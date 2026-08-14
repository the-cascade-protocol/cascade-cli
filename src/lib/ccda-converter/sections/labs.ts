/**
 * Extract lab results from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.3.1)
 *
 * Two record families come out of this section:
 *  - health:LabResultRecord — one per member observation (standalone or inside an
 *    organizer).
 *  - clinical:LaboratoryReport — one per BATTERY organizer (a lab panel), with a
 *    clinical:hasLabResult edge to each of its member results. This mirrors the
 *    FHIR converter's convertLaboratoryReport so both import paths produce
 *    shape-compatible panel records.
 *
 * CLUSTER organizers in this section are left as plain member observations (no
 * panel record); results-section CLUSTER panels are a filed follow-up, not this
 * slice's scope.
 *
 * SUBJECT MINTING IS NO LONGER "FROZEN", AND THE FREEZE IS WHY IT HAD TO CHANGE
 * ----------------------------------------------------------------------------
 * This header used to say `health:LabResultRecord` minting was frozen at
 * `contentHashedUri('LabResult', {patient, loincCode, testName, date})`. That
 * claim is gone rather than worked around, because it was not describing a
 * decision anyone would defend on the merits — it was describing a key set that
 * SILENTLY MERGED DIFFERENT LAB RESULTS, and the freeze is a large part of why
 * it survived long enough to be shipped by two importers at once.
 *
 * What was wrong with it, measured rather than argued: the MEASURED VALUE was
 * extracted a few lines above the mint and never entered the key; `date` was
 * `formatCcdaDate()`, truncated to a calendar day; and the observation's own
 * `<id root= extension=>` was passed as `fallbackId`, which `contentHashedUri`
 * consults only when every content field is empty — never true for a real lab,
 * since `patient` is always populated. So a fasting glucose of 95 and a
 * post-prandial glucose of 310, drawn the same morning with DISTINCT source
 * ids, both minted `urn:uuid:dc68ecd7-acc0-5d61-981a-e51a3dbc0b0c`, and one of
 * the two values was discarded downstream as a duplicate.
 *
 * The identical defect sat in the FHIR importer's `convertObservationLab` and
 * is fixed in the same change, so both import paths now answer the same way.
 *
 * A comment is not an enforcement mechanism. If some future key set here really
 * must not move, pin it with a golden-value test — `tests/ccda-lab-identity.test.ts`
 * carries several, and a test states which property is protected instead of
 * asking the next reader to guess.
 */

import { NS, tripleDateTime } from '../../fhir-converter/types.js';
import { firstOf, listOf } from '../multivalued.js';
import { ccdaRecordUri, ccdaSourceId } from '../record-identity.js';
import { contentFingerprint, EMPTY_SEED } from '../../identity.js';
import { resolveCodeUri } from '../code-systems.js';
import { ccdaDateQuad } from '../dates.js';
import { mapNullFlavorToDataAbsentReason } from '../null-flavor.js';
import { buildNarrativeIdMap, narrativeTextFor, resolveNarrativeName } from '../narrative-reference.js';
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
 * can be linked to their visit (encounter completeness).
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

/** The subject IRI, quads, and clinical date for one converted lab observation. */
interface LabObservation {
  subject: string;
  quads: Quad[];
  date: string;
}

/**
 * Convert one C-CDA lab observation to a health:LabResultRecord.
 *
 * IDENTITY: a present source `<id>` wins outright. That is the same rule the
 * FHIR importer's `convertObservationLab` applies to `resource.id`, and it makes
 * a collision structurally impossible for any result the source identified.
 * Identity answers "is this that record?"; deciding that two records are the
 * same THING is a separate judgement, it needs a conflict trail, and it belongs
 * to the layer that can see both records rather than to this one, which sees one
 * at a time and can only overwrite.
 *
 * Without an id, the key carries what actually separates two results: patient,
 * LOINC code, test name, the effective time at the FULL precision C-CDA gives
 * (`YYYYMMDDHHMMSS±ZZZZ`, not the day-truncated `formatCcdaDate` output that is
 * emitted as `health:performedDate`), and the measured value with its unit.
 *
 * Returns null for an empty/absent observation.
 */
function extractObservationQuads(
  obs: any,
  sourceSystem: string,
  narrativeIdMap: Record<string, string>,
  warnings?: string[],
): LabObservation | null {
  if (!obs) return null;

  const codeEl = obs?.code ?? {};
  const code = codeEl?.['@_code'] ?? codeEl?.code ?? '';
  const codeSystem = codeEl?.['@_codeSystem'] ?? codeEl?.codeSystem ?? '';
  const displayName = codeEl?.['@_displayName'] ?? codeEl?.displayName ?? '';
  const isLoinc = isLoincSystem(codeSystem);

  // The test's name when the structured code does not carry one. C-CDA lets the
  // entry point at the section narrative instead of repeating the name as an
  // attribute — `<code><originalText><reference value="#result1"/></originalText>`
  // — and this handler used to read `@displayName` only, so every such result
  // reached the pod with NO `health:testName`. That property is `sh:minCount 1`,
  // so the record was invalid for missing a name the document stated in plain
  // words one dereference away.
  //
  // Two containers carry it: the code's `<originalText>` (which may also hold the
  // text inline rather than behind a reference) and, in some exports, the
  // observation's own `<text>`. Both resolve through the same narrative map.
  //
  // If neither resolves, this stays empty and NOTHING is emitted below. The
  // minCount violation then fires and is true: no name for this record exists in
  // what the converter can read. A placeholder would hide that.
  const testName =
    displayName ||
    resolveNarrativeName(codeEl, narrativeIdMap, warnings) ||
    narrativeTextFor(obs?.text, narrativeIdMap, warnings);

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

  // A <value nullFlavor="..."/> carries no number and IS a statement: HL7 v3
  // separates UNK ("a value applies, nobody knows it"), NAV ("we will know
  // later"), NASK ("nobody asked") and ASKU ("we asked, the patient did not
  // know") deliberately, and the last one means somebody had the conversation.
  // Reading only @_value dropped all four to the same empty string, so three
  // different clinical facts became one indistinguishable blank and re-asking
  // was the only recovery.
  //
  // core v3.6 defines cascade:dataAbsentReason and states the mapping this call
  // implements. Note the value set is FHIR data-absent-reason, not v3-NullFlavor:
  // the raw nullFlavor code is deliberately NOT written through, because an
  // absence with two encodings turns "is this the same absence?" into a
  // string-comparison question. No value is invented for the record; only the
  // reason is recovered.
  const dataAbsentReason = mapNullFlavorToDataAbsentReason(
    valueEl?.['@_nullFlavor'] ?? valueEl?.nullFlavor,
  );

  // Extract reference range
  const refRange = obs?.referenceRange?.observationRange;
  const refRangeText = refRange?.text?.['#text'] ?? refRange?.text ?? '';

  const sourceId = ccdaSourceId(obs?.id);

  // Tier 1 — the source identified this result. Nothing else is consulted, so
  // two results the source kept apart can never be merged here. The door's
  // `{type}:{id}` template is byte-identical to the `contentHashedUri('LabResult',
  // {}, sourceId, obs)` this call used to spell inline, so no id-bearing lab IRI
  // moves. What DOES move: `ccdaSourceId` also reads a root-only `<id>`, which
  // the old reader here discarded, so an observation identified that way stops
  // falling through to the content tier.
  //
  // Tier 2 — no id. Now the key has to do the separating, so it carries the
  // full-precision effective time and the measured value, both of which the
  // pre-#36 key set left out.
  const uri = ccdaRecordUri({
    type: 'LabResult',
    sourceId,
    content: {
      loincCode: isLoinc ? code : undefined,
      // The STRUCTURED name only, deliberately. A name recovered from the
      // narrative is now emitted (above), but adding it to the key would re-mint
      // every id-less result that gains one, i.e. duplicate them against any pod
      // that already holds them. Widening the key is a defensible change with a
      // migration attached; it is not this change, and
      // `tests/ccda-narrative-names.test.ts` pins a golden IRI so the choice
      // cannot drift silently.
      testName: displayName || undefined,
      // `dateVal` raw, NOT `dateStr`. `formatCcdaDate` truncates to a calendar
      // day, which merged a 07:00 draw with an 11:00 draw.
      effective: dateVal || undefined,
      value: value || undefined,
      unit: unit || undefined,
      // Serialized as health:referenceRangeText and was outside the key.
      refRange: refRangeText || undefined,
    },
    source: obs,
    warnings,
    label: 'C-CDA lab result',
  });

  const subj = namedNode(uri);
  const quads: Quad[] = [];
  quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.health + 'LabResultRecord')));
  quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));

  if (isLoinc && code) {
    quads.push(makeQuad(subj, namedNode(NS.health + 'testCode'), namedNode(resolveCodeUri(LOINC_OID, code))));
  }
  if (testName) quads.push(makeQuad(subj, namedNode(NS.health + 'testName'), literal(testName)));
  // Typed from the RAW effectiveTime, not from the day-truncated `dateStr`: a
  // source that stated a time keeps it, a source that stated a day gets no
  // invented one. See `dates.ts`.
  const performedQuad = ccdaDateQuad(uri, NS.health + 'performedDate', dateVal, warnings);
  if (performedQuad) quads.push(performedQuad);
  if (value) quads.push(makeQuad(subj, namedNode(NS.health + 'resultValue'), literal(value)));
  if (unit) quads.push(makeQuad(subj, namedNode(NS.health + 'resultUnit'), literal(unit)));
  // Only when there is no value: cascade:dataAbsentReason explains an ABSENT
  // value (FHIR R4 Observation.dataAbsentReason), so a record carrying both
  // would be asserting that the value it just stated is missing.
  if (!value && dataAbsentReason) {
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'dataAbsentReason'), literal(dataAbsentReason)));
  }
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
  sourceSystem: string,
  importedAt: string,
  memberSubjects: string[],
  memberDates: string[],
  encounterSubjects: string[],
  warnings?: string[],
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

  const sourceId = ccdaSourceId(organizer);

  // Panel identity, tier 1: the organizer's own id decides. That is the same
  // rule every other C-CDA record now follows, and this path had already reached
  // most of the way to it on its own — the id was a first-class CONTENT field
  // (`panelId`) rather than a dead `fallbackId`, because real Epic exports
  // routinely omit the organizer-level <code> (verified: 47 of 55 panels in the
  // acceptance export carry no code), so keying on code+date alone collapsed
  // genuinely distinct same-day panels and pooled their members.
  //
  // Tier 2, and only tier 2: `clinicalDate` is `formatCcdaDate`-truncated to a
  // calendar day, so for an organizer with neither id nor code the key would
  // degenerate to a single day. Measured: two id-less code-less BATTERY
  // organizers four hours apart on one day, holding DIFFERENT results, both
  // minted urn:uuid:0335391b-48fb-5d69-ab87-7bbf2429e434. So the id-less branch
  // additionally carries the organizer's raw full-precision effectiveTime and a
  // fingerprint of its members and encounters — which is what a panel's content
  // actually IS, since a panel has no measured value of its own. The cost is
  // that an id-less panel which GAINS a result in a later export mints a new
  // IRI, i.e. a duplicate; that is a split, and a split is the recoverable
  // failure. A merge is not.
  //
  // Timestamps that vary between imports (importedAt) are deliberately excluded.
  const memberKey = contentFingerprint(memberSubjects);
  const encounterKey = contentFingerprint(encounterSubjects);
  const uri = ccdaRecordUri({
    type: 'LaboratoryReport',
    sourceId,
    content: {
      panelCode: code || undefined,
      // Serialized as clinical:panelName and was outside the key.
      panelName: displayName || undefined,
      date: clinicalDate || undefined,
      effective: orgDateRaw || undefined,
      members: memberKey === EMPTY_SEED ? undefined : memberKey,
      encounters: encounterKey === EMPTY_SEED ? undefined : encounterKey,
    },
    source: organizer,
    warnings,
    label: 'C-CDA lab panel',
  });

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
  sourceSystem: string,
  sectionText?: any,
  importedAt?: string,
  warnings?: string[],
): Quad[] {
  const quads: Quad[] = [];
  const stamp = importedAt ?? new Date().toISOString();
  // The section's own narrative, indexed by element ID. `sectionText` was already
  // being passed to every handler and this one ignored it (`_sectionText`), which
  // is why the names sitting in it were unreachable.
  const narrativeIdMap = buildNarrativeIdMap(sectionText);
  // Encounter records dedupe across the whole section: many organizers cite the
  // same visit, so a given encounter subject is emitted once even though each
  // panel that references it gets its own hasEncounter edge.
  const emittedEncounterSubjects = new Set<string>();

  for (const entry of entries) {
    // `<organizer>` is a repeatable element and is therefore an ARRAY (see
    // `multivalued.ts`). This used to be `const organizer = entry?.organizer`,
    // read straight as an object, so `organizer?.component` was `undefined` and
    // an entire results section of panels imported as NOTHING — no records, no
    // error, no skip count. Measured on a two-panel section: 0 quads before, 86
    // after.
    const organizer = firstOf<any>(entry?.organizer);

    if (organizer?.component) {
      // Lab panel (organizer wrapping member observations).
      const comps = listOf<any>(organizer.component);

      const memberSubjects: string[] = [];
      const memberDates: string[] = [];
      for (const comp of comps) {
        if (!comp?.observation) continue;
        const obsList = listOf<any>(comp.observation);
        for (const obs of obsList) {
          const member = extractObservationQuads(obs, sourceSystem, narrativeIdMap, warnings);
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
          const built = buildEncounterRecord(enc, sourceSystem, warnings);
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
          organizer, sourceSystem, stamp, memberSubjects, memberDates, encounterSubjects, warnings,
        ));
      }
    } else if (entry?.observation) {
      // Standalone observation (no organizer): a plain lab result, no panel.
      const obsList = listOf<any>(entry.observation);
      for (const obs of obsList) {
        const member = extractObservationQuads(obs, sourceSystem, narrativeIdMap, warnings);
        if (member) quads.push(...member.quads);
      }
    }
  }

  return quads;
}
