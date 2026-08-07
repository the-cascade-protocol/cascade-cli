/**
 * Core reconciliation logic extracted from the reconcile command.
 *
 * Exported so that other commands (e.g., pod import) can reuse reconciliation
 * without going through the CLI layer.
 */

import { createHash } from 'node:crypto';
import { Parser, Writer, DataFactory } from 'n3';
import type { Quad, Quad_Subject, Quad_Object } from 'n3';
import { NS, TURTLE_PREFIXES, deterministicUuid } from './fhir-converter/types.js';
import {
  buildReferenceResolver,
  buildResourceRefsFromQuads,
  decodeReferencePlaceholder,
  isReferencePlaceholder,
} from './fhir-converter/reference-resolution.js';
import { normalizeMedName, normalizeDose, normalizeFrequency, type DrugNameNormalizer } from './medication-normalize.js';
import { medicationCodeKeys, sharedMedicationCodeKey } from './code-keys.js';
import { cascadeTerminologyResolver } from './terminology.js';
import { relBase, relBaseFor, derelativizeQuads } from './bucket-write.js';

// Re-export so existing consumers of the reconciler's normalizeMedName keep
// working. The canonical definition now lives in ./medication-normalize.ts
// (shared, byte-identical to sdk-typescript).
export { normalizeMedName };

const { namedNode, literal, blankNode, quad: makeQuad } = DataFactory;

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface ReconcilerOptions {
  trustScores?: Record<string, number>;
  labTolerance?: number;
  /**
   * Brand-to-generic resolver applied during medication name normalization, so
   * a brand and its generic (Zyrtec / cetirizine) dedupe without a shared code.
   * Defaults to the bundled Cascade terminology asset; pass
   * `identityTerminologyResolver` to disable (asset-free behaviour).
   */
  terminologyResolver?: DrugNameNormalizer;
  /**
   * When `false` (the opt-in guard, Checkup parity), matched records that come
   * from different provenance classes (`clinical:provenanceClass`) are flagged
   * for review instead of auto-merged. Defaults to `true` (merge allowed), since
   * cross-source dedup is the primary goal; set `false` for the conservative
   * stance that never silently merges across provenance.
   */
  allowCrossProvenanceMerge?: boolean;
}

export interface ReconcilerInput {
  content: string;    // Turtle string
  systemName: string;
}

export interface ReconcilerResult {
  turtle: string;
  report: {
    sources: Array<{ system: string; count: number }>;
    summary: {
      totalInputRecords: number;
      exactDuplicatesRemoved: number;
      nearDuplicatesMerged: number;
      /**
       * Input records dropped because another input in the same run already
       * contributed their subject IRI: the signature of re-importing a document
       * the pod already holds (Cascade subjects are content-hashed, so the same
       * record mints the same IRI every run).
       *
       * Disjoint from `exactDuplicatesRemoved` / `nearDuplicatesMerged`, which
       * count MATCH-driven merges of records that arrived under DIFFERENT
       * subject IRIs. Both are "duplicates" for a caller that wants one number;
       * they are separate because only this one means "this input was already in
       * the pod, byte for byte".
       */
      duplicateSubjectsDropped: number;
      conflictsResolved: number;
      conflictsUnresolved: number;
      /**
       * Minted IRIs that two or more MATERIALLY DIFFERENT records claimed, and
       * that were therefore split apart instead of one being dropped as a
       * duplicate.
       *
       * Disjoint from `duplicateSubjectsDropped` by construction, and the point
       * of the distinction: a shared IRI whose holders agree is a re-import and
       * is counted there; a shared IRI whose holders disagree is an identity
       * collision, counted here, and every one of them also appears in
       * `unresolvedConflicts` (so it reaches `settings/pending-conflicts.ttl`).
       * Non-zero means the identity key that minted those IRIs is narrower than
       * the records it is identifying.
       */
      identityCollisionsSplit: number;
      finalRecordCount: number;
      /** Subjects preserved verbatim because their type is not reconcilable. */
      passthroughSubjects: number;
      /**
       * Record-to-record edge objects redirected from a merged-away (discarded)
       * subject to its surviving canonical subject during serialization
       *. Zero when no referenced record was merged, e.g.
       * a fresh single import. Excludes lineage predicates (dangling by design).
       */
      edgeObjectsRewritten: number;
    };
    transformations: object[];
    unresolvedConflicts: object[];
  };
}

// ---------------------------------------------------------------------------
// Cascade record types
// ---------------------------------------------------------------------------

type CascadeRecordType =
  | 'clinical:Medication'
  | 'health:ConditionRecord'
  | 'health:AllergyRecord'
  | 'health:LabResultRecord'
  | 'health:ImmunizationRecord'
  | 'clinical:VitalSign'
  | 'cascade:PatientProfile'
  | 'coverage:InsurancePlan';

const KNOWN_TYPES: Record<string, CascadeRecordType> = {
  [NS.clinical + 'Medication']:        'clinical:Medication',
  [NS.health + 'ConditionRecord']:    'health:ConditionRecord',
  [NS.health + 'AllergyRecord']:      'health:AllergyRecord',
  [NS.health + 'LabResultRecord']:    'health:LabResultRecord',
  [NS.health + 'ImmunizationRecord']: 'health:ImmunizationRecord',
  [NS.clinical + 'VitalSign']:        'clinical:VitalSign',
  [NS.cascade + 'PatientProfile']:    'cascade:PatientProfile',
  [NS.coverage + 'InsurancePlan']:    'coverage:InsurancePlan',
};

// ---------------------------------------------------------------------------
// Parser: Turtle → records
// ---------------------------------------------------------------------------

interface RdfValue {
  value: string;
  /** xsd:* datatype URI for typed literals; undefined for URIs and plain strings */
  datatype?: string;
  /**
   * True when the object was a NamedNode. Recorded at parse time because the
   * re-emission below otherwise has to GUESS from the string, and its guess
   * ("starts with http or urn:") demotes every other scheme to a literal —
   * which is how a pod's `prov:wasAttributedTo </profile/card.ttl#me>` came
   * back from an import as the string "undefined/profile/card.ttl#me".
   */
  isIri?: boolean;
}

interface ParsedRecord {
  uri: string;
  type: CascadeRecordType;
  sourceSystem: string;
  properties: Map<string, RdfValue[]>;
}

export async function parseTurtle(turtle: string, defaultSystem: string): Promise<ParsedRecord[]> {
  return new Promise((resolve, reject) => {
    // Sentinel base: pod content arrives here on its way back to the pod, and a
    // relative IRI must survive the trip. N3's default resolves
    // </profile/card.ttl#me> to "undefined/profile/card.ttl#me"; the sentinel is
    // stripped back off at the bucket write chokepoint. It is chosen against
    // THIS text, so nothing the document itself says can be mistaken for it.
    const parser = new Parser({ format: 'Turtle', baseIRI: relBaseFor(turtle) });
    const bySubject = new Map<string, Array<{ pred: string; obj: RdfValue }>>();

    parser.parse(turtle, (error, quad) => {
      if (error) { reject(error); return; }
      if (!quad) {
        const records: ParsedRecord[] = [];
        for (const [uri, triples] of bySubject) {
          const typeTriple = triples.find(t => t.pred === NS.rdf + 'type');
          if (!typeTriple || !KNOWN_TYPES[typeTriple.obj.value]) continue;

          const properties = new Map<string, RdfValue[]>();
          for (const t of triples) {
            const existing = properties.get(t.pred);
            if (existing) {
              // Deduplicate: skip if this exact value is already present
              const isDup = existing.some(v => v.value === t.obj.value && v.datatype === t.obj.datatype);
              if (!isDup) existing.push(t.obj);
            } else {
              properties.set(t.pred, [t.obj]);
            }
          }

          const sourceSystem = properties.get(NS.cascade + 'sourceSystem')?.[0]?.value ?? defaultSystem;
          records.push({ uri, type: KNOWN_TYPES[typeTriple.obj.value], sourceSystem, properties });
        }
        resolve(records);
        return;
      }
      const subj = quad.subject.value;
      if (!bySubject.has(subj)) bySubject.set(subj, []);
      const obj = quad.object;
      const rdfVal: RdfValue = obj.termType === 'Literal' && obj.datatype?.value && obj.datatype.value !== NS.xsd + 'string'
        ? { value: obj.value, datatype: obj.datatype.value }
        : { value: obj.value, isIri: obj.termType === 'NamedNode' };
      bySubject.get(subj)!.push({ pred: quad.predicate.value, obj: rdfVal });
    });
  });
}

// ---------------------------------------------------------------------------
// Passthrough: subjects the reconciler does not understand
// ---------------------------------------------------------------------------

/**
 * Collect the quads of every subject that is NOT a reconcilable record, i.e.
 * whose rdf:type is outside KNOWN_TYPES or that has no rdf:type at all, plus
 * the input's complete quad list.
 *
 * The reconciler only understands the KNOWN_TYPES record families. Everything
 * else (clinical:ClinicalDocument narrative documents and their
 * requiresLLMExtraction flags, encounters, imaging studies, procedures, FHIR
 * passthrough nodes, provenance activities, ...) must survive reconciliation
 * verbatim. Before this existed, any reconciliation pass silently dropped
 * those subjects from the merged output.
 *
 * `all` carries every quad of the input, reconcilable records included: the
 * reference-resolution index (`buildResourceRefsFromQuads`) is built from the
 * `sourceRecordId` literals that records persist, and those live on RECORD
 * subjects, so the placeholder-equivalence dedup below cannot be computed from
 * the passthrough slice alone.
 */
async function collectQuads(turtle: string): Promise<{ passthrough: Quad[]; all: Quad[] }> {
  return new Promise((resolve, reject) => {
    // Same sentinel base as parseTurtle above: passthrough subjects are copied
    // verbatim into the reconciled output, so their relative IRIs must not be
    // rewritten on the way through.
    const parser = new Parser({ format: 'Turtle', baseIRI: relBaseFor(turtle) });
    const quadsBySubject = new Map<string, Quad[]>();
    const all: Quad[] = [];

    parser.parse(turtle, (error, quad) => {
      if (error) { reject(error); return; }
      if (!quad) {
        const passthrough: Quad[] = [];
        for (const quads of quadsBySubject.values()) {
          const typeQuad = quads.find(q => q.predicate.value === NS.rdf + 'type');
          if (typeQuad && KNOWN_TYPES[typeQuad.object.value]) continue; // reconciled elsewhere
          passthrough.push(...quads);
        }
        resolve({ passthrough, all });
        return;
      }
      all.push(quad);
      const subjKey = `${quad.subject.termType}:${quad.subject.value}`;
      const bucket = quadsBySubject.get(subjKey);
      if (bucket) bucket.push(quad);
      else quadsBySubject.set(subjKey, [quad]);
    });
  });
}

/** Stable identity for cross-input deduplication of passthrough quads. */
function quadKey(q: Quad): string {
  const o = q.object;
  const objKey = o.termType === 'Literal'
    ? `L:${o.value}|${o.datatype?.value ?? ''}|${o.language ?? ''}`
    : `${o.termType}:${o.value}`;
  return `${q.subject.termType}:${q.subject.value}|${q.predicate.value}|${objKey}`;
}

/**
 * Re-label blank nodes per input so labels from independent parses cannot
 * collide. Named-node quads (the converters' normal output) pass unchanged.
 */
function relabelQuadBlankNodes(q: Quad, inputIndex: number): Quad {
  if (q.subject.termType !== 'BlankNode' && q.object.termType !== 'BlankNode') return q;
  const subj: Quad_Subject = q.subject.termType === 'BlankNode'
    ? blankNode(`in${inputIndex}_${q.subject.value}`)
    : q.subject;
  const obj: Quad_Object = q.object.termType === 'BlankNode'
    ? blankNode(`in${inputIndex}_${q.object.value}`)
    : q.object;
  return makeQuad(subj, q.predicate, obj);
}

// ---------------------------------------------------------------------------
// Single-cardinality passthrough repair
// ---------------------------------------------------------------------------
//
// Passthrough subjects (clinical:ClinicalDocument, clinical:LaboratoryReport,
// ...) are carried verbatim and deduplicated by full quad identity, which
// collapses a re-imported quad only when its OBJECT is byte-identical. A few
// single-cardinality predicates carry a value that legitimately changes every
// import run: `clinical:importedAt` is stamped `new Date().toISOString()` at
// conversion time while the subject is content-hash-stable (the timestamp is
// deliberately excluded from the identity hash). So a monthly re-import gives
// the same document a SECOND importedAt and it fails SHACL `sh:maxCount 1`
// ("Clinical document must have exactly one importedAt timestamp"). Collapse
// each such predicate to a single value per subject.
//
// Scope is deliberately importedAt-only. The sibling predicates that CAN hit the
// same trap (`prov:generatedAtTime`, `clinical:sourceEHR` on a cross-source
// re-import, and the genomics `GeneticTest.generatedAtTime`) are catalogued in
// `docs/2026-07-16-single-cardinality-passthrough-survey.md` and deferred, so
// this fix stays minimal; adding a sibling here is a one-line change once its
// intended-value semantics are decided.
const SINGLE_CARDINALITY_PASSTHROUGH_PREDICATES: ReadonlySet<string> = new Set<string>([
  NS.clinical + 'importedAt',
]);

/**
 * Keep exactly one object per (subject, single-cardinality predicate) in a
 * passthrough quad list, choosing the lexicographically smallest value. For the
 * ISO-8601 UTC timestamps this targets, that is the EARLIEST time, i.e. when the
 * record first entered the pod, which stays stable across any number of later
 * re-imports (deterministic, no churn). Every other quad passes through
 * untouched and in its original order; returns the input array unchanged when no
 * single-cardinality predicate is present.
 */
function collapseSingleCardinalityPassthrough(quads: Quad[]): Quad[] {
  const keep = new Map<string, string>(); // `${subjectKey}\u0000${predicate}` -> winning object value
  const subjectKey = (q: Quad) => `${q.subject.termType}:${q.subject.value}`;
  for (const q of quads) {
    if (!SINGLE_CARDINALITY_PASSTHROUGH_PREDICATES.has(q.predicate.value)) continue;
    const key = `${subjectKey(q)}\u0000${q.predicate.value}`;
    const cur = keep.get(key);
    if (cur === undefined || q.object.value < cur) keep.set(key, q.object.value);
  }
  if (keep.size === 0) return quads;

  const emitted = new Set<string>();
  const out: Quad[] = [];
  for (const q of quads) {
    if (SINGLE_CARDINALITY_PASSTHROUGH_PREDICATES.has(q.predicate.value)) {
      const key = `${subjectKey(q)}\u0000${q.predicate.value}`;
      if (q.object.value !== keep.get(key)) continue; // drop a later run's duplicate value
      if (emitted.has(key)) continue;                 // keep exactly one winning quad
      emitted.add(key);
    }
    out.push(q);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stated-edge re-import idempotence
// ---------------------------------------------------------------------------
//
// Record-to-record edges (clinical:hasEncounter, clinical:indicationReference,
// clinical:hasLabResult, coverage:relatedClaim, ...) reach the reconciler in TWO
// different shapes, and quad-identity dedup cannot see that they are the same
// statement:
//
//   * already RESOLVED, as the pod holds it:  <proc> hasEncounter <urn:uuid:86ed…>
//   * still a PLACEHOLDER, as a fresh convert emits it (reference resolution is
//     deferred to once per import invocation, R5):
//                                             <proc> hasEncounter <urn:cascade:unresolved-ref:Encounter%2Fenc-1>
//
// On a re-import the pod contributes the first and the new input the second.
// Both survive `quadKey` dedup (their objects differ byte-wise), the caller then
// resolves the placeholder to the very same target, and the passthrough subject
// ends up with the edge stated TWICE. Every re-sync added another copy: measured
// `hasEncounter` 200 -> 214 and `indicationReference` 5 -> 8 on a real pull, with
// Turtle bytes +18%. Same family as the `clinical:importedAt` duplication above,
// one resolution stage further out.
//
// The repair keys each passthrough edge on where its object RESOLVES TO rather
// than on the object's current spelling, and keeps one quad per key. It cannot
// simply drop placeholders that share a (subject, predicate) with a resolved
// edge: a lab report legitimately gains a third result, and that placeholder
// names a target the pod does not have yet.

/**
 * Collapse passthrough edge quads that name the same target through different
 * spellings, keeping ONE quad per (subject, predicate, resolved-target).
 *
 * `resolveRef` maps a raw FHIR reference string to the subject IRI it resolves
 * to over this run's inputs (`null` when the target is absent). A placeholder
 * whose target cannot be resolved keys on its own IRI, so it is never confused
 * with a different unresolvable edge and still reaches the caller's resolution
 * pass to be dropped-and-counted there.
 *
 * The ALREADY-RESOLVED spelling wins whenever both are present, for two reasons:
 * the pod's own copy of an edge is the one whose target provably exists, and
 * keeping it means the surviving quad needs no further rewriting. Emission order
 * follows each key's first occurrence, so output stays byte-stable; an input set
 * with no placeholder/resolved pair (every single import, where all edges are
 * placeholders) is returned untouched.
 */
function collapseResolvedEquivalentEdges(
  quads: Quad[],
  resolveRef: (raw: string) => string | null,
): Quad[] {
  // Where a quad's object lands once references are resolved. Non-placeholder
  // objects are already there; a placeholder resolves, or keys on itself.
  const targetOf = (q: Quad): string => {
    const v = q.object.value;
    if (q.object.termType !== 'NamedNode' || !isReferencePlaceholder(v)) return v;
    return resolveRef(decodeReferencePlaceholder(v)) ?? v;
  };
  const keyOf = (q: Quad): string =>
    `${q.subject.termType}:${q.subject.value}|${q.predicate.value}|${targetOf(q)}`;

  // Winner per key: the first non-placeholder quad if any, else the first quad.
  const winner = new Map<string, Quad>();
  let collapsed = 0;
  for (const q of quads) {
    if (q.object.termType !== 'NamedNode') continue;
    const key = keyOf(q);
    const current = winner.get(key);
    if (current === undefined) {
      winner.set(key, q);
      continue;
    }
    collapsed++;
    const currentIsPlaceholder = isReferencePlaceholder(current.object.value);
    if (currentIsPlaceholder && !isReferencePlaceholder(q.object.value)) winner.set(key, q);
  }
  if (collapsed === 0) return quads;

  const emitted = new Set<string>();
  const out: Quad[] = [];
  for (const q of quads) {
    if (q.object.termType !== 'NamedNode') { out.push(q); continue; }
    const key = keyOf(q);
    if (emitted.has(key)) continue;
    emitted.add(key);
    out.push(winner.get(key) ?? q);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Identity collisions: telling a collision apart from a re-import
// ---------------------------------------------------------------------------
//
// Two records can arrive under the SAME subject IRI for two completely
// different reasons, and until this section existed the reconciler could not
// tell them apart:
//
//   RE-IMPORT   — the same source record, imported twice. Cascade subjects are
//                 content-hashed, so this is the expected and overwhelmingly
//                 common case. Passing over the second arrival is correct: it
//                 carries nothing the first does not.
//
//   COLLISION   — two DIFFERENT records that the identity layer minted onto one
//                 IRI, because the minting key was narrower than the records
//                 (e.g. a lab key of {patient, LOINC, date} for a fasting and a
//                 post-prandial glucose drawn on the same day). Passing over the
//                 second arrival here silently destroys a clinical value, and
//                 WHICH value survives is decided by the order the inputs were
//                 enumerated — i.e. by the filesystem.
//
// The old code assumed the first case unconditionally (`assigned.has(uri)`), so
// the second was invisible: the run reported the loser as a duplicate, wrote no
// conflict, and printed nothing.
//
// THE RULE APPLIED HERE is the one stated in `lib/identity.ts`: when identity is
// uncertain, PREFER A SPLIT OVER A MERGE. A split is recoverable because both
// records are still present and can be reconciled later by a tool or a person; a
// merge is not, because the loser's content is simply gone. So a collision does
// not pick a winner — every distinct content gets its own IRI, and the collision
// is raised as an unresolved conflict so a human is asked which (if either) is
// the duplicate.
//
// WHY THE ASSIGNMENT IS ORDER-INDEPENDENT. The colliding contents are ranked by
// their own fingerprints, not by arrival order: the lexicographically smallest
// fingerprint keeps the original IRI and every other distinct fingerprint moves
// to an IRI derived from (original IRI, fingerprint). Reversing the input order
// therefore produces a byte-identical pod, which is the actual repair for "the
// filesystem decides which glucose value you keep". Keeping the smallest at the
// original IRI also means the IRI stays occupied, so nothing that referenced it
// starts dangling.
//
// WHY IT IS STABLE ACROSS RE-IMPORTS. The derived IRI is a pure function of the
// original IRI and the record's own content fingerprint, so importing the same
// pair of records again re-derives the same two IRIs, matches the pod's existing
// copies, and drops them as the re-imports they are. The pod does not grow.

/**
 * Predicates ignored when fingerprinting a record's content for collision
 * detection.
 *
 * Every entry is a claim that the predicate can legitimately DIFFER between two
 * encounters with the same logical record, so a difference in it is not evidence
 * of two different records. Getting this list wrong in the permissive direction
 * hides a collision; getting it wrong in the strict direction turns every
 * re-import into a false conflict and grows the pod on every sync, which is the
 * defect `lib/identity.ts` exists to prevent. Both errors are visible in tests.
 */
const COLLISION_IGNORED_PREDICATES: ReadonlySet<string> = new Set<string>([
  // Stamped `new Date().toISOString()` at conversion time; changes every run.
  NS.clinical + 'importedAt',
  NS.prov + 'generatedAtTime',
  // Written by the reconciler itself, so a record read back out of the pod
  // carries them and a freshly converted one does not.
  NS.cascade + 'reconciliationStatus',
  NS.cascade + 'mergedFrom',
  NS.cascade + 'mergedSources',
  NS.cascade + 'discardedRecords',
  NS.cascade + 'conflictResolution',
  NS.cascade + 'conflictField',
  NS.cascade + 'conflictValues',
  NS.prov + 'wasDerivedFrom',
  // Ingestion bookkeeping, not clinical content. `sourceSystem` in particular is
  // re-derived at serialization and is the axis two cross-source copies of one
  // result differ on — those are duplicates for the matcher to merge, not
  // evidence that two different results exist.
  NS.cascade + 'sourceSystem',
  NS.cascade + 'dataProvenance',
  NS.cascade + 'schemaVersion',
  // The originating server's record id, and the EHR it came from. Two copies of
  // ONE result retrieved from two systems carry different values here while
  // saying the same clinical thing, and the identity layer has already declared
  // them one record by minting them one IRI. Treating that as evidence of two
  // different results would raise a conflict on every cross-source duplicate —
  // the common, benign case — and bury the ones where the VALUES disagree, which
  // are the whole point. A genuine collision differs on clinical content too.
  NS.cascade + 'sourceRecordId',
  NS.clinical + 'sourceRecordId',
  NS.health + 'sourceRecordId',
  NS.clinical + 'sourceEHR',
]);

/**
 * One property value as the POD will hold it.
 *
 * A record-to-record edge exists in three spellings that all mean one thing, and
 * a comparison that cannot see through them cannot tell a re-import from a
 * collision:
 *
 *   - resolved (`urn:uuid:…`)  — how the pod stores it, once an import has
 *                                resolved the reference;
 *   - placeholder, resolvable  — how a freshly converted record carries it,
 *                                because reference resolution happens once per
 *                                import invocation (R5), after conversion;
 *   - placeholder, unresolvable — a reference to a record that is not in the
 *                                batch and not in the pod. The import pipeline
 *                                DROPS these rather than persisting them, so the
 *                                pod's copy of the record simply has no such
 *                                property. Returning `undefined` here is what
 *                                makes the fresh copy agree with it.
 *
 * Measured against this repo's `apple-health-multifile` fixture, which carries a
 * deliberately dangling `Encounter/enc-MISSING`: without the resolvable case, 3
 * false collisions on the second import and 6 on the third; without the
 * unresolvable case, 1 and 2. Both grow without bound, because each false split
 * mints a new IRI that the next import collides with in turn.
 */
function normalizeEdgeValue(
  value: string,
  resolveRef?: (raw: string) => string | null,
): string | undefined {
  if (!isReferencePlaceholder(value)) return value;
  return resolveRef?.(decodeReferencePlaceholder(value)) ?? undefined;
}

/**
 * A content fingerprint for one parsed record: SHA-256 over its
 * (predicate, value, datatype) triples, sorted, with
 * {@link COLLISION_IGNORED_PREDICATES} removed.
 *
 * Sorted because the parser's property order follows the input document's, and
 * two serializations of one record may order their triples differently.
 * Exported so a test can assert the fingerprint itself is order-independent
 * rather than only observing its effect.
 */
export function recordContentFingerprint(
  r: ParsedRecord,
  resolveRef?: (raw: string) => string | null,
): string {
  const parts: string[] = [];
  for (const [pred, vals] of r.properties) {
    if (COLLISION_IGNORED_PREDICATES.has(pred)) continue;
    for (const v of vals) {
      const value = normalizeEdgeValue(v.value, resolveRef);
      if (value === undefined) continue;  // an unresolvable edge is never persisted
      // `\u0000` as an ESCAPE, never as a raw byte: a literal NUL in a .ts file
      // makes grep and ripgrep classify it as binary and silently skip the whole
      // file, which is how a defect in this very module went unfound.
      parts.push(`${pred}\u0000${value}\u0000${v.datatype ?? ''}`);
    }
  }
  parts.sort();
  return createHash('sha256').update(parts.join('\u0001'), 'utf8').digest('hex');
}

/** `https://ns.cascadeprotocol.org/health/v1#resultValue` -> `health:resultValue`. */
function shortPredicate(iri: string): string {
  for (const [prefix, ns] of Object.entries(NS)) {
    if (iri.startsWith(ns)) return `${prefix}:${iri.slice(ns.length)}`;
  }
  return iri;
}

/** One IRI that two or more materially different records both claimed. */
export interface IdentityCollision {
  /** The IRI the identity layer minted for all of them. */
  mintedUri: string;
  recordType: CascadeRecordType;
  /** Final IRI of each distinct content, smallest fingerprint first. */
  resultingUris: string[];
  /** Source systems involved, deduplicated, in the order first seen. */
  sourceSystems: string[];
  /**
   * Predicates the colliding records DISAGREE on, sorted.
   *
   * The answer to the only question a person resolving this conflict has ("what
   * is actually different about these two?"), and the answer a bare pair of
   * IRIs cannot give. Surfaced as the pending conflict's label.
   */
  differingPredicates: string[];
}

/**
 * The IRI a colliding content is moved to.
 *
 * Domain-separated (`identity-collision:`) so it can never equal an IRI any
 * converter mints, and derived from nothing but the original IRI and the
 * record's own fingerprint, so it is reproducible on any machine, in any
 * directory, in any input order.
 */
function collisionSplitUri(mintedUri: string, fingerprint: string): string {
  return `urn:uuid:${deterministicUuid(`identity-collision:${mintedUri}::${fingerprint}`)}`;
}

/**
 * Which predicates a set of colliding records disagree on: present-with-
 * different-values on at least two of them, or present on some and absent on
 * others. Ignored predicates are excluded, so this always explains the same
 * difference the fingerprint saw.
 */
function differingPredicates(
  bucket: ParsedRecord[],
  resolveRef?: (raw: string) => string | null,
): string[] {
  const normalize = (r: ParsedRecord, pred: string): string | undefined => {
    const vals = r.properties.get(pred);
    if (!vals) return undefined;
    const normalized = vals
      .map((v) => normalizeEdgeValue(v.value, resolveRef))
      .filter((v): v is string => v !== undefined)
      .sort();
    return normalized.length > 0 ? normalized.join(', ') : undefined;
  };
  const preds = new Set<string>();
  for (const r of bucket) for (const p of r.properties.keys()) {
    if (!COLLISION_IGNORED_PREDICATES.has(p)) preds.add(p);
  }
  const out: string[] = [];
  for (const p of preds) {
    const seen = new Set(bucket.map((r) => normalize(r, p)));
    if (seen.size > 1) out.push(p);
  }
  return out.sort();
}

/**
 * Re-key every record whose minted IRI is shared by two or more materially
 * different records, so that no record is dropped for being a "duplicate" of
 * something it does not match.
 *
 * Records that share an IRI *and* a fingerprint are left completely alone: they
 * are a re-import, and the caller's existing `assigned.has(uri)` pass-over is
 * the correct handling for them.
 *
 * Runs to a fixpoint because a split can move a record onto an IRI that an
 * earlier import already assigned to different content (a pod record edited
 * between runs). The bound is defensive; one round settles every real case.
 */
export function splitIdentityCollisions(
  records: ParsedRecord[],
  resolveRef?: (raw: string) => string | null,
): {
  records: ParsedRecord[];
  collisions: IdentityCollision[];
  /**
   * Which collision each split record came out of, keyed by its FINAL uri.
   *
   * The matcher must not pair two records from one collision back together: the
   * identity layer said they were the same record, their contents said
   * otherwise, and that disagreement has just been raised as a question for a
   * person. Auto-merging them by trust priority in the same run would answer
   * that question silently, by discarding one of the two values — which is the
   * behaviour this whole change exists to remove, reintroduced one layer later.
   */
  collisionGroupByUri: Map<string, string>;
} {
  const collisions: IdentityCollision[] = [];
  const collisionGroupByUri = new Map<string, string>();
  const fingerprints = new Map<ParsedRecord, string>();
  for (const r of records) fingerprints.set(r, recordContentFingerprint(r, resolveRef));

  let current = records;
  for (let round = 0; round < 8; round++) {
    const byUri = new Map<string, ParsedRecord[]>();
    for (const r of current) {
      const bucket = byUri.get(r.uri);
      if (bucket) bucket.push(r);
      else byUri.set(r.uri, [r]);
    }

    const rekeyed = new Map<ParsedRecord, string>();
    for (const [uri, bucket] of byUri) {
      if (bucket.length < 2) continue;
      const distinct = [...new Set(bucket.map((r) => fingerprints.get(r)!))].sort();
      if (distinct.length < 2) continue;  // a re-import, not a collision

      // Smallest fingerprint keeps `uri`; the rest move. Ranking on the
      // fingerprint rather than on position is what makes this independent of
      // the order the inputs were enumerated.
      const target = new Map<string, string>();
      for (let i = 1; i < distinct.length; i++) target.set(distinct[i], collisionSplitUri(uri, distinct[i]));
      for (const r of bucket) {
        const to = target.get(fingerprints.get(r)!);
        if (to) rekeyed.set(r, to);
      }
      for (const u of [uri, ...distinct.slice(1).map((fp) => target.get(fp)!)]) {
        collisionGroupByUri.set(u, uri);
      }
      collisions.push({
        mintedUri: uri,
        recordType: bucket[0].type,
        resultingUris: [uri, ...distinct.slice(1).map((fp) => target.get(fp)!)],
        sourceSystems: [...new Set(bucket.map((r) => r.sourceSystem))],
        differingPredicates: differingPredicates(bucket, resolveRef),
      });
    }

    if (rekeyed.size === 0) return { records: current, collisions, collisionGroupByUri };
    current = current.map((r) => {
      const to = rekeyed.get(r);
      if (!to) return r;
      const moved: ParsedRecord = { ...r, uri: to };
      fingerprints.set(moved, fingerprints.get(r)!);
      return moved;
    });
  }
  return { records: current, collisions, collisionGroupByUri };
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function normalizeConditionName(name: string): string {
  return name.toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

function getProp(r: ParsedRecord, pred: string): string | undefined {
  return r.properties.get(pred)?.[0]?.value;
}

function codeFromUri(uri: string): string {
  return uri.split('/').pop() ?? uri.split('#').pop() ?? uri;
}

function dateOnly(dt: string): string { return dt.split('T')[0] ?? dt; }

// ---------------------------------------------------------------------------
// Medication divergence helpers (Phase 2: dose/frequency/status conflicts)
// ---------------------------------------------------------------------------

/**
 * FHIR/Cascade medication status values that mean the medication is NOT active.
 * Everything else (including `active`, `on-hold`, `draft`, `unknown`, or an
 * absent status) is treated as active. Used for the status-split so an active
 * record and a discontinued record of the same drug never collapse silently.
 */
const INACTIVE_MED_STATUSES = new Set([
  'stopped', 'discontinued', 'inactive', 'cancelled', 'canceled',
  'completed', 'entered-in-error',
]);

/** Coarse active/inactive classification of a medication's status string. */
function medicationActivity(status: string | undefined): 'active' | 'inactive' {
  if (!status) return 'active';
  return INACTIVE_MED_STATUSES.has(status.toLowerCase().trim()) ? 'inactive' : 'active';
}

/**
 * True when both values are present and differ after normalization.
 *
 * A value present on only one side is intentionally NOT a conflict: it is a
 * fill-in handled as a near-duplicate merge (resolveGroup copies the missing
 * field), not a user-actionable disagreement. This tightens Checkup's raw
 * nil-safe predicate (`a != b && (a != nil || b != nil)`) for the CLI, where a
 * conflict is a blocking gate (`cascade pod conflicts` exits 1) and drives a
 * keep-A / keep-B decision: only a genuine disagreement (e.g. 10 mg vs 20 mg)
 * warrants that, never "one source recorded a dose and the other didn't."
 */
function bothPresentAndDiffer(
  a: string | undefined,
  b: string | undefined,
  norm: (s: string) => string,
): boolean {
  if (a == null || b == null || a === '' || b === '') return false;
  return norm(a) !== norm(b);
}

/** True when exactly one of the two values is present (a mergeable fill-in). */
function onlyOneSide(a: string | undefined, b: string | undefined): boolean {
  const pa = a != null && a !== '';
  const pb = b != null && b !== '';
  return pa !== pb;
}

type MatchResult = { match: boolean; confidence: number; matchedOn: string };

/** All drug code URIs a record carries: clinical:rxNormCode + clinical:drugCode[]. */
function medCodeUris(r: ParsedRecord): string[] {
  const rx = (r.properties.get(NS.clinical + 'rxNormCode') ?? []).map(v => v.value);
  const codes = (r.properties.get(NS.clinical + 'drugCode') ?? []).map(v => v.value);
  return [...rx, ...codes];
}

/** Confidence per code-ladder tier at which two medications share an identity. */
const MED_TIER_CONFIDENCE: Record<string, number> = {
  rxnorm: 1.0,
  snomed: 0.95,
  ndc: 0.92,
  atc: 0.85,
  name: 0.85,
};

function matchMedications(a: ParsedRecord, b: ParsedRecord, resolver?: DrugNameNormalizer): MatchResult {
  // Walk the weighted code ladder (RxNorm > SNOMED > NDC > ATC > normalized
  // name) via the shared SDK primitive, so an NDC-only or SNOMED-only pair still
  // matches without an RxNorm code, instead of over-relying on the name match.
  // The resolver maps brand to generic so e.g. Zyrtec and cetirizine match.
  const nA = normalizeMedName(getProp(a, NS.clinical + 'drugName') ?? '', resolver);
  const nB = normalizeMedName(getProp(b, NS.clinical + 'drugName') ?? '', resolver);
  const keysA = medicationCodeKeys(medCodeUris(a), nA || undefined);
  const keysB = medicationCodeKeys(medCodeUris(b), nB || undefined);
  const shared = sharedMedicationCodeKey(keysA, keysB);
  if (shared) {
    const confidence = MED_TIER_CONFIDENCE[shared.system] ?? 0.80;
    const matchedOn = shared.system === 'name' ? `name:"${shared.value}"` : `${shared.system}:${shared.value}`;
    return { match: true, confidence, matchedOn };
  }

  // Partial-name fallback (substring containment), unchanged from the prior matcher.
  if (nA && nB && (nA.includes(nB) || nB.includes(nA))) return { match: true, confidence: 0.70, matchedOn: `partial-name` };
  return { match: false, confidence: 0, matchedOn: '' };
}

function matchConditions(a: ParsedRecord, b: ParsedRecord): MatchResult {
  const sA = getProp(a, NS.health + 'snomedCode');
  const sB = getProp(b, NS.health + 'snomedCode');
  if (sA && sB && codeFromUri(sA) === codeFromUri(sB)) return { match: true, confidence: 1.0, matchedOn: `snomed:${codeFromUri(sA)}` };

  const iA = getProp(a, NS.health + 'icd10Code');
  const iB = getProp(b, NS.health + 'icd10Code');
  if (iA && iB && codeFromUri(iA) === codeFromUri(iB)) return { match: true, confidence: 0.95, matchedOn: `icd10:${codeFromUri(iA)}` };

  const nA = normalizeConditionName(getProp(a, NS.health + 'conditionName') ?? '');
  const nB = normalizeConditionName(getProp(b, NS.health + 'conditionName') ?? '');
  if (nA && nB && nA === nB) return { match: true, confidence: 0.80, matchedOn: `name:"${nA}"` };
  return { match: false, confidence: 0, matchedOn: '' };
}

function matchAllergies(a: ParsedRecord, b: ParsedRecord): MatchResult {
  const nA = (getProp(a, NS.health + 'allergen') ?? '').toLowerCase().trim();
  const nB = (getProp(b, NS.health + 'allergen') ?? '').toLowerCase().trim();
  if (nA && nB && nA === nB) return { match: true, confidence: 0.90, matchedOn: `allergen:"${nA}"` };
  return { match: false, confidence: 0, matchedOn: '' };
}

function matchLabs(a: ParsedRecord, b: ParsedRecord, tol: number): MatchResult {
  const lA = getProp(a, NS.health + 'testCode');
  const lB = getProp(b, NS.health + 'testCode');
  const dA = dateOnly(getProp(a, NS.health + 'performedDate') ?? '');
  const dB = dateOnly(getProp(b, NS.health + 'performedDate') ?? '');
  const vA = parseFloat(getProp(a, NS.health + 'resultValue') ?? 'NaN');
  const vB = parseFloat(getProp(b, NS.health + 'resultValue') ?? 'NaN');
  const sameDay = dA && dB && dA === dB;
  const sameLoinc = lA && lB && codeFromUri(lA) === codeFromUri(lB);

  if (sameLoinc && sameDay) {
    if (!isNaN(vA) && !isNaN(vB)) {
      const diff = Math.abs(vA - vB) / Math.max(Math.abs(vA), 0.001);
      const conf = diff <= tol ? (diff === 0 ? 1.0 : 0.90) : 0.85;
      return { match: true, confidence: conf, matchedOn: `loinc:${codeFromUri(lA)}+${dA}` };
    }
    return { match: true, confidence: 0.90, matchedOn: `loinc:${codeFromUri(lA)}+${dA}` };
  }
  const nA = (getProp(a, NS.health + 'testName') ?? '').toLowerCase().trim();
  const nB = (getProp(b, NS.health + 'testName') ?? '').toLowerCase().trim();
  if (nA && nB && nA === nB && sameDay) return { match: true, confidence: 0.75, matchedOn: `name:"${nA}"+${dA}` };
  return { match: false, confidence: 0, matchedOn: '' };
}

function matchImmunizations(a: ParsedRecord, b: ParsedRecord): MatchResult {
  // Tier 1: CVX code + exact date (high confidence)
  const cA = getProp(a, NS.health + 'cvxCode');
  const cB = getProp(b, NS.health + 'cvxCode');
  const dA = dateOnly(getProp(a, NS.health + 'administrationDate') ?? getProp(a, NS.health + 'startDate') ?? '');
  const dB = dateOnly(getProp(b, NS.health + 'administrationDate') ?? getProp(b, NS.health + 'startDate') ?? '');

  if (cA && cB && codeFromUri(cA) === codeFromUri(cB) && dA && dA === dB)
    return { match: true, confidence: 1.0, matchedOn: `cvx:${codeFromUri(cA)}+${dA}` };

  // Tier 2: Vaccine name (normalized) + date -- fallback when CVX absent
  const nA = (getProp(a, NS.health + 'vaccineName') ?? '').toLowerCase().trim();
  const nB = (getProp(b, NS.health + 'vaccineName') ?? '').toLowerCase().trim();
  if (nA && nB && nA !== 'unknown vaccine' && nA === nB && dA && dA === dB)
    return { match: true, confidence: 0.80, matchedOn: `name:"${nA}"+${dA}` };

  // Tier 3: Vaccine name match, no date -- very conservative
  if (nA && nB && nA !== 'unknown vaccine' && nA === nB)
    return { match: true, confidence: 0.60, matchedOn: `name-only:"${nA}"` };

  return { match: false, confidence: 0, matchedOn: '' };
}

function matchVitalSigns(a: ParsedRecord, b: ParsedRecord): MatchResult {
  const lcA = getProp(a, NS.health + 'testCode');  // LOINC
  const lcB = getProp(b, NS.health + 'testCode');
  const dtA = dateOnly(getProp(a, NS.health + 'effectiveDate') ?? getProp(a, NS.health + 'performedDate') ?? '');
  const dtB = dateOnly(getProp(b, NS.health + 'effectiveDate') ?? getProp(b, NS.health + 'performedDate') ?? '');

  if (lcA && lcB && codeFromUri(lcA) === codeFromUri(lcB) && dtA && dtA === dtB) {
    // Same LOINC, same day -- check value proximity
    const vA = parseFloat(getProp(a, NS.health + 'value') ?? 'NaN');
    const vB = parseFloat(getProp(b, NS.health + 'value') ?? 'NaN');
    if (!isNaN(vA) && !isNaN(vB)) {
      const diff = Math.abs(vA - vB) / Math.max(Math.abs(vA), 0.001);
      if (diff <= 0.05) return { match: true, confidence: 0.95, matchedOn: `loinc:${codeFromUri(lcA)}+${dtA}` };
      if (diff <= 0.15) return { match: true, confidence: 0.75, matchedOn: `loinc-approx:${codeFromUri(lcA)}+${dtA}` };
    }
    return { match: true, confidence: 0.85, matchedOn: `loinc:${codeFromUri(lcA)}+${dtA}` };
  }
  return { match: false, confidence: 0, matchedOn: '' };
}

function matchPatientProfiles(a: ParsedRecord, b: ParsedRecord): MatchResult {
  const dobA = getProp(a, NS.cascade + 'dateOfBirth');
  const dobB = getProp(b, NS.cascade + 'dateOfBirth');
  const sexA = getProp(a, NS.cascade + 'biologicalSex');
  const sexB = getProp(b, NS.cascade + 'biologicalSex');

  if (dobA && dobB && dobA === dobB && sexA && sexB && sexA === sexB) {
    return { match: true, confidence: 0.95, matchedOn: `dob:${dobA}+sex:${sexA}` };
  }
  // Try DOB alone (lower confidence)
  if (dobA && dobB && dobA === dobB) {
    return { match: true, confidence: 0.75, matchedOn: `dob:${dobA}` };
  }
  return { match: false, confidence: 0, matchedOn: '' };
}

/**
 * Returns the confidence threshold to use when comparing two records.
 *
 * Records from summarization documents (LOINC 34133-9, e.g. MyChart "Summarization
 * of Episode Note") contain the patient's full history snapshot.  When the same
 * patient imports multiple such summaries, every clinical fact appears once per
 * summary export.  A lower threshold (0.50) catches these cross-summary duplicates
 * that would otherwise be missed at the standard threshold of 0.65.
 *
 * Additive documents (progress notes, discharge summaries) represent a single
 * encounter; their records are kept at the standard 0.65 threshold.
 */
function getMatchThreshold(a: ParsedRecord, b: ParsedRecord): number {
  const aIsSummary = getProp(a, NS.cascade + 'documentType') === 'summarization';
  const bIsSummary = getProp(b, NS.cascade + 'documentType') === 'summarization';
  if (aIsSummary || bIsSummary) return 0.50;
  return 0.65;
}

function doRecordsMatch(a: ParsedRecord, b: ParsedRecord, tol: number, resolver?: DrugNameNormalizer): MatchResult {
  if (a.type !== b.type) return { match: false, confidence: 0, matchedOn: '' };
  switch (a.type) {
    case 'clinical:Medication':        return matchMedications(a, b, resolver);
    case 'health:ConditionRecord':    return matchConditions(a, b);
    case 'health:AllergyRecord':      return matchAllergies(a, b);
    case 'health:LabResultRecord':    return matchLabs(a, b, tol);
    case 'health:ImmunizationRecord': return matchImmunizations(a, b);
    case 'clinical:VitalSign':        return matchVitalSigns(a, b);
    case 'cascade:PatientProfile':    return matchPatientProfiles(a, b);
    default:                          return { match: false, confidence: 0, matchedOn: '' };
  }
}

// ---------------------------------------------------------------------------
// Conflict classification
// ---------------------------------------------------------------------------

type MatchType = 'exact_duplicate' | 'near_duplicate' | 'status_conflict' | 'value_conflict' | 'pass_through';

function classifyGroup(
  records: ParsedRecord[],
  tol: number,
  resolver?: DrugNameNormalizer,
): { matchType: MatchType; conflictField?: string; conflictValues?: Record<string, string> } {
  if (records.length < 2) return { matchType: 'pass_through' };
  const [a, b] = records;

  if (a.type === 'health:ConditionRecord') {
    const sA = getProp(a, NS.health + 'status');
    const sB = getProp(b, NS.health + 'status');
    if (sA && sB && sA !== sB)
      return { matchType: 'status_conflict', conflictField: 'health:status', conflictValues: { [a.sourceSystem]: sA, [b.sourceSystem]: sB } };
  }
  if (a.type === 'health:AllergyRecord') {
    const sA = getProp(a, NS.health + 'allergySeverity');
    const sB = getProp(b, NS.health + 'allergySeverity');
    if (sA && sB && sA !== sB)
      return { matchType: 'value_conflict', conflictField: 'health:allergySeverity', conflictValues: { [a.sourceSystem]: sA, [b.sourceSystem]: sB } };
  }
  if (a.type === 'health:LabResultRecord') {
    const vA = parseFloat(getProp(a, NS.health + 'resultValue') ?? 'NaN');
    const vB = parseFloat(getProp(b, NS.health + 'resultValue') ?? 'NaN');
    if (!isNaN(vA) && !isNaN(vB)) {
      const diff = Math.abs(vA - vB) / Math.max(Math.abs(vA), 0.001);
      if (diff > tol) return { matchType: 'value_conflict', conflictField: 'health:resultValue', conflictValues: { [a.sourceSystem]: String(vA), [b.sourceSystem]: String(vB) } };
      if (diff > 0)   return { matchType: 'near_duplicate' };
    }
  }
  if (a.type === 'clinical:Medication') {
    // (1) Status split: an active record and a stopped/discontinued record of
    // the same drug is a clinically significant divergence, never a silent
    // merge. (Reference: Checkup SimplifiedImportProcessor splits active vs
    // stopped before dedup.)
    const actA = medicationActivity(getProp(a, NS.clinical + 'status'));
    const actB = medicationActivity(getProp(b, NS.clinical + 'status'));
    if (actA !== actB) {
      return {
        matchType: 'status_conflict',
        conflictField: 'clinical:status',
        conflictValues: {
          [a.sourceSystem]: getProp(a, NS.clinical + 'status') ?? '(none)',
          [b.sourceSystem]: getProp(b, NS.clinical + 'status') ?? '(none)',
        },
      };
    }

    // (2) Dose / frequency disagreement: the flagship conflict the Reconcile tab
    // exists for (e.g. "Lisinopril 10 mg" vs "20 mg"). Compared on the shared
    // normalized form so "10 mg" / "10mg" / "10 milligrams" do NOT conflict.
    const doseA = getProp(a, NS.clinical + 'dosage');
    const doseB = getProp(b, NS.clinical + 'dosage');
    if (bothPresentAndDiffer(doseA, doseB, normalizeDose)) {
      return {
        matchType: 'value_conflict',
        conflictField: 'clinical:dosage',
        conflictValues: { [a.sourceSystem]: doseA as string, [b.sourceSystem]: doseB as string },
      };
    }
    const freqA = getProp(a, NS.clinical + 'frequency') ?? getProp(a, NS.health + 'frequency');
    const freqB = getProp(b, NS.clinical + 'frequency') ?? getProp(b, NS.health + 'frequency');
    if (bothPresentAndDiffer(freqA, freqB, normalizeFrequency)) {
      return {
        matchType: 'value_conflict',
        conflictField: 'clinical:frequency',
        conflictValues: { [a.sourceSystem]: freqA as string, [b.sourceSystem]: freqB as string },
      };
    }

    // (3) No divergence. Mergeable differences (a different normalized name, or
    // a dose/frequency present on only one side) are near-duplicates so
    // resolveGroup fills in the missing fields; otherwise an exact duplicate.
    const nA = normalizeMedName(getProp(a, NS.clinical + 'drugName') ?? '', resolver);
    const nB = normalizeMedName(getProp(b, NS.clinical + 'drugName') ?? '', resolver);
    const mergeable = nA !== nB || onlyOneSide(doseA, doseB) || onlyOneSide(freqA, freqB);
    return { matchType: mergeable ? 'near_duplicate' : 'exact_duplicate' };
  }
  return { matchType: 'exact_duplicate' };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface Group {
  matchType: MatchType;
  confidence: number;
  records: ParsedRecord[];
  matchedOn: string;
  conflictField?: string;
  conflictValues?: Record<string, string>;
}

interface Resolution {
  canonical: ParsedRecord;
  mergedUris: string[];
  mergedSystems: string[];
  strategy: string;
  resolved: boolean;
}

function completeness(r: ParsedRecord): number {
  const skip = new Set([NS.rdf + 'type', NS.cascade + 'dataProvenance', NS.cascade + 'schemaVersion', NS.cascade + 'sourceSystem']);
  let n = 0;
  for (const [p] of r.properties) if (!skip.has(p)) n++;
  return n;
}

/**
 * Provenance-class boost added to a record's trust when selecting a merge
 * winner, mapping Checkup's evidence weighting (MedicationReconciler
 * `evidenceWeight`: +30/+20/+10/+5) onto the 0-1 trust scale. A high-provenance
 * record (e.g. HealthKit FHIR) can outrank a higher-trust source carrying weaker
 * provenance. Records without a `clinical:provenanceClass` get no boost.
 */
const PROVENANCE_BOOST: Record<string, number> = {
  healthKitFHIR: 0.30,
  pharmacyClaim: 0.20,
  userTracked: 0.10,
  imported: 0.05,
};

function provenanceBoost(r: ParsedRecord): number {
  const pc = getProp(r, NS.clinical + 'provenanceClass');
  return pc ? (PROVENANCE_BOOST[pc] ?? 0) : 0;
}

function resolveGroup(
  g: Group,
  trustScores: Record<string, number>,
  defaultTrust: number,
  allowCrossProvenanceMerge = true,
): Resolution {
  const trust = (sys: string) => trustScores[sys] ?? defaultTrust;
  // Effective winner score: source trust plus a provenance-class boost.
  const score = (r: ParsedRecord) => trust(r.sourceSystem) + provenanceBoost(r);

  if (g.records.length === 1) {
    return { canonical: g.records[0], mergedUris: [g.records[0].uri], mergedSystems: [g.records[0].sourceSystem], strategy: 'pass_through', resolved: true };
  }

  const ranked = [...g.records].sort((a, b) => {
    const sd = score(b) - score(a);
    return sd !== 0 ? sd : completeness(b) - completeness(a);
  });

  const winner = ranked[0];
  const losers = ranked.slice(1);
  let strategy = 'trust_priority';
  let resolved = true;

  const isMedication = g.records[0].type === 'clinical:Medication';

  if (g.matchType === 'near_duplicate') {
    strategy = 'merge_values';
  } else if (g.matchType === 'status_conflict') {
    if (isMedication) {
      // Active vs stopped of the same drug is a clinical divergence: always
      // user-resolved, never auto-merged by trust (the silent-merge danger).
      strategy = 'flag_unresolved';
      resolved = false;
    } else {
      // Conditions: auto-resolve by trust unless the two sources are near-equal.
      const diff = Math.abs(trust(ranked[0].sourceSystem) - trust(ranked[1].sourceSystem));
      if (diff < 0.05) { strategy = 'flag_unresolved'; resolved = false; }
    }
  } else if (g.matchType === 'value_conflict' && isMedication) {
    // Dose/frequency disagreement on the same medication: always user-resolved
    // so it reaches settings/pending-conflicts.ttl and the Reconcile tab,
    // rather than being silently collapsed by trust priority.
    strategy = 'flag_unresolved';
    resolved = false;
  }

  // Opt-in cross-provenance guard (Checkup parity): when a would-be merge spans
  // more than one provenance class, flag for review instead of silently merging
  // across provenance. Only affects the merge match types; existing conflicts
  // already flag.
  if (!allowCrossProvenanceMerge && (g.matchType === 'near_duplicate' || g.matchType === 'exact_duplicate')) {
    const provenanceClasses = new Set(
      g.records.map(r => getProp(r, NS.clinical + 'provenanceClass')).filter((v): v is string => !!v),
    );
    if (provenanceClasses.size > 1) {
      strategy = 'flag_cross_provenance';
      resolved = false;
    }
  }

  // Merge missing fields from lower-trust sources
  let canonical: ParsedRecord = winner;
  if (strategy === 'merge_values') {
    const mergedProps = new Map(winner.properties);
    const metaPreds = new Set([NS.rdf + 'type', NS.cascade + 'dataProvenance', NS.cascade + 'schemaVersion', NS.cascade + 'sourceSystem']);
    for (const src of losers) {
      for (const [pred, vals] of src.properties) {
        if (!metaPreds.has(pred) && !mergedProps.has(pred)) mergedProps.set(pred, vals);
      }
    }
    canonical = { ...winner, properties: mergedProps };
  }

  return {
    canonical,
    mergedUris: g.records.map(r => r.uri),
    mergedSystems: g.records.map(r => r.sourceSystem),
    strategy,
    resolved,
  };
}

// ---------------------------------------------------------------------------
// Edge re-dangling repair
// ---------------------------------------------------------------------------
//
// R1 resolved every record-to-record edge (clinical:hasLabResult,
// coverage:relatedClaim, clinical:hasEncounter, clinical:indicationReference)
// at conversion time, BEFORE reconciliation. The reconciler then merges
// near-duplicate records and DISCARDS the losing subjects, but it never rewrote
// other records' edge OBJECTS. So an edge pointing at a merged-away duplicate
// re-dangled on every multi-source / --reconcile-existing path. This section
// builds one discarded→canonical map over the run and rewrites matching edge
// objects (in reconciled groups AND passthrough quads) to the survivor.

/**
 * Predicates whose objects deliberately point at PRE-merge (now non-materialized)
 * subjects: they record the merge itself, so rewriting them to the survivor would
 * erase the provenance they exist to capture (mergedFrom → self-loop). Excluded
 * from the edge rewrite and dangling BY DESIGN per the ratified lineage decision
 * (exclude, do not tombstone). Any graph-query surface should
 * treat these as references to historical, non-materialized subjects.
 */
const LINEAGE_PREDICATES: ReadonlySet<string> = new Set<string>([
  NS.cascade + 'mergedFrom',
  NS.prov + 'wasDerivedFrom',
  NS.cascade + 'discardedRecords',
  'https://ns.cascadeprotocol.org/workbench/v1#erasedRecord',
]);

/**
 * Build the discarded-subject → canonical-subject map over every merge decision
 * in the run (in-batch AND against existing pod content). A group of N>1 records
 * collapses to one canonical (resolveGroup's winner); the other N−1 subjects are
 * discarded and vanish from the output, so anything that referenced them must be
 * redirected here. Self-entries (an exact re-import whose duplicate shares the
 * canonical's content-hashed URI) are skipped so the map holds no A→A no-ops.
 */
export function buildDiscardedToCanonical(
  groups: Group[],
  resolutions: Resolution[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < groups.length; i++) {
    const canonicalUri = resolutions[i].canonical.uri;
    for (const r of groups[i].records) {
      if (r.uri !== canonicalUri) map.set(r.uri, canonicalUri);
    }
  }
  return map;
}

/**
 * Resolve a subject to its FINAL canonical by following the map transitively
 * (A→B→C lands on C), with a cycle guard so a malformed A→B→A can never spin.
 * Returns the input unchanged when it was never discarded. A single reconciler
 * run produces a star (each subject is assigned to exactly one group), not a
 * chain, so the transitive walk is defensive: it covers a future multi-pass
 * merge or pre-merged existing-pod content without ever looping.
 */
export function resolveCanonicalSubject(map: Map<string, string>, subject: string): string {
  let current = subject;
  const seen = new Set<string>([current]);
  let next = map.get(current);
  while (next !== undefined && next !== current) {
    if (seen.has(next)) return next; // cycle: stop on the already-seen canonical
    seen.add(next);
    current = next;
    next = map.get(current);
  }
  return current;
}

// ---------------------------------------------------------------------------
// Serializer: resolved groups → Turtle
// ---------------------------------------------------------------------------

/**
 * Reconciler bookkeeping that `serializeGroups` derives from THIS run's decision
 * and re-states unconditionally on every record. When the pod is fed back in as
 * an input (the `--reconcile-existing` re-import path), the previous run's value
 * arrives as an ordinary parsed property, gets written out, and the derived value
 * is appended next to it, so the record accumulates a second copy on every
 * re-sync. Dropping it on the way in and letting the run re-derive it keeps
 * exactly one, and keeps the value TRUE for the current run rather than stale.
 *
 * Deliberately NOT in this set:
 *  - `cascade:sourceSystem`: also converter-emitted (it is source data, not
 *    bookkeeping), and already a fixed point (one parsed value + one derived).
 *  - `cascade:mergedFrom` / `prov:wasDerivedFrom`: real lineage pointing at
 *    historical subjects. They must SURVIVE a run in which nothing merged, so
 *    they are preserved and de-duplicated at emission instead.
 */
const RECONCILER_DERIVED_PREDICATES: ReadonlySet<string> = new Set<string>([
  NS.cascade + 'reconciliationStatus',
]);

async function serializeGroups(
  groups: Group[],
  resolutions: Resolution[],
  passthroughQuads: Quad[],
  discardedToCanonical: Map<string, string>,
): Promise<{ turtle: string; edgeObjectsRewritten: number }> {
  return new Promise((resolve, reject) => {
    const writer = new Writer({ prefixes: TURTLE_PREFIXES });
    let edgeObjectsRewritten = 0;

    // The sentinel base is a private detail of ONE parse. It must not survive
    // into this text: the next stage re-parses this output under a base chosen
    // for THAT text, so a sentinel that arrives already attached is never
    // resolved, never stripped, and lands on disk absolute and permanent. Every
    // quad leaves here derelativized, which keeps the invariant global — no
    // Turtle this CLI produces, intermediate or final, mentions the sentinel.
    const base = relBase();
    const emit = (q: Quad): void => { writer.addQuad(derelativizeQuads([q], base)[0]); };

    // Redirect a NamedNode edge object that points at a merged-away (discarded)
    // subject to its surviving canonical subject; lineage predicates are left
    // dangling by design (see LINEAGE_PREDICATES). Returns the IRI to serialize
    // and counts every real redirect.
    const rewriteEdgeIri = (predicate: string, objectValue: string): string => {
      if (LINEAGE_PREDICATES.has(predicate)) return objectValue;
      const canonical = resolveCanonicalSubject(discardedToCanonical, objectValue);
      if (canonical !== objectValue) edgeObjectsRewritten++;
      return canonical;
    };

    // Non-reconcilable subjects are preserved verbatim, except that an edge
    // object pointing at a merged-away subject is redirected to the survivor.
    for (const q of passthroughQuads) {
      if (q.object.termType === 'NamedNode') {
        const rewritten = rewriteEdgeIri(q.predicate.value, q.object.value);
        if (rewritten !== q.object.value) {
          emit(makeQuad(q.subject, q.predicate, namedNode(rewritten)));
          continue;
        }
      }
      emit(q);
    }

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const res = resolutions[i];
      const subj = namedNode(res.canonical.uri);

      // Lineage this record already carried, so a re-emission below cannot
      // duplicate it (the pod's own copy arrives as a parsed property).
      const emittedLineage = new Set<string>();

      for (const [pred, vals] of res.canonical.properties) {
        // Re-derived below for every record; a carried-over copy would double it.
        if (RECONCILER_DERIVED_PREDICATES.has(pred)) continue;
        for (const val of vals) {
          // What the source term ACTUALLY was, when we recorded it. The
          // string-shape guess is only the fallback for values this reconciler
          // derived itself rather than parsed.
          const isIri = val.isIri ?? (val.value.startsWith('http') || val.value.startsWith('urn:'));
          const obj = isIri
            ? namedNode(rewriteEdgeIri(pred, val.value))
            : val.datatype
              ? literal(val.value, namedNode(val.datatype))
              : literal(val.value);
          if (LINEAGE_PREDICATES.has(pred)) emittedLineage.add(`${pred}|${obj.value}`);
          emit(makeQuad(subj, namedNode(pred), obj));
        }
      }

      // Reconciliation status
      const status = !res.resolved ? 'unresolved-conflict'
        : g.matchType === 'pass_through' ? 'canonical'
        : (g.matchType === 'status_conflict' || g.matchType === 'value_conflict') ? 'conflict-resolved'
        : 'merged';
      emit(makeQuad(subj, namedNode(NS.cascade + 'reconciliationStatus'), literal(status)));
      emit(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(res.canonical.sourceSystem)));

      if (g.matchType !== 'pass_through' && res.mergedUris.length > 1) {
        for (const srcUri of res.mergedUris) {
          for (const pred of [NS.cascade + 'mergedFrom', NS.prov + 'wasDerivedFrom']) {
            // Already carried on the record from an earlier run's merge: state it
            // once, not once per re-import.
            if (emittedLineage.has(`${pred}|${srcUri}`)) continue;
            emittedLineage.add(`${pred}|${srcUri}`);
            emit(makeQuad(subj, namedNode(pred), namedNode(srcUri)));
          }
        }
        emit(makeQuad(subj, namedNode(NS.cascade + 'mergedSources'), literal(res.mergedSystems.join(', '))));
        emit(makeQuad(subj, namedNode(NS.cascade + 'conflictResolution'), literal(res.strategy)));
        if (g.conflictField) emit(makeQuad(subj, namedNode(NS.cascade + 'conflictField'), literal(g.conflictField)));
        if (g.conflictValues) {
          const valDesc = Object.entries(g.conflictValues).map(([s, v]) => `${s}: "${v}"`).join(' vs ');
          emit(makeQuad(subj, namedNode(NS.cascade + 'conflictValues'), literal(valDesc)));
        }
      }
    }

    writer.end((err, result) => err ? reject(err) : resolve({ turtle: result, edgeObjectsRewritten }));
  });
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

export async function runReconciliation(
  inputs: ReconcilerInput[],
  options?: ReconcilerOptions,
): Promise<ReconcilerResult> {
  const trustScores: Record<string, number> = {
    'primary-care': 0.90,
    'specialist': 0.85,
    'hospital': 0.95,
    ...(options?.trustScores ?? {}),
  };
  const defaultTrust = 0.80;
  const labTol = options?.labTolerance ?? 0.05;
  // Brand-to-generic resolver for medication name matching. Defaults to the
  // bundled Cascade terminology asset so Zyrtec/cetirizine dedupe out of the box;
  // callers pass identityTerminologyResolver for asset-free behaviour.
  const resolver = options?.terminologyResolver ?? cascadeTerminologyResolver();

  // Parse all inputs
  let allRecords: ParsedRecord[] = [];
  const sourceInfo: Array<{ system: string; count: number }> = [];

  // Subjects the reconciler cannot reconcile are carried through verbatim,
  // deduplicated by full quad identity across inputs (so re-feeding existing
  // pod content alongside a re-import of the same document does not grow).
  const passthroughQuads: Quad[] = [];
  const seenPassthrough = new Set<string>();
  const passthroughSubjectKeys = new Set<string>();
  // Every quad of every input, for the reference-resolution index that the
  // stated-edge collapse below keys on.
  const allInputQuads: Quad[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const records = await parseTurtle(input.content, input.systemName);
    allRecords.push(...records);
    sourceInfo.push({ system: input.systemName, count: records.length });

    const { passthrough, all } = await collectQuads(input.content);
    allInputQuads.push(...all);
    for (const q of passthrough) {
      const key = quadKey(q);
      if (seenPassthrough.has(key)) continue;
      seenPassthrough.add(key);
      passthroughSubjectKeys.add(`${q.subject.termType}:${q.subject.value}`);
      passthroughQuads.push(relabelQuadBlankNodes(q, i));
    }
  }

  // A re-import stamps a fresh clinical:importedAt while the subject is
  // content-hash-stable, so quad-identity dedup keeps every run's value and the
  // record fails SHACL maxCount 1. Collapse single-cardinality passthrough
  // predicates to one value per subject.
  const singleValuedPassthroughQuads = collapseSingleCardinalityPassthrough(passthroughQuads);

  // A stated edge arrives resolved from the pod and as a placeholder from the new
  // input, so quad-identity dedup keeps both and the caller's resolution pass
  // turns them into two copies of one statement. Collapse on where each object
  // RESOLVES TO.
  const referenceResolver = buildReferenceResolver(buildResourceRefsFromQuads(allInputQuads));
  const dedupedPassthroughQuads = collapseResolvedEquivalentEdges(
    singleValuedPassthroughQuads,
    referenceResolver,
  );

  // Identity collisions. Everything below treats a second arrival of an IRI as a
  // re-import and passes over it (`assigned.has(...)`), which destroys the loser
  // when the two are actually different records that the identity layer minted
  // onto one IRI. Split those apart FIRST, so the pass-over below only ever sees
  // records it is right about. The reference resolver is passed for the same
  // reason it is passed above: a stated edge arrives resolved from the pod and as
  // a placeholder from the new input, and without normalizing the two spellings
  // every re-import of an edge-bearing record reads as a collision.
  const split = splitIdentityCollisions(allRecords, referenceResolver);
  allRecords = split.records;
  const identityCollisions = split.collisions;

  /**
   * True when two records are the two halves of one identity collision.
   *
   * They are deliberately kept out of each other's candidate lists. The split
   * has already asked a person which of the two readings is right; letting the
   * matcher merge them by trust in the same run would answer that question by
   * throwing one of the values away, which is the exact behaviour being fixed.
   * Each still matches freely against every OTHER record.
   */
  const sameCollision = (a: ParsedRecord, b: ParsedRecord): boolean => {
    if (split.collisionGroupByUri.size === 0) return false;
    const ga = split.collisionGroupByUri.get(a.uri);
    return ga !== undefined && ga === split.collisionGroupByUri.get(b.uri);
  };

  // Match and group
  const groups: Group[] = [];
  const assigned = new Set<string>();

  const hasExistingPod = allRecords.some(r => r.sourceSystem === 'existing-pod');

  if (hasExistingPod) {
    // ---------------------------------------------------------------------------
    // Fast path: O(n_new × k) type-indexed matching for --reconcile-existing mode
    // ---------------------------------------------------------------------------

    const existingRecords = allRecords.filter(r => r.sourceSystem === 'existing-pod');
    const newRecords = allRecords.filter(r => r.sourceSystem !== 'existing-pod');

    // Build a type index over existing records only
    const existingIndex = new Map<string, ParsedRecord[]>();
    for (const r of existingRecords) {
      const bucket = existingIndex.get(r.type);
      if (bucket) bucket.push(r);
      else existingIndex.set(r.type, [r]);
    }

    // Cross-batch pass: match each new record against same-type existing records
    for (const a of newRecords) {
      if (assigned.has(a.uri)) continue;
      if (a.type === 'coverage:InsurancePlan') {
        groups.push({ matchType: 'pass_through', confidence: 1.0, records: [a], matchedOn: 'coverage' });
        assigned.add(a.uri);
        continue;
      }

      const matched: ParsedRecord[] = [a];
      let matchedOn = '';
      let bestConf = 1.0;

      const candidates = existingIndex.get(a.type) ?? [];
      for (const b of candidates) {
        if (assigned.has(b.uri) || a.sourceSystem === b.sourceSystem || sameCollision(a, b)) continue;
        const { match, confidence, matchedOn: mo } = doRecordsMatch(a, b, labTol, resolver);
        const threshold = getMatchThreshold(a, b);
        if (match && confidence >= threshold) {
          matched.push(b);
          assigned.add(b.uri);
          if (!matchedOn) { matchedOn = mo; bestConf = confidence; }
        }
      }
      assigned.add(a.uri);

      if (matched.length === 1) {
        groups.push({ matchType: 'pass_through', confidence: 1.0, records: matched, matchedOn: '' });
      } else {
        const { matchType, conflictField, conflictValues } = classifyGroup(matched, labTol, resolver);
        groups.push({ matchType, confidence: bestConf, records: matched, matchedOn, conflictField, conflictValues });
      }
    }

    // Within-batch pass: pairwise loop over newRecords only (existing-pod records
    // from the same sourceSystem never match each other)
    for (let i = 0; i < newRecords.length; i++) {
      const a = newRecords[i];
      if (assigned.has(a.uri)) continue;
      if (a.type === 'coverage:InsurancePlan') {
        // Already handled above; skip if already assigned
        continue;
      }

      const matched: ParsedRecord[] = [a];
      let matchedOn = '';
      let bestConf = 1.0;

      for (let j = i + 1; j < newRecords.length; j++) {
        const b = newRecords[j];
        if (assigned.has(b.uri) || a.sourceSystem === b.sourceSystem || sameCollision(a, b)) continue;
        const { match, confidence, matchedOn: mo } = doRecordsMatch(a, b, labTol, resolver);
        const threshold = getMatchThreshold(a, b);
        if (match && confidence >= threshold) {
          matched.push(b);
          assigned.add(b.uri);
          if (!matchedOn) { matchedOn = mo; bestConf = confidence; }
        }
      }
      assigned.add(a.uri);

      if (matched.length === 1) {
        groups.push({ matchType: 'pass_through', confidence: 1.0, records: matched, matchedOn: '' });
      } else {
        const { matchType, conflictField, conflictValues } = classifyGroup(matched, labTol, resolver);
        groups.push({ matchType, confidence: bestConf, records: matched, matchedOn, conflictField, conflictValues });
      }
    }

    // Existing-pod pass-through: records not matched into any group must still
    // appear as their own pass-through groups so they are written back to the pod
    for (const r of existingRecords) {
      if (assigned.has(r.uri)) continue;
      groups.push({ matchType: 'pass_through', confidence: 1.0, records: [r], matchedOn: '' });
      assigned.add(r.uri);
    }

  } else {
    // ---------------------------------------------------------------------------
    // Type-indexed O(n × k/T) algorithm for single-batch reconciliation
    // ---------------------------------------------------------------------------

    // Build a type index so each record is only compared against same-type records
    const typeIndex = new Map<string, ParsedRecord[]>();
    for (const r of allRecords) {
      const bucket = typeIndex.get(r.type);
      if (bucket) bucket.push(r);
      else typeIndex.set(r.type, [r]);
    }

    for (const a of allRecords) {
      if (assigned.has(a.uri)) continue;
      if (a.type === 'coverage:InsurancePlan') {
        groups.push({ matchType: 'pass_through', confidence: 1.0, records: [a], matchedOn: 'coverage' });
        assigned.add(a.uri);
        continue;
      }

      const matched = [a];
      let matchedOn = '';
      let bestConf = 1.0;

      const candidates = typeIndex.get(a.type) ?? [];
      for (const b of candidates) {
        if (b === a || assigned.has(b.uri) || a.sourceSystem === b.sourceSystem || sameCollision(a, b)) continue;
        const { match, confidence, matchedOn: mo } = doRecordsMatch(a, b, labTol, resolver);
        const threshold = getMatchThreshold(a, b);
        if (match && confidence >= threshold) {
          matched.push(b);
          assigned.add(b.uri);
          if (!matchedOn) { matchedOn = mo; bestConf = confidence; }
        }
      }
      assigned.add(a.uri);

      if (matched.length === 1) {
        groups.push({ matchType: 'pass_through', confidence: 1.0, records: matched, matchedOn: '' });
      } else {
        const { matchType, conflictField, conflictValues } = classifyGroup(matched, labTol, resolver);
        groups.push({ matchType, confidence: bestConf, records: matched, matchedOn, conflictField, conflictValues });
      }
    }
  }

  // How many input records never reached a group because another input had
  // already contributed their subject IRI. Cascade subjects are content-hashed,
  // so a second arrival of the same IRI is a re-import of the same record, and
  // the loops above silently pass over it (`assigned.has(...)`). Counting it is
  // what makes a 100%-duplicate import stop reporting "0 duplicates" while
  // quietly deduplicating everything. Measured on record
  // OBJECT identity, so it never double-counts a record the matcher already
  // reported as a merge.
  const groupedRecords = new Set<ParsedRecord>();
  for (const g of groups) for (const r of g.records) groupedRecords.add(r);
  const duplicateSubjectsDropped = allRecords.length - groupedRecords.size;

  // Resolve
  const allowCrossProvenanceMerge = options?.allowCrossProvenanceMerge ?? true;
  const resolutions = groups.map(g => resolveGroup(g, trustScores, defaultTrust, allowCrossProvenanceMerge));

  // Edge re-dangling repair: map every subject discarded
  // in a merge to its survivor, then rewrite matching edge objects at serialization.
  const discardedToCanonical = buildDiscardedToCanonical(groups, resolutions);

  // Serialize
  const { turtle, edgeObjectsRewritten } = await serializeGroups(
    groups, resolutions, dedupedPassthroughQuads, discardedToCanonical,
  );

  // Build report
  let exactDups = 0, nearDups = 0, resolved = 0, unresolved = 0;
  const transformations: object[] = [];
  const unresolvedList: object[] = [];

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const res = resolutions[i];
    const t = {
      type: g.matchType,
      recordType: g.records[0].type,
      canonicalUri: res.canonical.uri,
      sources: g.records.map(r => r.sourceSystem),
      matchedOn: g.matchedOn,
      strategy: res.strategy,
      conflictField: g.conflictField,
      conflictValues: g.conflictValues,
      resolved: res.resolved,
      documentType: getProp(g.records[0], NS.cascade + 'documentType'),
    };

    if (!res.resolved && (g.matchType === 'exact_duplicate' || g.matchType === 'near_duplicate')) {
      // A would-be merge that the cross-provenance guard flagged: count it as an
      // unresolved conflict, not as a silently-applied merge.
      unresolved++;
    } else {
      switch (g.matchType) {
        case 'exact_duplicate': exactDups++; break;
        case 'near_duplicate':  nearDups++; break;
        case 'status_conflict':
        case 'value_conflict':  res.resolved ? resolved++ : unresolved++; break;
      }
    }

    if (g.matchType !== 'pass_through') transformations.push(t);
    if (!res.resolved) unresolvedList.push({ ...t, candidateUris: g.records.map(r => r.uri) });
  }

  // An identity collision is a conflict, not a duplicate: the identity layer
  // asserted these records are the same and their contents say otherwise, and
  // only a person can say which reading is right. Raised through the SAME queue
  // as every other unresolved conflict — `settings/pending-conflicts.ttl`,
  // `pod conflicts` (exit 1), `pod resolve` — rather than through a private
  // channel nobody is watching. The records themselves have already been split,
  // so this reports a question, not a loss.
  for (const c of identityCollisions) {
    unresolved++;
    const entry = {
      type: 'identity_collision',
      recordType: c.recordType,
      canonicalUri: c.mintedUri,
      sources: c.sourceSystems,
      matchedOn: `identity-collision:${c.mintedUri}`,
      strategy: 'split_unresolved',
      resolved: false,
      candidateUris: c.resultingUris,
      label: `differs on ${c.differingPredicates.map(shortPredicate).join(', ')}`,
    };
    transformations.push(entry);
    unresolvedList.push(entry);
  }

  return {
    turtle,
    report: {
      sources: sourceInfo,
      summary: {
        totalInputRecords: allRecords.length,
        exactDuplicatesRemoved: exactDups,
        nearDuplicatesMerged: nearDups,
        duplicateSubjectsDropped,
        conflictsResolved: resolved,
        conflictsUnresolved: unresolved,
        identityCollisionsSplit: identityCollisions.length,
        finalRecordCount: groups.length,
        passthroughSubjects: passthroughSubjectKeys.size,
        edgeObjectsRewritten,
      },
      transformations,
      unresolvedConflicts: unresolvedList,
    },
  };
}
