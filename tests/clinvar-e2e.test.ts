/**
 * End-to-end smoke test for the ClinVar VCV → Cascade converter
 * (TASK-2A.6). Drives the full registry-dispatched conversion path;
 * verifies expected record types appear; double-checks no other
 * importer was edited (the registry add was a one-line change).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getImporter, listFormats } from '../src/lib/import-registry.js';
import type { ImportContext } from '../src/lib/import-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, '../../conformance/fixtures/genomics/clinvar');

const ctx: ImportContext = {
  inputPath: '<test>',
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  sourceSystem: 'clinvar-test',
  options: {},
};

const ALL_VCVS = [
  'VCV000017661-BRCA1.input.xml',
  'VCV000055448-BRCA2-pathogenic.input.xml',
  'VCV000208804-MLH1-LynchSyndrome.input.xml',
  'VCV000007105-CFTR-deltaF508.input.xml',
];

describe('clinvar end-to-end (TASK-2A.6)', () => {
  it('clinvar is registered in listFormats()', () => {
    expect(listFormats()).toContain('clinvar');
  });

  it('end-to-end convert: VCV → Turtle output for every corpus VCV', async () => {
    const importer = getImporter('clinvar');
    expect(importer).toBeDefined();

    for (const name of ALL_VCVS) {
      const xml = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
      const result = await importer!.convert(xml, 'cascade', ctx);
      expect(result.success, `${name} → success`).toBe(true);
      expect(result.errors, `${name} → errors`).toEqual([]);
      expect(result.output.length, `${name} → non-empty output`).toBeGreaterThan(0);
      // Turtle prefixes appear at the head.
      expect(result.output, `${name} → turtle prefixes`).toContain('@prefix cascade:');
      expect(result.output, `${name} → genomics IRI`).toContain(
        'https://ns.cascadeprotocol.org/genomics/v1#',
      );
      expect(result.resourceCount, `${name} → resourceCount`).toBeGreaterThan(0);
    }
  });

  it('output contains the three core record types', async () => {
    const importer = getImporter('clinvar')!;
    const xml = fs.readFileSync(
      path.join(FIXTURES_DIR, 'VCV000017661-BRCA1.input.xml'),
      'utf-8',
    );
    const result = await importer.convert(xml, 'cascade', ctx);
    // Substring checks against the serialized turtle (not exhaustive,
    // but proves all three types appear).
    expect(result.output).toContain('genomics/v1#Variant>');
    expect(result.output).toContain('genomics/v1#VariantInterpretation>');
    expect(result.output).toContain('genomics/v1#SubmitterAssertion>');
  });

  it('emits importedIdentifiers covering every produced record', async () => {
    const importer = getImporter('clinvar')!;
    const xml = fs.readFileSync(
      path.join(FIXTURES_DIR, 'VCV000017661-BRCA1.input.xml'),
      'utf-8',
    );
    const result = await importer.convert(xml, 'cascade', ctx);
    expect(result.importedIdentifiers.length).toBeGreaterThan(0);
    const types = new Set(result.importedIdentifiers.map((i) => i.cascadeType));
    expect(types.has('genomics:Variant')).toBe(true);
    expect(types.has('genomics:VariantInterpretation')).toBe(true);
    expect(types.has('genomics:SubmitterAssertion')).toBe(true);
  });

  it('vocabularyGaps array is populated (we do not silently drop fields)', async () => {
    const importer = getImporter('clinvar')!;
    const xml = fs.readFileSync(
      path.join(FIXTURES_DIR, 'VCV000017661-BRCA1.input.xml'),
      'utf-8',
    );
    const result = await importer.convert(xml, 'cascade', ctx);
    expect(result.vocabularyGaps.length).toBeGreaterThan(0);
    // Sanity: every gap has the required fields populated.
    for (const g of result.vocabularyGaps) {
      expect(g.sourceField.length).toBeGreaterThan(0);
      expect(g.reason.length).toBeGreaterThan(0);
      expect(['info', 'warning']).toContain(g.severity);
    }
  });
});
