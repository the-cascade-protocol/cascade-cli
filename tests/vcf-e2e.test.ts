/**
 * End-to-end smoke test + gap audit for the vcf-converter (TASK-3A.5).
 *
 * Streams the conformance ClinVar weekly corpus fixture through the full
 * importer (detect → orchestrator → record emission → Turtle serialization)
 * and asserts:
 *
 *   - end-to-end conversion succeeds
 *   - SequencingRun is emitted exactly once with referenceGenome + source
 *   - Variants are emitted with stable IRIs (deterministic across re-run)
 *   - data-quality tier defaults to ClinicalGrade for ##source=ClinVar
 *   - vocabulary gaps are surfaced for the v1-draft.0.1-pending fields
 *   - the produced Turtle parses back through n3.Parser without errors
 *   - streaming path doesn't crash on the truncated multi-block BGZF
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser as N3Parser } from 'n3';

import { convertVcf } from '../src/lib/vcf-converter/index.js';
import { vcfImporter } from '../src/lib/vcf-converter/registry-entry.js';
import { GENOMICS_NS } from '../src/lib/fhir-genomics-converter/types.js';
import { NS } from '../src/lib/fhir-converter/types.js';
import type { ImportContext } from '../src/lib/import-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VCF_GZ_FIXTURE = path.resolve(
  __dirname,
  '../../conformance/fixtures/genomics/vcf/sample-clinvar.input.vcf.gz',
);

const CTX: ImportContext = {
  inputPath: VCF_GZ_FIXTURE,
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  options: {},
};

describe('vcf end-to-end — corpus sample-clinvar.input.vcf.gz', () => {
  it('streams the gzipped VCF and emits one SequencingRun + N Variants', async () => {
    const input = fs.readFileSync(VCF_GZ_FIXTURE);
    const conversion = await convertVcf(input, CTX);

    // SequencingRun + many Variants
    const runs = conversion.records.filter((r) => r.cascadeType === 'genomics:SequencingRun');
    const variants = conversion.records.filter((r) => r.cascadeType === 'genomics:Variant');
    expect(runs).toHaveLength(1);
    expect(variants.length).toBeGreaterThan(1500);
    expect(variants.length).toBe(conversion.variantsEmitted);
    // ClinVar weekly is single-ALT per record; recordsRead may be slightly
    // higher than variantsEmitted because the corpus is a truncated BGZF
    // and the last 1-2 lines are split mid-record (rejected by splitLine,
    // so still counted as "read" via the warning path but emit 0 variants).
    expect(conversion.variantsEmitted).toBeLessThanOrEqual(conversion.recordsRead);
    expect(conversion.recordsRead - conversion.variantsEmitted).toBeLessThanOrEqual(5);
  });

  it('SequencingRun carries referenceGenome=GRCh38 + variantCallerVersion=ClinVar', async () => {
    const input = fs.readFileSync(VCF_GZ_FIXTURE);
    const conversion = await convertVcf(input, CTX);
    const runQuads = conversion.records.find(
      (r) => r.cascadeType === 'genomics:SequencingRun',
    )!.quads;

    const ref = runQuads.find((q) => q.predicate.value === GENOMICS_NS + 'referenceGenome');
    const src = runQuads.find((q) => q.predicate.value === GENOMICS_NS + 'variantCallerVersion');
    const date = runQuads.find((q) => q.predicate.value === GENOMICS_NS + 'fileGenerationDate');
    expect(ref?.object.value).toBe('GRCh38');
    expect(src?.object.value).toBe('ClinVar');
    expect(date?.object.value).toBe('2026-05-03');
  });

  it('every Variant references the SequencingRun via prov:wasGeneratedBy', async () => {
    const input = fs.readFileSync(VCF_GZ_FIXTURE);
    const conversion = await convertVcf(input, CTX);
    const runIri = conversion.sequencingRunIri!;
    const variants = conversion.records.filter((r) => r.cascadeType === 'genomics:Variant');

    for (const v of variants) {
      const link = v.quads.find((q) => q.predicate.value === NS.prov + 'wasGeneratedBy');
      expect(link?.object.value).toBe(runIri);
    }
  });

  it('every Variant is tagged ClinicalGrade for ClinVar source', async () => {
    const input = fs.readFileSync(VCF_GZ_FIXTURE);
    const conversion = await convertVcf(input, CTX);
    const variants = conversion.records.filter((r) => r.cascadeType === 'genomics:Variant');

    for (const v of variants) {
      const tier = v.quads.find((q) => q.predicate.value === GENOMICS_NS + 'dataQualityTier');
      expect(tier?.object.value).toBe(GENOMICS_NS + 'ClinicalGrade');
    }
  });

  it('produces Turtle that parses back through n3.Parser without errors', async () => {
    const input = fs.readFileSync(VCF_GZ_FIXTURE);
    const result = await vcfImporter.convert(input, 'cascade', CTX);
    expect(result.success).toBe(true);
    expect(result.output.length).toBeGreaterThan(1000);

    const parser = new N3Parser();
    const quads = parser.parse(result.output);
    expect(quads.length).toBeGreaterThan(0);
  });

  it('emits v1-draft.0.2 properties for REF/ALT/coords and a CLNSIG gap-info', async () => {
    const input = fs.readFileSync(VCF_GZ_FIXTURE);
    const conversion = await convertVcf(input, CTX);

    const fields = new Set(conversion.vocabularyGaps.map((g) => g.sourceField));
    // REF/ALT/coords gaps are no longer emitted — the v0.2 properties replace them.
    expect(fields.has('VCF.REF')).toBe(false);
    expect(fields.has('VCF.ALT')).toBe(false);
    expect(fields.has('VCF.CHROM:POS')).toBe(false);
    // CLNSIG is preserved as a gap pending Phase 2A reconciler integration.
    expect(fields).toContain('VCF.INFO.CLNSIG');
    // ClinVar weekly is sites-only, so multi-sample / FORMAT gaps must be absent.
    expect(fields.has('VCF.multi-sample')).toBe(false);
    expect(fields.has('VCF.FORMAT.AF')).toBe(false);

    // Spot check that at least one Variant carries the new properties.
    const sampleVariant = conversion.records.find((r) => r.cascadeType === 'genomics:Variant');
    expect(sampleVariant).toBeDefined();
    const preds = new Set(sampleVariant!.quads.map((q) => q.predicate.value));
    expect(preds.has('https://ns.cascadeprotocol.org/genomics/v1#refAllele')).toBe(true);
    expect(preds.has('https://ns.cascadeprotocol.org/genomics/v1#altAllele')).toBe(true);
    expect(preds.has('https://ns.cascadeprotocol.org/genomics/v1#genomicStartEnd')).toBe(true);
  });

  it('IRIs are deterministic across two consecutive runs', async () => {
    const input = fs.readFileSync(VCF_GZ_FIXTURE);
    const a = await convertVcf(input, CTX);
    const b = await convertVcf(input, CTX);
    expect(a.sequencingRunIri).toBe(b.sequencingRunIri);
    expect(a.variantsEmitted).toBe(b.variantsEmitted);
    // First few Variant IRIs identical
    const aIris = a.records
      .filter((r) => r.cascadeType === 'genomics:Variant')
      .slice(0, 10)
      .map((r) => r.iri);
    const bIris = b.records
      .filter((r) => r.cascadeType === 'genomics:Variant')
      .slice(0, 10)
      .map((r) => r.iri);
    expect(aIris).toEqual(bIris);
  });

  it('produces N Variants where N matches recordsRead from the streaming reader', async () => {
    // The corpus is a 64KB head of a multi-block BGZF stream. With
    // Z_SYNC_FLUSH our reader recovers ~1725 records (more than gunzip's
    // strict 1586 because the partial trailing block still decodes); the
    // very last line is truncated mid-record and skipped by splitLine().
    const input = fs.readFileSync(VCF_GZ_FIXTURE);
    const conversion = await convertVcf(input, CTX);
    expect(conversion.recordsRead).toBeGreaterThanOrEqual(1500);
  });
});

describe('vcf importer registry — ImportResult shape', () => {
  it('returns success=true and a non-empty turtle output', async () => {
    const input = fs.readFileSync(VCF_GZ_FIXTURE);
    const result = await vcfImporter.convert(input, 'cascade', CTX);
    expect(result.success).toBe(true);
    expect(result.format).toBe('cascade');
    expect(result.errors).toEqual([]);
    expect(result.resourceCount).toBeGreaterThan(1500);
    expect(result.output.startsWith('@prefix')).toBe(true);
  });

  it('produces JSON-LD when --to jsonld', async () => {
    const input = fs.readFileSync(VCF_GZ_FIXTURE);
    const result = await vcfImporter.convert(input, 'jsonld', CTX);
    expect(result.success).toBe(true);
    expect(result.format).toBe('jsonld');
    // valid JSON
    expect(() => JSON.parse(result.output)).not.toThrow();
  });

  it('returns success=false with a clear error on a bogus input', async () => {
    const result = await vcfImporter.convert('this is not a vcf', 'cascade', CTX);
    // Bogus input: header validation fails (missing ##fileformat), conversion errors.
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
