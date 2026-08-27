/**
 * Extract encounters from C-CDA section (templateId 2.16.840.1.113883.10.20.22.2.22)
 * Narrative is preserved by the main converter.
 *
 * The shared `buildEncounterRecord` helper mints one clinical:Encounter record
 * from a C-CDA <encounter> element and is reused by the Results-section walk
 * (sections/labs.ts), which links each lab panel to the visit it was collected
 * in via clinical:hasEncounter. Both paths therefore produce identical,
 * dedupe-safe encounter records (encounter completeness).
 *
 * The `<effectiveTime>` was read here for IDENTITY long before it was read for
 * CONTENT: the record's key had the visit's day in it while the record itself
 * carried no start, no end and no encounter date, so every encounter this
 * converter produced was undated to the shapes and to every consumer. It now
 * states its time, through the same typed-date helper the other section
 * handlers use, and its identity is computed from the same field in the same
 * order as before so that no existing encounter re-mints.
 */

import { NS } from '../../fhir-converter/types.js';
import { ccdaDateQuad } from '../dates.js';
import { listOf } from '../multivalued.js';
import { ccdaRecordUri, ccdaSourceId } from '../record-identity.js';
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
 * The raw `@value` of one HL7 TS element, under either attribute spelling the
 * C-CDA parser can hand back.
 */
function tsValue(el: any): unknown {
  if (el === null || el === undefined) return undefined;
  return el?.['@_value'] ?? el?.value;
}

/**
 * The three ways an `<encounter>` states WHEN, split apart.
 *
 * A C-CDA Encounters section writes an interval (`<low>`/`<high>`) for a visit
 * with a start and an end, and a single `@value` for one stated as a day. Both
 * are ordinary and both were being read for identity only, so every encounter
 * this converter produced was undated as far as the shapes and every consumer
 * were concerned.
 */
function encounterTimes(enc: any): { low: unknown; high: unknown; single: unknown } {
  const effTime = enc?.effectiveTime ?? {};
  return {
    low: tsValue(effTime?.low),
    high: tsValue(effTime?.high),
    single: tsValue(effTime),
  };
}

/**
 * Build one clinical:Encounter record from a C-CDA <encounter> element, or null
 * when the element carries no usable identity (no id, type, or date — a bare
 * reference rather than a real definition).
 *
 * Identity is the shared C-CDA rule: the encounter's own `<id>` decides, and
 * without one the key is type + date. The same encounter appearing across many
 * lab organizers or documents therefore dedupes to one record.
 */
export function buildEncounterRecord(
  enc: any,
  sourceSystem: string,
  warnings?: string[],
): CcdaEncounterRecord | null {
  if (!enc || typeof enc !== 'object' || Array.isArray(enc)) return null;

  const codeEl = enc?.code ?? {};
  const displayName = encounterDisplayName(codeEl);

  const { low, high, single } = encounterTimes(enc);
  // IDENTITY INPUT, UNCHANGED. Same field, same order, same day-precision
  // formatting as before the encounter learned to state its time: an encounter
  // IRI that moves is a duplicate visit on every pod that already holds the
  // record, plus a dangling clinical:hasEncounter edge from everything that
  // pointed at it.
  const dateVal = single ?? low ?? '';
  const dateStr = formatCcdaDate(dateVal as string);

  const sourceId = ccdaSourceId(enc?.id);

  // Require real content: an id, a type, or a date. A bare <encounter> with none
  // of these is a stray reference, not a visit — do not mint a record for it.
  if (!sourceId && !displayName && !dateStr) return null;

  const uri = ccdaRecordUri({
    type: 'Encounter',
    sourceId,
    content: {
      displayName: displayName || undefined,
      date: dateStr || undefined,
    },
    source: enc,
    warnings,
    label: 'C-CDA encounter',
  });

  const subj = namedNode(uri);
  const quads: Quad[] = [];
  quads.push(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'Encounter')));
  quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)));
  // THE TYPE, IN THE CANONICAL SPELLING AND THE OLD ONE.
  //
  // `clinical:EncounterShape` constrains `clinical:encounterType` and says
  // nothing about `cascade:encounterType`, and the FHIR path has always written
  // the `clinical:` one. So an encounter's type was validated on one transport
  // and invisible on the other, and a consumer reading either spelling saw half
  // the encounters in a pod that holds both. `clinical:` is canonical because
  // the shapes already say so.
  //
  // The `cascade:` spelling is dual-written for one release rather than
  // migrated in place: readers exist (this repo's own C-CDA tests, and anything
  // downstream that learned the old spelling), and retiring a predicate is a
  // change with its own blast radius and its own measurement.
  if (displayName) {
    quads.push(makeQuad(subj, namedNode(NS.clinical + 'encounterType'), literal(displayName)));
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'encounterType'), literal(displayName)));
  }
  // Kept, unchanged and untyped, because the reconciler reads
  // health:effectiveDate. Moving a record's date out from under a matcher in the
  // same change that gives it a second one is two changes wearing one commit.
  if (dateStr) quads.push(makeQuad(subj, namedNode(NS.health + 'effectiveDate'), literal(dateStr)));

  // WHEN THE VISIT WAS, said so the shapes and every consumer can see it.
  //
  // clinical:EncounterTemporalShape asks for encounterStart, encounterEnd or
  // encounterDate; this handler wrote none of the three, so every encounter the
  // C-CDA path produced fired its Warning — including the ones whose section
  // states the times outright. `<high>` was not read at any site.
  //
  // Each triple states exactly what the document stated and nothing else: an
  // interval becomes a start and an end, a single value becomes a date, and a
  // source that gave neither gets neither. The literals go through ccdaDateQuad,
  // the same typed-date chokepoint the labs, problems, immunizations and vitals
  // handlers use, so an encounter's precision rule is not a fifth opinion.
  for (const [predicate, raw] of [
    [NS.clinical + 'encounterStart', low],
    [NS.clinical + 'encounterEnd', high],
    [NS.clinical + 'encounterDate', single],
  ] as const) {
    const q = ccdaDateQuad(uri, predicate, raw, warnings);
    if (q) quads.push(q);
  }

  // THE VISIT'S IDENTIFIER, on both spellings, for the same reason as the type
  // above. `clinical:sourceRecordId` is what
  // clinical:EncounterShape constrains; `cascade:sourceRecordId` is what the
  // reconciler's encounter matcher and the FHIR path's `Encounter.identifier`
  // emission both key on, so it is also the cross-transport join key and stays.
  if (sourceId) {
    quads.push(makeQuad(subj, namedNode(NS.clinical + 'sourceRecordId'), literal(sourceId)));
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'sourceRecordId'), literal(sourceId)));
  }

  return { subject: uri, quads };
}

export function extractEncounterQuads(
  entries: any[],
  sourceSystem: string,
  _sectionText?: any,
  _importedAt?: string,
  warnings?: string[],
): Quad[] {
  const quads: Quad[] = [];

  for (const entry of entries) {
    // The C-CDA parser normalizes <encounter> to an array, so an entry wraps a
    // LIST of encounters — the old code read the array as a single object, so
    // every field came back undefined and all encounters in the export collapsed
    // into one bare, content-hash-identical record. Iterate the list instead.
    const encList = entry?.encounter ? listOf<any>(entry.encounter) : [entry];
    for (const enc of encList) {
      const built = buildEncounterRecord(enc, sourceSystem, warnings);
      if (built) quads.push(...built.quads);
    }
  }

  return quads;
}
