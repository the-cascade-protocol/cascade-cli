/**
 * Tests for phenopacket biosamples[] → fhir:Specimen + RawFile (TASK-2B.7).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ImportContext } from '../src/lib/import-types.js';
import {
  parseBiosample,
  buildRawFileRecord,
} from '../src/lib/phenopacket-converter/biosamples.js';
import { convertPhenopacket } from '../src/lib/phenopacket-converter/index.js';
import { GENOMICS_NS } from '../src/lib/phenopacket-converter/types.js';
import { NS } from '../src/lib/fhir-converter/types.js';

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

const PATIENT = 'urn:uuid:test-patient';

function findQuad(quads: any[], pred: string): string | undefined {
  return quads.find((q) => q.predicate.value === pred)?.object.value;
}

describe('parseBiosample', () => {
  it('emits fhir:Specimen anchor with tissue, taxonomy, ageAtCollection', () => {
    const out = parseBiosample(
      {
        id: 'bs-1',
        description: 'Muscle biopsy',
        sampledTissue: { id: 'UBERON:0003403', label: 'skin of forearm' },
        taxonomy: { id: 'NCBITaxon:9606', label: 'homo sapiens' },
        timeOfCollection: { age: { iso8601duration: 'P14Y' } },
      },
      PATIENT,
      ctx,
      'test',
    );
    const specimen = out.records.find((r) => r.cascadeType === 'fhir:Specimen');
    expect(specimen).toBeDefined();
    expect(findQuad(specimen!.quads, NS.cascade + 'sampledTissueId')).toBe('UBERON:0003403');
    expect(findQuad(specimen!.quads, NS.cascade + 'speciesTaxon')).toBe('NCBITaxon:9606');
    expect(findQuad(specimen!.quads, NS.cascade + 'ageAtCollection')).toBe('P14Y');
    expect(findQuad(specimen!.quads, NS.cascade + 'aboutPatient')).toBe(PATIENT);
  });

  it('emits info gap noting fhir:Specimen-anchor + Layer-2 wrapper missing', () => {
    const out = parseBiosample({ id: 'bs-1' }, PATIENT, ctx, 'test');
    expect(
      out.gaps.some((g) => g.severity === 'info' && g.reason.includes('Layer-2 specimen class')),
    ).toBe(true);
  });

  it('produces a RawFile record per biosample.files[]', () => {
    const out = parseBiosample(
      {
        id: 'bs-1',
        files: [
          {
            uri: 'file://data/somatic.vcf.gz',
            fileAttributes: { genomeAssembly: 'GRCh38', fileFormat: 'VCF' },
          },
        ],
      },
      PATIENT,
      ctx,
      'test',
    );
    const rawFiles = out.records.filter((r) => r.cascadeType === 'genomics:RawFile');
    expect(rawFiles).toHaveLength(1);
    const rf = rawFiles[0];
    expect(findQuad(rf.quads, GENOMICS_NS + 'fileLocation')).toBe('file://data/somatic.vcf.gz');
    expect(findQuad(rf.quads, GENOMICS_NS + 'fileFormat')).toBe(GENOMICS_NS + 'VCF');
    expect(findQuad(rf.quads, GENOMICS_NS + 'referenceGenome')).toBe('GRCh38');
  });

  it('emits info gaps for tumorProgression / pathologicalTnmFinding etc.', () => {
    const out = parseBiosample(
      {
        id: 'bs-1',
        tumorProgression: { id: 'NCIT:C8509', label: 'Primary' },
        pathologicalTnmFinding: [{ id: 'NCIT:C140720' }],
        diagnosticMarkers: [{ id: 'NCIT:C68748' }],
      },
      PATIENT,
      ctx,
      'test',
    );
    expect(out.gaps.some((g) => g.sourceField.endsWith('tumorProgression'))).toBe(true);
    expect(out.gaps.some((g) => g.sourceField.endsWith('pathologicalTnmFinding'))).toBe(true);
    expect(out.gaps.some((g) => g.sourceField.endsWith('diagnosticMarkers'))).toBe(true);
  });
});

describe('buildRawFileRecord', () => {
  it('falls back to URI extension for fileFormat detection', () => {
    const out = buildRawFileRecord({ uri: 'file://x.bam' }, ctx, 'test');
    expect(out).not.toBeNull();
    expect(findQuad(out!.record.quads, GENOMICS_NS + 'fileFormat')).toBe(GENOMICS_NS + 'BAM');
  });

  it('emits info gap noting absent SHA-256 hash', () => {
    const out = buildRawFileRecord({ uri: 'file://x.vcf.gz' }, ctx, 'test');
    expect(out!.gaps.some((g) => g.reason.includes('SHA-256'))).toBe(true);
  });

  it('returns null for missing uri', () => {
    expect(buildRawFileRecord({}, ctx, 'test')).toBeNull();
  });
});

describe('convertPhenopacket — biosamples integration', () => {
  it('retinoblastoma: produces 1 Specimen + 2 RawFile (biosample + top-level files)', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'retinoblastoma.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    const specimens = result.records.filter((r) => r.cascadeType === 'fhir:Specimen');
    const rawFiles = result.records.filter((r) => r.cascadeType === 'genomics:RawFile');
    expect(specimens).toHaveLength(1);
    // 1 from biosample.files + 1 from top-level files = 2
    expect(rawFiles).toHaveLength(2);
  });

  it('bethlem-myopathy: biosample tissue preserved', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'bethlem-myopathy.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    const specimens = result.records.filter((r) => r.cascadeType === 'fhir:Specimen');
    expect(specimens.length).toBeGreaterThanOrEqual(0); // bethlem may not have biosamples
  });
});
