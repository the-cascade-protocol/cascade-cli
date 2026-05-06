/**
 * Phenopacket end-to-end smoke test (TASK-2B.9).
 *
 * Drives the registry-dispatched `cascade convert --from phenopacket
 * --to cascade` pipeline against every fixture in the corpus. Verifies:
 *   - non-empty Cascade Turtle output for every recognized phenopacket
 *   - no `errors` reported by the importer
 *   - the BioSample non-phenopacket file is correctly NOT auto-detected
 *     as a phenopacket
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ImportContext } from '../src/lib/import-types.js';
import { phenopacketImporter } from '../src/lib/phenopacket-converter/registry-entry.js';
import { autoDetect } from '../src/lib/import-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.resolve(__dirname, '../../conformance/fixtures/genomics/phenopackets');

const ctx: ImportContext = {
  inputPath: '<test>',
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  options: {},
  sourceSystem: 'phenopacket-e2e',
};

const TRUE_PHENOPACKETS = [
  'bethlem-myopathy.input.json',
  'covid.input.json',
  'marfan.input.json',
  'retinoblastoma.input.json',
  'tpm3-myopathy.input.json',
  'v2-cohort.input.json',
  'v2-family.input.json',
  'v2-phenopacket.input.json',
];

describe('phenopacket end-to-end (TASK-2B.9)', () => {
  for (const fixture of TRUE_PHENOPACKETS) {
    it(`converts ${fixture} to non-empty Turtle with zero errors`, async () => {
      const text = fs.readFileSync(path.join(FIXTURES_DIR, fixture), 'utf-8');
      const result = await phenopacketImporter.convert(text, 'cascade', ctx);
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.output.length).toBeGreaterThan(0);
      // Every fixture must produce at least a patient profile (synthesized
      // for marfan since it has no subject).
      const patients = (result.records ?? []).filter(
        (r) => r.cascadeType === 'cascade:PatientProfile',
      );
      expect(patients.length).toBeGreaterThanOrEqual(1);
    });
  }

  it('does NOT auto-detect biosamples-SAMN05324082 (a non-phenopacket BioSample)', () => {
    const text = fs.readFileSync(
      path.join(FIXTURES_DIR, 'biosamples-SAMN05324082.input.json'),
      'utf-8',
    );
    const detected = autoDetect(text);
    expect(detected?.format).not.toBe('phenopacket');
  });

  it('retinoblastoma: produces 1 PatientProfile + 1 CNV + 1 Variant + 2 VariantInterpretation', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'retinoblastoma.input.json'), 'utf-8');
    const result = await phenopacketImporter.convert(text, 'cascade', ctx);
    const byKind = (kind: string) =>
      (result.records ?? []).filter((r) => r.cascadeType === kind).length;
    expect(byKind('cascade:PatientProfile')).toBe(1);
    expect(byKind('genomics:CopyNumberVariant')).toBe(1);
    expect(byKind('genomics:Variant')).toBe(1);
    expect(byKind('genomics:VariantInterpretation')).toBe(2);
    expect(byKind('fhir:Specimen')).toBe(1);
    expect(byKind('genomics:RawFile')).toBe(2);
  });

  it('v2-family: produces 3 PatientProfile + 1 Pedigree + 3 PedigreeMember', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'v2-family.input.json'), 'utf-8');
    const result = await phenopacketImporter.convert(text, 'cascade', ctx);
    const byKind = (kind: string) =>
      (result.records ?? []).filter((r) => r.cascadeType === kind).length;
    expect(byKind('cascade:PatientProfile')).toBe(3);
    expect(byKind('genomics:Pedigree')).toBe(1);
    expect(byKind('genomics:PedigreeMember')).toBe(3);
  });

  it('v2-cohort: produces 3 PatientProfile records', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'v2-cohort.input.json'), 'utf-8');
    const result = await phenopacketImporter.convert(text, 'cascade', ctx);
    const patients = (result.records ?? []).filter(
      (r) => r.cascadeType === 'cascade:PatientProfile',
    );
    expect(patients.length).toBe(3);
  });

  it('vocabulary gaps are surfaced (info + warning) for at least 5 fixtures', async () => {
    let fixturesWithGaps = 0;
    for (const fixture of TRUE_PHENOPACKETS) {
      const text = fs.readFileSync(path.join(FIXTURES_DIR, fixture), 'utf-8');
      const result = await phenopacketImporter.convert(text, 'cascade', ctx);
      if ((result.vocabularyGaps ?? []).length > 0) fixturesWithGaps += 1;
    }
    // Every fixture has at least one gap (taxonomy, alternateIds, etc.) —
    // this guards against a regression that silently drops gap reporting.
    expect(fixturesWithGaps).toBeGreaterThanOrEqual(5);
  });
});
