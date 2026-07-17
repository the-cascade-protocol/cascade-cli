/**
 * Graph-aware pod query support (root backlog 4.6, slice Q1).
 *
 * Loads every data file `pod query --all` discovers into a single `n3.Store`,
 * indexes the pod's record subjects, and serves two read-only views over the
 * stored forward edges:
 *
 *   - `recordEdges()`  — the record-to-record edge projection surfaced by
 *     `query --all --edges`, an array of `{ subject, predicate, object }`.
 *   - `neighborhood()` — a bounded, both-directions traversal from a seed
 *     record, surfaced by `query --neighbors <iri>`.
 *
 * Design notes (ratified in the Q1 kickoff):
 *   - Forward edges are stored; traversal reports `direction` per edge and never
 *     materializes an inverse. A lab result's neighborhood reaches its report
 *     via the inverse of `hasLabResult`, reported as `direction: "in"`.
 *   - An edge is ANY triple whose subject and object are both record subjects in
 *     the same pod. No predicate is hardcoded, so future reason/encounter edges
 *     flow through with no change here. `rdf:type`, code-system IRIs, and vocab
 *     terms fall out automatically because their objects are not record subjects.
 *   - Determinism: stable ordering everywhere. Same pod + same flags produce
 *     byte-identical output.
 *
 * A "record subject" is any named-node subject that carries an `rdf:type`. Only
 * the subject set is indexed; no other caching (the audit pod is ~2.8k triples,
 * trivially fine for `n3.Store`).
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { Store, DataFactory } from 'n3';
import { parseTurtle, shortenIRI, getProperties, extractLabel } from '../../lib/turtle-parser.js';
import { readResource } from '../../lib/pod-encryption.js';
import { discoverTtlFiles } from './helpers.js';

const { namedNode } = DataFactory;

const RDF_TYPE_IRI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * `rdf:type` IRIs that are pod plumbing, never a data record on their own.
 * A subject typed only by these is a container / type-index / provenance node;
 * it is still a record subject (it carries an rdf:type), but these types are
 * skipped when choosing the display `type`. Mirrors `parseDataFile`.
 */
const STRUCTURAL_TYPE_IRIS = new Set([
  'http://www.w3.org/ns/solid/terms#TypeRegistration',
  'http://www.w3.org/ns/solid/terms#TypeIndex',
  'http://www.w3.org/ns/solid/terms#ListedDocument',
  'http://www.w3.org/ns/solid/terms#UnlistedDocument',
  'http://www.w3.org/ns/ldp#BasicContainer',
]);

export interface PodGraph {
  /** All quads from every graph-covered data file, in one store. */
  store: Store;
  /** Every named-node subject that carries an `rdf:type`. */
  recordSubjects: Set<string>;
  /** Pod-relative paths the graph covers (the files `--all` reads). */
  files: string[];
  /** Files that could not be read/parsed (decrypt failure, bad Turtle). */
  parseErrors: Array<{ file: string; error: string }>;
}

export interface RecordEdge {
  /** Full IRI of the record the edge is written on. */
  subject: string;
  /** Edge predicate as a CURIE (`clinical:hasLabResult`) or full IRI if unknown. */
  predicate: string;
  /** Full IRI of the referenced record. */
  object: string;
}

export interface SeedSummary {
  iri: string;
  type: string;
  label?: string;
  properties: Record<string, string>;
}

export interface Neighbor {
  /** Full IRI of the neighboring record. */
  iri: string;
  /** Its display type as a CURIE (or full IRI if unknown). */
  type: string;
  /** The edge predicate that reached it (CURIE or full IRI). */
  edge: string;
  /** `out` = seed-side is the edge subject; `in` = seed-side is the edge object. */
  direction: 'out' | 'in';
  /** Traversal depth from the seed (1-based). */
  hop: number;
}

export interface NeighborhoodResult {
  seed: SeedSummary;
  /** Effective hop budget after clamping to [1, 3]. */
  hops: number;
  /** Edge-predicate filters that were applied, as CURIEs (empty = no filter). */
  edgeFilters: string[];
  neighbors: Neighbor[];
}

/** The same file-set `pod query --all` reads (record data, no pod plumbing). */
function graphExcludePaths(absDir: string): Set<string> {
  return new Set([
    path.join(absDir, 'index.ttl'),
    path.join(absDir, 'manifest.ttl'),
    path.join(absDir, 'profile', 'card.ttl'),
    path.join(absDir, 'settings', 'publicTypeIndex.ttl'),
    path.join(absDir, 'settings', 'privateTypeIndex.ttl'),
  ]);
}

/**
 * Load every graph-covered data file into a single store and index its record
 * subjects. Encrypted pods decrypt with `dek` exactly like `query --all`.
 */
export async function loadPodGraph(absDir: string, dek?: Buffer): Promise<PodGraph> {
  const exclude = graphExcludePaths(absDir);
  const discovered = await discoverTtlFiles(absDir); // already sorted
  const files = discovered.filter((f) => !exclude.has(f));

  const store = new Store();
  const parseErrors: Array<{ file: string; error: string }> = [];

  for (const file of files) {
    const rel = path.relative(absDir, file);
    let content: string;
    try {
      // readResource decrypts when a dek is supplied, else reads plaintext.
      content = dek ? readResource(file, dek) : await fs.readFile(file, 'utf-8');
    } catch (err: unknown) {
      parseErrors.push({ file: rel, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const result = parseTurtle(content, `file://${file}`);
    if (!result.success) {
      parseErrors.push({ file: rel, error: result.errors.join('; ') });
      continue;
    }
    store.addQuads(result.quads);
  }

  const recordSubjects = new Set<string>();
  for (const quad of store.getQuads(null, namedNode(RDF_TYPE_IRI), null, null)) {
    if (quad.subject.termType === 'NamedNode') {
      recordSubjects.add(quad.subject.value);
    }
  }

  return {
    store,
    recordSubjects,
    files: files.map((f) => path.relative(absDir, f)),
    parseErrors,
  };
}

/**
 * Choose a deterministic display type for a subject: the first meaningful
 * (non-structural) `rdf:type` in sorted order, shortened to a CURIE. Falls back
 * to the first type of any kind, then to an empty string.
 */
function displayType(store: Store, iri: string): string {
  const types = store
    .getObjects(namedNode(iri), namedNode(RDF_TYPE_IRI), null)
    .map((o) => o.value)
    .sort();
  const meaningful = types.filter(
    (t) => !t.startsWith('http://www.w3.org/ns/prov#') && !STRUCTURAL_TYPE_IRIS.has(t),
  );
  const chosen = meaningful[0] ?? types[0];
  return chosen ? shortenIRI(chosen) : '';
}

/** Summarize a record subject for the seed of a neighborhood query. */
export function summarizeSubject(store: Store, iri: string): SeedSummary {
  const props = getProperties(store, iri);
  const label = extractLabel(props);
  const flatProps: Record<string, string> = {};
  for (const [pred, values] of Object.entries(props)) {
    if (pred === RDF_TYPE_IRI) continue;
    const sorted = [...values].sort();
    flatProps[shortenIRI(pred)] = sorted.length === 1 ? sorted[0] : sorted.join(', ');
  }
  return { iri, type: displayType(store, iri), label: label ?? undefined, properties: flatProps };
}

/**
 * The record-to-record edge projection: every triple whose subject and object
 * are both record subjects (excluding `rdf:type`). Sorted by predicate IRI,
 * then subject IRI, then object IRI. Blank-node objects are skipped without
 * error (they are never record edges).
 */
export function recordEdges(graph: PodGraph): RecordEdge[] {
  const { store, recordSubjects } = graph;

  const rows: Array<{ subject: string; predicateFull: string; object: string }> = [];
  for (const quad of store.getQuads(null, null, null, null)) {
    if (quad.predicate.value === RDF_TYPE_IRI) continue;
    if (quad.subject.termType !== 'NamedNode' || quad.object.termType !== 'NamedNode') continue;
    if (!recordSubjects.has(quad.subject.value) || !recordSubjects.has(quad.object.value)) continue;
    rows.push({
      subject: quad.subject.value,
      predicateFull: quad.predicate.value,
      object: quad.object.value,
    });
  }

  rows.sort(
    (a, b) =>
      cmp(a.predicateFull, b.predicateFull) || cmp(a.subject, b.subject) || cmp(a.object, b.object),
  );

  return rows.map((r) => ({
    subject: r.subject,
    predicate: shortenIRI(r.predicateFull),
    object: r.object,
  }));
}

/**
 * Traverse the neighborhood of a seed record, following stored forward edges in
 * both directions up to `hops` deep. Returns `null` when the seed is not a
 * record subject in this pod (the caller emits a clean error).
 *
 * Breadth-first: each record is emitted once, at the hop where it is first
 * reached, labelled with the edge that reached it (deterministically the
 * lowest-sorted candidate: predicate IRI, then direction, then neighbor IRI).
 * The seed itself is never emitted as its own neighbor.
 */
export function neighborhood(
  graph: PodGraph,
  seedIri: string,
  opts: { hops: number; edgeFilters: string[] },
): NeighborhoodResult | null {
  const { store, recordSubjects } = graph;
  if (!recordSubjects.has(seedIri)) return null;

  const filterSet = opts.edgeFilters.length > 0 ? new Set(opts.edgeFilters) : null;
  const visited = new Set<string>([seedIri]);
  const neighbors: Neighbor[] = [];
  let frontier: string[] = [seedIri];

  for (let hop = 1; hop <= opts.hops && frontier.length > 0; hop++) {
    const candidates: Array<{ iri: string; predicateFull: string; direction: 'out' | 'in' }> = [];

    for (const node of frontier) {
      // Outgoing: node --predicate--> record
      for (const quad of store.getQuads(namedNode(node), null, null, null)) {
        if (quad.predicate.value === RDF_TYPE_IRI) continue;
        if (quad.object.termType !== 'NamedNode') continue;
        if (!recordSubjects.has(quad.object.value)) continue;
        if (filterSet && !filterSet.has(quad.predicate.value)) continue;
        candidates.push({ iri: quad.object.value, predicateFull: quad.predicate.value, direction: 'out' });
      }
      // Incoming: record --predicate--> node
      for (const quad of store.getQuads(null, null, namedNode(node), null)) {
        if (quad.predicate.value === RDF_TYPE_IRI) continue;
        if (quad.subject.termType !== 'NamedNode') continue;
        if (!recordSubjects.has(quad.subject.value)) continue;
        if (filterSet && !filterSet.has(quad.predicate.value)) continue;
        candidates.push({ iri: quad.subject.value, predicateFull: quad.predicate.value, direction: 'in' });
      }
    }

    candidates.sort(
      (a, b) =>
        cmp(a.predicateFull, b.predicateFull) ||
        cmp(a.direction, b.direction) ||
        cmp(a.iri, b.iri),
    );

    const nextFrontier: string[] = [];
    for (const c of candidates) {
      if (visited.has(c.iri)) continue;
      visited.add(c.iri);
      nextFrontier.push(c.iri);
      neighbors.push({
        iri: c.iri,
        type: displayType(store, c.iri),
        edge: shortenIRI(c.predicateFull),
        direction: c.direction,
        hop,
      });
    }
    frontier = nextFrontier;
  }

  return {
    seed: summarizeSubject(store, seedIri),
    hops: opts.hops,
    edgeFilters: opts.edgeFilters.map((f) => shortenIRI(f)),
    neighbors,
  };
}

/** Stable string comparison (deterministic, locale-independent). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
