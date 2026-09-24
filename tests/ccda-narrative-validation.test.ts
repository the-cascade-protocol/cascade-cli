/**
 * C-CDA section narratives validate against ClinicalDocumentShape, with the
 * narrative on the predicate the shape actually constrains.
 *
 * The converter used to write the section text as `cascade:narrativeText` and
 * again as `clinical:content`. Neither term is declared, and
 * `ClinicalDocumentShape` is open, so both passed validation unseen: the
 * shape's `clinical:narrativeText` property (datatype string, at most one
 * value) had never been applied to a single C-CDA narrative. "Zero violations"
 * over that output proved nothing. So each fixture here must also show the
 * shape reaching the narrative, and a synthetic collision must show the
 * cardinality constraint firing.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Parser } from 'n3';

import { convertCcda } from '../src/lib/ccda-converter/index.js';
import { loadShapes, validateTurtle } from '../src/lib/shacl-validator.js';
import { conformancePath } from './helpers/conformance.js';

const CORPUS = conformancePath('fixtures/ccda');
const CLINICAL_DOCUMENT = 'https://ns.cascadeprotocol.org/clinical/v1#ClinicalDocument';
const CLINICAL_NARRATIVE_TEXT = 'https://ns.cascadeprotocol.org/clinical/v1#narrativeText';
const SECTION_CODE = 'https://ns.cascadeprotocol.org/core/v1#sectionCode';

const FILES = fs.existsSync(CORPUS)
  ? fs.readdirSync(CORPUS).filter((f) => f.endsWith('.xml')).sort()
  : [];
if (FILES.length === 0) {
  throw new Error(`No C-CDA fixtures found at ${CORPUS}; this test does not skip.`);
}

const { store: shapes, shapeFiles } = loadShapes();

async function convertAndValidate(xml: string, label: string) {
  const result = await convertCcda(xml, {
    sourceSystem: 'Fixture',
    importedAt: '2026-01-01T00:00:00.000Z',
  });
  expect(result.errors).toHaveLength(0);
  const report = validateTurtle(result.output, shapes, shapeFiles, label);
  const quads = new Parser().parse(result.output);
  const documents = new Set(
    report.subjects.filter((s) => s.types.includes(CLINICAL_DOCUMENT)).map((s) => s.uri),
  );
  const sectionNarratives = new Set(
    quads.filter((q) => q.predicate.value === SECTION_CODE).map((q) => q.subject.value),
  );
  const narrativeValues = new Map<string, number>();
  for (const q of quads) {
    if (q.predicate.value !== CLINICAL_NARRATIVE_TEXT) continue;
    narrativeValues.set(q.subject.value, (narrativeValues.get(q.subject.value) ?? 0) + 1);
  }
  return { report, documents, sectionNarratives, narrativeValues };
}

describe('every conformance C-CDA fixture converts with zero ClinicalDocument violations', () => {
  for (const file of FILES) {
    it(file, async () => {
      const xml = fs.readFileSync(path.join(CORPUS, file), 'utf8');
      const { report, documents, sectionNarratives, narrativeValues } =
        await convertAndValidate(xml, file);

      const onDocuments = report.results.filter(
        (r) => r.severity === 'violation' && r.focusNode !== undefined && documents.has(r.focusNode),
      );
      expect(onDocuments, JSON.stringify(onDocuments, null, 2)).toEqual([]);

      // Not vacuous: the shape selected the section narratives, and the text sits
      // on the one predicate the shape constrains.
      expect(report.shapesFired).toContain('ClinicalDocumentShape');
      expect(sectionNarratives.size).toBeGreaterThan(0);
      for (const s of sectionNarratives) expect(documents.has(s), s).toBe(true);
      const carrying = [...sectionNarratives].filter((s) => (narrativeValues.get(s) ?? 0) > 0);
      expect(carrying.length, 'no section narrative carries clinical:narrativeText').toBeGreaterThan(0);
      for (const s of carrying) expect(narrativeValues.get(s), s).toBe(1);
    });
  }
});

describe('the narrative cardinality constraint is live', () => {
  // Two sections with the same LOINC code in one document share a narrative
  // IRI (it is keyed on section code, document and source), so the subject
  // gets two texts. No corpus fixture has this shape; real exports can. This is
  // the positive control that the constraint above is really being applied. It
  // asserts only that the shape reports the collision, not at which severity.
  const DUPLICATE_SECTION_CODE = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1" displayName="Summarization of Episode Note"/>
  <id root="9.8.7.6.5" extension="DOC-DUP-1"/>
  <custodian><assignedCustodian><representedCustodianOrganization><id root="1.2.3.4"/><name>Synthetic Clinic</name></representedCustodianOrganization></assignedCustodian></custodian>
  <recordTarget><patientRole><id root="1.2.3" extension="MRN-1"/><patient><name><given>Test</given><family>Patient</family></name></patient></patientRole></recordTarget>
  <component><structuredBody>
    <component><section>
      <code code="18776-5" codeSystem="2.16.840.1.113883.6.1" displayName="Plan of care"/>
      <text><paragraph>Follow up in two weeks for blood pressure recheck.</paragraph></text>
    </section></component>
    <component><section>
      <code code="18776-5" codeSystem="2.16.840.1.113883.6.1" displayName="Plan of care"/>
      <text><paragraph>Start physical therapy twice weekly.</paragraph></text>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;

  it('two same-code sections put two texts on one subject, and the shape reports it', async () => {
    const { report, sectionNarratives, narrativeValues } =
      await convertAndValidate(DUPLICATE_SECTION_CODE, 'duplicate-section-code');
    expect(sectionNarratives.size).toBe(1);
    const [subject] = [...sectionNarratives];
    expect(narrativeValues.get(subject)).toBe(2);
    const onNarrative = report.results.filter(
      (r) => r.focusNode === subject && r.property.endsWith('narrativeText'),
    );
    expect(onNarrative).toHaveLength(1);
  });
});
