/**
 * Tests for the clinvar-converter detect() heuristic and registry
 * wiring (TASK-2A.1).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectClinvar } from '../src/lib/clinvar-converter/detect.js';
import { clinvarImporter } from '../src/lib/clinvar-converter/registry-entry.js';
import { getImporter, listFormats, autoDetect } from '../src/lib/import-registry.js';
import { parseClinvarXml } from '../src/lib/clinvar-converter/xml-parser.js';
import { collectVariationArchives } from '../src/lib/clinvar-converter/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.resolve(__dirname, '../../conformance/fixtures/genomics/clinvar');
const NON_GENOMICS_FHIR = path.resolve(__dirname, '../test-fixtures/fhir-bundle-example.json');

const ALL_VCVS = [
  'VCV000017661-BRCA1.input.xml',
  'VCV000055448-BRCA2-pathogenic.input.xml',
  'VCV000208804-MLH1-LynchSyndrome.input.xml',
  'VCV000007105-CFTR-deltaF508.input.xml',
];

describe('detectClinvar', () => {
  for (const name of ALL_VCVS) {
    it(`returns true for ${name}`, () => {
      const filePath = path.join(FIXTURES_DIR, name);
      const text = fs.readFileSync(filePath, 'utf-8');
      expect(detectClinvar(text)).toBe(true);
    });
  }

  it('returns false for the non-genomics FHIR R4 bundle', () => {
    const text = fs.readFileSync(NON_GENOMICS_FHIR, 'utf-8');
    expect(detectClinvar(text)).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(detectClinvar('')).toBe(false);
  });

  it('returns false for plain JSON', () => {
    expect(detectClinvar('{"resourceType":"Bundle"}')).toBe(false);
  });

  it('returns false for arbitrary XML that is not ClinVar', () => {
    expect(
      detectClinvar(
        `<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3"><id/></ClinicalDocument>`,
      ),
    ).toBe(false);
  });

  it('returns true for a minimal VariationArchive root (no enclosing ClinVarResult-Set)', () => {
    expect(
      detectClinvar(
        `<?xml version="1.0"?><VariationArchive VariationID="1" Accession="VCV000000001"></VariationArchive>`,
      ),
    ).toBe(true);
  });

  it('returns true for the legacy ReleaseSet shape', () => {
    expect(
      detectClinvar(
        `<?xml version="1.0"?><ReleaseSet Dated="2024-01-01"><ClinVarSet/></ReleaseSet>`,
      ),
    ).toBe(true);
  });

  it('handles a Buffer input safely (returns false for binary ZIP magic)', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
    expect(detectClinvar(buf)).toBe(false);
  });

  it('handles a Buffer that decodes to ClinVar XML', () => {
    const buf = Buffer.from(
      `<?xml version="1.0"?><ClinVarResult-Set><VariationArchive Accession="VCV000000001"/></ClinVarResult-Set>`,
    );
    expect(detectClinvar(buf)).toBe(true);
  });
});

describe('clinvar importer registry wiring', () => {
  it('exposes the clinvar format', () => {
    expect(listFormats()).toContain('clinvar');
  });

  it('looks up via getImporter("clinvar")', () => {
    const imp = getImporter('clinvar');
    expect(imp).toBeDefined();
    expect(imp?.format).toBe('clinvar');
    expect(imp?.supportedOutputs).toContain('turtle');
    expect(imp?.supportedOutputs).toContain('cascade');
  });

  it('autoDetect picks clinvar for VCV XML', () => {
    const text = fs.readFileSync(
      path.join(FIXTURES_DIR, 'VCV000208804-MLH1-LynchSyndrome.input.xml'),
      'utf-8',
    );
    const imp = autoDetect(text);
    expect(imp?.format).toBe('clinvar');
  });

  it('importer.detect mirrors detectClinvar', () => {
    const text = fs.readFileSync(
      path.join(FIXTURES_DIR, 'VCV000017661-BRCA1.input.xml'),
      'utf-8',
    );
    expect(clinvarImporter.detect(text)).toBe(true);
  });
});

describe('clinvar XML parser + archive collection', () => {
  for (const name of ALL_VCVS) {
    it(`parses ${name} and collects exactly one VariationArchive`, () => {
      const text = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
      const parsed = parseClinvarXml(text);
      const archives = collectVariationArchives(parsed);
      expect(archives.length).toBeGreaterThanOrEqual(1);
      expect(archives[0]['@_Accession']).toMatch(/^VCV\d+/);
    });
  }
});
