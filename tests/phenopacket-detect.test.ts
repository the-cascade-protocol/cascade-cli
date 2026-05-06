/**
 * Tests for the phenopacket-converter detect() heuristic and registry
 * wiring (TASK-2B.1).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detectPhenopacket,
  classifyPhenopacket,
} from '../src/lib/phenopacket-converter/detect.js';
import { phenopacketImporter } from '../src/lib/phenopacket-converter/registry-entry.js';
import { getImporter, listFormats, autoDetect } from '../src/lib/import-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.resolve(__dirname, '../../conformance/fixtures/genomics/phenopackets');
const NON_GENOMICS_FHIR = path.resolve(__dirname, '../test-fixtures/fhir-bundle-example.json');

/**
 * The 9 phenopacket-corpus files. The biosamples-SAMN05324082 file is an
 * NCBI BioSample SRA-style record that *lives in this directory* but is
 * not actually a phenopacket — detection MUST refuse it so the importer
 * doesn't claim it.
 */
const ALL_FIXTURES = [
  'bethlem-myopathy.input.json',
  'biosamples-SAMN05324082.input.json',
  'covid.input.json',
  'marfan.input.json',
  'retinoblastoma.input.json',
  'tpm3-myopathy.input.json',
  'v2-cohort.input.json',
  'v2-family.input.json',
  'v2-phenopacket.input.json',
];

const TRUE_PHENOPACKETS = ALL_FIXTURES.filter((f) => f !== 'biosamples-SAMN05324082.input.json');

describe('detectPhenopacket', () => {
  for (const name of TRUE_PHENOPACKETS) {
    it(`returns true for ${name}`, () => {
      const text = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
      expect(detectPhenopacket(text)).toBe(true);
    });
  }

  it('returns false for the NCBI BioSample non-phenopacket file', () => {
    const text = fs.readFileSync(
      path.join(FIXTURES_DIR, 'biosamples-SAMN05324082.input.json'),
      'utf-8',
    );
    expect(detectPhenopacket(text)).toBe(false);
  });

  it('returns false for the non-genomics FHIR R4 bundle', () => {
    const text = fs.readFileSync(NON_GENOMICS_FHIR, 'utf-8');
    expect(detectPhenopacket(text)).toBe(false);
  });

  it('returns false for invalid JSON', () => {
    expect(detectPhenopacket('not-json')).toBe(false);
    expect(detectPhenopacket('{ broken')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(detectPhenopacket('')).toBe(false);
  });

  it('returns false for arbitrary objects with no phenopacket markers', () => {
    expect(detectPhenopacket(JSON.stringify({ foo: 'bar' }))).toBe(false);
  });

  it('returns false for ZIP magic bytes', () => {
    const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
    expect(detectPhenopacket(zipMagic)).toBe(false);
  });

  it('returns true for a minimal v2 phenopacket with only schemaVersion', () => {
    const minimal = JSON.stringify({
      id: 'p1',
      metaData: { phenopacketSchemaVersion: '2.0.0' },
    });
    expect(detectPhenopacket(minimal)).toBe(true);
  });

  it('returns true when subject + phenotypicFeatures coexist with id (no schemaVersion)', () => {
    const noSchema = JSON.stringify({
      id: 'p1',
      subject: { id: 's1' },
      phenotypicFeatures: [{ type: { id: 'HP:0001', label: 'x' } }],
    });
    expect(detectPhenopacket(noSchema)).toBe(true);
  });

  it('returns false for a FHIR Bundle (has resourceType)', () => {
    expect(
      detectPhenopacket(JSON.stringify({ resourceType: 'Bundle', id: 'b1' })),
    ).toBe(false);
  });
});

describe('classifyPhenopacket', () => {
  it('classifies single-subject phenopacket as "phenopacket"', () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'v2-phenopacket.input.json'), 'utf-8');
    expect(classifyPhenopacket(JSON.parse(text))).toBe('phenopacket');
  });

  it('classifies family resource as "family"', () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'v2-family.input.json'), 'utf-8');
    expect(classifyPhenopacket(JSON.parse(text))).toBe('family');
  });

  it('classifies cohort resource as "cohort"', () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'v2-cohort.input.json'), 'utf-8');
    expect(classifyPhenopacket(JSON.parse(text))).toBe('cohort');
  });

  it('returns null for unrecognized shape', () => {
    expect(classifyPhenopacket({ foo: 'bar' })).toBeNull();
    expect(classifyPhenopacket(null)).toBeNull();
  });
});

describe('phenopacketImporter registry wiring', () => {
  it('is registered under the "phenopacket" --from value', () => {
    expect(listFormats()).toContain('phenopacket');
    expect(getImporter('phenopacket')).toBe(phenopacketImporter);
  });

  it('declares cascade + turtle + jsonld outputs', () => {
    expect(phenopacketImporter.supportedOutputs).toEqual(
      expect.arrayContaining(['turtle', 'jsonld', 'cascade']),
    );
  });

  it('autoDetect() returns the phenopacket importer for a phenopacket fixture', () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'retinoblastoma.input.json'), 'utf-8');
    const detected = autoDetect(text);
    expect(detected?.format).toBe('phenopacket');
  });

  it('convert() succeeds (empty result) at TASK-2B.1 stub level', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'v2-phenopacket.input.json'), 'utf-8');
    const result = await phenopacketImporter.convert(text, 'turtle', {
      inputPath: '<test>',
      outputSerialization: 'turtle',
      importedAt: new Date().toISOString(),
      options: {},
    });
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('convert() reports invalid JSON as a structured error', async () => {
    const result = await phenopacketImporter.convert('{ broken', 'turtle', {
      inputPath: '<test>',
      outputSerialization: 'turtle',
      importedAt: new Date().toISOString(),
      options: {},
    });
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid JSON/);
  });
});
