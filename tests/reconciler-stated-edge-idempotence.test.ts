/**
 * Re-import duplication of stated record-to-record edges.
 *
 * A stated edge reaches the reconciler in two different shapes, and full
 * quad-identity dedup cannot see that they are one statement:
 *
 *   - RESOLVED, as the pod holds it:     <proc> clinical:hasEncounter <urn:uuid:enc>
 *   - a PLACEHOLDER, as a fresh convert emits it (reference resolution is deferred
 *     to once per import invocation, R5)
 *
 * On a re-import the pod contributes the first and the new input the second, both
 * survived, the caller resolved the placeholder to the same target, and the
 * subject ended up stating the edge TWICE — measured `hasEncounter` 200 -> 214 and
 * `indicationReference` 5 -> 8 on a real pull, Turtle bytes +18%. Same family as
 * the `clinical:importedAt` duplication (see reconciler-importedat-dedup.test.ts),
 * one resolution stage further out.
 *
 * The reconciler now keys each passthrough edge on where its object RESOLVES TO.
 * These tests lock that in, plus the two other things a fully duplicate import
 * has to get right: reconciler bookkeeping must not accumulate, and the summary
 * must count the duplicates it silently dropped.
 *
 * All data is synthetic and PHI-free.
 */

import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { runReconciliation } from '../src/lib/reconciler.js';
import { referencePlaceholder } from '../src/lib/fhir-converter/reference-resolution.js';

const PREFIXES = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

const HAS_ENCOUNTER = 'https://ns.cascadeprotocol.org/clinical/v1#hasEncounter';
const RECONCILIATION_STATUS = 'https://ns.cascadeprotocol.org/core/v1#reconciliationStatus';

const PROC = 'urn:uuid:proc-0001';
const ENC_1 = 'urn:uuid:enc-0001';
const ENC_2 = 'urn:uuid:enc-0002';

/** Two Encounter records the placeholders below can resolve against. */
const ENCOUNTERS = `
<${ENC_1}> a clinical:Encounter ;
  clinical:fhirResourceType "Encounter" ;
  clinical:sourceRecordId "enc-1" ;
  clinical:encounterType "Office Visit" .
<${ENC_2}> a clinical:Encounter ;
  clinical:fhirResourceType "Encounter" ;
  clinical:sourceRecordId "enc-2" ;
  clinical:encounterType "Follow-up Visit" .
`;

/** The pod's copy of the procedure: its edge is already resolved. */
function podTurtle(edges: string[] = [`clinical:hasEncounter <${ENC_1}>`]): string {
  return `${PREFIXES}${ENCOUNTERS}
<${PROC}> a clinical:Procedure ;
  clinical:fhirResourceType "Procedure" ;
  clinical:sourceRecordId "proc-1" ;
  clinical:procedureName "Appendectomy" ;
  ${edges.join(' ;\n  ')} .
`;
}

/** A fresh conversion of the same procedure: its edge is still a placeholder. */
function importTurtle(rawRefs: string[] = ['Encounter/enc-1']): string {
  const edges = rawRefs.map((r) => `clinical:hasEncounter <${referencePlaceholder(r)}>`);
  return `${PREFIXES}${ENCOUNTERS}
<${PROC}> a clinical:Procedure ;
  clinical:fhirResourceType "Procedure" ;
  clinical:sourceRecordId "proc-1" ;
  clinical:procedureName "Appendectomy" ;
  ${edges.join(' ;\n  ')} .
`;
}

/**
 * A reconcilable record (unlike the passthrough Procedure above), so the
 * reconciler stamps its own bookkeeping on it and a re-import exercises the
 * accumulation path.
 */
const LAB_URI = 'urn:uuid:lab-0001';
const LAB = `${PREFIXES}
<${LAB_URI}> a health:LabResultRecord ;
  health:testCode <http://loinc.org/rdf#2339-0> ;
  health:testName "Glucose" ;
  health:resultValue "95" ;
  health:performedDate "2024-03-01T09:15:00Z"^^xsd:dateTime ;
  cascade:sourceSystem "epic" .
`;

function objectsOf(ttl: string, subject: string, predicate: string): string[] {
  return new Parser({ format: 'Turtle' })
    .parse(ttl)
    .filter((q) => q.subject.value === subject && q.predicate.value === predicate)
    .map((q) => q.object.value);
}

describe('reconciler: a re-imported stated edge is kept exactly once', () => {
  it('collapses the pod-resolved edge and the re-imported placeholder into one', async () => {
    const result = await runReconciliation([
      { content: podTurtle(), systemName: 'existing-pod' },
      { content: importTurtle(), systemName: 'epic' },
    ]);

    // Exactly one edge, and it is the RESOLVED spelling: the copy whose target
    // provably exists, so no further rewriting is needed downstream.
    expect(objectsOf(result.turtle, PROC, HAS_ENCOUNTER)).toEqual([ENC_1]);
    expect(result.turtle).not.toContain('unresolved-ref');
  });

  it('is order-independent: same single edge whichever input comes first', async () => {
    const result = await runReconciliation([
      { content: importTurtle(), systemName: 'epic' },
      { content: podTurtle(), systemName: 'existing-pod' },
    ]);
    expect(objectsOf(result.turtle, PROC, HAS_ENCOUNTER)).toEqual([ENC_1]);
  });

  it('keeps a genuinely NEW edge on the same predicate (never a blanket drop)', async () => {
    // The pod states enc-1; the re-import states enc-1 AND a second visit enc-2.
    // Dropping placeholders merely because the predicate already had a resolved
    // value would silently lose the new one.
    const result = await runReconciliation([
      { content: podTurtle(), systemName: 'existing-pod' },
      { content: importTurtle(['Encounter/enc-1', 'Encounter/enc-2']), systemName: 'epic' },
    ]);
    // Two edges survive: the pod's resolved enc-1, and enc-2 still as the
    // placeholder the caller's resolution pass turns into ENC_2. The reconciler
    // resolves references only to COMPARE them, never rewriting on their behalf —
    // that stays the import's job (R5), which owns the resolved/dropped tally.
    expect(objectsOf(result.turtle, PROC, HAS_ENCOUNTER).sort()).toEqual([
      referencePlaceholder('Encounter/enc-2'),
      ENC_1,
    ].sort());
  });

  it('leaves an unresolvable placeholder for the caller to drop and count', async () => {
    // A reference whose target is absent must survive reconciliation unchanged so
    // the import's resolution pass can count it as dropped, rather than being
    // silently folded into a different edge.
    const result = await runReconciliation([
      { content: importTurtle(['Encounter/enc-absent']), systemName: 'epic' },
    ]);
    const objects = objectsOf(result.turtle, PROC, HAS_ENCOUNTER);
    expect(objects).toHaveLength(1);
    expect(objects[0]).toContain('unresolved-ref');
  });

  it('does not accumulate reconciliationStatus on a reconciled record', async () => {
    // The reconciler stamps this on every record it groups, so the previous run's
    // copy arriving as a parsed property doubled it on every re-sync (measured
    // 5 -> 10 -> 15 statements across three imports of one bundle).
    const first = await runReconciliation([
      { content: LAB, systemName: 'existing-pod' },
      { content: LAB, systemName: 'epic' },
    ]);
    expect(objectsOf(first.turtle, LAB_URI, RECONCILIATION_STATUS)).toHaveLength(1);

    // Feed the reconciled output back in, exactly as `--reconcile-existing` does.
    const second = await runReconciliation([
      { content: first.turtle, systemName: 'existing-pod' },
      { content: LAB, systemName: 'epic' },
    ]);
    expect(objectsOf(second.turtle, LAB_URI, RECONCILIATION_STATUS)).toHaveLength(1);

    const third = await runReconciliation([
      { content: second.turtle, systemName: 'existing-pod' },
      { content: LAB, systemName: 'epic' },
    ]);
    expect(objectsOf(third.turtle, LAB_URI, RECONCILIATION_STATUS)).toHaveLength(1);
  });

  it('counts the duplicate subjects it dropped instead of reporting zero', async () => {
    // The same content-hashed subject arriving twice is a re-import of one record.
    // It was already deduplicated, but reported as if nothing had been a duplicate.
    const withLab = await runReconciliation([
      { content: LAB, systemName: 'existing-pod' },
      { content: LAB, systemName: 'epic' },
    ]);
    expect(withLab.report.summary.totalInputRecords).toBe(2);
    expect(withLab.report.summary.duplicateSubjectsDropped).toBe(1);
    expect(withLab.report.summary.finalRecordCount).toBe(1);
  });

  it('is a fixed point: reconciling its own output changes nothing', async () => {
    const first = await runReconciliation([
      { content: podTurtle(), systemName: 'existing-pod' },
      { content: importTurtle(), systemName: 'epic' },
    ]);
    const second = await runReconciliation([
      { content: first.turtle, systemName: 'existing-pod' },
      { content: importTurtle(), systemName: 'epic' },
    ]);
    const third = await runReconciliation([
      { content: second.turtle, systemName: 'existing-pod' },
      { content: importTurtle(), systemName: 'epic' },
    ]);
    expect(second.turtle).toBe(third.turtle);
  });

  it('is deterministic across identical runs', async () => {
    const inputs = [
      { content: podTurtle(), systemName: 'existing-pod' },
      { content: importTurtle(), systemName: 'epic' },
    ];
    const a = await runReconciliation(inputs);
    const b = await runReconciliation(inputs);
    expect(a.turtle).toBe(b.turtle);
  });

  it('leaves a single import untouched (no resolved/placeholder pair to collapse)', async () => {
    // The byte-compatibility guard: with only placeholders present nothing is
    // equivalent to anything, so the quad list must pass through unchanged.
    const single = await runReconciliation([{ content: importTurtle(), systemName: 'epic' }]);
    expect(objectsOf(single.turtle, PROC, HAS_ENCOUNTER)).toEqual([
      referencePlaceholder('Encounter/enc-1'),
    ]);
  });
});
