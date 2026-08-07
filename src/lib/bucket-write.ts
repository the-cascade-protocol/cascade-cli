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
import { randomBytes } from 'node:crypto';
import { Parser, Writer, DataFactory } from 'n3';
import type { Quad, Quad_Graph, Quad_Object, Quad_Predicate, Quad_Subject, Term } from 'n3';
import { readResource, writeResource } from './pod-encryption.js';

const { namedNode, blankNode, literal, quad: makeQuad } = DataFactory;

/**
 * A term as it exists at RUNTIME, which is wider than n3's `Term` union.
 *
 * n3's TypeScript `Term` has no `'Quad'` member, but its parser really does
 * produce nested quads (RDF-star) whenever `format` is left unset — which is
 * exactly how `turtle-parser.ts`, and therefore `pod erase`'s read, parses. A
 * term walk that trusts the declared union silently skips those.
 */
type RuntimeTerm = Term | (Quad & { termType: 'Quad' });

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
 * SHAPE: the sentinel must be a BARE SCHEME — `<scheme>:` and nothing after the
 * colon. N3 derives `_baseRoot` with `/^(?:([a-z][a-z0-9+.-]*:))?(?:\/\/[^/]*)?/i`
 * and root-relative IRIs resolve against `_baseRoot`, not `_base`. A base of
 * `urn:x-cascade-rel-<nonce>:` therefore yields `_baseRoot === 'urn:'`, and
 * `</profile/card.ttl#me>` resolves to `urn:/profile/card.ttl#me` — which does
 * NOT carry the sentinel, so it is never stripped back off and the pod's WebID
 * silently becomes a different resource. Only a bare scheme makes `_base`,
 * `_basePath` and `_baseRoot` the same string, which is what makes all four
 * relative forms (root-relative, doc-relative, empty `<>`, fragment-only
 * `<#x>`) acquire exactly this one prefix. Verified against n3 1.26.0.
 *
 * NONCE: the scheme carries 128 random bits, minted once per process, rather
 * than being a fixed literal. A fixed literal is FORGEABLE, and forging it is a
 * silent re-identification attack: the strip cannot tell "this term was
 * relative in the source" from "this term merely starts with the sentinel", so
 * third-party Turtle containing `<x-cascade-rel:http://real.example/thing>` —
 * a perfectly legal absolute IRI, reachable through `pod import` — came back
 * out as `<http://real.example/thing>`, a statement about a different, real
 * resource, at exit 0. With a per-process nonce there is no string an attacker
 * can write down that this process will strip.
 */
const REL_BASE_SCHEME_PREFIX = 'x-cascade-rel-';

/** A fresh sentinel. Bare scheme, 128 bits of entropy, hex so it stays a legal scheme. */
function mintRelBase(): string {
  return `${REL_BASE_SCHEME_PREFIX}${randomBytes(16).toString('hex')}:`;
}

let activeRelBase = mintRelBase();

/**
 * Every sentinel this process has minted.
 *
 * One element in every real run. It exists so {@link assertNoSentinelLeak} can
 * still catch a term carrying a SUPERSEDED sentinel, which is the one way a
 * regeneration could otherwise open a leak.
 */
const mintedRelBases = new Set<string>([activeRelBase]);

/** The sentinel currently in force for this process. */
export function relBase(): string {
  return activeRelBase;
}

/**
 * The sentinel to parse `text` under, guaranteed absent from `text`.
 *
 * The check is what turns "an attacker practically cannot collide with the
 * nonce" into "a collision cannot happen at all". Everything downstream — the
 * strip, and the leak assertion — decides purely on `startsWith(base)`, so if a
 * source document could contain the base then a document could still name a
 * term the strip would rewrite. It cannot: any text that happens to hold the
 * active sentinel gets a fresh one minted for it, so within one parse
 * `startsWith(base)` means "N3 resolved this against the base", never "the
 * document said so".
 *
 * Reaching the loop body requires source text containing 128 specific random
 * bits that this process has never written anywhere ({@link
 * assertNoSentinelLeak} is what keeps that true). It is expected to be dead
 * code forever; it is here because "unreachable" is a claim about today's
 * coverage and this is the branch that makes the guarantee unconditional.
 */
export function relBaseFor(text: string): string {
  activeRelBase = pickSentinelBase(text, activeRelBase, () => {
    const minted = mintRelBase();
    mintedRelBases.add(minted);
    return minted;
  });
  return activeRelBase;
}

/** How many draws before {@link pickSentinelBase} concludes minting is broken. */
const MAX_SENTINEL_DRAWS = 8;

/**
 * Keep `current` if `text` does not contain it; otherwise draw again, BOUNDED.
 *
 * The bound is the point, and `mint` is injected so it can be observed. A
 * `while (contains) remint` loop terminates only because minting is random —
 * a property of a DIFFERENT function. If that ever stops holding (a
 * "simplification", a seeded double, a stubbed RNG) an unbounded loop hangs
 * the CLI forever on any input containing the sentinel, with no output and no
 * error. That is not hypothetical: mutating the nonce back to a fixed literal
 * to check this module's tripwires burned 22 minutes of CPU in a hang instead
 * of failing in a second.
 *
 * Eight colliding draws is not a case worth continuing from. It means the
 * randomness assumption is broken, and saying so beats spinning.
 */
export function pickSentinelBase(text: string, current: string, mint: () => string): string {
  let candidate = current;
  for (let draw = 0; draw < MAX_SENTINEL_DRAWS; draw++) {
    if (!text.includes(candidate)) return candidate;
    candidate = mint();
  }
  throw new Error(
    `Internal error: could not obtain a relative-IRI sentinel absent from the source text in ` +
      `${MAX_SENTINEL_DRAWS} draws. The sentinel carries 128 random bits, so this means minting ` +
      `has stopped being random.`,
  );
}

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

/**
 * A term that still carries the sentinel was about to be written to a pod.
 *
 * Not a user error: a gap in {@link derelativizeQuads}'s term coverage. It is
 * fatal rather than best-effort because the damage is PERMANENT. Once
 * `"5"^^<x-cascade-rel-...:myLocalType>` is on disk that datatype IRI is
 * ABSOLUTE, so no later parse resolves it against anything and no later strip
 * removes it. There is no second chance to notice.
 */
export class SentinelLeakError extends Error {
  readonly term: string;

  constructor(term: string) {
    super(
      `Internal error: the relative-IRI sentinel leaked into a term that was about to be ` +
        `written: ${term}\n` +
        `  This is a gap in derelativizeQuads' term coverage, not a problem with your data. ` +
        `Nothing was written.`,
    );
    this.name = 'SentinelLeakError';
    this.term = term;
  }
}

/** Strip one sentinel prefix off a term, recursing into everything that holds an IRI. */
function derelativizeTerm(term: RuntimeTerm, base: string): RuntimeTerm {
  switch (term.termType) {
    case 'NamedNode':
      return term.value.startsWith(base) ? namedNode(term.value.slice(base.length)) : term;
    case 'Literal': {
      // A literal's DATATYPE is a NamedNode, and `"5"^^<myLocalType>` is a
      // relative IRI like any other. Missing this is what leaked the sentinel
      // into pod data. A language-tagged literal's datatype is rdf:langString,
      // which is absolute, so reaching the rebuild means there is no language
      // to carry across.
      const dt = term.datatype;
      if (!dt || !dt.value.startsWith(base)) return term;
      return literal(term.value, namedNode(dt.value.slice(base.length)));
    }
    case 'Quad':
      return derelativizeQuad(term, base) as RuntimeTerm;
    default:
      // BlankNode, Variable, DefaultGraph. No IRI, nothing to strip.
      return term;
  }
}

/** Strip the sentinel off all four positions of one quad, graph included. */
function derelativizeQuad(q: Quad, base: string): Quad {
  const s = derelativizeTerm(q.subject as RuntimeTerm, base) as Quad_Subject;
  const p = derelativizeTerm(q.predicate as RuntimeTerm, base) as Quad_Predicate;
  const o = derelativizeTerm(q.object as RuntimeTerm, base) as Quad_Object;
  const g = derelativizeTerm(q.graph as RuntimeTerm, base) as Quad_Graph;
  return s === q.subject && p === q.predicate && o === q.object && g === q.graph
    ? q
    : makeQuad(s, p, o, g);
}

/**
 * Undo the sentinel base on every IRI-bearing term of every quad.
 *
 * `base` defaults to the sentinel currently in force. A caller that ran its own
 * parser must pass the base IT parsed under, because that is the only string
 * whose presence means "N3 resolved this".
 */
export function derelativizeQuads(quads: Quad[], base: string = relBase()): Quad[] {
  return quads.map((q) => derelativizeQuad(q, base));
}

/** Does any part of this term still mention `base`? */
function termLeaks(term: RuntimeTerm, base: string): string | undefined {
  switch (term.termType) {
    case 'NamedNode':
      return term.value.includes(base) ? term.value : undefined;
    case 'Literal':
      // The literal's own lexical form is checked too: the sentinel reached
      // pod data once before by a term being DEMOTED from a NamedNode to a
      // string literal on the reconciler's path.
      if (term.value.includes(base)) return `"${term.value}"`;
      return term.datatype?.value.includes(base) ? `^^<${term.datatype.value}>` : undefined;
    case 'Quad':
      return quadLeaks(term, base);
    default:
      return undefined;
  }
}

function quadLeaks(q: Quad, base: string): string | undefined {
  for (const t of [q.subject, q.predicate, q.object, q.graph]) {
    const hit = termLeaks(t as RuntimeTerm, base);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Refuse to write anything that still mentions a sentinel this process minted.
 *
 * The test is `includes`, not `startsWith`: a sentinel anywhere inside a term
 * is a leak, and no legitimate term can contain one, because
 * {@link relBaseFor} has already established that the source text does not and
 * nothing else mints them. That makes this a coverage tripwire with no way to
 * misfire on user data — if {@link derelativizeTerm} ever stops covering a term
 * position, the write fails loudly instead of poisoning a bucket forever.
 *
 * @throws {SentinelLeakError}
 */
export function assertNoSentinelLeak(quads: Quad[]): void {
  for (const q of quads) {
    for (const base of mintedRelBases) {
      const hit = quadLeaks(q, base);
      if (hit) throw new SentinelLeakError(hit);
    }
  }
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
  base: string = relBaseFor(turtle),
): Promise<{ quads: Quad[]; prefixes: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const parser = new Parser({ format: 'Turtle', baseIRI: base });
    const quads: Quad[] = [];
    parser.parse(turtle, (error, q, prefixes) => {
      if (error) {
        reject(error);
        return;
      }
      if (!q) {
        resolve({ quads: derelativizeQuads(quads, base), prefixes: toIriMap(prefixes) });
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

// ---------------------------------------------------------------------------
// IRI legality
// ---------------------------------------------------------------------------

/**
 * The characters Turtle forbids inside `<...>`, straight from the grammar:
 *
 *   IRIREF ::= '<' ([^#x00-#x20<>"{}|^`\] | UCHAR)* '>'
 *   — https://www.w3.org/TR/turtle/#grammar-production-IRIREF
 *
 * This is the W3C production, not a rule this project invented, and it is
 * deliberately narrower than "is this a well-formed IRI": a NamedNode is only
 * rejected when it cannot be SERIALIZED, so `/profile/card.ttl#me` (relative,
 * and load-bearing for pod attribution) and `https://ex.org/café#me`
 * (non-ASCII, legal in an IRI) both stay acceptable.
 */
const ILLEGAL_IRI_CHAR = /[\u0000-\u0020<>"{}|^`\\]/;

/** The first character of `iri` that Turtle cannot write, if any. */
export function findIllegalIriChar(iri: string): string | undefined {
  return ILLEGAL_IRI_CHAR.exec(iri)?.[0];
}

/** An IRI a caller asked to mint cannot be written as Turtle. */
export class UnwritableIriError extends Error {
  readonly iri: string;

  constructor(label: string, iri: string, offending: string) {
    const codePoint = `U+${(offending.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
    super(
      `Invalid IRI for ${label}: ${iri}\n` +
        `  It contains ${codePoint}, which Turtle forbids inside <...> ` +
        "(IRIREF ::= '<' ([^#x00-#x20<>\"{}|^`\\] | UCHAR)* '>').\n" +
        `  Writing it would produce a bucket file that cannot be parsed, and every later ` +
        `add-record, erase and import on that file would refuse. Nothing was written.`,
    );
    this.name = 'UnwritableIriError';
    this.iri = iri;
  }
}

/**
 * Refuse an IRI that cannot be serialized, BEFORE a term is minted from it.
 *
 * Late is not good enough. A NamedNode holding a space serializes to
 * `<https://ex.org/a b#me>`, which the next read cannot parse — and this
 * module's own contract is that an unreadable bucket is never overwritten. So
 * a single accepted typo takes the bucket out of service permanently, with no
 * CLI repair path. Validating the INPUT is what keeps that unreachable.
 *
 * @param label how the value reached us, e.g. `--by` or a property CURIE.
 * @throws {UnwritableIriError}
 */
export function assertWritableIri(iri: string, label: string): void {
  const offending = findIllegalIriChar(iri);
  if (offending !== undefined) throw new UnwritableIriError(label, iri, offending);
}

/** Walk one term, refusing any NamedNode (nested ones included) that cannot be written. */
function assertWritableTerm(term: RuntimeTerm, file: string): void {
  switch (term.termType) {
    case 'NamedNode':
      assertWritableIri(term.value, `a term of ${file}`);
      return;
    case 'Literal':
      if (term.datatype) assertWritableIri(term.datatype.value, `a literal datatype of ${file}`);
      return;
    case 'Quad':
      for (const t of [term.subject, term.predicate, term.object, term.graph]) {
        assertWritableTerm(t as RuntimeTerm, file);
      }
      return;
    default:
      return;
  }
}

/**
 * The backstop for {@link assertWritableIri}: no document leaves this module
 * unparseable, whatever the caller handed over.
 *
 * Commands validate their own inputs so the user gets an error naming the flag
 * they typed. This catches the writer that forgets to.
 */
function assertWritableQuads(quads: Quad[], file: string): void {
  for (const q of quads) {
    for (const t of [q.subject, q.predicate, q.object, q.graph]) {
      assertWritableTerm(t as RuntimeTerm, file);
    }
  }
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

  // One sentinel for the whole operation: the same string that the existing
  // document was parsed under is the one stripped off the merged result, so a
  // caller handing over quads from its OWN parse (the reconciler's path) is
  // covered by the same guarantee.
  let relBaseUsed = relBase();

  if (existedBefore) {
    // A read failure (bad DEK, unreadable bytes) propagates untouched: it is
    // not a parse error and it must not be reported as one.
    const existing = readResource(targetFile, dek);
    relBaseUsed = relBaseFor(existing);
    try {
      const parsed = await parseBucketTurtle(existing, relBaseUsed);
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

  const merged = derelativizeQuads(normalizeBlankNodes(combine(existingQuads, newQuads)), relBaseUsed);
  // Last gate before serialization. A term the strip did not reach must not be
  // discovered later, because by then it is absolute and permanent.
  assertNoSentinelLeak(merged);
  assertWritableQuads(merged, targetFile);
  const turtle = await serializeBucket(merged, prefixes);

  options.validate?.(turtle, targetFile);

  if (options.dryRun) {
    return { existedBefore, triplesBefore: existingQuads.length, triplesAfter: merged.length, turtle, written: false };
  }

  await fs.promises.mkdir(path.dirname(targetFile), { recursive: true });
  writeResource(targetFile, turtle, dek);
  return { existedBefore, triplesBefore: existingQuads.length, triplesAfter: merged.length, turtle, written: true };
}
