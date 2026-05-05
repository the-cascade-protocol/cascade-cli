/**
 * Tests for the fhir-genomics-converter detect() heuristic and registry
 * wiring (TASK-1.1).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectFhirGenomics } from '../src/lib/fhir-genomics-converter/detect.js';
import { fhirGenomicsImporter } from '../src/lib/fhir-genomics-converter/registry-entry.js';
import { getImporter, listFormats, autoDetect } from '../src/lib/import-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.resolve(__dirname, '../../conformance/fixtures/genomics/fhir-genomics-ig');
const NON_GENOMICS_FHIR = path.resolve(__dirname, '../test-fixtures/fhir-bundle-example.json');

const ALL_BUNDLES = [
  'Bundle-bundle-cgexample.input.json',
  'Bundle-bundle-pgxexample.input.json',
  'Bundle-bundle-oncology-diagnostic.input.json',
  'Bundle-bundle-oncologyexamples-r4.input.json',
  'Bundle-bundle-compound-heterozygote.input.json',
  'Bundle-bundle-CG-IG-HLA-FullBundle-01.input.json',
  'Bundle-bundle-complexVariant-nonHGVS.input.json',
];

describe('detectFhirGenomics', () => {
  for (const bundleName of ALL_BUNDLES) {
    it(`returns true for ${bundleName}`, () => {
      const filePath = path.join(FIXTURES_DIR, bundleName);
      const text = fs.readFileSync(filePath, 'utf-8');
      expect(detectFhirGenomics(text)).toBe(true);
    });
  }

  it('returns false for the non-genomics FHIR R4 bundle', () => {
    const text = fs.readFileSync(NON_GENOMICS_FHIR, 'utf-8');
    expect(detectFhirGenomics(text)).toBe(false);
  });

  it('returns false for invalid JSON', () => {
    expect(detectFhirGenomics('not-json')).toBe(false);
    expect(detectFhirGenomics('{ broken')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(detectFhirGenomics('')).toBe(false);
  });

  it('returns false for a non-Bundle non-genomics resource', () => {
    expect(
      detectFhirGenomics(JSON.stringify({ resourceType: 'Observation', id: 'foo' })),
    ).toBe(false);
  });

  it('returns true for a single Observation that carries a genomics IG profile', () => {
    expect(
      detectFhirGenomics(
        JSON.stringify({
          resourceType: 'Observation',
          id: 'foo',
          meta: {
            profile: ['http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/variant'],
          },
        }),
      ),
    ).toBe(true);
  });

  it('handles a Buffer input safely (returns false for binary ZIP magic)', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
    expect(detectFhirGenomics(buf)).toBe(false);
  });

  it('handles a Buffer input that decodes to genomics JSON', () => {
    const buf = Buffer.from(
      JSON.stringify({
        resourceType: 'Bundle',
        entry: [
          {
            resource: {
              resourceType: 'Observation',
              meta: {
                profile: [
                  'http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/haplotype',
                ],
              },
            },
          },
        ],
      }),
    );
    expect(detectFhirGenomics(buf)).toBe(true);
  });
});

describe('fhir-genomics importer registry wiring', () => {
  it('exposes the fhir-genomics format', () => {
    expect(listFormats()).toContain('fhir-genomics');
  });

  it('looks up via getImporter("fhir-genomics")', () => {
    const imp = getImporter('fhir-genomics');
    expect(imp).toBeDefined();
    expect(imp?.format).toBe('fhir-genomics');
    expect(imp?.supportedOutputs).toContain('turtle');
    expect(imp?.supportedOutputs).toContain('cascade');
  });

  it('autoDetect picks fhir-genomics over plain fhir for IG bundles', () => {
    const text = fs.readFileSync(
      path.join(FIXTURES_DIR, 'Bundle-bundle-cgexample.input.json'),
      'utf-8',
    );
    const imp = autoDetect(text);
    expect(imp?.format).toBe('fhir-genomics');
  });

  it('autoDetect still picks fhir for non-genomics R4 bundles', () => {
    const text = fs.readFileSync(NON_GENOMICS_FHIR, 'utf-8');
    const imp = autoDetect(text);
    expect(imp?.format).toBe('fhir');
  });

  it('importer.detect mirrors detectFhirGenomics', () => {
    const text = fs.readFileSync(
      path.join(FIXTURES_DIR, 'Bundle-bundle-cgexample.input.json'),
      'utf-8',
    );
    expect(fhirGenomicsImporter.detect(text)).toBe(true);
  });
});
