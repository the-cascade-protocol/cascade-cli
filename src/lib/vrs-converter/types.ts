/**
 * Internal types and namespace constants for the VRS → Cascade importer.
 *
 * Per D-Q6: this importer is PRESERVE-ONLY. It ingests a GA4GH VRS Allele
 * JSON-LD object, writes the deterministic `id` (vrsId hash) onto a
 * matching genomics:Variant, and stores the full Allele payload as a
 * literal blob (genomics:vrsObject). It does NOT compute VRS digests
 * from non-VRS input — refusing rather than falsely fabricating a hash
 * is the correct behaviour given that VRS digest computation requires
 * a sequence-repository (seqrepo) and we deliberately do not bundle
 * seqrepo-* dependencies.
 *
 * Hash-validation step: re-canonicalize the Allele (sort keys, drop
 * `id`, JSON-serialize, SHA-512, truncate to 24 bytes, base64url-encode
 * with `ga4gh:VA.` prefix) and confirm the declared `id` matches.
 */

import type { Quad } from 'n3';
import { NS } from '../fhir-converter/types.js';
import { GENOMICS_NS } from '../fhir-genomics-converter/types.js';

export { GENOMICS_NS };

/**
 * Re-export the core NS constants alongside genomics: so consumers in this
 * module only need to import from one place.
 */
export const NS_ALL = {
  ...NS,
  genomics: GENOMICS_NS,
} as const;

/**
 * Minimum-shape VRS Allele. The 1.x schema has additional optional
 * fields (extensions, label, description) which the importer preserves
 * via the full vrsObject blob — this interface only describes what
 * detect() and the hash-validator need to read explicitly.
 */
export interface VrsAllele {
  type: 'Allele';
  id: string;
  location: VrsSequenceLocation | unknown;
  state: VrsSequenceExpression | unknown;
  /** Other optional fields are preserved via the full Allele blob. */
  [key: string]: unknown;
}

export interface VrsSequenceLocation {
  type: 'SequenceLocation';
  sequence_id: string;
  interval?: VrsSequenceInterval;
  start?: { type: 'Number'; value: number };
  end?: { type: 'Number'; value: number };
}

export interface VrsSequenceInterval {
  type: 'SequenceInterval';
  start: { type: 'Number'; value: number };
  end: { type: 'Number'; value: number };
}

export interface VrsSequenceExpression {
  type: 'LiteralSequenceExpression' | 'ReferenceSequenceExpression' | string;
  sequence?: string;
  [key: string]: unknown;
}

/** Re-export the n3 Quad type for the writer. */
export type { Quad };
