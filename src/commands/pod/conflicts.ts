/**
 * cascade pod conflicts <pod-dir>
 *
 * List unresolved conflicts in a pod.
 * Reads settings/pending-conflicts.ttl and displays them.
 *
 * Exit codes:
 *   0 — no unresolved conflicts (text mode)
 *   1 — unresolved conflicts present (text mode; useful for CI)
 *   2 — the conflicts file exists but could NOT be read
 *
 * The third one is the point. `settings/` is inside the encrypted set, so on an
 * encrypted pod this file is ciphertext; without the DEK the Turtle parse failed
 * and the failure was swallowed into an empty list, so the command printed
 * "No unresolved conflicts" and exited 0 with the conflict sitting right there.
 * "None" and "could not tell" must not share an answer.
 */

import { Command } from 'commander';
import { loadPendingConflicts, ConflictStoreError } from '../../lib/user-resolutions.js';
import { resolvePodDir, resolvePodDekIfEncrypted } from './helpers.js';
import { printError, type OutputOptions } from '../../lib/output.js';
import { toJsonText } from '../../lib/json-output.js';

export function registerConflictsCommand(podProgram: Command, program: Command): void {
  podProgram
    .command('conflicts')
    .description('List unresolved conflicts in a pod')
    .argument('<pod-dir>', 'Path to the Cascade Pod directory')
    .option('--format <format>', 'Output format: text or json', 'text')
    .action(async (podDirArg: string, options: { format: string }) => {
      const globalOpts = program.opts() as OutputOptions;
      const podDir = resolvePodDir(podDirArg);

      let conflicts;
      try {
        const dek = await resolvePodDekIfEncrypted(podDir);
        conflicts = await loadPendingConflicts(podDir, dek);
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        const message =
          err instanceof ConflictStoreError
            ? `Could not read the conflicts in ${podDir}: ${detail}. This is NOT the same as having no conflicts.`
            : `Could not open the pod at ${podDir}: ${detail}`;
        printError(message, globalOpts);
        process.exit(2);
      }

      if (options.format === 'json') {
        console.log(toJsonText(conflicts));
      } else {
        if (conflicts.length === 0) {
          console.log(`No unresolved conflicts in pod at ${podDir}`);
          process.exit(0);
        }

        console.log(`${conflicts.length} unresolved conflict${conflicts.length > 1 ? 's' : ''} in pod at ${podDir}\n`);

        for (let i = 0; i < conflicts.length; i++) {
          const c = conflicts[i];
          console.log(`${i + 1}. ${c.recordType}`);
          if (c.sourceA) console.log(`   Source A: ${c.sourceA}`);
          if (c.sourceB) console.log(`   Source B: ${c.sourceB}`);
          console.log(`   Conflict ID: ${c.conflictId}`);
          console.log(`   Detected: ${c.detectedAt.toISOString()}`);
          console.log(`   Resolve: cascade pod resolve ${podDirArg} --conflict "${c.conflictId}" --keep source-a`);
          console.log();
        }

        // Exit code 1 if there are conflicts (useful for CI)
        process.exit(1);
      }
    });
}
