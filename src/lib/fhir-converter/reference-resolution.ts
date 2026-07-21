/**
 * Cross-record reference resolution for FHIR batch conversion (root backlog 2.6).
 *
 * FHIR resources point at each other with `Reference.reference` strings
 * ("Observation/<id>", "urn:uuid:<id>", or an absolute URL). Cascade record
 * subjects, by contrast, are content-hashed (`contentHashedUri`) or
 * deterministically minted (`mintSubjectUri`) from identity fields, never from
 * the raw source id. So a reference string cannot be turned into a subject IRI
 * in isolation, and the old converters that minted `urn:uuid:<last-path-segment>`
 * produced edges that dangled 100% of the time (plus a double `urn:uuid:` prefix
 * for `urn:uuid:` fullUrl references).
 *
 * The fix: converters emit each cross-record edge with a *placeholder* object
 * (`referencePlaceholder(rawReference)`) that carries the raw reference string.
 * At the end of a conversion batch, when every resource's minted subject is
 * known, `resolveReferenceEdges` rewrites each placeholder to the referenced
 * record's real subject IRI, or drops the edge and counts it when the target is
 * not in the batch. One helper, one index, every edge family
 * (clinical:hasLabResult, coverage:relatedClaim, and any future forward edge).
 */

import { DataFactory, type Quad } from 'n3';
import {
  NS,
  CODING_SYSTEM_MAP,
  codeableConceptText,
  extractCodings,
  tripleStr,
  type EdgeResolutionSummary,
} from './types.js';
import { parsedIndicationPlaceholder } from '../literal-lifting.js';

const { namedNode, quad: makeQuad } = DataFactory;

// A placeholder object IRI is minted by a converter and consumed only by
// `resolveReferenceEdges`; none survive into serialized output.
const REF_PLACEHOLDER_PREFIX = 'urn:cascade:unresolved-ref:';
const URN_UUID_PREFIX = 'urn:uuid:';

/**
 * Wrap a raw FHIR reference string as a placeholder object IRI. Converters emit
 * `tripleRef(subject, predicate, referencePlaceholder(ref))` instead of minting
 * a fake target; the batch loop rewrites or drops it.
 */
export function referencePlaceholder(rawReference: string): string {
  return REF_PLACEHOLDER_PREFIX + encodeURIComponent(rawReference);
}

export function isReferencePlaceholder(iri: string): boolean {
  return iri.startsWith(REF_PLACEHOLDER_PREFIX);
}

/**
 * Append a `clinical:hasEncounter` edge for a FHIR `.encounter` Reference (the
 * visit an event occurred within), emitted as a resolvable placeholder that the
 * batch loop rewrites to the Encounter record's minted subject or drops and
 * counts. No-op when the reference is absent or malformed. `encounter` is the
 * FHIR Reference object (`{ reference: "Encounter/x" | "urn:uuid:x" }`).
 */
export function pushEncounterEdge(quads: Quad[], subjectUri: string, encounter: unknown): void {
  const ref = (encounter as { reference?: unknown } | null | undefined)?.reference;
  if (typeof ref === 'string' && ref.length > 0) {
    quads.push(
      makeQuad(
        namedNode(subjectUri),
        namedNode(NS.clinical + 'hasEncounter'),
        namedNode(referencePlaceholder(ref)),
      ),
    );
  }
}

/**
 * Append one `clinical:indicationReference` edge per FHIR `reasonReference` entry
 * (the condition or observation that is the clinical reason for a medication or
 * procedure). Each is a resolvable placeholder rewritten or dropped at end of
 * batch. `reasonReference` is the FHIR array (each `{ reference: "..." }`).
 * Free-text `reasonCode` is intentionally left to the existing text mappers, so
 * this never duplicates an indication a converter already records as a literal.
 */
export function pushIndicationEdges(quads: Quad[], subjectUri: string, reasonReference: unknown): void {
  if (!Array.isArray(reasonReference)) return;
  for (const r of reasonReference) {
    const ref = (r as { reference?: unknown } | null)?.reference;
    if (typeof ref === 'string' && ref.length > 0) {
      quads.push(
        makeQuad(
          namedNode(subjectUri),
          namedNode(NS.clinical + 'indicationReference'),
          namedNode(referencePlaceholder(ref)),
        ),
      );
    }
  }
}

/**
 * Capture a record's coded/free-text reason (`reasonCode`) so the M1 lifting
 * pass can turn it into a real indication edge, and so the reason itself stops
 * being discarded.
 *
 * Two things are emitted, and they are independent on purpose:
 *
 *  1. ONE `clinical:indication` literal carrying the reason's display text,
 *     retained whether or not the reason ever resolves to a condition record, so
 *     a reason the importer cannot match is still visible in the pod instead of
 *     being dropped (which is what happened to every `reasonCode` before M1).
 *     Multiple reasons are joined into a single literal because
 *     `clinical:MedicationShape` constrains `clinical:indication` to
 *     `sh:maxCount 1`.
 *  2. One placeholder edge per reason on `clinical:parsedIndicationReference`,
 *     carrying that reason's fully-qualified code IRIs. `liftTrappedLiterals`
 *     rewrites each to the matched condition's subject, or drops and counts it.
 *
 * `reasonReference` (the reference the source states explicitly) is handled
 * separately by `pushIndicationEdges` and always wins: the lifting pass skips a
 * parsed restatement of an indication the record already states.
 */
export function pushParsedIndicationCandidates(
  quads: Quad[],
  subjectUri: string,
  reasonCode: unknown,
): void {
  if (!reasonCode) return;
  const concepts = Array.isArray(reasonCode) ? reasonCode : [reasonCode];

  const texts: string[] = [];
  const placeholders: string[] = [];

  for (const cc of concepts) {
    if (!cc) continue;
    const text = codeableConceptText(cc) ?? '';
    const codes: string[] = [];
    for (const coding of extractCodings(cc)) {
      const nsUri = CODING_SYSTEM_MAP[coding.system];
      // Unmappable systems (e.g. ICD-9) are skipped: a code that cannot be
      // qualified to a Cascade code IRI can never match a condition's own code.
      if (nsUri) codes.push(nsUri + coding.code);
    }
    if (text && !texts.includes(text)) texts.push(text);
    if (codes.length > 0 || text) placeholders.push(parsedIndicationPlaceholder(codes, text));
  }

  if (texts.length > 0) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'indication', texts.join('; ')));
  }
  for (const p of placeholders) {
    quads.push(
      makeQuad(
        namedNode(subjectUri),
        namedNode(NS.clinical + 'parsedIndicationReference'),
        namedNode(p),
      ),
    );
  }
}

export function decodeReferencePlaceholder(iri: string): string {
  return decodeURIComponent(iri.slice(REF_PLACEHOLDER_PREFIX.length));
}

export interface ParsedReference {
  /** FHIR resource type if the reference carries one ("Observation/<id>"). */
  resourceType?: string;
  /** The bare resource id. */
  id: string;
}

/**
 * Normalize a FHIR `Reference.reference` string to `(resourceType?, id)`.
 * Handles:
 *   - relative references: "Observation/123"            -> {Observation, 123}
 *   - urn:uuid fullUrls:   "urn:uuid:abc"               -> {undefined, abc}
 *     (collapses an accidental double prefix "urn:uuid:urn:uuid:abc")
 *   - absolute URLs:       "https://ex/fhir/Obs/123"    -> {Obs, 123}
 *   - version suffixes:    "Observation/123/_history/2" -> {Observation, 123}
 *   - other urns / bare ids are returned as an opaque id with no type.
 */
export function parseReference(ref: string): ParsedReference | null {
  if (!ref) return null;
  let s = ref.trim();
  if (!s) return null;

  // urn:uuid: fullUrl form (Synthea and any bundle using fullUrl references).
  // Collapse a doubled prefix defensively (the old mint bug produced these).
  if (s.startsWith(URN_UUID_PREFIX)) {
    let id = s;
    while (id.startsWith(URN_UUID_PREFIX)) id = id.slice(URN_UUID_PREFIX.length);
    return id ? { id } : null;
  }
  // Any other urn: scheme — treat the whole thing as an opaque id.
  if (s.startsWith('urn:')) return { id: s };

  // Drop a FHIR version suffix ("/_history/<vid>").
  const histIdx = s.indexOf('/_history/');
  if (histIdx >= 0) s = s.slice(0, histIdx);

  const segments = s.split('/').filter((seg) => seg.length > 0);
  if (segments.length === 0) return null;
  const id = segments[segments.length - 1];
  const maybeType = segments.length >= 2 ? segments[segments.length - 2] : undefined;
  // A FHIR resource type is an upper-camel token; anything else (a host, "fhir")
  // is not a type and is ignored so we fall back to an id-only lookup.
  const resourceType = maybeType && /^[A-Z][A-Za-z]+$/.test(maybeType) ? maybeType : undefined;
  return { id, resourceType };
}

/** A converted resource and the subject IRI its record was minted under. */
export interface ConvertedResourceRef {
  resourceType: string;
  id?: string;
  subject: string;
}

/**
 * Rewrite every reference-placeholder object in `quads` to the referenced
 * record's real minted subject, using an index built over `resources`. An edge
 * is kept only when it resolves; an unresolvable reference (target absent from
 * the batch, or its converter skipped it) is dropped and counted.
 *
 * The index is keyed two ways: a typed key ("Type/id") and a bare-id fallback
 * (for `urn:uuid:` references that carry no type). A bare id that maps to two
 * different subjects is marked ambiguous and only resolvable via its typed key.
 */
export function resolveReferenceEdges(
  quads: Quad[],
  resources: ConvertedResourceRef[],
): { quads: Quad[]; stats: EdgeResolutionSummary } {
  const byKey = new Map<string, string>();
  const ambiguousIds = new Set<string>();
  for (const r of resources) {
    if (!r.id || !r.subject) continue;
    byKey.set(`${r.resourceType}/${r.id}`, r.subject);
    const existing = byKey.get(r.id);
    if (existing !== undefined && existing !== r.subject) {
      ambiguousIds.add(r.id);
    } else {
      byKey.set(r.id, r.subject);
    }
  }

  const resolve = (raw: string): string | null => {
    const parsed = parseReference(raw);
    if (!parsed) return null;
    if (parsed.resourceType) {
      const typed = byKey.get(`${parsed.resourceType}/${parsed.id}`);
      if (typed) return typed;
    }
    if (ambiguousIds.has(parsed.id)) return null;
    return byKey.get(parsed.id) ?? null;
  };

  const stats: EdgeResolutionSummary = { resolved: 0, unresolved: 0, byPredicate: {} };
  const bump = (predicate: string, key: 'resolved' | 'unresolved') => {
    const p = shortenPredicate(predicate);
    (stats.byPredicate[p] ??= { resolved: 0, unresolved: 0 })[key]++;
    stats[key]++;
  };

  const out: Quad[] = [];
  for (const q of quads) {
    if (q.object.termType === 'NamedNode' && isReferencePlaceholder(q.object.value)) {
      const target = resolve(decodeReferencePlaceholder(q.object.value));
      if (target) {
        out.push(makeQuad(q.subject, q.predicate, namedNode(target), q.graph));
        bump(q.predicate.value, 'resolved');
      } else {
        // "An edge is written only when it resolves": drop and count.
        bump(q.predicate.value, 'unresolved');
      }
      continue;
    }
    out.push(q);
  }
  return { quads: out, stats };
}

/** Compact a Cascade predicate IRI to a `prefix:local` label for the report. */
function shortenPredicate(iri: string): string {
  const nsToPrefix: Array<[string, string]> = [
    [NS.clinical, 'clinical'],
    [NS.coverage, 'coverage'],
    [NS.health, 'health'],
    [NS.cascade, 'cascade'],
  ];
  for (const [ns, prefix] of nsToPrefix) {
    if (iri.startsWith(ns)) return `${prefix}:${iri.slice(ns.length)}`;
  }
  return iri;
}
