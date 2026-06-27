/**
 * Tests for the per-resource provenance pass: recovering the performing
 * clinician (clinical:providerName) and the source EHR/organization
 * (clinical:sourceEHR) that the per-type converters historically dropped.
 *
 * Anchored on the real Apple Health shapes observed in a live export:
 *   - MedicationRequest.requester = { reference: "Practitioner/..", display: "Pathmaja Paramsothy, MD" }
 *   - Observation.performer        = { display: "Shahrzad K A", reference: "https://haiku.swedish.org/fhirproxy/.../Practitioner/.." }
 */

import { describe, it, expect } from 'vitest';
import { DataFactory } from 'n3';

import {
  extractProviderName,
  extractSourceEhr,
  appendProvenanceQuads,
} from '../src/lib/fhir-converter/provenance.js';
import { NS, tripleType, tripleStr } from '../src/lib/fhir-converter/types.js';

const { namedNode } = DataFactory;

describe('extractProviderName', () => {
  it('reads requester.display (MedicationRequest)', () => {
    expect(
      extractProviderName({
        resourceType: 'MedicationRequest',
        requester: { reference: 'Practitioner/abc', display: 'Pathmaja Paramsothy, MD' },
      }),
    ).toBe('Pathmaja Paramsothy, MD');
  });

  it('reads performer[0].display (Observation, array form)', () => {
    expect(
      extractProviderName({
        resourceType: 'Observation',
        performer: [{ display: 'Shahrzad K A', reference: 'https://haiku.swedish.org/x' }],
      }),
    ).toBe('Shahrzad K A');
  });

  it('reads nested actor.display (Immunization performer)', () => {
    expect(
      extractProviderName({
        resourceType: 'Immunization',
        performer: [{ actor: { display: 'Nurse Mark H, RN' } }],
      }),
    ).toBe('Nurse Mark H, RN');
  });

  it('returns undefined when no provider field is present', () => {
    expect(extractProviderName({ resourceType: 'Condition' })).toBeUndefined();
  });
});

describe('extractSourceEhr', () => {
  it('derives the registrable host from an absolute performer reference', () => {
    expect(
      extractSourceEhr({
        resourceType: 'Observation',
        performer: [{ display: 'Shahrzad K A', reference: 'https://haiku.swedish.org/fhirproxy/api/FHIR/DSTU2/Practitioner/TT' }],
      }),
    ).toBe('swedish.org');
  });

  it('finds the host from ANY absolute reference (a lab whose only ref is subject/encounter)', () => {
    expect(
      extractSourceEhr({
        resourceType: 'Observation',
        subject: { reference: 'https://haiku.swedish.org/fhirproxy/api/FHIR/DSTU2/Patient/PT' },
      }),
    ).toBe('swedish.org');
  });

  it('NEVER treats a clinician role as the source org (host wins; no host -> none)', () => {
    // A vital with a person performer and no absolute reference: no fabricated org.
    expect(
      extractSourceEhr({
        resourceType: 'Observation',
        performer: [{ display: 'MA Vaidehi J, Medical Assistant' }],
      }),
    ).toBeUndefined();
  });

  it('falls back to an institution display only when there is no host', () => {
    expect(
      extractSourceEhr({
        resourceType: 'DiagnosticReport',
        performer: [{ display: 'Kaiser Permanente Washington' }],
      }),
    ).toBe('Kaiser Permanente Washington');
  });

  it('ignores relative references (no host to derive)', () => {
    expect(
      extractSourceEhr({
        resourceType: 'MedicationRequest',
        requester: { reference: 'Practitioner/abc', display: 'Pathmaja Paramsothy, MD' },
      }),
    ).toBeUndefined();
  });
});

describe('appendProvenanceQuads', () => {
  const SUBJ = 'urn:uuid:rec-1';
  function recordQuads() {
    return [tripleType(SUBJ, NS.clinical + 'Medication')];
  }

  it('adds providerName + sourceEHR to the record subject', () => {
    const quads = recordQuads();
    appendProvenanceQuads(
      {
        resourceType: 'Observation',
        performer: [{ display: 'Shahrzad K A', reference: 'https://haiku.swedish.org/x/Practitioner/p' }],
      },
      quads,
    );
    const preds = quads.map((q) => q.predicate.value);
    expect(preds).toContain(NS.clinical + 'providerName');
    expect(preds).toContain(NS.clinical + 'sourceEHR');
    const ehr = quads.find((q) => q.predicate.value === NS.clinical + 'sourceEHR');
    expect(ehr?.object.value).toBe('swedish.org');
  });

  it('does not overwrite a providerName a converter already set', () => {
    const quads = [
      tripleType(SUBJ, NS.clinical + 'LaboratoryReport'),
      tripleStr(SUBJ, NS.clinical + 'providerName', 'Kaiser Permanente Washington'),
    ];
    appendProvenanceQuads(
      { resourceType: 'DiagnosticReport', performer: [{ display: 'Someone Else, MD' }] },
      quads,
    );
    const providerNames = quads
      .filter((q) => q.predicate.value === NS.clinical + 'providerName')
      .map((q) => q.object.value);
    expect(providerNames).toEqual(['Kaiser Permanente Washington']);
  });

  it('treats health:administeringProvider as an existing provider (no duplicate)', () => {
    const quads = [
      tripleType(SUBJ, NS.health + 'ImmunizationRecord'),
      tripleStr(SUBJ, NS.health + 'administeringProvider', 'Nurse Mark H, RN'),
    ];
    appendProvenanceQuads(
      { resourceType: 'Immunization', performer: [{ actor: { display: 'Nurse Mark H, RN' } }] },
      quads,
    );
    expect(quads.some((q) => q.predicate.value === NS.clinical + 'providerName')).toBe(false);
  });

  it('is a no-op for non-clinical resource types', () => {
    const quads = [tripleType(SUBJ, NS.cascade + 'PatientProfile')];
    appendProvenanceQuads(
      { resourceType: 'Patient', performer: [{ display: 'Whoever' }] },
      quads,
    );
    expect(quads).toHaveLength(1);
  });

  it('is a no-op when the resource carries no provenance signal', () => {
    const quads = recordQuads();
    appendProvenanceQuads({ resourceType: 'Condition' }, quads);
    expect(quads).toHaveLength(1);
  });

  it('only attaches to record subjects (those with rdf:type)', () => {
    const quads = recordQuads();
    // a stray non-typed subject must not receive provenance
    quads.push(tripleStr('urn:uuid:nested', NS.clinical + 'someField', 'x'));
    appendProvenanceQuads(
      { resourceType: 'Procedure', performer: [{ display: 'Dr X', reference: 'https://x.swedish.org/p' }] },
      quads,
    );
    const onNested = quads.filter(
      (q) => q.subject.value === 'urn:uuid:nested' && q.predicate.value === NS.clinical + 'sourceEHR',
    );
    expect(onNested).toHaveLength(0);
    expect(namedNode(SUBJ).value).toBe(SUBJ); // sanity
  });
});
