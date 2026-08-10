/**
 * The reconciler matchers, pinned against the predicates the CONVERTERS actually
 * write, and against the strings that reach persisted conflict ids.
 *
 * WHY THESE FOUR TESTS EXIST TOGETHER
 * ----------------------------------
 * They are one defect wearing four costumes: a matcher reading a name nothing
 * writes. None of them could be caught by a green suite, because a matcher that
 * never fires produces no wrong output — it produces no output, and "these two
 * records did not merge" is the same observation as "there was nothing to merge".
 *
 *   - `matchVitalSigns` read `health:testCode`, `health:effectiveDate` and
 *     `health:value`. Both converters write `clinical:loincCode`,
 *     `clinical:effectiveDate` and `clinical:value`, so every lookup returned
 *     undefined and no two vital signs in any pod had ever matched.
 *   - `matchImmunizations` read `health:cvxCode`, which only the C-CDA importer
 *     writes; the FHIR importer writes `health:vaccineCode` with a `CVX-` prefix.
 *   - `codeFromUri` was `uri.split('/').pop() ?? uri.split('#').pop()`, whose
 *     second operand is unreachable, so a FHIR LOINC (`http://loinc.org/rdf#…`)
 *     and a C-CDA LOINC (`http://loinc.org/…`) for ONE code compared unequal, and
 *     the mangled `rdf#3094-0` reached `settings/pending-conflicts.ttl`.
 *   - `matchMedications` reported the bare constant `partial-name`, from which
 *     `generateConflictId` built ONE id for every partial-name medication
 *     conflict in a pod.
 *
 * Each test therefore asserts the ARGUMENT and not just the outcome: which
 * predicate was read, which string was produced. An assertion that two records
 * merged would stay green if the matcher started keying on something else.
 *
 * All fixtures are synthetic.
 */

import { describe, it, expect } from 'vitest';
import { runReconciliation } from '../src/lib/reconciler.js';
import { generateConflictId, legacyConflictIds } from '../src/lib/user-resolutions.js';

const PREFIXES = `
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
`;

interface Transformation {
  type: string;
  recordType: string;
  matchedOn?: string;
  conflictField?: string;
}

const transformations = (r: { report: { transformations: object[] } }): Transformation[] =>
  r.report.transformations as Transformation[];

// ---------------------------------------------------------------------------
// Vital signs
// ---------------------------------------------------------------------------

/**
 * A vital sign exactly as `convertObservationVital` emits one: LOINC under
 * `clinical:loincCode`, instant under `clinical:effectiveDate`, reading under
 * `clinical:value`.
 */
function vital(uri: string, loinc: string, effective: string, value: number): string {
  return `${PREFIXES}
<${uri}> a clinical:VitalSign ;
  clinical:vitalType "bloodPressureSystolic" ;
  clinical:loincCode <http://loinc.org/rdf#${loinc}> ;
  clinical:effectiveDate "${effective}" ;
  clinical:value "${value}" .
`;
}

describe('vital-sign matcher: reads the predicates the converters write', () => {
  it('merges a clock-skew duplicate recorded 17 minutes later by a second system', async () => {
    const result = await runReconciliation([
      { content: vital('urn:v:evening', '8480-6', '2025-06-11T17:20:00-07:00', 144), systemName: 'Harborview' },
      { content: vital('urn:v:skew', '8480-6', '2025-06-11T17:37:00-07:00', 144), systemName: 'Ridgecrest' },
    ]);

    expect(result.report.summary.finalRecordCount).toBe(1);

    // The ARGUMENT, not just the outcome: matched on the LOINC code (unmangled)
    // and the earlier of the two instants. Keying on the earlier one is what
    // makes the id independent of which record was enumerated first.
    const [t] = transformations(result);
    expect(t.matchedOn).toBe('loinc:8480-6+2025-06-12T00:20:00.000Z');
  });

  it('never merges two readings of the same vital taken hours apart', async () => {
    // 08:05 and 12:40 the same day, same LOINC, values within 7%. Under the
    // "same LOINC + same calendar day" rule these are one record; they are three
    // hours of clinical change. Note both come from DIFFERENT sources, so the
    // same-source guard is not what is keeping them apart here.
    const result = await runReconciliation([
      { content: vital('urn:v:morning', '8480-6', '2025-06-11T08:05:00-07:00', 138), systemName: 'Harborview' },
      { content: vital('urn:v:midday', '8480-6', '2025-06-11T12:40:00-07:00', 129), systemName: 'Ridgecrest' },
    ]);

    expect(result.report.summary.finalRecordCount).toBe(2);
    expect(transformations(result)).toEqual([]);
  });

  it('keeps both readings when two sources disagree by more than a rounding difference', async () => {
    // Inside the window, same code, but 138 and 172 are two measurements rather
    // than one measurement recorded twice. Keeping both is the recoverable answer.
    const result = await runReconciliation([
      { content: vital('urn:v:a', '8480-6', '2025-06-11T17:20:00-07:00', 138), systemName: 'Harborview' },
      { content: vital('urn:v:b', '8480-6', '2025-06-11T17:25:00-07:00', 172), systemName: 'Ridgecrest' },
    ]);

    expect(result.report.summary.finalRecordCount).toBe(2);
  });

  it('does not merge two different vitals recorded at the same instant', async () => {
    // Systolic and diastolic, one cuff, one timestamp. Only the code tells them
    // apart, so this is what fails if the code read is dropped from the key.
    const result = await runReconciliation([
      { content: vital('urn:v:sys', '8480-6', '2025-06-11T17:20:00-07:00', 90), systemName: 'Harborview' },
      { content: vital('urn:v:dia', '8462-4', '2025-06-11T17:20:00-07:00', 90), systemName: 'Ridgecrest' },
    ]);

    expect(result.report.summary.finalRecordCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Immunizations
// ---------------------------------------------------------------------------

describe('immunization matcher: both importers spell the CVX code differently', () => {
  it('matches a FHIR "CVX-141" against a C-CDA cvx code URI for the same shot', async () => {
    // Two names that do NOT match as strings, so the name tier cannot rescue
    // this: only reading the code both importers wrote can.
    const fhirShape = `${PREFIXES}
<urn:imm:fhir> a health:ImmunizationRecord ;
  health:vaccineName "Influenza, seasonal, injectable" ;
  health:vaccineCode "CVX-141" ;
  health:administrationDate "2024-10-02" .
`;
    const ccdaShape = `${PREFIXES}
<urn:imm:ccda> a health:ImmunizationRecord ;
  health:vaccineName "Influenza vaccine" ;
  health:cvxCode <http://hl7.org/fhir/sid/cvx/141> ;
  health:administrationDate "2024-10-02" .
`;
    const result = await runReconciliation([
      { content: fhirShape, systemName: 'Meridian FHIR' },
      { content: ccdaShape, systemName: 'Meridian C-CDA' },
    ]);

    expect(result.report.summary.finalRecordCount).toBe(1);
    expect(transformations(result)[0].matchedOn).toBe('cvx:141+2024-10-02');
  });

  it('keeps the name tier for records that carry no code at all', async () => {
    const named = (uri: string) => `${PREFIXES}
<${uri}> a health:ImmunizationRecord ;
  health:vaccineName "Tetanus toxoid" ;
  health:administrationDate "2023-04-11" .
`;
    const result = await runReconciliation([
      { content: named('urn:imm:a'), systemName: 'Meridian' },
      { content: named('urn:imm:b'), systemName: 'Ridgecrest' },
    ]);

    expect(result.report.summary.finalRecordCount).toBe(1);
    expect(transformations(result)[0].matchedOn).toBe('name:"tetanus toxoid"+2023-04-11');
  });
});

// ---------------------------------------------------------------------------
// Code extraction, and what reaches a persisted conflict id
// ---------------------------------------------------------------------------

function lab(uri: string, loincUri: string, value: string): string {
  return `${PREFIXES}
<${uri}> a health:LabResultRecord ;
  health:testName "Glucose" ;
  health:testCode <${loincUri}> ;
  health:performedDate "2025-03-04" ;
  health:resultValue "${value}" .
`;
}

describe('code extraction: one LOINC, two importer spellings, one key', () => {
  it('matches a FHIR loinc/rdf# URI against a C-CDA loinc/ URI for the same code', async () => {
    const result = await runReconciliation([
      { content: lab('urn:lab:fhir', 'http://loinc.org/rdf#3094-0', '18'), systemName: 'Meridian FHIR' },
      { content: lab('urn:lab:ccda', 'http://loinc.org/3094-0', '18'), systemName: 'Meridian C-CDA' },
    ]);
    expect(result.report.summary.finalRecordCount).toBe(1);
  });

  it('puts the bare code in matchedOn, which is what a conflict id is built from', async () => {
    const result = await runReconciliation([
      { content: lab('urn:lab:a', 'http://loinc.org/rdf#3094-0', '18'), systemName: 'Meridian' },
      { content: lab('urn:lab:b', 'http://loinc.org/rdf#3094-0', '44'), systemName: 'Ridgecrest' },
    ]);

    const [t] = transformations(result);
    expect(t.matchedOn).toBe('loinc:3094-0+2025-03-04');
    // The string in the pod, not just in memory: `rdf#3094-0` is what used to
    // land in settings/pending-conflicts.ttl and stay there.
    expect(generateConflictId(t.recordType, t.matchedOn!)).toBe(
      'health:LabResultRecord::loinc:3094-0+2025-03-04',
    );
  });
});

// ---------------------------------------------------------------------------
// Medication partial-name conflict ids
// ---------------------------------------------------------------------------

function med(uri: string, drugName: string, dose: string, status = 'active'): string {
  return `${PREFIXES}
<${uri}> a clinical:Medication ;
  clinical:drugName "${drugName}" ;
  clinical:dosage "${dose}" ;
  clinical:status "${status}" .
`;
}

describe('medication partial-name conflicts: one id per drug, not one id total', () => {
  it('names the drug in matchedOn so two drugs cannot share a conflict id', async () => {
    // Two independent conflicts in one run, both matched by name containment.
    // Under the bare `partial-name` constant these produced one id, and
    // user-resolutions.ttl is keyed by id and cannot hold two rows under one key.
    // "metoprolol succinate" contains "metoprolol" after normalization without
    // equalling it, which is the containment case the name tier cannot answer.
    const result = await runReconciliation([
      { content: med('urn:m:a1', 'metoprolol', '25 mg'), systemName: 'Harborview' },
      { content: med('urn:m:a2', 'metoprolol succinate', '50 mg'), systemName: 'Ridgecrest' },
      { content: med('urn:m:b1', 'insulin', '10 units'), systemName: 'Harborview' },
      { content: med('urn:m:b2', 'insulin glargine', '20 units'), systemName: 'Ridgecrest' },
    ]);

    const matched = transformations(result)
      .filter((t) => t.matchedOn?.startsWith('partial-name'))
      .map((t) => t.matchedOn!);
    expect(matched.sort()).toEqual(['partial-name:"insulin"', 'partial-name:"metoprolol"']);

    const ids = matched.map((m) => generateConflictId('clinical:Medication', m));
    expect(new Set(ids).size).toBe(2);
  });

  it('picks the contained name, so the id does not depend on input order', async () => {
    const forward = await runReconciliation([
      { content: med('urn:m:1', 'metoprolol', '25 mg'), systemName: 'Harborview' },
      { content: med('urn:m:2', 'metoprolol succinate', '50 mg'), systemName: 'Ridgecrest' },
    ]);
    const reversed = await runReconciliation([
      { content: med('urn:m:2', 'metoprolol succinate', '50 mg'), systemName: 'Ridgecrest' },
      { content: med('urn:m:1', 'metoprolol', '25 mg'), systemName: 'Harborview' },
    ]);

    expect(transformations(forward)[0].matchedOn).toBe('partial-name:"metoprolol"');
    expect(transformations(reversed)[0].matchedOn).toBe('partial-name:"metoprolol"');
  });
});

describe('conflict ids an earlier version wrote are still findable', () => {
  it('reproduces the pre-fix id for both changed shapes, and only when it differs', () => {
    expect(legacyConflictIds('clinical:Medication', 'partial-name:"lisinopril"')).toEqual([
      'clinical:Medication::partial-name',
    ]);
    expect(legacyConflictIds('health:LabResultRecord', 'loinc:3094-0+2025-03-04')).toEqual([
      'health:LabResultRecord::loinc:rdf_3094-0+2025-03-04',
    ]);
    // An id no defect ever mangled has no older spelling to look for.
    expect(legacyConflictIds('clinical:Medication', 'rxnorm:861007')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The cross-batch path
// ---------------------------------------------------------------------------

describe('cross-batch reconciliation runs on the existing-pod marker, not on a label', () => {
  /**
   * Two records the pod ALREADY holds that match each other, plus one new
   * record. The pod is settled state: its records are not re-compared against
   * each other, only against what is arriving. So the marker is observable as a
   * merge that does NOT happen.
   */
  const podRecordA = `${PREFIXES}
<urn:pod:a> a health:ConditionRecord ;
  cascade:sourceSystem "Harborview" ;
  health:conditionName "Type 2 diabetes mellitus" ;
  health:status "active" .
`;
  const podRecordB = `${PREFIXES}
<urn:pod:b> a health:ConditionRecord ;
  cascade:sourceSystem "Ridgecrest" ;
  health:conditionName "Type 2 diabetes mellitus" ;
  health:status "active" .
`;
  const incoming = `${PREFIXES}
<urn:new:c> a health:ConditionRecord ;
  cascade:sourceSystem "Cascadia" ;
  health:conditionName "Seasonal allergic rhinitis" ;
  health:status "active" .
`;

  it('takes the cross-batch path when the input is marked, whatever the records say', async () => {
    // Every pod record carries its own cascade:sourceSystem — the reconciler
    // re-states it on every write — so `systemName: 'existing-pod'` is always
    // overwritten and could never be the signal. `existingPod` is.
    const result = await runReconciliation([
      { content: `${podRecordA}\n${podRecordB}`, systemName: 'existing-pod', existingPod: true },
      { content: incoming, systemName: 'Cascadia' },
    ]);

    expect(result.report.summary.totalInputRecords).toBe(3);
    expect(result.report.summary.finalRecordCount).toBe(3);
    expect(result.report.summary.exactDuplicatesRemoved).toBe(0);
  });

  it('falls to the single-batch path without the marker, which re-compares the pod with itself', async () => {
    // The SAME inputs, one argument different. This is the pin on the argument:
    // an implementation that ignored `existingPod` would give this run's answer
    // for both, which is what shipped.
    const result = await runReconciliation([
      { content: `${podRecordA}\n${podRecordB}`, systemName: 'existing-pod' },
      { content: incoming, systemName: 'Cascadia' },
    ]);

    expect(result.report.summary.totalInputRecords).toBe(3);
    expect(result.report.summary.finalRecordCount).toBe(2);
  });

  it('keeps the pod\'s own copy when a batch re-imports a subject the pod holds', async () => {
    // Same subject IRI on both sides: a re-import. The stored copy wins, so the
    // record's first-seen timestamp is not re-stamped and its already-resolved
    // edges are not re-resolved.
    const stored = `${PREFIXES}
<urn:pod:x> a health:ConditionRecord ;
  cascade:sourceSystem "Harborview" ;
  clinical:importedAt "2025-01-02T00:00:00Z" ;
  health:conditionName "Type 2 diabetes mellitus" ;
  health:status "active" .
`;
    const reimported = `${PREFIXES}
<urn:pod:x> a health:ConditionRecord ;
  cascade:sourceSystem "Harborview" ;
  clinical:importedAt "2025-09-30T00:00:00Z" ;
  health:conditionName "Type 2 diabetes mellitus" ;
  health:status "active" .
`;
    const result = await runReconciliation([
      { content: stored, systemName: 'existing-pod', existingPod: true },
      { content: reimported, systemName: 'Harborview' },
    ]);

    expect(result.report.summary.finalRecordCount).toBe(1);
    expect(result.report.summary.duplicateSubjectsDropped).toBe(1);
    expect(result.turtle).toContain('2025-01-02T00:00:00Z');
    expect(result.turtle).not.toContain('2025-09-30T00:00:00Z');
  });
});
