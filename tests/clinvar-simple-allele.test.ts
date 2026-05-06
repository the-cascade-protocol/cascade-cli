/**
 * Tests for the SimpleAllele → Variant builder (TASK-2A.2).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertClinvarXml } from '../src/lib/clinvar-converter/index.js';
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

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

function predicateValues(quads: any[], iri: string, predIri: string): string[] {
  return quads
    .filter((q) => q.subject.value === iri && q.predicate.value === predIri)
    .map((q) => q.object.value);
}

describe('SimpleAllele → Variant (TASK-2A.2)', () => {
  it('produces exactly one Variant per VCV across the corpus', async () => {
    for (const name of ALL_VCVS) {
      const xml = loadFixture(name);
      const result = await convertClinvarXml(xml, ctx);
      const variants = result.records.filter((r) => r.cascadeType === 'genomics:Variant');
      expect(variants.length, `${name} → variants`).toBe(1);
    }
  });

  it('BRCA1 c.181T>G yields a Variant with all four expected stable identifiers', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const variant = result.records.find((r) => r.cascadeType === 'genomics:Variant');
    expect(variant).toBeDefined();

    const G = 'https://ns.cascadeprotocol.org/genomics/v1#';
    const iri = variant!.iri;
    const quads = result.quads;

    expect(predicateValues(quads, iri, G + 'clinvarVariationId')).toEqual(['17661']);
    expect(predicateValues(quads, iri, G + 'caId')).toEqual(['CA001182']);
    expect(predicateValues(quads, iri, G + 'dbsnpRsId')).toEqual(['rs28897672']);

    // SPDI preserved as vrsObject (D-Q6 — never compute)
    const vrsObjects = predicateValues(quads, iri, G + 'vrsObject');
    expect(vrsObjects).toHaveLength(1);
    expect(vrsObjects[0]).toContain('NC_000017.11:43106486:A:C');

    // HGVS strings
    expect(predicateValues(quads, iri, G + 'hgvsCDot')).toContain(
      'NM_007294.4:c.181T>G',
    );
    expect(predicateValues(quads, iri, G + 'geneSymbol')).toEqual(['BRCA1']);
    expect(predicateValues(quads, iri, G + 'hgncId')).toEqual(['HGNC:1100']);
  });

  it('Variant carries dataQualityTier = ClinicalGrade (D-QUALITY-TIER)', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const variant = result.records.find((r) => r.cascadeType === 'genomics:Variant');
    expect(variant).toBeDefined();

    const G = 'https://ns.cascadeprotocol.org/genomics/v1#';
    const tiers = predicateValues(result.quads, variant!.iri, G + 'dataQualityTier');
    expect(tiers).toEqual([G + 'ClinicalGrade']);
  });

  it('emits SO consequenceTerm when MolecularConsequence is present', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const variant = result.records.find((r) => r.cascadeType === 'genomics:Variant');
    const G = 'https://ns.cascadeprotocol.org/genomics/v1#';
    const terms = predicateValues(result.quads, variant!.iri, G + 'consequenceTerm');
    // SO:0001583 (missense variant) — expect at least one
    expect(terms.some((t) => t.endsWith('SO_0001583'))).toBe(true);
  });

  it('preserves CanonicalSPDI as vrsObject (D-Q6, never compute)', async () => {
    for (const name of ALL_VCVS) {
      const xml = loadFixture(name);
      const result = await convertClinvarXml(xml, ctx);
      const variant = result.records.find((r) => r.cascadeType === 'genomics:Variant');
      expect(variant).toBeDefined();
      const G = 'https://ns.cascadeprotocol.org/genomics/v1#';
      const vrsObjects = predicateValues(result.quads, variant!.iri, G + 'vrsObject');
      // All four corpus VCVs include CanonicalSPDI
      expect(vrsObjects.length, `${name} → vrsObject`).toBe(1);
      // Should NOT compute a vrsId — D-Q6 preservation only.
      const vrsIds = predicateValues(result.quads, variant!.iri, G + 'vrsId');
      expect(vrsIds.length, `${name} → vrsId (must not be computed)`).toBe(0);
    }
  });

  it('every emitted Variant has a stable identifier (VariantShape sh:or constraint)', async () => {
    for (const name of ALL_VCVS) {
      const xml = loadFixture(name);
      const result = await convertClinvarXml(xml, ctx);
      const variant = result.records.find((r) => r.cascadeType === 'genomics:Variant');
      expect(variant).toBeDefined();
      const G = 'https://ns.cascadeprotocol.org/genomics/v1#';
      const stableIdPredicates = ['caId', 'vrsId', 'clinvarVariationId', 'dbsnpRsId'];
      const hasAny = stableIdPredicates.some(
        (p) => predicateValues(result.quads, variant!.iri, G + p).length > 0,
      );
      expect(hasAny, `${name} → at least one stable ID`).toBe(true);
    }
  });

  it('variant IRI is deterministic across re-imports of the same VCV', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const a = await convertClinvarXml(xml, ctx);
    const b = await convertClinvarXml(xml, ctx);
    const ai = a.records.find((r) => r.cascadeType === 'genomics:Variant')!.iri;
    const bi = b.records.find((r) => r.cascadeType === 'genomics:Variant')!.iri;
    expect(ai).toBe(bi);
  });
});
