/**
 * Unit tests for the DiagnosticReport → GeneticTest parser (TASK-1.6).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertGenomicsBundle } from '../src/lib/fhir-genomics-converter/index.js';
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

function loadBundle(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8'));
}

function tripleStrings(quads: any[]): string[] {
  return quads.map((q: any) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`);
}

describe('parseDiagnosticReport', () => {
  it('cgexample DiagnosticReport yields a GeneticTest', async () => {
    const bundle = loadBundle('Bundle-bundle-cgexample.input.json');
    const result = await convertGenomicsBundle(bundle, baseCtx);

    const tests = result.records.filter((r) => r.cascadeType === 'genomics:GeneticTest');
    expect(tests.length).toBe(1);
    const triples = tripleStrings(tests[0].quads);

    // rdf:type genomics:GeneticTest
    expect(triples.some((t) => t.includes('22-rdf-syntax-ns#type') && t.includes('GeneticTest'))).toBe(true);

    // testType (defaulted from LOINC 51969-4 → GenePanelTest)
    expect(triples.some((t) => t.includes('genomics/v1#testType') && t.includes('GenePanelTest'))).toBe(true);

    // testDate from effectiveDateTime '2016' → '2016' (xsd:date)
    expect(triples.some((t) => t.includes('genomics/v1#testDate'))).toBe(true);

    // performingLab from performer[0] (Organization/ExampleLab reference)
    expect(triples.some((t) => t.includes('genomics/v1#performingLab'))).toBe(true);
  });

  it('cgexample GeneticTest links to the Variants present in result[] via variantsObserved', async () => {
    const bundle = loadBundle('Bundle-bundle-cgexample.input.json');
    const result = await convertGenomicsBundle(bundle, baseCtx);

    const test = result.records.find((r) => r.cascadeType === 'genomics:GeneticTest');
    expect(test).toBeTruthy();
    if (!test) throw new Error();

    const variantsObservedRefs = test.quads
      .filter((q: any) => q.predicate.value.endsWith('variantsObserved'))
      .map((q: any) => q.object.value);

    // The cgexample DR.result[] lists 8 Observations. 2 of them are top-level
    // variants (discrete-variant + complex-variant); the other 2 sub-component
    // Variants (complex-component-D / -E) are linked via complex-variant's
    // hasMember and not directly in result[]. So variantsObserved is 2.
    expect(variantsObservedRefs.length).toBe(2);

    const discreteVariant = result.records.find(
      (r) => r.cascadeType === 'genomics:Variant' && r.sourceId === 'discrete-variant',
    );
    const complexVariant = result.records.find(
      (r) => r.cascadeType === 'genomics:Variant' && r.sourceId === 'complex-variant',
    );
    expect(discreteVariant).toBeTruthy();
    expect(complexVariant).toBeTruthy();
    if (discreteVariant) expect(variantsObservedRefs).toContain(discreteVariant.iri);
    if (complexVariant) expect(variantsObservedRefs).toContain(complexVariant.iri);

    // All 4 Variants are still emitted as records (the sub-components live
    // independently in the graph).
    expect(result.records.filter((r) => r.cascadeType === 'genomics:Variant').length).toBe(4);
  });

  it('emits info-severity gap for missing genePanel extension', async () => {
    const bundle = loadBundle('Bundle-bundle-cgexample.input.json');
    const result = await convertGenomicsBundle(bundle, baseCtx);
    const genePanelGap = result.vocabularyGaps.find(
      (g) => g.sourceField.includes('genePanel') && g.severity === 'info',
    );
    expect(genePanelGap).toBeTruthy();
  });
});
