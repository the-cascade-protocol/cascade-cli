/**
 * VRS Allele → preserve-only Variant emission.
 *
 * Stub at TASK-3B.1 — full implementation lands in TASK-3B.2.
 *
 * TASK-3B.2 fills in:
 *   - hash validation: re-canonicalize the Allele payload (sort keys,
 *     drop `id`, JSON-serialize with no whitespace, SHA-512, truncate
 *     to 24 bytes, base64url-encode, prefix with "ga4gh:VA.") and
 *     reject if the declared `id` doesn't match.
 *   - emit genomics:Variant with vrsId + vrsObject literal blob.
 *   - never compute VRS from non-VRS input (refuse with clear error).
 */

import type { Quad } from 'n3';
import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';

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

export function ingestVrsAllele(_parsed: unknown, _ctx: ImportContext): IngestOutput {
  // Filled in at TASK-3B.2.
  return {
    warnings: [],
    gaps: [],
    error: 'VRS Allele ingestion not yet implemented (TASK-3B.2 pending).',
  };
}
