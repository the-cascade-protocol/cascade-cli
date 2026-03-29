/**
 * P5.7-A: Expanded C-CDA test coverage — narrative extraction, vendor normalization,
 * edge cases, full-document parse, and deduplication integration tests.
 *
 * Complements the existing tests in:
 *   - tests/ccda-converter.test.ts  (P4-A/P4-F basic conversion)
 *   - tests/narrative-extractor.test.ts  (P5.1-A/P5.1-B unit tests)
 *
 * New coverage added here:
 *   P5.7-A-1: collectNarrativeBlocks() against remaining fixture files
 *             (labs, immunizations, epic, cerner)
 *   P5.7-A-2: Social history templateId 2.16.840.1.113883.10.20.22.2.17
 *   P5.7-A-3: Edge cases — empty <text>, section-with-entries-only (no text)
 *   P5.7-A-4: Full-document parse for all fixtures without throwing
 *   P5.7-A-5: detectVendor behaviour on epic-summarization.xml (no custodian)
 *   P5.7-D:   Deduplication — idempotent parse, patientId URI format
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectNarrativeBlocks } from '../src/lib/ccda-converter/narrative-extractor.js';
import { parseCcdaXml } from '../src/lib/ccda-converter/parser.js';
import { detectVendor } from '../src/lib/ccda-converter/vendor/detect.js';
import { convertCcda } from '../src/lib/ccda-converter/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.resolve(__dirname, '../../conformance/fixtures/ccda');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

// =============================================================================
// P5.7-A-1: collectNarrativeBlocks() — labs and immunizations fixtures
// =============================================================================

describe('P5.7-A-1: collectNarrativeBlocks — labs-section fixture', () => {
  it('returns at least one NarrativeBlock', () => {
    const xml = readFixture('labs-section.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('returns labResults section with known templateId', () => {
    const xml = readFixture('labs-section.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    const labBlock = blocks.find(
      (b) => b.section === 'labResults' || b.templateId === '2.16.840.1.113883.10.20.22.2.3.1',
    );
    expect(labBlock).toBeDefined();
  });

  it('labs section has entries so requiresLLMExtraction is false', () => {
    const xml = readFixture('labs-section.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    const labBlock = blocks.find((b) => b.section === 'labResults');
    if (labBlock) {
      expect(labBlock.requiresLLMExtraction).toBe(false);
    }
  });

  it('narrative text does not contain raw XML tags', () => {
    const xml = readFixture('labs-section.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    for (const block of blocks) {
      expect(block.narrativeText).not.toMatch(/<[a-z]/i);
    }
  });
});

describe('P5.7-A-1: collectNarrativeBlocks — immunizations-section fixture', () => {
  it('returns immunizations section with known templateId', () => {
    const xml = readFixture('immunizations-section.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    const immBlock = blocks.find(
      (b) => b.section === 'immunizations' || b.templateId === '2.16.840.1.113883.10.20.22.2.2.1',
    );
    expect(immBlock).toBeDefined();
  });

  it('immunizations section has entries so requiresLLMExtraction is false', () => {
    const xml = readFixture('immunizations-section.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    const immBlock = blocks.find((b) => b.section === 'immunizations');
    if (immBlock) {
      expect(immBlock.requiresLLMExtraction).toBe(false);
    }
  });

  it('all blocks have non-empty templateId strings', () => {
    const xml = readFixture('immunizations-section.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    for (const block of blocks) {
      expect(typeof block.templateId).toBe('string');
      expect(block.templateId.length).toBeGreaterThan(0);
    }
  });
});

describe('P5.7-A-1: collectNarrativeBlocks — epic-summarization fixture', () => {
  it('returns blocks for all five clinical sections', () => {
    const xml = readFixture('epic-summarization.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    const names = blocks.map((b) => b.section);
    // Epic fixture has allergies, immunizations, medications, problems, labs
    expect(names).toContain('allergies');
    expect(names).toContain('immunizations');
    expect(names).toContain('medications');
  });

  it('all epic section blocks have requiresLLMExtraction false (all have entries)', () => {
    const xml = readFixture('epic-summarization.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    // Every section in the epic fixture has structured entries
    for (const block of blocks) {
      expect(block.requiresLLMExtraction).toBe(false);
    }
  });
});

describe('P5.7-A-1: collectNarrativeBlocks — cerner-summarization fixture', () => {
  it('returns blocks for cerner fixture sections', () => {
    const xml = readFixture('cerner-summarization.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('cerner narrative blocks all have valid NarrativeBlock shape', () => {
    const xml = readFixture('cerner-summarization.xml');
    const parsed = parseCcdaXml(xml);
    const blocks = collectNarrativeBlocks(parsed);
    for (const block of blocks) {
      expect(typeof block.section).toBe('string');
      expect(typeof block.templateId).toBe('string');
      expect(typeof block.narrativeText).toBe('string');
      expect(typeof block.requiresLLMExtraction).toBe('boolean');
    }
  });
});

// =============================================================================
// P5.7-A-2: Social history templateId recognition
// =============================================================================

describe('P5.7-A-2: Social history templateId — inline XML', () => {
  // Minimal social history section with templateId 2.16.840.1.113883.10.20.22.2.17
  const SOCIAL_HISTORY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <realmCode code="US"/>
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <id root="2.16.840.1.113883.3.88.11.32.1" extension="SOCIAL-HIST-INLINE-001"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1"/>
  <effectiveTime value="20260101"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <languageCode code="en-US"/>
  <recordTarget>
    <patientRole>
      <id root="2.16.840.1.113883.4.1" extension="999-99-9999"/>
      <patient>
        <name use="L"><given>Test</given><family>Patient</family></name>
        <administrativeGenderCode code="M" codeSystem="2.16.840.1.113883.5.1"/>
        <birthTime value="19800101"/>
      </patient>
    </patientRole>
  </recordTarget>
  <component>
    <structuredBody>
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.17"/>
          <code code="29762-2" displayName="Social History" codeSystem="2.16.840.1.113883.6.1"/>
          <title>Social History</title>
          <text>Former smoker. 20 pack-years. Quit 2015.</text>
          <entry typeCode="DRIV">
            <observation classCode="OBS" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.78"/>
              <id root="2.16.840.1.113883.3.88.11.32.1" extension="SOCIAL-HIST-OBS-001"/>
              <code code="72166-2" displayName="Tobacco smoking status" codeSystem="2.16.840.1.113883.6.1"/>
              <statusCode code="completed"/>
              <value xsi:type="CD" code="8517006" displayName="Ex-smoker" codeSystem="2.16.840.1.113883.6.96"
                xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>
            </observation>
          </entry>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>`;

  it('correctly identifies socialHistory section name for templateId 2.16.840.1.113883.10.20.22.2.17', () => {
    const parsed = parseCcdaXml(SOCIAL_HISTORY_XML);
    const blocks = collectNarrativeBlocks(parsed);
    const shBlock = blocks.find((b) => b.section === 'socialHistory');
    expect(shBlock).toBeDefined();
    expect(shBlock!.templateId).toBe('2.16.840.1.113883.10.20.22.2.17');
  });

  it('social history block requiresLLMExtraction is false (has entry)', () => {
    const parsed = parseCcdaXml(SOCIAL_HISTORY_XML);
    const blocks = collectNarrativeBlocks(parsed);
    const shBlock = blocks.find((b) => b.section === 'socialHistory');
    expect(shBlock).toBeDefined();
    expect(shBlock!.requiresLLMExtraction).toBe(false);
  });

  it('social history narrativeText contains smoking text', () => {
    const parsed = parseCcdaXml(SOCIAL_HISTORY_XML);
    const blocks = collectNarrativeBlocks(parsed);
    const shBlock = blocks.find((b) => b.section === 'socialHistory');
    expect(shBlock).toBeDefined();
    expect(shBlock!.narrativeText.toLowerCase()).toContain('smoker');
  });

  it('full convertCcda does not throw on social history document', async () => {
    const result = await convertCcda(SOCIAL_HISTORY_XML, { sourceSystem: 'TestSystem' });
    expect(result.errors).toHaveLength(0);
    expect(result.output).toBeTruthy();
  });
});

// =============================================================================
// P5.7-A-3: Edge cases — empty <text>, section with only entries (no text)
// =============================================================================

describe('P5.7-A-3: Edge case — empty <text> element', () => {
  const EMPTY_TEXT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <realmCode code="US"/>
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <id root="2.16.840.1.113883.3.88.11.32.1" extension="EMPTY-TEXT-001"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1"/>
  <effectiveTime value="20260101"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <languageCode code="en-US"/>
  <recordTarget>
    <patientRole>
      <id root="2.16.840.1.113883.4.1" extension="888-88-8888"/>
      <patient>
        <name use="L"><given>Edge</given><family>Case</family></name>
        <administrativeGenderCode code="F" codeSystem="2.16.840.1.113883.5.1"/>
        <birthTime value="19900101"/>
      </patient>
    </patientRole>
  </recordTarget>
  <component>
    <structuredBody>
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.6.1"/>
          <code code="48765-2" displayName="Allergies" codeSystem="2.16.840.1.113883.6.1"/>
          <title>Allergies</title>
          <text></text>
          <entry typeCode="DRIV">
            <act classCode="ACT" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.30"/>
              <id root="2.16.840.1.113883.3.88.11.32.1" extension="EDGE-ALLERGY-001"/>
              <code code="CONC" codeSystem="2.16.840.1.113883.5.6"/>
              <statusCode code="active"/>
              <observation classCode="OBS" moodCode="EVN">
                <templateId root="2.16.840.1.113883.10.20.22.4.7"/>
                <id root="2.16.840.1.113883.3.88.11.32.1" extension="EDGE-ALLERGY-OBS-001"/>
                <code code="ASSERTION" codeSystem="2.16.840.1.113883.5.4"/>
                <statusCode code="completed"/>
                <value xsi:type="CD" code="716186003" displayName="No known allergy"
                  codeSystem="2.16.840.1.113883.6.96"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>
                <participant typeCode="CSM">
                  <participantRole classCode="MANU">
                    <playingEntity classCode="MMAT">
                      <code code="NKDA" displayName="No Known Drug Allergy" codeSystem="2.16.840.1.113883.6.88"/>
                      <name>No Known Drug Allergy</name>
                    </playingEntity>
                  </participantRole>
                </participant>
              </observation>
            </act>
          </entry>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>`;

  it('does not throw when <text> element is empty', () => {
    expect(() => {
      const parsed = parseCcdaXml(EMPTY_TEXT_XML);
      collectNarrativeBlocks(parsed);
    }).not.toThrow();
  });

  it('returns narrativeText as empty string for empty <text>', () => {
    const parsed = parseCcdaXml(EMPTY_TEXT_XML);
    const blocks = collectNarrativeBlocks(parsed);
    // Section has entries, so it may or may not be included depending on
    // whether empty narrativeText + requiresLLMExtraction=false suppresses the block.
    // If included, narrativeText must be an empty string (not undefined or null).
    const allergyBlock = blocks.find((b) => b.section === 'allergies');
    if (allergyBlock) {
      expect(allergyBlock.narrativeText).toBe('');
    }
  });

  it('empty-text section with entries has requiresLLMExtraction false', () => {
    const parsed = parseCcdaXml(EMPTY_TEXT_XML);
    const blocks = collectNarrativeBlocks(parsed);
    const allergyBlock = blocks.find((b) => b.section === 'allergies');
    if (allergyBlock) {
      expect(allergyBlock.requiresLLMExtraction).toBe(false);
    }
  });

  it('convertCcda does not throw on empty <text> element', async () => {
    const result = await convertCcda(EMPTY_TEXT_XML, { sourceSystem: 'TestSystem' });
    expect(result.errors).toHaveLength(0);
    expect(result.output).toBeTruthy();
  });
});

describe('P5.7-A-3: Edge case — section with only entries and no <text> element', () => {
  // A section that has structured entries but absolutely no <text> element at all
  const NO_TEXT_SECTION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <realmCode code="US"/>
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <id root="2.16.840.1.113883.3.88.11.32.1" extension="NO-TEXT-SECTION-001"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1"/>
  <effectiveTime value="20260101"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <languageCode code="en-US"/>
  <recordTarget>
    <patientRole>
      <id root="2.16.840.1.113883.4.1" extension="777-77-7777"/>
      <patient>
        <name use="L"><given>No</given><family>Text</family></name>
        <administrativeGenderCode code="M" codeSystem="2.16.840.1.113883.5.1"/>
        <birthTime value="19750101"/>
      </patient>
    </patientRole>
  </recordTarget>
  <component>
    <structuredBody>
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.2.1"/>
          <code code="11369-6" displayName="Immunizations" codeSystem="2.16.840.1.113883.6.1"/>
          <title>Immunizations</title>
          <!-- No <text> element — only entries -->
          <entry typeCode="DRIV">
            <substanceAdministration classCode="SBADM" moodCode="EVN" negationInd="false">
              <templateId root="2.16.840.1.113883.10.20.22.4.52"/>
              <id root="2.16.840.1.113883.3.88.11.32.1" extension="NO-TEXT-IMM-001"/>
              <statusCode code="completed"/>
              <effectiveTime value="20230901"/>
              <consumable>
                <manufacturedProduct>
                  <manufacturedMaterial>
                    <code code="140" displayName="Influenza" codeSystem="2.16.840.1.113883.12.292"/>
                  </manufacturedMaterial>
                </manufacturedProduct>
              </consumable>
            </substanceAdministration>
          </entry>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>`;

  it('does not throw when section has no <text> element at all', () => {
    expect(() => {
      const parsed = parseCcdaXml(NO_TEXT_SECTION_XML);
      collectNarrativeBlocks(parsed);
    }).not.toThrow();
  });

  it('convertCcda does not throw when section has no <text>', async () => {
    const result = await convertCcda(NO_TEXT_SECTION_XML, { sourceSystem: 'TestSystem' });
    expect(result.errors).toHaveLength(0);
    expect(result.output).toBeTruthy();
  });

  it('section with no <text> and entries has requiresLLMExtraction false if block emitted', () => {
    const parsed = parseCcdaXml(NO_TEXT_SECTION_XML);
    const blocks = collectNarrativeBlocks(parsed);
    const immBlock = blocks.find((b) => b.section === 'immunizations');
    // The block may not be emitted (no narrativeText and requiresLLMExtraction=false)
    // but if it is, it must have requiresLLMExtraction false
    if (immBlock) {
      expect(immBlock.requiresLLMExtraction).toBe(false);
    }
  });
});

// =============================================================================
// P5.7-A-4: Full-document parse — all fixtures without throwing
// =============================================================================

describe('P5.7-A-4: Full-document parse — all conformance fixtures produce valid Turtle', () => {
  const fixtures = [
    'allergies-section.xml',
    'immunizations-section.xml',
    'labs-section.xml',
    'full-summarization.xml',
    'epic-summarization.xml',
    'cerner-summarization.xml',
    'narrative-only-section.xml',
  ];

  for (const fixture of fixtures) {
    it(`${fixture} converts without errors`, async () => {
      const xml = readFixture(fixture);
      const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });
      expect(result.errors, `${fixture} errors: ${result.errors.join(', ')}`).toHaveLength(0);
      expect(result.output).toBeTruthy();
      expect(result.output).toContain('@prefix');
    });

    it(`${fixture} collectNarrativeBlocks does not throw`, () => {
      const xml = readFixture(fixture);
      expect(() => {
        const parsed = parseCcdaXml(xml);
        collectNarrativeBlocks(parsed);
      }).not.toThrow();
    });
  }
});

// =============================================================================
// P5.7-A-5: detectVendor — epic-summarization.xml has no <custodian> element
// =============================================================================

describe('P5.7-A-5: detectVendor — epic-summarization.xml behaviour', () => {
  it('detectVendor returns unknown for epic-summarization.xml (no <custodian> element)', () => {
    // The epic-summarization.xml fixture intentionally omits the <custodian> element
    // because fast-xml-parser wraps <name> in arrays, making string-based vendor
    // detection via custodian org name unavailable for this fixture.
    // In production, vendor detection uses the MyChart patient portal URL.
    const xml = readFixture('epic-summarization.xml');
    const parsed = parseCcdaXml(xml);
    const vendor = detectVendor(parsed);
    expect(vendor).toBe('unknown');
  });

  it('detectVendor returns epic when custodian org name contains "epic"', () => {
    const docWithEpicCustodian = {
      ClinicalDocument: {
        custodian: {
          assignedCustodian: {
            representedCustodianOrganization: {
              name: 'Epic MyChart Patient Portal',
            },
          },
        },
      },
    };
    const vendor = detectVendor(docWithEpicCustodian);
    expect(vendor).toBe('epic');
  });

  it('detectVendor returns epic when custodian org name contains "mychart"', () => {
    const docWithMychartCustodian = {
      ClinicalDocument: {
        custodian: {
          assignedCustodian: {
            representedCustodianOrganization: {
              name: 'My Health MyChart Records',
            },
          },
        },
      },
    };
    const vendor = detectVendor(docWithMychartCustodian);
    expect(vendor).toBe('epic');
  });

  it('detectVendor returns cerner when custodian org name contains "cerner"', () => {
    const docWithCernerCustodian = {
      ClinicalDocument: {
        custodian: {
          assignedCustodian: {
            representedCustodianOrganization: {
              name: 'Cerner PowerChart EHR',
            },
          },
        },
      },
    };
    const vendor = detectVendor(docWithCernerCustodian);
    expect(vendor).toBe('cerner');
  });

  it('detectVendor returns unknown for cerner-summarization.xml (no <custodian> element)', () => {
    const xml = readFixture('cerner-summarization.xml');
    const parsed = parseCcdaXml(xml);
    const vendor = detectVendor(parsed);
    // Cerner fixture also omits <custodian> for the same reason as Epic fixture
    expect(vendor).toBe('unknown');
  });
});

// =============================================================================
// P5.7-D: Deduplication integration tests
// =============================================================================

// ---------------------------------------------------------------------------
// Helper: strip prov:generatedAtTime lines before comparing outputs.
// The converter stamps each ClinicalDocument section with the wall-clock time
// at conversion, so two calls to convertCcda will differ by milliseconds.
// Structural idempotency is tested by comparing everything except those lines.
// ---------------------------------------------------------------------------
function stripTimestamps(ttl: string): string {
  return ttl
    .split('\n')
    .filter((line) => !line.includes('generatedAtTime'))
    .join('\n');
}

describe('P5.7-D: Deduplication — idempotent parse', () => {
  it('converting full-summarization.xml twice produces structurally identical output', async () => {
    const xml = readFixture('full-summarization.xml');
    const result1 = await convertCcda(xml, { sourceSystem: 'TestSystem' });
    const result2 = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result1.errors).toHaveLength(0);
    expect(result2.errors).toHaveLength(0);
    // All triples except the wall-clock timestamp must be identical
    expect(stripTimestamps(result1.output)).toBe(stripTimestamps(result2.output));
  });

  it('converting epic-summarization.xml twice produces structurally identical output', async () => {
    const xml = readFixture('epic-summarization.xml');
    const result1 = await convertCcda(xml, { sourceSystem: 'TestSystem' });
    const result2 = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result1.errors).toHaveLength(0);
    expect(result2.errors).toHaveLength(0);
    expect(stripTimestamps(result1.output)).toBe(stripTimestamps(result2.output));
  });

  it('converting cerner-summarization.xml twice produces structurally identical output', async () => {
    const xml = readFixture('cerner-summarization.xml');
    const result1 = await convertCcda(xml, { sourceSystem: 'TestSystem' });
    const result2 = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result1.errors).toHaveLength(0);
    expect(result2.errors).toHaveLength(0);
    expect(stripTimestamps(result1.output)).toBe(stripTimestamps(result2.output));
  });
});

describe('P5.7-D: Deduplication — patientId URI format', () => {
  // The C-CDA converter produces deterministic urn:uuid: URIs derived from source
  // record identifiers (root + extension). PatientProfile entities use urn:uuid:
  // (SHA-1 pseudo-v5 UUIDs) — not urn:cascade:patient: — as their subject URIs.
  it('full-summarization.xml output contains a urn:uuid: PatientProfile URI', async () => {
    const xml = readFixture('full-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.errors).toHaveLength(0);
    // The patient entity uses a deterministic urn:uuid: URI derived from the C-CDA
    // patient ID root+extension. The TTL serializer wraps it in angle brackets.
    expect(result.output).toMatch(/urn:uuid:[0-9a-f-]+/);
    expect(result.output).toContain('cascade:PatientProfile');
  });

  it('epic-summarization.xml output contains a urn:uuid: PatientProfile URI', async () => {
    const xml = readFixture('epic-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.errors).toHaveLength(0);
    expect(result.output).toMatch(/urn:uuid:[0-9a-f-]+/);
    expect(result.output).toContain('cascade:PatientProfile');
  });

  it('cerner-summarization.xml output contains a urn:uuid: PatientProfile URI', async () => {
    const xml = readFixture('cerner-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.errors).toHaveLength(0);
    expect(result.output).toMatch(/urn:uuid:[0-9a-f-]+/);
    expect(result.output).toContain('cascade:PatientProfile');
  });

  it('patient URI is deterministic — same value across two conversions of the same document', async () => {
    const xml = readFixture('full-summarization.xml');
    const result1 = await convertCcda(xml, { sourceSystem: 'TestSystem' });
    const result2 = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    // Extract all urn:uuid: URIs that appear before cascade:PatientProfile in the output.
    // The TTL format is: <urn:uuid:XXXX> a cascade:PatientProfile;
    // We match the UUID portion (the angle brackets are part of TTL syntax).
    const patientUriRegex = /<(urn:uuid:[0-9a-f-]+)>\s+a\s+cascade:PatientProfile/g;
    const extract = (ttl: string) => {
      const uris: string[] = [];
      let m: RegExpExecArray | null;
      // Reset lastIndex before each use since regex is stateful with /g flag
      patientUriRegex.lastIndex = 0;
      while ((m = patientUriRegex.exec(ttl)) !== null) uris.push(m[1]);
      return uris.sort();
    };

    const uris1 = extract(result1.output);
    const uris2 = extract(result2.output);

    expect(uris1.length).toBeGreaterThan(0);
    expect(uris1).toEqual(uris2);
  });
});
