/**
 * Tests for the vrs-converter detect() heuristic and registry wiring
 * (TASK-3B.1).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectVrs } from '../src/lib/vrs-converter/detect.js';
import { vrsImporter } from '../src/lib/vrs-converter/registry-entry.js';
import { getImporter, listFormats, autoDetect } from '../src/lib/import-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VRS_FIXTURE = path.resolve(
  __dirname,
  '../../conformance/fixtures/genomics/vrs/example-allele-BRCA2-deletion.input.json',
);

describe('detectVrs', () => {
  it('returns true for the corpus BRCA2 Allele fixture', () => {
    const text = fs.readFileSync(VRS_FIXTURE, 'utf-8');
    expect(detectVrs(text)).toBe(true);
  });

  it('returns true for a canonical Allele shape (type+location+state)', () => {
    const allele = {
      type: 'Allele',
      id: 'ga4gh:VA.foo',
      location: { type: 'SequenceLocation', sequence_id: 'ga4gh:SQ.bar' },
      state: { type: 'LiteralSequenceExpression', sequence: 'A' },
    };
    expect(detectVrs(JSON.stringify(allele))).toBe(true);
  });

  it('returns true on @context-only signal (vrs.ga4gh.org)', () => {
    const doc = {
      '@context': 'https://vrs.ga4gh.org/contexts/vrs-1.3.jsonld',
    };
    expect(detectVrs(JSON.stringify(doc))).toBe(true);
  });

  it('returns true when id begins with ga4gh:VA. even without canonical shape', () => {
    expect(detectVrs(JSON.stringify({ id: 'ga4gh:VA.abc' }))).toBe(true);
  });

  it('returns false for a FHIR Bundle', () => {
    expect(detectVrs(JSON.stringify({ resourceType: 'Bundle', entry: [] }))).toBe(false);
  });

  it('returns false for a non-VRS plain JSON object', () => {
    expect(detectVrs(JSON.stringify({ foo: 'bar' }))).toBe(false);
  });

  it('returns false for invalid JSON', () => {
    expect(detectVrs('not json')).toBe(false);
    expect(detectVrs('{ broken')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(detectVrs('')).toBe(false);
  });

  it('handles a Buffer input safely (returns false for binary buffers)', () => {
    expect(detectVrs(Buffer.from([0x1f, 0x8b]))).toBe(false); // gzip
    expect(detectVrs(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(false); // ZIP
  });

  it('tolerates a leading `# comment` block before the JSON object', () => {
    const text =
      '# comment line 1\n# comment line 2\n' +
      JSON.stringify({
        type: 'Allele',
        id: 'ga4gh:VA.x',
        location: { type: 'SequenceLocation' },
        state: { type: 'LiteralSequenceExpression', sequence: '' },
      });
    expect(detectVrs(text)).toBe(true);
  });
});

describe('vrs importer registry wiring', () => {
  it('exposes the vrs format', () => {
    expect(listFormats()).toContain('vrs');
  });

  it('looks up via getImporter("vrs")', () => {
    const imp = getImporter('vrs');
    expect(imp).toBeDefined();
    expect(imp?.format).toBe('vrs');
    expect(imp?.supportedOutputs).toContain('turtle');
    expect(imp?.supportedOutputs).toContain('cascade');
  });

  it('autoDetect picks vrs for the corpus BRCA2 fixture', () => {
    const text = fs.readFileSync(VRS_FIXTURE, 'utf-8');
    const imp = autoDetect(text);
    expect(imp?.format).toBe('vrs');
  });

  it('autoDetect prefers fhir-genomics over vrs for a genomics-IG bundle', () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'Observation',
            meta: {
              profile: ['http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/variant'],
            },
          },
        },
      ],
    };
    const imp = autoDetect(JSON.stringify(bundle));
    expect(imp?.format).toBe('fhir-genomics');
  });

  it('importer.detect mirrors detectVrs', () => {
    const text = fs.readFileSync(VRS_FIXTURE, 'utf-8');
    expect(vrsImporter.detect(text)).toBe(true);
    expect(vrsImporter.detect('{}')).toBe(false);
  });
});
