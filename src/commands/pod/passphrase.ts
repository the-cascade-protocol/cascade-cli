/**
 * cascade pod passphrase set <pod-dir>
 *
 * Change the passphrase that opens an encrypted pod by RE-WRAPPING the pod's
 * data key. Every resource is sealed under that data key, not under the
 * passphrase, so a passphrase change is one write of `settings/encryption.json`
 * and nothing else in the pod moves.
 *
 * Secrets never travel on argv. The current passphrase comes from
 * `CASCADE_POD_PASSPHRASE` or a hidden prompt (the same way every read verb
 * takes it); the new one from `CASCADE_POD_NEW_PASSPHRASE` or a hidden prompt
 * entered twice. Neither is printed or logged.
 *
 * Refusals leave the manifest byte-identical: the pod is not encrypted; the
 * manifest is malformed or from a newer tool; the current passphrase opens no
 * wrap (the check that keeps a caller from replacing a key they cannot prove
 * they hold); the new passphrase is empty or the same as the current one.
 *
 * The write itself is {@link rewrapPassphrase}: atomic, read back and verified
 * before it replaces the manifest. The manifest it writes is version 1.1.
 *
 * Exit codes follow docs/exit-codes.md: 1 for a caller error (not encrypted,
 * empty or unchanged passphrase, entries that did not match), 2 when the pod's
 * key could not be opened (wrong current passphrase, unreadable manifest).
 *
 * With `--rotate-dek` the command RE-KEYS instead: a new data key, every sealed
 * file re-encrypted under it, and a header with one wrap for the new
 * passphrase. The engine and its crash-recovery rules are in
 * `lib/pod-rekey.ts`. Both passphrases come only from the environment (no
 * prompt), and every error carries a `reason` from the documented vocabulary
 * where one applies.
 */

import type { Command } from 'commander';
import * as fs from 'node:fs';
import {
  printResult,
  printError,
  printErrorDetail,
  printWarning,
  type OutputOptions,
} from '../../lib/output.js';
import { resolvePodDir } from './helpers.js';
import {
  isPodEncrypted,
  readEncryptionManifest,
  unlockManifest,
  rewrapPassphrase,
  PodDecryptError,
  EncryptionManifestError,
  type NormalizedEncryptionManifest,
  type RewrapResult,
} from '../../lib/pod-encryption.js';
import {
  obtainPassphrase,
  obtainReplacementPassphrase,
  PASSPHRASE_ENV_VAR,
  NEW_PASSPHRASE_ENV_VAR,
} from '../../lib/passphrase.js';
import {
  rotateDataKey,
  recoverInterruptedRekey,
  RotateDekError,
  type RekeyRecoveryStep,
  type RotateDekResult,
} from '../../lib/pod-rekey.js';

export const REWRAP_DONE_MESSAGE =
  'Re-wrapped. The new passphrase opens this pod; the old one no longer does. ' +
  'A copy of this pod made before now still opens with the old passphrase.';

export const REKEY_DONE_MESSAGE =
  'Re-keyed. Every file is now sealed under a new data key, and only the new passphrase opens this pod. ' +
  'A copy of this pod made before now still opens with the old passphrase.';

/** One line per finished step of an interrupted re-key, for a warning. */
export function describeRekeyRecovery(steps: RekeyRecoveryStep[]): string {
  return steps
    .map((s) => {
      switch (s.action) {
        case 'delete-staging':
          return `Removed an unfinished re-encrypted copy left by an interrupted re-key (${s.staging}).`;
        case 'roll-back':
          return `An interrupted re-key had moved the pod aside; it was moved back unchanged (from ${s.old}).`;
        case 'complete':
          return `An interrupted re-key had already put the new key in place; removed the old copy (${s.old}).`;
      }
    })
    .join('\n');
}

export function registerPassphraseSubcommand(pod: Command, program: Command): void {
  const passphrase = pod
    .command('passphrase')
    .description('Manage the passphrase that opens an encrypted pod');

  passphrase
    .command('set')
    .description(
      'Change the passphrase of an encrypted pod by re-wrapping its key. ' +
        'A copy of the pod made before the change still opens with the old passphrase.',
    )
    .argument('<pod-dir>', 'Path to the encrypted Cascade Pod directory')
    .option(
      '--rotate-dek',
      'Also replace the data key: re-encrypt every file under a new key and keep only the new passphrase',
      false,
    )
    .addHelpText(
      'after',
      `
The current passphrase is read from CASCADE_POD_PASSPHRASE, else a hidden prompt.
The new passphrase is read from CASCADE_POD_NEW_PASSPHRASE, else a hidden prompt
entered twice. Neither is accepted as an argument.

Only settings/encryption.json is rewritten (as manifest version 1.1); no resource
file is read or written.

With --rotate-dek the pod gets a NEW data key. Whoever opened the pod before
may have kept the old data key, and a re-wrap alone does not stop that key
working; a re-key does. Both passphrases must be set in the environment (there
is no prompt). A re-encrypted copy of the pod is built beside it
(.<name>.rekey-<hex>), verified with the new passphrase, and swapped in with two
renames; the header then holds one wrap, for the new passphrase, and every other
wrap is dropped. On any failure the pod is left as it was. If the command is
killed part way, running it again (or \`cascade pod doctor --write\`) finishes or
undoes the interrupted run. A copy of the pod made before the change still
opens with the old passphrase.`,
    )
    .action(async (dirArg: string, cmdOpts: { rotateDek?: boolean }) => {
      const globalOpts = program.opts() as OutputOptions;
      const podDir = resolvePodDir(dirArg);
      if (cmdOpts.rotateDek) {
        runRotateDek(podDir, globalOpts);
        return;
      }
      const refuse = (message: string, code: 1 | 2, unchangedNote = true): void => {
        printError(unchangedNote ? `${message} Nothing was changed.` : message, globalOpts);
        process.exitCode = code;
      };

      try {
        if (!fs.existsSync(podDir) || !fs.statSync(podDir).isDirectory()) {
          refuse(`Pod not found at ${podDir}.`, 1);
          return;
        }
        if (!isPodEncrypted(podDir)) {
          refuse(`Pod is not encrypted: ${podDir}. There is no passphrase to change.`, 1);
          return;
        }

        // Read the manifest before asking for anything, so a manifest this tool
        // cannot use is reported as that, not as a wrong passphrase.
        let manifest: NormalizedEncryptionManifest | null;
        try {
          manifest = readEncryptionManifest(podDir);
        } catch (e) {
          if (e instanceof EncryptionManifestError) {
            refuse(`Cannot change the passphrase: ${e.message}.`, 2);
            return;
          }
          throw e;
        }
        if (!manifest) {
          refuse(`Pod is not encrypted: ${podDir}.`, 1);
          return;
        }

        let current: string;
        try {
          current = await obtainPassphrase('Current pod passphrase: ');
        } catch (e) {
          refuse(e instanceof Error ? e.message : String(e), 2);
          return;
        }

        // Prove the current passphrase before asking for the new one.
        // rewrapPassphrase proves it again against the bytes it rewrites.
        try {
          unlockManifest(manifest, current).dek.fill(0);
        } catch (e) {
          if (e instanceof PodDecryptError || e instanceof EncryptionManifestError) {
            refuse(
              `Cannot change the passphrase: the current passphrase does not open this pod (${e.message}).`,
              2,
            );
            return;
          }
          throw e;
        }

        const next = await obtainReplacementPassphrase();
        if (next.length === 0) {
          refuse('The new passphrase cannot be empty.', 1);
          return;
        }
        if (next === current) {
          refuse('The new passphrase is the same as the current one: nothing to change.', 1, false);
          return;
        }

        let result: RewrapResult;
        try {
          result = rewrapPassphrase(podDir, current, next);
        } catch (e) {
          if (e instanceof PodDecryptError || e instanceof EncryptionManifestError) {
            refuse(`Cannot change the passphrase: ${e.message}.`, 2);
            return;
          }
          throw e;
        }

        if (globalOpts.json) {
          printResult(
            {
              podDir,
              manifestVersion: result.manifestVersion,
              wrapCount: result.wrapCount,
              createdAt: result.createdAt,
            },
            globalOpts,
          );
        } else {
          console.log(REWRAP_DONE_MESSAGE);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        printError(`Failed to change the pod passphrase: ${message}`, globalOpts);
        process.exitCode = 1;
      }
    });
}

/**
 * `pod passphrase set --rotate-dek`. Secrets from the environment only; see
 * `lib/pod-rekey.ts` for the steps and the recovery rules.
 *
 * Order: both secrets present (else exit 1, `passphrase-missing`, nothing
 * touched); new differs from current; finish any interrupted re-key; the pod
 * exists and is encrypted; its header reads (exit 2 with the manifest reasons);
 * the current passphrase opens it (exit 2, `passphrase-incorrect`); re-key.
 */
function runRotateDek(podDir: string, globalOpts: OutputOptions): void {
  const refuse = (message: string, code: 1 | 2, detail: Record<string, unknown> = {}): void => {
    printErrorDetail(message, detail, globalOpts);
    process.exitCode = code;
  };

  const current = process.env[PASSPHRASE_ENV_VAR] ?? '';
  const next = process.env[NEW_PASSPHRASE_ENV_VAR] ?? '';
  if (current.length === 0 || next.length === 0) {
    const missing = [
      ...(current.length === 0 ? [PASSPHRASE_ENV_VAR] : []),
      ...(next.length === 0 ? [NEW_PASSPHRASE_ENV_VAR] : []),
    ];
    refuse(
      `--rotate-dek takes both passphrases from the environment and ${missing.join(' and ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not set. Nothing was changed.`,
      1,
      { reason: 'passphrase-missing' },
    );
    return;
  }
  if (next === current) {
    refuse('The new passphrase is the same as the current one. Nothing was changed.', 1);
    return;
  }

  try {
    const recovered = recoverInterruptedRekey(podDir);
    if (recovered.length > 0) printWarning(describeRekeyRecovery(recovered), globalOpts);

    if (!fs.existsSync(podDir) || !fs.statSync(podDir).isDirectory()) {
      refuse(`Pod not found at ${podDir}. Nothing was changed.`, 1);
      return;
    }
    if (!isPodEncrypted(podDir)) {
      refuse(`Pod is not encrypted: ${podDir}. There is no key to change. Nothing was changed.`, 1);
      return;
    }

    let result: RotateDekResult;
    try {
      result = rotateDataKey(podDir, current, next);
    } catch (e) {
      if (e instanceof EncryptionManifestError) {
        refuse(`Cannot re-key: ${e.message}. Nothing was changed.`, 2, {
          reason: e.kind === 'malformed' ? 'manifest-malformed' : 'manifest-version-unsupported',
        });
        return;
      }
      if (e instanceof PodDecryptError) {
        refuse(
          `Cannot re-key: the current passphrase does not open this pod (${e.message}). Nothing was changed.`,
          2,
          { reason: 'passphrase-incorrect' },
        );
        return;
      }
      if (e instanceof RotateDekError) {
        refuse(e.message, e.exitCode, {
          ...(e.reason ? { reason: e.reason } : {}),
          ...(e.files ? { files: e.files } : {}),
        });
        return;
      }
      throw e;
    }

    if (result.oldCopyLeft) {
      printWarning(
        `The re-key is done and only the new passphrase opens the pod, but the old copy of the pod at ` +
          `${result.oldCopyLeft} could not be deleted, and it still opens with the old passphrase. ` +
          `Run \`cascade pod doctor --write\` on the pod to delete it.`,
        globalOpts,
      );
    }
    if (globalOpts.json) {
      printResult(
        {
          podDir,
          manifestVersion: result.manifestVersion,
          wrapCount: result.wrapCount,
          createdAt: result.createdAt,
          dataKeyRotated: true,
          resources: result.resealed,
        },
        globalOpts,
      );
    } else {
      console.log(REKEY_DONE_MESSAGE);
      console.log(`  Re-encrypted: ${result.resealed}`);
      if (result.copied > 0) {
        console.log(
          `  Copied unchanged: ${result.copied} (files that do not open with the pod's key, ` +
            `${result.plaintextByDesign} of them plaintext by design)`,
        );
      }
    }
  } catch (err: unknown) {
    if (err instanceof RotateDekError) {
      refuse(err.message, err.exitCode);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    printError(`Failed to re-key the pod: ${message}`, globalOpts);
    process.exitCode = 1;
  }
}
