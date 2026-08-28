/**
 * Fields the FHIR import path read past: record status, and the two Encounter
 * fields that were selected wrongly rather than merely sparsely.
 *
 * THE DEFECTS THESE PIN
 * ---------------------
 * 1. `status` / `docStatus` were not emitted by any converter that has one. An
 *    `amended` lab result and a `final` one, an `amended` document and a `final`
 *    one, were BYTE-IDENTICAL in the pod. Measured on one real account: 1
 *    amended Observation and 9 amended DocumentReferences, none of them
 *    distinguishable after import. That is a correctness defect, not an
 *    enrichment, and no new vocabulary was needed to carry it.
 *
 * 2. `convertEncounter` took `participant[0].individual.display` with no role
 *    check. On the same account the first slot held an explicitly non-treating
 *    role on 18 of the 52 encounters that have participants — an authorising
 *    physician 16 times, a referrer twice — so the pod named the wrong clinician
 *    with nothing on the record to say so.
 *
 * 3. `clinical:facilityName` appeared ZERO times in that entire pod, because the
 *    converter sourced it only from `serviceProvider`, which the vendor never
 *    populated, while `location[].location.display` was present on every single
 *    encounter (24 distinct clinics).
 *
 * WHAT THESE TESTS WOULD DO IF THE FIX WERE ABSENT
 * ------------------------------------------------
 * Measured, not assumed, against the parent commit with `dist/` rebuilt from
 * it: 16 of the 27 cases below FAIL. The 11 that pass either way are every case
 * labelled STABILITY PIN, plus the Coverage and `class.display` acknowledged
 * drops — they state what must NOT have changed, or what is deliberately still
 * missing, and are not counted as evidence for this change. (The third
 * acknowledged-drop case, on `DocumentReference.status`, does fail beforehand:
 * it asserts that exactly one of the resource's two status elements is emitted,
 * and beforehand neither was.)
 *
 * Two further cases in `clinical-identity.test.ts` also fail beforehand — the
 * mechanical audit rows added there for the two newly serialized fields.
 *
 * Every fixture is synthetic and PHI-free.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  convertObservationLab,
  convertObservationVital,
  convertCondition,
  convertAllergyIntolerance,
  convertClinicalDocument,
  convertEncounter,
  convertLaboratoryReport,
} from '../src/lib/fhir-converter/converters-clinical.js';
import { convertCoverage } from '../src/lib/fhir-converter/converters-demographics.js';
import { NS } from '../src/lib/fhir-converter/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Converted = {
  _quads: Array<{ subject: { value: string }; predicate: { value: string }; object: { value: string } }>;
};

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function valuesOf(result: Converted, predicate: string): string[] {
  return result._quads.filter((q) => q.predicate.value === predicate).map((q) => q.object.value);
}

function valueOf(result: Converted, predicate: string): string | undefined {
  return valuesOf(result, predicate)[0];
}

/** Everything the converter wrote, subject IRI dropped. Two records that differ here are two records. */
function statementsOf(result: Converted): string[] {
  return result._quads.map((q) => `${q.predicate.value} ${q.object.value}`).sort();
}

const STATUS = NS.clinical + 'status';
const VERIFICATION_STATUS = NS.clinical + 'verificationStatus';
const PROVIDER_NAME = NS.clinical + 'providerName';
const FACILITY_NAME = NS.clinical + 'facilityName';
const ENCOUNTER_CLASS = NS.clinical + 'encounterClass';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function labObservation(overrides: Record<string, unknown> = {}): any {
  return {
    resourceType: 'Observation',
    id: 'obs-glucose-1',
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
    code: { coding: [{ system: 'http://loinc.org', code: '2339-0', display: 'Glucose' }], text: 'Glucose' },
    subject: { reference: 'Patient/synthetic-1' },
    effectiveDateTime: '2026-02-04T07:15:00Z',
    valueQuantity: { value: 95, unit: 'mg/dL' },
    ...overrides,
  };
}

function vitalObservation(overrides: Record<string, unknown> = {}): any {
  return {
    resourceType: 'Observation',
    id: 'obs-hr-1',
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
    code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] },
    subject: { reference: 'Patient/synthetic-1' },
    effectiveDateTime: '2026-02-04T09:30:00Z',
    valueQuantity: { value: 72, unit: 'beats/minute' },
    ...overrides,
  };
}

function documentReference(overrides: Record<string, unknown> = {}): any {
  return {
    resourceType: 'DocumentReference',
    id: 'doc-progress-1',
    status: 'current',
    docStatus: 'final',
    type: { text: 'Progress Notes' },
    date: '2026-02-04T12:00:00Z',
    content: [{ attachment: { contentType: 'application/pdf', url: 'Binary/b1' } }],
    ...overrides,
  };
}

function diagnosticReport(overrides: Record<string, unknown> = {}): any {
  return {
    resourceType: 'DiagnosticReport',
    id: 'dr-cbc-1',
    status: 'final',
    code: { coding: [{ system: 'http://loinc.org', code: '58410-2' }], text: 'Complete Blood Count' },
    effectiveDateTime: '2026-02-04T07:15:00Z',
    issued: '2026-02-04T11:00:00Z',
    ...overrides,
  };
}

function conditionResource(overrides: Record<string, unknown> = {}): any {
  return {
    resourceType: 'Condition',
    id: 'cond-1',
    subject: { reference: 'Patient/synthetic-1' },
    code: { coding: [{ system: 'http://snomed.info/sct', code: '38341003' }], text: 'Essential hypertension' },
    onsetDateTime: '2021-04-02',
    ...overrides,
  };
}

function allergyResource(overrides: Record<string, unknown> = {}): any {
  return {
    resourceType: 'AllergyIntolerance',
    id: 'alg-1',
    patient: { reference: 'Patient/synthetic-1' },
    code: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '7980' }], text: 'Penicillin G' },
    criticality: 'high',
    ...overrides,
  };
}

function coverageResource(overrides: Record<string, unknown> = {}): any {
  return {
    resourceType: 'Coverage',
    id: 'cov-1',
    status: 'cancelled',
    payor: [{ display: 'Example Health Plan' }],
    subscriberId: 'SUB-12345',
    ...overrides,
  };
}

/** A participant with a declared role. `type` omitted entirely when `type` is null. */
function participant(name: string, type?: { code?: string; text?: string }): any {
  const entry: any = { individual: { display: name } };
  if (type) {
    const concept: any = {};
    if (type.code) concept.coding = [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: type.code }];
    if (type.text) concept.text = type.text;
    entry.type = [concept];
  }
  return entry;
}

function encounterResource(overrides: Record<string, unknown> = {}): any {
  return {
    resourceType: 'Encounter',
    id: 'enc-1',
    status: 'finished',
    class: { code: '5', display: 'Appointment' },
    type: [{ text: 'Derm Problem' }],
    period: { start: '2026-02-04T15:00:00Z', end: '2026-02-04T15:30:00Z' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. status and docStatus
// ---------------------------------------------------------------------------

describe('an amended record is distinguishable from a final one', () => {
  it('lab Observation: `amended` reaches the pod, and does not read as `final`', () => {
    const finalResult = convertObservationLab(labObservation({ status: 'final' })) as Converted;
    const amended = convertObservationLab(labObservation({ status: 'amended' })) as Converted;

    expect(valueOf(amended, STATUS)).toBe('amended');
    expect(valueOf(finalResult, STATUS)).toBe('final');
    // The property that actually failed: the two records were byte-identical.
    expect(statementsOf(amended)).not.toEqual(statementsOf(finalResult));
  });

  it('vital Observation: the same element, under the same predicate as the lab branch', () => {
    // `convertObservationVital` re-routes non-canonical vitals into
    // `convertObservationLab`, so a per-branch predicate would mean the same
    // source element landing under two names depending on a routing table.
    const amended = convertObservationVital(vitalObservation({ status: 'amended' })) as Converted;
    expect(valueOf(amended, STATUS)).toBe('amended');
  });

  it('DocumentReference: `docStatus` reaches the pod', () => {
    const finalResult = convertClinicalDocument(documentReference({ docStatus: 'final' })) as Converted;
    const amended = convertClinicalDocument(documentReference({ docStatus: 'amended' })) as Converted;

    expect(valueOf(amended, STATUS)).toBe('amended');
    expect(valueOf(finalResult, STATUS)).toBe('final');
    expect(statementsOf(amended)).not.toEqual(statementsOf(finalResult));
  });

  it('DiagnosticReport: `status` reaches the pod', () => {
    const amended = convertLaboratoryReport(diagnosticReport({ status: 'amended' })) as Converted;
    expect(valueOf(amended, STATUS)).toBe('amended');
    expect(statementsOf(amended))
      .not.toEqual(statementsOf(convertLaboratoryReport(diagnosticReport({ status: 'final' })) as Converted));
  });

  it('Condition: `refuted` is not stored as though the problem were confirmed', () => {
    const refuted = convertCondition(conditionResource({
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'refuted' }] },
    })) as Converted;
    const confirmed = convertCondition(conditionResource({
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
    })) as Converted;

    expect(valueOf(refuted, VERIFICATION_STATUS)).toBe('refuted');
    expect(valueOf(confirmed, VERIFICATION_STATUS)).toBe('confirmed');
    expect(statementsOf(refuted)).not.toEqual(statementsOf(confirmed));
  });

  it('AllergyIntolerance: a resolved allergy is not stored as an active one', () => {
    const resolved = convertAllergyIntolerance(allergyResource({
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'resolved' }] },
    })) as Converted;
    const active = convertAllergyIntolerance(allergyResource({
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
    })) as Converted;

    expect(valueOf(resolved, STATUS)).toBe('resolved');
    expect(valueOf(active, STATUS)).toBe('active');
    expect(statementsOf(resolved)).not.toEqual(statementsOf(active));
  });
});

describe('STABILITY PIN: a status is reported, never invented', () => {
  // A defaulted status would assert `final` about a record whose server never
  // said so — which is the same class of defect as dropping it, in the opposite
  // direction and harder to see.
  it('lab Observation with no status emits no status', () => {
    const noStatus = labObservation();
    delete noStatus.status;
    expect(valuesOf(convertObservationLab(noStatus) as Converted, STATUS)).toEqual([]);
  });

  it('DocumentReference with no docStatus emits no status', () => {
    const noDocStatus = documentReference();
    delete noDocStatus.docStatus;
    expect(valuesOf(convertClinicalDocument(noDocStatus) as Converted, STATUS)).toEqual([]);
  });

  it('Condition with neither status element emits neither', () => {
    // AMENDED for 3.257. This asserted `health:status` was 'active' on a
    // Condition that states no clinicalStatus at all — the converter's default,
    // read back as though the source had said it. That is the invention this
    // very describe block is named after, in the direction nobody was looking:
    // a problem list where every untyped entry reads as a live problem.
    const result = convertCondition(conditionResource()) as Converted;
    expect(valuesOf(result, VERIFICATION_STATUS)).toEqual([]);
    expect(valuesOf(result, NS.health + 'status')).toEqual([]);
  });

  it('Condition that states a clinicalStatus still emits it', () => {
    const result = convertCondition(
      conditionResource({ clinicalStatus: { coding: [{ code: 'active' }] } }),
    ) as Converted;
    expect(valueOf(result, NS.health + 'status')).toBe('active');
  });

  it('AllergyIntolerance with no clinicalStatus emits no status', () => {
    expect(valuesOf(convertAllergyIntolerance(allergyResource()) as Converted, STATUS)).toEqual([]);
  });
});

/**
 * CLOSED BY WAVE 4. All three drops this block guarded had one cause — no
 * predicate could carry the value — and clinical v1.16 / coverage v1.5 authored
 * all three terms, so the block now asserts the emissions instead of the
 * omissions.
 *
 * The `coverage:status` case is worth keeping a note on because it is what a
 * tripwire is FOR. It did not merely document a gap; it failed, by itself, on
 * the commit that synced the new vocabulary in, before any converter had been
 * touched — which is how the omission got closed in the same change as the term
 * that closed it rather than outliving the reason for it by a release.
 *
 * The emission behaviour is asserted in depth in `fhir-field-coverage-wave4.test.ts`.
 * What stays here is the half these cases uniquely hold: that the NEW value did
 * not displace the OLD one. The code is not overwritten by the display, and the
 * document's status is not overwritten by the reference's.
 */
describe('WAS an acknowledged drop: statuses that now have a predicate', () => {
  const SHAPES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'shapes');

  it('Coverage.status is emitted, on the coverage: term the vocabulary now defines', () => {
    const result = convertCoverage(coverageResource({ status: 'cancelled' })) as Converted;
    expect(valuesOf(result, NS.coverage + 'status')).toEqual(['cancelled']);
    // Still NOT on clinical:status. The predicate was authored in coverage:
    // rather than borrowed from clinical:, and borrowing it later would be the
    // same scope decision made in a converter that this wave avoided making.
    expect(valuesOf(result, STATUS)).toEqual([]);

    const vocab = fs.readFileSync(path.join(SHAPES, 'coverage.ttl'), 'utf8');
    expect(/^coverage:status\s+a\s+owl:/m.test(vocab), 'the bundled vocabulary must define the term being emitted').toBe(true);
  });

  it('Encounter.class.display is emitted and the class CODE is not overwritten by it', () => {
    // The code is what the reverse converter needs to rebuild Encounter.class,
    // so "store the readable one instead" was never an available shortcut. Both
    // are kept now, on predicates of their own.
    const result = convertEncounter(encounterResource({ class: { code: '5', display: 'Appointment' } })) as Converted;
    expect(valueOf(result, ENCOUNTER_CLASS)).toBe('5');
    expect(valuesOf(result, NS.clinical + 'encounterClassDisplay')).toEqual(['Appointment']);
  });

  it('DocumentReference.status and docStatus land on their own predicates, unconflated', () => {
    // `status: current` and `docStatus: final` are different elements. Exactly
    // one value reaches clinical:status, and it is still the document's.
    const result = convertClinicalDocument(documentReference({ status: 'current', docStatus: 'final' })) as Converted;
    expect(valuesOf(result, STATUS)).toEqual(['final']);
    expect(valuesOf(result, NS.clinical + 'documentReferenceStatus')).toEqual(['current']);
  });
});

// ---------------------------------------------------------------------------
// 2. Encounter: which participant is THE provider
// ---------------------------------------------------------------------------

describe('providerName names the clinician who treated the patient', () => {
  it('an attender listed AFTER a referrer is still the provider', () => {
    // The measured case: the pod stored the referring physician and dropped the
    // dermatologist who delivered the care.
    const result = convertEncounter(encounterResource({
      participant: [
        participant('Referring Physician', { code: 'REF', text: 'referrer' }),
        participant('Treating Dermatologist', { code: 'ATND', text: 'attender' }),
      ],
    })) as Converted;
    expect(valueOf(result, PROVIDER_NAME)).toBe('Treating Dermatologist');
  });

  it('an attender declared only in type.text beats an authorising physician listed first', () => {
    // The text tier. This vendor writes `attender` in `type[].text` and leaves
    // `type[].coding` unpopulated, so a code-only reader picks the wrong name on
    // every one of these.
    const result = convertEncounter(encounterResource({
      participant: [
        participant('Authorising Physician', { text: 'losAuthorizingPhysician' }),
        participant('Attending Clinician', { text: 'attender' }),
      ],
    })) as Converted;
    expect(valueOf(result, PROVIDER_NAME)).toBe('Attending Clinician');
  });

  it('a generic `Participation` role does not outrank a named performer', () => {
    const result = convertEncounter(encounterResource({
      participant: [
        participant('Unspecified Participant', { code: 'PART', text: 'Participation' }),
        participant('Primary Performer', { code: 'PPRF' }),
      ],
    })) as Converted;
    expect(valueOf(result, PROVIDER_NAME)).toBe('Primary Performer');
  });

  it("the measured Epic dialect: a local PHYSICIAN role beats a referrer listed first", () => {
    // The real dermatology-visit shape this fix was measured against: slot 0 is
    // the referrer (REF), and the clinician who delivered the care appears only
    // under the vendor's LOCAL spellings — `losAuthorizingPhysician`,
    // `PHYSICIAN`, `PART` — none of them a v3 ParticipationType code. A rank
    // table that speaks only v3 falls through to "first named", which is the
    // referrer: the exact record the audit opened with stays wrong.
    const result = convertEncounter(encounterResource({
      participant: [
        participant('Referring Physician, MD', { code: 'REF', text: 'referrer' }),
        participant('Treating Dermatologist, MD', { text: 'losAuthorizingPhysician' }),
        participant('Treating Dermatologist, MD', { code: 'PHYSICIAN', text: 'Physician' }),
        participant('Treating Dermatologist, MD', { code: 'PART', text: 'Participation' }),
      ],
    })) as Converted;
    expect(valueOf(result, PROVIDER_NAME)).toBe('Treating Dermatologist, MD');
  });

  it('a neutral unranked name beats an explicitly NON-treating one listed first', () => {
    // Neither participant is ranked, but `referrer` states this person did NOT
    // deliver the care, while the generic Participation says nothing either
    // way. Silence should beat a stated disqualification.
    const result = convertEncounter(encounterResource({
      participant: [
        participant('Referring Physician, MD', { code: 'REF', text: 'referrer' }),
        participant('Some Participant', { code: 'PART', text: 'Participation' }),
      ],
    })) as Converted;
    expect(valueOf(result, PROVIDER_NAME)).toBe('Some Participant');
  });

  it('STABILITY PIN: an explicitly non-treating role is still stored when it is the only name', () => {
    // Losing the only name the encounter has would be a worse answer than an
    // unlabelled referrer. Labelling it is the wave-4 vocabulary item.
    const result = convertEncounter(encounterResource({
      participant: [participant('Referring Physician, MD', { code: 'REF', text: 'referrer' })],
    })) as Converted;
    expect(valueOf(result, PROVIDER_NAME)).toBe('Referring Physician, MD');
  });

  it('the preference ORDER holds, not merely the membership', () => {
    // Pins the rank of every entry in the table against the one below it.
    // Membership alone is satisfied by a set; these fail if any single rank
    // moves or is deleted.
    const pairs: Array<[string, string]> = [
      ['ATND', 'PPRF'],
      ['PPRF', 'SPRF'],
      ['SPRF', 'CON'],
      ['CON', 'ADM'],
      ['ADM', 'DIS'],
    ];
    for (const [better, worse] of pairs) {
      // Listed worse-first AND better-first, so a converter that simply took the
      // last (or the first) ranked participant cannot pass both directions.
      const worseFirst = convertEncounter(encounterResource({
        participant: [participant(`${worse} name`, { code: worse }), participant(`${better} name`, { code: better })],
      })) as Converted;
      const betterFirst = convertEncounter(encounterResource({
        participant: [participant(`${better} name`, { code: better }), participant(`${worse} name`, { code: worse })],
      })) as Converted;
      expect(valueOf(worseFirst, PROVIDER_NAME), `${better} should outrank ${worse}`).toBe(`${better} name`);
      expect(valueOf(betterFirst, PROVIDER_NAME), `${better} should outrank ${worse}`).toBe(`${better} name`);
    }
  });

  it('every ranked role outranks an unranked one, listed last', () => {
    for (const code of ['ATND', 'PPRF', 'SPRF', 'CON', 'ADM', 'DIS']) {
      const result = convertEncounter(encounterResource({
        participant: [
          participant('Authorising Physician', { text: 'losAuthorizingPhysician' }),
          participant(`${code} name`, { code }),
        ],
      })) as Converted;
      expect(valueOf(result, PROVIDER_NAME), `${code} should be preferred`).toBe(`${code} name`);
    }
  });

  it('the code is read case-insensitively, as a code and not as free text', () => {
    const result = convertEncounter(encounterResource({
      participant: [
        participant('Referring Physician', { code: 'REF' }),
        participant('Attending Clinician', { code: 'atnd' }),
      ],
    })) as Converted;
    expect(valueOf(result, PROVIDER_NAME)).toBe('Attending Clinician');
  });

  it('STABILITY PIN: two participants of equal rank are broken by source order, so the answer is stable', () => {
    const encounter = encounterResource({
      participant: [participant('First Attender', { code: 'ATND' }), participant('Second Attender', { code: 'ATND' })],
    });
    expect(valueOf(convertEncounter(clone(encounter)) as Converted, PROVIDER_NAME)).toBe('First Attender');
    expect(valueOf(convertEncounter(clone(encounter)) as Converted, PROVIDER_NAME)).toBe('First Attender');
  });

  it('a participant carrying a role but NO name never displaces one carrying a name', () => {
    const result = convertEncounter(encounterResource({
      participant: [
        { type: [{ coding: [{ code: 'ATND' }] }] },
        participant('Named Referrer', { code: 'REF' }),
      ],
    })) as Converted;
    expect(valueOf(result, PROVIDER_NAME)).toBe('Named Referrer');
  });

  it('STABILITY PIN: with no ranked role anywhere, the first named participant is still used', () => {
    // The pre-existing behaviour. Losing a name entirely would be a worse answer
    // than an unranked one.
    const result = convertEncounter(encounterResource({
      participant: [participant('Only Participant'), participant('Second Participant')],
    })) as Converted;
    expect(valueOf(result, PROVIDER_NAME)).toBe('Only Participant');
  });

  it('STABILITY PIN: an encounter with no participants emits no providerName', () => {
    expect(valuesOf(convertEncounter(encounterResource()) as Converted, PROVIDER_NAME)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Encounter: the facility
// ---------------------------------------------------------------------------

describe('facilityName falls back to the location when the vendor omits serviceProvider', () => {
  it('a named location reaches the pod when serviceProvider is absent', () => {
    // The whole of the measured defect: serviceProvider empty on all 54
    // encounters, location present on all 54, facilityName present zero times.
    const result = convertEncounter(encounterResource({
      location: [{ location: { display: 'Northgate Dermatology' } }],
    })) as Converted;
    expect(valueOf(result, FACILITY_NAME)).toBe('Northgate Dermatology');
  });

  it('the first NON-EMPTY location display is used, not merely location[0]', () => {
    const result = convertEncounter(encounterResource({
      location: [
        { location: {} },
        { location: { display: '   ' } },
        { location: { display: 'Riverside Clinic' } },
        { location: { display: 'Second Clinic' } },
      ],
    })) as Converted;
    expect(valueOf(result, FACILITY_NAME)).toBe('Riverside Clinic');
  });

  it('STABILITY PIN: serviceProvider still wins when it is populated', () => {
    const result = convertEncounter(encounterResource({
      serviceProvider: { display: 'General Hospital' },
      location: [{ location: { display: 'Northgate Dermatology' } }],
    })) as Converted;
    expect(valuesOf(result, FACILITY_NAME)).toEqual(['General Hospital']);
  });

  it('STABILITY PIN: neither present emits nothing rather than an empty string', () => {
    expect(valuesOf(convertEncounter(encounterResource()) as Converted, FACILITY_NAME)).toEqual([]);
  });
});
