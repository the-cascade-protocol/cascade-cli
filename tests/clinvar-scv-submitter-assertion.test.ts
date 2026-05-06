/**
 * Tests for the ClinicalAssertion → SubmitterAssertion builder (TASK-2A.4).
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

describe('ClinicalAssertion → SubmitterAssertion (TASK-2A.4)', () => {
  // Count expectations: ClinVar VCVs aggregate one ClinicalAssertion per
  // submitter, but a few carry non-canonical classification strings
  // (NoClassification=evidence_only, "not provided", "Pathogenic, low
  // penetrance", drug-response) that would violate SubmitterAssertionShape.
  // We skip those records and surface gap-warnings — better than emitting
  // a partial assertion that fails SHACL.

  it('BRCA1 VCV produces 69 SHACL-conformant SubmitterAssertion records (out of 72 source SCVs; 3 skipped due to non-canonical classification text)', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const sas = result.records.filter((r) => r.cascadeType === 'genomics:SubmitterAssertion');
    expect(sas.length).toBe(69);
  });

  it('BRCA2 VCV produces 6 SHACL-conformant SubmitterAssertion records (1 skipped — NoClassification=evidence_only)', async () => {
    const xml = loadFixture('VCV000055448-BRCA2-pathogenic.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const sas = result.records.filter((r) => r.cascadeType === 'genomics:SubmitterAssertion');
    expect(sas.length).toBe(6);
  });

  it('CFTR VCV produces SHACL-conformant SubmitterAssertion records (close to 99 source SCVs; some skipped for drug-response classifications)', async () => {
    const xml = loadFixture('VCV000007105-CFTR-deltaF508.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const sas = result.records.filter((r) => r.cascadeType === 'genomics:SubmitterAssertion');
    expect(sas.length).toBeGreaterThan(50); // most submitters use canonical ACMG
    expect(sas.length).toBeLessThanOrEqual(99); // never more than the source
  });

  it('MLH1/VMA21 VCV produces 1 SubmitterAssertion', async () => {
    const xml = loadFixture('VCV000208804-MLH1-LynchSyndrome.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const sas = result.records.filter((r) => r.cascadeType === 'genomics:SubmitterAssertion');
    expect(sas.length).toBe(1);
  });

  it('every SubmitterAssertion carries scvAccession + submitter + assertedClassification', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const sas = result.records.filter((r) => r.cascadeType === 'genomics:SubmitterAssertion');
    const validAcmg = new Set([
      G + 'Pathogenic',
      G + 'LikelyPathogenic',
      G + 'VUS',
      G + 'LikelyBenign',
      G + 'Benign',
    ]);
    let withScv = 0;
    let withSubmitter = 0;
    let withAcmg = 0;
    for (const sa of sas) {
      const scvs = predicateValues(result.quads, sa.iri, G + 'scvAccession');
      if (scvs.length === 1 && /^SCV\d+$/.test(scvs[0])) withScv += 1;
      const submitters = predicateValues(result.quads, sa.iri, G + 'submitter');
      if (submitters.length === 1 && submitters[0].length > 0) withSubmitter += 1;
      const acmg = predicateValues(result.quads, sa.iri, G + 'assertedClassification');
      if (acmg.length === 1 && validAcmg.has(acmg[0])) withAcmg += 1;
    }
    expect(withScv).toBe(69);
    expect(withSubmitter).toBe(69);
    // Every emitted SubmitterAssertion has a valid 5-tier ACMG class
    // (records with non-canonical text are skipped earlier).
    expect(withAcmg).toBe(69);
  });

  it('SCV accessions are distinct across all records', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const sas = result.records.filter((r) => r.cascadeType === 'genomics:SubmitterAssertion');
    const scvs = new Set<string>();
    for (const sa of sas) {
      const v = predicateValues(result.quads, sa.iri, G + 'scvAccession')[0];
      scvs.add(v);
    }
    expect(scvs.size).toBe(69);
  });

  it('emits aggregatedFrom triples on Interpretations to link the matching SCVs', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const interps = result.records.filter((r) => r.cascadeType === 'genomics:VariantInterpretation');
    let totalLinks = 0;
    for (const interp of interps) {
      const links = predicateValues(result.quads, interp.iri, G + 'aggregatedFrom');
      totalLinks += links.length;
    }
    // Most assertions resolve to at least one Interpretation via the
    // TraitMapping table; expect a comfortable majority of the 72.
    expect(totalLinks).toBeGreaterThan(50);
  });

  it('identifies submitter category from OrganizationCategory', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const sas = result.records.filter((r) => r.cascadeType === 'genomics:SubmitterAssertion');
    const categories = new Set<string>();
    for (const sa of sas) {
      for (const v of predicateValues(result.quads, sa.iri, G + 'submitterCategory')) {
        categories.add(v);
      }
    }
    // BRCA1 submitters span laboratory, consortium, expert-panel
    expect(categories.has(G + 'SubmitterLaboratory') || categories.has(G + 'SubmitterConsortium')).toBe(true);
  });

  it('emits contributesToAggregate boolean for each ClinicalAssertion', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const result = await convertClinvarXml(xml, ctx);
    const sas = result.records.filter((r) => r.cascadeType === 'genomics:SubmitterAssertion');
    let count = 0;
    for (const sa of sas) {
      const v = predicateValues(result.quads, sa.iri, G + 'contributesToAggregate');
      if (v.length === 1) count += 1;
    }
    // Every emitted BRCA1 SubmitterAssertion carries the attribute.
    expect(count).toBe(69);
  });
});
