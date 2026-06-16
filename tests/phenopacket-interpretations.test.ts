/**
 * Tests for phenopacket interpretations[] → genomics:VariantInterpretation
 * (TASK-2B.4). Covers status mapping, ACMG mapping, multi-condition fan-out
 * (D-Q5), and the patient-anchor + requiresConfirmation safety triple.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ImportContext } from '../src/lib/import-types.js';
import { parseInterpretations } from '../src/lib/phenopacket-converter/interpretations.js';
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

function objectsForPredicate(quads: any[], pred: string): string[] {
  return quads.filter((q) => q.predicate.value === pred).map((q) => q.object.value);
}

describe('parseInterpretations', () => {
  it('emits a VariantInterpretation linked to the variant + patient', () => {
    const out = parseInterpretations(
      [
        {
          id: 'interp-1',
          progressStatus: 'SOLVED',
          diagnosis: {
            disease: { id: 'OMIM:101600', label: 'PFEIFFER SYNDROME' },
            genomicInterpretations: [
              {
                subjectOrBiosampleId: 's1',
                interpretationStatus: 'CAUSATIVE',
                variantInterpretation: {
                  acmgPathogenicityClassification: 'PATHOGENIC',
                  variationDescriptor: {
                    id: 'v1',
                    geneContext: { symbol: 'FGFR2', valueId: 'HGNC:3689' },
                    expressions: [
                      { syntax: 'hgvs.c', value: 'NM_000141.5:c.755C>G' },
                    ],
                  },
                },
              },
            ],
          },
        },
      ],
      PATIENT,
      ctx,
      'test',
    );
    const variants = out.records.filter((r) => r.cascadeType === 'genomics:Variant');
    const interps = out.records.filter((r) => r.cascadeType === 'genomics:VariantInterpretation');
    expect(variants).toHaveLength(1);
    expect(interps).toHaveLength(1);

    const ip = interps[0];
    expect(objectsForPredicate(ip.quads, GENOMICS_NS + 'variantInterpreted')[0]).toBe(
      variants[0].iri,
    );
    expect(objectsForPredicate(ip.quads, GENOMICS_NS + 'interpretationStatus')[0]).toBe(
      GENOMICS_NS + 'Causative',
    );
    expect(objectsForPredicate(ip.quads, GENOMICS_NS + 'acmgClassification')[0]).toBe(
      GENOMICS_NS + 'Pathogenic',
    );
    expect(objectsForPredicate(ip.quads, NS.cascade + 'aboutPatient')[0]).toBe(PATIENT);
  });

  it('flags requiresConfirmation=true on Pathogenic + ResearchGrade combo', () => {
    const out = parseInterpretations(
      [
        {
          id: 'i1',
          diagnosis: {
            disease: { id: 'OMIM:101600' },
            genomicInterpretations: [
              {
                interpretationStatus: 'CAUSATIVE',
                variantInterpretation: {
                  acmgPathogenicityClassification: 'PATHOGENIC',
                  variationDescriptor: {
                    id: 'v1',
                    expressions: [{ syntax: 'hgvs.c', value: 'NM_000.1:c.1A>G' }],
                  },
                },
              },
            ],
          },
        },
      ],
      PATIENT,
      ctx,
      'test',
    );
    const ip = out.records.find((r) => r.cascadeType === 'genomics:VariantInterpretation')!;
    const conf = ip.quads.find((q) => q.predicate.value === GENOMICS_NS + 'requiresConfirmation');
    expect(conf?.object.value).toBe('true');
  });

  it('does not flag requiresConfirmation for VUS', () => {
    const out = parseInterpretations(
      [
        {
          id: 'i1',
          diagnosis: {
            disease: { id: 'OMIM:101600' },
            genomicInterpretations: [
              {
                interpretationStatus: 'UNKNOWN_SIGNIFICANCE',
                variantInterpretation: {
                  acmgPathogenicityClassification: 'UNCERTAIN_SIGNIFICANCE',
                  variationDescriptor: { id: 'v1', expressions: [{ syntax: 'hgvs.c', value: 'x' }] },
                },
              },
            ],
          },
        },
      ],
      PATIENT,
      ctx,
      'test',
    );
    const ip = out.records.find((r) => r.cascadeType === 'genomics:VariantInterpretation')!;
    expect(
      ip.quads.find((q) => q.predicate.value === GENOMICS_NS + 'requiresConfirmation'),
    ).toBeUndefined();
  });

  it('emits one VariantInterpretation per (variant, condition) when diseases[] is multi-valued (D-Q5)', () => {
    const out = parseInterpretations(
      [
        {
          id: 'i1',
          diagnosis: {
            diseases: [
              { id: 'OMIM:101600', label: 'A' },
              { id: 'OMIM:222222', label: 'B' },
            ],
            genomicInterpretations: [
              {
                interpretationStatus: 'CAUSATIVE',
                variantInterpretation: {
                  acmgPathogenicityClassification: 'PATHOGENIC',
                  variationDescriptor: {
                    id: 'v1',
                    expressions: [{ syntax: 'hgvs.c', value: 'x' }],
                  },
                },
              },
            ],
          },
        },
      ],
      PATIENT,
      ctx,
      'test',
    );
    const interps = out.records.filter((r) => r.cascadeType === 'genomics:VariantInterpretation');
    const variants = out.records.filter((r) => r.cascadeType === 'genomics:Variant');
    expect(variants).toHaveLength(1); // single variant
    expect(interps).toHaveLength(2); // fanned to two conditions
    const allConditions = interps.flatMap((i) =>
      objectsForPredicate(i.quads, GENOMICS_NS + 'condition'),
    );
    expect(allConditions.sort()).toEqual(
      ['https://omim.org/entry/101600', 'https://omim.org/entry/222222'].sort(),
    );
  });

  it('records mondo / omim / orpha auxiliary IDs', () => {
    const out = parseInterpretations(
      [
        {
          id: 'i1',
          diagnosis: {
            disease: { id: 'MONDO:0007254' },
            genomicInterpretations: [
              {
                interpretationStatus: 'CAUSATIVE',
                variantInterpretation: {
                  acmgPathogenicityClassification: 'PATHOGENIC',
                  variationDescriptor: { id: 'v1', expressions: [{ syntax: 'hgvs.c', value: 'x' }] },
                },
              },
            ],
          },
        },
      ],
      PATIENT,
      ctx,
      'test',
    );
    const ip = out.records.find((r) => r.cascadeType === 'genomics:VariantInterpretation')!;
    expect(objectsForPredicate(ip.quads, GENOMICS_NS + 'mondoId')[0]).toBe('MONDO:0007254');
  });

  it('emits warning gap when interpretation has no diagnosis', () => {
    const out = parseInterpretations(
      [{ id: 'i1' }],
      PATIENT,
      ctx,
      'test',
    );
    expect(out.gaps.some((g) => g.severity === 'warning' && g.sourceField.endsWith('.diagnosis'))).toBe(true);
  });

  it('emits info gap for therapeuticActionability', () => {
    const out = parseInterpretations(
      [
        {
          id: 'i1',
          diagnosis: {
            disease: { id: 'OMIM:101600' },
            genomicInterpretations: [
              {
                interpretationStatus: 'CAUSATIVE',
                variantInterpretation: {
                  acmgPathogenicityClassification: 'PATHOGENIC',
                  therapeuticActionability: 'ACTIONABLE',
                  variationDescriptor: { id: 'v1', expressions: [{ syntax: 'hgvs.c', value: 'x' }] },
                },
              },
            ],
          },
        },
      ],
      PATIENT,
      ctx,
      'test',
    );
    expect(out.gaps.some((g) => g.sourceField.endsWith('therapeuticActionability'))).toBe(true);
  });
});

describe('convertPhenopacket — interpretations + variants wiring', () => {
  it('retinoblastoma: produces VariantInterpretation with Causative status', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'retinoblastoma.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    const interps = result.records.filter((r) => r.cascadeType === 'genomics:VariantInterpretation');
    expect(interps.length).toBeGreaterThanOrEqual(1);
    const causalities = interps.flatMap((i) =>
      objectsForPredicate(i.quads, GENOMICS_NS + 'interpretationStatus'),
    );
    expect(causalities).toContain(GENOMICS_NS + 'Causative');
  });

  it('retinoblastoma: at least one CopyNumberVariant emitted', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'retinoblastoma.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    const cnvs = result.records.filter((r) => r.cascadeType === 'genomics:CopyNumberVariant');
    expect(cnvs.length).toBeGreaterThanOrEqual(1);
  });
});
