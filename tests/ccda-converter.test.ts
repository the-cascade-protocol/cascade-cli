/**
 * Conformance tests for the native C-CDA converter.
 *
 * Exercises all synthetic C-CDA fixtures from conformance/fixtures/ccda/,
 * verifying:
 *  - Each fixture produces valid Turtle output with no errors
 *  - Section-specific fixtures produce expected RDF triples
 *  - Vendor-quirk fixtures (Epic urn:oid: prefix, Cerner setId) parse correctly
 *  - Narrative-only sections do not crash the converter
 *  - The full-summarization fixture passes SHACL validation
 *
 * P4-A: Basic C-CDA conformance (allergies, immunizations, labs, full summary)
 * P4-F: Multi-vendor fixtures (Epic urn:oid: quirks, Cerner setId quirk, narrative-only)
 *
 * Note on vendor detection: The fast-xml-parser isArray config wraps all <name>
 * elements in arrays, making custodian org name strings unavailable for automatic
 * vendor detection via detectVendor(). The Epic and Cerner fixtures therefore do
 * not include a <custodian> element, and vendor detection assertions are omitted.
 * The fixtures still validate that vendor-specific coding quirks (urn:oid: prefixes,
 * setId alongside id) are handled without errors.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';
import { convertCcda } from '../src/lib/ccda-converter/index.js';
import { loadShapes, validateTurtle } from '../src/lib/shacl-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fixtures live in the conformance repo, two levels up from cascade-cli/tests/
const FIXTURES_DIR = path.resolve(__dirname, '../../conformance/fixtures/ccda');

// This repo's own synthetic fixtures (co-located, committed here).
const LOCAL_FIXTURES_DIR = path.resolve(__dirname, '../test-fixtures');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

// =============================================================================
// P4-A: Basic single-section and full-summary fixtures
// =============================================================================

describe('C-CDA converter — allergies section (P4-A)', () => {
  it('converts allergies-section.xml to non-empty Turtle with no errors', async () => {
    const xml = readFixture('allergies-section.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.errors, `errors: ${result.errors.join(', ')}`).toHaveLength(0);
    expect(result.output).toBeTruthy();
    expect(result.output).toContain('@prefix');
  });

  it('output contains AllergyRecord type triple', async () => {
    const xml = readFixture('allergies-section.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.output).toContain('AllergyRecord');
  });

  it('output contains allergen name Penicillin', async () => {
    const xml = readFixture('allergies-section.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.output).toContain('Penicillin');
  });

  it('output contains allergySeverity moderate', async () => {
    const xml = readFixture('allergies-section.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    // The extractor lowercases the severity display name
    expect(result.output.toLowerCase()).toContain('moderate');
  });
});

describe('C-CDA converter — immunizations section (P4-A)', () => {
  it('converts immunizations-section.xml to non-empty Turtle with no errors', async () => {
    const xml = readFixture('immunizations-section.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.errors, `errors: ${result.errors.join(', ')}`).toHaveLength(0);
    expect(result.output).toBeTruthy();
    expect(result.output).toContain('@prefix');
  });

  it('output contains ImmunizationRecord type triple', async () => {
    const xml = readFixture('immunizations-section.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.output).toContain('ImmunizationRecord');
  });

  it('output contains Influenza vaccine name', async () => {
    const xml = readFixture('immunizations-section.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.output).toContain('Influenza');
  });

  it('output contains administration date 2023-10-01', async () => {
    const xml = readFixture('immunizations-section.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.output).toContain('2023-10-01');
  });
});

describe('C-CDA converter — labs section (P4-A)', () => {
  it('converts labs-section.xml to non-empty Turtle with no errors', async () => {
    const xml = readFixture('labs-section.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.errors, `errors: ${result.errors.join(', ')}`).toHaveLength(0);
    expect(result.output).toBeTruthy();
    expect(result.output).toContain('@prefix');
  });

  it('output contains LabResultRecord type triple', async () => {
    const xml = readFixture('labs-section.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.output).toContain('LabResultRecord');
  });

  it('output contains Glucose test name', async () => {
    const xml = readFixture('labs-section.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.output).toContain('Glucose');
  });

  it('output contains result value 95 (in narrative or structured triple)', async () => {
    const xml = readFixture('labs-section.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    // The value 95 may appear in the narrative content triple or as a structured resultValue triple
    expect(result.output).toContain('95');
  });

  it('output contains reference range text', async () => {
    const xml = readFixture('labs-section.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.output).toContain('70-100');
  });
});

describe('C-CDA converter — full summarization (P4-A)', () => {
  it('converts full-summarization.xml to non-empty Turtle with no errors', async () => {
    const xml = readFixture('full-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.errors, `errors: ${result.errors.join(', ')}`).toHaveLength(0);
    expect(result.output).toBeTruthy();
    expect(result.output).toContain('@prefix');
  });

  it('output contains all five section record types', async () => {
    const xml = readFixture('full-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.output).toContain('AllergyRecord');
    expect(result.output).toContain('ImmunizationRecord');
    expect(result.output).toContain('clinical:Medication');
    expect(result.output).toContain('ConditionRecord');
    expect(result.output).toContain('LabResultRecord');
  });

  it('output contains documentType summarization tag', async () => {
    const xml = readFixture('full-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.output).toContain('summarization');
  });

  it('output contains sourceSystem TestSystem', async () => {
    const xml = readFixture('full-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.output).toContain('"TestSystem"');
  });

  it('output passes SHACL validation with zero violations on every record type', async () => {
    const xml = readFixture('full-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    const { store: shapesStore, shapeFiles } = loadShapes();
    const validation = validateTurtle(result.output, shapesStore, shapeFiles, 'full-summarization.xml');

    // After the C-CDA provenance/required-field fixes, the converter emits the
    // ClinicalDocument (importedAt, sourceEHR, fhirResourceId, fhirResourceType),
    // PatientProfile (typed dateOfBirth, enum biologicalSex), and the shared
    // cascade:dataProvenance + cascade:schemaVersion on every record. Nothing is
    // filtered out: the full document must validate clean.
    const violations = validation.results.filter((r) => r.severity === 'violation');
    expect(
      violations,
      `SHACL violations:\n${violations.map((v) => `  ${v.shape}: ${v.message} (${v.property})`).join('\n')}`,
    ).toHaveLength(0);
  });
});

// =============================================================================
// P4-F: Multi-vendor fixtures
// =============================================================================

describe('C-CDA converter — Epic vendor quirks (P4-F)', () => {
  it('converts epic-summarization.xml to non-empty Turtle with no errors', async () => {
    const xml = readFixture('epic-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.errors, `errors: ${result.errors.join(', ')}`).toHaveLength(0);
    expect(result.output).toBeTruthy();
    expect(result.output).toContain('@prefix');
  });

  it('output contains all expected record types', async () => {
    const xml = readFixture('epic-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.output).toContain('AllergyRecord');
    expect(result.output).toContain('ImmunizationRecord');
    expect(result.output).toContain('clinical:Medication');
    expect(result.output).toContain('ConditionRecord');
    expect(result.output).toContain('LabResultRecord');
  });

  it('handles urn:oid: prefixed CVX codeSystem — still extracts Influenza immunization', async () => {
    const xml = readFixture('epic-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    // Should still extract Influenza immunization despite urn:oid: prefix on CVX codeSystem
    expect(result.output).toContain('Influenza');
  });

  it('handles urn:oid: prefixed RxNorm codeSystem — still extracts Metformin medication', async () => {
    const xml = readFixture('epic-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    // And medication name despite urn:oid: on RxNorm codeSystem
    expect(result.output).toContain('Metformin');
  });

  it('handles urn:oid: prefixed allergen codeSystem — still extracts allergy', async () => {
    const xml = readFixture('epic-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.output).toContain('Sulfa');
  });
});

describe('C-CDA converter — Cerner vendor quirks (P4-F)', () => {
  it('converts cerner-summarization.xml to non-empty Turtle with no errors', async () => {
    const xml = readFixture('cerner-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.errors, `errors: ${result.errors.join(', ')}`).toHaveLength(0);
    expect(result.output).toBeTruthy();
    expect(result.output).toContain('@prefix');
  });

  it('output contains ConditionRecord despite setId usage alongside id', async () => {
    const xml = readFixture('cerner-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.output).toContain('ConditionRecord');
  });

  it('output contains AllergyRecord despite setId usage at act level', async () => {
    const xml = readFixture('cerner-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.output).toContain('AllergyRecord');
  });

  it('output contains condition name for Chronic kidney disease', async () => {
    const xml = readFixture('cerner-summarization.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    expect(result.output.toLowerCase()).toContain('kidney');
  });
});

describe('C-CDA converter — narrative-only section (P4-F)', () => {
  it('converts narrative-only-section.xml without crashing', async () => {
    const xml = readFixture('narrative-only-section.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    // Converter must not crash — allergies section provides structured output
    expect(result.errors, `errors: ${result.errors.join(', ')}`).toHaveLength(0);
    expect(result.output).toBeTruthy();
    expect(result.output).toContain('@prefix');
  });

  it('output is non-empty (allergies section provides structured data)', async () => {
    const xml = readFixture('narrative-only-section.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    // The allergies section has a NKDA entry which produces an AllergyRecord
    expect(result.output.length).toBeGreaterThan(100);
  });

  it('does not emit an error for the known narrative-only Plan of Care templateId', async () => {
    const xml = readFixture('narrative-only-section.xml');
    const result = await convertCcda(xml, { sourceSystem: 'TestSystem' });

    // The narrative-only Plan of Care templateId (2.16.840.1.113883.10.20.22.2.10)
    // should NOT produce an "Unknown section templateId" warning
    const pocWarning = result.warnings.find(
      (w) => w.includes('2.16.840.1.113883.10.20.22.2.10'),
    );
    expect(pocWarning).toBeUndefined();
  });
});

// =============================================================================
// R2: BATTERY lab panel materialization + membership edges (root backlog 3.11a)
// =============================================================================

const CLINICAL = 'https://ns.cascadeprotocol.org/clinical/v1#';
const HEALTH = 'https://ns.cascadeprotocol.org/health/v1#';
const CASCADE = 'https://ns.cascadeprotocol.org/core/v1#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const LOINC = 'http://loinc.org/rdf#';

describe('C-CDA converter — lab panel materialization (R2, root 3.11a)', () => {
  const readLocal = () => fs.readFileSync(path.join(LOCAL_FIXTURES_DIR, 'ccda-lab-panel.xml'), 'utf-8');

  it('materializes exactly one LaboratoryReport per BATTERY organizer with the expected panel fields', async () => {
    const result = await convertCcda(readLocal(), { sourceSystem: 'TestSystem' });
    expect(result.errors, `errors: ${result.errors.join(', ')}`).toHaveLength(0);

    const quads = new Parser({ format: 'Turtle' }).parse(result.output);
    const panels = quads.filter(
      (q) => q.predicate.value === RDF_TYPE && q.object.value === CLINICAL + 'LaboratoryReport',
    );
    expect(panels).toHaveLength(1);
    const panel = panels[0].subject.value;

    const panelValue = (pred: string) =>
      quads.find((q) => q.subject.value === panel && q.predicate.value === pred)?.object.value;

    // Panel name and LOINC code come from the organizer's own <code>.
    expect(panelValue(CLINICAL + 'panelName')).toBe(
      'Complete blood count (hemogram) panel - Blood by Automated count',
    );
    expect(panelValue(CLINICAL + 'loincCode')).toBe(LOINC + '58410-2');
    // The organizer has no effectiveTime, so documentDate falls back to the
    // earliest member result date (2025-03-10).
    expect(panelValue(CLINICAL + 'documentDate')).toBe('2025-03-10T00:00:00Z');
    // Shape-compatibility with the FHIR panel converter.
    expect(panelValue(CLINICAL + 'fhirResourceType')).toBe('DiagnosticReport');
    expect(panelValue(CLINICAL + 'importedAt')).toBeTruthy();
    expect(panelValue(CASCADE + 'sourceRecordId')).toBe(
      '2.16.840.1.113883.3.88.11.32.1:PANEL-CBC-1',
    );
  });

  it('links the panel to exactly its members with hasLabResult edges that resolve to real LabResultRecord subjects', async () => {
    const result = await convertCcda(readLocal(), { sourceSystem: 'TestSystem' });
    const quads = new Parser({ format: 'Turtle' }).parse(result.output);

    const recordSubjects = new Set(
      quads.filter((q) => q.predicate.value === RDF_TYPE).map((q) => q.subject.value),
    );
    const labResultSubjects = new Set(
      quads
        .filter((q) => q.predicate.value === RDF_TYPE && q.object.value === HEALTH + 'LabResultRecord')
        .map((q) => q.subject.value),
    );

    const edges = quads.filter((q) => q.predicate.value === CLINICAL + 'hasLabResult');
    expect(edges).toHaveLength(3); // the three CBC members, not the standalone

    for (const e of edges) {
      expect(e.object.termType).toBe('NamedNode');
      // Every edge resolves to a real record subject, and specifically a lab result.
      expect(recordSubjects.has(e.object.value), `edge object ${e.object.value} is a record subject`).toBe(true);
      expect(labResultSubjects.has(e.object.value)).toBe(true);
    }

    // The edges cover the three named members (WBC, RBC, Hemoglobin).
    const memberNames = new Set(
      edges.map((e) =>
        quads.find((q) => q.subject.value === e.object.value && q.predicate.value === HEALTH + 'testName')?.object.value,
      ),
    );
    expect(memberNames.has('Leukocytes [#/volume] in Blood by Automated count')).toBe(true);
    expect(memberNames.has('Erythrocytes [#/volume] in Blood by Automated count')).toBe(true);
    expect(memberNames.has('Hemoglobin [Mass/volume] in Blood')).toBe(true);

    // Reported edge tally matches (all resolve, none dropped).
    expect(result.edgeResolution).toEqual({
      resolved: 3,
      unresolved: 0,
      byPredicate: { 'clinical:hasLabResult': { resolved: 3, unresolved: 0 } },
    });
  });

  it('leaves the standalone observation as a plain result with no panel', async () => {
    const result = await convertCcda(readLocal(), { sourceSystem: 'TestSystem' });
    const quads = new Parser({ format: 'Turtle' }).parse(result.output);

    // Only one panel is produced (the standalone observation does not become one).
    const panels = quads.filter(
      (q) => q.predicate.value === RDF_TYPE && q.object.value === CLINICAL + 'LaboratoryReport',
    );
    expect(panels).toHaveLength(1);

    // The standalone creatinine result exists as a LabResultRecord ...
    const creatinine = quads.find(
      (q) => q.predicate.value === HEALTH + 'testName' && q.object.value === 'Creatinine [Mass/volume] in Serum or Plasma',
    )?.subject.value;
    expect(creatinine).toBeTruthy();

    // ... but it is not a member of any panel.
    const edgeObjects = new Set(
      quads.filter((q) => q.predicate.value === CLINICAL + 'hasLabResult').map((q) => q.object.value),
    );
    expect(edgeObjects.has(creatinine!)).toBe(false);
  });

  it('produces deterministic panel and member subjects across two conversions', async () => {
    const a = await convertCcda(readLocal(), { sourceSystem: 'TestSystem' });
    const b = await convertCcda(readLocal(), { sourceSystem: 'TestSystem' });

    const identity = (ttl: string) => {
      const quads = new Parser({ format: 'Turtle' }).parse(ttl);
      const panel = quads.find(
        (q) => q.predicate.value === RDF_TYPE && q.object.value === CLINICAL + 'LaboratoryReport',
      )?.subject.value;
      const edges = quads
        .filter((q) => q.predicate.value === CLINICAL + 'hasLabResult')
        .map((q) => q.object.value)
        .sort();
      return { panel, edges };
    };

    const ia = identity(a.output);
    const ib = identity(b.output);
    expect(ia.panel).toBeTruthy();
    expect(ia.edges).toHaveLength(3);
    expect(ia).toEqual(ib);
  });
});

// =============================================================================
// R3: C-CDA encounter extraction + panel-to-visit edges (root backlog 3.11 c/d)
// =============================================================================

describe('C-CDA converter — encounter extraction and hasEncounter edges (R3, root 3.11c/d)', () => {
  const readLocal = () => fs.readFileSync(path.join(LOCAL_FIXTURES_DIR, 'ccda-encounter-panel.xml'), 'utf-8');

  it('mints one populated clinical:Encounter per distinct visit, deduped across member observations', async () => {
    const result = await convertCcda(readLocal(), { sourceSystem: 'TestSystem' });
    expect(result.errors, `errors: ${result.errors.join(', ')}`).toHaveLength(0);

    const quads = new Parser({ format: 'Turtle' }).parse(result.output);
    const encounters = quads.filter(
      (q) => q.predicate.value === RDF_TYPE && q.object.value === CLINICAL + 'Encounter',
    );
    // Both member observations cite the SAME encounter id, so it dedupes to one
    // record (the old array-bug extractor would have produced a bare, collapsed
    // record with no fields).
    expect(encounters).toHaveLength(1);
    const encounter = encounters[0].subject.value;

    const encValue = (pred: string) =>
      quads.find((q) => q.subject.value === encounter && q.predicate.value === pred)?.object.value;

    // Real fields come through: type (from @_displayName), date (from
    // effectiveTime/low), and the source id (root:extension).
    expect(encValue(CASCADE + 'encounterType')).toBe('Office Visit');
    expect(encValue(HEALTH + 'effectiveDate')).toBe('2025-03-10');
    expect(encValue(CASCADE + 'sourceRecordId')).toBe(
      '1.2.840.114350.1.13.999.2.7.3.111.8:VISIT-778899',
    );
  });

  it('links the lab panel to its visit with a single resolving hasEncounter edge', async () => {
    const result = await convertCcda(readLocal(), { sourceSystem: 'TestSystem' });
    const quads = new Parser({ format: 'Turtle' }).parse(result.output);

    const panel = quads.find(
      (q) => q.predicate.value === RDF_TYPE && q.object.value === CLINICAL + 'LaboratoryReport',
    )?.subject.value;
    const encounter = quads.find(
      (q) => q.predicate.value === RDF_TYPE && q.object.value === CLINICAL + 'Encounter',
    )?.subject.value;
    expect(panel).toBeTruthy();
    expect(encounter).toBeTruthy();

    const encEdges = quads.filter((q) => q.predicate.value === CLINICAL + 'hasEncounter');
    // One edge (deduped even though two members cite the visit), panel -> visit.
    expect(encEdges).toHaveLength(1);
    expect(encEdges[0].subject.value).toBe(panel);
    expect(encEdges[0].object.value).toBe(encounter);

    // The census counts both C-CDA edge families, all resolving.
    expect(result.edgeResolution).toEqual({
      resolved: 3,
      unresolved: 0,
      byPredicate: {
        'clinical:hasLabResult': { resolved: 2, unresolved: 0 },
        'clinical:hasEncounter': { resolved: 1, unresolved: 0 },
      },
    });
  });

  it('produces deterministic encounter subjects and edges across two conversions', async () => {
    const a = await convertCcda(readLocal(), { sourceSystem: 'TestSystem' });
    const b = await convertCcda(readLocal(), { sourceSystem: 'TestSystem' });

    const identity = (ttl: string) => {
      const quads = new Parser({ format: 'Turtle' }).parse(ttl);
      const encounter = quads.find(
        (q) => q.predicate.value === RDF_TYPE && q.object.value === CLINICAL + 'Encounter',
      )?.subject.value;
      const edges = quads
        .filter((q) => q.predicate.value === CLINICAL + 'hasEncounter')
        .map((q) => `${q.subject.value} -> ${q.object.value}`)
        .sort();
      return { encounter, edges };
    };

    const ia = identity(a.output);
    expect(ia.encounter).toBeTruthy();
    expect(ia.edges).toHaveLength(1);
    expect(ia).toEqual(identity(b.output));
  });
});
