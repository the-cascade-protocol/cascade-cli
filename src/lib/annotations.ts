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
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  isPodEncrypted,
  resolveDek,
  readResource,
  writeResource,
  PodDecryptError,
} from './pod-encryption.js';
import { obtainPassphrase } from './passphrase.js';
import { loadShapes, validateTurtle } from './shacl-validator.js';
import { fileExists } from '../commands/pod/helpers.js';

/** The pod-relative directory holding append-only overlay resources. */
export const ANNOTATIONS_DIR = 'annotations';

/** Shared Turtle prefix header for every overlay resource file. */
export const OVERLAY_PREFIXES = `@prefix workbench: <https://ns.cascadeprotocol.org/workbench/v1#> .
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

/**
 * Resolve the DEK for an encrypted pod, or `undefined` for a plaintext pod.
 * Throws a clean Error when the pod is encrypted but the passphrase is wrong
 * or unavailable.
 */
export async function resolvePodDek(podDir: string): Promise<Buffer | undefined> {
  if (!isPodEncrypted(podDir)) return undefined;
  try {
    const passphrase = await obtainPassphrase();
    return resolveDek(podDir, passphrase);
  } catch (e: unknown) {
    const msg =
      e instanceof PodDecryptError ? e.message : e instanceof Error ? e.message : String(e);
    throw new Error(`Cannot access encrypted pod: ${msg}`);
  }
}

/** Escape a value for use inside a Turtle "..." string literal. */
export function escapeTurtleString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** A single `predicate value` line within an overlay subject block. */
export interface OverlayLine {
  /** Predicate in CURIE form, e.g. 'workbench:amendsRecord'. */
  predicate: string;
  /** The object term, already serialized (IRI in <...> or "literal"^^type). */
  object: string;
}

/** A literal string object: `"escaped"`. */
export function strLit(value: string): string {
  return `"${escapeTurtleString(value)}"`;
}

/** A typed dateTime object: `"..."^^xsd:dateTime`. */
export function dateTimeLit(iso: string): string {
  return `"${escapeTurtleString(iso)}"^^xsd:dateTime`;
}

/** An IRI object: `<iri>`. */
export function iriRef(iri: string): string {
  return `<${iri}>`;
}

/**
 * Build the Turtle block for one overlay subject.
 *
 * @param subjectUri  the minted urn:uuid: of this overlay
 * @param rdfType     the workbench class CURIE, e.g. 'workbench:Amendment'
 * @param lines       the class-specific predicate/object lines
 * @param actorIri    optional prov:wasAttributedTo actor IRI
 * @param createdIso  dct:created timestamp (ISO 8601)
 */
export function buildOverlayBlock(
  subjectUri: string,
  rdfType: string,
  lines: OverlayLine[],
  actorIri: string | undefined,
  createdIso: string,
): string {
  const allLines: OverlayLine[] = [
    ...lines,
    { predicate: 'cascade:dataProvenance', object: 'cascade:SelfReported' },
  ];
  if (actorIri) {
    allLines.push({ predicate: 'prov:wasAttributedTo', object: iriRef(actorIri) });
  }
  allLines.push({ predicate: 'dct:created', object: dateTimeLit(createdIso) });

  const body = allLines.map((l) => `    ${l.predicate} ${l.object}`).join(' ;\n');
  return `<${subjectUri}> a ${rdfType} ;\n${body} .\n`;
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
 * Append an overlay resource to `<pod>/annotations/<fileName>` via the
 * read-merge-write pattern. The MERGED file content is SHACL-validated before
 * it is written; a malformed overlay throws and nothing is persisted.
 *
 * @throws {Error} if the merged overlay fails SHACL validation.
 */
export async function appendOverlay(
  podDir: string,
  spec: OverlaySpec,
  dek: Buffer | undefined,
): Promise<void> {
  const annotationsDir = path.join(podDir, ANNOTATIONS_DIR);
  const filePath = path.join(annotationsDir, spec.fileName);

  const block = buildOverlayBlock(
    spec.subjectUri,
    spec.rdfType,
    spec.lines,
    spec.actorIri,
    spec.createdIso,
  );

  // Read existing body (without re-applying the prefix header), if present.
  let existingBody = '';
  if (await fileExists(filePath)) {
    const existing = readResource(filePath, dek);
    // Strip the leading prefix header lines so we keep a single header.
    existingBody = stripPrefixHeader(existing);
  }

  const mergedBody = existingBody.trim().length > 0
    ? `${existingBody.trimEnd()}\n\n${block}`
    : block;
  const merged = `${OVERLAY_PREFIXES}\n${mergedBody}`;

  // Validate the merged graph BEFORE writing. A malformed overlay must fail.
  validateOverlayGraph(merged, filePath);

  await fs.mkdir(annotationsDir, { recursive: true });
  writeResource(filePath, merged, dek);
}

/**
 * Remove the leading `@prefix` / `@base` header lines from a Turtle document,
 * returning just the statement body. Lets us re-append a single shared header.
 */
function stripPrefixHeader(turtle: string): string {
  const lines = turtle.split('\n');
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('@prefix') || trimmed.startsWith('@base')) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join('\n');
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
