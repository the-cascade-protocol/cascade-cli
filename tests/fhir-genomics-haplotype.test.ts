/**
 * Unit tests for the Haplotype Observation parser (TASK-1.3).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertGenomicsBundle } from '../src/lib/fhir-genomics-converter/index.js';
import { parseHaplotypeObservation } from '../src/lib/fhir-genomics-converter/observation-haplotype.js';
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

describe('parseHaplotypeObservation', () => {
  it('HLA bundle yields Haplotype records with star-allele symbols', async () => {
    const bundle = loadBundle('Bundle-bundle-CG-IG-HLA-FullBundle-01.input.json');
    const result = await convertGenomicsBundle(bundle, baseCtx);
    const haps = result.records.filter((r) => r.cascadeType === 'genomics:Haplotype');
    // 6 haplotype Observations in the HLA full bundle
    expect(haps.length).toBe(6);

    const allTriples = haps.flatMap((h) => tripleStrings(h.quads));
    // Original bundle has these star alleles:
    expect(allTriples.some((t) => t.includes('starAlleleSymbol HLA-A*01:01:01G'))).toBe(true);
    expect(allTriples.some((t) => t.includes('starAlleleSymbol HLA-A*01:02'))).toBe(true);
    expect(allTriples.some((t) => t.includes('starAlleleSymbol HLA-B*15:01:01G'))).toBe(true);
    expect(allTriples.some((t) => t.includes('starAlleleSymbol HLA-B*57:01:01G'))).toBe(true);

    // Each Haplotype is rdf:type genomics:Haplotype
    for (const h of haps) {
      const triples = tripleStrings(h.quads);
      expect(triples.some((t) => t.includes('22-rdf-syntax-ns#type') && t.includes('Haplotype'))).toBe(true);
    }
  });

  it('cgexample bundle haplotype links via hasComponent to discrete-variant', async () => {
    const bundle = loadBundle('Bundle-bundle-cgexample.input.json');
    const result = await convertGenomicsBundle(bundle, baseCtx);
    const haps = result.records.filter((r) => r.cascadeType === 'genomics:Haplotype');
    expect(haps.length).toBe(1);

    const triples = tripleStrings(haps[0].quads);
    // *2 star-allele
    expect(triples.some((t) => t.includes('starAlleleSymbol *2'))).toBe(true);
    // hasComponent triple linking to a Variant IRI
    expect(triples.some((t) => t.includes('hasComponent'))).toBe(true);
  });

  it('HLA-DQB1 hypothetical produces expected starAlleleSymbol when present (synthetic fixture)', () => {
    // Direct unit test covering the value-extraction path with a typical HLA-DQB1 example.
    const obs = {
      resourceType: 'Observation',
      id: 'syn-dqb1',
      meta: { profile: ['http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/haplotype'] },
      valueCodeableConcept: {
        coding: [{ system: 'http://www.ebi.ac.uk/ipd/imgt/hla', code: 'HLA-DQB1*02:01' }],
      },
      component: [
        {
          code: { coding: [{ system: 'http://loinc.org', code: '48018-6' }] },
          valueCodeableConcept: {
            coding: [{ system: 'http://www.genenames.org', code: 'HGNC:4944', display: 'HLA-DQB1' }],
          },
        },
      ],
    };
    const out = parseHaplotypeObservation(obs, new Map<string, string>(), baseCtx);
    expect(out).toBeTruthy();
    if (!out) throw new Error('no output');
    const triples = tripleStrings(out.record.quads);
    expect(triples.some((t) => t.includes('starAlleleSymbol HLA-DQB1*02:01'))).toBe(true);
    expect(triples.some((t) => t.includes('geneSymbol HLA-DQB1'))).toBe(true);
  });
});
