/**
 * Extract lab results from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.3.1)
 *
 * Two record families come out of this section:
 *  - health:LabResultRecord — one per member observation (standalone or inside an
 *    organizer). Subject minting is frozen (contentHashedUri('LabResult', ...)).
 *  - clinical:LaboratoryReport — one per BATTERY organizer (a lab panel), with a
 *    clinical:hasLabResult edge to each of its member results. This mirrors the
 *    FHIR converter's convertLaboratoryReport so both import paths produce
 *    shape-compatible panel records (root backlog 3.11a / slice R2).
 *
 * CLUSTER organizers in this section are left as plain member observations (no
 * panel record); results-section CLUSTER panels are a filed follow-up, not this
 * slice's scope.
 */

import { NS, contentHashedUri, tripleDateTime } from '../../fhir-converter/types.js';
import { resolveCodeUri } from '../code-systems.js';
import { buildEncounterRecord } from './encounters.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

/**
 * Recursively collect every <encounter> element in a C-CDA subtree. Real Epic
 * lab organizers carry the visit an analysis was performed in as an <encounter>
 * (classCode ENC) nested at varying depths — directly under the organizer or
 * deep inside a member observation's entryRelationship chain. Each is a full
 * encounter definition (id + type + effectiveTime), so the organizer's results
 * can be linked to their visit (root 3.11 encounter completeness).
 */
function collectEncounters(node: any, out: any[]): void {
  if (node == null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'encounter') {
      const arr = Array.isArray(value) ? value : [value];
      for (const e of arr) out.push(e);
    }
    if (value && typeof value === 'object') collectEncounters(value, out);
  }
}

export const LABS_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.3.1';
export const LABS_LOINC = '30954-2';

const LOINC_OID = '2.16.840.1.113883.6.1';

/** True when a C-CDA codeSystem OID identifies LOINC. */
function isLoincSystem(codeSystem: string): boolean {
  return codeSystem.includes('6.1') || codeSystem === LOINC_OID;
}

/** Format an HL7 dateTime string (YYYYMMDD...) to an ISO date (YYYY-MM-DD). */
function formatCcdaDate(dateVal: string): string {
  if (!dateVal) return '';
  return dateVal.length >= 8
    ? `${dateVal.slice(0, 4)}-${dateVal.slice(4, 6)}-${dateVal.slice(6, 8)}`
    : dateVal;
}

/** Extract an HL7 II (id) element's "root:extension" string, or '' if no extension. */
function extractSourceId(node: any): string {
  const idEl = Array.isArray(node?.id) ? node.id[0] : node?.id;
  return idEl?.['@_extension'] ? `${idEl['@_root'] ?? ''}:${idEl['@_extension']}` : '';
}

/** The subject IRI, quads, and clinical date for one converted lab observation. */
interface LabObservation {
  subject: string;
  quads: Quad[];
  date: string;
}

/**
 * Convert one C-CDA lab observation to a health:LabResultRecord. Subject minting
 * is frozen: contentHashedUri('LabResult', {patient, loincCode, testName, date}).
 * Returns null for an empty/absent observation.
 */
function extractObservationQuads(
  obs: any,
  patientUri: string,
  sourceSystem: string,
): LabObservation | null {
  if (!obs) return null;

  const codeEl = obs?.code ?? {};
  const code = codeEl?.['@_code'] ?? codeEl?.code ?? '';
  const codeSystem = codeEl?.['@_codeSystem'] ?? codeEl?.codeSystem ?? '';
  const displayName = codeEl?.['@_displayName'] ?? codeEl?.displayName ?? '';
  const isLoinc = isLoincSystem(codeSystem);

  // Extract effective date
  const effTime = obs?.effectiveTime;
  const dateVal =
    effTime?.['@_value'] ?? effTime?.value ??
    effTime?.low?.['@_value'] ?? effTime?.low?.value ?? '';
  const dateStr = formatCcdaDate(dateVal);

  // Extract value
  const valueEl = obs?.value ?? {};
  const value = valueEl?.['@_value'] ?? valueEl?.value ?? valueEl?.['#text'] ?? '';
  const unit = valueEl?.['@_unit'] ?? valueEl?.unit ?? '';

  // Extract reference range
  const refRange = obs?.referenceRange?.observationRange;
  const refRangeText = refRange?.text?.['#text'] ?? refRange?.text ?? '';

  const sourceId = extractSourceId(obs);

  const uri = contentHashedUri('LabResult', {
    patient: patientUri,
    loincCode: isLoinc ? code : undefined,
    testName: displayName || undefined,
    date: dateStr || undefined,
  }, sourceId || undefined);

  const subj = namedNode(uri);
  const quads: Quad[] = [];
  quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.health + 'LabResultRecord')));
  quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));

  if (isLoinc && code) {
    quads.push(makeQuad(subj, namedNode(NS.health + 'testCode'), namedNode(resolveCodeUri(LOINC_OID, code))));
  }
  if (displayName) quads.push(makeQuad(subj, namedNode(NS.health + 'testName'), literal(displayName)));
  if (dateStr) quads.push(makeQuad(subj, namedNode(NS.health + 'performedDate'), literal(dateStr)));
  if (value) quads.push(makeQuad(subj, namedNode(NS.health + 'resultValue'), literal(value)));
  if (unit) quads.push(makeQuad(subj, namedNode(NS.health + 'resultUnit'), literal(unit)));
  if (refRangeText) quads.push(makeQuad(subj, namedNode(NS.health + 'referenceRangeText'), literal(refRangeText)));
  if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));

  return { subject: uri, quads, date: dateStr };
}

/**
 * Mint a clinical:LaboratoryReport panel record for one BATTERY organizer and
 * link it to its member results with clinical:hasLabResult. The panel subject is
 * content-hashed from stable organizer identity (patient + panel code + clinical
 * date), so re-importing the same document yields the same subject (exact
 * re-imports dedupe). Required ClinicalDocument/LaboratoryReport shape fields
 * (importedAt, documentDate, fhirResourceId, fhirResourceType) are filled here;
 * sourceEHR + dataProvenance + schemaVersion are stamped by the document-level
 * post-passes.
 */
function buildPanelQuads(
  organizer: any,
  patientUri: string,
  sourceSystem: string,
  importedAt: string,
  memberSubjects: string[],
  memberDates: string[],
  encounterSubjects: string[],
): Quad[] {
  const codeEl = organizer?.code ?? {};
  const code = codeEl?.['@_code'] ?? codeEl?.code ?? '';
  const codeSystem = codeEl?.['@_codeSystem'] ?? codeEl?.codeSystem ?? '';
  const displayName = codeEl?.['@_displayName'] ?? codeEl?.displayName ?? '';
  const isLoinc = isLoincSystem(codeSystem);

  // Clinical date for the panel: the organizer's own effectiveTime when present,
  // otherwise the earliest member result date (real Epic organizers routinely
  // omit effectiveTime). Deterministic either way and used in the panel subject.
  const orgEff = organizer?.effectiveTime;
  const orgDateRaw =
    orgEff?.['@_value'] ?? orgEff?.value ??
    orgEff?.low?.['@_value'] ?? orgEff?.low?.value ?? '';
  const clinicalDate =
    formatCcdaDate(orgDateRaw) ||
    memberDates.filter((d) => d).sort()[0] ||
    '';

  const sourceId = extractSourceId(organizer);

  // Panel identity: patient + panel code + clinical date + the organizer's own
  // id (root:extension). The id must be a first-class identity field, not just
  // the contentHashedUri fallback: real Epic exports routinely omit the
  // organizer-level <code> (verified: 47 of 55 panels in the acceptance export
  // carry no code), so keying on code+date alone collapses genuinely distinct
  // same-day panels into one record and pools their members. The organizer id is
  // present and unique per panel, so it yields one record per BATTERY organizer
  // while staying deterministic (the id is stable in the source) and dedupe-safe
  // (an exact re-import mints the same id and collapses to the same subject).
  // Timestamps that vary between imports (importedAt) are deliberately excluded.
  const uri = contentHashedUri('LaboratoryReport', {
    patient: patientUri,
    panelCode: code || undefined,
    date: clinicalDate || undefined,
    panelId: sourceId || undefined,
  }, sourceId || undefined);

  const subj = namedNode(uri);
  const quads: Quad[] = [];

  quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'LaboratoryReport')));
  quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));
  quads.push(makeQuad(subj, namedNode(NS.clinical + 'panelName'), literal(displayName || 'Unknown Panel')));

  if (isLoinc && code) {
    quads.push(makeQuad(subj, namedNode(NS.clinical + 'loincCode'), namedNode(NS.loinc + code)));
  }

  // documentDate is required by LaboratoryReportShape. Prefer the clinical date;
  // fall back to importedAt only when the document carries no date at all, so the
  // record still validates (a dateless panel is rare in real exports).
  const documentDate = clinicalDate || importedAt;
  quads.push(tripleDateTime(uri, NS.clinical + 'documentDate', documentDate));
  if (clinicalDate) {
    quads.push(tripleDateTime(uri, NS.clinical + 'performedDate', clinicalDate));
  }

  // ClinicalDocumentShape required fields (mirrors the C-CDA narrative document
  // node and the FHIR panel converter). This is a native C-CDA record, so the
  // fhirResource* fields carry the organizer identity / DiagnosticReport analog.
  quads.push(tripleDateTime(uri, NS.clinical + 'importedAt', importedAt));
  quads.push(makeQuad(subj, namedNode(NS.clinical + 'fhirResourceId'),
    literal(sourceId || uri.replace(/^urn:uuid:/, ''))));
  quads.push(makeQuad(subj, namedNode(NS.clinical + 'fhirResourceType'), literal('DiagnosticReport')));

  if (sourceId) {
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
  }

  // Membership edges. Each object is a member's real minted subject computed in
  // the same walk, so every edge resolves by construction.
  for (const memberSubject of memberSubjects) {
    quads.push(makeQuad(subj, namedNode(NS.clinical + 'hasLabResult'), namedNode(memberSubject)));
  }

  // Encounter edges: the visit(s) this panel was collected in, extracted from
  // the organizer's own <encounter> definition(s). Same construction guarantee —
  // each object is an encounter subject minted in the same batch.
  for (const encounterSubject of encounterSubjects) {
    quads.push(makeQuad(subj, namedNode(NS.clinical + 'hasEncounter'), namedNode(encounterSubject)));
  }

  return quads;
}

export function extractLabQuads(
  entries: any[],
  patientUri: string,
  sourceSystem: string,
  _sectionText?: any,
  importedAt?: string,
): Quad[] {
  const quads: Quad[] = [];
  const stamp = importedAt ?? new Date().toISOString();
  // Encounter records dedupe across the whole section: many organizers cite the
  // same visit, so a given encounter subject is emitted once even though each
  // panel that references it gets its own hasEncounter edge.
  const emittedEncounterSubjects = new Set<string>();

  for (const entry of entries) {
    const organizer = entry?.organizer;

    if (organizer?.component) {
      // Lab panel (organizer wrapping member observations).
      const comps = Array.isArray(organizer.component)
        ? organizer.component
        : [organizer.component];

      const memberSubjects: string[] = [];
      const memberDates: string[] = [];
      for (const comp of comps) {
        if (!comp?.observation) continue;
        const obsList = Array.isArray(comp.observation) ? comp.observation : [comp.observation];
        for (const obs of obsList) {
          const member = extractObservationQuads(obs, patientUri, sourceSystem);
          if (!member) continue;
          quads.push(...member.quads);
          memberSubjects.push(member.subject);
          if (member.date) memberDates.push(member.date);
        }
      }

      // Materialize a panel record only for BATTERY organizers (lab panels).
      // CLUSTER organizers keep their members as standalone results (scope R2).
      const classCode = organizer?.['@_classCode'] ?? organizer?.classCode ?? '';
      if (classCode === 'BATTERY' && memberSubjects.length > 0) {
        // The visit(s) this panel was collected in: mint one encounter record
        // per distinct visit (deduped across the whole section) and link the
        // panel to each with clinical:hasEncounter. Emitting encounters only
        // here — alongside the panel that references them — keeps records and
        // edges in lockstep, so every encounter record has an incoming edge and
        // no orphan visit node is minted for an organizer with no results.
        const rawEncounters: any[] = [];
        collectEncounters(organizer, rawEncounters);
        const encounterSubjects: string[] = [];
        const seenThisOrganizer = new Set<string>();
        for (const enc of rawEncounters) {
          const built = buildEncounterRecord(enc, patientUri, sourceSystem);
          if (!built) continue;
          if (!seenThisOrganizer.has(built.subject)) {
            seenThisOrganizer.add(built.subject);
            encounterSubjects.push(built.subject);
          }
          if (!emittedEncounterSubjects.has(built.subject)) {
            emittedEncounterSubjects.add(built.subject);
            quads.push(...built.quads);
          }
        }

        quads.push(...buildPanelQuads(
          organizer, patientUri, sourceSystem, stamp, memberSubjects, memberDates, encounterSubjects,
        ));
      }
    } else if (entry?.observation) {
      // Standalone observation (no organizer): a plain lab result, no panel.
      const obsList = Array.isArray(entry.observation) ? entry.observation : [entry.observation];
      for (const obs of obsList) {
        const member = extractObservationQuads(obs, patientUri, sourceSystem);
        if (member) quads.push(...member.quads);
      }
    }
  }

  return quads;
}
