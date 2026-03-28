/**
 * cascade pod resolve <pod-dir> --conflict <id> --keep <source-a|source-b|both>
 *
 * Record a conflict resolution decision in the pod.
 * Saves the decision to settings/user-resolutions.ttl and removes the
 * resolved conflict from settings/pending-conflicts.ttl.
 */

import { Command } from 'commander';
import {
  loadPendingConflicts,
  saveUserResolution,
  writePendingConflicts,
  type ResolutionChoice,
} from '../../lib/user-resolutions.js';
import { resolvePodDir } from './helpers.js';
import { randomUUID } from 'node:crypto';

export function registerResolveCommand(podProgram: Command): void {
  podProgram
    .command('resolve')
    .description('Record a conflict resolution decision in the pod')
    .argument('<pod-dir>', 'Path to the Cascade Pod directory')
    .requiredOption('--conflict <id>', 'Conflict ID to resolve (from cascade pod conflicts)')
    .requiredOption('--keep <choice>', 'Which source to keep: source-a, source-b, both')
    .option('--note <text>', 'Optional note about your decision')
    .action(async (podDirArg: string, options: { conflict: string; keep: string; note?: string }) => {
      const podDir = resolvePodDir(podDirArg);

      // Validate resolution choice
      const validChoices = ['source-a', 'source-b', 'both'];
      if (!validChoices.includes(options.keep)) {
        console.error(`Invalid --keep value. Must be one of: ${validChoices.join(', ')}`);
        process.exit(1);
      }

      const resolution: ResolutionChoice =
        options.keep === 'source-a' ? 'kept-source-a' :
        options.keep === 'source-b' ? 'kept-source-b' : 'kept-both';

      // Load pending conflicts to find the one being resolved
      const pending = await loadPendingConflicts(podDir);
      const conflict = pending.find(c => c.conflictId === options.conflict);

      if (!conflict) {
        console.error(`Conflict not found: ${options.conflict}`);
        console.error(`Run 'cascade pod conflicts ${podDirArg}' to see available conflicts`);
        process.exit(1);
      }

      // Save the resolution
      await saveUserResolution(podDir, {
        uri: `urn:uuid:resolution-${randomUUID()}`,
        conflictId: options.conflict,
        resolvedAt: new Date(),
        resolution,
        keptRecordUri: resolution === 'kept-source-a' ? (conflict.candidateRecordUris[0] ?? '') :
                       resolution === 'kept-source-b' ? (conflict.candidateRecordUris[1] ?? '') : '',
        discardedRecordUris: resolution === 'kept-source-a' ? conflict.candidateRecordUris.slice(1) :
                              resolution === 'kept-source-b' ? conflict.candidateRecordUris.slice(0, 1) : [],
        userNote: options.note,
      });

      // Remove the conflict from pending list
      const remaining = pending.filter(c => c.conflictId !== options.conflict);
      await writePendingConflicts(podDir, remaining);

      console.log(`Resolution saved: ${options.conflict} -> keep-${options.keep}`);
      if (remaining.length > 0) {
        console.log(`${remaining.length} conflict${remaining.length > 1 ? 's' : ''} still pending`);
      } else {
        console.log('No remaining conflicts');
      }
    });
}
