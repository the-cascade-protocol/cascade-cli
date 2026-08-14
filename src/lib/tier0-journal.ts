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

export interface Tier0Journal {
  entries: Tier0JournalEntry[];
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
 * Every record any tier-0 merge ever discarded, newest run last.
 *
 * This is the reversibility surface: a caller that wants to undo reads these and
 * has the complete pre-merge records without needing the pod's history, the
 * original import files, or the tier-0 rule to have been right.
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
