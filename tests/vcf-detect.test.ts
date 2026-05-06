/**
 * Tests for the vcf-converter detect() heuristic and registry wiring
 * (TASK-3A.1).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { detectVcf, isGzipped, inflateGzip } from '../src/lib/vcf-converter/detect.js';
import { vcfImporter } from '../src/lib/vcf-converter/registry-entry.js';
import { getImporter, listFormats, autoDetect } from '../src/lib/import-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VCF_GZ_FIXTURE = path.resolve(
  __dirname,
  '../../conformance/fixtures/genomics/vcf/sample-clinvar.input.vcf.gz',
);

describe('detectVcf', () => {
  it('returns true for a plain VCFv4.1 header', () => {
    const text = '##fileformat=VCFv4.1\n##reference=GRCh38\n#CHROM\tPOS\tID\tREF\tALT\n';
    expect(detectVcf(text)).toBe(true);
  });

  it('returns true for VCFv4.0, v4.2, v4.3, v4.4', () => {
    expect(detectVcf('##fileformat=VCFv4.0\n')).toBe(true);
    expect(detectVcf('##fileformat=VCFv4.2\n')).toBe(true);
    expect(detectVcf('##fileformat=VCFv4.3\n')).toBe(true);
    expect(detectVcf('##fileformat=VCFv4.4\n')).toBe(true);
  });

  it('returns false for non-VCF text', () => {
    expect(detectVcf('not a vcf file')).toBe(false);
    expect(detectVcf('{"resourceType":"Bundle"}')).toBe(false);
    expect(detectVcf('')).toBe(false);
  });

  it('returns false for VCF v3.x (not v4+)', () => {
    expect(detectVcf('##fileformat=VCFv3.3\n')).toBe(false);
  });

  it('handles a Buffer input safely (returns false for non-gzip non-VCF binary)', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]); // ZIP magic
    expect(detectVcf(buf)).toBe(false);
  });

  it('returns true for a gzipped VCF Buffer', () => {
    const plain = '##fileformat=VCFv4.1\n##reference=GRCh38\n#CHROM\tPOS\tID\tREF\tALT\n';
    const gz = zlib.gzipSync(Buffer.from(plain, 'utf-8'));
    expect(isGzipped(gz)).toBe(true);
    expect(detectVcf(gz)).toBe(true);
  });

  it('returns true for the corpus sample-clinvar.input.vcf.gz fixture', () => {
    const buf = fs.readFileSync(VCF_GZ_FIXTURE);
    expect(isGzipped(buf)).toBe(true);
    expect(detectVcf(buf)).toBe(true);
  });

  it('inflateGzip yields the VCF text starting with ##fileformat=', () => {
    const buf = fs.readFileSync(VCF_GZ_FIXTURE);
    let text: string;
    try {
      text = inflateGzip(buf).toString('utf-8');
    } catch {
      // BGZF multi-block streams sometimes complain at EOF; tolerate gracefully.
      text = '';
    }
    expect(text.startsWith('##fileformat=VCFv4')).toBe(true);
  });

  it('returns false for a string without ##fileformat=', () => {
    expect(detectVcf('# this is just a comment\nsome data')).toBe(false);
  });

  it('skips leading blank lines before checking the first non-empty line', () => {
    expect(detectVcf('\n\n##fileformat=VCFv4.1\n')).toBe(true);
  });
});

describe('vcf importer registry wiring', () => {
  it('exposes the vcf format', () => {
    expect(listFormats()).toContain('vcf');
  });

  it('looks up via getImporter("vcf")', () => {
    const imp = getImporter('vcf');
    expect(imp).toBeDefined();
    expect(imp?.format).toBe('vcf');
    expect(imp?.supportedOutputs).toContain('turtle');
    expect(imp?.supportedOutputs).toContain('cascade');
  });

  it('autoDetect picks vcf for plain VCF text', () => {
    const text = '##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\n';
    const imp = autoDetect(text);
    expect(imp?.format).toBe('vcf');
  });

  it('autoDetect picks vcf for the corpus sample-clinvar.input.vcf.gz', () => {
    const buf = fs.readFileSync(VCF_GZ_FIXTURE);
    const imp = autoDetect(buf);
    expect(imp?.format).toBe('vcf');
  });

  it('importer.detect mirrors detectVcf', () => {
    const text = '##fileformat=VCFv4.1\n';
    expect(vcfImporter.detect(text)).toBe(true);
    expect(vcfImporter.detect('not a vcf')).toBe(false);
  });
});
