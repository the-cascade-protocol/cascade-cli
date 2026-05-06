/**
 * Tests for phenopacket variationDescriptor → genomics:Variant /
 * CopyNumberVariant / Haplotype (TASK-2B.5).
 *
 * Covers:
 *   - allele path (HGVS expressions, geneContext, allelicState/zygosity)
 *   - CNV path (interval start/end/ref + integer copy number + mosaicism)
 *   - VRS preservation (D-Q6 — preserve only, never compute)
 *   - extension parsing (mosaicism, allele-frequency)
 *   - vcfRecord fallback when expressions[] is absent
 *   - default ResearchGrade quality tier (D-QUALITY-TIER)
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ImportContext } from '../src/lib/import-types.js';
import { parseVariationDescriptor } from '../src/lib/phenopacket-converter/variation-descriptor.js';
import { convertPhenopacket } from '../src/lib/phenopacket-converter/index.js';
import { GENOMICS_NS } from '../src/lib/phenopacket-converter/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.resolve(__dirname, '../../conformance/fixtures/genomics/phenopackets');

const ctx: ImportContext = {
  inputPath: '<test>',
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  options: {},
  sourceSystem: 'phenopacket-test',
};

function objectsForPredicate(quads: any[], pred: string): string[] {
  return quads.filter((q) => q.predicate.value === pred).map((q) => q.object.value);
}

function findQuad(quads: any[], pred: string): string | undefined {
  return quads.find((q) => q.predicate.value === pred)?.object.value;
}

describe('parseVariationDescriptor — allele path', () => {
  it('emits genomics:Variant + HGVS expressions + geneContext + zygosity', () => {
    const out = parseVariationDescriptor(
      {
        id: 'rs121913300',
        moleculeContext: 'genomic',
        variation: { allele: { sequenceLocation: { sequenceId: 'NC_000013.11' } } },
        geneContext: { valueId: 'HGNC:9884', symbol: 'RB1' },
        expressions: [
          { syntax: 'hgvs.c', value: 'NM_000321.2:c.958C>T' },
          { syntax: 'transcript_reference', value: 'NM_000321.2' },
        ],
        allelicState: { id: 'GENO:0000135', label: 'heterozygous' },
        extensions: [{ name: 'allele-frequency', value: '25.0%' }],
      },
      ctx,
      'test',
    );
    expect(out).not.toBeNull();
    expect(out!.record.cascadeType).toBe('genomics:Variant');
    expect(findQuad(out!.record.quads, GENOMICS_NS + 'geneSymbol')).toBe('RB1');
    expect(findQuad(out!.record.quads, GENOMICS_NS + 'hgncId')).toBe('HGNC:9884');
    expect(findQuad(out!.record.quads, GENOMICS_NS + 'hgvsCDot')).toBe('NM_000321.2:c.958C>T');
    expect(findQuad(out!.record.quads, GENOMICS_NS + 'transcriptRef')).toBe('NM_000321.2');
    expect(findQuad(out!.record.quads, GENOMICS_NS + 'zygosity')).toBe(GENOMICS_NS + 'Heterozygous');
    // 25.0% → 0.25 fraction
    const vaf = findQuad(out!.record.quads, GENOMICS_NS + 'mosaicismFraction');
    expect(parseFloat(vaf!)).toBeCloseTo(0.25);
  });

  it('falls back to vcfRecord-derived hgvsGDot when expressions[] absent', () => {
    const out = parseVariationDescriptor(
      {
        id: 'v1',
        vcfRecord: {
          genomeAssembly: 'GRCh38',
          chrom: 'NC_000013.11',
          pos: '48367512',
          ref: 'C',
          alt: 'T',
        },
      },
      ctx,
      'test',
    );
    expect(out).not.toBeNull();
    expect(findQuad(out!.record.quads, GENOMICS_NS + 'genomeAssembly')).toBe('GRCh38');
    expect(findQuad(out!.record.quads, GENOMICS_NS + 'hgvsGDot')).toBe('NC_000013.11:g.48367512C>T');
    // Vocabulary-evolution gap should be emitted
    expect(out!.gaps.some((g) => g.sourceField.endsWith('vcfRecord'))).toBe(true);
  });

  it('emits ResearchGrade quality tier by default (D-QUALITY-TIER)', () => {
    const out = parseVariationDescriptor(
      { id: 'v1', expressions: [{ syntax: 'hgvs.c', value: 'x' }] },
      ctx,
      'test',
    );
    expect(findQuad(out!.record.quads, GENOMICS_NS + 'dataQualityTier')).toBe(
      GENOMICS_NS + 'ResearchGrade',
    );
  });

  it('preserves VRS id + object when present (D-Q6)', () => {
    const out = parseVariationDescriptor(
      {
        id: 'v1',
        variation: {
          allele: {
            _id: 'ga4gh:VA.abcdef123',
            location: { sequenceId: 'NC_000017.11' },
          },
        },
        expressions: [{ syntax: 'hgvs.c', value: 'x' }],
      },
      ctx,
      'test',
    );
    expect(findQuad(out!.record.quads, GENOMICS_NS + 'vrsId')).toBe('ga4gh:VA.abcdef123');
    const vrsObj = findQuad(out!.record.quads, GENOMICS_NS + 'vrsObject');
    expect(vrsObj).toBeDefined();
    expect(vrsObj).toContain('ga4gh:VA.abcdef123');
  });
});

describe('parseVariationDescriptor — CNV path', () => {
  it('emits CopyNumberVariant + integer copies + interval coords + mosaicism', () => {
    const out = parseVariationDescriptor(
      {
        id: 'cnv-1',
        variation: {
          copyNumber: {
            derivedSequenceExpression: {
              location: {
                sequenceId: 'refseq:NC_000013.14',
                sequenceInterval: {
                  startNumber: { value: '25981249' },
                  endNumber: { value: '61706822' },
                },
              },
            },
            number: { value: '1' },
          },
        },
        extensions: [{ name: 'mosaicism', value: '40.0%' }],
      },
      ctx,
      'test',
    );
    expect(out).not.toBeNull();
    expect(out!.record.cascadeType).toBe('genomics:CopyNumberVariant');
    expect(findQuad(out!.record.quads, GENOMICS_NS + 'copyNumber')).toBe('1');
    expect(findQuad(out!.record.quads, GENOMICS_NS + 'cnvIntervalRef')).toBe('refseq:NC_000013.14');
    expect(findQuad(out!.record.quads, GENOMICS_NS + 'cnvIntervalStart')).toBe('25981249');
    expect(findQuad(out!.record.quads, GENOMICS_NS + 'cnvIntervalEnd')).toBe('61706822');
    const mos = findQuad(out!.record.quads, GENOMICS_NS + 'mosaicismFraction');
    expect(parseFloat(mos!)).toBeCloseTo(0.4);
  });
});

describe('parseVariationDescriptor — empty / unknown', () => {
  it('returns null for an undefined descriptor', () => {
    expect(parseVariationDescriptor(undefined, ctx, 'test')).toBeNull();
  });

  it('returns null for a descriptor with no recognizable shape, with warning gap', () => {
    const out = parseVariationDescriptor({ id: 'x' }, ctx, 'test');
    expect(out).toBeNull();
  });
});

describe('convertPhenopacket — variation acceptance (retinoblastoma CNV)', () => {
  it('produces CopyNumberVariant with copyNumber=1 and mosaicismFraction≈0.4', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'retinoblastoma.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    const cnvs = result.records.filter((r) => r.cascadeType === 'genomics:CopyNumberVariant');
    expect(cnvs).toHaveLength(1);
    const cnv = cnvs[0];
    expect(findQuad(cnv.quads, GENOMICS_NS + 'copyNumber')).toBe('1');
    const mos = findQuad(cnv.quads, GENOMICS_NS + 'mosaicismFraction');
    expect(parseFloat(mos!)).toBeCloseTo(0.4);
  });

  it('produces a Variant with VAF≈0.25 for the RB1 SNV', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'retinoblastoma.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    const variants = result.records.filter((r) => r.cascadeType === 'genomics:Variant');
    expect(variants.length).toBeGreaterThanOrEqual(1);
    const rb1 = variants.find((v) => objectsForPredicate(v.quads, GENOMICS_NS + 'geneSymbol')[0] === 'RB1');
    expect(rb1).toBeDefined();
    const vaf = findQuad(rb1!.quads, GENOMICS_NS + 'mosaicismFraction');
    expect(parseFloat(vaf!)).toBeCloseTo(0.25);
  });
});
