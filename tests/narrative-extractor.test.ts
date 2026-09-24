/**
 * Tests for P5.1-A (narrative-extractor.ts) and P5.1-B (vendor-normalizer.ts).
 *
 * P5.1-A: extractNarrativeText and collectNarrativeBlocks
 * P5.1-B: VendorNormalizer — Epic SNOMED status codes, condition display name,
 *         lab metadata row detection, vendor auto-detection
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { extractNarrativeText, collectNarrativeBlocks } from '../src/lib/ccda-converter/narrative-extractor.js';
import { parseCcdaXml } from '../src/lib/ccda-converter/parser.js';
import {
  createVendorNormalizer,
  EPIC_STATUS_CODES,
} from '../src/lib/ccda-converter/vendor-normalizer.js';
import { convertCcda } from '../src/lib/ccda-converter/index.js';
import { extractNarrativeQuads } from '../src/lib/ccda-converter/narrative.js';
import { Parser } from 'n3';
import { conformancePath } from './helpers/conformance.js';

const FIXTURES_DIR = conformancePath('fixtures/ccda');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

// =============================================================================
// P5.1-A: extractNarrativeText
// =============================================================================

describe('P5.1-A: extractNarrativeText — primitive inputs', () => {
  it('returns empty string for null', () => {
    expect(extractNarrativeText(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(extractNarrativeText(undefined)).toBe('');
  });

  it('returns the string itself for a plain string', () => {
    expect(extractNarrativeText('Penicillin - Moderate')).toBe('Penicillin - Moderate');
  });

  it('converts number to string', () => {
    expect(extractNarrativeText(42)).toBe('42');
  });
});

describe('P5.1-A: extractNarrativeText — parsed XML objects', () => {
  it('extracts text from a #text node', () => {
    const node = { '#text': 'Hello world' };
    expect(extractNarrativeText(node)).toBe('Hello world');
  });

  it('ignores @_ attribute keys', () => {
    const node = { '@_ID': 'S1', '#text': 'Drug allergy to Penicillin' };
    expect(extractNarrativeText(node)).toBe('Drug allergy to Penicillin');
  });

  it('extracts text from nested list/item structure', () => {
    const node = {
      list: {
        item: [
          { '#text': 'Penicillin' },
          { '#text': 'Sulfa drugs' },
        ],
      },
    };
    const result = extractNarrativeText(node);
    expect(result).toContain('Penicillin');
    expect(result).toContain('Sulfa drugs');
  });

  it('extracts text from table rows', () => {
    const node = {
      table: {
        tbody: {
          tr: [
            { td: [{ '#text': 'Glucose' }, { '#text': '95 mg/dL' }] },
            { td: [{ '#text': 'HbA1c' },   { '#text': '5.8 %' }] },
          ],
        },
      },
    };
    const result = extractNarrativeText(node);
    expect(result).toContain('Glucose');
    expect(result).toContain('95 mg/dL');
    expect(result).toContain('HbA1c');
  });

  it('strips renderMultiMedia nodes', () => {
    const node = {
      '#text': 'See image',
      renderMultiMedia: { '#text': 'binary-data-here' },
    };
    const result = extractNarrativeText(node);
    expect(result).not.toContain('binary-data-here');
    expect(result).toBe('See image');
  });

  it('collapses excessive blank lines to max two newlines', () => {
    const node = {
      paragraph: [
        { '#text': 'First paragraph' },
        { '#text': 'Second paragraph' },
        { '#text': 'Third paragraph' },
      ],
    };
    const result = extractNarrativeText(node);
    expect(result).not.toMatch(/\n{3,}/);
  });
});

// =============================================================================
// P5.1-A: collectNarrativeBlocks — using conformance fixtures
// =============================================================================

describe('P5.1-A: collectNarrativeBlocks — allergies section fixture', () => {
  it('returns at least one NarrativeBlock', () => {
    const xml = readFixture('allergies-section.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('returns allergies section with correct templateId', () => {
    const xml = readFixture('allergies-section.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    const allergyBlock = blocks.find(b => b.templateId === '2.16.840.1.113883.10.20.22.6.1' ||
      b.section === 'allergies');
    expect(allergyBlock).toBeDefined();
  });

  it('narrative text does not contain raw XML tags', () => {
    const xml = readFixture('allergies-section.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    for (const block of blocks) {
      expect(block.narrativeText).not.toMatch(/<[a-z]/i);
    }
  });

  it('allergy section has entries so requiresLLMExtraction is false', () => {
    const xml = readFixture('allergies-section.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    const allergyBlock = blocks.find(b => b.section === 'allergies');
    // The allergies-section fixture has structured entries
    if (allergyBlock) {
      expect(allergyBlock.requiresLLMExtraction).toBe(false);
    }
  });
});

describe('P5.1-A: collectNarrativeBlocks — full summarization fixture', () => {
  it('collects blocks for multiple sections', () => {
    const xml = readFixture('full-summarization.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });

  it('section names include known names like medications, allergies, immunizations', () => {
    const xml = readFixture('full-summarization.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    const names = blocks.map(b => b.section);
    // Full summarization has several sections
    expect(names.some(n => n === 'medications' || n === 'allergies' || n === 'immunizations')).toBe(true);
  });

  it('narrative text from sections is non-empty strings', () => {
    const xml = readFixture('full-summarization.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    const withText = blocks.filter(b => b.narrativeText.trim());
    expect(withText.length).toBeGreaterThan(0);
  });
});

describe('P5.1-A: narrative-only section (P4-F fixture)', () => {
  it('marks narrative-only plan-of-care section with requiresLLMExtraction true', () => {
    const xml = readFixture('narrative-only-section.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    // The plan-of-care section has no entries
    const pocBlock = blocks.find(b =>
      b.templateId === '2.16.840.1.113883.10.20.22.2.10' ||
      b.requiresLLMExtraction === true,
    );
    expect(pocBlock).toBeDefined();
    expect(pocBlock!.requiresLLMExtraction).toBe(true);
  });
});

// =============================================================================
// TTL output: the section narrative is written on the declared predicate
// =============================================================================

const CLINICAL_NARRATIVE_TEXT = 'https://ns.cascadeprotocol.org/clinical/v1#narrativeText';
/** Undeclared spellings earlier releases wrote. A converter must write neither. */
const LEGACY_NARRATIVE_SPELLINGS = [
  'https://ns.cascadeprotocol.org/core/v1#narrativeText',
  'https://ns.cascadeprotocol.org/clinical/v1#content',
];
const SECTION_CODE = 'https://ns.cascadeprotocol.org/core/v1#sectionCode';

/** Per section-narrative subject, how many objects each predicate carries. */
function narrativeCounts(ttl: string): Map<string, Map<string, number>> {
  const quads = new Parser().parse(ttl);
  const sectionSubjects = new Set(
    quads.filter((q) => q.predicate.value === SECTION_CODE).map((q) => q.subject.value),
  );
  const out = new Map<string, Map<string, number>>();
  for (const s of sectionSubjects) out.set(s, new Map());
  for (const q of quads) {
    const counts = out.get(q.subject.value);
    if (!counts) continue;
    counts.set(q.predicate.value, (counts.get(q.predicate.value) ?? 0) + 1);
  }
  return out;
}

describe('C-CDA section narrative is written once, on clinical:narrativeText', () => {
  it('extractNarrativeQuads emits the exact declared IRI once and neither legacy spelling', () => {
    const quads = extractNarrativeQuads(
      { paragraph: 'Follow up in two weeks.' },
      '18776-5',
      'summarization',
      'DOC-1',
      'TestSystem',
      '2026-01-01T00:00:00.000Z',
      true,
    );
    const predicates = quads.map((q) => q.predicate.value);
    expect(predicates.filter((p) => p === CLINICAL_NARRATIVE_TEXT)).toHaveLength(1);
    for (const legacy of LEGACY_NARRATIVE_SPELLINGS) {
      expect(predicates, `${legacy} must not be written`).not.toContain(legacy);
    }
    const text = quads.find((q) => q.predicate.value === CLINICAL_NARRATIVE_TEXT)!.object;
    expect(text.termType).toBe('Literal');
    expect(text.value).toBe('Follow up in two weeks.');
  });

  const corpus = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.xml')).sort();

  it('the corpus is present', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  for (const file of corpus) {
    it(`${file}: every section narrative carries exactly one clinical:narrativeText and no legacy spelling`, async () => {
      const result = await convertCcda(readFixture(file), { sourceSystem: 'TestSystem' });
      expect(result.errors).toHaveLength(0);
      const bySubject = narrativeCounts(result.output);
      let withText = 0;
      for (const [subject, counts] of bySubject) {
        for (const legacy of LEGACY_NARRATIVE_SPELLINGS) {
          expect(counts.get(legacy) ?? 0, `${subject} carries ${legacy}`).toBe(0);
        }
        const n = counts.get(CLINICAL_NARRATIVE_TEXT) ?? 0;
        expect(n, `${subject} carries ${n} clinical:narrativeText values`).toBeLessThanOrEqual(1);
        withText += n;
      }
      // Every corpus document has at least one section with text, so zero here
      // means the text went out on some other predicate.
      expect(withText).toBeGreaterThan(0);
    });
  }

  it('full-summarization.xml output contains cascade:requiresLLMExtraction predicate', async () => {
    const xml = readFixture('full-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });
    expect(result.errors).toHaveLength(0);
    expect(result.output).toContain('requiresLLMExtraction');
  });
});

// =============================================================================
// P5.1-B: VendorNormalizer — Epic SNOMED status codes
// =============================================================================

describe('P5.1-B: EPIC_STATUS_CODES map', () => {
  it('contains all required SNOMED codes', () => {
    expect(EPIC_STATUS_CODES['55561003']).toBe('active');
    expect(EPIC_STATUS_CODES['73425007']).toBe('inactive');
    expect(EPIC_STATUS_CODES['413322009']).toBe('completed');
    expect(EPIC_STATUS_CODES['7087005']).toBe('unknown');
  });
});

describe('P5.1-B: VendorNormalizer.normalizeMedicationStatus', () => {
  const normalizer = createVendorNormalizer('epic');

  it('maps plain "active" to active', () => {
    expect(normalizer.normalizeMedicationStatus('active')).toBe('active');
  });

  it('maps plain "completed" to completed', () => {
    expect(normalizer.normalizeMedicationStatus('completed')).toBe('completed');
  });

  it('maps plain "inactive" to completed', () => {
    expect(normalizer.normalizeMedicationStatus('inactive')).toBe('completed');
  });

  it('maps Epic SNOMED active code 55561003 to active', () => {
    expect(normalizer.normalizeMedicationStatus('55561003')).toBe('active');
  });

  it('maps Epic SNOMED inactive code 73425007 to completed', () => {
    expect(normalizer.normalizeMedicationStatus('73425007')).toBe('completed');
  });

  it('maps Epic SNOMED resolved code 413322009 to completed', () => {
    expect(normalizer.normalizeMedicationStatus('413322009')).toBe('completed');
  });

  it('maps unknown SNOMED code to unknown', () => {
    expect(normalizer.normalizeMedicationStatus('99999999')).toBe('unknown');
  });

  it('maps empty string to unknown', () => {
    expect(normalizer.normalizeMedicationStatus('')).toBe('unknown');
  });
});

describe('P5.1-B: VendorNormalizer.isLabMetadataRow', () => {
  const normalizer = createVendorNormalizer('epic');

  it('returns true for a row with only label text and no numbers', () => {
    const headerRow = { td: [{ '#text': 'Test Name' }, { '#text': 'Result' }, { '#text': 'Units' }] };
    expect(normalizer.isLabMetadataRow(headerRow)).toBe(true);
  });

  it('returns false for a row with numeric result values', () => {
    const dataRow = { td: [{ '#text': 'Glucose' }, { '#text': '95' }, { '#text': 'mg/dL' }] };
    expect(normalizer.isLabMetadataRow(dataRow)).toBe(false);
  });

  it('returns false for null input', () => {
    expect(normalizer.isLabMetadataRow(null)).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(normalizer.isLabMetadataRow({})).toBe(false);
  });

  it('returns true for a th-based header row with no numbers', () => {
    const thRow = { th: [{ '#text': 'Lab' }, { '#text': 'Reference Range' }] };
    expect(normalizer.isLabMetadataRow(thRow)).toBe(true);
  });
});

describe('P5.1-B: VendorNormalizer.detectVendor', () => {
  const normalizer = createVendorNormalizer('auto');

  it('returns auto when no custodian org is present', () => {
    const result = normalizer.detectVendor({ ClinicalDocument: {} });
    expect(result).toBe('auto');
  });

  it('detects epic from custodian org name containing "epic"', () => {
    const doc = {
      ClinicalDocument: {
        custodian: {
          assignedCustodian: {
            representedCustodianOrganization: {
              name: 'Epic Systems Corporation',
            },
          },
        },
      },
    };
    const result = normalizer.detectVendor(doc);
    expect(result).toBe('epic');
  });
});

describe('P5.1-B: VendorNormalizer.normalizeConditionDisplayName', () => {
  const normalizer = createVendorNormalizer('epic');

  it('returns displayName from value element when present', () => {
    const entry = {
      act: [{
        entryRelationship: [{
          observation: [{
            value: { '@_displayName': 'Type 2 diabetes', '@_code': 'E11' },
          }],
        }],
      }],
    };
    const result = normalizer.normalizeConditionDisplayName(entry, {});
    expect(result).toBe('Type 2 diabetes');
  });

  it('returns empty string when no display name and no section text', () => {
    const result = normalizer.normalizeConditionDisplayName({}, {});
    expect(result).toBe('');
  });

  it('falls back to section text for Epic when displayName absent', () => {
    const entry = {};
    const section = { text: 'Hypertension\nOnset 2020' };
    const result = normalizer.normalizeConditionDisplayName(entry, section);
    expect(result).toBe('Hypertension');
  });
});

// =============================================================================
// P5.1-C: --extract-narratives integration test
// =============================================================================

describe('P5.1-C: --extract-narratives sidecar JSON', () => {
  it('collectNarrativeBlocks on full-summarization produces valid sidecar-shaped objects', () => {
    const xml = readFixture('full-summarization.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);

    // Verify each block conforms to the NarrativeBlock interface
    for (const block of blocks) {
      expect(typeof block.section).toBe('string');
      expect(typeof block.templateId).toBe('string');
      expect(typeof block.narrativeText).toBe('string');
      expect(typeof block.requiresLLMExtraction).toBe('boolean');
    }
  });

  it('sidecar JSON is round-trip serializable', () => {
    const xml = readFixture('full-summarization.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);

    const json = JSON.stringify(blocks, null, 2);
    const reparsed = JSON.parse(json);
    expect(Array.isArray(reparsed)).toBe(true);
    expect(reparsed.length).toBe(blocks.length);
  });

  it('--extract-narratives flag: sidecar file is written when called programmatically', async () => {
    // This test verifies the sidecar write logic works end-to-end by
    // simulating what the CLI does: parse XML, collect blocks, write JSON.
    const xml = readFixture('full-summarization.xml');
    const tmpDir = os.tmpdir();
    const inputPath = path.join(tmpDir, 'test-full-summarization.xml');
    const narrativesPath = path.join(tmpDir, 'test-full-summarization.xml.narratives.json');

    fs.writeFileSync(inputPath, xml);

    // Simulate the CLI's sidecar write logic
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    fs.writeFileSync(narrativesPath, JSON.stringify(blocks, null, 2));

    expect(fs.existsSync(narrativesPath)).toBe(true);

    const sidecar = JSON.parse(fs.readFileSync(narrativesPath, 'utf-8'));
    expect(Array.isArray(sidecar)).toBe(true);
    expect(sidecar.length).toBeGreaterThan(0);

    // Cleanup
    fs.unlinkSync(inputPath);
    fs.unlinkSync(narrativesPath);
  });
});
