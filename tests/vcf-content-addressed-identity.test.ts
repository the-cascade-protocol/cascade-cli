/**
 * Regression suite for content-addressed VCF identity.
 *
 * The VCF importer used to mint `genomics:SequencingRun` by hashing
 * `ImportContext.inputPath`. Every `genomics:Variant` IRI derives from the
 * run IRI, so the whole subgraph's identity moved with the file: importing
 * the same bytes from a second location minted a second run and a duplicate
 * set of variants instead of reconciling with what was already in the pod.
 *
 * These tests pin the replacement invariant from the outside, through the
 * public importer surface:
 *
 *   Same decompressed content  =>  same SequencingRun IRI and same Variant
 *   IRIs, regardless of path, filename, or compression.
 *
 * They are deliberately self-contained (inline VCF text, no conformance
 * sibling checkout) so they run everywhere the suite runs, including CI.
 */

import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';

import { convertVcf } from '../src/lib/vcf-converter/index.js';
import type { ImportContext } from '../src/lib/import-types.js';

const VCF = [
  '##fileformat=VCFv4.2',
  '##fileDate=2026-05-03',
  '##source=ClinVar',
  '##reference=GRCh38',
  '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tNA12878',
  '1\t100\trs1\tA\tG\t50\tPASS\tGENEINFO=BRCA1:672\tGT\t0/1',
  '1\t200\trs2\tC\tT\t60\tPASS\tGENEINFO=BRCA2:675\tGT\t1/1',
  '2\t300\t.\tG\tA,T\t70\tPASS\t.\tGT\t0/1',
  '',
].join('\n');

/** A different VCF that happens to share the header coordinates above. */
const OTHER_VCF = VCF.replace('1\t100\trs1\tA\tG', '1\t101\trs1\tA\tG');

function ctxAt(inputPath: string): ImportContext {
  return {
    inputPath,
    outputSerialization: 'turtle',
    importedAt: '2026-05-05T00:00:00Z',
    options: {},
  };
}

/** Run the importer and return the identity surface we care about. */
async function identityOf(input: string | Buffer, inputPath: string) {
  const result = await convertVcf(input, ctxAt(inputPath));
  return {
    runIri: result.sequencingRunIri,
    variantIris: result.records
      .filter((r) => r.cascadeType === 'genomics:Variant')
      .map((r) => r.iri),
    variantsEmitted: result.variantsEmitted,
  };
}

describe('VCF run identity is content-addressed', () => {
  it('mints the same IRIs for identical bytes at two different paths', async () => {
    const a = await identityOf(VCF, '/Users/alice/genomes/sample.vcf');
    const b = await identityOf(VCF, '/var/tmp/import-42/other-name.vcf');

    expect(a.runIri).toBeDefined();
    expect(b.runIri).toBe(a.runIri);
    expect(b.variantIris).toEqual(a.variantIris);
    expect(a.variantIris.length).toBeGreaterThan(0);
  });

  it('mints the same IRIs whether the input is gzipped or plain', async () => {
    const plain = await identityOf(Buffer.from(VCF, 'utf-8'), '/data/sample.vcf');
    const gzipped = await identityOf(gzipSync(Buffer.from(VCF, 'utf-8')), '/data/sample.vcf.gz');

    expect(gzipped.runIri).toBe(plain.runIri);
    expect(gzipped.variantIris).toEqual(plain.variantIris);
  });

  it('mints the same IRIs across gzip compression levels', async () => {
    // Gzip output is not byte-stable across compressors or levels, which is
    // why the digest is taken over the DECOMPRESSED content. Guard the two
    // extremes so a future change to hash raw file bytes fails here.
    const raw = Buffer.from(VCF, 'utf-8');
    const fast = gzipSync(raw, { level: 1 });
    const small = gzipSync(raw, { level: 9 });
    expect(fast.equals(small)).toBe(false);

    const a = await identityOf(fast, '/data/level1.vcf.gz');
    const b = await identityOf(small, '/data/level9.vcf.gz');

    expect(b.runIri).toBe(a.runIri);
    expect(b.variantIris).toEqual(a.variantIris);
  });

  it('mints the same IRIs for string and Buffer input of the same content', async () => {
    const asString = await identityOf(VCF, '/data/sample.vcf');
    const asBuffer = await identityOf(Buffer.from(VCF, 'utf-8'), '/data/sample.vcf');

    expect(asBuffer.runIri).toBe(asString.runIri);
    expect(asBuffer.variantIris).toEqual(asString.variantIris);
  });

  it('mints different IRIs for different content at the same path', async () => {
    // The digest must actually discriminate — a key that collapsed every
    // input to one run would pass all the tests above.
    const a = await identityOf(VCF, '/data/sample.vcf');
    const b = await identityOf(OTHER_VCF, '/data/sample.vcf');

    expect(b.runIri).not.toBe(a.runIri);
    expect(b.variantIris).not.toEqual(a.variantIris);
    expect(b.variantsEmitted).toBe(a.variantsEmitted);
  });

  it('mints different IRIs for different files that share a basename', async () => {
    // Records why a basename key was rejected: it is path-independent but
    // not content-addressed, so these two would have collided into one run.
    const a = await identityOf(VCF, '/patients/alice/sample.vcf');
    const b = await identityOf(OTHER_VCF, '/patients/bob/sample.vcf');

    expect(b.runIri).not.toBe(a.runIri);
  });

  it('keeps Variant IRIs derived from the run, so they move together', async () => {
    // Every Variant hangs off the run IRI; if the run is stable the whole
    // subgraph is. Assert the derivation is still in force rather than the
    // Variants having quietly acquired their own path-dependent identity.
    const same = await identityOf(VCF, '/one/place.vcf');
    const moved = await identityOf(VCF, '/another/place.vcf');
    const changed = await identityOf(OTHER_VCF, '/one/place.vcf');

    expect(new Set(moved.variantIris)).toEqual(new Set(same.variantIris));
    // Different run => every Variant IRI is different too.
    const overlap = changed.variantIris.filter((iri) => same.variantIris.includes(iri));
    expect(overlap).toEqual([]);
  });
});
