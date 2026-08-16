/**
 * cascade pod export <pod-dir>
 *
 * Export pod data as a ZIP archive or directory copy.
 *
 * Exit codes:
 *   0 — the export was written
 *   1 — usage error, INCLUDING an encrypted pod exported without a decision
 *   2 — the pod could not be read
 *
 * The middle one is decision D-CLI-2. This command copies bytes; it does not
 * parse them, so it was the one read verb that "worked" on an encrypted pod —
 * it produced a zip full of ciphertext, indistinguishable from a healthy export
 * until someone opened it. Exporting a sealed pod is now a choice the user
 * makes explicitly with `--allow-encrypted`, and an export made that way is
 * STAMPED with a note saying what the files are and what is needed to read
 * them, so whoever receives it gets an explanation instead of a brick.
 *
 * Refusing is exit 1 rather than 2 because nothing failed to be read: the user
 * has a choice to make (decrypt first, or export the ciphertext deliberately).
 */

import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'path';
import { printResult, printError, printVerbose, type OutputOptions } from '../../lib/output.js';
import { resolvePodDir, isDirectory, copyDirectory, createZipArchive } from './helpers.js';
import { isPodEncrypted, MANIFEST_RELATIVE_PATH } from '../../lib/pod-encryption.js';
import { shellCommand } from '../../lib/shell-quote.js';

/** File name of the note stamped into an encrypted export. */
export const ENCRYPTED_EXPORT_NOTICE_FILE = 'ENCRYPTED-EXPORT-README.md';

/**
 * The note stamped into an encrypted export.
 *
 * Written for whoever opens the archive, who is quite likely NOT the person who
 * made it: say what the files are, why they are unreadable, and what would make
 * them readable. No passphrase hint and no key material — the note travels with
 * the ciphertext.
 */
export function encryptedExportNotice(podName: string): string {
  return `# This export is encrypted

The files in \`${podName}\` are **ciphertext**, not damaged files. This is a
Cascade Pod that was encrypted at rest, and it was exported without being
decrypted first.

## What you are looking at

Every resource (\`.ttl\` and the other pod files) is sealed with AES-256-GCM
under a per-pod data encryption key. Opening one in a text editor shows binary
noise. That is expected.

\`${MANIFEST_RELATIVE_PATH.split(path.sep).join('/')}\` holds the key, wrapped
with a passphrase-derived key. Without that passphrase the contents cannot be
recovered by anyone, including the person who sent you this archive.

## To read it

You need the pod's passphrase from the person who exported it. Then:

    cascade pod decrypt <path-to-this-pod>

or point a Cascade-aware tool at the pod and supply the passphrase when asked.

## If you wanted a readable export

Decrypt the pod first, then export:

    cascade pod decrypt <pod-dir>
    cascade pod export <pod-dir>
`;
}

export function registerExportSubcommand(pod: Command, program: Command): void {
  pod
    .command('export')
    .description('Export pod data')
    .argument('<pod-dir>', 'Path to the Cascade Pod')
    .option('--format <fmt>', 'Export format (zip|directory)', 'zip')
    .option('--output <path>', 'Output path for export')
    .option(
      '--allow-encrypted',
      'Export an encrypted pod as ciphertext (the export is stamped with a note explaining it)',
    )
    .action(
      async (
        podDir: string,
        options: { format: string; output?: string; allowEncrypted?: boolean },
      ) => {
        const globalOpts = program.opts() as OutputOptions;
        const absDir = resolvePodDir(podDir);

        printVerbose(`Exporting pod: ${absDir} as ${options.format}`, globalOpts);

        // Validate pod exists
        if (!(await isDirectory(absDir))) {
          printError(`Pod directory not found: ${absDir}`, globalOpts);
          process.exitCode = 1;
          return;
        }

        // D-CLI-2: an encrypted pod is exported only on purpose. The old
        // behavior — copy the bytes, report success — produced an archive that
        // looks exactly like a working export and is unreadable by design.
        const encrypted = isPodEncrypted(absDir);
        if (encrypted && !options.allowEncrypted) {
          printError(
            `This pod is encrypted, so an export of it would contain ciphertext that nobody ` +
              `can read without its passphrase. Decrypt it first ` +
              `(${shellCommand('cascade', 'pod', 'decrypt', podDir)}), ` +
              `or pass --allow-encrypted to export the sealed bytes on purpose.`,
            globalOpts,
          );
          process.exitCode = 1;
          return;
        }

        const notice = encrypted
          ? [{ name: ENCRYPTED_EXPORT_NOTICE_FILE, content: encryptedExportNotice(path.basename(absDir)) }]
          : [];

        try {
          if (options.format === 'directory') {
            // Copy to new directory
            const outputDir = options.output ?? `${absDir}-export`;
            await copyDirectory(absDir, outputDir);
            for (const extra of notice) {
              await fs.writeFile(path.join(outputDir, extra.name), extra.content, 'utf-8');
            }

            if (globalOpts.json) {
              printResult(
                {
                  status: 'exported',
                  format: 'directory',
                  source: absDir,
                  output: outputDir,
                  encrypted,
                  ...(encrypted ? { notice: ENCRYPTED_EXPORT_NOTICE_FILE } : {}),
                },
                globalOpts,
              );
            } else {
              console.log(`Pod exported to directory: ${outputDir}`);
              if (encrypted) {
                console.log(
                  `  The export is CIPHERTEXT. ${ENCRYPTED_EXPORT_NOTICE_FILE} inside it explains what is needed to read it.`,
                );
              }
            }
          } else if (options.format === 'zip') {
            // Create ZIP archive
            const outputZip = options.output ?? `${path.basename(absDir)}.zip`;
            const absOutputZip = path.resolve(process.cwd(), outputZip);

            await createZipArchive(absDir, absOutputZip, notice);

            if (globalOpts.json) {
              printResult(
                {
                  status: 'exported',
                  format: 'zip',
                  source: absDir,
                  output: absOutputZip,
                  encrypted,
                  ...(encrypted ? { notice: ENCRYPTED_EXPORT_NOTICE_FILE } : {}),
                },
                globalOpts,
              );
            } else {
              console.log(`Pod exported to ZIP: ${absOutputZip}`);
              if (encrypted) {
                console.log(
                  `  The export is CIPHERTEXT. ${ENCRYPTED_EXPORT_NOTICE_FILE} inside it explains what is needed to read it.`,
                );
              }
            }
          } else {
            printError(
              `Unknown export format: ${options.format}. Use 'zip' or 'directory'.`,
              globalOpts,
            );
            process.exitCode = 1;
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          printError(`Failed to export pod: ${message}`, globalOpts);
          process.exitCode = 1;
        }
      },
    );
}
