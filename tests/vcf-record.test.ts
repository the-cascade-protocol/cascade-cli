/**
 * Tests for parseRecordLine() — TASK-3A.3.
 *
 * Exercises Variant emission, ID classification (rsID vs ClinVar
 * Variation ID), CLNHGVS / ALLELEID handling, multi-ALT splitting, FILTER
 * + QUAL preservation, GT → zygosity mapping, and the v1-draft.0.1 gap
 * surface (refAllele / altAllele / coords / VAF / observedIn).
 */

import { describe, it, expect } from 'vitest';

import { parseRecordLine } from '../src/lib/vcf-converter/record.js';
import { parseHeaderLines, classifySource } from '../src/lib/vcf-converter/header.js';
import { GENOMICS_NS } from '../src/lib/fhir-genomics-converter/types.js';
import type { ImportContext } from '../src/lib/import-types.js';

const RUN_IRI = 'urn:uuid:00000000-0000-5000-8000-000000000001';

const CTX: ImportContext = {
  inputPath: '<test>',
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  options: {},
};

function makeClinVarHeader() {
  const header = parseHeaderLines([
    '##fileformat=VCFv4.1',
    '##source=ClinVar',
    '##reference=GRCh38',
    '##INFO=<ID=ALLELEID,Number=1,Type=Integer,Description="ClinVar Allele ID">',
    '##INFO=<ID=CLNHGVS,Number=.,Type=String,Description="HGVS expression">',
    '##INFO=<ID=CLNSIG,Number=.,Type=String,Description="Aggregate classification">',
    '##INFO=<ID=GENEINFO,Number=1,Type=String,Description="Gene info">',
    '##INFO=<ID=RS,Number=.,Type=String,Description="dbSNP rsID">',
    '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO',
  ]);
  return { header, profile: classifySource(header) };
}

function makeMultiSampleHeader() {
  const header = parseHeaderLines([
    '##fileformat=VCFv4.2',
    '##source=GATK HaplotypeCaller',
    '##reference=GRCh38',
    '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">',
    '##FORMAT=<ID=AF,Number=A,Type=Float,Description="Allele frequency">',
    '##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Total depth">',
    '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tNA12878',
  ]);
  return { header, profile: classifySource(header) };
}

describe('parseRecordLine — ClinVar single-ALT site', () => {
  const { header, profile } = makeClinVarHeader();

  it('emits one Variant per record', () => {
    const line = [
      '1', '69134', '2205837', 'A', 'G', '.', '.',
      'ALLELEID=2193183;CLNHGVS=NC_000001.11:g.69134A>G;CLNSIG=Likely_benign;GENEINFO=OR4F5:79501;RS=781394307',
    ].join('\t');
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    expect(out.records).toHaveLength(1);
    expect(out.records[0].cascadeType).toBe('genomics:Variant');
    expect(out.records[0].sourceId).toBe('1:69134:A>G');
  });

  it('marks the Variant ClinicalGrade for ClinVar source', () => {
    const line = '1\t69134\t.\tA\tG\t.\t.\t.';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    const tierQuad = out.records[0].quads.find(
      (q) => q.predicate.value === GENOMICS_NS + 'dataQualityTier',
    );
    expect(tierQuad?.object.value).toBe(GENOMICS_NS + 'ClinicalGrade');
  });

  it('classifies a numeric ID column as a ClinVar Variation ID', () => {
    const line = '1\t69134\t2205837\tA\tG\t.\t.\t.';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    const cvId = out.records[0].quads.find(
      (q) => q.predicate.value === GENOMICS_NS + 'clinvarVariationId',
    );
    expect(cvId?.object.value).toBe('2205837');
  });

  it('classifies an "rs" ID column as a dbSNP rsID', () => {
    const line = '1\t69134\trs999\tA\tG\t.\t.\t.';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    const rs = out.records[0].quads.find((q) => q.predicate.value === GENOMICS_NS + 'dbsnpRsId');
    expect(rs?.object.value).toBe('rs999');
  });

  it('falls back to INFO.RS for dbsnpRsId when ID column is non-rs', () => {
    const line = '1\t69134\t2205837\tA\tG\t.\t.\tRS=781394307';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    const rs = out.records[0].quads.find((q) => q.predicate.value === GENOMICS_NS + 'dbsnpRsId');
    expect(rs?.object.value).toBe('rs781394307');
  });

  it('emits hgvsGDot from CLNHGVS', () => {
    const line = '1\t69134\t.\tA\tG\t.\t.\tCLNHGVS=NC_000001.11:g.69134A>G';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    const hgvs = out.records[0].quads.find((q) => q.predicate.value === GENOMICS_NS + 'hgvsGDot');
    expect(hgvs?.object.value).toBe('NC_000001.11:g.69134A>G');
  });

  it('surfaces gap-info for refAllele / altAllele / coords / FILTER (non-PASS)', () => {
    const line = '1\t69134\t.\tA\tG\t30\tLowQual\tCLNSIG=Pathogenic';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    const fields = out.gaps.map((g) => g.sourceField);
    expect(fields).toContain('VCF.REF');
    expect(fields).toContain('VCF.ALT');
    expect(fields).toContain('VCF.CHROM:POS');
    expect(fields).toContain('VCF.QUAL');
    expect(fields).toContain('VCF.FILTER');
    const filterGap = out.gaps.find((g) => g.sourceField === 'VCF.FILTER')!;
    expect(filterGap.severity).toBe('warning');
  });

  it('records FILTER=PASS as info-level gap, not warning', () => {
    const line = '1\t69134\t.\tA\tG\t30\tPASS\t.';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    const filterGap = out.gaps.find((g) => g.sourceField === 'VCF.FILTER')!;
    expect(filterGap.severity).toBe('info');
  });

  it('skips FILTER and QUAL gap when both are "."', () => {
    const line = '1\t69134\t.\tA\tG\t.\t.\t.';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    const fields = out.gaps.map((g) => g.sourceField);
    expect(fields).not.toContain('VCF.QUAL');
    expect(fields).not.toContain('VCF.FILTER');
  });
});

describe('parseRecordLine — multi-ALT', () => {
  const { header, profile } = makeClinVarHeader();

  it('emits N Variants for N ALT alleles', () => {
    const line = '1\t100\t.\tA\tG,T,C\t.\t.\t.';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    expect(out.records).toHaveLength(3);
    expect(out.records.map((r) => r.sourceId)).toEqual([
      '1:100:A>G',
      '1:100:A>T',
      '1:100:A>C',
    ]);
  });

  it('mints distinct IRIs for each ALT', () => {
    const line = '1\t100\t.\tA\tG,T\t.\t.\t.';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    expect(out.records[0].iri).not.toBe(out.records[1].iri);
  });
});

describe('parseRecordLine — multi-sample VCF (FORMAT)', () => {
  const { header, profile } = makeMultiSampleHeader();

  it('maps GT 0/1 → genomics:Heterozygous', () => {
    const line = '1\t100\t.\tA\tG\t30\tPASS\t.\tGT:AF:DP\t0/1:0.5:30';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    const zyg = out.records[0].quads.find((q) => q.predicate.value === GENOMICS_NS + 'zygosity');
    expect(zyg?.object.value).toBe(GENOMICS_NS + 'Heterozygous');
  });

  it('maps GT 1/1 → genomics:Homozygous', () => {
    const line = '1\t100\t.\tA\tG\t30\tPASS\t.\tGT\t1/1';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    const zyg = out.records[0].quads.find((q) => q.predicate.value === GENOMICS_NS + 'zygosity');
    expect(zyg?.object.value).toBe(GENOMICS_NS + 'Homozygous');
  });

  it('maps GT 1 (single allele, e.g. chrY in male) → genomics:Hemizygous', () => {
    const line = 'Y\t100\t.\tA\tG\t30\tPASS\t.\tGT\t1';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    const zyg = out.records[0].quads.find((q) => q.predicate.value === GENOMICS_NS + 'zygosity');
    expect(zyg?.object.value).toBe(GENOMICS_NS + 'Hemizygous');
  });

  it('flags GT 0/0 (HomRef) as a v1-draft.0.1 gap (not in ZygosityValue enum)', () => {
    const line = '1\t100\t.\tA\tG\t30\tPASS\t.\tGT\t0/0';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    const fields = out.gaps.map((g) => g.sourceField);
    expect(fields).toContain('VCF.FORMAT.GT');
  });

  it('emits VAF gap-info for FORMAT.AF', () => {
    const line = '1\t100\t.\tA\tG\t30\tPASS\t.\tGT:AF\t0/1:0.42';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    const afGap = out.gaps.find((g) => g.sourceField === 'VCF.FORMAT.AF');
    expect(afGap).toBeDefined();
    expect(afGap?.reason).toMatch(/variantAlleleFrequency/);
  });

  it('flags multi-sample VCFs since observedIn is not in v1-draft.0.1', () => {
    const multiHeader = parseHeaderLines([
      '##fileformat=VCFv4.2',
      '##FORMAT=<ID=GT,Number=1,Type=String>',
      '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tA\tB',
    ]);
    const line = '1\t100\t.\tA\tG\t30\tPASS\t.\tGT\t0/1\t1/1';
    const out = parseRecordLine(line, multiHeader, classifySource(multiHeader), RUN_IRI, CTX)!;
    const gap = out.gaps.find((g) => g.sourceField === 'VCF.multi-sample');
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('warning');
  });

  it('flags phased genotypes (|) as a v1-draft.0.2-pending gap', () => {
    const line = '1\t100\t.\tA\tG\t30\tPASS\t.\tGT\t0|1';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    const phaseGap = out.gaps.find((g) => g.sourceField === 'VCF.FORMAT.GT.phase');
    expect(phaseGap).toBeDefined();
  });
});

describe('parseRecordLine — error paths', () => {
  const { header, profile } = makeClinVarHeader();

  it('returns a warning + empty records on a malformed line', () => {
    const out = parseRecordLine('not\ta\tvalid', header, profile, RUN_IRI, CTX);
    expect(out!.records).toHaveLength(0);
    expect(out!.warnings.length).toBeGreaterThan(0);
  });

  it('returns no Variants when ALT is "." (REF-only record)', () => {
    const line = '1\t100\t.\tA\t.\t.\t.\t.';
    const out = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    expect(out.records).toHaveLength(0);
  });
});

describe('parseRecordLine — IRI determinism', () => {
  const { header, profile } = makeClinVarHeader();

  it('produces stable IRIs across re-parse of the same line', () => {
    const line = '1\t100\t.\tA\tG\t.\t.\t.';
    const a = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    const b = parseRecordLine(line, header, profile, RUN_IRI, CTX)!;
    expect(a.records[0].iri).toBe(b.records[0].iri);
  });
});
