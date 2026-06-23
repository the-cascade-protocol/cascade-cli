/**
 * cascade pod encrypt <dir>
 * cascade pod decrypt <dir>
 *
 * Migrate an existing PLAINTEXT pod to encrypted-at-rest (and back).
 *
 * `encrypt`:
 *   - Guards if the pod is already encrypted.
 *   - Obtains a passphrase (CASCADE_POD_PASSPHRASE or hidden prompt).
 *   - Generates a fresh DEK + manifest, then re-writes every pod resource
 *     (read plaintext -> writeResource with DEK) in place.
 *
 * `decrypt`:
 *   - Guards if the pod is not encrypted.
 *   - Resolves the DEK, re-writes every resource as plaintext, then removes the
 *     encryption manifest.
 */

import type { Command } from 'commander';
import * as path from 'node:path';
import { printResult, printError, printVerbose, type OutputOptions } from '../../lib/output.js';
import { resolvePodDir, fileExists } from './helpers.js';
import {
  generateDek,
  buildPassphraseManifest,
  writeEncryptionManifest,
  isPodEncrypted,
  resolveDek,
  readResource,
  writeResource,
  PodDecryptError,
  MANIFEST_RELATIVE_PATH,
} from '../../lib/pod-encryption.js';
import { obtainNewPassphrase, obtainPassphrase } from '../../lib/passphrase.js';
import * as fs from 'node:fs/promises';

/**
 * Enumerate the absolute paths of every encryptable pod resource.
 *
 * Covers: index.ttl, every `.ttl` under clinical/ wellness/ profile/ settings/,
 * plus the non-`.ttl` resources the initializer writes (`.well-known/solid`,
 * `settings/preferences`). README.md and the encryption manifest itself are
 * deliberately excluded.
 */
async function enumerateResources(podDir: string): Promise<string[]> {
  const out: string[] = [];

  // index.ttl at the root
  const indexPath = path.join(podDir, 'index.ttl');
  if (await fileExists(indexPath)) out.push(indexPath);

  // All .ttl files under data + profile + settings directories (recursive).
  const dataDirs = ['clinical', 'wellness', 'profile', 'settings'];
  for (const dir of dataDirs) {
    const dirPath = path.join(podDir, dir);
    await walkTtl(dirPath, out);
  }

  // Non-.ttl resources written by `pod init`.
  for (const rel of [
    path.join('.well-known', 'solid'),
    path.join('settings', 'preferences'),
  ]) {
    const p = path.join(podDir, rel);
    if (await fileExists(p)) out.push(p);
  }

  // Stable order, de-duplicated.
  return Array.from(new Set(out)).sort();
}

async function walkTtl(dir: string, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory doesn't exist
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      await walkTtl(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ttl')) {
      out.push(full);
    }
  }
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

        // Read every resource as plaintext FIRST, before writing the manifest,
        // so a mid-migration failure leaves a recoverable (still-plaintext) pod.
        const resources = await enumerateResources(podDir);
        const contents: Array<{ path: string; text: string }> = [];
        for (const p of resources) {
          contents.push({ path: p, text: readResource(p) });
        }

        const dek = generateDek();
        const manifest = buildPassphraseManifest(dek, passphrase);
        writeEncryptionManifest(podDir, manifest);

        for (const { path: p, text } of contents) {
          writeResource(p, text, dek);
          printVerbose(`  Encrypted ${path.relative(podDir, p)}`, globalOpts);
        }

        const result = {
          status: 'encrypted',
          directory: podDir,
          manifest: MANIFEST_RELATIVE_PATH.split(path.sep).join('/'),
          resourcesEncrypted: contents.length,
        };
        if (globalOpts.json) {
          printResult(result, globalOpts);
        } else {
          console.log(`Pod encrypted: ${podDir}`);
          console.log(`  Resources encrypted: ${contents.length}`);
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
    .action(async (dirArg: string) => {
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

        // Decrypt everything into memory first, then write plaintext + drop the
        // manifest only after all reads succeed.
        const resources = await enumerateResources(podDir);
        const contents: Array<{ path: string; text: string }> = [];
        for (const p of resources) {
          contents.push({ path: p, text: readResource(p, dek) });
        }

        for (const { path: p, text } of contents) {
          writeResource(p, text);
          printVerbose(`  Decrypted ${path.relative(podDir, p)}`, globalOpts);
        }

        await fs.rm(path.join(podDir, MANIFEST_RELATIVE_PATH), { force: true });

        const result = {
          status: 'decrypted',
          directory: podDir,
          resourcesDecrypted: contents.length,
        };
        if (globalOpts.json) {
          printResult(result, globalOpts);
        } else {
          console.log(`Pod decrypted: ${podDir}`);
          console.log(`  Resources decrypted: ${contents.length}`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        printError(`Failed to decrypt pod: ${message}`, globalOpts);
        process.exitCode = 1;
      }
    });
}
