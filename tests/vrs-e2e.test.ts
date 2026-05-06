/**
 * VRS importer end-to-end smoke tests (TASK-3B.3).
 *
 * Exercises the full pipeline (detect → orchestrator → registry-entry
 * → Turtle/JSON-LD serialization) on the corpus BRCA2 fixture and
 * synthetic Alleles.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser as N3Parser } from 'n3';

import { vrsImporter } from '../src/lib/vrs-converter/registry-entry.js';
import { computeSimpleVrsDigest } from '../src/lib/vrs-converter/allele.js';
import { GENOMICS_NS } from '../src/lib/fhir-genomics-converter/types.js';
import type { ImportContext } from '../src/lib/import-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VRS_FIXTURE = path.resolve(
  __dirname,
  '../../conformance/fixtures/genomics/vrs/example-allele-BRCA2-deletion.input.json',
);

const STRICT_CTX: ImportContext = {
  inputPath: VRS_FIXTURE,
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  options: {},
};

const PERMISSIVE_CTX: ImportContext = {
  ...STRICT_CTX,
  options: { allowVrsHashMismatch: true },
};

function selfConsistentAllele() {
  const payload = {
    type: 'Allele' as const,
    location: {
      type: 'SequenceLocation',
      sequence_id: 'ga4gh:SQ.test',
      interval: {
        type: 'SequenceInterval',
        start: { type: 'Number', value: 100 },
        end: { type: 'Number', value: 101 },
      },
    },
    state: { type: 'LiteralSequenceExpression', sequence: 'A' },
  };
  const id = computeSimpleVrsDigest(payload);
  return { ...payload, id };
}

describe('vrs end-to-end — registry adapter', () => {
  it('rejects the corpus BRCA2 fixture in strict mode (success: false)', async () => {
    const text = fs.readFileSync(VRS_FIXTURE, 'utf-8');
    const result = await vrsImporter.convert(text, 'cascade', STRICT_CTX);
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/hash mismatch/);
    expect(result.output).toBe('');
    expect(result.resourceCount).toBe(0);
  });

  it('accepts the corpus BRCA2 fixture in permissive mode (success: true + Turtle output)', async () => {
    const text = fs.readFileSync(VRS_FIXTURE, 'utf-8');
    const result = await vrsImporter.convert(text, 'cascade', PERMISSIVE_CTX);
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.resourceCount).toBe(1);
    expect(result.output.startsWith('@prefix')).toBe(true);
    expect(result.output).toContain('genomics/v1#Variant');
    expect(result.output).toContain('genomics/v1#vrsId');
    expect(result.output).toContain('genomics/v1#vrsObject');
    expect(result.output).toContain('ga4gh:VA.S3LWLZ-vfWfvxtOdT_BcsoMaP1mLfuNS');
  });

  it('emitted Turtle parses back through n3.Parser without errors', async () => {
    const text = fs.readFileSync(VRS_FIXTURE, 'utf-8');
    const result = await vrsImporter.convert(text, 'cascade', PERMISSIVE_CTX);
    expect(result.success).toBe(true);
    const parser = new N3Parser();
    const quads = parser.parse(result.output);
    expect(quads.length).toBeGreaterThan(0);
    // vrsId quad
    const vrsIdQuad = quads.find((q) => q.predicate.value === GENOMICS_NS + 'vrsId');
    expect(vrsIdQuad?.object.value).toBe('ga4gh:VA.S3LWLZ-vfWfvxtOdT_BcsoMaP1mLfuNS');
    // vrsObject literal preserved
    const vrsObjectQuad = quads.find((q) => q.predicate.value === GENOMICS_NS + 'vrsObject');
    expect(vrsObjectQuad?.object.value).toContain('"type":"Allele"');
    expect(vrsObjectQuad?.object.value).toContain('"sequence_id":"ga4gh:SQ._0wi-qoDrvram155UmcSC-zA5ZK4fpLT"');
  });

  it('produces JSON-LD when --to jsonld', async () => {
    const text = fs.readFileSync(VRS_FIXTURE, 'utf-8');
    const result = await vrsImporter.convert(text, 'jsonld', PERMISSIVE_CTX);
    expect(result.success).toBe(true);
    expect(result.format).toBe('jsonld');
    expect(() => JSON.parse(result.output)).not.toThrow();
  });

  it('rejects raw HGVS string with "not a VRS Allele" error', async () => {
    const result = await vrsImporter.convert(
      JSON.stringify({ hgvs: 'NM_007294.3:c.5946delT' }),
      'cascade',
      STRICT_CTX,
    );
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/not a VRS Allele|computes VRS digests/);
  });

  it('rejects empty / non-JSON input cleanly', async () => {
    const result = await vrsImporter.convert('not json', 'cascade', STRICT_CTX);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('round-trips a self-consistent synthetic Allele in strict mode', async () => {
    const allele = selfConsistentAllele();
    const result = await vrsImporter.convert(JSON.stringify(allele), 'cascade', STRICT_CTX);
    expect(result.success).toBe(true);
    expect(result.resourceCount).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.output).toContain(allele.id);
  });

  it('exposes --allow-vrs-hash-mismatch via cliOptions', () => {
    expect(vrsImporter.cliOptions).toBeDefined();
    const flag = vrsImporter.cliOptions!.find((o) =>
      o.flag.includes('--allow-vrs-hash-mismatch'),
    );
    expect(flag).toBeDefined();
  });
});

describe('vrs end-to-end — corpus determinism', () => {
  it('produces identical Variant IRIs across two runs of the same fixture', async () => {
    const text = fs.readFileSync(VRS_FIXTURE, 'utf-8');
    const a = await vrsImporter.convert(text, 'cascade', PERMISSIVE_CTX);
    const b = await vrsImporter.convert(text, 'cascade', PERMISSIVE_CTX);
    expect(a.importedIdentifiers[0].cascadeIri).toBe(b.importedIdentifiers[0].cascadeIri);
  });
});
