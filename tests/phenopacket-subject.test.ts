/**
 * Tests for phenopacket subject → cascade:PatientProfile parsing (TASK-2B.2).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ImportContext } from '../src/lib/import-types.js';
import { parseSubject } from '../src/lib/phenopacket-converter/subject.js';
import { convertPhenopacket } from '../src/lib/phenopacket-converter/index.js';
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

function findQuad(quads: any[], pred: string): string | undefined {
  return quads.find((q) => q.predicate.value === pred)?.object.value;
}

function findAllQuads(quads: any[], pred: string): string[] {
  return quads.filter((q) => q.predicate.value === pred).map((q) => q.object.value);
}

describe('parseSubject', () => {
  it('emits cascade:PatientProfile type + provenance', () => {
    const out = parseSubject(
      { id: 's1', sex: 'MALE', dateOfBirth: '1970-01-02T00:00:00Z' },
      'p1',
      ctx,
    );
    const types = findAllQuads(out.record.quads, NS.rdf + 'type');
    expect(types).toContain(NS.cascade + 'PatientProfile');
    expect(findQuad(out.record.quads, NS.cascade + 'dataProvenance')).toBe(
      NS.cascade + 'ClinicalGenerated',
    );
    expect(findQuad(out.record.quads, NS.cascade + 'profileId')).toBe('s1');
  });

  it('maps phenopacket sex enum to biologicalSex', () => {
    const cases: Array<[string, string]> = [
      ['MALE', 'male'],
      ['FEMALE', 'female'],
      ['OTHER_SEX', 'intersex'],
      ['UNKNOWN_SEX', 'intersex'],
    ];
    for (const [enumVal, expected] of cases) {
      const out = parseSubject({ id: 's1', sex: enumVal }, 'p1', ctx);
      expect(findQuad(out.record.quads, NS.cascade + 'biologicalSex')).toBe(expected);
    }
  });

  it('emits gap for unknown sex enum', () => {
    const out = parseSubject({ id: 's1', sex: 'WEIRD' }, 'p1', ctx);
    expect(out.gaps.some((g) => g.sourceField === 'subject.sex')).toBe(true);
  });

  it('parses dateOfBirth as xsd:date (date portion only)', () => {
    const out = parseSubject(
      { id: 's1', dateOfBirth: '1970-01-02T10:17:36.000000100Z' },
      'p1',
      ctx,
    );
    expect(findQuad(out.record.quads, NS.cascade + 'dateOfBirth')).toBe('1970-01-02');
  });

  it('captures timeAtLastEncounter as ISO duration string + info gap', () => {
    const out = parseSubject(
      { id: 's1', timeAtLastEncounter: { age: { iso8601duration: 'P14Y' } } },
      'p1',
      ctx,
    );
    expect(findQuad(out.record.quads, NS.cascade + 'ageAtLastEncounter')).toBe('P14Y');
    expect(
      out.gaps.some(
        (g) =>
          g.severity === 'info' && g.sourceField === 'subject.timeAtLastEncounter.age.iso8601duration',
      ),
    ).toBe(true);
  });

  it('captures taxonomy id + label', () => {
    const out = parseSubject(
      { id: 's1', taxonomy: { id: 'NCBITaxon:9606', label: 'homo sapiens' } },
      'p1',
      ctx,
    );
    expect(findQuad(out.record.quads, NS.cascade + 'speciesTaxon')).toBe('NCBITaxon:9606');
    expect(findQuad(out.record.quads, NS.cascade + 'speciesLabel')).toBe('homo sapiens');
  });

  it('emits info gap for alternateIds and karyotypicSex (no v1-draft slot)', () => {
    const out = parseSubject(
      {
        id: 's1',
        alternateIds: ['a', 'b', 'c'],
        karyotypicSex: 'XY',
      },
      'p1',
      ctx,
    );
    expect(out.gaps.some((g) => g.sourceField === 'subject.alternateIds')).toBe(true);
    expect(out.gaps.some((g) => g.sourceField === 'subject.karyotypicSex')).toBe(true);
  });

  it('synthesizes patient IRI + warning gap when subject is undefined', () => {
    const out = parseSubject(undefined, 'phenopacket-marfan', ctx);
    expect(out.record.iri).toMatch(/^urn:uuid:/);
    expect(out.gaps.some((g) => g.severity === 'warning' && g.sourceField === 'subject')).toBe(true);
  });

  it('mints stable IRIs across calls', () => {
    const a = parseSubject({ id: 's1' }, 'p1', ctx);
    const b = parseSubject({ id: 's1' }, 'p1', ctx);
    expect(a.record.iri).toBe(b.record.iri);
  });
});

describe('convertPhenopacket — subject orchestrator wiring', () => {
  it('processes a single phenopacket subject end-to-end', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'v2-phenopacket.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    expect(result.records.length).toBeGreaterThanOrEqual(1);
    const patient = result.records.find((r) => r.cascadeType === 'cascade:PatientProfile');
    expect(patient).toBeDefined();
    expect(patient?.sourceId).toBe('14 year-old boy');
    expect(findQuad(patient!.quads, NS.cascade + 'biologicalSex')).toBe('male');
  });

  it('processes a family resource: proband + relatives', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'v2-family.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    const patients = result.records.filter((r) => r.cascadeType === 'cascade:PatientProfile');
    // 1 proband + 2 relatives = 3 patient profiles
    expect(patients).toHaveLength(3);
    const ids = patients.map((p) => p.sourceId).sort();
    expect(ids).toEqual(['14 year-old boy', 'FATHER', 'MOTHER']);
  });

  it('processes a cohort resource: members[]', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'v2-cohort.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    const patients = result.records.filter((r) => r.cascadeType === 'cascade:PatientProfile');
    expect(patients.length).toBe(3);
  });

  it('handles phenopacket with no subject (marfan): emits warning gap', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'marfan.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    const patients = result.records.filter((r) => r.cascadeType === 'cascade:PatientProfile');
    expect(patients).toHaveLength(1);
    expect(
      result.vocabularyGaps.some((g) => g.severity === 'warning' && g.sourceField === 'subject'),
    ).toBe(true);
  });

  it('handles v1-RC3 phenopacket (tpm3-myopathy)', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'tpm3-myopathy.input.json'), 'utf-8');
    const result = await convertPhenopacket(JSON.parse(text), ctx);
    const patients = result.records.filter((r) => r.cascadeType === 'cascade:PatientProfile');
    expect(patients).toHaveLength(1);
    expect(patients[0].sourceId).toBe('II.2');
  });
});
