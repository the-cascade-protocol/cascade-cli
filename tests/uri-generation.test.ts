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
import {
  contentHashedUri,
  mintSubjectUri,
  medicationUri,
  codeableConceptKey,
  codeableConceptSetKey,
  canonicalSetKey,
} from '../src/lib/fhir-converter/types.js';

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

// ---------------------------------------------------------------------------
// Canonical form of a SET-valued identity input (core v3.6)
//
// The rule is stated normatively on cascade:cascadeUri in spec: discard empty
// members, deduplicate, sort by code point, join with a fixed separator, and a
// one-element sequence canonicalizes to the bare scalar.
//
// THE GOLDEN PINS BELOW ARE THE POINT OF THIS BLOCK. The three invariants are
// worth testing, but the claim that actually had to be proved before shipping is
// the NEGATIVE one: that adding dedupe to these key builders moved no identity
// that had already been written. So the single-code and scalar cases are pinned
// to literal URIs, not to each other. A test that only compares two computed
// values passes just as happily when both have moved.
// ---------------------------------------------------------------------------

describe('canonical form of a set-valued identity input (core v3.6)', () => {
  // The URI a single-coding CodeableConcept minted BEFORE dedupe was added.
  //
  // HOW THIS VALUE WAS OBTAINED, because a golden pin copied out of the run it is
  // meant to constrain proves nothing. Three independent derivations agree:
  //   1. An independent SHA-1 implementation applied to the identity string
  //      "Observation::code=http://loinc.org|2339-0" by hand.
  //   2. This module's code at origin/main, i.e. BEFORE canonicalSetKey existed.
  //   3. This module's code now.
  // The only output that differs between (2) and (3) anywhere is the duplicate
  // case: codeableConceptSetKey(['medication','food','food']) was
  // "food;food;medication" and is now "food;medication". That single collapse is
  // the whole behavioural change, and it is the defect being corrected.
  const SINGLE_CODING_URI = 'urn:uuid:69d60ee0-84eb-5ecf-be93-c243962b1ae5';

  it('GOLDEN PIN: one coding hashes exactly as it did before dedupe existed', () => {
    // identity string: Observation::code=http://loinc.org|2339-0
    const uri = contentHashedUri('Observation', {
      code: codeableConceptKey({ coding: [{ system: 'http://loinc.org', code: '2339-0' }] }),
    });
    expect(uri).toBe(SINGLE_CODING_URI);
  });

  it('GOLDEN PIN: a scalar field spelled directly hashes to the same URI', () => {
    // SCALAR AGREEMENT. The key builder is not involved at all here: this is the
    // bare string a pre-0..* caller would have passed. It must land on the same
    // value the coding array does, or the two spellings of one record split.
    const uri = contentHashedUri('Observation', { code: 'http://loinc.org|2339-0' });
    expect(uri).toBe(SINGLE_CODING_URI);
  });

  it('GOLDEN PIN: repeating that one coding does not move it', () => {
    // DUPLICATE INDEPENDENCE, pinned to the literal rather than to a comparison,
    // so it also proves the dedupe collapses TO the pre-existing value and not
    // to some new one.
    const uri = contentHashedUri('Observation', {
      code: codeableConceptKey({
        coding: [
          { system: 'http://loinc.org', code: '2339-0' },
          { system: 'http://loinc.org', code: '2339-0' },
        ],
      }),
    });
    expect(uri).toBe(SINGLE_CODING_URI);
  });

  it('ORDER INDEPENDENCE: two exports listing the same codings differently agree', () => {
    const a = codeableConceptKey({
      coding: [
        { system: 'http://snomed.info/sct', code: '73211009' },
        { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'E11.9' },
      ],
    });
    const b = codeableConceptKey({
      coding: [
        { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'E11.9' },
        { system: 'http://snomed.info/sct', code: '73211009' },
      ],
    });
    expect(a).toBe(b);
    expect(contentHashedUri('Condition', { code: a })).toBe(contentHashedUri('Condition', { code: b }));
  });

  it('a differing SET still differs: canonicalization removes splits, never merges', () => {
    // The guard on the whole change. Sorting and deduping may only collapse
    // spellings of ONE set; if it ever collapsed two different sets, every
    // assertion above would still pass while the converter silently merged
    // distinct records.
    const two = codeableConceptKey({
      coding: [
        { system: 'http://snomed.info/sct', code: '73211009' },
        { system: 'http://snomed.info/sct', code: '44054006' },
      ],
    });
    const one = codeableConceptKey({ coding: [{ system: 'http://snomed.info/sct', code: '73211009' }] });
    expect(two).not.toBe(one);
    expect(contentHashedUri('Condition', { code: two })).not.toBe(contentHashedUri('Condition', { code: one }));
  });

  it('sorts by code point, not by locale', () => {
    // A locale-aware comparator orders these a01, B02, Z01 and would make a
    // record's identity depend on the machine that imported it.
    expect(canonicalSetKey(['Z01', 'a01', 'B02'], ',')).toBe('B02,Z01,a01');
  });

  it('empty and whitespace-only members are discarded, not hashed', () => {
    expect(canonicalSetKey(['2339-0', '', '   '], ',')).toBe('2339-0');
    expect(canonicalSetKey(['', '  '], ',')).toBeUndefined();
    // An all-empty set is ABSENT, and contentHashedUri drops absent fields, so
    // it must hash identically to the field never being supplied.
    expect(contentHashedUri('Observation', { date: '2024-01-10', code: canonicalSetKey([''], ',') }))
      .toBe(contentHashedUri('Observation', { date: '2024-01-10' }));
  });

  it('keeps the separator each existing site already shipped', () => {
    // core v3.6 recommends U+002C and REQUIRES it of new implementations, but
    // lets an existing site keep what it ships, because changing a separator
    // re-mints every identity that site ever produced. codeableConceptSetKey has
    // always joined with ';'. This test is what stops a well-meaning
    // "consistency" edit from silently re-minting every multi-concept record.
    expect(codeableConceptSetKey(['food', 'medication'])).toBe('food;medication');
    expect(canonicalSetKey(['food', 'medication'], ',')).toBe('food,medication');
  });

  it('codeableConceptSetKey deduplicates and orders its members', () => {
    expect(codeableConceptSetKey(['medication', 'food', 'food'])).toBe('food;medication');
    expect(codeableConceptSetKey(['food', 'medication'])).toBe(
      codeableConceptSetKey(['medication', 'food']),
    );
  });
});
