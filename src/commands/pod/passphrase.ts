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
 */

import type { Command } from 'commander';
import * as fs from 'node:fs';
import { printResult, printError, type OutputOptions } from '../../lib/output.js';
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
import { obtainPassphrase, obtainReplacementPassphrase } from '../../lib/passphrase.js';

export const REWRAP_DONE_MESSAGE =
  'Re-wrapped. The new passphrase opens this pod; the old one no longer does. ' +
  'A copy of this pod made before now still opens with the old passphrase.';

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
    .addHelpText(
      'after',
      `
The current passphrase is read from CASCADE_POD_PASSPHRASE, else a hidden prompt.
The new passphrase is read from CASCADE_POD_NEW_PASSPHRASE, else a hidden prompt
entered twice. Neither is accepted as an argument.

Only settings/encryption.json is rewritten (as manifest version 1.1); no resource
file is read or written.`,
    )
    .action(async (dirArg: string) => {
      const globalOpts = program.opts() as OutputOptions;
      const podDir = resolvePodDir(dirArg);
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
