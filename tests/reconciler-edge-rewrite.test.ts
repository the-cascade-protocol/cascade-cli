/**
 * Reconciler edge re-dangling repair (root backlog 3.13a, slice R4).
 *
 * R1 resolved every record-to-record edge (clinical:hasLabResult,
 * clinical:indicationReference, ...) at conversion time, BEFORE reconciliation.
 * The reconciler then merges near-duplicate records and DISCARDS the losing
 * subjects, but historically never rewrote OTHER records' edge objects, so an
 * edge pointing at a merged-away duplicate re-dangled on every multi-source /
 * --reconcile-existing path. These tests lock in the fix: at merge time the
 * reconciler builds a discarded->canonical map and redirects matching edge
 * objects (in passthrough quads AND reconciled groups) to the survivor, while
 * leaving lineage predicates (mergedFrom / wasDerivedFrom) dangling by design.
 *
 * All data is synthetic and PHI-free.
 */

import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import type { Quad } from 'n3';
import {
  runReconciliation,
  buildDiscardedToCanonical,
  resolveCanonicalSubject,
} from '../src/lib/reconciler.js';

const PREFIXES = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
`;

const NS_CLIN = 'https://ns.cascadeprotocol.org/clinical/v1#';
const NS_CASCADE = 'https://ns.cascadeprotocol.org/core/v1#';
const NS_PROV = 'http://www.w3.org/ns/prov#';
const HAS_LAB_RESULT = NS_CLIN + 'hasLabResult';
const INDICATION = NS_CLIN + 'indicationReference';
const MERGED_FROM = NS_CASCADE + 'mergedFrom';
const WAS_DERIVED_FROM = NS_PROV + 'wasDerivedFrom';

// --- small census helpers -------------------------------------------------

function parse(ttl: string): Quad[] {
  return new Parser({ format: 'Turtle' }).parse(ttl);
}
function subjectsOf(quads: Quad[]): Set<string> {
  return new Set(quads.filter(q => q.subject.termType === 'NamedNode').map(q => q.subject.value));
}
/** Object values of (subject, predicate) across the graph. */
function objectsOf(quads: Quad[], subject: string, predicate: string): string[] {
  return quads.filter(q => q.subject.value === subject && q.predicate.value === predicate).map(q => q.object.value);
}

// --- fixture URIs ---------------------------------------------------------

const LAB_QUEST = 'urn:uuid:lab-quest-0001';
const LAB_LABCORP = 'urn:uuid:lab-labcorp-0001';
const REPORT = 'urn:uuid:report-panel-0001';

// Bundle A (existing export): a lab panel report referencing its lab result,
// plus that lab result. The report is a passthrough type (LaboratoryReport is
// not in the reconciler's KNOWN_TYPES); the lab result IS a reconciled type.
const BUNDLE_A = `${PREFIXES}
<${REPORT}> a clinical:LaboratoryReport ;
  clinical:panelName "Basic Metabolic Panel" ;
  clinical:hasLabResult <${LAB_QUEST}> .

<${LAB_QUEST}> a health:LabResultRecord ;
  cascade:sourceSystem "quest" ;
  health:testCode <http://loinc.org/rdf#2345-7> ;
  health:testName "Glucose" ;
  health:performedDate "2026-01-15" ;
  health:resultValue "100" .
`;

// Bundle B (later overlapping export): a near-duplicate of the lab result (same
// LOINC + date, value within tolerance) from a different, higher-trust source.
const BUNDLE_B = `${PREFIXES}
<${LAB_LABCORP}> a health:LabResultRecord ;
  cascade:sourceSystem "labcorp" ;
  health:testCode <http://loinc.org/rdf#2345-7> ;
  health:testName "Glucose" ;
  health:performedDate "2026-01-15" ;
  health:resultValue "101" .
`;

// Force labcorp's lab to win, so the report's edge (pointing at quest's lab)
// must be redirected. Without trust control the tie would break on order.
const TRUST = { trustScores: { labcorp: 0.95, quest: 0.80 } };

describe('reconciler edge rewrite: passthrough holder + reconciled target', () => {
  it('redirects hasLabResult from the merged-away lab to the surviving lab', async () => {
    const result = await runReconciliation(
      [{ content: BUNDLE_A, systemName: 'quest' }, { content: BUNDLE_B, systemName: 'labcorp' }],
      TRUST,
    );

    const quads = parse(result.turtle);
    const subjects = subjectsOf(quads);

    // The near-duplicate labs merged into one survivor (labcorp won on trust).
    expect(result.report.summary.nearDuplicatesMerged).toBe(1);
    expect(subjects.has(LAB_LABCORP)).toBe(true);
    expect(subjects.has(LAB_QUEST)).toBe(false); // discarded, gone from output

    // The passthrough report's edge now points at the survivor, not the ghost.
    const edge = objectsOf(quads, REPORT, HAS_LAB_RESULT);
    expect(edge).toEqual([LAB_LABCORP]);

    // The edge resolves to a real subject in the pod (no dangling IRI).
    expect(subjects.has(edge[0])).toBe(true);

    // Exactly one edge object was rewritten and the report itself survived.
    expect(result.report.summary.edgeObjectsRewritten).toBe(1);
    expect(subjects.has(REPORT)).toBe(true);
  });

  it('leaves merge lineage (mergedFrom / wasDerivedFrom) dangling by design', async () => {
    const result = await runReconciliation(
      [{ content: BUNDLE_A, systemName: 'quest' }, { content: BUNDLE_B, systemName: 'labcorp' }],
      TRUST,
    );
    const quads = parse(result.turtle);

    // Lineage on the surviving lab still references the PRE-merge (now
    // non-materialized) subject: rewriting it would self-loop and destroy the
    // provenance it exists to record (ratified decision: exclude, do not
    // tombstone; dangling by design).
    const mergedFrom = objectsOf(quads, LAB_LABCORP, MERGED_FROM);
    const derivedFrom = objectsOf(quads, LAB_LABCORP, WAS_DERIVED_FROM);
    expect(mergedFrom).toContain(LAB_QUEST);
    expect(derivedFrom).toContain(LAB_QUEST);

    // Lineage predicates are NOT counted as edge rewrites.
    expect(result.report.summary.edgeObjectsRewritten).toBe(1);
  });

  it('is deterministic: two runs produce byte-identical turtle', async () => {
    const inputs = [{ content: BUNDLE_A, systemName: 'quest' }, { content: BUNDLE_B, systemName: 'labcorp' }];
    const a = await runReconciliation(inputs, TRUST);
    const b = await runReconciliation(inputs, TRUST);
    expect(a.turtle).toBe(b.turtle);
  });
});

// --- reconciled edge HOLDER (canonical-property rewrite path) --------------

const MED = 'urn:uuid:med-lisinopril-0001';
const COND_QUEST = 'urn:uuid:cond-htn-quest';
const COND_HOSP = 'urn:uuid:cond-htn-hosp';

const MED_BUNDLE = `${PREFIXES}
<${MED}> a clinical:Medication ;
  cascade:sourceSystem "quest" ;
  clinical:drugName "Lisinopril" ;
  clinical:rxNormCode <https://ns.cascadeprotocol.org/rxnorm/29046> ;
  clinical:indicationReference <${COND_QUEST}> .

<${COND_QUEST}> a health:ConditionRecord ;
  cascade:sourceSystem "quest" ;
  health:conditionName "Hypertension" ;
  health:snomedCode <http://snomed.info/sct/38341003> ;
  health:status "active" .
`;

const COND_BUNDLE = `${PREFIXES}
<${COND_HOSP}> a health:ConditionRecord ;
  cascade:sourceSystem "hospital" ;
  health:conditionName "Hypertension" ;
  health:snomedCode <http://snomed.info/sct/38341003> ;
  health:status "active" .
`;

describe('reconciler edge rewrite: reconciled-type edge holder', () => {
  it('redirects a medication indicationReference when the target condition merges', async () => {
    const result = await runReconciliation(
      [{ content: MED_BUNDLE, systemName: 'quest' }, { content: COND_BUNDLE, systemName: 'hospital' }],
      { trustScores: { hospital: 0.95, quest: 0.80 } },
    );
    const quads = parse(result.turtle);
    const subjects = subjectsOf(quads);

    // Conditions merged; the hospital condition survived.
    expect(subjects.has(COND_HOSP)).toBe(true);
    expect(subjects.has(COND_QUEST)).toBe(false);

    // The medication (a reconciled type carried through as its own group) has
    // its indication edge rewritten via the canonical-property path.
    const edge = objectsOf(quads, MED, INDICATION);
    expect(edge).toEqual([COND_HOSP]);
    expect(subjects.has(edge[0])).toBe(true);
    expect(result.report.summary.edgeObjectsRewritten).toBe(1);
  });
});

// --- 3-way merge: multiple discarded subjects collapse to one survivor -----

describe('reconciler edge rewrite: three-way merge', () => {
  it('redirects an edge to any merged-away duplicate onto the single survivor', async () => {
    const L1 = 'urn:uuid:lab-a', L2 = 'urn:uuid:lab-b', L3 = 'urn:uuid:lab-c';
    const RPT = 'urn:uuid:report-3way';
    const lab = (uri: string, sys: string, val: string) => `
<${uri}> a health:LabResultRecord ;
  cascade:sourceSystem "${sys}" ;
  health:testCode <http://loinc.org/rdf#2345-7> ;
  health:testName "Glucose" ;
  health:performedDate "2026-02-01" ;
  health:resultValue "${val}" .`;

    const bundleA = `${PREFIXES}
<${RPT}> a clinical:LaboratoryReport ;
  clinical:hasLabResult <${L1}> .
${lab(L1, 'quest', '100')}`;
    const bundleB = `${PREFIXES}${lab(L2, 'labcorp', '101')}`;
    const bundleC = `${PREFIXES}${lab(L3, 'hospital', '102')}`;

    const result = await runReconciliation(
      [
        { content: bundleA, systemName: 'quest' },
        { content: bundleB, systemName: 'labcorp' },
        { content: bundleC, systemName: 'hospital' },
      ],
      { trustScores: { hospital: 0.99, labcorp: 0.90, quest: 0.80 } },
    );
    const quads = parse(result.turtle);
    const subjects = subjectsOf(quads);

    // All three collapsed to the highest-trust survivor.
    expect(subjects.has(L3)).toBe(true);
    expect(subjects.has(L1)).toBe(false);
    expect(subjects.has(L2)).toBe(false);

    // The report's edge (which pointed at L1, a loser) resolves to the survivor.
    expect(objectsOf(quads, RPT, HAS_LAB_RESULT)).toEqual([L3]);
  });
});

// --- no merge => no rewrite (fresh-import / non-overlapping control) --------

describe('reconciler edge rewrite: no-op when nothing merges', () => {
  it('leaves a resolving edge untouched and rewrites zero objects', async () => {
    // Two labs with different LOINC codes never match, so nothing is discarded.
    const other = `${PREFIXES}
<urn:uuid:lab-other> a health:LabResultRecord ;
  cascade:sourceSystem "labcorp" ;
  health:testCode <http://loinc.org/rdf#9999-9> ;
  health:testName "Sodium" ;
  health:performedDate "2026-01-15" ;
  health:resultValue "140" .`;
    const result = await runReconciliation(
      [{ content: BUNDLE_A, systemName: 'quest' }, { content: other, systemName: 'labcorp' }],
      TRUST,
    );
    const quads = parse(result.turtle);
    expect(objectsOf(quads, REPORT, HAS_LAB_RESULT)).toEqual([LAB_QUEST]);
    expect(result.report.summary.edgeObjectsRewritten).toBe(0);
    expect(subjectsOf(quads).has(LAB_QUEST)).toBe(true);
  });
});

// --- transitivity + cycle guard (pure resolver) ---------------------------

describe('resolveCanonicalSubject: transitive resolution and cycle guard', () => {
  it('follows a chain A->B->C to the final canonical', () => {
    const map = new Map([['A', 'B'], ['B', 'C']]);
    expect(resolveCanonicalSubject(map, 'A')).toBe('C');
    expect(resolveCanonicalSubject(map, 'B')).toBe('C');
  });

  it('returns an untouched subject unchanged', () => {
    const map = new Map([['A', 'B']]);
    expect(resolveCanonicalSubject(map, 'Z')).toBe('Z');
  });

  it('terminates deterministically on a cycle A->B->A', () => {
    const cyc = new Map([['A', 'B'], ['B', 'A']]);
    let out: string | undefined;
    expect(() => { out = resolveCanonicalSubject(cyc, 'A'); }).not.toThrow();
    expect(out).toBe(resolveCanonicalSubject(cyc, 'A')); // stable
  });
});

describe('buildDiscardedToCanonical: maps losers, skips self-entries', () => {
  it('maps every non-canonical record to the canonical and omits A->A', () => {
    // Minimal group/resolution shapes (only the fields the builder reads).
    const groups = [{ records: [{ uri: 'A' }, { uri: 'B' }, { uri: 'A' }] }] as unknown as Parameters<typeof buildDiscardedToCanonical>[0];
    const resolutions = [{ canonical: { uri: 'A' } }] as unknown as Parameters<typeof buildDiscardedToCanonical>[1];
    const map = buildDiscardedToCanonical(groups, resolutions);
    expect(map.get('B')).toBe('A');
    expect(map.has('A')).toBe(false); // self-entry skipped (exact re-import case)
  });
});
