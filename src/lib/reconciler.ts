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
import { medicationCodeKeys, sharedMedicationCodeKey, extractCodeValue } from './code-keys.js';
import { cascadeTerminologyResolver } from './terminology.js';
import { relBase, relBaseFor, derelativizeQuads } from './bucket-write.js';
import { SOURCE_IDENTITY_PREDICATE, isKnownOrigin } from './source-identity.js';

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
  /**
   * True when this input is the POD'S OWN existing content, fed back in so the
   * new batch can be reconciled against what is already stored
   * (`pod import --reconcile-existing`).
   *
   * This is a property of WHERE THE TEXT CAME FROM, and it has to be carried
   * separately from `systemName` because `systemName` is only a DEFAULT: a
   * parsed record takes its source system from its own `cascade:sourceSystem`
   * triple, and every record the pod holds carries one (the reconciler re-states
   * it on every write). So the caller's `systemName: 'existing-pod'` was
   * overwritten for every pod record without exception, `hasExistingPod` was
   * therefore never true, and the cross-batch path below — the entire reason
   * `--reconcile-existing` exists — had never run.
   */
  existingPod?: boolean;
}

/**
 * One record as it stood BEFORE a tier-0 merge discarded it: everything needed
 * to put it back.
 *
 * Content-complete on purpose. A tier-0 merge is defined over records whose
 * content is identical, so in principle the survivor IS the restoration and only
 * the IRI and the provenance axis would need keeping. That reasoning is correct
 * and it is not what gets written, because it is only correct as long as the
 * tier-0 predicate is exactly what it is today. An undo that depends on the
 * merge rule having been right is not an undo.
 */
export interface Tier0DiscardedRecord {
  uri: string;
  type: string;
  /** INGESTION axis at the time of the merge. */
  sourceSystem: string;
  /** ORIGIN axis. Always a known (`org:` / `ns:`) value: tier 0 requires it. */
  sourceIdentity?: string;
  /** Every property the record carried, verbatim, keyed by predicate IRI. */
  properties: Record<string, Array<{ value: string; datatype?: string; isIri?: boolean }>>;
}

/** One applied tier-0 merge, as the audit journal records it. */
export interface Tier0Merge {
  /** The record that survived and now stands for all of them. */
  canonicalUri: string;
  recordType: string;
  /** What made them one record, e.g. `loinc:2951-2@2031-05-20T09:14:00Z`. */
  matchedOn: string;
  /** The distinct known origins that contributed. Always two or more. */
  origins: string[];
  /** Everything merged away, restorable. */
  discarded: Tier0DiscardedRecord[];
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
      /**
       * Of the merges above, how many met the TIER 0 predicate: cross-source
       * exact lab duplication. A subset of `exactDuplicatesRemoved`, never
       * disjoint from it — the same merge counted twice, once as a merge and
       * once as the narrow, audited class of merge it belongs to.
       *
       * Every one of these is itemized in `report.tier0Merges` with the IRIs and
       * the discarded content, which is what makes the class reversible rather
       * than merely counted.
       */
      tier0MergesApplied: number;
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
    /**
     * Every tier-0 merge this run applied, itemized. Empty on a run that applied
     * none, which is the ordinary case.
     */
    tier0Merges: Tier0Merge[];
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
  /** INGESTION axis: the import batch this record arrived in. Never an origin. */
  sourceSystem: string;
  /**
   * True when this record was read out of the pod rather than out of the batch
   * being imported. See {@link ReconcilerInput.existingPod}: it is deliberately
   * NOT derived from `sourceSystem`, which the record itself states and which
   * therefore cannot say how the record reached this run.
   */
  fromExistingPod: boolean;
  /**
   * ORIGIN axis: `cascade:sourceIdentity`, the canonical organization identity.
   * Undefined for a record written before core v3.5 — see {@link sameSourceStatement},
   * which is the only thing that reads it and which falls back safely.
   */
  sourceIdentity?: string;
  properties: Map<string, RdfValue[]>;
}

export async function parseTurtle(
  turtle: string,
  defaultSystem: string,
  fromExistingPod = false,
): Promise<ParsedRecord[]> {
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
          const sourceIdentity = properties.get(SOURCE_IDENTITY_PREDICATE)?.[0]?.value;
          records.push({
            uri,
            type: KNOWN_TYPES[typeTriple.obj.value],
            sourceSystem,
            sourceIdentity,
            fromExistingPod,
            properties,
          });
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
  // The ORIGIN axis, for the same reason as the display label directly above:
  // two copies of ONE result retrieved from two organizations differ here while
  // saying the same clinical thing. Where they differ is exactly what the
  // same-source guard reads to decide they are worth comparing at all, so
  // treating the difference ALSO as evidence of a collision would raise a
  // conflict on every cross-source duplicate the guard just admitted.
  SOURCE_IDENTITY_PREDICATE,
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
  ignored: ReadonlySet<string> = COLLISION_IGNORED_PREDICATES,
): string {
  const parts: string[] = [];
  for (const [pred, vals] of r.properties) {
    if (ignored.has(pred)) continue;
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

/**
 * The bare code value a code URI carries.
 *
 * Delegates to `extractCodeValue`, the definition shared with the SDK, rather
 * than keeping a second copy. The copy this replaces was
 *
 *     uri.split('/').pop() ?? uri.split('#').pop() ?? uri
 *
 * whose second operand is unreachable: `String.split('/').pop()` on a non-empty
 * string is always a non-empty string, so `??` never falls through to the
 * fragment branch. Every LOINC URI this repo mints is
 * `http://loinc.org/rdf#3094-0`, which therefore came back as `rdf#3094-0`.
 *
 * That had two consequences beyond the ugly string. The C-CDA converter writes
 * its LOINC as `http://loinc.org/3094-0` (no `rdf#` — see `OID_TO_URI`), so the
 * two importers' spellings of ONE code compared unequal and a FHIR lab never
 * matched the same lab from a C-CDA. And the mangled form is interpolated into
 * `matchedOn`, which `generateConflictId` turns into the id persisted in
 * `settings/pending-conflicts.ttl` — so it reached disk. See
 * {@link legacyConflictIds} in `user-resolutions.ts` for what that means for a
 * pod written by an earlier version.
 */
const codeFromUri = extractCodeValue;

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

  // Partial-name fallback (substring containment).
  //
  // `matchedOn` NAMES THE DRUG, and that is load-bearing rather than cosmetic:
  // `generateConflictId` builds the persisted conflict id out of this string, so
  // the bare constant `partial-name` gave EVERY partial-name medication conflict
  // in every pod one id. Two consequences, both silent:
  // `settings/user-resolutions.ttl` is keyed by conflict id and cannot hold two
  // rows under one key, so resolving a lisinopril conflict overwrote the
  // recorded decision for an amlodipine one; and `pod resolve` removes every
  // pending conflict whose id matches, so answering one question cleared the
  // others from the queue unanswered.
  //
  // The CONTAINED name is the shared identity — "lisinopril" out of
  // {"lisinopril", "lisinopril oral tablet"} — and choosing by length rather
  // than by which record happened to be `a` keeps the id independent of the
  // order the inputs were enumerated.
  if (nA && nB && (nA.includes(nB) || nB.includes(nA))) {
    const shared = nA.length <= nB.length ? nA : nB;
    return { match: true, confidence: 0.70, matchedOn: `partial-name:"${shared}"` };
  }
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

/**
 * The bare CVX code an immunization record carries, whichever predicate its
 * importer used and whichever spelling that importer wrote.
 *
 * The two importers disagree on both, which is why the CVX tier below had never
 * fired on a FHIR record:
 *
 *   C-CDA  health:cvxCode      <http://hl7.org/fhir/sid/cvx/207>
 *   FHIR   health:vaccineCode  "CVX-207"
 *
 * The matcher read only the first, so every FHIR immunization fell through to
 * the name tier and two records for one shot matched only when their display
 * names happened to agree verbatim. Normalizing both spellings to `207` is what
 * lets a C-CDA immunization and a FHIR one for the same shot compare at all.
 */
function immunizationCvxCode(r: ParsedRecord): string | undefined {
  const raw = getProp(r, NS.health + 'cvxCode') ?? getProp(r, NS.health + 'vaccineCode');
  if (!raw) return undefined;
  const code = extractCodeValue(raw);
  return code.startsWith('CVX-') ? code.slice(4) : code;
}

function matchImmunizations(a: ParsedRecord, b: ParsedRecord): MatchResult {
  // Tier 1: CVX code + exact date (high confidence)
  const cA = immunizationCvxCode(a);
  const cB = immunizationCvxCode(b);
  const dA = dateOnly(getProp(a, NS.health + 'administrationDate') ?? getProp(a, NS.health + 'startDate') ?? '');
  const dB = dateOnly(getProp(b, NS.health + 'administrationDate') ?? getProp(b, NS.health + 'startDate') ?? '');

  if (cA && cB && cA === cB && dA && dA === dB)
    return { match: true, confidence: 1.0, matchedOn: `cvx:${cA}+${dA}` };

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

/**
 * How far apart two readings of one vital sign may be recorded and still be the
 * same reading arriving twice.
 *
 * A vital sign is an instant, not a day. The rule this replaces was "same LOINC,
 * same calendar day", which is the wrong shape for the data: a morning, a midday
 * and an evening blood pressure share a calendar day and are three separate
 * clinical events, while one cuff reading forwarded to a second system 17
 * minutes later is one event under two clocks. A day-wide window merges the
 * first group and a zero-width window keeps the second apart; both lose real
 * information, in opposite directions.
 *
 * Thirty minutes is chosen against what the window has to separate — repeat
 * measurements, which clinical protocol spaces in hours (a repeat BP at 1-5
 * minutes is the same encounter and SHOULD collapse) — rather than against a
 * particular export. It is not a claim that clocks never drift further; a source
 * that stamps its records an hour out will still keep both copies, which is the
 * recoverable error of the two.
 */
const VITAL_SAME_READING_WINDOW_MS = 30 * 60 * 1000;

/**
 * The instant a vital sign was taken, in epoch milliseconds.
 *
 * `clinical:effectiveDate` is what BOTH converters write (`converters-clinical.ts`
 * for FHIR, `sections/vitals.ts` for C-CDA); the `health:` predicates are read
 * after it only so a record written by some other producer is not ignored.
 *
 * A day-precision value parses to that day's midnight UTC, so two day-precision
 * readings of one vital on one day are zero apart. That is the truth available:
 * the source did not say when, and inventing a separation it never stated would
 * be the same fabrication as inventing a time of day.
 */
function vitalInstantMs(r: ParsedRecord): number | undefined {
  const raw =
    getProp(r, NS.clinical + 'effectiveDate') ??
    getProp(r, NS.health + 'effectiveDate') ??
    getProp(r, NS.health + 'performedDate');
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Do two vital-sign records denote one reading?
 *
 * WHAT THIS USED TO READ. `health:testCode`, `health:effectiveDate` /
 * `health:performedDate` and `health:value` — three predicates no converter in
 * this repository has ever written for a vital sign. Both of them write
 * `clinical:loincCode`, `clinical:effectiveDate` and `clinical:value`. All three
 * lookups returned undefined, the date guard therefore failed, and the function
 * returned no-match for EVERY pair: no two vital signs in any pod had ever
 * matched. The "three same-day readings must never merge" property held, but for
 * the wrong reason, and the price was that a genuine cross-source duplicate was
 * kept as a second record.
 *
 * The value tolerance is symmetric (the larger magnitude is the denominator), so
 * the verdict does not depend on which record is `a`; `matchedOn` keys on the
 * EARLIER instant for the same reason, since it becomes a persisted id.
 */
function matchVitalSigns(a: ParsedRecord, b: ParsedRecord): MatchResult {
  const noMatch: MatchResult = { match: false, confidence: 0, matchedOn: '' };

  const lcA = getProp(a, NS.clinical + 'loincCode');
  const lcB = getProp(b, NS.clinical + 'loincCode');
  if (!lcA || !lcB) return noMatch;
  const code = codeFromUri(lcA);
  if (code !== codeFromUri(lcB)) return noMatch;

  const tA = vitalInstantMs(a);
  const tB = vitalInstantMs(b);
  if (tA === undefined || tB === undefined) return noMatch;
  if (Math.abs(tA - tB) > VITAL_SAME_READING_WINDOW_MS) return noMatch;

  const at = new Date(Math.min(tA, tB)).toISOString();
  const vA = parseFloat(getProp(a, NS.clinical + 'value') ?? 'NaN');
  const vB = parseFloat(getProp(b, NS.clinical + 'value') ?? 'NaN');

  if (!isNaN(vA) && !isNaN(vB)) {
    const diff = Math.abs(vA - vB) / Math.max(Math.abs(vA), Math.abs(vB), 0.001);
    if (diff === 0) return { match: true, confidence: 1.0, matchedOn: `loinc:${code}+${at}` };
    if (diff <= 0.05) return { match: true, confidence: 0.95, matchedOn: `loinc:${code}+${at}` };
    if (diff <= 0.15) return { match: true, confidence: 0.75, matchedOn: `loinc-approx:${code}+${at}` };
    // Inside the window but disagreeing by more than a rounding difference: two
    // measurements, not one measurement recorded twice. Keeping both is the
    // recoverable answer.
    return noMatch;
  }

  // A non-numeric or absent reading on either side. The code and the instant
  // still agree, which is as much as there is to go on.
  return { match: true, confidence: 0.85, matchedOn: `loinc:${code}+${at}` };
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
// Tier 0: the one duplicate class that is safe to merge with nobody watching
// ---------------------------------------------------------------------------
//
// THE RULING
// ----------
// Cross-source EXACT lab duplication merges silently rather than raising a
// question. Two organizations reporting one draw is the single most common thing
// a multi-source pod contains, and asking a person to confirm each one is not
// caution — it is a queue nobody finishes, which is how the genuinely
// disagreeing pairs (the ones a conflict queue exists for) end up buried among
// hundreds of identical ones.
//
// The class is drawn NARROWLY on purpose, and every clause below is doing work:
//
//   SAME LOINC        the two records are answering the same question.
//   SAME INSTANT      and not the same DAY. Day-level is what the ordinary lab
//                     matcher uses, and it is right to: a same-day repeat draw is
//                     a real second measurement, and merging it destroys data.
//                     Tier 0 will not take that risk, so a record whose date
//                     carries no time of day is not eligible at all.
//   IDENTICAL CONTENT byte-equal on every predicate that is not provenance
//                     bookkeeping. Not "within tolerance" — a tolerance is a
//                     judgement, and a judgement is what tier 0 is not allowed to
//                     make. Anything that differs by any amount stays a
//                     near-duplicate and is reported.
//   DIFFERENT KNOWN   both records must state an ORIGIN, both origins must name
//   ORIGINS           a real organization (`org:` / `ns:`), and they must differ.
//                     This is the clause that makes the class safe: one source
//                     does not restate one result twice inside one export, so two
//                     identical results from two ORGANIZATIONS is a re-sync,
//                     while two from ONE source may be two real measurements.
//                     `transport:` and absent origins are UNKNOWN, not different,
//                     and are excluded — the conservative fallback stays exactly
//                     as it was for every pod written before origins existed.
//
// Measured over 144 candidate groups at a 22% duplicate base rate: zero false
// positives.
//
// WHAT SILENT DOES NOT MEAN
// -------------------------
// It does not mean unrecorded. Every tier-0 merge is itemized in the run report
// and journaled into the pod with the discarded records' full content, so the
// class is auditable after the fact and reversible without the originals. Silent
// is about not INTERRUPTING, not about not TELLING.

/** True when a date literal states a time of day, not just a day. */
function statesTimeOfDay(value: string | undefined): boolean {
  return typeof value === 'string' && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
}

/**
 * What "identical content" means for tier 0: everything
 * {@link COLLISION_IGNORED_PREDICATES} already treats as bookkeeping, plus the
 * provenance CLASS.
 *
 * `clinical:provenanceClass` says how a copy REACHED the pod — a direct FHIR
 * pull, a pharmacy claim, a user's own entry. Two organizations reporting one
 * draw differ on it as a matter of course, and that difference is the very thing
 * the tier-0 clause about different origins is already reading. Counting it as
 * content too would mean the class almost never applies where it is most needed
 * (the cross-provenance guard, which flags exactly this difference), leaving the
 * exemption above true in principle and dead in practice.
 *
 * It is added HERE and not to `COLLISION_IGNORED_PREDICATES`, which answers a
 * different question — whether two records that claim one IRI are materially
 * different — and whose membership changes identity-collision splitting for
 * every record type. The two sets agreeing on most of their contents is not a
 * reason to make them one set.
 */
const TIER0_IGNORED_PREDICATES: ReadonlySet<string> = new Set<string>([
  ...COLLISION_IGNORED_PREDICATES,
  NS.clinical + 'provenanceClass',
]);

/**
 * Whether a whole matched group is tier 0.
 *
 * Group-level rather than pair-level because a group is what gets merged: a
 * third record joining two tier-0 twins is a third organization's copy only if
 * IT also satisfies every clause, and if it does not, the whole group leaves the
 * class. Requiring the property of every member is what stops one qualifying
 * pair from carrying an unqualified record along with it.
 */
/*
 * THREE OF THE CLAUSES BELOW ARE REDUNDANT TODAY, AND ARE KEPT ON PURPOSE.
 *
 * Measured by mutation: deleting the lab-only check, the same-LOINC check, or
 * the same-instant EQUALITY check each leaves the whole suite green, because
 * each is implied by something else in the function as it currently stands.
 *
 *   lab-only        a non-lab record carries no `health:testCode`, so the
 *                   next clause already rejects it.
 *   same LOINC      the content fingerprint covers `health:testCode`, so two
 *   same instant    records with equal fingerprints already agree on both.
 *   (equality)
 *
 * They are written out anyway because each is a separate clause of the ruling
 * and the redundancy is CONTINGENT, not structural: it holds only while
 * {@link TIER0_IGNORED_PREDICATES} contains neither predicate. Adding
 * `health:testCode` or `health:performedDate` to that set, which is an ordinary
 * one-line change someone could make for a defensible reason, would silently
 * widen the class to merge different tests or different draws. A clause that
 * states its own condition cannot be undone that way.
 *
 * `statesTimeOfDay` is NOT in this list. It is about the FORM of the value
 * rather than the equality of two values, nothing else implies it, and dropping
 * it goes red.
 */
function isTier0Group(records: ParsedRecord[], fingerprint: (r: ParsedRecord) => string): boolean {
  if (records.length < 2) return false;
  const origins = new Set<string>();
  let sharedCode: string | undefined;
  let sharedInstant: string | undefined;
  let sharedFingerprint: string | undefined;

  for (const r of records) {
    if (r.type !== 'health:LabResultRecord') return false;

    const code = getProp(r, NS.health + 'testCode');
    if (!code) return false;
    const bare = codeFromUri(code);
    if (sharedCode === undefined) sharedCode = bare;
    else if (sharedCode !== bare) return false;

    const performed = getProp(r, NS.health + 'performedDate');
    if (!statesTimeOfDay(performed)) return false;
    if (sharedInstant === undefined) sharedInstant = performed;
    else if (sharedInstant !== performed) return false;

    if (!isKnownOrigin(r.sourceIdentity)) return false;
    origins.add(r.sourceIdentity as string);

    const fp = fingerprint(r);
    if (sharedFingerprint === undefined) sharedFingerprint = fp;
    else if (sharedFingerprint !== fp) return false;
  }

  // EVERY origin distinct, which is the different-origins clause. Stated once,
  // here, rather than also as an early return inside the loop: a duplicate
  // origin is exactly a set smaller than the record count, so the two spellings
  // were the same test written twice and the early one could be deleted with no
  // test noticing.
  return origins.size === records.length;
}

/** The audit record for one applied tier-0 merge. */
function describeTier0Merge(g: Group, res: Resolution): Tier0Merge {
  const code = getProp(g.records[0], NS.health + 'testCode');
  const instant = getProp(g.records[0], NS.health + 'performedDate') ?? '';
  return {
    canonicalUri: res.canonical.uri,
    recordType: g.records[0].type,
    matchedOn: `loinc:${code ? codeFromUri(code) : '(none)'}@${instant}`,
    origins: g.records.map((r) => r.sourceIdentity as string).sort(),
    discarded: g.records
      .filter((r) => r.uri !== res.canonical.uri)
      .map((r) => ({
        uri: r.uri,
        type: r.type,
        sourceSystem: r.sourceSystem,
        sourceIdentity: r.sourceIdentity,
        properties: Object.fromEntries(
          [...r.properties].map(([pred, vals]) => [
            pred,
            vals.map((v) => ({ value: v.value, datatype: v.datatype, isIri: v.isIri })),
          ]),
        ),
      })),
  };
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
  /** True when every member satisfies the tier-0 predicate. See {@link isTier0Group}. */
  tier0?: boolean;
}

interface Resolution {
  canonical: ParsedRecord;
  mergedUris: string[];
  mergedSystems: string[];
  strategy: string;
  resolved: boolean;
}

function completeness(r: ParsedRecord): number {
  const skip = new Set([NS.rdf + 'type', NS.cascade + 'dataProvenance', NS.cascade + 'schemaVersion', NS.cascade + 'sourceSystem', SOURCE_IDENTITY_PREDICATE]);
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
  //
  // TIER 0 IS EXEMPT, and this is the clause where the ruling has teeth. The
  // guard's question is "could these two be different things?", and for a tier-0
  // group that question is already answered by construction: same LOINC, same
  // INSTANT, byte-identical content, two different named organizations. A
  // provenance class differing across them describes how each copy reached the
  // pod, which is exactly what two organizations reporting one draw looks like —
  // so under this guard every cross-source duplicate, the commonest and most
  // benign thing a multi-source pod holds, became a question. Exempting the
  // class is the difference between a queue a person finishes and one they
  // abandon with the real disagreements still in it.
  if (!allowCrossProvenanceMerge && !g.tier0 && (g.matchType === 'near_duplicate' || g.matchType === 'exact_duplicate')) {
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
    // Provenance bookkeeping, not content. sourceIdentity in particular must NOT
    // be filled in from a loser: a winner that carries no origin has no origin,
    // and inheriting the loser's would attribute it to an organization it never
    // came from.
    const metaPreds = new Set([NS.rdf + 'type', NS.cascade + 'dataProvenance', NS.cascade + 'schemaVersion', NS.cascade + 'sourceSystem', SOURCE_IDENTITY_PREDICATE]);
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
    const records = await parseTurtle(input.content, input.systemName, input.existingPod === true);
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

  /**
   * THE SAME-SOURCE GUARD. True when two records must NOT be compared, because
   * they are two things ONE organization stated in ONE ingestion.
   *
   * WHAT THE GUARD IS ACTUALLY FOR
   * ------------------------------
   * A source does not restate the same record twice inside one export. Three
   * blood-pressure readings hours apart in one download are three readings, and
   * a matcher let loose on them merges away two real measurements. That is what
   * the guard protects.
   *
   * It is NOT for holding apart two exports. One organization exporting FHIR in
   * January and a C-CDA in March is the re-sync case that reconciliation exists
   * to handle, and the same is true of the same system's two transports.
   *
   * WHY KEYING ON `sourceSystem` ALONE WAS WRONG
   * --------------------------------------------
   * `sourceSystem` is the INGESTION axis — the import-batch label, which defaults
   * to the file name and is set by `--source-system`. It answers neither half of
   * the question. Measured on the pathology corpus (P07-SHARED-LABEL): give two
   * different health systems' exports ONE batch label, which is the ordinary
   * shape when a consumer health app exports several connected accounts, and the
   * guard suppresses every cross-source comparison. None of four byte-identical
   * duplicates merges, and the pod holds 12 records where 7 is right. On one real
   * corpus the same defect hid 148 cross-source duplicates.
   *
   * WHY IT IS NOT KEYED ON THE ORIGIN ALONE EITHER
   * ----------------------------------------------
   * Because that breaks the other half. Corpus scenario P01 is one health system
   * exporting FHIR and a C-CDA; both halves now correctly carry ONE origin, so an
   * origin-only guard would stop the two transports from ever being compared and
   * the duplicate condition and lab would both survive. Measured: P01 falls from
   * 2 merges to 0 and from 8 records to 10.
   *
   * So both axes, and the AND is the load-bearing part. This suppresses a STRICT
   * SUBSET of what the old guard suppressed: nothing that merges today stops
   * merging, and the only pairs newly admitted are those with DIFFERENT known
   * origins under one batch label — exactly the defect.
   *
   * ABSENT OR UNKNOWN ORIGIN BEHAVES CONSERVATIVELY
   * -----------------------------------------------
   * `isKnownOrigin` is false for a record written before core v3.5 (no value at
   * all) and for one whose origin honestly landed on the `transport:` tier
   * (nothing in the document named or located an organization). In both cases the
   * origin is UNKNOWN, and two unknowns are not evidence of two different
   * organizations. So the guard declines to use the axis and falls back to the
   * batch label, which is the pre-v3.5 behaviour: it suppresses MORE comparison,
   * leaving duplicates in the pod, which is the recoverable direction. A pod
   * imported by an older CLI therefore reconciles exactly as it did before.
   */
  const sameSourceStatement = (a: ParsedRecord, b: ParsedRecord): boolean => {
    if (a.sourceSystem !== b.sourceSystem) return false;
    if (isKnownOrigin(a.sourceIdentity) && isKnownOrigin(b.sourceIdentity)) {
      return a.sourceIdentity === b.sourceIdentity;
    }
    return true;
  };

  // Match and group
  const groups: Group[] = [];
  const assigned = new Set<string>();

  // Keyed on WHERE THE INPUT CAME FROM, not on a label the record could restate.
  // The test was `r.sourceSystem === 'existing-pod'`, and a pod record's
  // `sourceSystem` is read from its own `cascade:sourceSystem` triple, which it
  // always has — so this was permanently false and `--reconcile-existing` always
  // fell through to the single-batch branch.
  const hasExistingPod = allRecords.some(r => r.fromExistingPod);

  if (hasExistingPod) {
    // ---------------------------------------------------------------------------
    // Fast path: O(n_new × k) type-indexed matching for --reconcile-existing mode
    // ---------------------------------------------------------------------------

    const existingRecords = allRecords.filter(r => r.fromExistingPod);

    // A new record whose subject IRI the pod ALREADY holds is a re-import of that
    // record, and the pod's own copy is the one that is kept. Cascade subjects are
    // content-hashed and `splitIdentityCollisions` has already moved apart any two
    // records that merely LOOK the same, so a shared IRI here means the two agree
    // on everything except ingestion bookkeeping — and of the two, the stored copy
    // is the one whose `importedAt` says when the record first arrived and whose
    // record-to-record edges are already resolved to real subjects rather than
    // still being placeholders. Letting the fresh copy win instead re-stamped the
    // timestamp and re-resolved edges that were never unresolved, i.e. churn with
    // nothing gained. Dropping them here (rather than inside the loops) also keeps
    // them out of `groupedRecords`, so `duplicateSubjectsDropped` counts them,
    // which is exactly what that number is for.
    const existingUris = new Set(existingRecords.map(r => r.uri));
    const newRecords = allRecords.filter(r => !r.fromExistingPod && !existingUris.has(r.uri));

    // THE PASS ORDERING. ONE pass, seeded by new records, over candidates drawn
    // from BOTH pools.
    //
    // WHAT WAS HERE, AND WHY IT COULD NOT BE PATCHED
    // ---------------------------------------------
    // Two passes ran in sequence: a cross-batch pass (each new record against
    // existing records) and then a within-batch pass (new against new). The
    // first one called `assigned.add(a.uri)` on EVERY new record, matched or
    // not, so by the time the second pass ran there was no unassigned new record
    // left for it to seed from. The second pass and its same-source guard site
    // were unreachable — structurally dead code, not a rare path — and the
    // consequence was that a batch's own internal duplicates imported
    // un-reconciled whenever the pod had any content at all, which is every
    // import after the first. The single-batch path merged the very same pair:
    // measured 3 records against 1 on identical inputs.
    //
    // Two smaller repairs were considered and rejected, because each fixes the
    // symptom and leaves a different pair un-merged:
    //
    //   DEFER ASSIGNMENT (only assign new records that actually matched) lets
    //   the within-batch pass see the leftovers, but a new record that DID match
    //   an existing one is still assigned, so it can no longer absorb its own
    //   in-batch twin. Pod {gamma}, batch {alpha, beta} where all three are one
    //   result: alpha+gamma merge, beta is left over, 2 records where 1 is right.
    //
    //   WITHIN-BATCH FIRST inverts the same problem. alpha+beta merge, then both
    //   are assigned, so neither is ever compared against gamma. Again 2.
    //
    // Both are guard patches on an ordering that should not exist. A record's
    // membership in a group is one question, and asking it in two half-passes
    // over two disjoint candidate pools cannot answer it. So the two passes
    // become ONE, with the candidate list being the union of the pools, which
    // makes this path the SAME algorithm the single-batch path below runs — the
    // whole reason the two disagreed.
    //
    // WHAT STAYS DELIBERATELY RESTRICTED
    // ----------------------------------
    // Only new records SEED a group. An existing record is a candidate but never
    // a seed, so two records already in the pod are still never compared with
    // each other. That restriction is not an oversight to be fixed here: pod
    // content is reconciled by `pod reconcile`, a mutation a person asks for and
    // sees a report from first, not as an invisible side effect of importing an
    // unrelated file. Import remains additive with respect to what the pod
    // already holds.
    const candidateIndex = new Map<string, ParsedRecord[]>();
    for (const r of [...newRecords, ...existingRecords]) {
      const bucket = candidateIndex.get(r.type);
      if (bucket) bucket.push(r);
      else candidateIndex.set(r.type, [r]);
    }

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

      const candidates = candidateIndex.get(a.type) ?? [];
      for (const b of candidates) {
        // `b === a` is new here, because the seed is now in its own candidate
        // list and a record matched against itself would form a merge group of
        // one record with itself: same count out, but the survivor restated as
        // the winner of a merge that never happened, with `mergedFrom` pointing
        // at itself.
        //
        // It is also, measured, REDUNDANT: `sameSourceStatement(a, a)` is
        // unconditionally true (one record trivially shares its own ingestion
        // label and its own origin), so the next clause already rejects the
        // self-pair and deleting this one leaves the suite green. Kept because
        // it is the direct statement of the condition, it matches the
        // single-batch loop below, and it does not depend on a guard about
        // SOURCES happening to also exclude identity.
        if (b === a || assigned.has(b.uri) || sameSourceStatement(a, b) || sameCollision(a, b)) continue;
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
        if (b === a || assigned.has(b.uri) || sameSourceStatement(a, b) || sameCollision(a, b)) continue;
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

  // Tier-0 classification, BEFORE resolution, because resolveGroup reads it.
  // The fingerprint is memoized: it is a SHA-256 over the record's whole property
  // set and a group asks for it once per member.
  const fingerprintCache = new Map<ParsedRecord, string>();
  const fingerprintOf = (r: ParsedRecord): string => {
    let fp = fingerprintCache.get(r);
    if (fp === undefined) {
      fp = recordContentFingerprint(r, referenceResolver, TIER0_IGNORED_PREDICATES);
      fingerprintCache.set(r, fp);
    }
    return fp;
  };
  for (const g of groups) {
    if (g.matchType === 'pass_through') continue;
    g.tier0 = isTier0Group(g.records, fingerprintOf);
  }

  // Resolve
  const allowCrossProvenanceMerge = options?.allowCrossProvenanceMerge ?? true;
  const resolutions = groups.map(g => resolveGroup(g, trustScores, defaultTrust, allowCrossProvenanceMerge));

  // The tier-0 journal: what merged, what it merged away, and enough of the
  // discarded records to put them back.
  //
  // `resolved` is checked and is UNREACHABLE TODAY, deliberately. A tier-0 group
  // is a set of byte-identical lab records, so `classifyGroup` always calls it an
  // exact duplicate, and the only rule that could have left an exact duplicate
  // unresolved is the cross-provenance guard, which tier 0 is now exempt from.
  // So no group can currently reach here with `resolved === false`, and deleting
  // the check would pass every test. It stays because of what this list MEANS:
  // an entry is the claim "these records were merged away, and here is what they
  // held". A future match type that leaves a tier-0 group for review would, with
  // the check gone, journal records that are still in the pod, and the journal
  // would start describing merges that never happened. That is a worse failure
  // than a redundant condition.
  const tier0Merges: Tier0Merge[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g.tier0 || !resolutions[i].resolved || g.records.length < 2) continue;
    tier0Merges.push(describeTier0Merge(g, resolutions[i]));
  }

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
      // Only stated when true, so every existing consumer of this object and
      // every recorded fixture of it is byte-unchanged on a run with no tier-0
      // merge, which is the ordinary run.
      ...(g.tier0 ? { tier0: true } : {}),
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
        tier0MergesApplied: tier0Merges.length,
        passthroughSubjects: passthroughSubjectKeys.size,
        edgeObjectsRewritten,
      },
      transformations,
      unresolvedConflicts: unresolvedList,
      tier0Merges,
    },
  };
}
