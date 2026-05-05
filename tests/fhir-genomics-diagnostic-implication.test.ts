/**
 * Unit tests for the Diagnostic-implication parser (TASK-1.5).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertGenomicsBundle } from '../src/lib/fhir-genomics-converter/index.js';
import { parseDiagnosticImplication } from '../src/lib/fhir-genomics-converter/observation-diagnostic-implication.js';
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

describe('parseDiagnosticImplication', () => {
  it('cgexample yields a Pathogenic VariantInterpretation linking to MONDO:0012624', async () => {
    const bundle = loadBundle('Bundle-bundle-cgexample.input.json');
    const result = await convertGenomicsBundle(bundle, baseCtx);
    const interps = result.records.filter((r) => r.cascadeType === 'genomics:VariantInterpretation');
    // dis-path + complex-dis-path = 2 interpretations
    expect(interps.length).toBeGreaterThanOrEqual(1);

    const allTriples = interps.flatMap((i) => tripleStrings(i.quads));
    // Pathogenic ACMG class
    expect(allTriples.some(
      (t) => t.includes('acmgClassification') && t.includes('Pathogenic'),
    )).toBe(true);

    // MONDO:0012624 (acyl-CoA dehydrogenase 9 deficiency)
    expect(allTriples.some((t) => t.includes('mondoId MONDO:0012624'))).toBe(true);

    // condition IRI link
    expect(allTriples.some(
      (t) => t.includes('genomics/v1#condition') && t.includes('MONDO_'),
    )).toBe(true);

    // variantInterpreted ref
    expect(allTriples.some((t) => t.includes('variantInterpreted'))).toBe(true);
  });

  it('emits one VariantInterpretation per condition (D-Q5 cardinality 1..1)', () => {
    const synthetic = {
      resourceType: 'Observation',
      id: 'multi-condition',
      meta: { profile: ['http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/diagnostic-implication'] },
      derivedFrom: [{ reference: 'Observation/v1' }],
      component: [
        {
          code: { coding: [{ system: 'http://loinc.org', code: '53037-8' }] },
          valueCodeableConcept: { coding: [{ system: 'http://loinc.org', code: 'LA6668-3', display: 'Pathogenic' }] },
        },
        {
          code: { coding: [{ system: 'http://loinc.org', code: '81259-4' }] },
          valueCodeableConcept: { coding: [{ system: 'http://purl.obolibrary.org/obo/mondo.owl', code: 'MONDO:0007254' }] },
        },
        {
          code: { coding: [{ system: 'http://loinc.org', code: '81259-4' }] },
          valueCodeableConcept: { coding: [{ system: 'http://purl.obolibrary.org/obo/mondo.owl', code: 'MONDO:0014551' }] },
        },
      ],
    };
    const idIndex = new Map<string, string>([
      ['Observation/v1', 'urn:uuid:variant-iri-1'],
    ]);
    const out = parseDiagnosticImplication(synthetic, idIndex, baseCtx);
    expect(out).toBeTruthy();
    if (!out) throw new Error('no output');

    expect(out.records.length).toBe(2);
    // Each interpretation has Pathogenic + a single condition
    for (const rec of out.records) {
      const triples = tripleStrings(rec.quads);
      expect(triples.some((t) => t.includes('acmgClassification') && t.includes('Pathogenic'))).toBe(true);
      expect(triples.some((t) => t.includes('variantInterpreted urn:uuid:variant-iri-1'))).toBe(true);
      // Exactly one condition triple per record
      const conditionTriples = triples.filter((t) => t.includes('genomics/v1#condition '));
      expect(conditionTriples.length).toBe(1);
    }
    // Conditions distinct across records
    const allMondo = out.records.flatMap((r) => tripleStrings(r.quads).filter((t) => t.includes('mondoId')));
    expect(allMondo.length).toBe(2);
  });

  it('emits warning gap when no Variant ref can be resolved', () => {
    const synthetic = {
      resourceType: 'Observation',
      id: 'orphan',
      meta: { profile: ['http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/diagnostic-implication'] },
      derivedFrom: [{ reference: 'Observation/missing' }],
      component: [
        {
          code: { coding: [{ system: 'http://loinc.org', code: '81259-4' }] },
          valueCodeableConcept: { coding: [{ system: 'http://purl.obolibrary.org/obo/mondo.owl', code: 'MONDO:0007254' }] },
        },
      ],
    };
    const out = parseDiagnosticImplication(synthetic, new Map(), baseCtx);
    expect(out?.records.length).toBe(0);
    expect(out?.gaps.find((g) => g.severity === 'warning')).toBeTruthy();
  });

  it('cgexample full bundle: variantInterpreted points at the actual Variant IRI', async () => {
    const bundle = loadBundle('Bundle-bundle-cgexample.input.json');
    const result = await convertGenomicsBundle(bundle, baseCtx);
    const variant = result.records.find(
      (r) => r.cascadeType === 'genomics:Variant' && r.sourceId === 'discrete-variant',
    );
    const interp = result.records.find(
      (r) => r.cascadeType === 'genomics:VariantInterpretation' && r.sourceId === 'dis-path',
    );
    expect(variant).toBeTruthy();
    expect(interp).toBeTruthy();
    if (!variant || !interp) throw new Error();

    const interpTriples = tripleStrings(interp.quads);
    expect(interpTriples.some((t) => t.includes(`variantInterpreted ${variant.iri}`))).toBe(true);
  });
});
