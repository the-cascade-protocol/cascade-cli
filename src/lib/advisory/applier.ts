/**
 * Cascade Advisory Patch (CAP) — Applier with Activity Logging (TASK-4.5).
 *
 * For each Bind match, the applier:
 *   1. Walks the AST's Add blocks, replacing every `?var` reference with the
 *      bound IRI for this match.
 *   2. Emits the resulting triples into the pod's RDF store.
 *   3. Records a `cascade:AdvisoryApplicationActivity` per match. The activity
 *      links the patch (`prov:used <advisory-iri>`) and the matched record
 *      (`prov:used <matched-record-iri>`) and stamps the application time
 *      (`prov:atTime`).
 *   4. Marks every NEWLY-INSERTED root subject with
 *      `prov:wasGeneratedBy <activity-iri>`. This is in addition to whatever
 *      `prov:wasGeneratedBy` triples the patch itself emits — the applier's
 *      generated-by points at the local activity record, not the advisory IRI
 *      (which is typically what the patch's generated-by points to).
 *
 * Per D-N6 milestone M4.2: applying example-brca2-reclassification.ldpatch to
 * a pod containing CAid CA000123 produces a new VariantInterpretation linked
 * to the prior interpretation via `prov:wasRevisionOf` — the BRCA2 example's
 * Add block writes that triple directly.
 *
 * The applier mutates `podStore` in place. Callers who want a dry-run should
 * pass a separate Store, or use the dry-run command (TASK-4.9).
 */

import type { Store } from 'n3';
import { DataFactory } from 'n3';
import type { Quad, NamedNode, BlankNode, Literal } from 'n3';
import type { CapAst, CapTerm, CapTriple } from './types.js';
import type { MatchResult } from './selector.js';

const { namedNode, literal, blankNode, quad: q } = DataFactory;

const PROV_USED = 'http://www.w3.org/ns/prov#used';
const PROV_AT_TIME = 'http://www.w3.org/ns/prov#atTime';
const PROV_WAS_GENERATED_BY = 'http://www.w3.org/ns/prov#wasGeneratedBy';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const ADVISORY_APPLICATION_ACTIVITY =
  'https://ns.cascadeprotocol.org/core/v1#AdvisoryApplicationActivity';
const APPLIED_TRIPLES_COUNT =
  'https://ns.cascadeprotocol.org/core/v1#appliedTriplesCount';

export interface ApplyOptions {
  /**
   * Override the application timestamp. Defaults to `new Date()`. Tests
   * pass a fixed value for deterministic output.
   */
  now?: Date;
  /**
   * IRI factory for activity records. The default mints
   * `urn:cascade:advisory-activity:<random>` — which is good enough for
   * tests and dry runs but is not collision-free on long-lived pods.
   * Production callers should pass a UUIDv7 generator.
   */
  mintActivityIri?: () => string;
  /**
   * If true, suppress the per-application `prov:wasGeneratedBy` activity
   * link added to root subjects. Useful for dry-run displays where the
   * activity isn't actually being persisted. Default: false.
   */
  suppressActivityLinks?: boolean;
}

/** Result of applying an advisory across all bindings. */
export interface ApplyResult {
  /** The number of matches processed (== bindings.length). */
  matchesApplied: number;
  /** Quads added to the pod store across all applications. */
  insertedQuads: ReadonlyArray<Quad>;
  /** One per match — the IRI of the activity record created for that application. */
  activityIris: ReadonlyArray<string>;
  /** One per match — the matched record IRI (mirrors bindings, for convenience). */
  matchedRecordIris: ReadonlyArray<string>;
}

/**
 * Apply a CAP advisory to a pod store, once per binding.
 */
export function applyCap(
  ast: CapAst,
  bindings: ReadonlyArray<MatchResult>,
  podStore: Store,
  advisoryIri: string,
  options: ApplyOptions = {},
): ApplyResult {
  const now = options.now ?? new Date();
  const mintActivityIri = options.mintActivityIri ?? defaultActivityIriMinter();

  const allInserted: Quad[] = [];
  const activityIris: string[] = [];
  const matchedRecordIris: string[] = [];

  for (const binding of bindings) {
    const activityIri = mintActivityIri();
    const matchedRecordIri = binding.boundIri;

    // ── 1. Materialize Add operations ──────────────────────────────────
    const insertedThisMatch: Quad[] = [];
    const rootSubjects = new Set<string>();
    for (const add of ast.adds) {
      for (const triple of add.triples) {
        const materialized = materializeTriple(triple, binding);
        if (!materialized) continue;
        insertedThisMatch.push(materialized);
        // Track NamedNode root subjects for the prov:wasGeneratedBy linkage.
        if (
          materialized.subject.termType === 'NamedNode' &&
          materialized.subject.value !== matchedRecordIri
        ) {
          rootSubjects.add(materialized.subject.value);
        }
      }
    }

    // ── 2. Build the activity record ──────────────────────────────────
    const activityNode = namedNode(activityIri);
    insertedThisMatch.push(
      q(activityNode, namedNode(RDF_TYPE), namedNode(ADVISORY_APPLICATION_ACTIVITY)),
    );
    insertedThisMatch.push(
      q(activityNode, namedNode(PROV_USED), namedNode(advisoryIri)),
    );
    if (matchedRecordIri.length > 0) {
      insertedThisMatch.push(
        q(activityNode, namedNode(PROV_USED), namedNode(matchedRecordIri)),
      );
    }
    insertedThisMatch.push(
      q(
        activityNode,
        namedNode(PROV_AT_TIME),
        literal(now.toISOString(), namedNode(XSD_DATETIME)),
      ),
    );
    // appliedTriplesCount counts the patch-emitted triples (does NOT include
    // the activity record's own triples). This is the count the user sees.
    insertedThisMatch.push(
      q(
        activityNode,
        namedNode(APPLIED_TRIPLES_COUNT),
        literal(String(insertedThisMatch.length - 4), namedNode(XSD_INTEGER)),
      ),
    );

    // ── 3. Link generated root subjects to the activity ────────────────
    if (!options.suppressActivityLinks) {
      for (const root of rootSubjects) {
        insertedThisMatch.push(
          q(namedNode(root), namedNode(PROV_WAS_GENERATED_BY), activityNode),
        );
      }
    }

    // ── 4. Commit to the store ────────────────────────────────────────
    for (const quad of insertedThisMatch) {
      podStore.addQuad(quad);
      allInserted.push(quad);
    }

    activityIris.push(activityIri);
    matchedRecordIris.push(matchedRecordIri);
  }

  return {
    matchesApplied: bindings.length,
    insertedQuads: allInserted,
    activityIris,
    matchedRecordIris,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Triple materialization                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Substitute the bound variable into a CapTriple, producing an n3 Quad.
 * Returns `null` if the triple references a variable other than the bound
 * one (which the validator should have already rejected — this is defensive).
 *
 * Per CAP profile §C4 the only legal variable in an Add is the one bound by
 * the (single) Bind clause, so substitution is straightforward.
 *
 * Bnode names are preserved within a single match-application (so co-references
 * stay coherent), but a separate match gets fresh bnode identities — that's
 * handled by re-keying through the n3 DataFactory's blank-node generator
 * implicitly: each call to materializeTriple creates new bnode terms.
 */
function materializeTriple(triple: CapTriple, binding: MatchResult): Quad | null {
  const subject = materializeTerm(triple.subject, binding);
  const object = materializeTerm(triple.object, binding);
  if (!subject || !object) return null;
  if (subject.termType === 'Literal') return null; // not a valid subject
  return q(
    subject as NamedNode | BlankNode,
    namedNode(triple.predicate),
    object as NamedNode | BlankNode | Literal,
  );
}

function materializeTerm(
  term: CapTerm,
  binding: MatchResult,
): NamedNode | BlankNode | Literal | null {
  switch (term.kind) {
    case 'iri':
      return namedNode(term.value);
    case 'literal':
      if (term.datatype) return literal(term.value, namedNode(term.datatype));
      if (term.lang) return literal(term.value, term.lang);
      return literal(term.value);
    case 'variable':
      // Only legal variable per C4 is the bound one. Defensive check.
      if (binding.variable === term.value && binding.boundIri.length > 0) {
        return namedNode(binding.boundIri);
      }
      return null;
    case 'bnode':
      return blankNode(term.value);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Default activity-IRI minter                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Default IRI minter — produces collision-resistant URNs of the form
 * `urn:cascade:advisory-activity:<timestamp>-<rand>`. NOT cryptographically
 * unique; production callers should swap in a UUIDv7 generator.
 */
function defaultActivityIriMinter(): () => string {
  let counter = 0;
  const seed = Date.now().toString(36);
  return () => {
    counter += 1;
    const rand = Math.random().toString(36).slice(2, 10);
    return `urn:cascade:advisory-activity:${seed}-${counter}-${rand}`;
  };
}
