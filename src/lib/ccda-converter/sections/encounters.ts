/**
 * Extract encounters from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.22)
 * Narrative is preserved by the main converter.
 *
 * The shared `buildEncounterRecord` helper mints one clinical:Encounter record
 * from a C-CDA <encounter> element and is reused by the Results-section walk
 * (sections/labs.ts), which links each lab panel to the visit it was collected
 * in via clinical:hasEncounter. Both paths therefore produce identical,
 * dedupe-safe encounter records (root 3.11 encounter completeness).
 */

import { NS, contentHashedUri } from '../../fhir-converter/types.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export const ENCOUNTERS_TEMPLATE_ID = '2.16.840.1.113883.10.20.22.2.22';
export const ENCOUNTERS_LOINC = '46240-8';

/** A minted encounter record: its subject IRI and the quads that describe it. */
export interface CcdaEncounterRecord {
  subject: string;
  quads: Quad[];
}

/**
 * Resolve a C-CDA encounter's human-readable type from, in order: the code
 * element's @_displayName, a translation's @_displayName, or a plain-text
 * originalText. A narrative `<reference>` originalText (a pointer into the
 * document text, e.g. "#encounter4type") is NOT a literal and is skipped rather
 * than misrecorded as a type.
 */
function encounterDisplayName(codeEl: any): string {
  const direct = codeEl?.['@_displayName'] ?? codeEl?.displayName;
  if (direct) return String(direct);

  const tr = codeEl?.translation;
  const trArr = Array.isArray(tr) ? tr : tr ? [tr] : [];
  for (const t of trArr) {
    const d = t?.['@_displayName'] ?? t?.displayName;
    if (d) return String(d);
  }

  const ot = codeEl?.originalText;
  if (typeof ot === 'string' && ot.trim()) return ot.trim();
  if (ot && typeof ot === 'object' && typeof ot['#text'] === 'string' && ot['#text'].trim()) {
    return ot['#text'].trim();
  }
  return '';
}

/** Format an HL7 dateTime (YYYYMMDD...) to an ISO date (YYYY-MM-DD). */
function formatCcdaDate(dateVal: string): string {
  if (!dateVal) return '';
  return dateVal.length >= 8
    ? `${dateVal.slice(0, 4)}-${dateVal.slice(4, 6)}-${dateVal.slice(6, 8)}`
    : dateVal;
}

/**
 * Build one clinical:Encounter record from a C-CDA <encounter> element, or null
 * when the element carries no usable identity (no id, type, or date — a bare
 * reference rather than a real definition). The subject is content-hashed on
 * stable identity (patient + type + date + id) so the same encounter, appearing
 * across many lab organizers or documents, dedupes to one record.
 */
export function buildEncounterRecord(
  enc: any,
  patientUri: string,
  sourceSystem: string,
): CcdaEncounterRecord | null {
  if (!enc || typeof enc !== 'object' || Array.isArray(enc)) return null;

  const codeEl = enc?.code ?? {};
  const displayName = encounterDisplayName(codeEl);

  const effTime = enc?.effectiveTime ?? {};
  const dateVal =
    effTime?.['@_value'] ?? effTime?.value ?? effTime?.low?.['@_value'] ?? effTime?.low?.value ?? '';
  const dateStr = formatCcdaDate(dateVal);

  const idEl = Array.isArray(enc?.id) ? enc.id[0] : enc?.id;
  const sourceId = idEl?.['@_extension']
    ? `${idEl['@_root'] ?? ''}:${idEl['@_extension']}`
    : idEl?.['@_root']
      ? String(idEl['@_root'])
      : '';

  // Require real content: an id, a type, or a date. A bare <encounter> with none
  // of these is a stray reference, not a visit — do not mint a record for it.
  if (!sourceId && !displayName && !dateStr) return null;

  const uri = contentHashedUri('Encounter', {
    patient: patientUri,
    displayName: displayName || undefined,
    date: dateStr || undefined,
  }, sourceId || undefined);

  const subj = namedNode(uri);
  const quads: Quad[] = [];
  quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'Encounter')));
  quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));
  if (displayName) quads.push(makeQuad(subj, namedNode(NS.cascade + 'encounterType'), literal(displayName)));
  if (dateStr) quads.push(makeQuad(subj, namedNode(NS.health + 'effectiveDate'), literal(dateStr)));
  if (sourceId) quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));

  return { subject: uri, quads };
}

export function extractEncounterQuads(
  entries: any[],
  patientUri: string,
  sourceSystem: string,
): Quad[] {
  const quads: Quad[] = [];

  for (const entry of entries) {
    // The C-CDA parser normalizes <encounter> to an array, so an entry wraps a
    // LIST of encounters — the old code read the array as a single object, so
    // every field came back undefined and all encounters in the export collapsed
    // into one bare, content-hash-identical record. Iterate the list instead.
    const encList = Array.isArray(entry?.encounter)
      ? entry.encounter
      : entry?.encounter
        ? [entry.encounter]
        : [entry];
    for (const enc of encList) {
      const built = buildEncounterRecord(enc, patientUri, sourceSystem);
      if (built) quads.push(...built.quads);
    }
  }

  return quads;
}
