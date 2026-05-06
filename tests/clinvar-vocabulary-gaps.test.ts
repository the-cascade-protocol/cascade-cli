/**
 * Vocabulary-gap audit (TASK-2A.7).
 *
 * Verifies the converter surfaces a `VocabularyGap` for every
 * recognized ClinVar source field that has no v1-draft.0.1 mapping —
 * we never silently drop data. Failures here are typically caught
 * during a corpus update (a new ClinVar field appears) and prompt
 * either a vocab-evolution candidate or an explicit info-gap.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertClinvarXml } from '../src/lib/clinvar-converter/index.js';
import type { ImportContext } from '../src/lib/import-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, '../../conformance/fixtures/genomics/clinvar');

const ctx: ImportContext = {
  inputPath: '<test>',
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  sourceSystem: 'clinvar-test',
  options: {},
};

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

describe('clinvar vocabulary-gap audit (TASK-2A.7)', () => {
  it('every gap has the required fields populated', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const r = await convertClinvarXml(xml, ctx);
    expect(r.vocabularyGaps.length).toBeGreaterThan(0);
    for (const g of r.vocabularyGaps) {
      expect(g.sourceField.length, 'sourceField').toBeGreaterThan(0);
      expect(g.reason.length, 'reason').toBeGreaterThan(0);
      expect(['info', 'warning']).toContain(g.severity);
    }
  });

  it('BRCA1 surfaces gaps for every key dropped field', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const r = await convertClinvarXml(xml, ctx);
    const fields = r.vocabularyGaps.map((g) => g.sourceField).join('\n');

    // Variant-level
    expect(fields).toContain('SequenceLocation'); // chr/start/stop/ref/alt VCF
    expect(fields).toContain('AlleleFrequencyList'); // population VAF
    expect(fields).toContain('VariantType'); // structural kind
    expect(fields).toContain('OtherNameList'); // legacy aliases
    // Gene-level (BRCA1 carries Haploinsufficiency)
    expect(fields).toContain('Haploinsufficiency');

    // RCV-level
    expect(fields).toContain('@SubmissionCount');

    // SCV-level
    expect(fields).toMatch(/Classification\/ReviewStatus/); // per-SCV review status
    expect(fields).toMatch(/Classification@DateLastEvaluated/); // per-SCV date
    expect(fields).toMatch(/@SubmissionDate/); // submission lifecycle dates
    expect(fields).toContain('ObservedIn/Method'); // method types
    expect(fields).toContain('ObservedIn/Sample/Origin'); // germline / somatic
    expect(fields).toContain('Citation'); // PMIDs / DOIs

    // Aggregate-level
    expect(fields).toContain('Classifications/GermlineClassification/Citation');
    expect(fields).toContain('TraitMappingList');
  });

  it('every corpus VCV produces a non-zero gap count', async () => {
    const all = [
      'VCV000017661-BRCA1.input.xml',
      'VCV000055448-BRCA2-pathogenic.input.xml',
      'VCV000208804-MLH1-LynchSyndrome.input.xml',
      'VCV000007105-CFTR-deltaF508.input.xml',
    ];
    for (const name of all) {
      const xml = loadFixture(name);
      const r = await convertClinvarXml(xml, ctx);
      expect(r.vocabularyGaps.length, `${name} → gap count`).toBeGreaterThan(0);
    }
  });

  it('warnings target real shape-affecting concerns; info covers v1-draft.0.2 candidates', async () => {
    const xml = loadFixture('VCV000017661-BRCA1.input.xml');
    const r = await convertClinvarXml(xml, ctx);
    const warnings = r.vocabularyGaps.filter((g) => g.severity === 'warning');
    const infos = r.vocabularyGaps.filter((g) => g.severity === 'info');
    expect(infos.length).toBeGreaterThan(0); // most ClinVar fields land here
    // Warnings should be sparse — we use them only when downstream
    // SHACL/contract is materially affected (non-canonical ACMG class,
    // missing required gene symbol, sample origin which affects causality).
    expect(warnings.length).toBeGreaterThan(0); // sample Origin gap should fire
    expect(warnings.length).toBeLessThan(infos.length);
  });
});
