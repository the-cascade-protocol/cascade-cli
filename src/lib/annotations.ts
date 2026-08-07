/**
 * Append-only record-amendment overlays (workbench: vocabulary).
 *
 * Original Pod records are immutable. Every edit/delete is a NEW overlay
 * resource written to `<pod>/annotations/<kind>.ttl`:
 *
 *   - workbench:Amendment   overrides one property value on a record
 *   - workbench:Annotation  adds a note / extra attribute (no override)
 *   - workbench:Retraction  soft-deletes / supersedes a record
 *   - workbench:Tombstone   hard-erase audit marker (bytes gone, fact kept)
 *
 * Overlays carry cascade:dataProvenance cascade:SelfReported, an optional
 * prov:wasAttributedTo actor, and a dct:created timestamp. All resource I/O
 * routes through the pod-encryption chokepoint so overlays are ciphertext on
 * disk when the pod is encrypted. A malformed overlay fails before it is
 * written: the merged annotations file is SHACL-validated first.
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DataFactory } from 'n3';
import type { Quad, Quad_Object } from 'n3';
import { openPod } from './pod-read.js';
import { loadShapes, validateTurtle } from './shacl-validator.js';
import { mergeIntoBucket, KNOWN_PREFIXES } from './bucket-write.js';

const { namedNode, literal, quad: makeQuad } = DataFactory;

/** The pod-relative directory holding append-only overlay resources. */
export const ANNOTATIONS_DIR = 'annotations';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * CURIE prefixes an overlay may name. Expansion happens HERE, at build time,
 * so no overlay predicate reaches disk as text: a prefix this map does not know
 * is a loud throw rather than an unparseable `annotations/*.ttl`.
 */
const OVERLAY_NS: Record<string, string> = {
  workbench: KNOWN_PREFIXES.workbench,
  cascade: KNOWN_PREFIXES.cascade,
  prov: KNOWN_PREFIXES.prov,
  dct: KNOWN_PREFIXES.dct,
  xsd: KNOWN_PREFIXES.xsd,
};

/** Expand an overlay CURIE to its full IRI. @throws on an unknown prefix. */
function expandOverlayCurie(curie: string): string {
  const idx = curie.indexOf(':');
  const ns = idx > 0 ? OVERLAY_NS[curie.slice(0, idx)] : undefined;
  if (!ns) {
    throw new Error(
      `Unknown overlay CURIE prefix in "${curie}". Overlay terms must use one of: ` +
        `${Object.keys(OVERLAY_NS).join(', ')}.`,
    );
  }
  return ns + curie.slice(idx + 1);
}

/**
 * Resolve the DEK for an encrypted pod, or `undefined` for a plaintext pod.
 *
 * Delegates to the read layer's {@link openPod} rather than resolving a key of
 * its own: one place decides how a passphrase is obtained and what a failure to
 * obtain it means, so the overlay writers cannot drift from the read verbs.
 *
 * @throws {PodUnreadableError} when the pod is encrypted and unopenable.
 */
export async function resolvePodDek(podDir: string): Promise<Buffer | undefined> {
  return (await openPod(podDir)).dek;
}

/** A single `predicate value` statement within an overlay subject block. */
export interface OverlayLine {
  /** Predicate in CURIE form, e.g. 'workbench:amendsRecord'. */
  predicate: string;
  /** The object term. Build it with {@link strLit} / {@link iriRef} / {@link dateTimeLit}. */
  object: Quad_Object;
}

/** A plain string literal object. */
export function strLit(value: string): Quad_Object {
  return literal(value);
}

/** An `xsd:dateTime` literal object. */
export function dateTimeLit(iso: string): Quad_Object {
  return literal(iso, namedNode(KNOWN_PREFIXES.xsd + 'dateTime'));
}

/** An IRI object. */
export function iriRef(iri: string): Quad_Object {
  return namedNode(iri);
}

/**
 * Build the quads for one overlay subject.
 *
 * @param subjectUri  the minted urn:uuid: of this overlay
 * @param rdfType     the workbench class CURIE, e.g. 'workbench:Amendment'
 * @param lines       the class-specific predicate/object statements
 * @param actorIri    optional prov:wasAttributedTo actor IRI
 * @param createdIso  dct:created timestamp (ISO 8601)
 */
export function buildOverlayQuads(
  subjectUri: string,
  rdfType: string,
  lines: OverlayLine[],
  actorIri: string | undefined,
  createdIso: string,
): Quad[] {
  const subject = namedNode(subjectUri);
  const allLines: OverlayLine[] = [
    { predicate: 'cascade:dataProvenance', object: namedNode(KNOWN_PREFIXES.cascade + 'SelfReported') },
  ];
  if (actorIri) {
    allLines.push({ predicate: 'prov:wasAttributedTo', object: iriRef(actorIri) });
  }
  allLines.push({ predicate: 'dct:created', object: dateTimeLit(createdIso) });

  return [
    makeQuad(subject, namedNode(RDF_TYPE), namedNode(expandOverlayCurie(rdfType))),
    ...lines.map((l) => makeQuad(subject, namedNode(expandOverlayCurie(l.predicate)), l.object)),
    ...allLines.map((l) => makeQuad(subject, namedNode(expandOverlayCurie(l.predicate)), l.object)),
  ];
}

/** Description of one overlay to be written. */
export interface OverlaySpec {
  /** File name under annotations/, e.g. 'amendments.ttl'. */
  fileName: string;
  /** The minted urn:uuid: subject of the overlay. */
  subjectUri: string;
  /** rdf:type CURIE, e.g. 'workbench:Amendment'. */
  rdfType: string;
  /** Class-specific predicate/object lines. */
  lines: OverlayLine[];
  /** Optional actor IRI for prov:wasAttributedTo. */
  actorIri?: string;
  /** ISO timestamp for dct:created. */
  createdIso: string;
}

/**
 * Append an overlay resource to `<pod>/annotations/<fileName>` through the
 * bucket chokepoint. The MERGED document is SHACL-validated before it is
 * written; a malformed overlay throws and nothing is persisted.
 *
 * @throws {Error}            if the merged overlay fails SHACL validation.
 * @throws {BucketParseError} if the existing overlay file does not parse.
 */
export async function appendOverlay(
  podDir: string,
  spec: OverlaySpec,
  dek: Buffer | undefined,
): Promise<void> {
  const filePath = path.join(podDir, ANNOTATIONS_DIR, spec.fileName);

  const newQuads = buildOverlayQuads(
    spec.subjectUri,
    spec.rdfType,
    spec.lines,
    spec.actorIri,
    spec.createdIso,
  );

  await mergeIntoBucket(filePath, newQuads, dek, {
    // Validate the merged graph BEFORE writing. A malformed overlay must fail.
    validate: (turtle, file) => validateOverlayGraph(turtle, file),
  });
}

let cachedShapes: ReturnType<typeof loadShapes> | undefined;

/**
 * SHACL-validate an overlay Turtle string against the bundled shapes.
 * @throws {Error} listing the violations when the overlay does not conform.
 */
export function validateOverlayGraph(turtle: string, filePath: string): void {
  if (!cachedShapes) {
    cachedShapes = loadShapes();
  }
  const { store, shapeFiles } = cachedShapes;
  const result = validateTurtle(turtle, store, shapeFiles, filePath);
  if (!result.valid) {
    const violations = result.results.filter((r) => r.severity === 'violation');
    if (violations.length > 0) {
      const detail = violations
        .map((v) => `${v.property || v.shape}: ${v.message}`)
        .join('; ');
      throw new Error(`Overlay failed SHACL validation: ${detail}`);
    }
  }
}

/** Mint a fresh urn:uuid: resource URI. */
export function mintUri(): string {
  return `urn:uuid:${randomUUID()}`;
}
