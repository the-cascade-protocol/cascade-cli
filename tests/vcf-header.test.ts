/**
 * Tests for parseHeaderLines() — TASK-3A.2.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseHeaderLines, classifySource } from '../src/lib/vcf-converter/header.js';
import { inflateGzip } from '../src/lib/vcf-converter/detect.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VCF_GZ_FIXTURE = path.resolve(
  __dirname,
  '../../conformance/fixtures/genomics/vcf/sample-clinvar.input.vcf.gz',
);

describe('parseHeaderLines', () => {
  it('parses a minimal v4.1 header with reference + source', () => {
    const lines = [
      '##fileformat=VCFv4.1',
      '##fileDate=2026-05-03',
      '##source=ClinVar',
      '##reference=GRCh38',
      '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO',
    ];
    const h = parseHeaderLines(lines);
    expect(h.fileFormat).toBe('VCFv4.1');
    expect(h.fileDate).toBe('2026-05-03');
    expect(h.source).toBe('ClinVar');
    expect(h.reference).toBe('GRCh38');
    expect(h.sampleColumns).toEqual([]);
  });

  it('parses ##INFO with quoted Description containing commas', () => {
    const lines = [
      '##fileformat=VCFv4.2',
      '##INFO=<ID=CLNDISDB,Number=.,Type=String,Description="Tag-value pairs of disease database name and identifier, separated by commas">',
    ];
    const h = parseHeaderLines(lines);
    expect(h.info.has('CLNDISDB')).toBe(true);
    const meta = h.info.get('CLNDISDB')!;
    expect(meta.Type).toBe('String');
    expect(meta.Number).toBe('.');
    expect(meta.Description).toBe(
      'Tag-value pairs of disease database name and identifier, separated by commas',
    );
  });

  it('parses ##INFO with integer Number', () => {
    const h = parseHeaderLines([
      '##fileformat=VCFv4.2',
      '##INFO=<ID=DP,Number=1,Type=Integer,Description="Total Depth">',
    ]);
    expect(h.info.get('DP')!.Number).toBe(1);
  });

  it('parses ##FORMAT entries', () => {
    const h = parseHeaderLines([
      '##fileformat=VCFv4.2',
      '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">',
      '##FORMAT=<ID=AF,Number=A,Type=Float,Description="Allele frequency">',
    ]);
    expect(h.format.get('GT')!.Type).toBe('String');
    expect(h.format.get('AF')!.Number).toBe('A');
  });

  it('parses ##contig entries', () => {
    const h = parseHeaderLines([
      '##fileformat=VCFv4.2',
      '##contig=<ID=1,length=248956422,assembly=GRCh38>',
      '##contig=<ID=X,length=156040895>',
    ]);
    expect(h.contigs.get('1')).toEqual({ length: 248956422, assembly: 'GRCh38' });
    expect(h.contigs.get('X')).toEqual({ length: 156040895, assembly: undefined });
  });

  it('parses ##SAMPLE entries', () => {
    const h = parseHeaderLines([
      '##fileformat=VCFv4.2',
      '##SAMPLE=<ID=NA12878,Sex=Female,Description="GIAB reference">',
    ]);
    expect(h.samples.get('NA12878')).toEqual({
      ID: 'NA12878',
      Sex: 'Female',
      Description: 'GIAB reference',
    });
  });

  it('extracts sample column names from the #CHROM line', () => {
    const h = parseHeaderLines([
      '##fileformat=VCFv4.2',
      '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tNA12878\tNA12891\tNA12892',
    ]);
    expect(h.sampleColumns).toEqual(['NA12878', 'NA12891', 'NA12892']);
  });

  it('throws on missing ##fileformat', () => {
    expect(() => parseHeaderLines(['#CHROM\tPOS\tID'])).toThrow(/missing ##fileformat/);
  });

  it('throws on pre-v4 fileformat', () => {
    expect(() => parseHeaderLines(['##fileformat=VCFv3.3'])).toThrow(/not supported/);
  });

  it('throws on unrecognized fileformat string', () => {
    expect(() => parseHeaderLines(['##fileformat=garbage'])).toThrow(/unrecognized/);
  });

  it('parses the corpus sample-clinvar.input.vcf.gz header', () => {
    const buf = fs.readFileSync(VCF_GZ_FIXTURE);
    const text = inflateGzip(buf).toString('utf-8');
    const headerLines = text.split('\n').filter((l) => l.startsWith('#'));
    const h = parseHeaderLines(headerLines);
    expect(h.fileFormat).toBe('VCFv4.1');
    expect(h.reference).toBe('GRCh38');
    expect(h.source).toBe('ClinVar');
    expect(h.fileDate).toBe('2026-05-03');
    // ClinVar VCF carries 30+ INFO fields including ALLELEID, CLNSIG, RS, GENEINFO.
    expect(h.info.has('ALLELEID')).toBe(true);
    expect(h.info.has('CLNSIG')).toBe(true);
    expect(h.info.has('RS')).toBe(true);
    expect(h.info.has('GENEINFO')).toBe(true);
    // ClinVar weekly is sites-only — no FORMAT or sample columns.
    expect(h.format.size).toBe(0);
    expect(h.sampleColumns).toEqual([]);
  });
});

describe('classifySource', () => {
  it('promotes ClinVar VCFs to ClinicalGrade-eligible', () => {
    const profile = classifySource({
      fileFormat: 'VCFv4.1',
      source: 'ClinVar',
      contigs: new Map(),
      info: new Map(),
      format: new Map(),
      samples: new Map(),
      sampleColumns: [],
      rawHeader: '',
    });
    expect(profile.isClinvarLike).toBe(true);
  });

  it('leaves unknown sources in the default (research) tier', () => {
    const profile = classifySource({
      fileFormat: 'VCFv4.2',
      source: 'GATK HaplotypeCaller',
      contigs: new Map(),
      info: new Map(),
      format: new Map(),
      samples: new Map(),
      sampleColumns: [],
      rawHeader: '',
    });
    expect(profile.isClinvarLike).toBe(false);
  });

  it('handles missing source field', () => {
    const profile = classifySource({
      fileFormat: 'VCFv4.2',
      contigs: new Map(),
      info: new Map(),
      format: new Map(),
      samples: new Map(),
      sampleColumns: [],
      rawHeader: '',
    });
    expect(profile.isClinvarLike).toBe(false);
  });
});
