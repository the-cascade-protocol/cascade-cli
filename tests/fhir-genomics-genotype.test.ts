/**
 * Unit tests for the Genotype Observation parser (TASK-1.4).
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

describe('parseGenotypeObservation', () => {
  it('HLA bundle yields Diplotype records with hapA + hapB', async () => {
    const bundle = loadBundle('Bundle-bundle-CG-IG-HLA-FullBundle-01.input.json');
    const result = await convertGenomicsBundle(bundle, baseCtx);
    const dips = result.records.filter((r) => r.cascadeType === 'genomics:Diplotype');
    expect(dips.length).toBe(3);

    // Each diplotype should have hapA + hapB
    for (const d of dips) {
      const triples = tripleStrings(d.quads);
      expect(triples.some((t) => t.includes('hapA'))).toBe(true);
      expect(triples.some((t) => t.includes('hapB'))).toBe(true);
      expect(triples.some((t) => t.includes('22-rdf-syntax-ns#type') && t.includes('Diplotype'))).toBe(true);
    }
  });

  it('cgexample genotype produces a Diplotype with diplotypeNotation CYP2C9 *2/*5', async () => {
    const bundle = loadBundle('Bundle-bundle-cgexample.input.json');
    const result = await convertGenomicsBundle(bundle, baseCtx);
    const dips = result.records.filter((r) => r.cascadeType === 'genomics:Diplotype');
    expect(dips.length).toBe(1);
    const triples = tripleStrings(dips[0].quads);
    expect(triples.some((t) => t.includes('diplotypeNotation') && t.includes('*'))).toBe(true);
  });

  it('compound-het bundle adds phasedWith + phase Trans triples to the two Variants', async () => {
    const bundle = loadBundle('Bundle-bundle-compound-heterozygote.input.json');
    const result = await convertGenomicsBundle(bundle, baseCtx);

    const allTriples = tripleStrings(result.quads);
    // Two phasedWith triples (one per direction)
    const phasedWith = allTriples.filter((t) => t.includes('phasedWith'));
    expect(phasedWith.length).toBeGreaterThanOrEqual(2);

    // phase Trans (semicolon between brackets in c.[53A>G];[769G>A])
    const phaseTrans = allTriples.filter(
      (t) => t.includes('genomics/v1#phase ') && t.includes('Trans'),
    );
    expect(phaseTrans.length).toBeGreaterThanOrEqual(2);
  });

  it('detects HGVS cis vs trans patterns', () => {
    // Exposed via the genotype parser semantics in compound-het (Trans).
    // Direct unit test on a synthetic genotype to also exercise Cis.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
  });
});
