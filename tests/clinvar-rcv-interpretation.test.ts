/**
 * Tests for the RCVAccession → VariantInterpretation builder (TASK-2A.3).
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

const G = 'https://ns.cascadeprotocol.org/genomics/v1#';

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

function predicateValues(quads: any[], iri: string, predIri: string): string[] {
  return quads
    .filter((q) => q.subject.value === iri && q.predicate.value === predIri)
    .map((q) => q.object.value);
}

describe('RCVAccession → VariantInterpretation (TASK-2A.3)', () => {
  it('BRCA1 VCV produces 14 VariantInterpretation records (12 RCVs + 2 multi-condition expansion)', async () => {
    // BRCA1 has 12 <RCVAccession> entries. 11 of them carry one
    // ClassifiedCondition; 1 of them (RCV005003390 "multiple
    // conditions") carries 3 ClassifiedConditions. Per D-Q5 the
    // multi-condition RCV expands to 3 Interpretations.
    // Total: 11 + 3 = 14.
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const interps = result.records.filter((r) => r.cascadeType === 'genomics:VariantInterpretation');
    expect(interps.length).toBe(14);
  });

  it('every Interpretation has exactly one variantInterpreted and exactly one condition (D-Q5)', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const interps = result.records.filter((r) => r.cascadeType === 'genomics:VariantInterpretation');
    for (const interp of interps) {
      const variants = predicateValues(result.quads, interp.iri, G + 'variantInterpreted');
      const conditions = predicateValues(result.quads, interp.iri, G + 'condition');
      expect(variants.length, `${interp.iri} → variantInterpreted`).toBe(1);
      expect(conditions.length, `${interp.iri} → condition`).toBe(1);
    }
  });

  it('Interpretations link back to the single Variant emitted from the VCV', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const variant = result.records.find((r) => r.cascadeType === 'genomics:Variant');
    expect(variant).toBeDefined();
    const interps = result.records.filter((r) => r.cascadeType === 'genomics:VariantInterpretation');
    for (const interp of interps) {
      const linked = predicateValues(result.quads, interp.iri, G + 'variantInterpreted')[0];
      expect(linked).toBe(variant!.iri);
    }
  });

  it('every Pathogenic interpretation references a ClinicalGrade variant (D-QUALITY-TIER)', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const variant = result.records.find((r) => r.cascadeType === 'genomics:Variant')!;
    const tiers = predicateValues(result.quads, variant.iri, G + 'dataQualityTier');
    expect(tiers).toEqual([G + 'ClinicalGrade']);

    const interps = result.records.filter((r) => r.cascadeType === 'genomics:VariantInterpretation');
    const pathogenic = interps.filter((i) =>
      predicateValues(result.quads, i.iri, G + 'acmgClassification').includes(G + 'Pathogenic'),
    );
    expect(pathogenic.length).toBeGreaterThan(0);
    for (const p of pathogenic) {
      const linked = predicateValues(result.quads, p.iri, G + 'variantInterpreted')[0];
      expect(linked).toBe(variant.iri);
    }
  });

  it('emits genomics:reviewStatus drawn from the 7-tier enum', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const interps = result.records.filter((r) => r.cascadeType === 'genomics:VariantInterpretation');
    const reviewStatuses = new Set<string>();
    for (const interp of interps) {
      for (const v of predicateValues(result.quads, interp.iri, G + 'reviewStatus')) {
        reviewStatuses.add(v);
      }
    }
    // BRCA1 has at least 'reviewed by expert panel' (ExpertPanelReviewed)
    expect(reviewStatuses.has(G + 'ExpertPanelReviewed')).toBe(true);
    // And 'criteria provided, multiple submitters, no conflicts'
    expect(reviewStatuses.has(G + 'MultipleSubmittersNoConflict')).toBe(true);
    // All emitted review-status IRIs must be from the published enum.
    const validEnum = new Set([
      G + 'NoAssertionProvided',
      G + 'CriteriaNotProvided',
      G + 'SingleSubmitter',
      G + 'ConflictingSubmissions',
      G + 'MultipleSubmittersNoConflict',
      G + 'ExpertPanelReviewed',
      G + 'PracticeGuideline',
    ]);
    for (const v of reviewStatuses) {
      expect(validEnum.has(v), `unexpected reviewStatus IRI ${v}`).toBe(true);
    }
  });

  it('emits ACMG classification for each Interpretation', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const interps = result.records.filter((r) => r.cascadeType === 'genomics:VariantInterpretation');
    const validEnum = new Set([
      G + 'Pathogenic',
      G + 'LikelyPathogenic',
      G + 'VUS',
      G + 'LikelyBenign',
      G + 'Benign',
    ]);
    for (const interp of interps) {
      const acmg = predicateValues(result.quads, interp.iri, G + 'acmgClassification');
      expect(acmg.length).toBe(1);
      expect(validEnum.has(acmg[0])).toBe(true);
    }
  });

  it('emits genomics:clinvarRcvId on every Interpretation', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const interps = result.records.filter((r) => r.cascadeType === 'genomics:VariantInterpretation');
    for (const interp of interps) {
      const rcvIds = predicateValues(result.quads, interp.iri, G + 'clinvarRcvId');
      expect(rcvIds.length).toBe(1);
      expect(rcvIds[0]).toMatch(/^RCV\d+$/);
    }
  });

  it('multi-condition RCV expands to 3 Interpretations with distinct condition IRIs (D-Q5)', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const interps = result.records.filter((r) => r.cascadeType === 'genomics:VariantInterpretation');
    // Find the three with clinvarRcvId=RCV005003390
    const multi = interps.filter((i) =>
      predicateValues(result.quads, i.iri, G + 'clinvarRcvId').includes('RCV005003390'),
    );
    expect(multi.length).toBe(3);
    const conditions = new Set(
      multi.map((i) => predicateValues(result.quads, i.iri, G + 'condition')[0]),
    );
    expect(conditions.size).toBe(3);
  });

  it('emits MONDO IRI for known MONDO-mapped conditions', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const conditionsAll = result.quads
      .filter((q) => q.predicate.value === G + 'condition')
      .map((q) => q.object.value);
    // BRCA1 corpus: 'BRCA1-related cancer predisposition' is MONDO:0700268;
    // 'Breast-ovarian cancer, familial, susceptibility to, 1' is MONDO:0011450
    expect(
      conditionsAll.some((c) => c === 'http://purl.obolibrary.org/obo/MONDO_0700268'),
    ).toBe(true);
    expect(
      conditionsAll.some((c) => c === 'http://purl.obolibrary.org/obo/MONDO_0011450'),
    ).toBe(true);
  });

  it('emits interpretedDate when DateLastEvaluated is present', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const interps = result.records.filter((r) => r.cascadeType === 'genomics:VariantInterpretation');
    let withDate = 0;
    for (const interp of interps) {
      const dates = predicateValues(result.quads, interp.iri, G + 'interpretedDate');
      if (dates.length > 0) withDate += 1;
    }
    expect(withDate).toBeGreaterThan(0);
  });

  it('all four corpus VCVs produce at least one Interpretation each', async () => {
    const all = [
      'VCV000017661-BRCA1.input.xml',
      'VCV000055448-BRCA2-pathogenic.input.xml',
      'VCV000208804-MLH1-LynchSyndrome.input.xml',
      'VCV000007105-CFTR-deltaF508.input.xml',
    ];
    for (const name of all) {
      const xml = loadFixture(name);
      const result = await convertClinvarXml(xml, ctx);
      const interps = result.records.filter((r) => r.cascadeType === 'genomics:VariantInterpretation');
      expect(interps.length, `${name} → interpretations`).toBeGreaterThan(0);
    }
  });
});
