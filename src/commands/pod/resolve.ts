/**
 * cascade pod resolve <pod-dir> --conflict <id> --keep <source-a|source-b|both>
 *
 * Record a conflict resolution decision in the pod.
 * Saves the decision to settings/user-resolutions.ttl and removes the
 * resolved conflict from settings/pending-conflicts.ttl.
 *
 * Honors the global --json flag: with --json it emits a single machine-readable
 * result object (and JSON errors) instead of human-readable text. Every other
 * pod command the desktop apps shell already does this; resolve was the lone
 * exception, which forced callers to parse a success string out of stdout.
 */

import { Command } from 'commander';
import {
  loadPendingConflicts,
  saveUserResolution,
  writePendingConflicts,
  ConflictStoreError,
  type ResolutionChoice,
} from '../../lib/user-resolutions.js';
import { resolvePodDir, resolvePodDekIfEncrypted } from './helpers.js';
import { printResult, printError, type OutputOptions } from '../../lib/output.js';
import { randomUUID } from 'node:crypto';

export function registerResolveCommand(podProgram: Command, program: Command): void {
  podProgram
    .command('resolve')
    .description('Record a conflict resolution decision in the pod')
    .argument('<pod-dir>', 'Path to the Cascade Pod directory')
    .requiredOption('--conflict <id>', 'Conflict ID to resolve (from cascade pod conflicts)')
    .requiredOption('--keep <choice>', 'Which source to keep: source-a, source-b, both')
    .option('--note <text>', 'Optional note about your decision')
    .action(async (podDirArg: string, options: { conflict: string; keep: string; note?: string }) => {
      const globalOpts = program.opts() as OutputOptions;
      const podDir = resolvePodDir(podDirArg);

      // Validate resolution choice
      const validChoices = ['source-a', 'source-b', 'both'];
      if (!validChoices.includes(options.keep)) {
        printError(`Invalid --keep value. Must be one of: ${validChoices.join(', ')}`, globalOpts);
        process.exit(1);
      }

      const resolution: ResolutionChoice =
        options.keep === 'source-a' ? 'kept-source-a' :
        options.keep === 'source-b' ? 'kept-source-b' : 'kept-both';

      // On an encrypted pod both conflict-store files are ciphertext. Resolve the
      // DEK once and route every read and write below through it; a failure here
      // must stop the command rather than let it read ciphertext, find no match,
      // and report the conflict as missing.
      let dek: Buffer | undefined;
      try {
        dek = await resolvePodDekIfEncrypted(podDir);
      } catch (err: unknown) {
        printError(
          `Could not open the pod at ${podDir}: ${err instanceof Error ? err.message : String(err)}`,
          globalOpts,
        );
        process.exit(2);
      }

      // Load pending conflicts to find the one being resolved
      let pending;
      try {
        pending = await loadPendingConflicts(podDir, dek);
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        printError(
          err instanceof ConflictStoreError
            ? `Could not read the conflicts in ${podDir}: ${detail}. Nothing was changed.`
            : `Could not read the conflicts in ${podDir}: ${detail}`,
          globalOpts,
        );
        process.exit(2);
      }
      const conflict = pending.find(c => c.conflictId === options.conflict);

      if (!conflict) {
        printError(
          `Conflict not found: ${options.conflict}. Run 'cascade pod conflicts ${podDirArg}' to see available conflicts.`,
          globalOpts,
        );
        process.exit(1);
      }

      const keptRecordUri =
        resolution === 'kept-source-a' ? (conflict.candidateRecordUris[0] ?? '') :
        resolution === 'kept-source-b' ? (conflict.candidateRecordUris[1] ?? '') : '';
      const discardedRecordUris =
        resolution === 'kept-source-a' ? conflict.candidateRecordUris.slice(1) :
        resolution === 'kept-source-b' ? conflict.candidateRecordUris.slice(0, 1) : [];

      // Save the resolution
      await saveUserResolution(podDir, {
        uri: `urn:uuid:resolution-${randomUUID()}`,
        conflictId: options.conflict,
        resolvedAt: new Date(),
        resolution,
        keptRecordUri,
        discardedRecordUris,
        userNote: options.note,
      }, dek);

      // Remove the conflict from the pending list
      const remaining = pending.filter(c => c.conflictId !== options.conflict);
      await writePendingConflicts(podDir, remaining, dek);

      if (globalOpts.json) {
        printResult(
          {
            resolved: true,
            conflictId: options.conflict,
            keep: options.keep,
            resolution,
            keptRecordUri,
            discardedRecordUris,
            remainingConflicts: remaining.length,
          },
          globalOpts,
        );
      } else {
        console.log(`Resolution saved: ${options.conflict} -> keep-${options.keep}`);
        if (remaining.length > 0) {
          console.log(`${remaining.length} conflict${remaining.length > 1 ? 's' : ''} still pending`);
        } else {
          console.log('No remaining conflicts');
        }
      }
    });
}
