/**
 * End-to-end integration smoke tests for the fhir-genomics importer
 * (TASK-1.8).
 *
 * Exercises the full registry-driven dispatch path: detect → convert →
 * Turtle output. Validates --from fhir-genomics over the importer registry
 * (no convert.ts edits required).
 *
 * Note: --report-gaps flag (mentioned in plan TASK-1.8 acceptance) does
 * not exist in the CLI yet. It's listed as a v1.x dev-experience feature
 * in REPORT §4.5 — surfaced in the agent report rather than blocking the
 * task here.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fhirGenomicsImporter } from '../src/lib/fhir-genomics-converter/registry-entry.js';
import {
  getImporter,
  listFormats,
  autoDetect,
} from '../src/lib/import-registry.js';
import type { ImportContext } from '../src/lib/import-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, '../../conformance/fixtures/genomics/fhir-genomics-ig');

const baseCtx: ImportContext = {
  inputPath: '<test>',
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  options: {},
};

const CORPUS = [
  'Bundle-bundle-cgexample.input.json',
  'Bundle-bundle-pgxexample.input.json',
  'Bundle-bundle-oncology-diagnostic.input.json',
  'Bundle-bundle-oncologyexamples-r4.input.json',
  'Bundle-bundle-compound-heterozygote.input.json',
  'Bundle-bundle-CG-IG-HLA-FullBundle-01.input.json',
  'Bundle-bundle-complexVariant-nonHGVS.input.json',
];

describe('fhir-genomics end-to-end (TASK-1.8)', () => {
  it('registry exposes fhir-genomics in --from list', () => {
    expect(listFormats()).toContain('fhir-genomics');
  });

  it('importer carries the expected supportedOutputs', () => {
    const imp = getImporter('fhir-genomics');
    expect(imp).toBeDefined();
    expect(imp?.supportedOutputs).toEqual(expect.arrayContaining(['turtle', 'cascade', 'jsonld']));
  });

  for (const fixture of CORPUS) {
    it(`detects + converts ${fixture}`, async () => {
      const text = fs.readFileSync(path.join(FIXTURES_DIR, fixture), 'utf-8');
      expect(fhirGenomicsImporter.detect(text)).toBe(true);
      expect(autoDetect(text)?.format).toBe('fhir-genomics');

      const result = await fhirGenomicsImporter.convert(text, 'cascade', baseCtx);
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      // Output is non-empty Turtle for any bundle that has at least one
      // Variant / Haplotype / etc. — every corpus bundle has at least one.
      expect(result.output.length).toBeGreaterThan(100);
      // Standard prefixes
      expect(result.output).toContain('@prefix cascade:');
      // At least one genomics: triple
      expect(result.output).toContain('genomics/v1#');
    });
  }

  it('cgexample end-to-end Turtle has Variant + Interpretation + GeneticTest blocks', async () => {
    const text = fs.readFileSync(
      path.join(FIXTURES_DIR, 'Bundle-bundle-cgexample.input.json'),
      'utf-8',
    );
    const result = await fhirGenomicsImporter.convert(text, 'cascade', baseCtx);
    expect(result.success).toBe(true);

    // Check for type assertions
    expect(result.output).toContain('genomics/v1#Variant>');
    expect(result.output).toContain('genomics/v1#VariantInterpretation>');
    expect(result.output).toContain('genomics/v1#GeneticTest>');
    expect(result.output).toContain('genomics/v1#GeneticTestOrder>');

    // D-QUALITY-TIER on every Variant
    expect(result.output).toContain('genomics/v1#dataQualityTier>');
    expect(result.output).toContain('genomics/v1#ClinicalGrade>');

    // Pathogenic class on the Interpretation
    expect(result.output).toContain('genomics/v1#Pathogenic>');

    // resourceCount > 0 + records list populated
    expect(result.resourceCount).toBeGreaterThan(0);
    expect(result.records?.length).toBeGreaterThan(0);

    // Vocabulary gaps surfaced (info + warning)
    expect(result.vocabularyGaps.length).toBeGreaterThan(0);
  });

  it('compound-het end-to-end emits phasedWith Trans linking the two Variants', async () => {
    const text = fs.readFileSync(
      path.join(FIXTURES_DIR, 'Bundle-bundle-compound-heterozygote.input.json'),
      'utf-8',
    );
    const result = await fhirGenomicsImporter.convert(text, 'cascade', baseCtx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('phasedWith>');
    expect(result.output).toContain('phase> <https://ns.cascadeprotocol.org/genomics/v1#Trans>');
  });

  it('jsonld serialization works', async () => {
    const text = fs.readFileSync(
      path.join(FIXTURES_DIR, 'Bundle-bundle-cgexample.input.json'),
      'utf-8',
    );
    const result = await fhirGenomicsImporter.convert(text, 'jsonld', {
      ...baseCtx,
      outputSerialization: 'jsonld',
    });
    expect(result.success).toBe(true);
    expect(() => JSON.parse(result.output)).not.toThrow();
  });
});
