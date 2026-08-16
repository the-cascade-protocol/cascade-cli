/**
 * The tier-0 audit journal: what a silent merge is allowed to be silent ABOUT.
 *
 * The tier-0 ruling (see `lib/reconciler.ts`) lets one narrow class of duplicate
 * merge without asking anyone: cross-source EXACT lab duplication. That is a
 * deliberate loss of a question, and it is only defensible if the merge is still
 * a fact the pod holds afterwards. So "silent" is scoped precisely:
 *
 *   NOT INTERRUPTING   no conflict is queued, no prompt is raised, the import or
 *                      the reconcile completes.
 *   STILL RECORDED     every merge is appended here with its canonical IRI, the
 *                      IRIs it absorbed, the origins involved, and the FULL
 *                      content of every record it discarded.
 *
 * The second half is what makes the first half a decision rather than a data
 * loss. A person who disagrees with the ruling, or with one application of it,
 * can find every merge it ever made and reconstruct exactly what was there.
 *
 * WHY JSON AND NOT TURTLE
 * -----------------------
 * Because this is not a claim about the patient. A pod's Turtle says what is
 * true of a person's health; a journal says what this tool did to the pod, which
 * is bookkeeping about the store and does not belong in the clinical graph.
 * Writing it as Turtle would also mean minting vocabulary to describe it, and
 * vocabulary is authored in `spec/` and synced here — inventing terms locally to
 * describe a local operation is how unvalidatable predicates end up in pods.
 *
 * It goes through the pod's resource layer, so on an encrypted pod the journal
 * is ciphertext like everything else under `settings/`: it holds record content
 * by design, and content that was worth encrypting in the bucket is worth
 * encrypting here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readResource, writeResource } from './pod-encryption.js';
import { toJsonText } from './json-output.js';
import type { Tier0Merge } from './reconciler.js';

/** Pod-relative location of the journal. */
export const TIER0_JOURNAL_RELATIVE_PATH = 'settings/tier0-merge-journal.json';

/** One appended entry: a run, and the merges it applied. */
export interface Tier0JournalEntry {
  /** When the run that applied these merges completed. */
  appliedAt: string;
  /** Which verb applied them, e.g. `pod import` or `pod reconcile --apply`. */
  appliedBy: string;
  /** The ruling this entry was written under, so a later reader can tell. */
  rule: 'tier-0-cross-source-exact-lab-duplicate';
  merges: Tier0Merge[];
}

/**
 * One appended entry recording that merges were UNDONE.
 *
 * APPENDED, NEVER SUBTRACTED, and that is the whole design. The obvious way to
 * record an undo is to remove the merge entry it reverses, and that would make
 * the journal a statement of current state rather than of what happened. A
 * person auditing a pod needs to see that a merge was made AND that it was
 * reversed, in that order, with both timestamps: "this record was merged away on
 * the 3rd and put back on the 9th" is a different fact from "this record was
 * never merged", and only the second one survives a rewrite.
 *
 * It also makes the undo verb re-runnable without a separate lock or marker: the
 * set of already-restored records is derivable from the journal itself, so a
 * second run has nothing left to do and says so.
 */
export interface Tier0UndoEntry {
  /** When the undo run completed. */
  appliedAt: string;
  /** Which verb performed it. */
  appliedBy: string;
  /** The discriminator. Distinguishes an undo entry from a merge entry. */
  rule: 'tier-0-merge-undo';
  /** What was put back, grouped by the merge it reverses. */
  undone: Array<{
    /** The record that had survived the merge, and keeps existing. */
    canonicalUri: string;
    /** The discarded record IRIs restored to the pod. */
    restoredUris: string[];
  }>;
}

export interface Tier0Journal {
  entries: Array<Tier0JournalEntry | Tier0UndoEntry>;
}

/** True for an entry that records merges rather than an undo of them. */
export function isMergeEntry(
  entry: Tier0JournalEntry | Tier0UndoEntry,
): entry is Tier0JournalEntry {
  return entry.rule === 'tier-0-cross-source-exact-lab-duplicate';
}

function journalPath(podDir: string): string {
  return path.join(podDir, ...TIER0_JOURNAL_RELATIVE_PATH.split('/'));
}

/**
 * Read the journal. A pod that has never had a tier-0 merge has no journal, and
 * that is an empty journal, not an error.
 *
 * A journal that EXISTS and cannot be read is a different thing and throws:
 * "there were no silent merges" and "I cannot tell you what was merged away" are
 * opposite answers and must not share one.
 */
export function readTier0Journal(podDir: string, dek?: Buffer): Tier0Journal {
  const p = journalPath(podDir);
  if (!fs.existsSync(p)) return { entries: [] };
  const raw = readResource(p, dek);
  const parsed = JSON.parse(raw) as Partial<Tier0Journal>;
  return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
}

/**
 * Append one run's tier-0 merges. A no-op when there are none, so an ordinary
 * import never creates the file.
 *
 * Returns the number of merges appended.
 */
export function appendTier0Journal(
  podDir: string,
  merges: Tier0Merge[],
  appliedBy: string,
  dek?: Buffer,
): number {
  if (merges.length === 0) return 0;
  const existing = readTier0Journal(podDir, dek);
  const entry: Tier0JournalEntry = {
    appliedAt: new Date().toISOString(),
    appliedBy,
    rule: 'tier-0-cross-source-exact-lab-duplicate',
    merges,
  };
  const p = journalPath(podDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeResource(p, toJsonText({ entries: [...existing.entries, entry] }), dek);
  return merges.length;
}

/**
 * Append one undo run. A no-op when it restored nothing, so a re-run of the undo
 * verb never grows the journal with an entry that says nothing happened.
 *
 * Returns the number of records recorded as restored.
 */
export function appendTier0Undo(
  podDir: string,
  undone: Tier0UndoEntry['undone'],
  appliedBy: string,
  dek?: Buffer,
): number {
  const restored = undone.reduce((n, u) => n + u.restoredUris.length, 0);
  if (restored === 0) return 0;
  const existing = readTier0Journal(podDir, dek);
  const entry: Tier0UndoEntry = {
    appliedAt: new Date().toISOString(),
    appliedBy,
    rule: 'tier-0-merge-undo',
    undone,
  };
  const p = journalPath(podDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeResource(p, toJsonText({ entries: [...existing.entries, entry] }), dek);
  return restored;
}

/**
 * The discarded record IRIs the journal says have already been put back.
 *
 * This is what makes running the undo twice safe without any state outside the
 * journal: a record named by an undo entry is in the pod again, so the merge
 * that discarded it has nothing left to reverse.
 */
export function restoredUris(journal: Tier0Journal): Set<string> {
  const out = new Set<string>();
  for (const entry of journal.entries) {
    if (isMergeEntry(entry)) continue;
    for (const u of entry.undone) {
      for (const uri of u.restoredUris) out.add(uri);
    }
  }
  return out;
}

/**
 * Every record any tier-0 merge ever discarded, newest run last.
 *
 * This is the reversibility surface: a caller that wants to undo reads these and
 * has the complete pre-merge records without needing the pod's history, the
 * original import files, or the tier-0 rule to have been right.
 *
 * Records already put back are still listed. The function reports what the
 * journal says was DISCARDED, which is a fact about the past that an undo does
 * not change; a caller that wants only the outstanding ones subtracts
 * {@link restoredUris}.
 */
export function tier0DiscardedRecords(journal: Tier0Journal): Array<{
  runAppliedAt: string;
  canonicalUri: string;
  discardedUri: string;
  properties: Record<string, Array<{ value: string; datatype?: string; isIri?: boolean }>>;
}> {
  const out: Array<{
    runAppliedAt: string;
    canonicalUri: string;
    discardedUri: string;
    properties: Record<string, Array<{ value: string; datatype?: string; isIri?: boolean }>>;
  }> = [];
  for (const entry of journal.entries) {
    if (!isMergeEntry(entry)) continue;
    for (const merge of entry.merges) {
      for (const d of merge.discarded) {
        out.push({
          runAppliedAt: entry.appliedAt,
          canonicalUri: merge.canonicalUri,
          discardedUri: d.uri,
          properties: d.properties,
        });
      }
    }
  }
  return out;
}
