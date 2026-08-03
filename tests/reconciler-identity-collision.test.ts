/**
 * An identity collision is a CONFLICT, not a duplicate.
 *
 * Two records can arrive under one subject IRI for two different reasons, and
 * the reconciler used to assume the harmless one unconditionally:
 *
 *   RE-IMPORT  — the same record imported twice. Cascade subjects are
 *                content-hashed, so this is expected and overwhelmingly common,
 *                and passing over the second arrival is correct.
 *
 *   COLLISION  — two DIFFERENT records that the identity layer minted onto one
 *                IRI because its key was narrower than the records. A fasting
 *                glucose of 95 and a post-prandial of 310, drawn the same day
 *                and keyed on {patient, LOINC, date}, are one IRI.
 *
 * `assigned.has(uri)` handled both the same way, so the second glucose was
 * counted as a duplicate and dropped — and WHICH value survived was decided by
 * the order the inputs were enumerated, i.e. by the filesystem. A normal glucose
 * and a critical hyperglycemia reading were interchangeable outputs of the same
 * bytes, with no warning, no conflict record, and a summary line reporting the
 * loss as successful deduplication.
 *
 * These tests are written against RECONCILER inputs (hand-authored Turtle with
 * colliding subject IRIs) rather than against a FHIR fixture, on purpose. The
 * reconciler must not silently lose a record regardless of what any converter
 * upstream mints, so nothing here depends on a particular converter continuing
 * to produce a collision.
 *
 * All data is synthetic and PHI-free.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolve } from 'node:path';
import { Parser } from 'n3';
import { runReconciliation, recordContentFingerprint, parseTurtle } from '../src/lib/reconciler.js';

const CLI_PATH = resolve(__dirname, '../dist/index.js');

const PREFIXES = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix loinc: <http://loinc.org/rdf#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

/** The IRI a {patient, LOINC, date} key mints for BOTH of the labs below. */
const COLLIDING_IRI = 'urn:uuid:d2257c58-3d9f-5fe7-a34d-e48f97f6f27e';
const RESULT_VALUE = 'https://ns.cascadeprotocol.org/health/v1#resultValue';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * One glucose result, at whatever subject IRI is passed. Two calls with
 * different values and the SAME IRI are the collision; two calls with the same
 * value and the same IRI are a re-import.
 */
function glucose(uri: string, value: string, time: string): string {
  return `${PREFIXES}
<${uri}> a health:LabResultRecord ;
  health:testName "Glucose" ;
  health:testCode loinc:2339-0 ;
  health:resultValue "${value}" ;
  health:resultUnit "mg/dL" ;
  health:performedDate "${time}"^^xsd:dateTime .
`;
}

const FASTING = glucose(COLLIDING_IRI, '95', '2026-08-02T07:30:00Z');
const POST_PRANDIAL = glucose(COLLIDING_IRI, '310', '2026-08-02T13:00:00Z');

/** Every subject in `ttl` that is a lab result, sorted. */
function labSubjects(ttl: string): string[] {
  return new Parser({ format: 'Turtle' }).parse(ttl)
    .filter(q => q.predicate.value === RDF_TYPE
      && q.object.value === 'https://ns.cascadeprotocol.org/health/v1#LabResultRecord')
    .map(q => q.subject.value)
    .sort();
}

/** Every asserted `health:resultValue` in `ttl`, sorted. */
function resultValues(ttl: string): string[] {
  return new Parser({ format: 'Turtle' }).parse(ttl)
    .filter(q => q.predicate.value === RESULT_VALUE)
    .map(q => q.object.value)
    .sort();
}

describe('a collision keeps both records instead of dropping one', () => {
  it('keeps BOTH values when two different results share one IRI', async () => {
    const result = await runReconciliation([
      { content: FASTING, systemName: 'lab-a' },
      { content: POST_PRANDIAL, systemName: 'lab-b' },
    ]);

    // The whole defect in one assertion: before this change, one of these two
    // clinical values was simply gone from the output.
    expect(resultValues(result.turtle)).toEqual(['310', '95']);
    // And they are two RECORDS, not one record asserting both values (which is
    // the other bad outcome: a single subject a consumer reads as "95, 310").
    const subjects = labSubjects(result.turtle);
    expect(subjects).toHaveLength(2);
    expect(new Set(subjects).size).toBe(2);
    // The IRI the identity layer minted is still one of them, so nothing that
    // referenced it starts dangling.
    expect(subjects).toContain(COLLIDING_IRI);
  });

  it('reports the collision as an unresolved conflict, not as a duplicate', async () => {
    const result = await runReconciliation([
      { content: FASTING, systemName: 'lab-a' },
      { content: POST_PRANDIAL, systemName: 'lab-b' },
    ]);
    const { summary, unresolvedConflicts } = result.report;

    // "The pod deduplicated 1 record" used to mean "the pod discarded a record
    // that was not a duplicate". Nothing was dropped, so nothing is counted.
    expect(summary.duplicateSubjectsDropped).toBe(0);
    expect(summary.identityCollisionsSplit).toBe(1);
    expect(summary.conflictsUnresolved).toBeGreaterThanOrEqual(1);

    // It reaches the SAME queue every other unresolved conflict reaches, which
    // is what puts it in settings/pending-conflicts.ttl and `pod conflicts`.
    const collision = (unresolvedConflicts as Array<{
      type?: string; candidateUris?: string[]; label?: string; recordType?: string;
    }>).find(c => c.type === 'identity_collision');
    expect(collision, 'the collision must appear in unresolvedConflicts').toBeDefined();
    expect(collision!.recordType).toBe('health:LabResultRecord');
    // The candidates are the records as they now exist in the pod, so `pod
    // resolve` points at something real rather than at a URI that was dropped.
    expect([...(collision!.candidateUris ?? [])].sort()).toEqual(labSubjects(result.turtle));
    // The conflict names WHAT disagrees, which is the only question a person
    // resolving it has.
    expect(collision!.label).toContain('health:resultValue');
  });

  it('stops counting a collision as a deduplicated duplicate', async () => {
    // Both results from ONE source, which is what a folder import looks like:
    // every file gets the same source label. The matcher never compares two
    // records of the same source, so this is the path where the old code
    // reached `assigned.has(uri)` and dropped the second record outright — and
    // then reported the loss in `duplicateSubjectsDropped`, i.e. as a successful
    // deduplication. Measured on this input before the change:
    // duplicateSubjectsDropped 1, one record in the pod, zero conflicts.
    const result = await runReconciliation([
      { content: FASTING, systemName: 'quest' },
      { content: POST_PRANDIAL, systemName: 'quest' },
    ]);

    expect(resultValues(result.turtle)).toEqual(['310', '95']);
    expect(result.report.summary.duplicateSubjectsDropped).toBe(0);
    expect(result.report.summary.identityCollisionsSplit).toBe(1);
    expect(result.report.summary.conflictsUnresolved).toBe(1);
  });

  it('is decided by content, not by the order the inputs were enumerated', async () => {
    const forward = await runReconciliation([
      { content: FASTING, systemName: 'lab-a' },
      { content: POST_PRANDIAL, systemName: 'lab-b' },
    ]);
    const reversed = await runReconciliation([
      { content: POST_PRANDIAL, systemName: 'lab-b' },
      { content: FASTING, systemName: 'lab-a' },
    ]);

    // Before this change these two runs produced DIFFERENT pods: 95 survived one
    // way and 310 the other, and the only variable was `fs.readdir` order.
    expect(resultValues(reversed.turtle)).toEqual(['310', '95']);
    expect(labSubjects(reversed.turtle)).toEqual(labSubjects(forward.turtle));
    expect(reversed.report.summary.identityCollisionsSplit).toBe(1);
  });
});

describe('a re-import is still a re-import', () => {
  it('does not split two byte-identical arrivals of one record', async () => {
    // One source, imported twice: the shape the `assigned.has(uri)` pass-over
    // was written for, and the one it is right about.
    const result = await runReconciliation([
      { content: FASTING, systemName: 'lab-a' },
      { content: FASTING, systemName: 'lab-a' },
    ]);

    // Splitting here would be the deterministic-identity defect wearing new
    // clothes: a pod that grows a copy of every record on every sync.
    expect(labSubjects(result.turtle)).toEqual([COLLIDING_IRI]);
    expect(resultValues(result.turtle)).toEqual(['95']);
    expect(result.report.summary.identityCollisionsSplit).toBe(0);
    expect(result.report.summary.duplicateSubjectsDropped).toBe(1);
    expect(result.report.summary.conflictsUnresolved).toBe(0);
  });

  it('does not split a re-import whose only difference is per-run bookkeeping', async () => {
    // What a real re-sync looks like: the pod's copy carries an importedAt, a
    // reconciliationStatus and a source label the fresh conversion does not.
    // Treating any of those as content would raise a conflict on every record of
    // every import, forever.
    const podCopy = `${FASTING.trimEnd().slice(0, -1)} ;
  <https://ns.cascadeprotocol.org/clinical/v1#importedAt> "2026-01-01T00:00:00Z" ;
  cascade:reconciliationStatus "canonical" ;
  cascade:sourceSystem "existing-pod" .
`;
    const result = await runReconciliation([
      { content: podCopy, systemName: 'existing-pod' },
      { content: FASTING, systemName: 'lab-a' },
    ]);
    expect(result.report.summary.identityCollisionsSplit).toBe(0);
    expect(labSubjects(result.turtle)).toEqual([COLLIDING_IRI]);
    expect(resultValues(result.turtle)).toEqual(['95']);
  });

  it('does not grow the pod when the SAME collision is imported again', async () => {
    const first = await runReconciliation([
      { content: FASTING, systemName: 'lab-a' },
      { content: POST_PRANDIAL, systemName: 'lab-b' },
    ]);
    const firstSubjects = labSubjects(first.turtle);
    expect(firstSubjects).toHaveLength(2);

    // Feed the pod's own output back as existing content, alongside a re-import
    // of the two originals — the monthly re-sync. The split IRI is derived from
    // the record's content, so it re-derives to the same place and matches.
    const second = await runReconciliation([
      { content: first.turtle, systemName: 'existing-pod' },
      { content: FASTING, systemName: 'lab-a' },
      { content: POST_PRANDIAL, systemName: 'lab-b' },
    ]);
    expect(labSubjects(second.turtle)).toEqual(firstSubjects);
    expect(resultValues(second.turtle)).toEqual(['310', '95']);

    const third = await runReconciliation([
      { content: second.turtle, systemName: 'existing-pod' },
      { content: FASTING, systemName: 'lab-a' },
      { content: POST_PRANDIAL, systemName: 'lab-b' },
    ]);
    expect(labSubjects(third.turtle)).toEqual(firstSubjects);
  });
});

describe('the content fingerprint that separates the two cases', () => {
  it('is blind to the order properties were written in', async () => {
    const a = (await parseTurtle(`${PREFIXES}
<${COLLIDING_IRI}> a health:LabResultRecord ;
  health:testName "Glucose" ; health:resultValue "95" ; health:resultUnit "mg/dL" .
`, 's'))[0];
    const b = (await parseTurtle(`${PREFIXES}
<${COLLIDING_IRI}> a health:LabResultRecord ;
  health:resultUnit "mg/dL" ; health:resultValue "95" ; health:testName "Glucose" .
`, 's'))[0];
    expect(recordContentFingerprint(a)).toBe(recordContentFingerprint(b));
  });

  it('separates records that differ, and ignores per-run bookkeeping', async () => {
    const base = (await parseTurtle(FASTING, 's'))[0];
    const other = (await parseTurtle(POST_PRANDIAL, 's'))[0];
    // A constant is perfectly deterministic and perfectly useless: assert the
    // fingerprint actually DISTINGUISHES.
    expect(recordContentFingerprint(base)).not.toBe(recordContentFingerprint(other));

    // ... while a per-run import timestamp and the reconciler's own status
    // predicate must not make one record look like two.
    const withBookkeeping = (await parseTurtle(`${PREFIXES}
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
<${COLLIDING_IRI}> a health:LabResultRecord ;
  health:testName "Glucose" ;
  health:testCode loinc:2339-0 ;
  health:resultValue "95" ;
  health:resultUnit "mg/dL" ;
  health:performedDate "2026-08-02T07:30:00Z"^^xsd:dateTime ;
  clinical:importedAt "2026-08-03T11:22:33Z"^^xsd:dateTime ;
  cascade:reconciliationStatus "canonical" ;
  cascade:sourceSystem "some-other-ehr" .
`, 's'))[0];
    expect(recordContentFingerprint(withBookkeeping)).toBe(recordContentFingerprint(base));
  });
});

describe('the split IRI is reproducible off this machine', () => {
  /**
   * Run the reconciliation in a CHILD process, from `cwd`, and return the lab
   * subject IRIs it produced.
   *
   * A separate process and a different working directory together rule out the
   * two things an in-process assertion cannot: module-level state carried
   * between calls, and any dependence on where the tool was invoked from (the
   * exact defect root 3.7 shipped, where an IRI hashed an absolute path).
   */
  function subjectsFromChild(cwd: string): string[] {
    const script = `
      const { runReconciliation } = await import(${JSON.stringify(resolve(__dirname, '../dist/lib/reconciler.js'))});
      const r = await runReconciliation([
        { content: ${JSON.stringify(FASTING)}, systemName: 'lab-a' },
        { content: ${JSON.stringify(POST_PRANDIAL)}, systemName: 'lab-b' },
      ]);
      // Extracted with a regex rather than with n3: the child runs from a temp
      // directory with no node_modules, and resolving a bare specifier there
      // would silently reintroduce a dependency on where it was started.
      const subs = [...r.turtle.matchAll(/<(urn:uuid:[^>]+)> a health:LabResultRecord/g)]
        .map(m => m[1]).sort();
      console.log(JSON.stringify(subs));
    `;
    const out = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd, encoding: 'utf-8', timeout: 120000,
    });
    return JSON.parse(out.trim().split('\n').pop()!) as string[];
  }

  it('mints the same two IRIs from two processes in two directories', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'collision-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'collision-b-'));

    const fromA = subjectsFromChild(dirA);
    const fromB = subjectsFromChild(dirB);

    // Determinism...
    expect(fromA).toEqual(fromB);
    // ...and DISTINCTNESS, without which determinism is satisfied by a constant.
    expect(fromA).toHaveLength(2);
    expect(new Set(fromA).size).toBe(2);
    expect(fromA).toContain(COLLIDING_IRI);
    // The derived IRI is a real urn:uuid, not a decorated copy of the original.
    const derived = fromA.filter(u => u !== COLLIDING_IRI);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('pod import surfaces a collision to the user', () => {
  /** Both streams: the collision notice is a warning, so it goes to stderr. */
  function cli(args: string[]): { output: string; status: number } {
    const r = spawnSync('node', [CLI_PATH, ...args], { encoding: 'utf-8', timeout: 120000 });
    return { output: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status ?? 1 };
  }

  it('keeps both records, writes a pending conflict, and says so', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collision-pod-'));
    const podDir = path.join(root, 'pod');
    const inputs = path.join(root, 'inputs');
    fs.mkdirSync(inputs);
    fs.writeFileSync(path.join(inputs, 'a-fasting.ttl'), FASTING);
    fs.writeFileSync(path.join(inputs, 'b-postprandial.ttl'), POST_PRANDIAL);
    cli(['pod', 'init', podDir]);

    const imported = cli(['pod', 'import', podDir, inputs]);
    expect(imported.output).toMatch(/identity collision/i);

    // Both clinical values are in the pod. Before this change one of them was
    // gone, chosen by directory enumeration order.
    const labFile = path.join(podDir, 'clinical', 'lab-results.ttl');
    const podTurtle = fs.readFileSync(labFile, 'utf-8');
    expect(resultValues(podTurtle)).toEqual(['310', '95']);
    expect(labSubjects(podTurtle)).toHaveLength(2);

    // And the user is asked about it through the conflict queue that already
    // exists, rather than through a channel nobody is watching.
    const conflicts = cli(['pod', 'conflicts', podDir]);
    expect(conflicts.status).toBe(1);          // CI-friendly: unresolved work remains
    expect(conflicts.output).toMatch(/health:LabResultRecord/);
    expect(fs.existsSync(path.join(podDir, 'settings', 'pending-conflicts.ttl'))).toBe(true);
  });
});
