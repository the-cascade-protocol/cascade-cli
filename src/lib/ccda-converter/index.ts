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
import { NS, TURTLE_PREFIXES, type BatchConversionResult, type EdgeResolutionSummary, type SectionCensusEntry } from '../fhir-converter/types.js';

const { namedNode, literal, quad: makeQuad } = DataFactory;
import { parseCcdaXml } from './parser.js';
import { firstOf, listOf } from './multivalued.js';
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
import {
  deriveCcdaIdNamespace,
  deriveSourceEhr,
  ensureProvenanceQuads,
  ensureSourceEhrQuads,
  ensureSourceIdentityQuads,
} from './provenance.js';
import { identityKey } from '../identity.js';
import { beginCcdaIdScope, endCcdaIdScope } from './record-identity.js';
import { sourceIdentity } from '../source-identity.js';

// Map templateId → extractor function and LOINC code.
//
// NOTE THE ABSENT PARAMETER. Every handler used to take the document's derived
// `patientUri` and splice it into each record's identity key. It is gone from
// this signature deliberately, and not merely unused: while it was a parameter,
// the next key written here would have reached for it. See
// `record-identity.ts` for why a per-document patient component both merged
// records the source kept apart and split records that were the same.
const SECTION_HANDLERS: Record<string, {
  loinc: string;
  extract: (
    entries: any[],
    sourceSystem: string,
    sectionText?: any,
    importedAt?: string,
    warnings?: string[],
  ) => any[];
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
  const sectionCensus: SectionCensusEntry[] = [];

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
      mergeSectionCensus(sectionCensus, result.census);
    } catch (err) {
      warnings.push(`Failed to convert C-CDA document: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Absence has to be reported as absence. A section that offered structured
  // entries and yielded no records is named here, whatever the cause — a handler
  // that cannot read that nesting, an unsupported template, or entries that were
  // genuinely empty. Three whole sections used to import as nothing while the
  // summary printed a record count and simply omitted the empty buckets.
  for (const s of sectionCensus) {
    if (s.entriesIn > 0 && s.recordsOut === 0) {
      warnings.push(
        `Section "${s.label}"${s.loinc ? ` (LOINC ${s.loinc})` : ''}: read ${s.entriesIn} structured ` +
          `entr${s.entriesIn === 1 ? 'y' : 'ies'} and imported 0 records` +
          (s.handled ? '' : ' — no structured handler for this section type') +
          '. Nothing from this section reached the pod.',
      );
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

  // `resourceCount` means THE NUMBER OF RECORDS THE CONVERSION PRODUCED, which
  // is the number of distinct subjects it gave an rdf:type — the same thing the
  // FHIR importer reports, so a caller reading the field gets one meaning
  // whatever `--from` it used.
  //
  // It used to be documents-and-sections: one for the patient, plus
  // `entries.length` per handled section. A C-CDA `<entry>` routinely holds an
  // `<organizer>` wrapping several observations, so a document producing 8
  // records reported 2. A caller deciding whether an import is worth running, or
  // showing "N records found", was told a number four times too small, and the
  // two importers disagreed about what the field meant. Counting after the
  // cross-document dedup below is deliberate: for an IHE XDM zip whose documents
  // repeat a record, the count is what the pod will receive, not the sum of what
  // each document claimed.
  const recordSubjects = new Set<string>();
  for (const q of uniqueQuads) {
    if (q.predicate.value === NS.rdf + 'type') recordSubjects.add(q.subject.value);
  }
  const resourceCount = recordSubjects.size;

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
    // Tally the record-to-record edges the C-CDA path materializes:
    // clinical:hasLabResult from BATTERY lab panels and clinical:hasEncounter
    // from each panel to the visit it was collected in. Every such edge is built
    // from a subject computed in the same walk, so all resolve; the census below
    // verifies that against the final record set and surfaces the count in the
    // import summary, matching the FHIR path's accounting.
    edgeResolution: censusForwardEdges(uniqueQuads),
    sectionCensus,
  };
}

/**
 * Fold one document's per-section census into the batch census. An IHE XDM zip
 * carries the same sections across several documents; they are summed under one
 * label so the reported numbers say "this import read N entries", not "the last
 * document did".
 */
function mergeSectionCensus(into: SectionCensusEntry[], from: SectionCensusEntry[]): void {
  for (const s of from) {
    const existing = into.find((e) => e.label === s.label && e.loinc === s.loinc);
    if (existing) {
      existing.entriesIn += s.entriesIn;
      existing.recordsOut += s.recordsOut;
      existing.handled = existing.handled || s.handled;
    } else {
      into.push({ ...s });
    }
  }
}

/**
 * Forward record-to-record edge predicates the C-CDA path writes, mapped to the
 * compacted label the import summary reports (matches the FHIR path's keys).
 */
const CCDA_FORWARD_EDGES: Record<string, string> = {
  [NS.clinical + 'hasLabResult']: 'clinical:hasLabResult',
  [NS.clinical + 'hasEncounter']: 'clinical:hasEncounter',
};

/**
 * Census the C-CDA edge families over a final quad set: an edge counts as
 * resolved when its object is a real record subject (carries an rdf:type) in the
 * same batch, unresolved otherwise. C-CDA edges resolve by construction, but the
 * census keeps the invariant "no edge is written that does not resolve" honest.
 */
function censusForwardEdges(quads: any[]): EdgeResolutionSummary {
  const subjects = new Set<string>();
  for (const q of quads) {
    if (q.predicate.value === NS.rdf + 'type') subjects.add(q.subject.value);
  }
  const stats: EdgeResolutionSummary = { resolved: 0, unresolved: 0, byPredicate: {} };
  for (const q of quads) {
    const label = CCDA_FORWARD_EDGES[q.predicate.value];
    if (!label) continue;
    const key =
      q.object.termType === 'NamedNode' && subjects.has(q.object.value) ? 'resolved' : 'unresolved';
    (stats.byPredicate[label] ??= { resolved: 0, unresolved: 0 })[key]++;
    stats[key]++;
  }
  return stats;
}

/**
 * Convert one C-CDA document, with the id-collision scope open for its whole
 * conversion.
 *
 * The scope is module state in `record-identity.ts` and is opened and closed
 * here, around a synchronous body, so no second document's scope can interleave
 * with this one's. The `finally` matters: a document that throws mid-conversion
 * (the caller catches and records a warning, then converts the next file of an
 * IHE XDM zip) must not leave the previous document's contradicted-id set in
 * place for its successor.
 */
function convertSingleCcda(
  xml: string,
  options: CcdaConversionOptions,
  importedAt: string,
  warnings: string[],
): { quads: any[]; census: SectionCensusEntry[] } {
  const parsed = parseCcdaXml(xml);

  // Detect vendor and apply normalization
  const vendor = detectVendor(parsed);
  const normalizedDoc = applyVendorNormalization(parsed, vendor);
  if (vendor !== 'unknown') {
    warnings.push(`Detected EHR vendor: ${vendor}`);
  }

  // The scope is opened over the NORMALIZED document, because that is the tree
  // the section handlers hand to the identity door: pre-scanning the raw parse
  // would fingerprint objects the mint never sees.
  beginCcdaIdScope(normalizedDoc?.ClinicalDocument ?? normalizedDoc);
  try {
    return convertNormalizedCcda(normalizedDoc, options, importedAt, warnings);
  } finally {
    endCcdaIdScope();
  }
}

function convertNormalizedCcda(
  normalizedDoc: any,
  options: CcdaConversionOptions,
  importedAt: string,
  warnings: string[],
): { quads: any[]; census: SectionCensusEntry[] } {
  const ccdaDoc = normalizedDoc?.ClinicalDocument ?? normalizedDoc;
  const sourceSystem = options.sourceSystem ?? getSourceSystemName(normalizedDoc);
  const documentType = detectDocumentType(normalizedDoc);
  // The EHR of origin is the document's custodian organization (ratified CDA
  // signal), independent of the import-batch label that drives `sourceSystem`.
  const sourceEhr = deriveSourceEhr(ccdaDoc);
  // The ORIGIN axis, derived once per document through the shared door. The
  // custodian organization NAME is the input, not the label: the label is what
  // this document called the organization, and the identity is the canonical
  // form the FHIR path independently arrives at from the endpoint host. If the
  // custodian named nobody, the document's own id namespace is the next-best
  // fact, and the import-batch label is the last resort and says so.
  const documentOrigin = sourceIdentity({
    organizationName: sourceEhr,
    idNamespace: deriveCcdaIdNamespace(ccdaDoc),
    transportLabel: sourceSystem,
  });

  // Document ID for narrative linking
  const docIdEl = firstOf<any>(ccdaDoc?.id);
  // HL7 II semantics: root+extension when both present; root alone IS the
  // globally unique document id when extension is absent. When the document
  // carries no id at all, identity comes from the document's own parsed,
  // vendor-normalized content.
  //
  // That last tier used to be `doc:${importedAt}`, and the comment here used to
  // record the consequence without fixing it: "that fallback makes re-imports
  // mint new URIs, i.e. duplicate documents". It did — documentId feeds the
  // ClinicalDocument subject through `contentHashedUri`, so every section of an
  // id-less C-CDA became a new document node on every single import. Hashing the
  // parsed object rather than the raw XML keeps the identity insensitive to
  // reformatting and to vendor-specific whitespace.
  const documentId =
    docIdEl?.['@_extension']
      ? `${docIdEl['@_root'] ?? ''}:${docIdEl['@_extension']}`
      : docIdEl?.extension
        ? `${docIdEl.root ?? ''}:${docIdEl.extension}`
        : (docIdEl?.['@_root'] ?? docIdEl?.root)
          ? `${docIdEl['@_root'] ?? docIdEl.root}`
          : `doc:${identityKey(undefined, ccdaDoc, warnings, 'C-CDA ClinicalDocument (no <id>)')}`;

  const allQuads: any[] = [];
  const census: SectionCensusEntry[] = [];

  // Extract patient demographics
  const recordTarget = ccdaDoc?.recordTarget;
  if (!recordTarget) {
    warnings.push('C-CDA document has no recordTarget — patient demographics not extracted');
    return { quads: allQuads, census };
  }

  // The patient profile is a record like any other. Its IRI is NOT threaded into
  // the section handlers below — see the note on SECTION_HANDLERS.
  const { quads: patientQuads } = extractPatientQuads(
    Array.isArray(recordTarget) ? recordTarget : [recordTarget],
    sourceSystem,
    warnings,
  );
  allQuads.push(...patientQuads);

  // Process each section
  // `<component>` is a repeatable element and is therefore always an array (see
  // multivalued.ts), so we must search the array for the element that contains
  // structuredBody rather than reading .structuredBody off the array.
  const componentTopArr = listOf<any>(ccdaDoc?.component);
  const body =
    componentTopArr.find((c: any) => c?.structuredBody)?.structuredBody
    ?? ccdaDoc?.structuredBody;
  const componentArr = listOf<any>(body?.component);

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
    const entries = listOf<any>(section?.entry);
    const sectionLabel =
      (typeof section?.title === 'string' ? section.title : section?.title?.['#text']) ||
      (sectionCode ? `LOINC ${sectionCode}` : templateIds[0]) ||
      'untitled section';

    // Extract narrative — always attempt, even if section also has entries
    const sectionText = section?.text;
    // A section that carries a nullFlavor has ALREADY said, in the ratified way,
    // that it holds no information (HL7 v3 NullFlavor: NI and its children UNK,
    // NAV, ASKU, NASK, MSK, NA, OTH). Queueing such a section for extraction
    // offers a model the sentence "No information available." and asks it what
    // allergies the patient has — the one input from which any answer at all is
    // a fabrication. The narrative record is still produced; it is only the
    // extraction flag that changes.
    const sectionNullFlavor = section?.['@_nullFlavor'] ?? section?.nullFlavor;
    const requiresLLMExtraction = entries.length === 0 && !sectionNullFlavor;
    if (sectionText || requiresLLMExtraction) {
      const effectiveLoinc =
        sectionCode || (matchedTemplateId ? (SECTION_HANDLERS[matchedTemplateId]?.loinc ?? '') : '');
      const narrativeQuads = extractNarrativeQuads(
        sectionText, effectiveLoinc, documentType, documentId, sourceSystem, importedAt,
        requiresLLMExtraction, sourceEhr, warnings,
      );
      allQuads.push(...narrativeQuads);
    }

    // Extract structured entries
    if (matchedTemplateId && SECTION_HANDLERS[matchedTemplateId]) {
      const handler = SECTION_HANDLERS[matchedTemplateId];
      const quads = handler.extract(entries, sourceSystem, sectionText, importedAt, warnings);

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

      // Entries read versus records written, for THIS section. Counted from the
      // handler's own output — the distinct subjects it gave an rdf:type — so it
      // cannot be satisfied by a handler that returns quads without records.
      const recordSubjects = new Set(
        quads
          .filter((q: any) => q.predicate.value === NS.rdf + 'type')
          .map((q: any) => q.subject.value),
      );
      census.push({
        label: sectionLabel,
        loinc: sectionCode || handler.loinc || undefined,
        entriesIn: entries.length,
        recordsOut: recordSubjects.size,
        handled: true,
      });
    } else {
      // No structured handler. If the section still carried entries, they were
      // read and dropped, and that has to be counted rather than assumed empty.
      if (entries.length > 0) {
        census.push({
          label: sectionLabel,
          loinc: sectionCode || undefined,
          entriesIn: entries.length,
          recordsOut: 0,
          handled: false,
        });
      }
      if (templateIds.length > 0) {
        const isKnownNarrativeOnly = templateIds.some((id: string) => NARRATIVE_ONLY_TEMPLATE_IDS.has(id));
        if (!isKnownNarrativeOnly) {
          warnings.push(
            `Unknown section templateId: ${templateIds[0]} — narrative preserved if present`,
          );
        }
      }
    }
  }

  // Shared post-passes over every record subject (every subject with an rdf:type):
  //  - stamp cascade:dataProvenance + cascade:schemaVersion if absent (mirrors the
  //    FHIR converter's commonTriples), and
  //  - stamp clinical:sourceEHR (the custodian organization) so structured records
  //    are attributed to their EHR of origin in the source-organized Records view.
  // Both are additive + idempotent: they never overwrite a value a handler set.
  ensureProvenanceQuads(allQuads);
  ensureSourceEhrQuads(allQuads, sourceEhr);
  ensureSourceIdentityQuads(allQuads, documentOrigin);

  return { quads: allQuads, census };
}
