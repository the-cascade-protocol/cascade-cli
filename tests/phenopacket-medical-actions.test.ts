/**
 * Tests for phenopacket medicalActions[] → checkup:recommendedActions text
 * on the patient (TASK-2B.8).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ImportContext } from '../src/lib/import-types.js';
import { parseMedicalActions } from '../src/lib/phenopacket-converter/medical-actions.js';
import { convertPhenopacket } from '../src/lib/phenopacket-converter/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.resolve(__dirname, '../../conformance/fixtures/genomics/phenopackets');
const CHECKUP_NS = 'https://ns.cascadeprotocol.org/checkup/v1#';

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

describe('parseMedicalActions', () => {
  it('serializes a procedure to free text', () => {
    const out = parseMedicalActions(
      [
        {
          procedure: {
            code: { id: 'NCIT:C48601', label: 'Enucleation' },
            bodySite: { id: 'UBERON:0004548', label: 'left eye' },
            performed: { age: { iso8601duration: 'P8M2W' } },
          },
        },
      ],
      PATIENT,
      ctx,
      'test',
    );
    const texts = objectsForPredicate(out.quads, CHECKUP_NS + 'recommendedActions');
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Enucleation');
    expect(texts[0]).toContain('left eye');
  });

  it('serializes a treatment with dosing', () => {
    const out = parseMedicalActions(
      [
        {
          treatment: {
            agent: { id: 'DrugCentral:1678', label: 'melphalan' },
            routeOfAdministration: { id: 'NCIT:C38222', label: 'Intraarterial Route' },
            doseIntervals: [
              {
                quantity: { unit: { label: 'mg/kg' }, value: 0.4 },
                scheduleFrequency: { label: 'Once' },
              },
            ],
          },
        },
      ],
      PATIENT,
      ctx,
      'test',
    );
    const texts = objectsForPredicate(out.quads, CHECKUP_NS + 'recommendedActions');
    expect(texts[0]).toContain('melphalan');
    expect(texts[0]).toContain('Intraarterial');
    expect(texts[0]).toContain('0.4 mg/kg');
    // Info gap for dose intervals
    expect(out.gaps.some((g) => g.sourceField.endsWith('.doseIntervals'))).toBe(true);
  });

  it('serializes a therapeutic regimen', () => {
    const out = parseMedicalActions(
      [
        {
          therapeuticRegimen: {
            ontologyClass: { id: 'NCIT:C10894', label: 'Carboplatin/Etoposide/Vincristine' },
            startTime: { age: { iso8601duration: 'P7M' } },
            endTime: { age: { iso8601duration: 'P8M' } },
            regimenStatus: 'COMPLETED',
          },
        },
      ],
      PATIENT,
      ctx,
      'test',
    );
    const texts = objectsForPredicate(out.quads, CHECKUP_NS + 'recommendedActions');
    expect(texts[0]).toContain('Carboplatin/Etoposide/Vincristine');
    expect(texts[0]).toContain('COMPLETED');
  });

  it('serializes a radiation therapy entry', () => {
    const out = parseMedicalActions(
      [
        {
          radiationTherapy: {
            modality: { id: 'NCIT:C15313', label: 'Photon Beam Radiation' },
            bodySite: { id: 'UBERON:0001456', label: 'face' },
            dosage: 60,
            fractions: 30,
          },
        },
      ],
      PATIENT,
      ctx,
      'test',
    );
    const texts = objectsForPredicate(out.quads, CHECKUP_NS + 'recommendedActions');
    expect(texts[0]).toContain('Photon Beam Radiation');
    expect(texts[0]).toContain('dose=60');
    expect(texts[0]).toContain('fractions=30');
  });

  it('emits gaps for treatmentTarget / treatmentIntent / adverseEvents', () => {
    const out = parseMedicalActions(
      [
        {
          treatment: {
            agent: { id: 'X', label: 'X' },
            doseIntervals: [{ quantity: { unit: { label: 'mg' }, value: 1 } }],
          },
          treatmentTarget: { id: 'NCIT:C7541', label: 'Retinoblastoma' },
          treatmentIntent: { id: 'NCIT:C62220', label: 'Cure' },
          adverseEvents: [{ id: 'HP:0025637' }],
        },
      ],
      PATIENT,
      ctx,
      'test',
    );
    expect(out.gaps.some((g) => g.sourceField.endsWith('.treatmentTarget'))).toBe(true);
    expect(out.gaps.some((g) => g.sourceField.endsWith('.treatmentIntent'))).toBe(true);
    expect(out.gaps.some((g) => g.sourceField.endsWith('.adverseEvents'))).toBe(true);
  });

  it('returns no quads for empty / undefined input', () => {
    const a = parseMedicalActions(undefined, PATIENT, ctx, 'test');
    const b = parseMedicalActions([], PATIENT, ctx, 'test');
    expect(a.quads).toHaveLength(0);
    expect(b.quads).toHaveLength(0);
  });
});

describe('convertPhenopacket — medicalActions integration (retinoblastoma)', () => {
  it('emits 3 recommendedActions for the 3 retinoblastoma medicalActions', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'retinoblastoma.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    const patient = result.records.find((r) => r.cascadeType === 'cascade:PatientProfile')!;
    const texts = objectsForPredicate(patient.quads, CHECKUP_NS + 'recommendedActions');
    expect(texts.length).toBe(3);
    // Sanity: at least one mentions melphalan, one mentions the regimen, one mentions Enucleation
    expect(texts.some((t) => t.toLowerCase().includes('melphalan'))).toBe(true);
    expect(texts.some((t) => t.toLowerCase().includes('regimen'))).toBe(true);
    expect(texts.some((t) => t.toLowerCase().includes('enucleation'))).toBe(true);
  });
});
