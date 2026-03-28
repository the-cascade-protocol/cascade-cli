/**
 * cascade pod conflicts <pod-dir>
 *
 * List unresolved conflicts in a pod.
 * Reads settings/pending-conflicts.ttl and displays them.
 * Exits with code 1 if any conflicts are present (useful for CI).
 */

import { Command } from 'commander';
import { loadPendingConflicts } from '../../lib/user-resolutions.js';
import { resolvePodDir } from './helpers.js';

export function registerConflictsCommand(podProgram: Command): void {
  podProgram
    .command('conflicts')
    .description('List unresolved conflicts in a pod')
    .argument('<pod-dir>', 'Path to the Cascade Pod directory')
    .option('--format <format>', 'Output format: text or json', 'text')
    .action(async (podDirArg: string, options: { format: string }) => {
      const podDir = resolvePodDir(podDirArg);
      const conflicts = await loadPendingConflicts(podDir);

      if (options.format === 'json') {
        console.log(JSON.stringify(conflicts, null, 2));
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
