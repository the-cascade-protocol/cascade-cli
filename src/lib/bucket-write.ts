/**
 * The single door every RECORD-DATA merge writes through.
 *
 * A pod bucket (`clinical/*.ttl`, `wellness/*.ttl`, `annotations/*.ttl`) is
 * merged by read-modify-write. Doing that with text surgery has now produced
 * the same shipped defect twice: a writer stripped the leading `@prefix` block,
 * re-emitted a header of its OWN namespaces, and kept a body full of CURIEs
 * whose prefixes it had just deleted. The file stopped parsing and the
 * whole-pod read failed.
 *
 * This module makes that class of defect unrepresentable rather than fixed:
 *
 *   - No caller emits Turtle text. Callers hand over QUADS.
 *   - One {@link Writer} owns the entire document, header included. An N3
 *     writer emits a full `<IRI>` for any namespace it has no prefix for, so an
 *     undeclared CURIE cannot be written.
 *   - The prefixes the existing document DECLARED are harvested and win over
 *     the CLI's own, so a bucket an importer wrote keeps the prefix names it
 *     was written with and stays as compact as it was.
 *   - An existing file that does not parse is a hard, named refusal
 *     ({@link BucketParseError}). Nothing is written. Silently treating an
 *     unreadable bucket as empty is how a corrupt file became a LOST file.
 *
 * NOT for human-curated scaffolding. `settings/publicTypeIndex.ttl`,
 * `index.ttl`, `profile/card.ttl` and `profile/extended.ttl` are authored with
 * comments that are load-bearing — `extended.ttl` regex-anchors PHI population
 * on a literal comment line — and re-serializing them would drop those
 * comments. The boundary is the one `pod-data-types.ts` already draws.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Parser, Writer, DataFactory } from 'n3';
import type { Quad, Quad_Object, Quad_Subject } from 'n3';
import { readResource, writeResource } from './pod-encryption.js';

const { namedNode, blankNode, quad: makeQuad } = DataFactory;

/**
 * Namespaces the CLI itself can emit, so its own output stays compact.
 *
 * The first eleven are `fhir-converter/types.ts`'s `TURTLE_PREFIXES`, in its
 * order, so a file the importer wrote and this module later rewrites keeps its
 * header block in place. The last four are the namespaces only the record and
 * overlay writers use (`add-record`, `amend`, `annotate`, `retract`, `erase`).
 *
 * A namespace absent here is not a hazard: the writer falls back to a full
 * `<IRI>`. Adding one only changes how compactly it is written.
 */
export const KNOWN_PREFIXES: Record<string, string> = {
  cascade: 'https://ns.cascadeprotocol.org/core/v1#',
  health: 'https://ns.cascadeprotocol.org/health/v1#',
  clinical: 'https://ns.cascadeprotocol.org/clinical/v1#',
  coverage: 'https://ns.cascadeprotocol.org/coverage/v1#',
  fhir: 'http://hl7.org/fhir/',
  sct: 'http://snomed.info/sct/',
  loinc: 'http://loinc.org/rdf#',
  rxnorm: 'http://www.nlm.nih.gov/research/umls/rxnorm/',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  prov: 'http://www.w3.org/ns/prov#',
  vcard: 'http://www.w3.org/2006/vcard/ns#',
  checkup: 'https://ns.cascadeprotocol.org/checkup/v1#',
  pots: 'https://ns.cascadeprotocol.org/pots/v1#',
  workbench: 'https://ns.cascadeprotocol.org/workbench/v1#',
  dct: 'http://purl.org/dc/terms/',
};

/**
 * Sentinel base IRI for round-trip-safe RELATIVE IRIs.
 *
 * A pod states attribution as a root-relative IRI: `add-record` writes
 * `prov:wasAttributedTo </profile/card.ttl#me>`. These quads are re-serialized
 * back to the SAME file, so a relative IRI has to come out exactly as it went
 * in.
 *
 * `baseIRI: ''` — the mitigation `pod erase` shipped with — does NOT do that.
 * N3's `_setBase('')` leaves `_baseRoot` undefined and `_resolveRelativeIRI`
 * then computes `_baseRoot + iri`, so `</profile/card.ttl#me>` resolves to the
 * literal string `"undefined/profile/card.ttl#me"`, and it is silent: the file
 * still parses, it just says something else.
 *
 * A bare-scheme base makes N3's `_base`, `_basePath` and `_baseRoot` the same
 * string, so every relative form (root-relative, doc-relative, empty `<>`,
 * fragment-only `<#x>`) acquires exactly this one prefix, which
 * {@link derelativizeQuads} strips back off on the way out.
 */
export const REL_BASE = 'x-cascade-rel:';

/**
 * An existing bucket file could not be read as Turtle.
 *
 * Thrown BEFORE anything is written. A bucket that does not parse is a bucket
 * whose contents are unknown, and unknown is not empty.
 */
export class BucketParseError extends Error {
  readonly file: string;

  constructor(file: string, detail: string) {
    super(
      `Cannot read ${file} as Turtle: ${detail}\n` +
        `  This file must parse before anything can be merged into it. ` +
        `Nothing was written.`,
    );
    this.name = 'BucketParseError';
    this.file = file;
  }
}

/** Undo the {@link REL_BASE} sentinel on every IRI term of every quad. */
export function derelativizeQuads(quads: Quad[]): Quad[] {
  const strip = (value: string): string =>
    value.startsWith(REL_BASE) ? value.slice(REL_BASE.length) : value;
  return quads.map((q) => {
    const s = q.subject.termType === 'NamedNode' && q.subject.value.startsWith(REL_BASE)
      ? (namedNode(strip(q.subject.value)) as Quad_Subject)
      : q.subject;
    const p = q.predicate.value.startsWith(REL_BASE)
      ? namedNode(strip(q.predicate.value))
      : q.predicate;
    const o = q.object.termType === 'NamedNode' && q.object.value.startsWith(REL_BASE)
      ? (namedNode(strip(q.object.value)) as Quad_Object)
      : q.object;
    return s === q.subject && p === q.predicate && o === q.object ? q : makeQuad(s, p, o, q.graph);
  });
}

/**
 * Parse Turtle into quads AND the prefixes the document declared.
 *
 * Harvesting the document's own prefixes is what keeps a re-serialized bucket
 * as compact and as recognisable as the writer that created it left it, and it
 * is why a re-serializing merge cannot drop `rxnorm:`, `sct:` or `loinc:`.
 */
export function parseBucketTurtle(
  turtle: string,
): Promise<{ quads: Quad[]; prefixes: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const parser = new Parser({ format: 'Turtle', baseIRI: REL_BASE });
    const quads: Quad[] = [];
    parser.parse(turtle, (error, q, prefixes) => {
      if (error) {
        reject(error);
        return;
      }
      if (!q) {
        resolve({ quads: derelativizeQuads(quads), prefixes: toIriMap(prefixes) });
        return;
      }
      quads.push(q);
    });
  });
}

/** N3 hands prefixes back as terms; the Writer wants plain namespace strings. */
function toIriMap(prefixes: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!prefixes || typeof prefixes !== 'object') return out;
  for (const [k, v] of Object.entries(prefixes as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (v && typeof v === 'object' && 'value' in v) out[k] = String((v as { value: unknown }).value);
  }
  return out;
}

/**
 * Rewrite blank-node labels to a bounded, deterministic sequence.
 *
 * N3's parser prefixes every label it reads with a fresh per-parse counter, so
 * a round-tripped `_:b1` comes back as `_:b2_b1`, then `_:b3_b2_b1`. A bucket
 * holding blank nodes would therefore grow on EVERY write, forever. Labels are
 * document-scoped and carry no meaning across documents, so renumbering them in
 * emission order is loss-free.
 *
 * No bucket contains a blank node today. This is the insurance that keeps that
 * true if one ever does.
 */
export function normalizeBlankNodes(quads: Quad[]): Quad[] {
  const seen = new Map<string, ReturnType<typeof blankNode>>();
  const relabel = (label: string) => {
    let next = seen.get(label);
    if (!next) {
      next = blankNode(`b${seen.size}`);
      seen.set(label, next);
    }
    return next;
  };
  return quads.map((q) => {
    if (q.subject.termType !== 'BlankNode' && q.object.termType !== 'BlankNode') return q;
    const s = q.subject.termType === 'BlankNode'
      ? (relabel(q.subject.value) as Quad_Subject)
      : q.subject;
    const o = q.object.termType === 'BlankNode'
      ? (relabel(q.object.value) as Quad_Object)
      : q.object;
    return makeQuad(s, q.predicate, o, q.graph);
  });
}

/** Serialize a whole bucket document: one Writer owns the header and the body. */
export function serializeBucket(quads: Quad[], prefixes: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const writer = new Writer({ prefixes });
    for (const q of quads) writer.addQuad(q);
    writer.end((error, result) => (error ? reject(error) : resolve(result)));
  });
}

/** How `newQuads` are combined with what the file already held. */
export type BucketCombine = (existing: Quad[], incoming: Quad[]) => Quad[];

export interface MergeIntoBucketOptions {
  /**
   * Combine the parsed existing quads with the incoming ones. Defaults to
   * append (`[...existing, ...incoming]`).
   *
   * A caller that needs subject-level deduplication, or that is REPLACING the
   * file's contents wholesale (`pod erase`, a cross-batch reconciled import),
   * supplies its own. It still runs behind the parse, so the refusal to write
   * over an unreadable file holds for every caller.
   */
  combine?: BucketCombine;
  /**
   * Inspect the serialized document before it is written. Throwing aborts the
   * write. `annotations/` uses this for its SHACL gate.
   */
  validate?: (turtle: string, filePath: string) => void;
  /** Compute everything, write nothing. */
  dryRun?: boolean;
}

export interface BucketWriteResult {
  /** Whether the target existed before this write. */
  existedBefore: boolean;
  /** Triples parsed out of the existing file (0 when it did not exist). */
  triplesBefore: number;
  /** Triples in the document that was written. */
  triplesAfter: number;
  /** The serialized document (returned even under `dryRun`). */
  turtle: string;
  /** False under `dryRun`. */
  written: boolean;
}

/**
 * THE CHOKEPOINT. Merge `newQuads` into the record file at `targetFile`.
 *
 * Reads the existing file as a GRAPH, combines, and writes the whole document
 * back through one serializer that owns the prefix header.
 *
 * @throws {BucketParseError} when the existing file is not valid Turtle.
 * @throws {PodDecryptError}  when the existing file cannot be decrypted.
 */
export async function mergeIntoBucket(
  targetFile: string,
  newQuads: Quad[],
  dek: Buffer | undefined,
  options: MergeIntoBucketOptions = {},
): Promise<BucketWriteResult> {
  const existedBefore = fs.existsSync(targetFile);

  let existingQuads: Quad[] = [];
  let filePrefixes: Record<string, string> = {};

  if (existedBefore) {
    // A read failure (bad DEK, unreadable bytes) propagates untouched: it is
    // not a parse error and it must not be reported as one.
    const existing = readResource(targetFile, dek);
    try {
      const parsed = await parseBucketTurtle(existing);
      existingQuads = parsed.quads;
      filePrefixes = parsed.prefixes;
    } catch (e: unknown) {
      throw new BucketParseError(targetFile, e instanceof Error ? e.message : String(e));
    }
  }

  const combine = options.combine ?? ((existing, incoming) => [...existing, ...incoming]);
  // The file's own declarations win, so a bucket keeps the prefix names it was
  // written with; the CLI's namespaces are the floor, so the quads being added
  // are compact too.
  const prefixes = { ...KNOWN_PREFIXES, ...filePrefixes };

  const merged = derelativizeQuads(normalizeBlankNodes(combine(existingQuads, newQuads)));
  const turtle = await serializeBucket(merged, prefixes);

  options.validate?.(turtle, targetFile);

  if (options.dryRun) {
    return { existedBefore, triplesBefore: existingQuads.length, triplesAfter: merged.length, turtle, written: false };
  }

  await fs.promises.mkdir(path.dirname(targetFile), { recursive: true });
  writeResource(targetFile, turtle, dek);
  return { existedBefore, triplesBefore: existingQuads.length, triplesAfter: merged.length, turtle, written: true };
}
