/**
 * cascade pod resolve <pod-dir> --conflict <id> --keep <source-a|source-b|both>
 *                     [--note <text>] [--by <actorIri>]
 *
 * Record a conflict resolution decision in the pod.
 * Saves the decision to settings/user-resolutions.ttl and removes the
 * resolved conflict from settings/pending-conflicts.ttl.
 *
 * `--by` attributes the decision (`prov:wasAttributedTo`), mirroring
 * `pod annotate --by`. It is optional: the log recorded WHEN a conflict was
 * answered and never by whom, which is unattributable on a pod more than one
 * person touches, but an absent actor stays absent rather than being guessed at.
 * Read the log back with `pod conflicts <pod-dir> --resolved`.
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
import { shellCommand } from '../../lib/shell-quote.js';
import { assertWritableIri } from '../../lib/bucket-write.js';

export function registerResolveCommand(podProgram: Command, program: Command): void {
  podProgram
    .command('resolve')
    .description('Record a conflict resolution decision in the pod')
    .argument('<pod-dir>', 'Path to the Cascade Pod directory')
    .requiredOption('--conflict <id>', 'Conflict ID to resolve (from cascade pod conflicts)')
    .requiredOption('--keep <choice>', 'Which source to keep: source-a, source-b, both')
    .option('--note <text>', 'Optional note about your decision')
    .option('--by <actorIri>', 'Optional actor IRI (prov:wasAttributedTo)')
    .action(async (podDirArg: string, options: { conflict: string; keep: string; note?: string; by?: string }) => {
      const globalOpts = program.opts() as OutputOptions;
      const podDir = resolvePodDir(podDirArg);

      // Validate resolution choice
      const validChoices = ['source-a', 'source-b', 'both'];
      if (!validChoices.includes(options.keep)) {
        printError(`Invalid --keep value. Must be one of: ${validChoices.join(', ')}`, globalOpts);
        process.exit(1);
      }

      // Before the pod is opened, let alone written. An IRI carrying a character
      // Turtle forbids inside <...> serializes into a decision log the next read
      // cannot parse, and this store's own contract is that an unreadable file is
      // never silently replaced — so one accepted typo would take the decision
      // log out of service with no repair path. `pod annotate --by` refuses the
      // same input at the same point, and for the same reason.
      if (options.by !== undefined) {
        try {
          assertWritableIri(options.by, '--by');
        } catch (err: unknown) {
          printError(err instanceof Error ? err.message : String(err), globalOpts);
          process.exit(1);
        }
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
          `Conflict not found: ${options.conflict}. Run ` +
            `${shellCommand('cascade', 'pod', 'conflicts', podDirArg)} to see available conflicts.`,
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
        actorIri: options.by,
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
            // Only when there is one. A `null` here would read as "recorded, and
            // the author is nobody", which is a different claim from "recorded,
            // and nobody said who".
            ...(options.by ? { actorIri: options.by } : {}),
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
