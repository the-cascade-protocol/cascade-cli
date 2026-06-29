/**
 * Parity contract for the shared code-key / ladder module.
 *
 * Canonical definition: sdk-typescript/src/utils/code-keys.ts. cascade-cli holds
 * a byte-identical copy (src/lib/code-keys.ts). These vectors MUST match
 * sdk-typescript/tests/code-keys.test.ts; if they drift, the reconciler matcher
 * and the conversation grounder classify codes differently.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyCodeSystem,
  extractCodeValue,
  medicationCodeKeys,
  sharedMedicationCodeKey,
} from '../src/lib/code-keys.js';

const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm/29046';
const SCT = 'http://snomed.info/sct/271649006';
const NDC = 'http://hl7.org/fhir/sid/ndc/0071-0155';
const ATC = 'http://www.whocc.no/atc/C09AA03';
const LOINC = 'http://loinc.org/rdf#4548-4';

describe('classifyCodeSystem (parity with sdk-typescript)', () => {
  it('identifies systems by URI root and OID', () => {
    expect(classifyCodeSystem(RX)).toBe('rxnorm');
    expect(classifyCodeSystem(SCT)).toBe('snomed');
    expect(classifyCodeSystem(NDC)).toBe('ndc');
    expect(classifyCodeSystem(ATC)).toBe('atc');
    expect(classifyCodeSystem(LOINC)).toBe('loinc');
    expect(classifyCodeSystem('urn:oid:2.16.840.1.113883.6.69')).toBe('ndc');
    expect(classifyCodeSystem('http://example.org/x/1')).toBeUndefined();
  });
});

describe('extractCodeValue (parity with sdk-typescript)', () => {
  it('returns the bare code', () => {
    expect(extractCodeValue(RX)).toBe('29046');
    expect(extractCodeValue(LOINC)).toBe('4548-4');
  });
});

describe('medication code ladder (parity with sdk-typescript)', () => {
  it('ranks drug codes by tier and ignores non-drug systems', () => {
    const keys = medicationCodeKeys([ATC, LOINC, SCT, RX, NDC], 'lisinopril');
    expect(keys.map((k) => k.system)).toEqual(['rxnorm', 'snomed', 'ndc', 'atc', 'name']);
  });

  it('shares an NDC-only and a SNOMED-only key', () => {
    expect(sharedMedicationCodeKey(medicationCodeKeys([NDC]), medicationCodeKeys([NDC]))?.system).toBe('ndc');
    expect(sharedMedicationCodeKey(medicationCodeKeys([SCT]), medicationCodeKeys([SCT]))?.system).toBe('snomed');
  });
});
