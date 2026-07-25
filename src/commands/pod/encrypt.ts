/**
 * cascade pod encrypt <dir>
 * cascade pod decrypt <dir> [--force]
 *
 * Migrate an existing PLAINTEXT pod to encrypted-at-rest (and back).
 *
 * Both directions enumerate the pod through ONE authority,
 * `enumeratePodResources` in `src/lib/pod-resources.ts`, which walks the actual
 * pod and excludes only the by-design plaintext files. They cannot drift apart
 * by forgetting to update a list, because there is no list to update.
 *
 * `encrypt`:
 *   - Guards if the pod is already encrypted.
 *   - Obtains a passphrase (CASCADE_POD_PASSPHRASE or hidden prompt).
 *   - Confirms every resource is readable, then generates a fresh DEK +
 *     manifest and seals every resource in place.
 *
 * `decrypt`:
 *   - Guards if the pod is not encrypted.
 *   - Resolves the DEK, then classifies every resource WITHOUT writing.
 *   - Refuses to touch the pod at all if anything is unrecoverable, unless
 *     `--force`.
 *   - Writes plaintext, VERIFIES each file landed, and only then removes the
 *     encryption manifest. The manifest holds the only wrapped copy of the DEK,
 *     so the order of those last two steps is the whole difference between a
 *     recoverable failure and permanent loss.
 *
 * Both directions are idempotent: a file already in the target state is left
 * untouched and counted separately, so a re-run after an interruption finishes
 * the job instead of double-sealing (which would be unrecoverable).
 */

import type { Command } from 'commander';
import * as path from 'node:path';
import { printResult, printError, printVerbose, printWarning, type OutputOptions } from '../../lib/output.js';
import { resolvePodDir, fileExists } from './helpers.js';
import {
  generateDek,
  buildPassphraseManifest,
  writeEncryptionManifest,
  isPodEncrypted,
  resolveDek,
  readResourceBytes,
  encryptBytes,
  PodDecryptError,
  MANIFEST_RELATIVE_PATH,
} from '../../lib/pod-encryption.js';
import {
  enumeratePodResources,
  classifyResource,
  atomicWriteBytes,
  type PodResource,
} from '../../lib/pod-resources.js';
import { obtainNewPassphrase, obtainPassphrase } from '../../lib/passphrase.js';
import * as fs from 'node:fs/promises';

/** How many offending paths a failure message names before it summarizes. */
const MAX_LISTED_PATHS = 10;

function formatPathList(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).map((p) => `  - ${p}`);
  if (paths.length > MAX_LISTED_PATHS) {
    shown.push(`  ... and ${paths.length - MAX_LISTED_PATHS} more`);
  }
  return shown.join('\n');
}

export function registerEncryptSubcommand(pod: Command, program: Command): void {
  pod
    .command('encrypt')
    .description('Encrypt an existing plaintext pod at rest (AES-256-GCM)')
    .argument('<dir>', 'Path to the Cascade Pod directory')
    .action(async (dirArg: string) => {
      const globalOpts = program.opts() as OutputOptions;
      const podDir = resolvePodDir(dirArg);

      try {
        if (!(await fileExists(path.join(podDir, 'index.ttl')))) {
          printError(`Pod not found at ${podDir} (no index.ttl).`, globalOpts);
          process.exitCode = 1;
          return;
        }

        if (isPodEncrypted(podDir)) {
          printError(`Pod is already encrypted: ${podDir}`, globalOpts);
          process.exitCode = 1;
          return;
        }

        const passphrase = await obtainNewPassphrase();

        const { resources, plaintextByDesign } = await enumeratePodResources(podDir);

        // Confirm every resource is readable BEFORE the manifest exists, so a
        // permission problem fails on a pod that is still entirely plaintext.
        // Byte counts only: holding a whole pod in memory is not an option once
        // `sources/` can carry retained documents.
        const unreadable: string[] = [];
        for (const r of resources) {
          try {
            readResourceBytes(r.absPath);
          } catch {
            unreadable.push(r.relPath);
          }
        }
        if (unreadable.length > 0) {
          printError(
            `Cannot encrypt pod: ${unreadable.length} file(s) could not be read. Nothing was changed.\n${formatPathList(unreadable)}`,
            globalOpts,
          );
          process.exitCode = 1;
          return;
        }

        const dek = generateDek();
        const manifest = buildPassphraseManifest(dek, passphrase);
        writeEncryptionManifest(podDir, manifest);

        // Each file is sealed with an atomic replace, so an interruption leaves
        // every individual resource either fully plaintext or fully sealed.
        // `pod decrypt` tolerates exactly that mixture, so the pod stays
        // recoverable at any point in this loop.
        let encrypted = 0;
        for (const r of resources) {
          atomicWriteBytes(r.absPath, encryptBytes(readResourceBytes(r.absPath), dek));
          encrypted += 1;
          printVerbose(`  Encrypted ${r.relPath}`, globalOpts);
        }

        const result = {
          status: 'encrypted',
          directory: podDir,
          manifest: MANIFEST_RELATIVE_PATH.split(path.sep).join('/'),
          resourcesEncrypted: encrypted,
          plaintextByDesign,
        };
        if (globalOpts.json) {
          printResult(result, globalOpts);
        } else {
          console.log(`Pod encrypted: ${podDir}`);
          console.log(`  Resources encrypted: ${encrypted}`);
          console.log(`  Left plaintext by design: ${plaintextByDesign}`);
          console.log(`  Manifest: ${result.manifest}`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        printError(`Failed to encrypt pod: ${message}`, globalOpts);
        process.exitCode = 1;
      }
    });

  pod
    .command('decrypt')
    .description('Decrypt an encrypted pod back to plaintext at rest')
    .argument('<dir>', 'Path to the Cascade Pod directory')
    .option(
      '--force',
      'Proceed even when some files cannot be decrypted with this pod key. They are LEFT UNCHANGED and the encryption manifest is still removed.',
      false,
    )
    .action(async (dirArg: string, options: { force: boolean }) => {
      const globalOpts = program.opts() as OutputOptions;
      const podDir = resolvePodDir(dirArg);

      try {
        if (!isPodEncrypted(podDir)) {
          printError(`Pod is not encrypted: ${podDir}`, globalOpts);
          process.exitCode = 1;
          return;
        }

        const passphrase = await obtainPassphrase();
        let dek: Buffer;
        try {
          dek = resolveDek(podDir, passphrase);
        } catch (e) {
          if (e instanceof PodDecryptError) {
            printError(`Cannot decrypt pod: ${e.message}`, globalOpts);
            process.exitCode = 1;
            return;
          }
          throw e;
        }

        const { resources, plaintextByDesign } = await enumeratePodResources(podDir);

        // ── Pass 1: classify everything. NOTHING is written in this pass. ──
        const sealed: PodResource[] = [];
        const alreadyPlaintext: PodResource[] = [];
        const unreadable: PodResource[] = [];
        for (const r of resources) {
          switch (classifyResource(r.absPath, dek)) {
            case 'encrypted':
              sealed.push(r);
              break;
            case 'plaintext':
              alreadyPlaintext.push(r);
              break;
            case 'unreadable':
              unreadable.push(r);
              break;
          }
        }

        // A file that does not open with this pod's key is either ciphertext
        // under a different key or bytes that are not ours. Removing the
        // manifest while one of those is present is how the old implementation
        // destroyed data. Stop before writing anything.
        if (unreadable.length > 0 && !options.force) {
          printError(
            `Cannot decrypt pod: ${unreadable.length} file(s) do not decrypt with this pod's key. ` +
              `Nothing was changed and ${MANIFEST_RELATIVE_PATH.split(path.sep).join('/')} was kept, so the pod is still recoverable. ` +
              `Check the passphrase, or re-run with --force to decrypt the rest and leave these files as they are.\n` +
              formatPathList(unreadable.map((r) => r.relPath)),
            globalOpts,
          );
          process.exitCode = 1;
          return;
        }

        // ── Pass 2: write plaintext, then VERIFY each file landed. ──
        let decrypted = 0;
        for (const r of sealed) {
          const plaintext = readResourceBytes(r.absPath, dek);
          atomicWriteBytes(r.absPath, plaintext);
          // Read back. "Confirmed decrypted" has to mean the bytes on disk, not
          // the bytes we meant to write, because the manifest is about to go.
          const onDisk = readResourceBytes(r.absPath);
          if (!onDisk.equals(plaintext)) {
            printError(
              `Failed to decrypt pod: ${r.relPath} did not persist as plaintext. ` +
                `${MANIFEST_RELATIVE_PATH.split(path.sep).join('/')} was kept, so the pod is still recoverable.`,
              globalOpts,
            );
            process.exitCode = 1;
            return;
          }
          decrypted += 1;
          printVerbose(`  Decrypted ${r.relPath}`, globalOpts);
        }

        // Only now: every resource is confirmed plaintext on disk (or was
        // deliberately left alone under --force), so the wrapped DEK is no
        // longer the last copy of anything recoverable.
        await fs.rm(path.join(podDir, MANIFEST_RELATIVE_PATH), { force: true });

        if (unreadable.length > 0) {
          printWarning(
            `${unreadable.length} file(s) did not decrypt with this pod's key and were left unchanged:\n` +
              formatPathList(unreadable.map((r) => r.relPath)),
            globalOpts,
          );
        }

        const result = {
          status: 'decrypted',
          directory: podDir,
          resourcesDecrypted: decrypted,
          alreadyPlaintext: alreadyPlaintext.length,
          plaintextByDesign,
          leftEncrypted: unreadable.length,
        };
        if (globalOpts.json) {
          printResult(result, globalOpts);
        } else {
          console.log(`Pod decrypted: ${podDir}`);
          console.log(`  Resources decrypted: ${decrypted}`);
          console.log(`  Already plaintext: ${alreadyPlaintext.length}`);
          console.log(`  Left plaintext by design: ${plaintextByDesign}`);
          if (unreadable.length > 0) {
            console.log(`  Left unchanged (did not decrypt): ${unreadable.length}`);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        printError(`Failed to decrypt pod: ${message}`, globalOpts);
        process.exitCode = 1;
      }
    });
}
