/**
 * The pod's one identifier: `cascade:podIdentifier` (core v3.11).
 *
 * WHAT IT IS
 * ----------
 * A random version 4 UUID in `urn:uuid:` form, lowercase, typed `xsd:anyURI`,
 * on `<#me>` in the owner-only `profile/extended.ttl`. Exactly one per pod.
 * It is the naming subject for every naming rule that includes a pod subject,
 * so two pods never mint the same name for the same watch, day or summary.
 *
 * MINTED ONCE, READ BACK, NEVER RECOMPUTED
 * ----------------------------------------
 * `pod init` mints it. A pod created before this existed gets one the first
 * time a command needs it, through {@link ensurePodIdentifier}, which WRITES it
 * before returning, so nothing is ever named from a value that is not on disk.
 * Nothing derives it: the value a caller receives is the value read back from
 * the file after the write. "Stable for the life of the pod" therefore holds by
 * construction, not by keeping a derivation's inputs stable.
 *
 * WHY IT IS RANDOM, AND WHY THAT IS NOT AN IDENTITY DEFECT
 * -------------------------------------------------------
 * Record identity in this repository is never random: re-importing one source
 * record must name it the same way on every machine (`src/lib/identity.ts`).
 * This value identifies something else, the pod's CREATION, which is an event.
 * Two pods rebuilt from the same exports are two pods, and are meant to name
 * their records differently. So the randomness lives here, outside the
 * identity-minting modules, and is declared as an event identity in
 * `tests/identity-chokepoint.test.ts`. Record names are then derived
 * deterministically FROM it.
 *
 * WHERE IT MAY APPEAR
 * -------------------
 * Only in `profile/extended.ttl`. Never in `profile/card.ttl` (the one profile
 * document a pod may serve to unauthenticated readers), never in an export.
 * This module is the only writer. A whole-pod copy (`pod export`, a backup)
 * carries `extended.ttl` as it is, which is what lets a restore keep every name.
 *
 * WRITING
 * -------
 * `extended.ttl` is human-curated scaffolding whose comments are load-bearing,
 * so it is never re-serialized. The identifier is APPENDED as a statement of its
 * own, written with full IRIs so it parses whatever prefixes the file declares,
 * and the whole file is replaced atomically. Every existing byte is kept.
 */

import { randomUUID } from 'node:crypto';
import { Parser } from 'n3';
import type { Quad } from 'n3';
import { decryptResource, encryptResource } from './pod-encryption.js';
import { atomicWritePodFile, mkdirInPod, podPathExists, readPodFile } from './pod-path.js';

/** The predicate, as a full IRI. */
export const POD_IDENTIFIER_IRI = 'https://ns.cascadeprotocol.org/core/v1#podIdentifier';

/** Where the identifier lives, pod-relative. */
export const EXTENDED_PROFILE_PATH = 'profile/extended.ttl';

/** The public profile, which must never carry it. */
export const CARD_PATH = 'profile/card.ttl';

const XSD_ANY_URI = 'http://www.w3.org/2001/XMLSchema#anyURI';
const RDFS_SEE_ALSO = 'http://www.w3.org/2000/01/rdf-schema#seeAlso';

/**
 * The form `cascade:PodIdentifierShape` checks: lowercase, version 4, RFC 9562
 * variant, `urn:uuid:` prefix. Mirrors the shape's `sh:pattern` exactly.
 */
export const POD_IDENTIFIER_FORM =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A fixed base that is never dereferenced, so `<#me>` in each profile document
 * resolves the same way on every machine and for every pod location.
 */
const BASE = 'https://pod.invalid/';
const EXTENDED_ME = `${BASE}${EXTENDED_PROFILE_PATH}#me`;
const CARD_ME = `${BASE}${CARD_PATH}#me`;

/** What `profile/extended.ttl` says about the identifier. Values are never echoed into messages. */
export type PodIdentifierState =
  | { status: 'present'; value: string }
  /** No identifier. `file` says whether `profile/extended.ttl` exists at all. */
  | { status: 'absent'; file: 'missing' | 'present' }
  /** More than one value: the pod would have two naming subjects. */
  | { status: 'duplicate'; count: number }
  /** One value, but not the form the shape requires, or not on `<#me>`. */
  | { status: 'malformed'; reason: string }
  /** `profile/extended.ttl` does not parse, so nothing can be said or appended. */
  | { status: 'unparseable'; reason: string };

/** Why {@link ensurePodIdentifier} refused. Stable, machine-readable. */
export type PodIdentifierRefusal = 'duplicate' | 'malformed' | 'unparseable' | 'not-written';

/** The pod's identifier could not be established. Nothing may be named from this pod until it is. */
export class PodIdentifierError extends Error {
  readonly reason: PodIdentifierRefusal;
  constructor(reason: PodIdentifierRefusal, message: string) {
    super(message);
    this.name = 'PodIdentifierError';
    this.reason = reason;
  }
}

/** The identifier as it is on disk, and whether this call is the one that wrote it. */
export interface PodIdentifier {
  value: string;
  minted: boolean;
}

function parse(text: string, docPath: string): Quad[] {
  return new Parser({ format: 'Turtle', baseIRI: `${BASE}${docPath}` }).parse(text);
}

function readText(podDir: string, rel: string, dek?: Buffer): string {
  const blob = readPodFile(podDir, rel);
  return dek ? decryptResource(blob, dek) : blob.toString('utf-8');
}

/** Judge the identifier statements in an already-read `extended.ttl`. */
export function podIdentifierStateOfText(text: string): PodIdentifierState {
  let quads: Quad[];
  try {
    quads = parse(text, EXTENDED_PROFILE_PATH);
  } catch (e: unknown) {
    return { status: 'unparseable', reason: e instanceof Error ? e.message : String(e) };
  }
  // The parser reports every statement; RDF is a set, so an identical
  // statement written twice is one triple, not two values.
  const statements = new Map<string, Quad>();
  for (const q of quads) {
    if (q.predicate.value !== POD_IDENTIFIER_IRI) continue;
    const o = q.object;
    const dt = o.termType === 'Literal' ? o.datatype.value : '';
    statements.set(`${q.subject.value}\u0000${o.termType}\u0000${o.value}\u0000${dt}`, q);
  }
  if (statements.size === 0) return { status: 'absent', file: 'present' };
  if (statements.size > 1) return { status: 'duplicate', count: statements.size };

  const [only] = statements.values();
  if (only.subject.value !== EXTENDED_ME) {
    return { status: 'malformed', reason: 'it is not stated on <#me> in profile/extended.ttl' };
  }
  const o = only.object;
  if (o.termType !== 'Literal' || o.datatype.value !== XSD_ANY_URI) {
    return { status: 'malformed', reason: 'it is not a literal typed xsd:anyURI' };
  }
  if (!POD_IDENTIFIER_FORM.test(o.value)) {
    return { status: 'malformed', reason: 'it is not a lowercase version 4 UUID in urn:uuid form' };
  }
  return { status: 'present', value: o.value };
}

/**
 * Read the pod's identifier without writing anything.
 *
 * @throws {PodDecryptError} when the file does not open under `dek`.
 * @throws {PodPathError} when the path is refused.
 */
export function readPodIdentifier(podDir: string, dek?: Buffer): PodIdentifierState {
  if (!podPathExists(podDir, EXTENDED_PROFILE_PATH)) return { status: 'absent', file: 'missing' };
  return podIdentifierStateOfText(readText(podDir, EXTENDED_PROFILE_PATH, dek));
}

/**
 * Does `profile/card.ttl` state a `cascade:podIdentifier`? It never should: the
 * card is the one profile document a pod may serve publicly. Unreadable or
 * unparseable cards answer false; other checks report those.
 */
export function cardCarriesPodIdentifier(podDir: string, dek?: Buffer): boolean {
  if (!podPathExists(podDir, CARD_PATH)) return false;
  try {
    return parse(readText(podDir, CARD_PATH, dek), CARD_PATH).some((q) => q.predicate.value === POD_IDENTIFIER_IRI);
  } catch {
    return false;
  }
}

/** The file written when a pod has no `profile/extended.ttl` at all. */
const MINIMAL_EXTENDED_PROFILE = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

# =============================================================================
# Extended Profile  (private, owner-only)
# =============================================================================
# This document holds PHI and the pod's identifier. It must NOT be publicly
# accessible. Linked from profile/card.ttl via rdfs:seeAlso.
# =============================================================================
`;

function identifierBlock(value: string): string {
  return (
    `\n# The pod's identifier (cascade:podIdentifier). Minted once and never changed.\n` +
    `# Record names are derived from it. Never copy it to card.ttl or into an export.\n` +
    `<#me> <${POD_IDENTIFIER_IRI}> "${value}"^^<${XSD_ANY_URI}> .\n`
  );
}

/**
 * Write a profile document atomically, sealed when the pod is. `ownerOnly`
 * creates the replacement file readable by its owner alone (the process umask
 * can only narrow that further).
 */
function writeProfileDocument(podDir: string, rel: string, text: string, dek: Buffer | undefined, ownerOnly: boolean): void {
  const bytes = dek ? encryptResource(text, dek) : Buffer.from(text, 'utf-8');
  atomicWritePodFile(podDir, rel, bytes, ownerOnly ? { mode: 0o600 } : {});
}

/**
 * Link `card.ttl` to `extended.ttl` (pod-structure 3.2) when the card exists,
 * parses, and does not already. Appended, so the card's comments survive.
 */
function ensureCardLinksExtended(podDir: string, dek?: Buffer): void {
  if (!podPathExists(podDir, CARD_PATH)) return;
  const card = readText(podDir, CARD_PATH, dek);
  let quads: Quad[];
  try {
    quads = parse(card, CARD_PATH);
  } catch {
    return; // An unparseable card is not this function's to touch; `pod doctor` reports it.
  }
  const target = `${BASE}${EXTENDED_PROFILE_PATH}`;
  if (quads.some((q) => q.subject.value === CARD_ME && q.predicate.value === RDFS_SEE_ALSO && q.object.value === target)) {
    return;
  }
  const sep = card === '' || card.endsWith('\n') ? '' : '\n';
  const link = `${sep}\n# The owner-only extended profile (pod-structure 3.2).\n<#me> <${RDFS_SEE_ALSO}> </${EXTENDED_PROFILE_PATH}> .\n`;
  writeProfileDocument(podDir, CARD_PATH, card + link, dek, false);
}

/**
 * The pod's identifier: read it, or mint it and write it first.
 *
 * Call this BEFORE computing any name from the pod subject. When the pod has no
 * identifier yet, one is minted, appended to `profile/extended.ttl` (created
 * when missing, with the `rdfs:seeAlso` link from `card.ttl`), written
 * atomically, and read back; the value returned is always the one on disk.
 * A second call returns the same value and writes nothing.
 *
 * @throws {PodIdentifierError} when the file holds two values, a malformed one,
 *   does not parse, or the write did not read back.
 * @throws {PodDecryptError} when the file does not open under `dek`.
 * @throws {PodPathError} when the path is refused.
 */
export function ensurePodIdentifier(podDir: string, dek?: Buffer): PodIdentifier {
  const state = readPodIdentifier(podDir, dek);
  switch (state.status) {
    case 'present':
      return { value: state.value, minted: false };
    case 'duplicate':
      throw new PodIdentifierError(
        'duplicate',
        `${EXTENDED_PROFILE_PATH} states ${state.count} values of cascade:podIdentifier. A pod has exactly one; ` +
          `with two, the same record could be named two ways. Keep the one this pod's records were named from ` +
          `and remove the others by hand. Nothing was written.`,
      );
    case 'malformed':
      throw new PodIdentifierError(
        'malformed',
        `The cascade:podIdentifier in ${EXTENDED_PROFILE_PATH} is not usable: ${state.reason}. ` +
          `It is never rewritten automatically, because records may already be named from it. Nothing was written.`,
      );
    case 'unparseable':
      throw new PodIdentifierError(
        'unparseable',
        `${EXTENDED_PROFILE_PATH} does not parse as Turtle, so the pod's identifier cannot be read or added. ` +
          `Run \`cascade pod doctor\` on the pod. Nothing was written.`,
      );
    case 'absent':
      break;
  }

  const minted = `urn:uuid:${randomUUID()}`;
  const existing =
    state.file === 'present' ? readText(podDir, EXTENDED_PROFILE_PATH, dek) : MINIMAL_EXTENDED_PROFILE;
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  const next = existing + sep + identifierBlock(minted);

  // Prove the new text says exactly this before a byte is written.
  const planned = podIdentifierStateOfText(next);
  if (planned.status !== 'present' || planned.value !== minted) {
    throw new PodIdentifierError(
      'not-written',
      `Adding the pod's identifier to ${EXTENDED_PROFILE_PATH} would not read back as one well-formed value ` +
        `(the file may rebind <#me> or declare a base). Nothing was written.`,
    );
  }

  if (state.file === 'missing') mkdirInPod(podDir, 'profile');
  writeProfileDocument(podDir, EXTENDED_PROFILE_PATH, next, dek, true);
  ensureCardLinksExtended(podDir, dek);

  const onDisk = readPodIdentifier(podDir, dek);
  if (onDisk.status !== 'present') {
    throw new PodIdentifierError(
      'not-written',
      `The pod's identifier was written to ${EXTENDED_PROFILE_PATH} and did not read back as one well-formed value.`,
    );
  }
  // Another writer may have won the rename; what is on disk is the identifier.
  return { value: onDisk.value, minted: onDisk.value === minted };
}
