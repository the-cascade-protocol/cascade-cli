/**
 * Vocabulary gap audit tests (TASK-2B.10).
 *
 * Confirms the importer surfaces gaps for every load-bearing field that
 * v1-draft cannot represent natively, plus a full-corpus audit that
 * catches silent data drops.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ImportContext } from '../src/lib/import-types.js';
import { phenopacketImporter } from '../src/lib/phenopacket-converter/registry-entry.js';
import {
  auditPhenopacketTopLevel,
  auditCohortWrapper,
} from '../src/lib/phenopacket-converter/gap-audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.resolve(__dirname, '../../conformance/fixtures/genomics/phenopackets');

const ctx: ImportContext = {
  inputPath: '<test>',
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  options: {},
  sourceSystem: 'audit-test',
};

const TRUE_PHENOPACKETS = [
  'bethlem-myopathy.input.json',
  'covid.input.json',
  'marfan.input.json',
  'retinoblastoma.input.json',
  'tpm3-myopathy.input.json',
  'v2-cohort.input.json',
  'v2-family.input.json',
  'v2-phenopacket.input.json',
];

describe('auditPhenopacketTopLevel', () => {
  it('emits info gap for top-level diseases[]', () => {
    const gaps = auditPhenopacketTopLevel(
      { id: 'p1', diseases: [{ term: { id: 'NCIT:C7541' } }] },
      'test',
    );
    expect(gaps.some((g) => g.sourceField.endsWith('.diseases'))).toBe(true);
  });

  it('emits info gap for top-level measurements[]', () => {
    const gaps = auditPhenopacketTopLevel(
      { id: 'p1', measurements: [{ assay: { id: 'LOINC:79893-4' } }] },
      'test',
    );
    expect(gaps.some((g) => g.sourceField.endsWith('.measurements'))).toBe(true);
  });

  it('emits warning gap for v1-style top-level genes[] / variants[]', () => {
    const gaps = auditPhenopacketTopLevel(
      {
        id: 'p1',
        genes: [{ id: 'NCBIGene:7170', symbol: 'TPM3' }],
        variants: [{ vcfAllele: { genomeAssembly: 'GRCh37' } }],
      },
      'test',
    );
    expect(gaps.find((g) => g.sourceField.endsWith('.genes'))?.severity).toBe('warning');
    expect(gaps.find((g) => g.sourceField.endsWith('.variants'))?.severity).toBe('warning');
  });

  it('emits info gap for metaData.externalReferences and submittedBy', () => {
    const gaps = auditPhenopacketTopLevel(
      {
        id: 'p1',
        metaData: {
          submittedBy: 'PhenopacketLab',
          externalReferences: [{ id: 'PMID:30808312' }],
        },
      },
      'test',
    );
    expect(gaps.some((g) => g.sourceField.endsWith('externalReferences'))).toBe(true);
    expect(gaps.some((g) => g.sourceField.endsWith('submittedBy'))).toBe(true);
  });

  it('does not emit gaps for handled top-level fields (subject, phenotypicFeatures, etc.)', () => {
    const gaps = auditPhenopacketTopLevel(
      {
        id: 'p1',
        subject: { id: 's1' },
        phenotypicFeatures: [],
        interpretations: [],
        biosamples: [],
        medicalActions: [],
        files: [],
        metaData: {},
      },
      'test',
    );
    expect(gaps).toHaveLength(0);
  });

  it('emits info gap for unrecognized top-level field', () => {
    const gaps = auditPhenopacketTopLevel({ id: 'p1', flubber: 42 }, 'test');
    expect(gaps.some((g) => g.sourceField.endsWith('.flubber'))).toBe(true);
  });
});

describe('auditCohortWrapper', () => {
  it('surfaces cohort description as a gap so the string isn’t lost', () => {
    const gaps = auditCohortWrapper({ id: 'c1', description: 'A description.' });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].reason).toContain('A description.');
  });

  it('emits no gap for a cohort without description', () => {
    expect(auditCohortWrapper({ id: 'c1' })).toHaveLength(0);
  });
});

describe('full-corpus gap audit', () => {
  it('every fixture emits at least one info-severity gap', async () => {
    for (const fixture of TRUE_PHENOPACKETS) {
      const text = fs.readFileSync(path.join(FIXTURES_DIR, fixture), 'utf-8');
      const result = await phenopacketImporter.convert(text, 'cascade', ctx);
      const infoGaps = (result.vocabularyGaps ?? []).filter((g) => g.severity === 'info');
      expect(infoGaps.length, `expected info gaps for ${fixture}`).toBeGreaterThan(0);
    }
  });

  it('tpm3-myopathy: emits warning gaps for v1 genes[] + variants[]', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'tpm3-myopathy.input.json'), 'utf-8');
    const result = await phenopacketImporter.convert(text, 'cascade', ctx);
    const warnings = (result.vocabularyGaps ?? []).filter((g) => g.severity === 'warning');
    expect(warnings.some((g) => g.sourceField.endsWith('.genes'))).toBe(true);
    expect(warnings.some((g) => g.sourceField.endsWith('.variants'))).toBe(true);
  });

  it('retinoblastoma: emits gap for top-level diseases[] and measurements[]', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'retinoblastoma.input.json'), 'utf-8');
    const result = await phenopacketImporter.convert(text, 'cascade', ctx);
    expect(
      (result.vocabularyGaps ?? []).some((g) => g.sourceField.endsWith('.diseases')),
    ).toBe(true);
    expect(
      (result.vocabularyGaps ?? []).some((g) => g.sourceField.endsWith('.measurements')),
    ).toBe(true);
  });

  it('v2-cohort: emits gap for cohort.description', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'v2-cohort.input.json'), 'utf-8');
    const result = await phenopacketImporter.convert(text, 'cascade', ctx);
    expect(
      (result.vocabularyGaps ?? []).some((g) => g.sourceField === 'cohort.description'),
    ).toBe(true);
  });

  it('full corpus: total gaps emitted exceeds 100 (defends against silent drop regressions)', async () => {
    let total = 0;
    for (const fixture of TRUE_PHENOPACKETS) {
      const text = fs.readFileSync(path.join(FIXTURES_DIR, fixture), 'utf-8');
      const result = await phenopacketImporter.convert(text, 'cascade', ctx);
      total += (result.vocabularyGaps ?? []).length;
    }
    expect(total).toBeGreaterThan(100);
  });

  it('every emitted gap has a non-empty sourceField + reason', async () => {
    for (const fixture of TRUE_PHENOPACKETS) {
      const text = fs.readFileSync(path.join(FIXTURES_DIR, fixture), 'utf-8');
      const result = await phenopacketImporter.convert(text, 'cascade', ctx);
      for (const g of result.vocabularyGaps ?? []) {
        expect(g.sourceField.length).toBeGreaterThan(0);
        expect(g.reason.length).toBeGreaterThan(0);
        expect(['info', 'warning']).toContain(g.severity);
      }
    }
  });
});
