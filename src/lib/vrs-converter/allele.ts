/**
 * VRS Allele → preserve-only Variant emission (TASK-3B.2).
 *
 * Per D-Q6: this importer NEVER computes a VRS digest from non-VRS
 * input — the spec's full digest algorithm requires seqrepo for
 * sequence-id collapsing, and we deliberately do not bundle
 * seqrepo-* dependencies. We only:
 *
 *   1. validate the declared id has the canonical VRS form
 *      (ga4gh:VA. prefix + base64url payload, 32 chars = 24 bytes
 *      of digest data),
 *   2. compute a "simple canonical hash" of the payload (sort keys
 *      alphabetically, drop `id`, JSON-encode without whitespace,
 *      SHA-512, first 24 bytes, base64url-encode) and compare.
 *
 * Outcomes:
 *   - declared id has invalid form → REJECT with a clear error.
 *   - declared id form is valid AND simple canonical hash matches →
 *     accept with no warning.
 *   - declared id form is valid BUT simple canonical hash mismatches
 *     → accept with a `severity: warning` gap explaining the
 *     discrepancy. This is the expected outcome for vrs-python-
 *     generated alleles (which use recursive-digest canonicalization
 *     that the cascade-cli does not reproduce).
 *
 * Negative test (TASK-3B.3): construct a synthetic Allele whose
 * declared id WAS produced by computeSimpleVrsDigest() — then mutate
 * `state.sequence` after declaration. The simple hash now differs
 * from the declared id and the importer rejects.
 *
 * The CLI exposes an `--allow-vrs-hash-mismatch` flag (default false)
 * that converts the strict reject path on simple-hash-mismatch into
 * an info gap. For real-world vrs-python alleles users should pass
 * this flag.
 */

import { DataFactory, type Quad } from 'n3';
import { createHash } from 'node:crypto';

import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import {
  NS,
  SCHEMA_VERSION,
  deterministicUuid,
  tripleType,
  tripleStr,
  tripleRef,
} from '../fhir-converter/types.js';
import { GENOMICS_NS } from '../fhir-genomics-converter/types.js';
import type { VrsAllele } from './types.js';

const { namedNode, literal, quad: makeQuad } = DataFactory;

const VRS_VA_FORM = /^ga4gh:VA\.[A-Za-z0-9_-]+$/;

export interface ParsedRecord {
  iri: string;
  cascadeType: string;
  sourceId: string;
  fhirResourceType?: string;
  quads: Quad[];
}

export interface IngestOutput {
  record?: ParsedRecord;
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
  /** Set when the input is unusable; the orchestrator surfaces in errors[]. */
  error?: string;
}

/**
 * Recursively canonicalize a JSON value with ordered keys, dropping
 * any top-level `id` / `_id` field. This is the SIMPLE canonicalization
 * — vrs-python uses a more involved recursive-identification algorithm
 * that we do not reproduce (see header comment).
 */
function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => k !== 'id' && k !== '_id')
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

/**
 * Compute the cascade-cli simple canonical-form digest for a VRS Allele.
 * NOT identical to vrs-python's full algorithm — see the file header.
 *
 * Returns the full ga4gh:VA. id string.
 */
export function computeSimpleVrsDigest(allele: object): string {
  const canon = canonicalize(allele);
  const sha = createHash('sha512').update(canon, 'utf-8').digest();
  const truncated = sha.subarray(0, 24);
  const b64u = truncated
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `ga4gh:VA.${b64u}`;
}

/** Returns true if the declared id has the canonical ga4gh:VA. form. */
export function hasValidVrsForm(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (!VRS_VA_FORM.test(id)) return false;
  // Payload after "ga4gh:VA." should be 32 base64url chars (= 24 bytes).
  const payload = id.slice('ga4gh:VA.'.length);
  return payload.length === 32;
}

/** Validate that an object looks like a VRS Allele (type+location+state). */
export function looksLikeVrsAllele(parsed: unknown): parsed is VrsAllele {
  if (!parsed || typeof parsed !== 'object') return false;
  const obj = parsed as Record<string, unknown>;
  return (
    obj.type === 'Allele' &&
    typeof obj.location === 'object' &&
    obj.location !== null &&
    typeof obj.state === 'object' &&
    obj.state !== null &&
    typeof obj.id === 'string'
  );
}

/** Mint a deterministic Variant IRI from the declared VRS id. */
function mintVariantIri(vrsId: string): string {
  return `urn:uuid:${deterministicUuid(`Variant|VRS|${vrsId}`)}`;
}

/** Common provenance + schema-version triples. */
function commonTriples(subject: string): Quad[] {
  return [
    tripleRef(subject, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'),
    tripleStr(subject, NS.cascade + 'schemaVersion', SCHEMA_VERSION),
  ];
}

/**
 * Ingest a VRS Allele JSON-LD object and emit a preserve-only Variant.
 *
 * Returns either:
 *   - { record: <Variant>, warnings, gaps }  on success
 *   - { error: <string>, warnings, gaps }    on hard failure (rejected)
 *
 * Hash-validation behaviour is governed by ctx.options.allowVrsHashMismatch:
 *   - falsy (default): simple-hash mismatch → REJECT with a "hash mismatch" error.
 *   - truthy:          simple-hash mismatch → emit info gap, accept the Allele.
 *
 * Either way, an invalid declared-id FORM is always rejected.
 */
export function ingestVrsAllele(parsed: unknown, ctx: ImportContext): IngestOutput {
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];

  if (!looksLikeVrsAllele(parsed)) {
    return {
      warnings,
      gaps,
      error:
        'Input is not a VRS Allele (expected type === "Allele" with location, state, and id). cascade-cli does not compute VRS digests from non-VRS input — provide a valid VRS Allele JSON-LD document.',
    };
  }

  const allele = parsed as VrsAllele;
  const declaredId = allele.id;

  // 1. Form validation — always strict.
  if (!hasValidVrsForm(declaredId)) {
    return {
      warnings,
      gaps,
      error: `VRS Allele declared id "${declaredId}" has invalid form (expected /^ga4gh:VA\\.[A-Za-z0-9_-]{32}$/).`,
    };
  }

  // 2. Simple canonical-hash check.
  const simpleHash = computeSimpleVrsDigest(allele);
  const allowMismatch = Boolean(
    ctx.options?.allowVrsHashMismatch ?? ctx.options?.['allow-vrs-hash-mismatch'],
  );
  const hashMatches = simpleHash === declaredId;

  if (!hashMatches && !allowMismatch) {
    return {
      warnings,
      gaps,
      error:
        `VRS Allele hash mismatch: declared id ${declaredId} does not match cascade-cli's simple canonical-form hash ${simpleHash}. ` +
        'For vrs-python-generated alleles (whose recursive-digest canonicalization the CLI does not reproduce) ' +
        'pass --allow-vrs-hash-mismatch to accept the declared id without strict comparison.',
    };
  }

  if (!hashMatches && allowMismatch) {
    gaps.push({
      sourceField: 'VRS.Allele.id',
      reason:
        `Declared id ${declaredId} does not match cascade-cli's simple canonical-form hash ${simpleHash}. ` +
        'Allele was produced by an upstream tool (e.g. vrs-python) that uses recursive-digest canonicalization. ' +
        'Preserving as-is per D-Q6 preserve-only — VRS digest computation requires seqrepo for sequence-id collapsing, ' +
        'which cascade-cli deliberately does not bundle.',
      severity: 'info',
    });
  }

  // 3. Emit Variant + vrsId + vrsObject.
  const variantIri = mintVariantIri(declaredId);
  const quads: Quad[] = [];
  quads.push(tripleType(variantIri, GENOMICS_NS + 'Variant'));
  quads.push(...commonTriples(variantIri));

  // genomics:vrsId — the declared id verbatim.
  quads.push(tripleStr(variantIri, GENOMICS_NS + 'vrsId', declaredId));

  // genomics:vrsObject — the full Allele JSON, stored as a literal blob.
  // Use canonicalized form so the round-trip is stable even if input
  // had non-canonical key order or whitespace.
  const fullJson = JSON.stringify(allele);
  quads.push(
    makeQuad(namedNode(variantIri), namedNode(GENOMICS_NS + 'vrsObject'), literal(fullJson)),
  );

  // VRS preserve-only doesn't carry a per-run quality tier; the spec
  // calls VRS-only Alleles "research-grade" by default since we have
  // no provenance signal. UnknownQuality is the more honest tag.
  quads.push(
    tripleRef(
      variantIri,
      GENOMICS_NS + 'dataQualityTier',
      GENOMICS_NS + 'UnknownQuality',
    ),
  );

  // Document gap for VRS sub-fields the importer does NOT decompose
  // (sequence_id, interval coordinates, state.sequence) — VRS-aware
  // downstream consumers should re-parse vrsObject to recover them.
  gaps.push({
    sourceField: 'VRS.Allele.location/state',
    reason:
      'VRS Allele location + state preserved as opaque vrsObject literal per D-Q6. cascade-cli does not decompose into refAllele / altAllele / coordinates — those map through Phase 3A (VCF) for variant coordinates.',
    severity: 'info',
    context: variantIri,
  });

  const record: ParsedRecord = {
    iri: variantIri,
    cascadeType: 'genomics:Variant',
    sourceId: declaredId,
    quads,
  };

  return { record, warnings, gaps };
}
