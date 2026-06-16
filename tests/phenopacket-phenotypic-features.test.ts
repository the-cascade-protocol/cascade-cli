/**
 * Tests for phenopacket phenotypicFeatures → HPO term references on the
 * patient (TASK-2B.3).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ImportContext } from '../src/lib/import-types.js';
import { parsePhenotypicFeatures } from '../src/lib/phenopacket-converter/phenotypic-features.js';
import { convertPhenopacket } from '../src/lib/phenopacket-converter/index.js';
import { GENOMICS_NS } from '../src/lib/phenopacket-converter/types.js';

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

const PATIENT = 'urn:uuid:test-patient-iri';

function objectsForPredicate(quads: any[], pred: string): string[] {
  return quads.filter((q) => q.predicate.value === pred).map((q) => q.object.value);
}

describe('parsePhenotypicFeatures', () => {
  it('emits one genomics:hpoTerm per positive feature', () => {
    const out = parsePhenotypicFeatures(
      [
        { type: { id: 'HP:0030084', label: 'Clinodactyly' } },
        { type: { id: 'HP:0000555', label: 'Leukocoria' } },
      ],
      PATIENT,
      ctx,
      'test',
    );
    const hpos = objectsForPredicate(out.quads, GENOMICS_NS + 'hpoTerm');
    expect(hpos).toEqual(['HP:0030084', 'HP:0000555']);
    expect(out.attached).toBe(2);
  });

  it('routes excluded features to genomics:negatedHpoTerm + info gap', () => {
    const out = parsePhenotypicFeatures(
      [{ type: { id: 'HP:0002616', label: 'Aortic root aneurysm' }, excluded: true }],
      PATIENT,
      ctx,
      'test',
    );
    const positives = objectsForPredicate(out.quads, GENOMICS_NS + 'hpoTerm');
    const negs = objectsForPredicate(out.quads, GENOMICS_NS + 'negatedHpoTerm');
    expect(positives).toEqual([]);
    expect(negs).toEqual(['HP:0002616']);
    expect(out.gaps.some((g) => g.sourceField.endsWith('.excluded'))).toBe(true);
  });

  it('also accepts v1-style "negated: true" as excluded', () => {
    const out = parsePhenotypicFeatures(
      [{ type: { id: 'HP:0001260' }, negated: true }],
      PATIENT,
      ctx,
      'test',
    );
    const negs = objectsForPredicate(out.quads, GENOMICS_NS + 'negatedHpoTerm');
    expect(negs).toEqual(['HP:0001260']);
  });

  it('extracts integer years from onset.age.iso8601duration when expressible', () => {
    const out = parsePhenotypicFeatures(
      [{ type: { id: 'HP:0000001' }, onset: { age: { iso8601duration: 'P14Y' } } }],
      PATIENT,
      ctx,
      'test',
    );
    const ages = objectsForPredicate(out.quads, GENOMICS_NS + 'phenotypeOnsetAge');
    expect(ages).toEqual(['14']);
  });

  it('emits info gap for sub-year onset (e.g., P3M)', () => {
    const out = parsePhenotypicFeatures(
      [{ type: { id: 'HP:0030084' }, onset: { age: { iso8601duration: 'P3M' } } }],
      PATIENT,
      ctx,
      'test',
    );
    expect(
      out.gaps.some((g) => g.sourceField.includes('onset.age.iso8601duration')),
    ).toBe(true);
  });

  it('emits info gap for HPO onset class (e.g., HP:0011461 Fetal onset)', () => {
    const out = parsePhenotypicFeatures(
      [{ type: { id: 'HP:0001558' }, onset: { ontologyClass: { id: 'HP:0011461' } } }],
      PATIENT,
      ctx,
      'test',
    );
    expect(out.gaps.some((g) => g.sourceField.endsWith('onset.ontologyClass'))).toBe(true);
  });

  it('emits info gaps for severity, modifiers, evidence', () => {
    const out = parsePhenotypicFeatures(
      [
        {
          type: { id: 'HP:0000001' },
          severity: { id: 'HP:0012825', label: 'Mild' },
          modifiers: [{ id: 'HP:0012834', label: 'Right' }],
          evidence: [{ evidenceCode: { id: 'ECO:0000033' } }],
        },
      ],
      PATIENT,
      ctx,
      'test',
    );
    expect(out.gaps.some((g) => g.sourceField.endsWith('.severity'))).toBe(true);
    expect(out.gaps.some((g) => g.sourceField.endsWith('.modifiers'))).toBe(true);
    expect(out.gaps.some((g) => g.sourceField.endsWith('.evidence'))).toBe(true);
  });

  it('emits warning gap when feature.type.id is missing', () => {
    const out = parsePhenotypicFeatures(
      [{ type: { label: 'no id' } }, { onset: { age: { iso8601duration: 'P5Y' } } }],
      PATIENT,
      ctx,
      'test',
    );
    expect(out.gaps.filter((g) => g.severity === 'warning').length).toBe(2);
    expect(out.attached).toBe(0);
  });

  it('returns empty result for undefined / empty array', () => {
    const a = parsePhenotypicFeatures(undefined, PATIENT, ctx, 'test');
    const b = parsePhenotypicFeatures([], PATIENT, ctx, 'test');
    expect(a.attached).toBe(0);
    expect(b.attached).toBe(0);
  });
});

describe('convertPhenopacket — phenotypicFeatures wiring', () => {
  it('preserves all 4 HPO terms from the retinoblastoma example on the patient', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'retinoblastoma.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    const patient = result.records.find((r) => r.cascadeType === 'cascade:PatientProfile');
    expect(patient).toBeDefined();
    const hpos = objectsForPredicate(patient!.quads, GENOMICS_NS + 'hpoTerm');
    expect(hpos.sort()).toEqual(
      ['HP:0000486', 'HP:0000541', 'HP:0000555', 'HP:0030084'].sort(),
    );
  });

  it('handles excluded features in the v2-phenopacket example', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'v2-phenopacket.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    const patient = result.records.find((r) => r.cascadeType === 'cascade:PatientProfile');
    const negs = objectsForPredicate(patient!.quads, GENOMICS_NS + 'negatedHpoTerm');
    expect(negs).toContain('HP:0031910'); // "Abnormal cranial nerve physiology" is excluded
  });

  it('attaches HPO terms when subject is missing (marfan)', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'marfan.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    const patient = result.records.find((r) => r.cascadeType === 'cascade:PatientProfile');
    const positives = objectsForPredicate(patient!.quads, GENOMICS_NS + 'hpoTerm');
    expect(positives).toContain('HP:0004942'); // Aortic aneurysm
    const negs = objectsForPredicate(patient!.quads, GENOMICS_NS + 'negatedHpoTerm');
    expect(negs).toContain('HP:0002616'); // Aortic root aneurysm (excluded)
  });
});
