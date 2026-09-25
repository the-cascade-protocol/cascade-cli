/**
 * Medication status -> lifecycle class. The ONE place this repository answers
 * "is this medication still being taken?".
 *
 * The answer is data, not code: the table is `cascade-knowledge`'s
 * `medication-status-lifecycle` family (every FHIR R4 MedicationRequest.status
 * and MedicationStatement.status code -> active | stopped | paused | unknown |
 * entered-in-error, plus a row for an ABSENT status) and its
 * `medication-status-synonym` family (legacy spellings and free text -> the FHIR
 * code they mean). Both are vendored verbatim in
 * `src/knowledge/medication-status.snapshot.json` by
 * `scripts/sync-knowledge-from-cascade-knowledge.mjs` and drift-checked by
 * `scripts/check-knowledge-drift.mjs`. This module only implements the matching
 * contract the table publishes (cascade-knowledge README, "Medication status"):
 *
 *   1. key = lower-case, runs of non-alphanumerics to one space, trimmed; two
 *      keys also match when equal with spaces removed ("not taken" = "nottaken")
 *   2. blank or absent -> the data-absent-reason row
 *   3. key is a FHIR status code -> its class
 *   4. key is a synonym_of subject -> its target code's class
 *   5. key contains fragment_of subjects -> the most conservative target class,
 *      in the order entered-in-error, stopped, paused, unknown, active
 *   6. otherwise -> unknown, reported as unmatched
 *
 * A consumer that needs a narrower question (the reconciler asks only "is one
 * side known to have ended?") derives it from the class; it never keeps a status
 * list of its own.
 */

import snapshot from '../knowledge/medication-status.snapshot.json' with { type: 'json' };

export type MedicationLifecycle = 'active' | 'stopped' | 'paused' | 'unknown' | 'entered-in-error';

export interface MedicationStatusClassification {
  lifecycle: MedicationLifecycle;
  /** How the table was reached. `unmatched` means no row applied. */
  matchedBy: 'absent' | 'code' | 'synonym' | 'fragment' | 'unmatched';
  /** The FHIR status code the input resolved to, when one did. */
  code?: string;
}

interface Row {
  subject: { system: string; code?: string; display: string };
  predicate: string;
  object: { system: string; code?: string; display: string };
}

const MED_STATUS_SYSTEMS = new Set(['FHIR-MEDICATIONREQUEST-STATUS', 'FHIR-MEDICATIONSTATEMENT-STATUS']);
const ABSENT_SYSTEM = 'FHIR-DATA-ABSENT-REASON';
const LIFECYCLES: readonly MedicationLifecycle[] = ['entered-in-error', 'stopped', 'paused', 'unknown', 'active'];

/** Step 1 of the contract. */
export function medicationStatusKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const compact = (key: string): string => key.replace(/ /g, '');

function rowsOf(family: string): Row[] {
  const fam = (snapshot as { families: Record<string, { lines: string[] }> }).families[family];
  if (!fam || fam.lines.length === 0) throw new Error(`medication-status: vendored table has no ${family} rows`);
  return fam.lines.map((l) => JSON.parse(l) as Row);
}

function asLifecycle(value: string | undefined, where: string): MedicationLifecycle {
  if (!LIFECYCLES.includes(value as MedicationLifecycle)) {
    throw new Error(`medication-status: ${where} has lifecycle "${value}", not one of ${LIFECYCLES.join(', ')}`);
  }
  return value as MedicationLifecycle;
}

// ---- tables, built once from the vendored rows ------------------------------

/** compact key of a FHIR status code -> { code, lifecycle } */
const byCode = new Map<string, { code: string; lifecycle: MedicationLifecycle }>();
let absentLifecycle: MedicationLifecycle | undefined;
for (const r of rowsOf('medication-status-lifecycle')) {
  const lifecycle = asLifecycle(r.object.code, `${r.subject.system}|${r.subject.code}`);
  if (r.subject.system === ABSENT_SYSTEM) {
    absentLifecycle = lifecycle;
    continue;
  }
  if (!MED_STATUS_SYSTEMS.has(r.subject.system) || !r.subject.code) continue;
  const k = compact(medicationStatusKey(r.subject.code));
  const prior = byCode.get(k);
  if (prior && prior.lifecycle !== lifecycle) {
    throw new Error(`medication-status: "${r.subject.code}" has two classes (${prior.lifecycle}, ${lifecycle})`);
  }
  byCode.set(k, { code: r.subject.code, lifecycle });
}
if (!absentLifecycle) throw new Error('medication-status: vendored table has no absent-status row');
const ABSENT: MedicationLifecycle = absentLifecycle;

/** compact key -> target FHIR code, for whole-string synonyms */
const bySynonym = new Map<string, string>();
/** contained phrases, each with its target FHIR code */
const fragments: { key: string; code: string }[] = [];
for (const r of rowsOf('medication-status-synonym')) {
  const target = r.object.code;
  if (!target || !byCode.has(compact(medicationStatusKey(target)))) {
    throw new Error(`medication-status: synonym "${r.subject.display}" targets "${target}", which has no class`);
  }
  const key = medicationStatusKey(r.subject.display);
  if (r.predicate === 'synonym_of') bySynonym.set(compact(key), target);
  else if (r.predicate === 'fragment_of') fragments.push({ key, code: target });
}

function classOfCode(code: string): MedicationLifecycle {
  return byCode.get(compact(medicationStatusKey(code)))!.lifecycle;
}

/** Classify a medication record's status string (absent included). */
export function classifyMedicationStatus(raw: string | null | undefined): MedicationStatusClassification {
  const key = raw == null ? '' : medicationStatusKey(raw);
  if (key === '') return { lifecycle: ABSENT, matchedBy: 'absent' };
  const c = compact(key);

  const hit = byCode.get(c);
  if (hit) return { lifecycle: hit.lifecycle, matchedBy: 'code', code: hit.code };

  const syn = bySynonym.get(c);
  if (syn) return { lifecycle: classOfCode(syn), matchedBy: 'synonym', code: syn };

  let best: { lifecycle: MedicationLifecycle; code: string } | undefined;
  for (const f of fragments) {
    if (!key.includes(f.key)) continue;
    const lifecycle = classOfCode(f.code);
    if (!best || LIFECYCLES.indexOf(lifecycle) < LIFECYCLES.indexOf(best.lifecycle)) best = { lifecycle, code: f.code };
  }
  if (best) return { lifecycle: best.lifecycle, matchedBy: 'fragment', code: best.code };

  return { lifecycle: 'unknown', matchedBy: 'unmatched' };
}

/** The per-family sha256 of the vendored table, for cross-repository checks. */
export function medicationStatusTableDigests(): Record<string, string> {
  const fams = (snapshot as { families: Record<string, { sha256: string }> }).families;
  return Object.fromEntries(Object.entries(fams).map(([k, v]) => [k, v.sha256]));
}
