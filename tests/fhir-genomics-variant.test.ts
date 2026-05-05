/**
 * Unit tests for the Variant Observation parser (TASK-1.2).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseVariantObservation } from '../src/lib/fhir-genomics-converter/observation-variant.js';
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

function findResource(bundle: any, predicate: (r: any) => boolean): any {
  return bundle.entry.map((e: any) => e.resource).find(predicate);
}

function quadStrings(quads: any[]): string[] {
  return quads.map(
    (q: any) =>
      `${q.subject.value} ${q.predicate.value} ${q.object.value}`,
  );
}

describe('parseVariantObservation', () => {
  it('emits a Variant record from the cgexample discrete-variant Observation', () => {
    const bundle = loadBundle('Bundle-bundle-cgexample.input.json');
    const obs = findResource(bundle, (r: any) => r.id === 'discrete-variant');
    expect(obs).toBeTruthy();

    const out = parseVariantObservation(obs, baseCtx);
    expect(out).not.toBeNull();
    if (!out) throw new Error('no output');

    const triples = quadStrings(out.record.quads);

    // rdf:type genomics:Variant
    expect(triples).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/.* http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#type https:\/\/ns\.cascadeprotocol\.org\/genomics\/v1#Variant$/),
      ]),
    );

    // gene symbol
    expect(triples).toEqual(
      expect.arrayContaining([
        expect.stringContaining('genomics/v1#geneSymbol ACAD9'),
      ]),
    );
    // hgnc id
    expect(triples).toEqual(
      expect.arrayContaining([
        expect.stringContaining('genomics/v1#hgncId HGNC:21497'),
      ]),
    );

    // hgvsCDot, hgvsPDot, hgvsGDot all present
    expect(triples.some((t) => t.includes('hgvsCDot') && t.includes('NM_014049.4:c.1249C>T'))).toBe(true);
    expect(triples.some((t) => t.includes('hgvsPDot') && t.includes('NP_000050'))).toBe(false); // not this variant
    expect(triples.some((t) => t.includes('hgvsGDot') && t.includes('NC_000003.11:g.128625063C>T'))).toBe(true);

    // zygosity → Heterozygous (LA6706-1)
    expect(triples).toEqual(
      expect.arrayContaining([
        expect.stringContaining('genomics/v1#zygosity https://ns.cascadeprotocol.org/genomics/v1#Heterozygous'),
      ]),
    );

    // ClinVar ID 30880
    expect(triples).toEqual(
      expect.arrayContaining([
        expect.stringContaining('clinvarVariationId 30880'),
      ]),
    );

    // dbSNP rs368949613
    expect(triples).toEqual(
      expect.arrayContaining([
        expect.stringContaining('dbsnpRsId rs368949613'),
      ]),
    );

    // D-QUALITY-TIER: every Variant carries dataQualityTier
    expect(triples).toEqual(
      expect.arrayContaining([
        expect.stringContaining('genomics/v1#dataQualityTier https://ns.cascadeprotocol.org/genomics/v1#ClinicalGrade'),
      ]),
    );
  });

  it('returns null for non-Observation input', () => {
    expect(parseVariantObservation({ resourceType: 'Patient' }, baseCtx)).toBeNull();
    expect(parseVariantObservation(null, baseCtx)).toBeNull();
  });

  it('emits info-severity gap when gene component is missing', () => {
    const obs = {
      resourceType: 'Observation',
      id: 'noGene',
      meta: { profile: ['http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/variant'] },
      component: [
        {
          code: { coding: [{ system: 'http://loinc.org', code: '48004-6' }] },
          valueCodeableConcept: { coding: [{ system: 'http://varnomen.hgvs.org', code: 'NM_X:c.1A>T' }] },
        },
      ],
    };
    const out = parseVariantObservation(obs, baseCtx);
    expect(out).not.toBeNull();
    if (!out) throw new Error('no output');
    expect(out.gaps.find((g) => g.sourceField.includes('48018-6'))).toBeTruthy();
  });

  it('cgexample bundle yields 4 Variant records via convertGenomicsBundle', async () => {
    const bundle = loadBundle('Bundle-bundle-cgexample.input.json');
    const result = await convertGenomicsBundle(bundle, baseCtx);
    const variantRecords = result.records.filter((r) => r.cascadeType === 'genomics:Variant');
    expect(variantRecords.length).toBe(4);
    // Every Variant carries dataQualityTier (D-QUALITY-TIER).
    for (const v of variantRecords) {
      const triples = quadStrings(v.quads);
      expect(triples.some((t) => t.includes('dataQualityTier'))).toBe(true);
    }
    // At least 3 of the 4 carry an HGVS string (the 'complex-variant' parent
    // resource just chains via hasMember and has no HGVS components itself).
    const withHgvs = variantRecords.filter((v) => {
      const triples = quadStrings(v.quads);
      return triples.some(
        (t) => t.includes('hgvsCDot') || t.includes('hgvsGDot') || t.includes('hgvsPDot'),
      );
    });
    expect(withHgvs.length).toBeGreaterThanOrEqual(3);
  });

  it('compound-het bundle yields exactly 2 Variant records', async () => {
    const bundle = loadBundle('Bundle-bundle-compound-heterozygote.input.json');
    const result = await convertGenomicsBundle(bundle, baseCtx);
    const variantRecords = result.records.filter((r) => r.cascadeType === 'genomics:Variant');
    expect(variantRecords.length).toBe(2);
    // each has hgvsCDot from the bundle
    const allTriples = variantRecords.flatMap((v) => quadStrings(v.quads));
    expect(allTriples.some((t) => t.includes('NM_022787.3:c.769G>A'))).toBe(true);
    expect(allTriples.some((t) => t.includes('NM_022787.3:c.53A>G'))).toBe(true);
    // Each is Heterozygous
    expect(allTriples.filter((t) => t.includes('zygosity') && t.includes('Heterozygous')).length).toBe(2);
  });

  it('cgexample bundle gathers vocabulary gaps for unmapped components', async () => {
    const bundle = loadBundle('Bundle-bundle-cgexample.input.json');
    const result = await convertGenomicsBundle(bundle, baseCtx);
    expect(result.vocabularyGaps.length).toBeGreaterThan(0);
    // Some gaps should reference unmapped LOINC component codes
    const gapFields = result.vocabularyGaps.map((g) => g.sourceField);
    expect(gapFields.some((f) => f.includes('component['))).toBe(true);
  });
});
