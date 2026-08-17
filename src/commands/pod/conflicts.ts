/**
 * cascade pod conflicts <pod-dir> [--resolved]
 *
 * Read the pod's conflict store. Without `--resolved` that is the QUEUE of
 * unanswered questions (`settings/pending-conflicts.ttl`); with it, the LOG of
 * answered ones (`settings/user-resolutions.ttl`).
 *
 * Exit codes:
 *   0 — no unresolved conflicts (text mode), or any successful `--resolved` read
 *   1 — unresolved conflicts present (text mode; useful for CI)
 *   2 — a conflict-store file exists but could NOT be read
 *
 * The third one is the point. `settings/` is inside the encrypted set, so on an
 * encrypted pod this file is ciphertext; without the DEK the Turtle parse failed
 * and the failure was swallowed into an empty list, so the command printed
 * "No unresolved conflicts" and exited 0 with the conflict sitting right there.
 * "None" and "could not tell" must not share an answer.
 *
 * WHY `--resolved` AND NOT A `pod resolutions` VERB
 * -------------------------------------------------
 * The queue and the decision log are two halves of one store: a row moves from
 * the first to the second when `pod resolve` answers it, and both live under
 * `settings/` behind the same DEK. A separate verb would have needed its own
 * copy of the pod resolution, the DEK resolution, and — the part that matters —
 * the "this is NOT the same as having none" wording that the encrypted-pod
 * defect above exists to enforce. A second copy of that sentence is how one of
 * them softens. So there is one verb over the store and a flag that says which
 * half.
 *
 * Exit code 1 is NOT borrowed for the log. It is a CI signal about UNANSWERED
 * questions, and a decision log carries no such signal: a log with entries is
 * not a problem, it is the record of problems already handled. `--resolved`
 * therefore exits 0 whenever the read succeeded, empty or not.
 */

import { Command } from 'commander';
import {
  loadPendingConflicts,
  loadUserResolutions,
  ConflictStoreError,
  type UserResolution,
} from '../../lib/user-resolutions.js';
import { resolvePodDir, resolvePodDekIfEncrypted } from './helpers.js';
import { printError, type OutputOptions } from '../../lib/output.js';
import { toJsonText } from '../../lib/json-output.js';
import { shellCommand } from '../../lib/shell-quote.js';

export function registerConflictsCommand(podProgram: Command, program: Command): void {
  podProgram
    .command('conflicts')
    .description('List unresolved conflicts in a pod (--resolved for the decision log)')
    .argument('<pod-dir>', 'Path to the Cascade Pod directory')
    .option('--format <format>', 'Output format: text or json', 'text')
    .option('--resolved', 'List recorded decisions instead of the unanswered queue', false)
    .action(async (podDirArg: string, options: { format: string; resolved?: boolean }) => {
      const globalOpts = program.opts() as OutputOptions;
      const podDir = resolvePodDir(podDirArg);

      if (options.resolved === true) {
        await listResolutions(podDir, podDirArg, options.format, globalOpts);
        return;
      }

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
          if (c.conflictField) console.log(`   Field: ${c.conflictField}`);
          // Each side's value is printed WITH its origin, because the pair is
          // what makes the row answerable: one candidate record may have been
          // absorbed by the merge that raised this, and following its IRI would
          // find nothing.
          if (c.sourceA) console.log(`   Source A: ${c.sourceA}${c.valueA !== undefined ? ` — "${c.valueA}"` : ''}`);
          if (c.sourceB) console.log(`   Source B: ${c.sourceB}${c.valueB !== undefined ? ` — "${c.valueB}"` : ''}`);
          if (c.survivingRecordUri) console.log(`   Surviving record: ${c.survivingRecordUri}`);
          console.log(`   Conflict ID: ${c.conflictId}`);
          console.log(`   Detected: ${c.detectedAt.toISOString()}`);
          console.log(
            `   Resolve: ${shellCommand('cascade', 'pod', 'resolve', podDirArg, '--conflict', c.conflictId, '--keep', 'source-a')}`,
          );
          console.log();
        }

        // Exit code 1 if there are conflicts (useful for CI)
        process.exit(1);
      }
    });
}

/**
 * The decision log: every conflict someone has already answered.
 *
 * Sorted by `resolvedAt`, oldest first, so the output reads as a history rather
 * than as whatever order the store happened to hold. `loadUserResolutions` is
 * keyed by conflict id and holds one row per conflict, which is the same shape
 * `pod resolve` writes under, so this reports decisions and not attempts.
 */
async function listResolutions(
  podDir: string,
  podDirArg: string,
  format: string,
  globalOpts: OutputOptions,
): Promise<void> {
  let decisions: Map<string, UserResolution>;
  try {
    const dek = await resolvePodDekIfEncrypted(podDir);
    decisions = await loadUserResolutions(podDir, dek);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    printError(
      err instanceof ConflictStoreError
        ? `Could not read the recorded decisions in ${podDir}: ${detail}. ` +
            `This is NOT the same as no decisions having been made.`
        : `Could not open the pod at ${podDir}: ${detail}`,
      globalOpts,
    );
    process.exit(2);
  }

  const rows = [...decisions.values()]
    .sort((a, b) => a.resolvedAt.getTime() - b.resolvedAt.getTime())
    .map((r) => ({
      conflictId: r.conflictId,
      resolvedAt: r.resolvedAt.toISOString(),
      resolution: r.resolution,
      keptRecordUri: r.keptRecordUri,
      discardedRecordUris: r.discardedRecordUris,
      // Omitted rather than nulled when unstated: "nobody recorded who" and
      // "attributed to nobody" are different claims.
      ...(r.userNote ? { userNote: r.userNote } : {}),
      ...(r.actorIri ? { actorIri: r.actorIri } : {}),
    }));

  if (format === 'json') {
    console.log(toJsonText(rows));
    return;
  }

  if (rows.length === 0) {
    console.log(`No recorded conflict decisions in pod at ${podDirArg}`);
    return;
  }

  console.log(`${rows.length} recorded decision${rows.length > 1 ? 's' : ''} in pod at ${podDirArg}\n`);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    console.log(`${i + 1}. ${r.conflictId}`);
    console.log(`   Decision: ${r.resolution}`);
    console.log(`   Recorded: ${r.resolvedAt}`);
    if (r.actorIri) console.log(`   By: ${r.actorIri}`);
    if (r.keptRecordUri) console.log(`   Kept: ${r.keptRecordUri}`);
    for (const d of r.discardedRecordUris) console.log(`   Discarded: ${d}`);
    if (r.userNote) console.log(`   Note: ${r.userNote}`);
    console.log();
  }
}
