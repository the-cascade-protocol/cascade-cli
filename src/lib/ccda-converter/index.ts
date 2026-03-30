/**
 * Native C-CDA R2.1 to Cascade Protocol Turtle converter.
 *
 * Converts HL7 Clinical Document Architecture R2.1 XML (as exported by Epic MyChart,
 * Cerner PowerChart, Athena, and other EHR systems) directly to Cascade Protocol RDF.
 *
 * Converting natively (without going through FHIR as an intermediary) preserves:
 * - CVX codes for immunizations
 * - LOINC codes for labs and vitals
 * - RxNorm codes for medications
 * - SNOMED CT codes for problems and procedures
 * - ICD-10 codes for diagnoses
 * - Lab reference ranges (health:referenceRangeText)
 *
 * Supports both single C-CDA XML files and IHE XDM zip bundles
 * (multiple C-CDA documents per zip).
 */

import AdmZip from 'adm-zip';
import { Writer, DataFactory } from 'n3';
import { NS, TURTLE_PREFIXES, type BatchConversionResult } from '../fhir-converter/types.js';

const { namedNode, literal, quad: makeQuad } = DataFactory;
import { parseCcdaXml } from './parser.js';
import { detectVendor, getSourceSystemName } from './vendor/detect.js';
import { applyVendorNormalization } from './vendor/normalize.js';
import { detectDocumentType } from './document-type.js';
import { extractPatientQuads } from './sections/patient.js';
import { extractImmunizationQuads, IMMUNIZATIONS_TEMPLATE_ID } from './sections/immunizations.js';
import { extractLabQuads, LABS_TEMPLATE_ID } from './sections/labs.js';
import { extractProblemQuads, PROBLEMS_TEMPLATE_ID } from './sections/problems.js';
import { extractAllergyQuads, ALLERGIES_TEMPLATE_ID } from './sections/allergies.js';
import { extractMedicationQuads, MEDICATIONS_TEMPLATE_ID } from './sections/medications.js';
import { extractVitalQuads, VITALS_TEMPLATE_ID } from './sections/vitals.js';
import { extractProcedureQuads, PROCEDURES_TEMPLATE_ID } from './sections/procedures.js';
import { extractEncounterQuads, ENCOUNTERS_TEMPLATE_ID } from './sections/encounters.js';
import { extractFamilyHistoryQuads, FAMILY_HISTORY_TEMPLATE_ID } from './sections/family-history.js';
import { extractDeviceQuads, DEVICES_TEMPLATE_ID } from './sections/devices.js';
import { extractSocialHistoryQuads, SOCIAL_HISTORY_TEMPLATE_ID } from './sections/social-history.js';
import { extractNarrativeQuads } from './narrative.js';

// Map templateId → extractor function and LOINC code
const SECTION_HANDLERS: Record<string, {
  loinc: string;
  extract: (entries: any[], patientUri: string, sourceSystem: string) => any[];
}> = {
  [IMMUNIZATIONS_TEMPLATE_ID]:  { loinc: '11369-6', extract: extractImmunizationQuads },
  [LABS_TEMPLATE_ID]:           { loinc: '30954-2', extract: extractLabQuads },
  [PROBLEMS_TEMPLATE_ID]:       { loinc: '11450-4', extract: extractProblemQuads },
  [ALLERGIES_TEMPLATE_ID]:      { loinc: '48765-2', extract: extractAllergyQuads },
  [MEDICATIONS_TEMPLATE_ID]:    { loinc: '10160-0', extract: extractMedicationQuads },
  [VITALS_TEMPLATE_ID]:         { loinc: '8716-3',  extract: extractVitalQuads },
  [PROCEDURES_TEMPLATE_ID]:     { loinc: '47519-4', extract: extractProcedureQuads },
  [ENCOUNTERS_TEMPLATE_ID]:     { loinc: '46240-8', extract: extractEncounterQuads },
  [FAMILY_HISTORY_TEMPLATE_ID]: { loinc: '10157-6', extract: extractFamilyHistoryQuads },
  [DEVICES_TEMPLATE_ID]:        { loinc: '46264-8', extract: extractDeviceQuads },
  [SOCIAL_HISTORY_TEMPLATE_ID]: { loinc: '29762-2', extract: extractSocialHistoryQuads },
};

// Template IDs known to be narrative-only (no structured extractor needed)
const NARRATIVE_ONLY_TEMPLATE_IDS = new Set([
  '2.16.840.1.113883.10.20.22.2.10', // plan of care
]);

export interface CcdaConversionOptions {
  sourceSystem?: string;
  importedAt?: string;
}

/**
 * Convert a C-CDA XML document (or IHE XDM zip) to Cascade Protocol Turtle.
 *
 * @param xmlOrZip  C-CDA XML string, or a Buffer containing an IHE XDM zip
 * @param options   Optional source system name and importedAt timestamp
 */
export async function convertCcda(
  xmlOrZip: string | Buffer,
  options: CcdaConversionOptions = {},
): Promise<BatchConversionResult> {
  const warnings: string[] = [];
  const allQuads: any[] = [];
  let resourceCount = 0;

  const importedAt = options.importedAt ?? new Date().toISOString();

  // Handle IHE XDM zip vs single XML
  const xmlFiles: string[] = [];

  if (Buffer.isBuffer(xmlOrZip)) {
    try {
      const zip = new AdmZip(xmlOrZip);
      for (const entry of zip.getEntries()) {
        if (entry.entryName.toLowerCase().endsWith('.xml') && !entry.isDirectory) {
          xmlFiles.push(entry.getData().toString('utf-8'));
        }
      }
    } catch {
      // Not a valid zip — treat as raw XML
      xmlFiles.push(xmlOrZip.toString('utf-8'));
    }
  } else {
    xmlFiles.push(xmlOrZip as string);
  }

  for (const xml of xmlFiles) {
    try {
      const result = convertSingleCcda(xml, options, importedAt, warnings);
      allQuads.push(...result.quads);
      resourceCount += result.count;
    } catch (err) {
      warnings.push(`Failed to convert C-CDA document: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Deduplicate quads (same record can appear in multiple C-CDA documents within one ZIP)
  const seen = new Set<string>();
  const uniqueQuads = allQuads.filter(q => {
    const key = `${q.subject.value}\x00${q.predicate.value}\x00${q.object.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Serialize all quads to Turtle
  const output = await new Promise<string>((resolve, reject) => {
    const writer = new Writer({ prefixes: TURTLE_PREFIXES });
    for (const q of uniqueQuads) writer.addQuad(q);
    writer.end((err, result) => (err ? reject(err) : resolve(result)));
  });

  const errors: string[] = [];
  if (allQuads.length === 0) {
    errors.push('C-CDA conversion produced no output — document may be invalid or unsupported');
  }

  return {
    success: allQuads.length > 0,
    output,
    format: 'turtle',
    resourceCount,
    skippedCount: 0,
    warnings,
    errors,
    results: [],
  };
}

function convertSingleCcda(
  xml: string,
  options: CcdaConversionOptions,
  importedAt: string,
  warnings: string[],
): { quads: any[]; count: number } {
  const parsed = parseCcdaXml(xml);

  // Detect vendor and apply normalization
  const vendor = detectVendor(parsed);
  const normalizedDoc = applyVendorNormalization(parsed, vendor);
  if (vendor !== 'unknown') {
    warnings.push(`Detected EHR vendor: ${vendor}`);
  }

  const ccdaDoc = normalizedDoc?.ClinicalDocument ?? normalizedDoc;
  const sourceSystem = options.sourceSystem ?? getSourceSystemName(normalizedDoc);
  const documentType = detectDocumentType(normalizedDoc);

  // Document ID for narrative linking
  const docIdEl = Array.isArray(ccdaDoc?.id) ? ccdaDoc.id[0] : ccdaDoc?.id;
  const documentId =
    docIdEl?.['@_extension']
      ? `${docIdEl['@_root'] ?? ''}:${docIdEl['@_extension']}`
      : docIdEl?.extension
        ? `${docIdEl.root ?? ''}:${docIdEl.extension}`
        : `doc:${importedAt}`;

  const allQuads: any[] = [];
  let count = 0;

  // Extract patient demographics
  const recordTarget = ccdaDoc?.recordTarget;
  if (!recordTarget) {
    warnings.push('C-CDA document has no recordTarget — patient demographics not extracted');
    return { quads: allQuads, count };
  }

  const { quads: patientQuads, patientUri } = extractPatientQuads(
    Array.isArray(recordTarget) ? recordTarget : [recordTarget],
    sourceSystem,
  );
  allQuads.push(...patientQuads);
  count++;

  // Process each section
  // ccdaDoc.component is always an array (fast-xml-parser isArray config), so we must
  // search through the array for the element that contains structuredBody rather than
  // accessing .structuredBody directly on the array.
  const componentTopLevel = ccdaDoc?.component;
  const componentTopArr = Array.isArray(componentTopLevel)
    ? componentTopLevel
    : componentTopLevel ? [componentTopLevel] : [];
  const body =
    componentTopArr.find((c: any) => c?.structuredBody)?.structuredBody
    ?? ccdaDoc?.structuredBody;
  const components = body?.component ?? [];
  const componentArr = Array.isArray(components) ? components : [components];

  for (const comp of componentArr) {
    const section = comp?.section ?? comp;
    if (!section) continue;

    // Find template ID
    const templateIdRaw = Array.isArray(section?.templateId)
      ? section.templateId
      : section?.templateId ? [section.templateId] : [];
    const templateIds = templateIdRaw.map(
      (t: any) => t?.['@_root'] ?? t?.root ?? '',
    ).filter(Boolean);

    const matchedTemplateId = templateIds.find((id: string) => SECTION_HANDLERS[id]);

    // Get LOINC from section code
    const sectionCode = section?.code?.['@_code'] ?? section?.code?.code ?? '';

    // Extract structured entries (needed before narrative to know requiresLLMExtraction)
    const entries = Array.isArray(section?.entry)
      ? section.entry
      : section?.entry ? [section.entry] : [];

    // Extract narrative — always attempt, even if section also has entries
    const sectionText = section?.text;
    const requiresLLMExtraction = entries.length === 0;
    if (sectionText || requiresLLMExtraction) {
      const effectiveLoinc =
        sectionCode || (matchedTemplateId ? (SECTION_HANDLERS[matchedTemplateId]?.loinc ?? '') : '');
      const narrativeQuads = extractNarrativeQuads(
        sectionText, effectiveLoinc, documentType, documentId, sourceSystem, importedAt,
        requiresLLMExtraction,
      );
      allQuads.push(...narrativeQuads);
    }

    // Extract structured entries
    if (matchedTemplateId && SECTION_HANDLERS[matchedTemplateId]) {
      const handler = SECTION_HANDLERS[matchedTemplateId];
      const quads = handler.extract(entries, patientUri, sourceSystem);

      // Tag each structured record from a summarization document so the
      // reconciler can apply a lower confidence threshold for deduplication.
      // Summarization documents (LOINC 34133-9) contain the patient's full
      // history snapshot — the same record appearing in two such documents is
      // almost certainly a duplicate.
      if (documentType === 'summarization') {
        const subjects = new Set(
          quads
            .filter((q: any) => q.predicate.value === NS.rdf + 'type')
            .map((q: any) => q.subject.value),
        );
        for (const subjectUri of subjects) {
          quads.push(makeQuad(
            namedNode(subjectUri),
            namedNode(NS.cascade + 'documentType'),
            literal(documentType),
          ));
        }
      }

      allQuads.push(...quads);
      count += entries.length;
    } else if (templateIds.length > 0) {
      const isKnownNarrativeOnly = templateIds.some((id: string) => NARRATIVE_ONLY_TEMPLATE_IDS.has(id));
      if (!isKnownNarrativeOnly) {
        warnings.push(
          `Unknown section templateId: ${templateIds[0]} — narrative preserved if present`,
        );
      }
    }
  }

  return { quads: allQuads, count };
}
