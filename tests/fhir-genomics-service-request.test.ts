/**
 * Unit tests for the ServiceRequest → GeneticTestOrder parser (TASK-1.7).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertGenomicsBundle } from '../src/lib/fhir-genomics-converter/index.js';
import { parseServiceRequest } from '../src/lib/fhir-genomics-converter/service-request.js';
import type { ImportContext } from '../src/lib/import-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, '../../conformance/fixtures/genomics/fhir-genomics-ig');

const baseCtx: ImportContext = {
  inputPath: '<test>',
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  options: {},
};

function loadBundle(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8'));
}

function tripleStrings(quads: any[]): string[] {
  return quads.map((q: any) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`);
}

describe('parseServiceRequest', () => {
  it('cgexample yields a GeneticTestOrder linked to its GeneticTest via resultedIn', async () => {
    const bundle = loadBundle('Bundle-bundle-cgexample.input.json');
    const result = await convertGenomicsBundle(bundle, baseCtx);

    const order = result.records.find((r) => r.cascadeType === 'genomics:GeneticTestOrder');
    const test = result.records.find((r) => r.cascadeType === 'genomics:GeneticTest');
    expect(order).toBeTruthy();
    expect(test).toBeTruthy();
    if (!order || !test) throw new Error();

    // The DR's basedOn writes a 'resultedIn' triple with the order as subject.
    // It lives in the Test record's quads (since that parser emitted it).
    const allTriples = tripleStrings(result.quads);
    const resultedInTriples = allTriples.filter(
      (t) => t.includes(`${order.iri} `) && t.includes('resultedIn'),
    );
    expect(resultedInTriples.length).toBe(1);
    expect(resultedInTriples[0]).toContain(test.iri);
  });

  it('maps FHIR status to OrderStatus named individuals', () => {
    const cases: Array<[string, string]> = [
      ['draft', 'OrderPending'],
      ['active', 'OrderInProgress'],
      ['completed', 'OrderResulted'],
      ['revoked', 'OrderCancelled'],
    ];
    for (const [fhirStatus, expectedInd] of cases) {
      const out = parseServiceRequest(
        { resourceType: 'ServiceRequest', id: 'sr', status: fhirStatus, intent: 'order' },
        baseCtx,
      );
      expect(out).toBeTruthy();
      if (!out) throw new Error();
      const triples = tripleStrings(out.record.quads);
      expect(
        triples.some((t) => t.includes('orderStatus') && t.includes(expectedInd)),
      ).toBe(true);
    }
  });

  it('emits notes from reasonCode.text and a vocabulary gap', () => {
    const out = parseServiceRequest(
      {
        resourceType: 'ServiceRequest',
        id: 'sr',
        status: 'active',
        intent: 'order',
        reasonCode: [{ text: 'Worried about family planning' }],
      },
      baseCtx,
    );
    expect(out).toBeTruthy();
    if (!out) throw new Error();
    const triples = tripleStrings(out.record.quads);
    expect(triples.some((t) => t.includes('Worried about family planning'))).toBe(true);
    expect(out.gaps.some((g) => g.sourceField.includes('reasonCode'))).toBe(true);
  });

  it('returns null for non-ServiceRequest input', () => {
    expect(parseServiceRequest({ resourceType: 'Patient' }, baseCtx)).toBeNull();
  });
});
