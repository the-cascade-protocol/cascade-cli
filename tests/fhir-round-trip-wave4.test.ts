/**
 * Round trip: FHIR -> Cascade -> FHIR, for every predicate the import path
 * learned to write in waves 1 and 4.
 *
 * THE DEFECT
 * ------------------------------
 * Wave 1 taught the converters to emit `clinical:status` and
 * `clinical:verificationStatus`, and the reverse converters were not touched.
 * Nothing read either predicate back, and several restorers wrote a HARDCODED
 * status instead — `'final'` on a DiagnosticReport, `'current'` on a
 * DocumentReference, `'active'` on a Coverage. So a pod holding a correct
 * `amended`, `superseded`, `refuted` or `cancelled` exported it as the confident
 * default, which is the same class of defect the import fix had just closed,
 * pointed the other way: the pod knew, and the export unlearned it.
 *
 * Wave 4 adds nine encounter facts, three document facts and a coverage status,
 * so the same gap would open nine more times if the reverse converters were left
 * alone again. Every one of them is asserted here.
 *
 * WHAT A CASE PROVES, AND WHAT IT DOES NOT
 * ----------------------------------------
 * These are ROUND TRIPS, not equality assertions on the whole resource. Cascade
 * is a lossy target by design (references to resources the pod does not hold are
 * dropped, codings are narrowed), so "the output equals the input" would be
 * false for reasons that are not defects. Each case therefore names the ELEMENT
 * it is about and asserts that element survived the trip, which is exactly the
 * claim 3.262 says was never checked.
 *
 * The trip runs through `convertCascadeToFhir` — the real entry point, parsing
 * real Turtle — rather than by handing a restorer a hand-built map, so a
 * predicate that is emitted but never serialized, or serialized but never
 * parsed, fails here too.
 *
 * All fixtures are synthetic and PHI-free.
 */

import { describe, it, expect } from 'vitest';

import { convertFhirResourceToQuads } from '../src/lib/fhir-converter/fhir-to-cascade.js';
import { convertCascadeToFhir } from '../src/lib/fhir-converter/cascade-to-fhir.js';
import { quadsToTurtle, TURTLE_PREFIXES } from '../src/lib/fhir-converter/types.js';

/** FHIR in, Cascade Turtle, FHIR back out. The resource of the given type. */
async function roundTrip(resource: Record<string, unknown>): Promise<Record<string, any>> {
  const converted = convertFhirResourceToQuads(structuredClone(resource));
  if (!converted) throw new Error(`no conversion for ${String(resource.resourceType)}`);
  const turtle = await quadsToTurtle(converted._quads);
  const { resources } = await convertCascadeToFhir(turtle);
  const match = resources.find((r) => r.resourceType === resource.resourceType);
  if (!match) {
    throw new Error(
      `round trip lost the ${String(resource.resourceType)}; got ${resources.map((r) => r.resourceType).join(', ') || '<nothing>'}`,
    );
  }
  return match;
}

// A prefix table is required by quadsToTurtle's writer; assert it exists so a
// refactor that empties it fails here rather than producing unparseable output.
expect(Object.keys(TURTLE_PREFIXES).length).toBeGreaterThan(0);

// ---------------------------------------------------------------------------
// Encounter
// ---------------------------------------------------------------------------

const ENCOUNTER = {
  resourceType: 'Encounter',
  id: 'enc-derm-1',
  status: 'finished',
  class: { system: 'urn:oid:1.2.840.114350.1.72.1.7.1', code: '5', display: 'Appointment' },
  identifier: [
    { system: 'urn:oid:1.2.840.114350.1.13.999.2.7.3.698084.8', value: '20100000001' },
    { value: 'BARE-4471' },
  ],
  type: [{ text: 'Office Visit' }],
  reasonCode: [{ text: 'Derm Problem' }, { text: 'Annual skin check' }],
  hospitalization: {
    admitSource: { text: 'From outpatient department' },
    dischargeDisposition: { text: 'Home' },
  },
  participant: [
    {
      type: [{ text: 'referrer', coding: [{ code: 'REF' }] }],
      individual: { display: 'Lucia Marsh, MD' },
    },
    {
      type: [{ text: 'attender', coding: [{ code: 'ATND' }] }],
      extension: [
        {
          url: 'https://vendor.example/fhir/StructureDefinition/participant-specialty',
          valueCodeableConcept: { text: 'Dermatology' },
        },
      ],
      individual: { display: 'Amara Okoye, MD' },
    },
  ],
  period: { start: '2025-04-01T16:00:00Z', end: '2025-04-01T16:40:00Z' },
};

describe('Encounter round trip', () => {
  it('restores the class Coding WHOLE, not just the code', async () => {
    const out = await roundTrip(ENCOUNTER);
    expect(out.class).toEqual({
      code: '5',
      display: 'Appointment',
      system: 'urn:oid:1.2.840.114350.1.72.1.7.1',
    });
  });

  it('restores every reasonCode', async () => {
    const out = await roundTrip(ENCOUNTER);
    expect((out.reasonCode ?? []).map((r: any) => r.text).sort()).toEqual([
      'Annual skin check',
      'Derm Problem',
    ]);
  });

  it('restores admitSource and dischargeDisposition', async () => {
    const out = await roundTrip(ENCOUNTER);
    expect(out.hospitalization?.admitSource?.text).toBe('From outpatient department');
    expect(out.hospitalization?.dischargeDisposition?.text).toBe('Home');
  });

  it('restores every participant with its role, role code and specialty', async () => {
    const out = await roundTrip(ENCOUNTER);
    const byName = new Map<string, any>(
      (out.participant ?? []).map((p: any) => [p.individual?.display, p]),
    );
    expect([...byName.keys()].sort()).toEqual(['Amara Okoye, MD', 'Lucia Marsh, MD']);

    const attender = byName.get('Amara Okoye, MD');
    expect(attender.type?.[0]?.text).toBe('attender');
    expect(attender.type?.[0]?.coding?.map((c: any) => c.code)).toEqual(['ATND']);
    expect(attender.extension?.[0]?.valueCodeableConcept?.text).toBe('Dermatology');

    expect(byName.get('Lucia Marsh, MD').type?.[0]?.text).toBe('referrer');
  });

  it('does NOT re-emit the summary provider as a second participant', async () => {
    // The treating clinician is already one of the participations. Adding the
    // providerName slot back as another entry would emit the same person twice,
    // once with a role and once without, and no consumer could tell the
    // duplicate from a real second participation.
    const out = await roundTrip(ENCOUNTER);
    const names = (out.participant ?? []).map((p: any) => p.individual?.display);
    expect(names.filter((n: string) => n === 'Amara Okoye, MD')).toHaveLength(1);
  });

  it('restores identifiers from the token form, splitting system from value', async () => {
    const out = await roundTrip(ENCOUNTER);
    expect(out.identifier).toEqual([
      { system: 'urn:oid:1.2.840.114350.1.13.999.2.7.3.698084.8', value: '20100000001' },
      // Written bare because the source stated no system, and none is invented
      // on the way back either.
      { value: 'BARE-4471' },
    ]);
  });

  it('an encounter with no participation nodes still restores its summary name', async () => {
    // The pre-v1.16 record, and the reason the fallback exists: those pods hold
    // a providerName and no participations, and exporting no participant at all
    // would lose the one name they have.
    const noParticipants = structuredClone(ENCOUNTER) as Record<string, unknown>;
    noParticipants.participant = [{ individual: { display: 'Solo Clinician, MD' } }];
    const out = await roundTrip(noParticipants);
    expect(out.participant?.[0]?.individual?.display).toBe('Solo Clinician, MD');
  });
});

// ---------------------------------------------------------------------------
// DocumentReference
// ---------------------------------------------------------------------------

const DOCUMENT = {
  resourceType: 'DocumentReference',
  id: 'doc-progress-1',
  status: 'superseded',
  docStatus: 'amended',
  type: { text: 'Progress Notes' },
  date: '2025-04-01T18:22:00Z',
  author: [{ display: 'Noor Habib, MD' }, { display: 'Amara Okoye, MD' }],
  authenticator: { display: 'Priya Raman, MD' },
};

describe('DocumentReference round trip', () => {
  it('restores BOTH statuses onto their own elements', async () => {
    // The pair that shared one predicate through clinical v1.15. Before this
    // change the restorer hardcoded status: 'current', so a superseded filing
    // came back live.
    const out = await roundTrip(DOCUMENT);
    expect(out.status).toBe('superseded');
    expect(out.docStatus).toBe('amended');
  });

  it('restores every author', async () => {
    const out = await roundTrip(DOCUMENT);
    expect((out.author ?? []).map((a: any) => a.display)).toEqual([
      'Noor Habib, MD',
      'Amara Okoye, MD',
    ]);
  });

  it('restores the authenticator as an authenticator, not as an author', async () => {
    const out = await roundTrip(DOCUMENT);
    expect(out.authenticator?.display).toBe('Priya Raman, MD');
    expect((out.author ?? []).map((a: any) => a.display)).not.toContain('Priya Raman, MD');
  });

  it('a document stating no status still exports one, because FHIR requires it', async () => {
    // `DocumentReference.status` is 1..1. The fallback is the one place a value
    // is supplied that the pod did not state, and it is confined to records
    // written before the predicate existed.
    const bare = structuredClone(DOCUMENT) as Record<string, unknown>;
    delete bare.status;
    delete bare.docStatus;
    const out = await roundTrip(bare);
    expect(out.status).toBe('current');
    expect(out.docStatus).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

describe('Coverage round trip', () => {
  const COVERAGE = {
    resourceType: 'Coverage',
    id: 'cov-ppo-1',
    status: 'cancelled',
    type: { coding: [{ code: 'PPO' }] },
    subscriberId: 'MEM-88213400',
    payor: [{ display: 'Cascade Mutual Health' }],
  };

  it('a cancelled plan does not come back active', async () => {
    // `Coverage.status` is a FHIR MODIFIER element, so the previous hardcoded
    // 'active' was not a missing answer on export but a wrong one: it told a
    // downstream reader the patient had coverage that had been cancelled.
    const out = await roundTrip(COVERAGE);
    expect(out.status).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// The wave-1 statuses the reverse converters had been ignoring
// ---------------------------------------------------------------------------

describe('wave-1 statuses now survive the round trip too', () => {
  it('an amended DiagnosticReport does not come back final', async () => {
    const out = await roundTrip({
      resourceType: 'DiagnosticReport',
      id: 'dr-1',
      status: 'amended',
      code: { text: 'CBC' },
      effectiveDateTime: '2025-04-01T16:00:00Z',
    });
    expect(out.status).toBe('amended');
  });

  it('an amended lab Observation keeps its status', async () => {
    const out = await roundTrip({
      resourceType: 'Observation',
      id: 'obs-1',
      status: 'amended',
      category: [{ coding: [{ code: 'laboratory' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: '2951-2' }], text: 'Sodium' },
      valueQuantity: { value: 140, unit: 'mmol/L' },
      effectiveDateTime: '2025-04-01T16:00:00Z',
    });
    expect(out.status).toBe('amended');
  });

  it('a corrected vital-sign Observation keeps its status', async () => {
    const out = await roundTrip({
      resourceType: 'Observation',
      id: 'obs-vital-1',
      status: 'corrected',
      category: [
        { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] },
      ],
      code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }], text: 'Heart rate' },
      valueQuantity: { value: 72, unit: '/min' },
      effectiveDateTime: '2025-04-01T16:00:00Z',
    });
    expect(out.status).toBe('corrected');
  });

  it('a REFUTED Condition does not come back unqualified', async () => {
    // The opposite claim to `confirmed`, and the one that changes what a reader
    // does next.
    const out = await roundTrip({
      resourceType: 'Condition',
      id: 'cond-1',
      clinicalStatus: { coding: [{ code: 'inactive' }] },
      verificationStatus: { coding: [{ code: 'refuted' }] },
      code: { text: 'Peanut allergy' },
    });
    expect(out.verificationStatus?.coding?.[0]?.code).toBe('refuted');
    expect(out.clinicalStatus?.coding?.[0]?.code).toBe('inactive');
  });

  it('a REFUTED AllergyIntolerance keeps both of its status elements', async () => {
    const out = await roundTrip({
      resourceType: 'AllergyIntolerance',
      id: 'allergy-1',
      clinicalStatus: { coding: [{ code: 'inactive' }] },
      verificationStatus: { coding: [{ code: 'refuted' }] },
      code: { text: 'Penicillin' },
    });
    expect(out.clinicalStatus?.coding?.[0]?.code).toBe('inactive');
    expect(out.verificationStatus?.coding?.[0]?.code).toBe('refuted');
  });
});
