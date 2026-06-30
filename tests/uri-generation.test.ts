/**
 * Contract tests for deterministicUuid / contentHashedUri.
 *
 * These tests lock in the exact output values that define the Cascade URI
 * derivation spec.  Any change to the hashing algorithm will cause these
 * tests to fail — that is intentional.  Before changing an algorithm,
 * coordinate with all SDK ports (TypeScript, Python, Swift) so they ship
 * matching changes simultaneously.
 *
 * Algorithm reference (copy of the doc-comment in types.ts):
 *   Input:   UTF-8 string
 *   Hash:    SHA-1(input) -> 40-char lowercase hex digest `h`
 *   Layout:  {h[0:8]}-{h[8:12]}-5{h[13:16]}-{v}{h[18:20]}-{h[20:32]}
 *            where v = (parseInt(h[16:18], 16) & 0x3f | 0x80).toString(16).padStart(2,'0')
 */

import { describe, it, expect } from 'vitest';
import { contentHashedUri, mintSubjectUri, medicationUri } from '../src/lib/fhir-converter/types.js';

describe('deterministicUuid cross-SDK contract', () => {
  it('SHA-1("hello") produces the canonical UUID', () => {
    // contentHashedUri("X", { k: "hello" }) builds identity "X::k=hello"
    // SHA-1("X::k=hello") = 8d332657...
    // -> urn:uuid:8d332657-5b2e-59bb-aeef-5f78bab37a8a
    const uri = contentHashedUri('X', { k: 'hello' });
    expect(uri).toBe('urn:uuid:8d332657-5b2e-59bb-aeef-5f78bab37a8a');
  });

  it('Patient identity fields produce a stable URI', () => {
    // Canonical test vector from types.ts doc-comment:
    //   identity: "Patient::dob=1985-03-15|family=Smith|given=John|sex=male"
    //   -> urn:uuid:aba8c9f5-fdc6-5187-a363-0d5a7cb72438
    const uri = contentHashedUri('Patient', {
      dob: '1985-03-15',
      sex: 'male',
      family: 'Smith',
      given: 'John',
    });
    expect(uri).toBe('urn:uuid:aba8c9f5-fdc6-5187-a363-0d5a7cb72438');
  });

  it('keys are sorted ascending before hashing', () => {
    const ordered   = contentHashedUri('T', { a: '1', b: '2', c: '3' });
    const unordered = contentHashedUri('T', { c: '3', a: '1', b: '2' });
    expect(ordered).toBe(unordered);
  });

  it('undefined and empty values are excluded from identity string', () => {
    const withEmpty    = contentHashedUri('T', { a: '1', b: '', c: undefined });
    const withoutEmpty = contentHashedUri('T', { a: '1' });
    expect(withEmpty).toBe(withoutEmpty);
  });

  it('mintSubjectUri preserves a valid UUID v4 resource id unchanged', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const uri = mintSubjectUri({ resourceType: 'Patient', id });
    expect(uri).toBe(`urn:uuid:${id}`);
  });

  it('mintSubjectUri hashes a non-UUID resource id deterministically', () => {
    const uri1 = mintSubjectUri({ resourceType: 'Condition', id: 'epic-12345' });
    const uri2 = mintSubjectUri({ resourceType: 'Condition', id: 'epic-12345' });
    expect(uri1).toBe(uri2);
    expect(uri1).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('medicationUri matches the cross-port conformance vector (and normalizes the name)', () => {
    // Vector `medication-lisinopril-rxnorm`:
    //   MedicationRequest::normalizedName=lisinopril|patient=urn:uuid:patient-smith|rxNormCode=29046|startDate=2020-04-01
    //   -> urn:uuid:f181c773-4c66-5cd3-96d7-5ff69c472fea
    // The raw name "Lisinopril 10 mg" must normalize to "lisinopril" so dose
    // variants share one identity (dose is NOT part of the URI).
    const uri = medicationUri({
      rxNormCode: '29046',
      medicationName: 'Lisinopril 10 mg',
      startDate: '2020-04-01',
      patient: 'urn:uuid:patient-smith',
    });
    expect(uri).toBe('urn:uuid:f181c773-4c66-5cd3-96d7-5ff69c472fea');
  });

  it('medicationUri excludes dose: 10 mg and 20 mg of the same drug share a URI', () => {
    const base = { rxNormCode: '29046', startDate: '2020-04-01', patient: 'urn:uuid:p1' };
    expect(medicationUri({ ...base, medicationName: 'Lisinopril 10 mg' }))
      .toBe(medicationUri({ ...base, medicationName: 'Lisinopril 20 mg' }));
  });
});
