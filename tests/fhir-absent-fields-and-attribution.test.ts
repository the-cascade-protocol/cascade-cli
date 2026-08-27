/**
 * Three FHIR import defects that share one shape: the pod states something the
 * source did not.
 *
 * 1. DEFAULT-MASKING (3.257). `convertImmunization` wrote
 *    `resource.status ?? 'completed'`, `convertCondition` wrote
 *    `clinicalStatus ?? 'active'`, and `convertCoverage` wrote
 *    `relationship.coding[0].code ?? 'self'`. A source that said NOTHING was
 *    therefore stored indistinguishably from a source that asserted the value —
 *    the honesty defect of 3.256 inverted. There the pod under-claimed (an
 *    amended result read as final); here it over-claims (silence reads as a
 *    completed dose, an active problem, a self-held policy).
 *
 *    None of the three properties carries `sh:minCount` in its shape
 *    (`health:ImmunizationRecordShape`, `health:ConditionRecordShape`,
 *    `coverage:InsurancePlanShape` all state `sh:maxCount 1` only), so omitting
 *    the triple validates. That was checked before the defaults were removed:
 *    a required property would have made this a spec-repo question instead.
 *
 * 2. `AllergyIntolerance.verificationStatus` (3.256 remainder). `confirmed` and
 *    `refuted` are OPPOSITE claims about whether the patient is allergic at all,
 *    and the pod stated neither. `convertCondition` already emits the same FHIR
 *    element on `clinical:verificationStatus`; the allergy converter did not.
 *
 * 3. DOCUMENTREFERENCE ATTRIBUTION (3.259). `appendProvenanceQuads` exists
 *    precisely to recover the clinician and organization "the per-type
 *    converters historically dropped for most types" — and it read
 *    performer/requester/recorder/asserter/serviceProvider, of which a
 *    DocumentReference states NONE. A clinical note therefore landed in the pod
 *    naming neither its writer nor its source organization, while the source
 *    stated both outright in `author` / `authenticator` / `custodian`.
 *
 * IDENTITY, PINNED RATHER THAN ASSUMED
 * ------------------------------------
 * Removing a default could move an IRI, which is a duplicate record on every pod
 * that already holds one. It does not here, and the reason is structural: all
 * three identity keys read the RAW source element, never the converter's
 * serialized value (`immunizationSubjectUri` says so in as many words;
 * `conditionSubjectUri` keys `codeableConceptKey(resource?.clinicalStatus)`; the
 * Coverage path hashes the raw resource through `mintSubjectUri`). The IRIs
 * below were captured from the id-less path BEFORE the change and are pinned as
 * literals, so a future edit that reintroduces a serialized value into a key
 * fails here rather than in a user's pod.
 *
 * Every fixture is synthetic and PHI-free.
 */

import { describe, it, expect } from 'vitest';

import {
  convertAllergyIntolerance,
  convertCondition,
  convertClinicalDocument,
} from '../src/lib/fhir-converter/converters-clinical.js';
import {
  convertCoverage,
  convertImmunization,
} from '../src/lib/fhir-converter/converters-demographics.js';
import { appendProvenanceQuads } from '../src/lib/fhir-converter/provenance.js';
import { NS } from '../src/lib/fhir-converter/types.js';

type Converted = {
  _quads: Array<{
    subject: { value: string };
    predicate: { value: string };
    object: { value: string };
  }>;
};

function valuesOf(result: Converted, predicate: string): string[] {
  return result._quads.filter((q) => q.predicate.value === predicate).map((q) => q.object.value);
}

/** The record subject a converter minted. */
function subjectOf(result: Converted): string {
  return result._quads[0].subject.value;
}

/** A DocumentReference converted the way the import path converts it: with the provenance pass. */
function convertDocument(resource: Record<string, unknown>): Converted {
  const result = convertClinicalDocument(resource);
  appendProvenanceQuads(resource, result._quads);
  return result;
}

// ---------------------------------------------------------------------------
// 3.257 — silence is not an assertion
// ---------------------------------------------------------------------------

describe('3.257: an absent status is absent in the pod, not a confident default', () => {
  const immunization = () => ({
    resourceType: 'Immunization',
    id: 'imm-no-status',
    vaccineCode: {
      coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '208', display: 'COVID-19 mRNA' }],
      text: 'COVID-19 mRNA Vaccine',
    },
    occurrenceDateTime: '2021-04-15T09:00:00Z',
  });

  const condition = () => ({
    resourceType: 'Condition',
    id: 'cond-no-status',
    code: {
      coding: [{ system: 'http://snomed.info/sct', code: '73211009', display: 'Diabetes Mellitus' }],
      text: 'Diabetes Mellitus',
    },
    onsetDateTime: '2020-03-15',
  });

  const coverage = () => ({
    resourceType: 'Coverage',
    id: 'cov-no-relationship',
    subscriberId: 'XYZ123456',
    payor: [{ display: 'Blue Cross Blue Shield' }],
    type: { coding: [{ code: 'HIP' }] },
  });

  it('an Immunization stating no status gets no health:status', () => {
    const resource = immunization();
    expect(valuesOf(convertImmunization(resource), NS.health + 'status')).toEqual([]);
  });

  it('an Immunization stating a status still gets it, unchanged', () => {
    // The half that must NOT change: `not-done` is the value whose loss would
    // tell a reader a dose was given when the source says it was not.
    for (const status of ['completed', 'not-done', 'entered-in-error']) {
      const resource = { ...immunization(), status };
      expect(valuesOf(convertImmunization(resource), NS.health + 'status')).toEqual([status]);
    }
  });

  it('a Condition stating no clinicalStatus gets no health:status', () => {
    expect(valuesOf(convertCondition(condition()), NS.health + 'status')).toEqual([]);
  });

  it('a Condition stating a clinicalStatus still gets it, unchanged', () => {
    for (const code of ['active', 'resolved', 'remission']) {
      const resource = { ...condition(), clinicalStatus: { coding: [{ code }] } };
      expect(valuesOf(convertCondition(resource), NS.health + 'status')).toEqual([code]);
    }
  });

  it('a Condition whose clinicalStatus states only text gets no health:status', () => {
    // Mapping free text onto ConditionClinicalStatusCodes would be a guess, and
    // guessing "active" is the defect this test exists for.
    const resource = { ...condition(), clinicalStatus: { text: 'Active' } };
    expect(valuesOf(convertCondition(resource), NS.health + 'status')).toEqual([]);
  });

  it('a Coverage stating no relationship gets no coverage:subscriberRelationship', () => {
    expect(valuesOf(convertCoverage(coverage()), NS.coverage + 'subscriberRelationship')).toEqual(
      [],
    );
  });

  it('a Coverage whose relationship states only text gets no subscriberRelationship', () => {
    // This is the reachable half of the defect: the guard was
    // `if (resource.relationship)`, so a relationship present but uncoded fell
    // through to 'self' — the pod asserting the policy is the patient's own.
    const resource = { ...coverage(), relationship: { text: 'Spouse' } };
    expect(valuesOf(convertCoverage(resource), NS.coverage + 'subscriberRelationship')).toEqual([]);
  });

  it('a Coverage stating a coded relationship still gets it, unchanged', () => {
    for (const code of ['self', 'spouse', 'child', 'injured']) {
      const resource = { ...coverage(), relationship: { coding: [{ code }] } };
      expect(valuesOf(convertCoverage(resource), NS.coverage + 'subscriberRelationship')).toEqual([
        code,
      ]);
    }
  });
});

describe('3.257: removing the defaults moves no IRI', () => {
  // Captured from this exact input on the parent commit, with the defaults still
  // in place. The id-less path is the one at risk: with an `id` the IRI comes
  // from the id and no content can reach it.
  it('an id-less Immunization keeps the IRI it had before the default was removed', () => {
    const resource = {
      resourceType: 'Immunization',
      vaccineCode: {
        coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '208', display: 'COVID-19 mRNA' }],
        text: 'COVID-19 mRNA Vaccine',
      },
      occurrenceDateTime: '2021-04-15T09:00:00Z',
      lotNumber: 'EL9264',
    };
    expect(subjectOf(convertImmunization(resource))).toBe(
      'urn:uuid:6e216961-08bd-5ec3-abf5-2196d4fbbfe0',
    );
  });

  it('an id-less Condition keeps the IRI it had before the default was removed', () => {
    const resource = {
      resourceType: 'Condition',
      code: {
        coding: [
          { system: 'http://snomed.info/sct', code: '73211009', display: 'Diabetes Mellitus' },
        ],
        text: 'Diabetes Mellitus',
      },
      onsetDateTime: '2020-03-15',
    };
    expect(subjectOf(convertCondition(resource))).toBe(
      'urn:uuid:91238efa-b784-56b5-979e-fe772bba6323',
    );
  });

  it('an id-less Coverage keeps the IRI it had before the default was removed', () => {
    const resource = {
      resourceType: 'Coverage',
      subscriberId: 'XYZ123456',
      payor: [{ display: 'Blue Cross Blue Shield' }],
      type: { coding: [{ code: 'HIP' }] },
      relationship: { text: 'Self' },
    };
    expect(subjectOf(convertCoverage(resource))).toBe(
      'urn:uuid:1fa3e863-f511-58dc-b334-1454d5de42d0',
    );
  });
});

// ---------------------------------------------------------------------------
// 3.256 remainder — the allergy's verification status
// ---------------------------------------------------------------------------

describe('3.256: an allergy states whether it was confirmed or refuted', () => {
  const allergy = () => ({
    resourceType: 'AllergyIntolerance',
    id: 'allergy-verification-1',
    code: { coding: [{ display: 'Penicillin' }], text: 'Penicillin' },
    category: ['medication'],
  });

  it('emits the coded verification status on clinical:verificationStatus', () => {
    for (const code of ['confirmed', 'unconfirmed', 'presumed', 'refuted', 'entered-in-error']) {
      const resource = { ...allergy(), verificationStatus: { coding: [{ code }] } };
      expect(
        valuesOf(convertAllergyIntolerance(resource), NS.clinical + 'verificationStatus'),
      ).toEqual([code]);
    }
  });

  it('a refuted allergy is no longer byte-identical to a confirmed one', () => {
    const statements = (code: string) =>
      convertAllergyIntolerance({ ...allergy(), verificationStatus: { coding: [{ code }] } })
        ._quads.map((q) => `${q.predicate.value} ${q.object.value}`)
        .sort()
        .join('\n');
    expect(statements('refuted')).not.toBe(statements('confirmed'));
  });

  it('an allergy stating no verification status gets no triple', () => {
    expect(
      valuesOf(convertAllergyIntolerance(allergy()), NS.clinical + 'verificationStatus'),
    ).toEqual([]);
  });

  it('a verification status stated only as text is not guessed at', () => {
    const resource = { ...allergy(), verificationStatus: { text: 'Confirmed' } };
    expect(
      valuesOf(convertAllergyIntolerance(resource), NS.clinical + 'verificationStatus'),
    ).toEqual([]);
  });

  it('moves no IRI: verificationStatus was already in the allergy identity key', () => {
    // Pinned against the value this id-less allergy minted BEFORE the field was
    // serialized. `allergySubjectUri` has keyed it from the start, deliberately,
    // so serializing it now is a fact added to a record that already existed
    // under this name.
    const resource = {
      resourceType: 'AllergyIntolerance',
      code: { coding: [{ display: 'Penicillin' }], text: 'Penicillin' },
      category: ['medication'],
      verificationStatus: {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification',
            code: 'refuted',
          },
        ],
      },
    };
    expect(subjectOf(convertAllergyIntolerance(resource))).toBe(
      'urn:uuid:383529fb-5ad3-5aef-9db7-1ab0e8e3a77d',
    );
  });
});

// ---------------------------------------------------------------------------
// 3.259 — a clinical note names its writer and its holder
// ---------------------------------------------------------------------------

describe('3.259: DocumentReference attribution reaches the pod', () => {
  const document = () => ({
    resourceType: 'DocumentReference',
    id: 'doc-attribution-1',
    type: { text: 'Progress Notes' },
    date: '2025-04-01T18:22:00Z',
    author: [
      { reference: 'Practitioner/resident', display: 'Noor Habib, MD' },
      { reference: 'Practitioner/attender', display: 'Amara Okoye, MD' },
    ],
    authenticator: { reference: 'Practitioner/attender', display: 'Amara Okoye, MD' },
    custodian: { reference: 'Organization/northgate', display: 'Northgate Health Network' },
  });

  it('names the author as the provider', () => {
    expect(valuesOf(convertDocument(document()), NS.clinical + 'providerName')).toEqual([
      'Noor Habib, MD',
    ]);
  });

  it('falls back to the authenticator when the document names no author', () => {
    const resource = document();
    delete (resource as Record<string, unknown>).author;
    expect(valuesOf(convertDocument(resource), NS.clinical + 'providerName')).toEqual([
      'Amara Okoye, MD',
    ]);
  });

  it('names the custodian as the source organization', () => {
    expect(valuesOf(convertDocument(document()), NS.clinical + 'sourceEHR')).toEqual([
      'Northgate Health Network',
    ]);
  });

  it('emits exactly one provider and one source, never one per author', () => {
    // `clinical:providerName` is `sh:maxCount 1` on every shape that constrains
    // it. A pass that emitted one per author would produce records that fail
    // validation on any document with two.
    const quads = convertDocument(document());
    expect(valuesOf(quads, NS.clinical + 'providerName')).toHaveLength(1);
    expect(valuesOf(quads, NS.clinical + 'sourceEHR')).toHaveLength(1);
  });

  it('still prefers the source FHIR server host over the custodian display', () => {
    // STABILITY PIN. The host is the low-cardinality, unambiguous signal and has
    // always won; a custodian must not quietly displace it and split one
    // source axis into two spellings.
    const resource = document();
    resource.author = [
      { reference: 'https://haiku.swedish.org/api/FHIR/R4/Practitioner/1', display: 'Noor Habib, MD' },
    ];
    expect(valuesOf(convertDocument(resource), NS.clinical + 'sourceEHR')).toEqual(['swedish.org']);
  });

  it('a document stating none of the three still gets nothing invented', () => {
    const resource = document();
    delete (resource as Record<string, unknown>).author;
    delete (resource as Record<string, unknown>).authenticator;
    delete (resource as Record<string, unknown>).custodian;
    const quads = convertDocument(resource);
    expect(valuesOf(quads, NS.clinical + 'providerName')).toEqual([]);
    expect(valuesOf(quads, NS.clinical + 'sourceEHR')).toEqual([]);
  });

  it('never overwrites a provider a converter already set', () => {
    // The pass is additive and idempotent by contract. Running it twice must
    // not double the triples it added the first time.
    const resource = document();
    const result = convertClinicalDocument(resource);
    appendProvenanceQuads(resource, result._quads);
    appendProvenanceQuads(resource, result._quads);
    expect(valuesOf(result, NS.clinical + 'providerName')).toEqual(['Noor Habib, MD']);
    expect(valuesOf(result, NS.clinical + 'sourceEHR')).toEqual(['Northgate Health Network']);
  });
});
