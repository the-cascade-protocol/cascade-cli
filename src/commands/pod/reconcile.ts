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
 * AND THE WAY BACK
 * ----------------
 * `--undo` replays `settings/tier0-merge-journal.json` and puts the silently
 * merged records back. It is the same shape as the forward verb — report first,
 * `--apply` to write — because it is the same kind of decision, and reversibility
 * that only exists as a JSON file a person could read by hand is reversibility in
 * principle. See {@link runUndo}.
 *
 * Exit codes:
 *   0 — the run completed (a dry run, or an --apply that wrote successfully)
 *   1 — the reconciliation ran but at least one bucket could not be WRITTEN, or
 *       an --undo run refused at least one journal entry
 *   2 — the pod could not be opened, or a record file in it could not be READ,
 *       or the review queue / the journal exists and could not be read.
 *       These are exit 2 in the DRY RUN too: this command's whole output is a
 *       claim about the pod's whole record set, and it must not make that claim
 *       about files it never opened.
 */

import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { Parser, DataFactory } from 'n3';
import type { Quad } from 'n3';
import { printResult, printError, printVerbose, type OutputOptions } from '../../lib/output.js';
import { toJsonText } from '../../lib/json-output.js';
import { runReconciliation, type ReconcilerInput, type Tier0Merge } from '../../lib/reconciler.js';
import { DATA_TYPES, resolvePodDir } from './helpers.js';
import { openPod, PodReadLedger, tidyReason, type PodReader } from '../../lib/pod-read.js';
import { mergeIntoBucket, derelativizeQuads, relBaseFor } from '../../lib/bucket-write.js';
import {
  writePendingConflicts,
  loadPendingConflicts,
  pendingConflictFromRaised,
  type PendingConflict,
  type RaisedConflict,
} from '../../lib/user-resolutions.js';
import {
  appendTier0Journal,
  appendTier0Undo,
  isMergeEntry,
  readTier0Journal,
  restoredUris,
  TIER0_JOURNAL_RELATIVE_PATH,
  type Tier0Journal,
} from '../../lib/tier0-journal.js';
import { shellCommand } from '../../lib/shell-quote.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const MERGED_FROM = 'https://ns.cascadeprotocol.org/core/v1#mergedFrom';

const { namedNode, literal, quad: makeQuad } = DataFactory;

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
  /** INGESTION axis: the import batch each record of the group arrived in. */
  sources: string[];
  /**
   * ORIGIN axis: which organization each record came from, one per record, in
   * the same order as `sources`.
   *
   * Reported separately rather than replacing `sources` because the two are
   * different facts and both are worth having. A pod-internal run reads every
   * record through one door, so `sources` is legitimately one repeated string
   * there — which is fine as an answer to "how did this get here" and useless as
   * an answer to "who says what".
   */
  origins: string[];
}

/**
 * What this run does to the queue of conflicts a person still has to answer.
 *
 * WHY THIS IS A REPORTED FIELD AND NOT AN IMPLEMENTATION DETAIL
 * -------------------------------------------------------------
 * `settings/pending-conflicts.ttl` is a user-decision queue: each row is a
 * question the tool declined to answer on its own. Applying a reconcile used to
 * write that file from the run's OWN conflicts alone, so every question already
 * in it was discarded whether or not anything about it had changed. Measured on
 * a real pod: eight conflict subjects before, zero after, and a run report that
 * did not mention conflicts at all.
 *
 * Most of those eight were probably moot — their candidates had merged, so there
 * was nothing left to choose between. But "probably" is doing all the work in
 * that sentence, and the case it does not cover is a question about records that
 * are still there, still different, and now silently un-asked.
 *
 * So the queue is now rewritten from a decision about each row, and the decision
 * is counted here. "N items left your review queue" is a fact the user is told,
 * not one they discover by diffing a settings file.
 */
export interface PendingConflictDisposition {
  /** Rows in the queue before this run. */
  before: number;
  /** Rows this run's own reconciliation raises. */
  raised: number;
  /**
   * Pre-existing rows carried forward: two or more of their candidate records
   * are still in the pod as distinct records, so the question still stands.
   */
  kept: number;
  /**
   * Pre-existing rows retired because their candidates merged. The choice they
   * asked for has been made by the merge, so the row is answered, not dropped.
   */
  clearedByMerge: number;
  /**
   * Pre-existing rows whose candidate records are no longer in the pod at all,
   * and not because of a merge this run performed. Nothing can act on them, so
   * they do not survive — but they are counted and named, because "your queue
   * shrank and no merge explains it" is exactly the sentence a silent rewrite
   * would have swallowed.
   */
  orphaned: number;
  /** Rows the queue holds afterwards. `raised` plus `kept`, minus re-raises. */
  after: number;
  /** The conflict ids behind `clearedByMerge`, sorted. */
  clearedIds: string[];
  /** The conflict ids behind `orphaned`, sorted. */
  orphanedIds: string[];
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
  /** What this run does to the pending-conflict queue. */
  pendingConflicts: PendingConflictDisposition;
  filesWritten: string[];
}

/** A disposition for a pod where nothing was read and nothing can change. */
export function emptyDisposition(before = 0): PendingConflictDisposition {
  return {
    before,
    raised: 0,
    kept: before,
    clearedByMerge: 0,
    orphaned: 0,
    after: before,
    clearedIds: [],
    orphanedIds: [],
  };
}

// ---------------------------------------------------------------------------
// The undo report
// ---------------------------------------------------------------------------

/** What `--undo` would do, or did, to one journalled merge. */
export interface UndoMergeReport {
  /** When the run that applied this merge completed. */
  appliedAt: string;
  /** The record that survived the merge and goes on existing. */
  canonicalUri: string;
  recordType: string;
  matchedOn: string;
  /** The discarded record IRIs this entry would put back. */
  restores: string[];
  /**
   * `restorable`      every discarded record can go back where it came from.
   * `already-undone`  the journal already records these as restored.
   * `blocked`         something about the pod stops it, named in `reason`.
   */
  status: 'restorable' | 'already-undone' | 'blocked';
  /** Why a blocked entry is blocked. Absent otherwise. */
  reason?: string;
  /** Pod-relative bucket the records go back into, when one was resolvable. */
  bucket?: string;
  /**
   * Whether the record the merge KEPT is still in the pod.
   *
   * False does not block the restore, and that is a deliberate asymmetry. The
   * journal exists so a discarded record can always be recovered; refusing to
   * give it back because the record it was merged into has since been deleted
   * would make the recovery surface fail exactly when it is most needed. It is
   * reported because it means the pod is no longer in the state the journal
   * describes, and there is then no lineage edge to withdraw.
   */
  canonicalPresent: boolean;
}

export interface ReconcileUndoReport {
  podDir: string;
  ranAt: string;
  /** False for a dry run. The single most important field in this object. */
  applied: boolean;
  /** Pod-relative location of the journal that was replayed. */
  journal: string;
  /** Every merge the journal holds, with what would happen to it. */
  merges: UndoMergeReport[];
  /** Records put back (or that would be). */
  recordsRestored: number;
  /** Merges reversed (or that would be). */
  mergesUndone: number;
  /** Merges already reversed by an earlier undo run. */
  alreadyUndone: number;
  /** Merges that could NOT be reversed. Non-zero means exit 1. */
  blocked: number;
  /** `cascade:mergedFrom` edges withdrawn from the surviving records. */
  lineageEdgesRemoved: number;
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

/**
 * Decide what happens to every row of the pending-conflict queue, and build the
 * queue this run would leave behind.
 *
 * THE TWO POPULATIONS THE RECONCILED TEXT DISTINGUISHES
 * ----------------------------------------------------
 * A record IRI that was in the pod and is not in the reconciled output either
 * MERGED into another record — in which case the survivor carries
 * `cascade:mergedFrom` pointing at it, which is the lineage the reconciler
 * writes — or it is simply gone. Those two are opposite facts about a conflict:
 * the first ANSWERS it, the second means nothing here can act on it. Reading
 * only "is it still a subject" would collapse them and let a vanished record
 * look like a resolved one.
 *
 * A row survives when two or more of its candidates are still distinct records,
 * because that is the condition under which there is still something to choose
 * between. One candidate left is not a choice.
 *
 * Re-raised rows are deduplicated on `conflictId`, and the PRE-EXISTING row wins:
 * it carries the `detectedAt` the user first saw and the subject IRI anything
 * else in the pod may reference. A conflict does not become newer by being
 * noticed again.
 */
export function disposePendingConflicts(
  existing: readonly PendingConflict[],
  raised: readonly PendingConflict[],
  reconciledTurtle: string,
): { disposition: PendingConflictDisposition; queue: PendingConflict[] } {
  const surviving = new Set<string>();
  const absorbed = new Set<string>();
  for (const q of new Parser({ format: 'Turtle', baseIRI: relBaseFor(reconciledTurtle) }).parse(
    reconciledTurtle,
  )) {
    if (q.predicate.value === RDF_TYPE) surviving.add(q.subject.value);
    else if (q.predicate.value === MERGED_FROM) absorbed.add(q.object.value);
  }

  const kept: PendingConflict[] = [];
  const clearedIds: string[] = [];
  const orphanedIds: string[] = [];

  for (const c of existing) {
    const alive = c.candidateRecordUris.filter((u) => surviving.has(u));
    const merged = c.candidateRecordUris.filter((u) => absorbed.has(u));
    if (alive.length >= 2) {
      kept.push(c);
    } else if (merged.length > 0) {
      clearedIds.push(c.conflictId);
    } else {
      orphanedIds.push(c.conflictId);
    }
  }

  const keptIds = new Set(kept.map((c) => c.conflictId));
  const newRows = raised.filter((c) => !keptIds.has(c.conflictId));

  return {
    disposition: {
      before: existing.length,
      raised: raised.length,
      kept: kept.length,
      clearedByMerge: clearedIds.length,
      orphaned: orphanedIds.length,
      after: kept.length + newRows.length,
      clearedIds: clearedIds.sort(),
      orphanedIds: orphanedIds.sort(),
    },
    queue: [...kept, ...newRows],
  };
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/** Rebuild a journalled record's quads from the properties the journal kept. */
function quadsFromJournal(
  uri: string,
  properties: Record<string, Array<{ value: string; datatype?: string; isIri?: boolean }>>,
): Quad[] {
  const subject = namedNode(uri);
  const out: Quad[] = [];
  for (const [predicate, values] of Object.entries(properties)) {
    for (const v of values) {
      const object = v.isIri
        ? namedNode(v.value)
        : v.datatype
          ? literal(v.value, namedNode(v.datatype))
          : literal(v.value);
      out.push(makeQuad(subject, namedNode(predicate), object));
    }
  }
  return out;
}

/** The rdf:type IRI a journalled record carried, if it carried one. */
function journalledTypeIri(
  properties: Record<string, Array<{ value: string; datatype?: string; isIri?: boolean }>>,
): string | undefined {
  return properties[RDF_TYPE]?.[0]?.value;
}

/** The registered bucket a type IRI belongs in, pod-relative. */
function bucketForType(typeIri: string): string | undefined {
  for (const info of Object.values(DATA_TYPES)) {
    if (info.isFhirPassthroughBucket) continue;
    if (info.rdfTypes.includes(typeIri)) return `${info.directory}/${info.filename}`;
  }
  return undefined;
}

function renderUndoReport(report: ReconcileUndoReport): string {
  const lines: string[] = [''];
  lines.push(
    report.applied
      ? `Undid tier-0 merges in the pod at ${report.podDir}`
      : `Dry run over the tier-0 merge journal of ${report.podDir}`,
  );
  lines.push(`  Journal: ${report.journal}`);
  lines.push('');

  if (report.merges.length === 0) {
    lines.push('  The journal records no tier-0 merges. There is nothing to undo.');
    lines.push('');
    return lines.join('\n');
  }

  const pending = report.merges.filter((m) => m.status === 'restorable');
  const blocked = report.merges.filter((m) => m.status === 'blocked');

  if (pending.length > 0) {
    lines.push(
      report.applied
        ? `  Restored ${report.recordsRestored} record(s) from ${report.mergesUndone} merge(s):`
        : `  Would restore ${report.recordsRestored} record(s) from ${report.mergesUndone} merge(s):`,
    );
    for (const m of pending) {
      lines.push(`    ${m.matchedOn}  (merged ${m.appliedAt})`);
      lines.push(
        `      keep     ${m.canonicalUri}${m.canonicalPresent ? '' : '  [no longer in the pod]'}`,
      );
      for (const uri of m.restores) lines.push(`      restore  ${uri}  -> ${m.bucket}`);
    }
    lines.push('');
  }

  if (report.alreadyUndone > 0) {
    lines.push(
      `  ${report.alreadyUndone} merge(s) were already undone by an earlier run and were left alone.`,
    );
    lines.push('');
  }

  if (blocked.length > 0) {
    lines.push(`  ${blocked.length} merge(s) could NOT be undone:`);
    for (const m of blocked) {
      lines.push(`    ${m.matchedOn}  (merged ${m.appliedAt})`);
      lines.push(`      ${m.reason}`);
    }
    lines.push(
      '    Each is refused on its own. The rest of the journal was replayed normally.',
    );
    lines.push('');
  }

  if (report.applied) {
    lines.push(
      `  Wrote ${report.filesWritten.length} file(s), withdrew ${report.lineageEdgesRemoved} ` +
        `cascade:mergedFrom edge(s), and appended the undo to the journal.`,
    );
  } else if (pending.length > 0) {
    lines.push('  DRY RUN. Nothing was written.');
    lines.push(
      '  Re-run with --apply to restore: ' +
        shellCommand('cascade', 'pod', 'reconcile', report.podDir, '--undo', '--apply'),
    );
  } else {
    lines.push('  Nothing to restore.');
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

/**
 * The review-queue paragraph. Printed whenever the queue held anything or this
 * run puts anything in it, INCLUDING on the "nothing to reconcile" path: a run
 * that merges nothing still rewrites the queue, and that is precisely the case
 * where a silent change would be least expected.
 */
function renderConflictQueue(report: ReconcileReport): string[] {
  const p = report.pendingConflicts;
  if (p.before === 0 && p.raised === 0) return [];

  const lines: string[] = [];
  const verb = report.applied ? '' : ' would';
  lines.push(`  Review queue (settings/pending-conflicts.ttl): ${p.before} item(s) before,`);
  lines.push(`  ${p.after} after.`);
  if (p.kept > 0) lines.push(`    ${p.kept} kept: their records are still distinct and still need a decision.`);
  if (p.raised > 0) lines.push(`    ${p.raised} raised by this run.`);
  if (p.clearedByMerge > 0) {
    lines.push(
      `    ${p.clearedByMerge} cleared by merge: their candidate records became one, so the`,
    );
    lines.push('    question is answered rather than dropped.');
    for (const id of p.clearedIds) lines.push(`      ${id}`);
  }
  if (p.orphaned > 0) {
    lines.push(
      `    ${p.orphaned} orphaned: their candidate records are no longer in the pod, and no`,
    );
    lines.push(`    merge in this run explains it. These${verb} leave the queue unanswered.`);
    for (const id of p.orphanedIds) lines.push(`      ${id}`);
  }
  lines.push('');
  return lines;
}

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
    lines.push(...renderConflictQueue(report));
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

  lines.push(...renderConflictQueue(report));

  if (report.filesUnreadable.length > 0) {
    lines.push(`  ${report.filesUnreadable.length} file(s) could NOT be read and were excluded:`);
    for (const f of report.filesUnreadable) lines.push(`    ${f}`);
    lines.push('');
  }

  if (!report.applied) {
    lines.push('  DRY RUN. Nothing was written.');
    lines.push(
      `  Re-run with --apply to merge: ` +
        shellCommand('cascade', 'pod', 'reconcile', report.podDir, '--apply'),
    );
    lines.push('');
  } else {
    lines.push(`  Wrote ${report.filesWritten.length} file(s).`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------

/**
 * `--undo`: replay the tier-0 journal and put the silently merged records back.
 *
 * WHY THE JOURNAL IS ENOUGH, AND WHY IT IS THE ONLY INPUT
 * ------------------------------------------------------
 * The tier-0 ruling lets one narrow class of duplicate merge without asking
 * anyone. That is only defensible because every such merge is written to
 * `settings/tier0-merge-journal.json` with the FULL content of every record it
 * discarded. Until now that made the merges reversible in principle and by hand.
 * This is the verb that makes them reversible in practice, and it reads nothing
 * but the journal and the pod: not the original import files, not the pod's
 * history, and not the tier-0 rule, which may well have been what the person
 * running this disagrees with.
 *
 * SAFE TO RUN TWICE, BY CONSTRUCTION
 * ----------------------------------
 * The undo is itself journalled, appended rather than substituted for the merge
 * entry it reverses. So the set of records already put back is derivable from
 * the journal, a second run finds nothing outstanding, and it writes nothing —
 * rather than restoring a second copy of every record, which is what a
 * re-runnable restore with no memory would do.
 *
 * REFUSALS ARE PER ENTRY
 * ----------------------
 * Two things about the pod can make one journalled merge unrestorable: the
 * bucket its records belong in is gone, or a live record already holds the IRI
 * being restored. Both mean the pod has moved on from what the journal
 * describes, and both are decisions for a person. They are refused ONE AT A
 * TIME, loudly, with the rest of the journal replayed normally — because
 * abandoning the whole run over one entry would make an unrelated recoverable
 * record unrecoverable, and the exit code says clearly enough that something
 * needs looking at.
 */
async function runUndo(
  podDir: string,
  reader: PodReader,
  apply: boolean,
  reportFile: string | undefined,
  globalOpts: OutputOptions,
): Promise<void> {
  const dek = reader.dek;

  let journal: Tier0Journal;
  try {
    journal = readTier0Journal(podDir, dek);
  } catch (err: unknown) {
    printError(
      `Could not read ${TIER0_JOURNAL_RELATIVE_PATH}: ` +
        `${err instanceof Error ? err.message : String(err)}. "there were no silent merges" and ` +
        `"I cannot tell you what was merged away" are opposite answers, and this is the second ` +
        `one. The pod is unchanged.`,
      globalOpts,
    );
    process.exitCode = 2;
    return;
  }

  // The pod is read for the same reason the reconcile path reads it: every
  // judgement below is about whether a record can go back, and a bucket that was
  // never opened could hold the live record that stops it.
  const { inputs, filesRead, ledger } = await readPodBuckets(reader);
  if (ledger.hasFatal) {
    for (const f of ledger.fatal) printError(`Could not read ${f.file}: ${f.reason}`, globalOpts);
    printError(
      `Refusing to undo in ${podDir}: ${ledger.fatal.length} of ${ledger.attempted} record ` +
        `file(s) could not be read, and a record restored beside a live copy this run never saw ` +
        `would be a duplicate. The pod is unchanged.`,
      globalOpts,
    );
    process.exitCode = 2;
    return;
  }

  const live = new Set<string>();
  for (const input of inputs) {
    for (const q of new Parser({ format: 'Turtle', baseIRI: relBaseFor(input.content) }).parse(
      input.content,
    )) {
      if (q.predicate.value === RDF_TYPE) live.add(q.subject.value);
    }
  }

  const alreadyRestored = restoredUris(journal);
  const merges: UndoMergeReport[] = [];
  /** Restorable quads, keyed by the pod-relative bucket they belong in. */
  const toWrite = new Map<string, Quad[]>();
  const restoredSet = new Set<string>();
  const undone: Array<{ canonicalUri: string; restoredUris: string[] }> = [];

  for (const entry of journal.entries) {
    if (!isMergeEntry(entry)) continue;
    for (const merge of entry.merges) {
      const restores = merge.discarded.map((d) => d.uri);
      const base = {
        appliedAt: entry.appliedAt,
        canonicalUri: merge.canonicalUri,
        recordType: merge.recordType,
        matchedOn: merge.matchedOn,
        restores,
        canonicalPresent: live.has(merge.canonicalUri),
      };

      if (restores.every((u) => alreadyRestored.has(u))) {
        merges.push({ ...base, status: 'already-undone' });
        continue;
      }

      let reason: string | undefined;
      let bucket: string | undefined;
      const quads: Quad[] = [];
      for (const d of merge.discarded) {
        if (live.has(d.uri)) {
          reason =
            `a live record already holds ${d.uri}, so restoring the journalled copy would ` +
            `create a second record under one IRI. Nothing was restored for this merge.`;
          break;
        }
        const typeIri = journalledTypeIri(d.properties);
        if (!typeIri) {
          reason = `the journalled record ${d.uri} states no rdf:type, so nothing can route it to a bucket.`;
          break;
        }
        const rel = bucketForType(typeIri);
        if (!rel) {
          reason = `no registered bucket holds <${typeIri}>, which is the type of ${d.uri}.`;
          break;
        }
        if (!fsSync.existsSync(path.join(podDir, ...rel.split('/')))) {
          reason =
            `the bucket ${rel} that ${d.uri} belongs in no longer exists in this pod. ` +
            `Restoring into a file the pod has since dropped would put the record somewhere ` +
            `nothing reads.`;
          break;
        }
        bucket = rel;
        quads.push(...quadsFromJournal(d.uri, d.properties));
      }

      if (reason) {
        merges.push({ ...base, status: 'blocked', reason, bucket });
        continue;
      }

      merges.push({ ...base, status: 'restorable', bucket });
      const target = toWrite.get(bucket as string) ?? [];
      target.push(...quads);
      toWrite.set(bucket as string, target);
      for (const u of restores) restoredSet.add(u);
      undone.push({ canonicalUri: merge.canonicalUri, restoredUris: restores });
    }
  }

  const report: ReconcileUndoReport = {
    podDir,
    ranAt: new Date().toISOString(),
    applied: false,
    journal: TIER0_JOURNAL_RELATIVE_PATH,
    merges,
    recordsRestored: restoredSet.size,
    mergesUndone: merges.filter((m) => m.status === 'restorable').length,
    alreadyUndone: merges.filter((m) => m.status === 'already-undone').length,
    blocked: merges.filter((m) => m.status === 'blocked').length,
    lineageEdgesRemoved: 0,
    filesWritten: [],
  };

  if (apply && restoredSet.size > 0) {
    // Buckets that receive a restored record, PLUS any bucket holding a
    // `cascade:mergedFrom` edge that points at one. The second set is usually the
    // same as the first and does not have to be: the edge lives on the surviving
    // record, and nothing guarantees the survivor and the record it absorbed are
    // filed under one type forever.
    const targets = new Map<string, Quad[]>(toWrite);
    for (const rel of filesRead) {
      if (targets.has(rel)) continue;
      const abs = path.join(podDir, ...rel.split('/'));
      const text = reader.readText(abs);
      if (!text.ok) continue;
      const hasEdge = new Parser({ format: 'Turtle', baseIRI: relBaseFor(text.value) })
        .parse(text.value)
        .some((q) => q.predicate.value === MERGED_FROM && restoredSet.has(q.object.value));
      if (hasEdge) targets.set(rel, []);
    }

    const failed: string[] = [];
    for (const rel of [...targets.keys()].sort()) {
      const incoming = targets.get(rel) as Quad[];
      const abs = path.join(podDir, ...rel.split('/'));
      try {
        await mergeIntoBucket(abs, incoming, dek, {
          combine: (existing, added) => {
            // The lineage the merge wrote is withdrawn along with the merge. A
            // survivor that still claimed `mergedFrom` a record now sitting
            // beside it would state a merge the pod no longer contains, and the
            // restored record would read as both live and absorbed.
            const kept = existing.filter(
              (q) => !(q.predicate.value === MERGED_FROM && restoredSet.has(q.object.value)),
            );
            report.lineageEdgesRemoved += existing.length - kept.length;
            return [...kept, ...added];
          },
        });
        report.filesWritten.push(rel);
      } catch (e: unknown) {
        printError(
          `Refusing to write ${rel}: ${e instanceof Error ? e.message : String(e)}`,
          globalOpts,
        );
        failed.push(rel);
      }
    }

    if (failed.length === 0) {
      appendTier0Undo(podDir, undone, 'pod reconcile --undo --apply', dek);
      report.applied = true;
    } else {
      // The journal is NOT appended when a bucket failed: an undo entry claims
      // those records are back, and a later run would believe it and skip them.
      process.exitCode = 1;
    }
  }

  if (report.blocked > 0) process.exitCode = 1;

  if (reportFile) await fs.writeFile(reportFile, toJsonText(report), 'utf-8');
  printResult(globalOpts.json ? report : renderUndoReport(report), globalOpts);
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
    .option(
      '--undo',
      'Replay settings/tier0-merge-journal.json and put the silently merged records back. ' +
        'Reports by default; combine with --apply to write.',
      false,
    )
    .option('--trust <scores>', 'Trust scores, e.g. hospital=0.95,clinic=0.85')
    .option('--report <file>', 'Write the full report as JSON to this file')
    .action(
      async (
        podDirArg: string,
        options: { apply?: boolean; undo?: boolean; trust?: string; report?: string },
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

        if (options.undo === true) {
          await runUndo(podDir, reader, apply, options.report, globalOpts);
          return;
        }

        const trustScores: Record<string, number> = {};
        for (const pair of (options.trust ?? '').split(',')) {
          const [k, v] = pair.split('=');
          if (k && v && !Number.isNaN(Number(v))) trustScores[k.trim()] = Number(v);
        }

        // The review queue is read BEFORE anything is decided, and a queue that
        // exists and cannot be read ends the run. Under --apply this file is
        // rewritten, so a run that could not read it would be overwriting a set
        // of unanswered questions it never saw; in the dry run the report would
        // be claiming a disposition it never computed. Both are worse than
        // stopping.
        let existingConflicts: PendingConflict[];
        try {
          existingConflicts = await loadPendingConflicts(podDir, dek);
        } catch (err: unknown) {
          printError(
            `Could not read settings/pending-conflicts.ttl: ` +
              `${err instanceof Error ? err.message : String(err)}. Refusing to reconcile ` +
              `${podDir}: applying would rewrite a review queue this run cannot read. ` +
              `The pod is unchanged.`,
            globalOpts,
          );
          process.exitCode = 2;
          return;
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
                  // Nothing was read, so nothing can have merged and no row of
                  // the queue can have changed meaning. It is still reported,
                  // because "your queue has 8 items" is true and useful on a pod
                  // that holds no reconcilable records at all.
                  pendingConflicts: emptyDisposition(existingConflicts.length),
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

        // Conflicts this run raises go through the SAME queue every other conflict
        // does, so `pod conflicts` and `pod resolve` see them. Building them here
        // rather than inside the --apply branch is what lets the DRY RUN say what
        // the queue would look like, which is the whole reason the verb reports
        // before it writes.
        const raisedConflicts: PendingConflict[] = (
          result.report.unresolvedConflicts as RaisedConflict[]
        ).map((c) => pendingConflictFromRaised(c));
        const { disposition, queue: finalConflicts } = disposePendingConflicts(
          existingConflicts,
          raisedConflicts,
          result.turtle,
        );

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
            origins?: string[];
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
          origins: t.origins ?? [],
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
          pendingConflicts: disposition,
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

          // The queue is written as the DISPOSITION decided it: rows this run
          // raised, plus every pre-existing row whose question still stands.
          // Writing only the run's own conflicts is what silently emptied a
          // user-decision queue, so the set written here is the one the report
          // above already told the user about.
          const conflictsFile = path.join(podDir, 'settings', 'pending-conflicts.ttl');
          if (finalConflicts.length > 0 || fsSync.existsSync(conflictsFile)) {
            await writePendingConflicts(podDir, finalConflicts, dek);
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
