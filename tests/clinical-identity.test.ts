/**
 * A Condition, an allergy, an immunization and a patient must be identified by
 * the identifier their source assigned them.
 *
 * THE DEFECT THESE PIN
 * --------------------
 * Four converters minted their subject as
 * `contentHashedUri(type, {…narrow key…}, resource.id)`. That reads as "identify
 * by content, fall back to the id", but `contentHashedUri` consults
 * `fallbackId` ONLY when every content field is empty — which never happens on a
 * real record. So the id was not a fallback, it was DEAD, and a distinct,
 * stable, server-assigned identifier was thrown away on every record.
 *
 * Measured against `origin/main`, same content under two different ids:
 *
 *     convertCondition          'server-id-A' vs 'server-id-B' -> ONE IRI
 *     convertAllergyIntolerance 'server-id-A' vs 'server-id-B' -> ONE IRI
 *     convertImmunization       'server-id-A' vs 'server-id-B' -> ONE IRI
 *     convertPatient            'server-id-A' vs 'server-id-B' -> ONE IRI
 *
 * It is the same mechanism already fixed for lab results, in four more types.
 *
 * READ THIS BEFORE REPEATING "NO DATA IS LOST"
 * -------------------------------------------
 * These merges were originally called low severity because the merged pairs
 * "really are the same clinical fact". The identity fields did agree. The
 * NON-identity fields did not have to, and that is the whole defect: two
 * Conditions sharing patient, code and onset can disagree on `clinicalStatus`
 * and `verificationStatus`, so an ACTIVE, CONFIRMED problem and a RESOLVED,
 * REFUTED one merged, with the winner decided by which file was read first.
 * `it('the reading a reader will assume is safe')` below is exactly that pair.
 *
 * What kept it from being an emergency is not that the merges were harmless: it
 * is that a differing-content collision is now split and raised as a conflict
 * instead of silently overwritten. Visible, not safe.
 *
 * WHAT THESE TESTS WOULD DO IF THE FIX WERE ABSENT
 * ------------------------------------------------
 * Measured, not assumed: every case in sections 1-4 FAILS against `origin/main`.
 * The cases that pass either way are the whole of section 5 and are labelled
 * STABILITY PIN in place; each states which guarantee it is guarding rather than
 * being counted as evidence for this change.
 *
 * Every fixture is synthetic and PHI-free.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  convertCondition,
  convertAllergyIntolerance,
} from '../src/lib/fhir-converter/converters-clinical.js';
import {
  convertImmunization,
  convertPatient,
} from '../src/lib/fhir-converter/converters-demographics.js';

// ---------------------------------------------------------------------------
// Helpers and base fixtures
// ---------------------------------------------------------------------------

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

type Converted = { _quads: Array<{ subject: { value: string }; predicate: { value: string }; object: { value: string } }> };

/** The minted subject IRI: the first quad is the `rdf:type` triple on it. */
function subjectOf(result: Converted): string {
  expect(result._quads.length).toBeGreaterThan(0);
  return result._quads[0].subject.value;
}

/**
 * Everything the converter WROTE about the record, with the subject IRI removed.
 *
 * Two resources whose serialized statements differ are two different records in
 * the pod, whatever their identity says. Comparing this to identity is what
 * section 4 does.
 */
function statementsOf(result: Converted): string[] {
  return result._quads.map((q) => `${q.predicate.value} ${q.object.value}`).sort();
}

/** A hypertension problem as a FHIR server returns it. */
function condition(overrides: Record<string, unknown> = {}): any {
  return {
    resourceType: 'Condition',
    subject: { reference: 'Patient/synthetic-1' },
    code: {
      coding: [{ system: 'http://snomed.info/sct', code: '38341003', display: 'Essential hypertension' }],
      text: 'Essential hypertension',
    },
    onsetDateTime: '2021-04-02',
    ...overrides,
  };
}

/** A penicillin allergy. */
function allergy(overrides: Record<string, unknown> = {}): any {
  return {
    resourceType: 'AllergyIntolerance',
    patient: { reference: 'Patient/synthetic-1' },
    code: {
      coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '7980', display: 'Penicillin G' }],
      text: 'Penicillin G',
    },
    criticality: 'high',
    ...overrides,
  };
}

/** A seasonal influenza dose. */
function immunization(overrides: Record<string, unknown> = {}): any {
  return {
    resourceType: 'Immunization',
    status: 'completed',
    patient: { reference: 'Patient/synthetic-1' },
    vaccineCode: {
      coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '141', display: 'Influenza, seasonal' }],
      text: 'Influenza, seasonal',
    },
    occurrenceDateTime: '2025-10-15',
    ...overrides,
  };
}

/** A patient. */
function patient(overrides: Record<string, unknown> = {}): any {
  return {
    resourceType: 'Patient',
    name: [{ family: 'Rivera', given: ['Alex'] }],
    gender: 'female',
    birthDate: '1985-03-15',
    ...overrides,
  };
}

const condUri = (r: any): string => subjectOf(convertCondition(clone(r)));
const algUri = (r: any): string => subjectOf(convertAllergyIntolerance(clone(r)));
const immUri = (r: any): string => subjectOf(convertImmunization(clone(r)));
const patUri = (r: any): string => subjectOf(convertPatient(clone(r)));

/** The four types under one description, so a case can be stated once. */
const TYPES = [
  { name: 'Condition', base: condition, uri: condUri, convert: convertCondition },
  { name: 'AllergyIntolerance', base: allergy, uri: algUri, convert: convertAllergyIntolerance },
  { name: 'Immunization', base: immunization, uri: immUri, convert: convertImmunization },
  { name: 'Patient', base: patient, uri: patUri, convert: convertPatient },
] as const;

// ---------------------------------------------------------------------------
// 1. A present `resource.id` decides
// ---------------------------------------------------------------------------

describe('the identifier a source assigned is what identifies the record', () => {
  for (const { name, base, uri } of TYPES) {
    it(`${name}: two records the source kept apart stay two records`, () => {
      // Nothing in the content distinguishes them. The ids ARE the source
      // saying these are two records, and discarding them merged the pair.
      expect(uri(base({ id: 'server-id-A' }))).not.toBe(uri(base({ id: 'server-id-B' })));
    });

    it(`${name}: the id path is deterministic AND discriminating, not merely deterministic`, () => {
      // Determinism on its own is satisfied by returning a constant — which is
      // very nearly what the defect did. Both halves, or neither is evidence.
      const a = base({ id: 'server-id-A' });
      const b = base({ id: 'server-id-B' });
      expect(uri(a)).toBe(uri(clone(a)));
      expect(uri(b)).toBe(uri(clone(b)));
      expect(uri(a)).not.toBe(uri(b));
      expect(uri(a)).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    });
  }

  it('the reading a reader will assume is safe: ACTIVE+CONFIRMED and RESOLVED+REFUTED', () => {
    // This is the pair the original "no data is lost" argument was wrong about.
    // Patient, code and onset all agree, so the old key called them one record —
    // but one says the patient HAS essential hypertension and the other says the
    // claim was investigated and REFUTED. They are opposite assertions, each
    // with its own server id, and merging them let file read order decide which
    // one the pod ends up asserting.
    const active = condition({
      id: 'cond-active',
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
    });
    const refuted = condition({
      id: 'cond-refuted',
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'resolved' }] },
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'refuted' }] },
    });

    expect(condUri(active)).not.toBe(condUri(refuted));
    // And the disagreement really is present in the records, so the merge would
    // have destroyed something rather than being a harmless tidy-up.
    expect(statementsOf(convertCondition(clone(active))))
      .not.toEqual(statementsOf(convertCondition(clone(refuted))));
  });

  it('the same pair with no ids is also two records', () => {
    // The id-less half of the same scenario: with no identifier to honour, the
    // content key has to carry both status fields or the merge simply moves.
    const active = condition({
      clinicalStatus: { coding: [{ code: 'active' }] },
      verificationStatus: { coding: [{ code: 'confirmed' }] },
    });
    const refuted = condition({
      clinicalStatus: { coding: [{ code: 'resolved' }] },
      verificationStatus: { coding: [{ code: 'refuted' }] },
    });
    expect(condUri(active)).not.toBe(condUri(refuted));
  });
});

// ---------------------------------------------------------------------------
// 2. The id-less path: the discriminating fields are in the key
// ---------------------------------------------------------------------------

describe('id-less Conditions are separated by what actually differs', () => {
  it('a code the old key could not read still identifies the problem', () => {
    // The old key read exactly two codings, found by substring match on the
    // system URL: `snomed` and `icd`. A Condition coded in any other system
    // contributed NOTHING to its own identity and merged with every other such
    // Condition for that patient on that day.
    const local = (code: string): any => ({
      resourceType: 'Condition',
      subject: { reference: 'Patient/synthetic-1' },
      code: { coding: [{ system: 'http://epic.example.org/dx', code }] },
      onsetDateTime: '2021-04-02',
    });
    expect(condUri(local('E11-LOCAL'))).not.toBe(condUri(local('J45-LOCAL')));
  });

  it('a text-only code identifies the problem', () => {
    // Portal exports routinely carry `code.text` and no coding at all. Under
    // the old key those Conditions were indistinguishable from one another.
    const textOnly = (text: string): any => ({
      resourceType: 'Condition',
      subject: { reference: 'Patient/synthetic-1' },
      code: { text },
      onsetDateTime: '2021-04-02',
    });
    expect(condUri(textOnly('Asthma'))).not.toBe(condUri(textOnly('Migraine')));
  });

  it('onset is identity at FULL precision, not truncated to a day', () => {
    expect(condUri(condition({ onsetDateTime: '2021-04-02T08:00:00Z' })))
      .not.toBe(condUri(condition({ onsetDateTime: '2021-04-02T16:00:00Z' })));
  });

  it('an abatement date is identity — a resolved problem is not the active one', () => {
    expect(condUri(condition({ abatementDateTime: '2023-01-01' })))
      .not.toBe(condUri(condition({ abatementDateTime: '2024-06-01' })));
  });

  it('the category is identity — a problem-list entry is not an encounter diagnosis', () => {
    expect(condUri(condition({ category: [{ coding: [{ code: 'problem-list-item' }] }] })))
      .not.toBe(condUri(condition({ category: [{ coding: [{ code: 'encounter-diagnosis' }] }] })));
  });

  it('the encounter is identity — the same diagnosis recorded at two visits is two records', () => {
    expect(condUri(condition({ encounter: { reference: 'Encounter/visit-may' } })))
      .not.toBe(condUri(condition({ encounter: { reference: 'Encounter/visit-june' } })));
  });

  it('a note is identity — "Provisional" is not "Ruled out"', () => {
    // The hole the mechanical audit in section 4 found in the first draft of
    // this very change: `note` is SERIALIZED as health:notes but was outside
    // the key, so two Conditions saying opposite things shared an IRI.
    const noted = (text: string): any => ({
      resourceType: 'Condition',
      subject: { reference: 'Patient/synthetic-1' },
      onsetDateTime: '2021-04-02',
      note: [{ text }],
    });
    expect(condUri(noted('Provisional'))).not.toBe(condUri(noted('Ruled out')));
  });
});

describe('id-less allergies are separated by what actually differs', () => {
  it('a coding system is part of the code — two systems reusing digits are not one allergen', () => {
    // The old key read `code.coding[0].code` WITHOUT its system, so any two
    // systems that reuse a number collided outright, and a resource whose first
    // coding is the local EHR's own numbering keyed on that instead of on the
    // RxNorm code beside it.
    const coded = (system: string): any => ({
      resourceType: 'AllergyIntolerance',
      patient: { reference: 'Patient/synthetic-1' },
      code: { coding: [{ system, code: '7980' }] },
    });
    expect(algUri(coded('http://www.nlm.nih.gov/research/umls/rxnorm')))
      .not.toBe(algUri(coded('http://snomed.info/sct')));
  });

  it('THE REACTION IS IDENTITY — a mild rash is not an anaphylaxis', () => {
    // The sharpest merge in this file. Severity is the part a clinician acts
    // on, and the old key held nothing about the reaction at all, so which of
    // the two survived was decided by input order — meaning a pod could report
    // a life-threatening allergy as mild.
    const rash = allergy({ reaction: [{ manifestation: [{ text: 'Rash' }], severity: 'mild' }] });
    const anaphylaxis = allergy({ reaction: [{ manifestation: [{ text: 'Anaphylaxis' }], severity: 'severe' }] });
    expect(algUri(rash)).not.toBe(algUri(anaphylaxis));
  });

  it('criticality is identity', () => {
    expect(algUri(allergy({ criticality: 'low' }))).not.toBe(algUri(allergy({ criticality: 'high' })));
  });

  it('onset is identity', () => {
    expect(algUri(allergy({ onsetDateTime: '2019-01-01' })))
      .not.toBe(algUri(allergy({ onsetDateTime: '2022-07-01' })));
  });

  it('the category is identity — a medication allergy is not a food allergy', () => {
    expect(algUri(allergy({ category: ['medication'] }))).not.toBe(algUri(allergy({ category: ['food'] })));
  });

  it('verificationStatus is identity — confirmed is not refuted', () => {
    expect(algUri(allergy({ verificationStatus: { coding: [{ code: 'confirmed' }] } })))
      .not.toBe(algUri(allergy({ verificationStatus: { coding: [{ code: 'refuted' }] } })));
  });
});

describe('id-less immunizations are separated by what actually differs', () => {
  it('the lot number is identity', () => {
    expect(immUri(immunization({ lotNumber: 'AAJN11K' }))).not.toBe(immUri(immunization({ lotNumber: 'BBKP22L' })));
  });

  it('the body site is identity — a left-arm and a right-arm injection are two doses', () => {
    // Two vaccines administered in one visit at two sites is ordinary practice,
    // and "two flu shots on one day really are one dose" — the argument the old
    // key rested on — cannot tell that case from a duplicate record.
    expect(immUri(immunization({ site: { text: 'Left deltoid' } })))
      .not.toBe(immUri(immunization({ site: { text: 'Right deltoid' } })));
  });

  it('the status is identity — a `not-done` entry is not a dose that was given', () => {
    // The merge here tells a reader a vaccine was administered when the source
    // says it was not.
    expect(immUri(immunization({ status: 'completed' }))).not.toBe(immUri(immunization({ status: 'not-done' })));
  });

  it('the dose quantity is identity — a paediatric half-dose is not a full one', () => {
    expect(immUri(immunization({ doseQuantity: { value: 0.25, unit: 'mL' } })))
      .not.toBe(immUri(immunization({ doseQuantity: { value: 0.5, unit: 'mL' } })));
  });

  it('the occurrence instant is identity at FULL precision', () => {
    expect(immUri(immunization({ occurrenceDateTime: '2025-10-15T09:00:00Z' })))
      .not.toBe(immUri(immunization({ occurrenceDateTime: '2025-10-15T15:30:00Z' })));
  });

  it('a coding system is part of the vaccine code', () => {
    const coded = (system: string): any => ({
      resourceType: 'Immunization',
      status: 'completed',
      patient: { reference: 'Patient/synthetic-1' },
      vaccineCode: { coding: [{ system, code: '141' }] },
      occurrenceDateTime: '2025-10-15',
    });
    expect(immUri(coded('http://hl7.org/fhir/sid/cvx'))).not.toBe(immUri(coded('http://hl7.org/fhir/sid/ndc')));
  });

  it('the manufacturer is identity', () => {
    expect(immUri(immunization({ manufacturer: { display: 'Sanofi Pasteur' } })))
      .not.toBe(immUri(immunization({ manufacturer: { display: 'Seqirus' } })));
  });
});

describe('id-less patients are separated by what actually differs', () => {
  it('an identifier is identity — two people with one name and one birthday are two people', () => {
    // The old key was {birthDate, gender, name[0].family, name[0].given[0]}. It
    // never looked at `identifier` — the medical record number, the very field
    // an EHR uses to tell two patients apart. Merging two patients merges the
    // subject every record in the pod hangs off, which is the worst merge
    // available in this system.
    const withMrn = (value: string): any => patient({ identifier: [{ system: 'urn:oid:1.2.3', value }] });
    expect(patUri(withMrn('MRN-100200'))).not.toBe(patUri(withMrn('MRN-300400')));
  });

  it('every given name is identity, not just the first', () => {
    expect(patUri(patient({ name: [{ family: 'Rivera', given: ['Alex', 'Marie'] }] })))
      .not.toBe(patUri(patient({ name: [{ family: 'Rivera', given: ['Alex', 'Jordan'] }] })));
  });

  it('a suffix is identity — Jr is not Sr', () => {
    expect(patUri(patient({ name: [{ family: 'Rivera', given: ['Alex'], suffix: ['Jr'] }] })))
      .not.toBe(patUri(patient({ name: [{ family: 'Rivera', given: ['Alex'], suffix: ['Sr'] }] })));
  });

  it('a second name entry is identity — a maiden name is not invisible', () => {
    expect(patUri(patient()))
      .not.toBe(patUri(patient({
        name: [{ family: 'Rivera', given: ['Alex'] }, { use: 'maiden', family: 'Okonkwo', given: ['Alex'] }],
      })));
  });
});

// ---------------------------------------------------------------------------
// 3. Placeholder defaults are display values, never identity
// ---------------------------------------------------------------------------

/**
 * `?? 'Unknown Condition'`, `?? 'Unknown Allergen'`, `?? 'Unknown Vaccine'`.
 *
 * A placeholder is the right answer for what a record DISPLAYS and never for
 * what it IS: it converts "we do not know" into "these are the same record". A
 * content hash that succeeds with a constant is indistinguishable from one that
 * fails, except that it merges records instead of splitting them.
 *
 * These placeholders were judged safe by an earlier sweep specifically BECAUSE
 * they were not in an identity key. Widening the keys is what could have made
 * that judgement stale, so each is re-checked here rather than assumed.
 */
describe('a placeholder display name never reaches an identity key', () => {
  const cases = [
    {
      name: 'Condition',
      predicate: 'https://ns.cascadeprotocol.org/health/v1#conditionName',
      placeholder: 'Unknown Condition',
      convert: convertCondition,
      a: { resourceType: 'Condition', subject: { reference: 'Patient/synthetic-1' }, note: [{ text: 'Provisional' }] },
      b: { resourceType: 'Condition', subject: { reference: 'Patient/synthetic-1' }, note: [{ text: 'Ruled out' }] },
    },
    {
      name: 'AllergyIntolerance',
      predicate: 'https://ns.cascadeprotocol.org/health/v1#allergen',
      placeholder: 'Unknown Allergen',
      convert: convertAllergyIntolerance,
      a: { resourceType: 'AllergyIntolerance', patient: { reference: 'Patient/synthetic-1' }, criticality: 'low' },
      b: { resourceType: 'AllergyIntolerance', patient: { reference: 'Patient/synthetic-1' }, criticality: 'high' },
    },
    {
      name: 'Immunization',
      predicate: 'https://ns.cascadeprotocol.org/health/v1#vaccineName',
      placeholder: 'Unknown Vaccine',
      convert: convertImmunization,
      a: { resourceType: 'Immunization', patient: { reference: 'Patient/synthetic-1' }, lotNumber: 'AAJN11K' },
      b: { resourceType: 'Immunization', patient: { reference: 'Patient/synthetic-1' }, lotNumber: 'BBKP22L' },
    },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: '${c.placeholder}' is still displayed, and does not merge the records`, () => {
      const ra = c.convert(clone(c.a) as any);
      const rb = c.convert(clone(c.b) as any);

      // The placeholder is still what the record says on screen...
      for (const r of [ra, rb]) {
        const displayed = r._quads.filter((q) => q.predicate.value === c.predicate).map((q) => q.object.value);
        expect(displayed, `${c.name} should still display the placeholder`).toEqual([c.placeholder]);
      }
      // ...and it is not what the record is identified by.
      expect(subjectOf(ra)).not.toBe(subjectOf(rb));
    });
  }
});

// ---------------------------------------------------------------------------
// 4. The mechanical audit: no serialized difference may share an identity
// ---------------------------------------------------------------------------

/**
 * The property that actually has to hold, stated once instead of field by field.
 *
 * If two resources produce DIFFERENT statements in the pod, they are two
 * different records, and an identity that cannot tell them apart merges them.
 * (The converse is deliberately NOT asserted: identity may split records that
 * serialize identically, because a split is recoverable and a merge is not.)
 *
 * This is the check that found `note` missing from the Condition, allergy and
 * immunization keys, and `performer` / `location` missing from the
 * immunization key, in the first draft of this change. Case-by-case tests
 * cannot find the field nobody thought of; this can, and it will fail on the
 * next one a future edit forgets.
 */
describe('two records that serialize differently never share an identity', () => {
  const AUDIT: Array<{ name: string; base: () => any; convert: (r: any) => Converted; mutations: Array<[string, Record<string, unknown>]> }> = [
    {
      name: 'Condition',
      base: condition,
      convert: convertCondition as any,
      mutations: [
        ['code', { code: { coding: [{ system: 'http://snomed.info/sct', code: '195967001' }], text: 'Asthma' } }],
        ['category', { category: [{ coding: [{ code: 'encounter-diagnosis' }] }] }],
        ['clinicalStatus', { clinicalStatus: { coding: [{ code: 'resolved' }] } }],
        ['onsetDateTime', { onsetDateTime: '2022-09-09' }],
        ['onsetPeriod', { onsetDateTime: undefined, onsetPeriod: { start: '2019-01-01' } }],
        ['abatementDateTime', { abatementDateTime: '2024-01-01' }],
        ['note', { note: [{ text: 'Ruled out' }] }],
        ['encounter', { encounter: { reference: 'Encounter/visit-june' } }],
        ['id', { id: 'cond-1' }],
      ],
    },
    {
      name: 'AllergyIntolerance',
      base: allergy,
      convert: convertAllergyIntolerance as any,
      mutations: [
        ['code', { code: { coding: [{ system: 'http://snomed.info/sct', code: '387406002' }], text: 'Sulfonamide' } }],
        ['category', { category: ['food'] }],
        ['criticality', { criticality: 'low' }],
        ['reaction', { reaction: [{ manifestation: [{ text: 'Anaphylaxis' }], severity: 'severe' }] }],
        ['onsetDateTime', { onsetDateTime: '2019-01-01' }],
        ['note', { note: [{ text: 'Reported by patient' }] }],
        ['id', { id: 'alg-1' }],
      ],
    },
    {
      name: 'Immunization',
      base: immunization,
      convert: convertImmunization as any,
      mutations: [
        ['vaccineCode', { vaccineCode: { coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '208' }], text: 'COVID-19' } }],
        ['occurrenceDateTime', { occurrenceDateTime: '2024-10-15' }],
        ['status', { status: 'not-done' }],
        ['manufacturer', { manufacturer: { display: 'Seqirus' } }],
        ['lotNumber', { lotNumber: 'BBKP22L' }],
        ['doseQuantity', { doseQuantity: { value: 0.5, unit: 'mL' } }],
        ['route', { route: { text: 'Intramuscular' } }],
        ['site', { site: { text: 'Right deltoid' } }],
        ['performer', { performer: [{ actor: { display: 'Community Pharmacy' } }] }],
        ['location', { location: { display: 'Riverside Clinic' } }],
        ['note', { note: [{ text: 'Given at a drive-through clinic' }] }],
        ['encounter', { encounter: { reference: 'Encounter/visit-october' } }],
        ['id', { id: 'imm-1' }],
      ],
    },
    {
      name: 'Patient',
      base: patient,
      convert: convertPatient as any,
      mutations: [
        ['birthDate', { birthDate: '1972-11-08' }],
        ['gender', { gender: 'male' }],
        ['address', { address: [{ city: 'Portland', state: 'OR', postalCode: '97201', line: ['1 Main St'] }] }],
        // Needs a display or text: the converter reads marital status through
        // `codeableConceptText`, which returns nothing for a bare code, so a
        // code-only mutation would change no statement and the guard below
        // would (correctly) call this case vacuous.
        ['maritalStatus', { maritalStatus: { coding: [{ code: 'M', display: 'Married' }], text: 'Married' } }],
        ['id', { id: 'pat-1' }],
      ],
    },
  ];

  for (const { name, base, convert, mutations } of AUDIT) {
    it(`${name}: every field it serializes is inside its identity`, () => {
      const baseline = convert(clone(base()));
      const baseStatements = statementsOf(baseline);
      const baseUri = subjectOf(baseline);

      const merged: string[] = [];
      let compared = 0;
      for (const [field, override] of mutations) {
        const mutated = convert(clone(base(override)));
        // Only meaningful where the mutation actually changed the record.
        if (statementsOf(mutated).join('\n') === baseStatements.join('\n')) continue;
        compared++;
        if (subjectOf(mutated) === baseUri) merged.push(field);
      }

      // Guard the guard: a mutation list that stopped changing anything would
      // make this test vacuous while staying green.
      expect(compared, `${name}: no mutation changed the record — this test proves nothing`)
        .toBe(mutations.length);
      expect(
        merged,
        `${name}: these fields change what the pod stores but not the record's identity, so two ` +
          `records differing only in them collide: ${merged.join(', ')}`,
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. STABILITY PINS — what must NOT change
// ---------------------------------------------------------------------------

/**
 * These pass against `origin/main` too, and are not evidence for this change.
 * They guard the mirror-image failure: a fix that split records on every sync
 * would be worse than the merge it replaced, because the pod would grow
 * forever and never say so.
 */
describe('STABILITY PIN: a true re-import still deduplicates', () => {
  for (const { name, base, uri } of TYPES) {
    it(`${name}: byte-identical input twice is one record, with an id`, () => {
      const r = base({ id: 'server-id-A' });
      expect(uri(r)).toBe(uri(clone(r)));
    });

    it(`${name}: byte-identical input twice is one record, with no id`, () => {
      const r = base();
      expect(uri(r)).toBe(uri(clone(r)));
    });

    it(`${name}: server metadata churn between two fetches does not move the identity`, () => {
      // `meta.versionId`, `meta.lastUpdated` and `meta.source` change on every
      // re-fetch of an UNCHANGED resource. Hashing them would mint a fresh IRI
      // on every EHR sync — this defect's mirror image, and much harder to see.
      const first = base({ id: 'server-id-A' });
      const refetched = base({
        id: 'server-id-A',
        meta: { versionId: '17', lastUpdated: '2026-08-03T19:22:41.881+00:00', source: 'urn:oid:1.2.3#z' },
      });
      expect(uri(first)).toBe(uri(refetched));
    });

    it(`${name}: an id-less record re-fetched with churned metadata keeps its identity`, () => {
      const first = base();
      const refetched = base({
        meta: { versionId: '17', lastUpdated: '2026-08-03T19:22:41.881+00:00', source: 'urn:oid:1.2.3#z' },
      });
      expect(uri(first)).toBe(uri(refetched));
    });
  }

  it('Patient: a telephone number is not identity', () => {
    // `telecom` is NOT serialized by this converter, so two Patients differing
    // only there are the same record and must not split. This is the boundary
    // of the completeness rule the keys are built to, asserted rather than
    // asserted-about.
    expect(patUri(patient())).toBe(patUri(patient({ telecom: [{ system: 'phone', value: '555-0100' }] })));
  });
});

describe('STABILITY PIN: the identity door still collapses an empty record loudly', () => {
  for (const { name, convert } of TYPES) {
    it(`${name}: a resource with no id and no content warns rather than passing silently`, () => {
      const type = name === 'Patient' ? 'Patient' : name;
      const bare = convert({ resourceType: type } as any) as unknown as { warnings: string[] };
      expect(
        bare.warnings.some((w) => w.includes('carries no identifier and no identity-bearing content')),
        `${name} collapsed to the shared sentinel without saying so`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Across processes and across working directories
// ---------------------------------------------------------------------------

/**
 * Minting twice inside one process shares a warm module cache, one
 * `process.cwd()`, and any memoization a converter holds, so a defect keyed on
 * any of those is invisible to it — and this repo has actually shipped a
 * path-dependent identity defect that stayed green for months for exactly that
 * reason.
 *
 * So this spawns SEPARATE node processes from DIFFERENT working directories and
 * compares across them, through `dist/` — the artifact an npm consumer installs.
 *
 * The skip guard keys on a module present in EVERY revision of this repo, not
 * on anything this change introduces. A guard that keys on a new file SKIPS
 * instead of FAILING when run against a pre-fix build, which is how a
 * determinism suite looks green while proving nothing.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(REPO, 'dist');
const HAVE_DIST = fs.existsSync(path.join(DIST, 'lib', 'fhir-converter', 'converters-demographics.js'));

const SCRIPT = `
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
const dist = process.env.CASCADE_DIST;
const clinical = await import(pathToFileURL(path.join(dist, 'lib/fhir-converter/converters-clinical.js')).href);
const demographics = await import(pathToFileURL(path.join(dist, 'lib/fhir-converter/converters-demographics.js')).href);
const byType = {
  Condition: clinical.convertCondition,
  AllergyIntolerance: clinical.convertAllergyIntolerance,
  Immunization: demographics.convertImmunization,
  Patient: demographics.convertPatient,
};
const payload = JSON.parse(process.env.CASCADE_PAYLOAD);
const out = {
  cwd: process.cwd(),
  uris: payload.map((r) => byType[r.resourceType](r)._quads[0].subject.value),
};
process.stdout.write(JSON.stringify(out));
`;

function mintIn(dir: string, resources: any[]): { cwd: string; uris: string[] } {
  const scriptPath = path.join(dir, 'mint.mjs');
  fs.writeFileSync(scriptPath, SCRIPT, 'utf8');
  const stdout = execFileSync(process.execPath, [scriptPath], {
    cwd: dir,
    env: { ...process.env, CASCADE_DIST: DIST, CASCADE_PAYLOAD: JSON.stringify(resources) },
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

describe.skipIf(!HAVE_DIST)('clinical identity survives the process and the working directory', () => {
  it('two processes in two directories agree, and still tell every record apart', () => {
    // Eight resources: an id-bearing and an id-less pair of each type, where
    // the members of each pair are meant to be DIFFERENT records.
    const resources = [
      condition({ id: 'cond-A' }),
      condition({ id: 'cond-B' }),
      condition({ clinicalStatus: { coding: [{ code: 'active' }] } }),
      condition({ clinicalStatus: { coding: [{ code: 'resolved' }] } }),
      allergy({ id: 'alg-A' }),
      allergy({ reaction: [{ manifestation: [{ text: 'Anaphylaxis' }], severity: 'severe' }] }),
      immunization({ id: 'imm-A' }),
      immunization({ lotNumber: 'BBKP22L' }),
      patient({ id: 'pat-A' }),
      patient({ identifier: [{ system: 'urn:oid:1.2.3', value: 'MRN-100200' }] }),
    ];

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-clin-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-clin-b-'));
    try {
      const a = mintIn(dirA, clone(resources));
      const b = mintIn(dirB, clone(resources));

      expect(a.cwd).not.toBe(b.cwd);
      // DETERMINISM: two processes, two directories, one answer.
      expect(a.uris, `cwd ${a.cwd} disagreed with cwd ${b.cwd}`).toEqual(b.uris);
      // DISTINCTNESS: and the answer is not a constant. Without this half, a
      // function returning one string would pass the line above perfectly.
      expect(new Set(a.uris).size, `records shared an IRI: ${a.uris.join(' ')}`).toBe(resources.length);
      for (const uri of a.uris) expect(uri).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });
});
