/**
 * cascade pod reconcile <pod-dir>
 *
 * Reconcile a pod against ITSELF: find and merge the duplicates it already
 * holds.
 *
 * WHY THIS VERB HAS TO EXIST
 * --------------------------
 * `pod import --reconcile-existing` reconciles ARRIVING records against stored
 * ones. It deliberately never compares two stored records with each other, and
 * that restriction is right for an import: reconciling a pod's existing content
 * is a mutation of records the user did not just hand over, and it must not
 * happen as an invisible side effect of importing an unrelated file.
 *
 * The consequence, though, is that duplicates ALREADY in a pod are permanent.
 * Nothing in the tool ever compares them, so every pod written before
 * cross-source matching existed carries its duplicates forever, and no sequence
 * of imports can clear them. That is this verb: the same reconciler, the same
 * matching, the same conflict machinery, pointed at pod content — and named
 * honestly as the mutation it is.
 *
 * DRY RUN IS THE DEFAULT, AND THAT IS THE DESIGN
 * ----------------------------------------------
 * The command reports first. With no flags it reads the pod, runs the whole
 * reconciliation, prints exactly what WOULD merge and what WOULD be raised as a
 * conflict, writes nothing, and exits 0. `--apply` is a separate, typed decision
 * made after reading that report.
 *
 * A verb that rewrites a person's health records the first time they run it,
 * because they were curious what it did, is not a tool anyone should trust with
 * a pod. And the report is useful on its own: "how much cross-source duplication
 * do I actually have" is a question worth answering without changing anything.
 *
 * Exit codes:
 *   0 — the run completed (a dry run, or an --apply that wrote successfully)
 *   1 — the reconciliation ran but at least one bucket could not be WRITTEN
 *   2 — the pod could not be opened, or a record file in it could not be READ.
 *       The second one is exit 2 in the DRY RUN too: this command's whole output
 *       is a claim about the pod's whole record set, and it must not make that
 *       claim about files it never opened.
 */

import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { Parser } from 'n3';
import type { Quad } from 'n3';
import { printResult, printError, printVerbose, type OutputOptions } from '../../lib/output.js';
import { toJsonText } from '../../lib/json-output.js';
import { runReconciliation, type ReconcilerInput, type Tier0Merge } from '../../lib/reconciler.js';
import { DATA_TYPES, resolvePodDir } from './helpers.js';
import { openPod, PodReadLedger, tidyReason, type PodReader } from '../../lib/pod-read.js';
import { mergeIntoBucket, derelativizeQuads, relBaseFor } from '../../lib/bucket-write.js';
import {
  writePendingConflicts,
  generateConflictId,
  type PendingConflict,
} from '../../lib/user-resolutions.js';
import { randomUUID } from 'node:crypto';
import { appendTier0Journal, TIER0_JOURNAL_RELATIVE_PATH } from '../../lib/tier0-journal.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** Pod directories holding reconcilable records. Matches `pod import`. */
const DATA_DIRS = ['clinical', 'wellness'] as const;

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** One group the reconciler would collapse or raise, as the report names it. */
export interface ReconcileGroupReport {
  /** `exact_duplicate`, `near_duplicate`, `value_conflict`, ... */
  type: string;
  recordType: string;
  /** The record that would survive. */
  canonicalUri: string;
  /** What made them one record, e.g. `loinc:2951-2+2031-05-20`. */
  matchedOn: string;
  /** How the reconciler would settle it. */
  strategy: string;
  /** False when it would be raised for a person to answer instead of merged. */
  resolved: boolean;
  /** True for the narrow, silently-mergeable cross-source exact lab class. */
  tier0: boolean;
  sources: string[];
}

export interface ReconcileReport {
  podDir: string;
  ranAt: string;
  /** False for a dry run. The single most important field in this object. */
  applied: boolean;
  /** Pod-relative bucket paths that were read. */
  filesRead: string[];
  /**
   * Record buckets that could not be read.
   *
   * ALWAYS EMPTY in any report a caller actually receives, and that is the
   * point: an unreadable record bucket ends the run at exit 2 before a report
   * exists. The field is kept so the shape of the report states the invariant
   * rather than leaving a reader to infer it, and so a future partial-read mode
   * would have somewhere honest to put the names. It never means "some of your
   * records were quietly skipped", because that outcome is not reachable.
   */
  filesUnreadable: string[];
  recordsBefore: number;
  recordsAfter: number;
  summary: {
    exactDuplicatesRemoved: number;
    nearDuplicatesMerged: number;
    conflictsResolved: number;
    conflictsUnresolved: number;
    identityCollisionsSplit: number;
    tier0MergesApplied: number;
  };
  /** Every group that is not a plain pass-through, itemized. */
  groups: ReconcileGroupReport[];
  /** The tier-0 subset, with the discarded records retained for undo. */
  tier0Merges: Tier0Merge[];
  filesWritten: string[];
}

// ---------------------------------------------------------------------------

/** Parse Turtle into quads grouped by subject, under a per-text sentinel base. */
async function parseBySubject(turtle: string): Promise<Map<string, Quad[]>> {
  const base = relBaseFor(turtle);
  const parser = new Parser({ format: 'Turtle', baseIRI: base });
  const collected: Quad[] = [];
  return new Promise((resolve, reject) => {
    parser.parse(turtle, (error, quad) => {
      if (error) {
        reject(error);
        return;
      }
      if (!quad) {
        const bySubject = new Map<string, Quad[]>();
        for (const q of derelativizeQuads(collected, base)) {
          const bucket = bySubject.get(q.subject.value);
          if (bucket) bucket.push(q);
          else bySubject.set(q.subject.value, [q]);
        }
        resolve(bySubject);
        return;
      }
      collected.push(quad);
    });
  });
}

/** Route a subject's rdf:type to the DATA_TYPES bucket that holds it. */
function routeTypeKey(quads: Quad[]): string {
  const typeIri = quads.find((q) => q.predicate.value === RDF_TYPE)?.object.value ?? '';
  for (const [key, info] of Object.entries(DATA_TYPES)) {
    if (info.isFhirPassthroughBucket) continue;
    if (info.rdfTypes.includes(typeIri)) return key;
  }
  return 'fhir-passthrough';
}

/** Pod-relative path of every REGISTERED record bucket, keyed by DATA_TYPES key. */
function registeredBuckets(): Array<{ key: string; rel: string }> {
  return Object.entries(DATA_TYPES)
    .map(([key, info]) => ({ key, rel: `${info.directory}/${info.filename}` }))
    .filter(({ rel }) => DATA_DIRS.some((d) => rel.startsWith(`${d}/`)))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Read every REGISTERED record bucket as a reconciler input.
 *
 * ONLY registered buckets, and that is a safety property rather than a
 * shortcut. This verb's output is a COMPLETE replacement of the records it
 * covers: what comes back from the reconciler is routed by `rdf:type` and
 * written over the bucket that type belongs to. A pod legitimately keeps notes,
 * analyses and literature as `.ttl` under `clinical/`, and reading one of those
 * would sweep its subjects into the merged result, where routing has no bucket
 * for them and files them under passthrough — quietly RELOCATING a note as a
 * side effect of reconciling records. `pod import` sweeps the directory because
 * it only ever adds; a verb that replaces cannot.
 *
 * Each bucket is its OWN input, labelled with its pod-relative path. The label
 * is only a default for records that state no `cascade:sourceSystem`, and pod
 * records all state one, so it never overrides what the pod says: it exists so
 * the report can name which file a record came out of.
 *
 * `existingPod` is deliberately NOT set. That flag selects the import fast path,
 * whose whole point is that stored records are candidates but never seeds, and a
 * pod-only reconcile would then compare nothing with anything. This verb wants
 * the ordinary path, where every record is a seed, which is exactly the
 * comparison an import declines to make and the reason this verb exists.
 */
async function readPodBuckets(
  reader: PodReader,
): Promise<{
  inputs: ReconcilerInput[];
  filesRead: string[];
  unreadable: string[];
  ledger: PodReadLedger;
}> {
  const inputs: ReconcilerInput[] = [];
  const filesRead: string[] = [];
  const unreadable: string[] = [];
  const ledger = new PodReadLedger();

  for (const { rel } of registeredBuckets()) {
    const abs = path.join(reader.podDir, ...rel.split('/'));
    if (!fsSync.existsSync(abs)) continue;
    ledger.attempt();

    // Through the SHARED read door, not a local try/catch. It is the only thing
    // that can tell a wrong key from a plaintext file inside a sealed pod: those
    // fail GCM identically, and the raw error for both blames the passphrase,
    // which for the second one is a lie that sends a user to re-check the one
    // thing that is not wrong.
    const text = reader.readText(abs);
    if (!text.ok) {
      ledger.record(text.failure);
      unreadable.push(rel);
      continue;
    }
    if (text.value.trim().length === 0) continue;

    try {
      await parseBySubject(text.value);
    } catch (e: unknown) {
      ledger.record({
        file: rel,
        kind: 'parse',
        reason: tidyReason(e instanceof Error ? e.message : String(e)),
      });
      unreadable.push(rel);
      continue;
    }

    inputs.push({ content: text.value, systemName: rel });
    filesRead.push(rel);
  }
  return { inputs, filesRead, unreadable, ledger };
}

/**
 * Record subjects (those carrying an `rdf:type`) in one Turtle document.
 *
 * The BEFORE and AFTER counts this verb reports are both taken this way, over
 * the actual text, and that symmetry is the point.
 *
 * The reconciler's own `finalRecordCount` is the number of GROUPS, which counts
 * only reconcilable records: a pod's documents, reports and profile pass through
 * as subjects the matcher never groups, so they are absent from it. Reporting
 * that against a subject count of the input made a pod where nothing merged read
 * "4 records in, 3 records out" — a fabricated deletion, on the one surface
 * whose entire job is to tell a user what a merge would cost them.
 */
function countRecordSubjects(turtle: string): number {
  const subjects = new Set<string>();
  for (const q of new Parser({ format: 'Turtle', baseIRI: relBaseFor(turtle) }).parse(turtle)) {
    if (q.predicate.value === RDF_TYPE) subjects.add(q.subject.value);
  }
  return subjects.size;
}

/** The same count across every input document. */
function countRecordsIn(inputs: ReconcilerInput[]): number {
  const subjects = new Set<string>();
  for (const input of inputs) {
    for (const q of new Parser({ format: 'Turtle', baseIRI: relBaseFor(input.content) }).parse(
      input.content,
    )) {
      if (q.predicate.value === RDF_TYPE) subjects.add(q.subject.value);
    }
  }
  return subjects.size;
}

// ---------------------------------------------------------------------------

function renderTextReport(report: ReconcileReport): string {
  const lines: string[] = [];
  const s = report.summary;
  const merges = s.exactDuplicatesRemoved + s.nearDuplicatesMerged;

  lines.push('');
  lines.push(report.applied ? `Reconciled pod at ${report.podDir}` : `Dry run over pod at ${report.podDir}`);
  lines.push(`  Read ${report.filesRead.length} record file(s), ${report.recordsBefore} record(s).`);
  lines.push('');

  if (merges === 0 && s.conflictsUnresolved === 0 && s.conflictsResolved === 0) {
    lines.push('  No duplicates and no conflicts found. Nothing to reconcile.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(report.applied ? '  Applied:' : '  Would apply:');
  lines.push(`    ${s.exactDuplicatesRemoved} exact duplicate group(s) merged`);
  lines.push(`    ${s.nearDuplicatesMerged} near-duplicate group(s) merged`);
  lines.push(`    ${s.conflictsResolved} conflict(s) resolved by trust`);
  lines.push(
    `    ${report.recordsBefore} record(s) in, ${report.recordsAfter} record(s) out ` +
      `(${report.recordsBefore - report.recordsAfter} fewer)`,
  );
  lines.push('');

  if (s.tier0MergesApplied > 0) {
    lines.push(
      `  Of those, ${s.tier0MergesApplied} are cross-source exact lab duplicates (tier 0): identical`,
    );
    lines.push('  result, same instant, different known sources. These merge without asking, and each');
    lines.push(`  one is recorded with its discarded record in ${TIER0_JOURNAL_RELATIVE_PATH}.`);
    for (const m of report.tier0Merges) {
      lines.push(`    ${m.matchedOn}  ${m.origins.join(' + ')}`);
      lines.push(`      keep    ${m.canonicalUri}`);
      for (const d of m.discarded) lines.push(`      merge   ${d.uri}`);
    }
    lines.push('');
  }

  const unresolved = report.groups.filter((g) => !g.resolved);
  if (unresolved.length > 0) {
    lines.push(`  ${unresolved.length} group(s) NOT merged, raised for review:`);
    for (const g of unresolved) {
      lines.push(`    ${g.recordType}  ${g.matchedOn || '(no match key)'}  [${g.type}]`);
    }
    lines.push(
      report.applied
        ? '    Run `cascade pod conflicts <pod-dir>` to see them.'
        : '    With --apply these are written to settings/pending-conflicts.ttl.',
    );
    lines.push('');
  }

  if (report.filesUnreadable.length > 0) {
    lines.push(`  ${report.filesUnreadable.length} file(s) could NOT be read and were excluded:`);
    for (const f of report.filesUnreadable) lines.push(`    ${f}`);
    lines.push('');
  }

  if (!report.applied) {
    lines.push('  DRY RUN. Nothing was written.');
    lines.push(`  Re-run with --apply to merge: cascade pod reconcile ${report.podDir} --apply`);
    lines.push('');
  } else {
    lines.push(`  Wrote ${report.filesWritten.length} file(s).`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------

export function registerReconcileSubcommand(podProgram: Command, program: Command): void {
  podProgram
    .command('reconcile')
    .description(
      'Find (and with --apply, merge) duplicates a pod ALREADY holds. Dry run by default.',
    )
    .argument('<pod-dir>', 'Path to the Cascade Pod directory')
    .option(
      '--apply',
      'Actually merge and write. Without this the command only reports what it would do.',
      false,
    )
    .option('--trust <scores>', 'Trust scores, e.g. hospital=0.95,clinic=0.85')
    .option('--report <file>', 'Write the full report as JSON to this file')
    .action(
      async (
        podDirArg: string,
        options: { apply?: boolean; trust?: string; report?: string },
      ) => {
        const globalOpts = program.opts() as OutputOptions;
        const podDir = resolvePodDir(podDirArg);
        const apply = options.apply === true;

        // "This pod has no duplicates" and "there is no pod here" are opposite
        // answers, and a directory that does not exist reads as an empty sweep
        // unless it is checked for. `openPod` cannot make this distinction: an
        // unencrypted pod needs no key, so a missing directory opens fine.
        if (!fsSync.existsSync(podDir) || !fsSync.statSync(podDir).isDirectory()) {
          printError(`Not a pod directory: ${podDir}`, globalOpts);
          process.exitCode = 2;
          return;
        }

        let reader: PodReader;
        try {
          reader = await openPod(podDir);
        } catch (err: unknown) {
          printError(
            `Could not open the pod at ${podDir}: ${err instanceof Error ? err.message : String(err)}`,
            globalOpts,
          );
          process.exitCode = 2;
          return;
        }
        const dek = reader.dek;

        const trustScores: Record<string, number> = {};
        for (const pair of (options.trust ?? '').split(',')) {
          const [k, v] = pair.split('=');
          if (k && v && !Number.isNaN(Number(v))) trustScores[k.trim()] = Number(v);
        }

        const { inputs, filesRead, unreadable, ledger } = await readPodBuckets(reader);

        // A record file this run could not read is FATAL, in the dry run as much
        // as under --apply, and that is the whole judgement of this command.
        //
        // Every number this verb prints is a statement about the pod's WHOLE
        // record set: "these two are duplicates" is only true if nothing else in
        // the pod is a third copy, and "nothing would merge" is only true if
        // every record was compared. A file that was never opened could hold
        // either. So a report produced over a partial read is not a smaller
        // answer, it is a wrong one — the same reasoning `pod doctor` applies,
        // for the same reason: a verb whose entire output is a claim about the
        // pod must not make that claim about files it never read.
        //
        // The ledger's softer branch cannot fire here: it downgrades a parse
        // failure only for a file that is NOT a registered record file, and
        // `readPodBuckets` reads nothing else. So every read failure this verb
        // can have is fatal, and there is no partial-answer case to print.
        if (ledger.hasFatal) {
          for (const f of ledger.fatal) {
            printError(`Could not read ${f.file}: ${f.reason}`, globalOpts);
          }
          printError(
            `Refusing to reconcile ${podDir}: ${ledger.fatal.length} of ${ledger.attempted} record ` +
              `file(s) could not be read. Every count this command reports is a claim about the ` +
              `whole pod, and those files were never opened. The pod is unchanged.`,
            globalOpts,
          );
          process.exitCode = 2;
          return;
        }

        if (inputs.length === 0) {
          printResult(
            globalOpts.json
              ? {
                  podDir,
                  ranAt: new Date().toISOString(),
                  applied: false,
                  filesRead,
                  filesUnreadable: unreadable,
                  recordsBefore: 0,
                  recordsAfter: 0,
                  summary: {
                    exactDuplicatesRemoved: 0,
                    nearDuplicatesMerged: 0,
                    conflictsResolved: 0,
                    conflictsUnresolved: 0,
                    identityCollisionsSplit: 0,
                    tier0MergesApplied: 0,
                  },
                  groups: [],
                  tier0Merges: [],
                  filesWritten: [],
                }
              : `\nNo reconcilable records found in ${podDir}.\n`,
            globalOpts,
          );
          return;
        }

        const recordsBefore = countRecordsIn(inputs);
        printVerbose(`Reconciling ${recordsBefore} record(s) from ${inputs.length} file(s)...`, globalOpts);

        const result = await runReconciliation(inputs, { trustScores, labTolerance: 0.05 });

        const groups: ReconcileGroupReport[] = (
          result.report.transformations as Array<{
            type: string;
            recordType: string;
            canonicalUri: string;
            matchedOn: string;
            strategy: string;
            resolved: boolean;
            tier0?: boolean;
            sources?: string[];
          }>
        ).map((t) => ({
          type: t.type,
          recordType: t.recordType,
          canonicalUri: t.canonicalUri,
          matchedOn: t.matchedOn,
          strategy: t.strategy,
          resolved: t.resolved,
          tier0: t.tier0 === true,
          sources: t.sources ?? [],
        }));

        const report: ReconcileReport = {
          podDir,
          ranAt: new Date().toISOString(),
          applied: false,
          filesRead,
          filesUnreadable: unreadable,
          recordsBefore,
          recordsAfter: countRecordSubjects(result.turtle),
          summary: {
            exactDuplicatesRemoved: result.report.summary.exactDuplicatesRemoved,
            nearDuplicatesMerged: result.report.summary.nearDuplicatesMerged,
            conflictsResolved: result.report.summary.conflictsResolved,
            conflictsUnresolved: result.report.summary.conflictsUnresolved,
            identityCollisionsSplit: result.report.summary.identityCollisionsSplit,
            tier0MergesApplied: result.report.summary.tier0MergesApplied,
          },
          groups,
          tier0Merges: result.report.tier0Merges,
          filesWritten: [],
        };

        if (apply) {
          let subjectQuads: Map<string, Quad[]>;
          try {
            subjectQuads = await parseBySubject(result.turtle);
          } catch (err: unknown) {
            printError(
              `Failed to parse the reconciled Turtle: ${err instanceof Error ? err.message : String(err)}. ` +
                `The pod is unchanged.`,
              globalOpts,
            );
            process.exitCode = 1;
            return;
          }

          const buckets = new Map<string, Quad[][]>();
          for (const [, quads] of subjectQuads) {
            const key = routeTypeKey(quads);
            const bucket = buckets.get(key);
            if (bucket) bucket.push(quads);
            else buckets.set(key, [quads]);
          }

          // Every target is a REGISTERED bucket, which `readPodBuckets` already
          // guarantees for `filesRead` and the routing table guarantees for the
          // rest. Each is written with `combine: incoming`: the merged result is
          // a complete replacement of the records it covers, so the file's prior
          // content is discarded rather than added to.
          //
          // A bucket that was read but received nothing IS still written, and
          // emptied. That is a file whose records all routed elsewhere, and
          // leaving it holding its pre-merge copies would duplicate every one of
          // them.
          const keysByRel = new Map<string, string>();
          for (const { key, rel } of registeredBuckets()) keysByRel.set(rel, key);
          const targets = new Set<string>(filesRead);
          for (const key of buckets.keys()) {
            const info = DATA_TYPES[key];
            if (info) targets.add(`${info.directory}/${info.filename}`);
          }

          const failed: string[] = [];
          for (const rel of [...targets].sort()) {
            const key = keysByRel.get(rel);
            if (!key) continue;
            const quads = (buckets.get(key) ?? []).flat();
            const target = path.join(podDir, ...rel.split('/'));
            if (quads.length === 0 && !fsSync.existsSync(target)) continue;
            try {
              await mergeIntoBucket(target, quads, dek, { combine: (_existing, incoming) => incoming });
              report.filesWritten.push(rel);
            } catch (e: unknown) {
              printError(
                `Refusing to write ${rel}: ${e instanceof Error ? e.message : String(e)}`,
                globalOpts,
              );
              failed.push(rel);
            }
          }

          // Conflicts this run raised go through the SAME queue every other
          // conflict does, so `pod conflicts` and `pod resolve` see them.
          const pendingConflicts: PendingConflict[] = (
            result.report.unresolvedConflicts as Array<{
              recordType: string;
              matchedOn: string;
              sources?: string[];
              candidateUris?: string[];
              label?: string;
            }>
          ).map((c) => ({
            uri: `urn:uuid:conflict-${randomUUID()}`,
            conflictId: generateConflictId(c.recordType, c.matchedOn),
            recordType: c.recordType,
            detectedAt: new Date(),
            candidateRecordUris: c.candidateUris ?? [],
            label: c.label,
            sourceA: c.sources?.[0],
            sourceB: c.sources?.[1],
          }));
          const conflictsFile = path.join(podDir, 'settings', 'pending-conflicts.ttl');
          if (pendingConflicts.length > 0 || fsSync.existsSync(conflictsFile)) {
            await writePendingConflicts(podDir, pendingConflicts, dek);
          }

          if (result.report.tier0Merges.length > 0) {
            appendTier0Journal(podDir, result.report.tier0Merges, 'pod reconcile --apply', dek);
          }

          report.applied = true;
          if (failed.length > 0) process.exitCode = 1;
        }

        if (options.report) {
          await fs.writeFile(options.report, toJsonText(report), 'utf-8');
        }

        printResult(globalOpts.json ? report : renderTextReport(report), globalOpts);
      },
    );
}
