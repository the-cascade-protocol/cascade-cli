/**
 * VCF record parser → genomics:Variant emission.
 *
 * Stub at TASK-3A.1 — full implementation lands in TASK-3A.3.
 * The stub returns a single empty placeholder record per line so the
 * orchestrator + registry-entry compile end-to-end.
 *
 * TASK-3A.3 fills in:
 *   - per-ALT Variant emission with refAllele / altAllele / dbsnpRsId /
 *     clinvarVariationId / data-quality tier / FILTER + QUAL handling.
 *   - per-sample zygosity / AF / depth (from FORMAT columns).
 *   - prov:wasGeneratedBy → SequencingRun IRI.
 *
 * TASK-3A.4 fills in:
 *   - genomics:observedIn per-sample emission once the upstream vocabulary
 *     gains the predicate.
 */

import type { Quad } from 'n3';
import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import type { VcfHeader, VcfSourceProfile } from './types.js';

/**
 * One emitted record from the VCF importer. Matches the FHIR-genomics
 * importer's `ParsedRecord` shape (without `fhirResourceType` since VCF
 * isn't FHIR — but we keep the field nullable so the orchestrator stays
 * uniform).
 */
export interface ParsedRecord {
  iri: string;
  cascadeType: string;
  sourceId: string;
  /** Always undefined for VCF; preserved for orchestrator parity. */
  fhirResourceType?: string;
  quads: Quad[];
}

export interface RecordParseOutput {
  records: ParsedRecord[];
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

/**
 * Parse one VCF body line into 0+ Variant records. Stub returns no records
 * — TASK-3A.3 fills this in.
 */
export function parseRecordLine(
  _line: string,
  _header: VcfHeader,
  _sourceProfile: VcfSourceProfile,
  _sequencingRunIri: string,
  _ctx: ImportContext,
): RecordParseOutput | null {
  return { records: [], warnings: [], gaps: [] };
}
