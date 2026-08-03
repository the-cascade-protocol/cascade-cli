/**
 * Tests for SequencingRun emission + multi-sample IRI minting (TASK-3A.4).
 */

import { describe, it, expect } from 'vitest';

import { parseHeaderLines } from '../src/lib/vcf-converter/header.js';
import { emitSequencingRun, mintSampleIri } from '../src/lib/vcf-converter/multi-sample.js';
import { GENOMICS_NS } from '../src/lib/fhir-genomics-converter/types.js';
import { NS } from '../src/lib/fhir-converter/types.js';
import type { ImportContext } from '../src/lib/import-types.js';

const CTX: ImportContext = {
  inputPath: '/path/to/sample.vcf.gz',
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  options: {},
};

/**
 * Stand-in for the SHA-256 the orchestrator computes over the decompressed
 * VCF bytes. `emitSequencingRun` takes the digest as given; the tests that
 * exercise how the digest is derived from real content live in
 * `vcf-content-addressed-identity.test.ts`.
 */
const DIGEST = 'a'.repeat(64);

describe('emitSequencingRun', () => {
  it('emits referenceGenome / variantCallerVersion / fileGenerationDate', () => {
    const header = parseHeaderLines([
      '##fileformat=VCFv4.1',
      '##fileDate=2026-05-03',
      '##source=ClinVar',
      '##reference=GRCh38',
      '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO',
    ]);
    const run = emitSequencingRun(header, CTX, DIGEST);
    const preds = run.quads.map((q) => q.predicate.value);
    expect(preds).toContain(GENOMICS_NS + 'referenceGenome');
    expect(preds).toContain(GENOMICS_NS + 'variantCallerVersion');
    expect(preds).toContain(GENOMICS_NS + 'fileGenerationDate');

    const ref = run.quads.find((q) => q.predicate.value === GENOMICS_NS + 'referenceGenome');
    expect(ref?.object.value).toBe('GRCh38');
    const src = run.quads.find((q) => q.predicate.value === GENOMICS_NS + 'variantCallerVersion');
    expect(src?.object.value).toBe('ClinVar');
    const date = run.quads.find((q) => q.predicate.value === GENOMICS_NS + 'fileGenerationDate');
    expect(date?.object.value).toBe('2026-05-03');
  });

  it('marks the SequencingRun with rdf:type genomics:SequencingRun', () => {
    const header = parseHeaderLines(['##fileformat=VCFv4.2']);
    const run = emitSequencingRun(header, CTX, DIGEST);
    const typeQuad = run.quads.find((q) => q.predicate.value.endsWith('rdf-syntax-ns#type'));
    expect(typeQuad?.object.value).toBe(GENOMICS_NS + 'SequencingRun');
  });

  it('normalizes YYYYMMDD fileDate into ISO 8601', () => {
    const header = parseHeaderLines([
      '##fileformat=VCFv4.2',
      '##fileDate=20260503',
    ]);
    const run = emitSequencingRun(header, CTX, DIGEST);
    const date = run.quads.find((q) => q.predicate.value === GENOMICS_NS + 'fileGenerationDate');
    expect(date?.object.value).toBe('2026-05-03');
  });

  it('preserves a malformed fileDate as cascade:unmappedField + info gap', () => {
    const header = parseHeaderLines([
      '##fileformat=VCFv4.2',
      '##fileDate=garbage-not-a-date',
    ]);
    const run = emitSequencingRun(header, CTX, DIGEST);
    const date = run.quads.find((q) => q.predicate.value === GENOMICS_NS + 'fileGenerationDate');
    expect(date).toBeUndefined();
    const unmapped = run.quads.find((q) => q.predicate.value === NS.cascade + 'unmappedField');
    expect(unmapped?.object.value).toContain('VCF.fileDate=garbage-not-a-date');
    expect(run.gaps.some((g) => g.sourceField === 'VCF.fileDate')).toBe(true);
  });

  it('mints stable sample IRIs from #CHROM column names', () => {
    const header = parseHeaderLines([
      '##fileformat=VCFv4.2',
      '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tNA12878\tNA12891\tNA12892',
    ]);
    const run = emitSequencingRun(header, CTX, DIGEST);
    expect(run.sampleIris.size).toBe(3);
    expect(run.sampleIris.get('NA12878')).toMatch(/^urn:uuid:/);
    // Stable across re-emit
    const run2 = emitSequencingRun(header, CTX, DIGEST);
    expect(run2.sampleIris.get('NA12878')).toBe(run.sampleIris.get('NA12878'));
  });

  it('merges ##SAMPLE entries with #CHROM column names', () => {
    const header = parseHeaderLines([
      '##fileformat=VCFv4.2',
      '##SAMPLE=<ID=metadataOnly,Sex=Female>',
      '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tcolumnSample',
    ]);
    const run = emitSequencingRun(header, CTX, DIGEST);
    expect(run.sampleIris.has('metadataOnly')).toBe(true);
    expect(run.sampleIris.has('columnSample')).toBe(true);
  });

  it('emits an info-level gap when samples exist (observedIn pending v0.2)', () => {
    const header = parseHeaderLines([
      '##fileformat=VCFv4.2',
      '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tA',
    ]);
    const run = emitSequencingRun(header, CTX, DIGEST);
    const gap = run.gaps.find((g) => g.sourceField === 'VCF.SAMPLE');
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('info');
  });

  it('omits sample-related gap on sites-only VCF', () => {
    const header = parseHeaderLines([
      '##fileformat=VCFv4.1',
      '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO',
    ]);
    const run = emitSequencingRun(header, CTX, DIGEST);
    expect(run.sampleIris.size).toBe(0);
    expect(run.gaps.some((g) => g.sourceField === 'VCF.SAMPLE')).toBe(false);
  });

  it('SequencingRun IRI is deterministic across re-emit with same inputs', () => {
    const header = parseHeaderLines([
      '##fileformat=VCFv4.1',
      '##fileDate=2026-05-03',
      '##source=ClinVar',
      '##reference=GRCh38',
    ]);
    const a = emitSequencingRun(header, CTX, DIGEST);
    const b = emitSequencingRun(header, CTX, DIGEST);
    expect(a.iri).toBe(b.iri);
  });

  it('SequencingRun IRI is minted from the content digest alone', () => {
    // Identity must not move with the file. Same digest + different
    // inputPath + different header coords => same run IRI; different digest
    // => different run IRI.
    const headerA = parseHeaderLines([
      '##fileformat=VCFv4.1',
      '##fileDate=2026-05-03',
      '##source=ClinVar',
      '##reference=GRCh38',
    ]);
    const headerB = parseHeaderLines(['##fileformat=VCFv4.2']);
    const elsewhere: ImportContext = { ...CTX, inputPath: '/somewhere/else/renamed.vcf' };

    expect(emitSequencingRun(headerA, CTX, DIGEST).iri).toBe(
      emitSequencingRun(headerB, elsewhere, DIGEST).iri,
    );
    expect(emitSequencingRun(headerA, CTX, DIGEST).iri).not.toBe(
      emitSequencingRun(headerA, CTX, 'b'.repeat(64)).iri,
    );
  });

  it('records the input path as sourceId provenance, not as identity', () => {
    // The path is still worth recording (it says where the bytes came
    // from); it just must not reach the IRI.
    const header = parseHeaderLines(['##fileformat=VCFv4.2']);
    const run = emitSequencingRun(header, CTX, DIGEST);
    expect(run.sourceId).toBe('/path/to/sample.vcf.gz');
  });
});

describe('mintSampleIri', () => {
  it('produces identical IRIs for the same (run, name) pair', () => {
    const a = mintSampleIri('urn:uuid:run-1', 'NA12878');
    const b = mintSampleIri('urn:uuid:run-1', 'NA12878');
    expect(a).toBe(b);
  });

  it('produces distinct IRIs for different sample names', () => {
    const a = mintSampleIri('urn:uuid:run-1', 'NA12878');
    const b = mintSampleIri('urn:uuid:run-1', 'NA12891');
    expect(a).not.toBe(b);
  });
});
