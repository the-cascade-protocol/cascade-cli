/**
 * Parity contract for the shared medication normalizer.
 *
 * The canonical definition lives in `sdk-typescript/src/utils/medication-normalize.ts`.
 * cascade-cli holds a byte-identical copy (`src/lib/medication-normalize.ts`),
 * the same arrangement used for `deterministicUuid`. These vectors MUST match
 * `sdk-typescript/tests/medication-normalize.test.ts`; if they drift, the
 * reconciler (record-vs-record) and the conversation grounder (claim-vs-record)
 * stop agreeing on identity. Any behaviour change must land in both repos with
 * both vector sets updated in the same pass.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeMedName,
  normalizeDose,
  normalizeFrequency,
  normalizeRoute,
} from '../src/lib/medication-normalize.js';

describe('normalizeMedName (parity with sdk-typescript)', () => {
  it('lowercases and trims', () => {
    expect(normalizeMedName('  Lisinopril  ')).toBe('lisinopril');
  });

  it('strips dose/unit tokens so different doses share an identity', () => {
    expect(normalizeMedName('Lisinopril 10 mg')).toBe('lisinopril');
    expect(normalizeMedName('Lisinopril 20 mg')).toBe('lisinopril');
    expect(normalizeMedName('Lisinopril 10 mg')).toBe(normalizeMedName('Lisinopril 20 mg'));
  });

  it('strips a variety of unit tokens', () => {
    expect(normalizeMedName('Albuterol 90 mcg')).toBe('albuterol');
    expect(normalizeMedName('Insulin 100 units')).toBe('insulin');
    expect(normalizeMedName('Potassium 40 meq')).toBe('potassium');
    expect(normalizeMedName('Vitamin D 1000 iu')).toBe('vitamin d');
  });

  it('preserves a trailing "%" token (verbatim CLI quirk)', () => {
    // The regex ends each unit alternative with `\b`; after a non-word "%" there
    // is no word boundary, so "5 %" is NOT stripped. Preserved intentionally so
    // this copy stays behaviour-identical to the pre-swap reconciler.
    expect(normalizeMedName('Lidocaine 5 %')).toBe('lidocaine 5 %');
  });

  it('strips form/route tokens', () => {
    expect(normalizeMedName('Lisinopril 10 mg Oral Tablet')).toBe('lisinopril');
    expect(normalizeMedName('Metformin Extended Release')).toBe('metformin');
    expect(normalizeMedName('Diltiazem ER')).toBe('diltiazem');
  });

  it('collapses internal whitespace', () => {
    expect(normalizeMedName('Amoxicillin    Clavulanate')).toBe('amoxicillin clavulanate');
  });

  it('is idempotent', () => {
    const once = normalizeMedName('Lisinopril 10 mg Oral Tablet');
    expect(normalizeMedName(once)).toBe(once);
  });

  it('handles empty input', () => {
    expect(normalizeMedName('')).toBe('');
  });
});

describe('normalizeDose (parity with sdk-typescript)', () => {
  it('removes whitespace so spacing differences compare equal', () => {
    expect(normalizeDose('10 mg')).toBe('10mg');
    expect(normalizeDose('10mg')).toBe('10mg');
  });

  it('folds spelled-out and plural units', () => {
    expect(normalizeDose('10 milligrams')).toBe('10mg');
    expect(normalizeDose('90 micrograms')).toBe('90mcg');
    expect(normalizeDose('1 gram')).toBe('1g');
    expect(normalizeDose('10 mgs')).toBe('10mg');
  });

  it('does NOT collapse genuinely different doses', () => {
    expect(normalizeDose('10 mg')).not.toBe(normalizeDose('20 mg'));
  });
});

describe('normalizeFrequency (parity with sdk-typescript)', () => {
  it('folds frequency phrasings to abbreviations', () => {
    expect(normalizeFrequency('once daily')).toBe('qd');
    expect(normalizeFrequency('every day')).toBe('qd');
    expect(normalizeFrequency('twice daily')).toBe('bid');
    expect(normalizeFrequency('three times daily')).toBe('tid');
    expect(normalizeFrequency('four times a day')).toBe('qid');
  });
});

describe('normalizeRoute (parity with sdk-typescript)', () => {
  it('canonicalizes known synonyms and degrades to identity', () => {
    expect(normalizeRoute('PO')).toBe('oral');
    expect(normalizeRoute('Inhaled')).toBe('inhalation');
    expect(normalizeRoute('  Buccal ')).toBe('buccal');
  });
});
