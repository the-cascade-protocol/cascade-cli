/**
 * Literal lifting: turn relation-shaped LITERALS into real, traversable,
 * basis-labeled record-to-record edges (graph-meaning slice M1).
 *
 * Two families of relation are present in real pods but trapped in strings, so
 * no graph query can follow them:
 *
 *   (a) `clinical:linkedConditionIds` — a single literal packing the UUIDs of
 *       related conditions (Cascade Checkup writes these COMMA-separated and
 *       lowercased; the v1.10 deprecation comment's "space-separated" wording is
 *       wrong, so both delimiters are accepted). Deprecated in clinical v1.10 in
 *       favor of the real `clinical:linkedCondition` edge, which this pass
 *       materializes. The source literal is retained: removing it rides a later
 *       cleanup with Checkup's own data migration.
 *
 *   (b) A coded/free-text reason on a medication or procedure (FHIR
 *       `reasonCode`, or a `clinical:indication` / `clinical:reasonForUse`
 *       literal). The FHIR converter emits the reason as a `clinical:indication`
 *       literal (never dropped, so nothing is lost even when it does not
 *       resolve) plus a placeholder edge carrying the reason's codes; this pass
 *       matches that against the condition records in scope and materializes
 *       `clinical:parsedIndicationReference` (clinical v1.12), a subproperty of
 *       `clinical:indicationReference`. The subproperty IS the basis label: a
 *       stated `indicationReference` restates a reference the source carried,
 *       while the parsed variant records a match this importer computed, and one
 *       traversal over the superproperty still returns both.
 *
 * Two rules govern both families, inherited from the R1 edge work:
 *   - An edge is written only when it RESOLVES. Unresolved, ambiguous, and
 *     unmatched cases are counted for the import report, never guessed.
 *   - Matching is deterministic, so a re-run over the same input is
 *     byte-identical. Candidate sets are sorted before the unambiguity check.
 *
 * Deliberately NOT in scope: any INFERRED edge (co-occurrence, timing,
 * terminology hierarchy). Those never enter the pod; they are computed at query
 * time (ratified GM-Q2). This pass only restates what a record already says.
 */

import { DataFactory, type Quad } from 'n3';
import { NS } from './fhir-converter/types.js';

const { namedNode, quad: makeQuad } = DataFactory;

// ---------------------------------------------------------------------------
// Predicates and types this pass reads and writes
// ---------------------------------------------------------------------------

const LINKED_CONDITION_IDS = NS.clinical + 'linkedConditionIds';
const LINKED_CONDITION = NS.clinical + 'linkedCondition';
const PARSED_INDICATION_REFERENCE = NS.clinical + 'parsedIndicationReference';
const INDICATION_REFERENCE = NS.clinical + 'indicationReference';
const RDF_TYPE = NS.rdf + 'type';

/**
 * rdf:type values that mark a record as a condition, across every producer:
 * `health:ConditionRecord` (both cascade-cli importer paths, FHIR and C-CDA),
 * `clinical:Condition` (the clinical vocabulary's own class), and
 * `checkup:ConditionSummary` (Cascade Checkup, the only real producer of the
 * `linkedConditionIds` literal this pass lifts).
 */
const CONDITION_TYPES = new Set([
  NS.health + 'ConditionRecord',
  NS.clinical + 'Condition',
  'https://ns.cascadeprotocol.org/checkup/v1#ConditionSummary',
]);

/**
 * Code predicates carried by condition records, mapped to the code system the
 * value belongs to. Both the `health:` and `clinical:` spellings appear in real
 * data, and the object may be an IRI (cascade-cli importers mint
 * `<http://snomed.info/sct/44054006>`) or a bare literal (Checkup writes
 * `clinical:snomedCode "44054006"`), so both forms normalize to one key.
 */
const CONDITION_CODE_PREDICATES: Record<string, string> = {
  [NS.health + 'snomedCode']: NS.sct,
  [NS.clinical + 'snomedCode']: NS.sct,
  [NS.health + 'icd10Code']: NS.icd10,
  [NS.clinical + 'icd10Code']: NS.icd10,
};

/** Name predicates carried by condition records, for the fallback match. */
const CONDITION_NAME_PREDICATES = [
  NS.health + 'conditionName',
  NS.clinical + 'conditionName',
  'https://ns.cascadeprotocol.org/checkup/v1#conditionName',
];

/**
 * Free-text indication literals that can be lifted on their own. These reach a
 * pod through the Turtle passthrough path (Cascade Checkup writes
 * `checkup:reasonForUse`; a previously-imported pod carries `clinical:indication`)
 * rather than through the FHIR converter, so they arrive with no coded candidate
 * attached and only the name fallback can resolve them.
 */
const INDICATION_TEXT_PREDICATES = [
  NS.clinical + 'indication',
  NS.clinical + 'reasonForUse',
  'https://ns.cascadeprotocol.org/checkup/v1#reasonForUse',
];

// ---------------------------------------------------------------------------
// Parsed-indication placeholder (emitted by the converter, consumed here)
// ---------------------------------------------------------------------------

const PARSED_INDICATION_PREFIX = 'urn:cascade:parsed-indication:';

/** The reason a record carries, as the converter captured it from the source. */
export interface ParsedIndicationPayload {
  /** Fully-qualified code IRIs for the reason, e.g. `http://snomed.info/sct/38341003`. */
  codes: string[];
  /** The reason's display text, for the name fallback and the retained literal. */
  text: string;
}

/**
 * Wrap a source record's coded reason as a placeholder object IRI. The converter
 * emits `<record> clinical:parsedIndicationReference <placeholder>`; this module
 * rewrites it to the matched condition's subject or drops it. No placeholder
 * ever survives into a written pod: `resolveParsedIndications` is called on
 * every path that serializes (see `convert()` and `pod import`).
 */
export function parsedIndicationPlaceholder(codes: string[], text: string): string {
  return PARSED_INDICATION_PREFIX + encodeURIComponent(JSON.stringify({ c: codes, t: text }));
}

export function isParsedIndicationPlaceholder(iri: string): boolean {
  return iri.startsWith(PARSED_INDICATION_PREFIX);
}

export function decodeParsedIndicationPlaceholder(iri: string): ParsedIndicationPayload | null {
  try {
    const raw = decodeURIComponent(iri.slice(PARSED_INDICATION_PREFIX.length));
    const parsed = JSON.parse(raw) as { c?: unknown; t?: unknown };
    const codes = Array.isArray(parsed.c) ? parsed.c.filter((c): c is string => typeof c === 'string') : [];
    const text = typeof parsed.t === 'string' ? parsed.t : '';
    return { codes, text };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Report tallies
// ---------------------------------------------------------------------------

/**
 * Per-family outcome of one lifting pass, surfaced in the import report so the
 * counts that were only measurable by hand in the Phase 0 census become a
 * standing, per-import number.
 */
export interface LiteralLiftSummary {
  linkedCondition: {
    /** Edges written (one per resolved UUID). */
    lifted: number;
    /** UUIDs in the literal that matched no condition record in scope. */
    unresolved: number;
  };
  parsedIndication: {
    /** Edges written (exactly one candidate matched). */
    lifted: number;
    /** Reasons whose match was ambiguous (more than one candidate). */
    ambiguous: number;
    /** Reasons that matched no condition record in scope. */
    unmatched: number;
    /** Reasons skipped because the record already states this indication. */
    redundant: number;
  };
}

export function emptyLiftSummary(): LiteralLiftSummary {
  return {
    linkedCondition: { lifted: 0, unresolved: 0 },
    parsedIndication: { lifted: 0, ambiguous: 0, unmatched: 0, redundant: 0 },
  };
}

export function mergeLiftSummary(into: LiteralLiftSummary, add: LiteralLiftSummary): void {
  into.linkedCondition.lifted += add.linkedCondition.lifted;
  into.linkedCondition.unresolved += add.linkedCondition.unresolved;
  into.parsedIndication.lifted += add.parsedIndication.lifted;
  into.parsedIndication.ambiguous += add.parsedIndication.ambiguous;
  into.parsedIndication.unmatched += add.parsedIndication.unmatched;
  into.parsedIndication.redundant += add.parsedIndication.redundant;
}

export function liftSummaryTotal(s: LiteralLiftSummary): number {
  return (
    s.linkedCondition.lifted + s.linkedCondition.unresolved +
    s.parsedIndication.lifted + s.parsedIndication.ambiguous +
    s.parsedIndication.unmatched + s.parsedIndication.redundant
  );
}

// ---------------------------------------------------------------------------
// Condition index
// ---------------------------------------------------------------------------

interface ConditionIndex {
  /** Bare UUID (however the record identifies itself) -> subject IRIs. */
  byUuid: Map<string, Set<string>>;
  /** Fully-qualified code IRI -> subject IRIs. */
  byCode: Map<string, Set<string>>;
  /** Normalized condition name -> subject IRIs. */
  byName: Map<string, Set<string>>;
  /** Every condition subject, for self-link and membership checks. */
  subjects: Set<string>;
}

/** Lowercase, strip punctuation, collapse whitespace. */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function addTo(map: Map<string, Set<string>>, key: string, subject: string): void {
  if (!key) return;
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(subject);
}

/**
 * Index every condition record in `quads` by the keys a trapped literal can
 * reference it with: any UUID embedded in its subject IRI or carried as a source
 * record id (Checkup's `<#condition-<uuid>>` fragment and the importers'
 * `urn:uuid:<uuid>` subjects both land here), its code IRIs, and its normalized
 * name.
 */
function buildConditionIndex(quads: Quad[]): ConditionIndex {
  const index: ConditionIndex = {
    byUuid: new Map(),
    byCode: new Map(),
    byName: new Map(),
    subjects: new Set(),
  };

  for (const q of quads) {
    if (q.predicate.value === RDF_TYPE && CONDITION_TYPES.has(q.object.value)) {
      index.subjects.add(q.subject.value);
    }
  }
  if (index.subjects.size === 0) return index;

  // Every UUID appearing in the subject IRI itself identifies the record.
  for (const subject of index.subjects) {
    for (const m of subject.match(UUID_RE) ?? []) addTo(index.byUuid, m.toLowerCase(), subject);
  }

  for (const q of quads) {
    const subject = q.subject.value;
    if (!index.subjects.has(subject)) continue;
    const pred = q.predicate.value;

    // Source record ids are the other way a literal can name a record.
    if (pred === NS.health + 'sourceRecordId' || pred === NS.cascade + 'sourceRecordId') {
      const v = q.object.value.trim().toLowerCase();
      addTo(index.byUuid, v, subject);
      for (const m of v.match(UUID_RE) ?? []) addTo(index.byUuid, m, subject);
      continue;
    }

    const codeNs = CONDITION_CODE_PREDICATES[pred];
    if (codeNs) {
      // IRI object: already fully qualified. Literal object (Checkup): qualify
      // it with the namespace this predicate implies, so both forms share a key.
      const key = q.object.termType === 'NamedNode' ? q.object.value : codeNs + q.object.value.trim();
      addTo(index.byCode, key, subject);
      continue;
    }

    if (CONDITION_NAME_PREDICATES.includes(pred)) {
      addTo(index.byName, normalizeName(q.object.value), subject);
    }
  }

  return index;
}

/**
 * One canonical key for "this subject already has this edge to this object".
 * The separator is an explicit \u0000 escape (never a raw control character in
 * source, which makes the file read as binary to grep and friends) so that every
 * call site produces byte-identical keys: a mismatched separator here silently
 * disables duplicate suppression and re-imports grow duplicate edges.
 */
function edgeKey(subject: string, predicate: string, object: string): string {
  return `${subject}\u0000${predicate}\u0000${object}`;
}

/** Deterministic single-candidate resolution: sorted, and unambiguous only. */
function soleCandidate(set: Set<string> | undefined, exclude?: string): string | null {
  if (!set) return null;
  const candidates = [...set].filter((s) => s !== exclude).sort();
  return candidates.length === 1 ? candidates[0] : null;
}

function candidateCount(set: Set<string> | undefined, exclude?: string): number {
  if (!set) return 0;
  return [...set].filter((s) => s !== exclude).length;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * Lift both trapped-literal families over one quad set, returning the rewritten
 * quads and the tally. Pure: the input array is not mutated.
 *
 * Call this on any quad set that is about to be serialized, so no
 * parsed-indication placeholder can survive into written output.
 */
export function liftTrappedLiterals(quads: Quad[]): { quads: Quad[]; stats: LiteralLiftSummary } {
  const stats = emptyLiftSummary();
  const index = buildConditionIndex(quads);

  // Edges already present, so a re-import (or a record that already states an
  // indication) never produces a duplicate or a redundant parsed restatement.
  const existingEdges = new Set<string>();
  for (const q of quads) {
    if (q.object.termType !== 'NamedNode') continue;
    const p = q.predicate.value;
    if (p === LINKED_CONDITION || p === PARSED_INDICATION_REFERENCE || p === INDICATION_REFERENCE) {
      existingEdges.add(edgeKey(q.subject.value, p, q.object.value));
      // A stated indication also suppresses the parsed restatement of itself.
      if (p === INDICATION_REFERENCE) {
        existingEdges.add(edgeKey(q.subject.value, PARSED_INDICATION_REFERENCE, q.object.value));
      }
    }
  }

  // Subjects whose reason already arrived as a coded candidate from the FHIR
  // converter. Their free-text `clinical:indication` literal is the SAME reason
  // restated, so lifting it again would double-count; the coded path owns them.
  const hasCodedCandidate = new Set<string>();
  for (const q of quads) {
    if (
      q.predicate.value === PARSED_INDICATION_REFERENCE &&
      q.object.termType === 'NamedNode' &&
      isParsedIndicationPlaceholder(q.object.value)
    ) {
      hasCodedCandidate.add(q.subject.value);
    }
  }

  const out: Quad[] = [];
  const appended: Quad[] = [];

  for (const q of quads) {
    // ---- (b) parsed indication: resolve the placeholder, or drop it ---------
    if (
      q.predicate.value === PARSED_INDICATION_REFERENCE &&
      q.object.termType === 'NamedNode' &&
      isParsedIndicationPlaceholder(q.object.value)
    ) {
      const payload = decodeParsedIndicationPlaceholder(q.object.value);
      if (!payload) {
        stats.parsedIndication.unmatched++;
        continue;
      }
      const subject = q.subject.value;

      // Code-first: exact coding identity against the condition's own code.
      // Measured on a real provider export, this is the signal that works;
      // normalized-name matching alone resolved nothing there.
      let matched: string | null = null;
      let sawAmbiguous = false;
      for (const code of payload.codes) {
        const bucket = index.byCode.get(code);
        const n = candidateCount(bucket, subject);
        if (n > 1) { sawAmbiguous = true; continue; }
        const sole = soleCandidate(bucket, subject);
        if (sole) { matched = sole; break; }
      }

      // Fallback: exact normalized-name equality (never substring, which would
      // trade precision for recall on clinical names).
      if (!matched && payload.text) {
        const bucket = index.byName.get(normalizeName(payload.text));
        const n = candidateCount(bucket, subject);
        if (n > 1) sawAmbiguous = true;
        matched = soleCandidate(bucket, subject);
      }

      if (!matched) {
        if (sawAmbiguous) stats.parsedIndication.ambiguous++;
        else stats.parsedIndication.unmatched++;
        continue;
      }

      const key = edgeKey(subject, PARSED_INDICATION_REFERENCE, matched);
      if (existingEdges.has(key)) {
        stats.parsedIndication.redundant++;
        continue;
      }
      existingEdges.add(key);
      out.push(makeQuad(q.subject, q.predicate, namedNode(matched), q.graph));
      stats.parsedIndication.lifted++;
      continue;
    }

    out.push(q);

    // ---- (a) linkedConditionIds -> linkedCondition --------------------------
    // The source literal is retained (kept in `out` above); the edge is added
    // alongside it.
    if (q.predicate.value === LINKED_CONDITION_IDS && q.object.termType === 'Literal') {
      const subject = q.subject.value;
      // Checkup emits comma-separated lowercased UUIDs; the deprecated
      // property's own comment says space-separated. Accept both, plus stray
      // semicolons, rather than trusting either wording.
      const ids = q.object.value
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      for (const id of ids) {
        const target = soleCandidate(index.byUuid.get(id), subject);
        if (!target) {
          stats.linkedCondition.unresolved++;
          continue;
        }
        const key = edgeKey(subject, LINKED_CONDITION, target);
        if (existingEdges.has(key)) continue;
        existingEdges.add(key);
        appended.push(makeQuad(q.subject, namedNode(LINKED_CONDITION), namedNode(target), q.graph));
        stats.linkedCondition.lifted++;
      }
    }

    // ---- (b) free-text indication literal with no coded candidate ----------
    // The Turtle-passthrough path: a record that already carries its reason as
    // a bare string (Checkup's reasonForUse, or an earlier import's
    // clinical:indication). Only the name fallback can resolve these, so the
    // yield is low by nature; the literal is retained either way.
    if (
      q.object.termType === 'Literal' &&
      INDICATION_TEXT_PREDICATES.includes(q.predicate.value) &&
      !hasCodedCandidate.has(q.subject.value)
    ) {
      const subject = q.subject.value;
      const bucket = index.byName.get(normalizeName(q.object.value));
      const n = candidateCount(bucket, subject);
      const target = soleCandidate(bucket, subject);
      if (!target) {
        if (n > 1) stats.parsedIndication.ambiguous++;
        else stats.parsedIndication.unmatched++;
      } else {
        const key = edgeKey(subject, PARSED_INDICATION_REFERENCE, target);
        if (existingEdges.has(key)) {
          stats.parsedIndication.redundant++;
        } else {
          existingEdges.add(key);
          appended.push(
            makeQuad(q.subject, namedNode(PARSED_INDICATION_REFERENCE), namedNode(target), q.graph),
          );
          stats.parsedIndication.lifted++;
        }
      }
    }
  }

  return { quads: out.concat(appended), stats };
}
