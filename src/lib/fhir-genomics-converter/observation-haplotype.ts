/**
 * Haplotype Observation parser (TASK-1.3 stub).
 *
 * Maps FHIR Genomics IG `haplotype`-profiled Observations to
 * `genomics:Haplotype` records, linking constituent Variants via
 * `genomics:hasComponent`.
 *
 * Currently a stub — populated in TASK-1.3.
 */

import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import type { ParsedRecord } from './types.js';

export interface HaplotypeParseOutput {
  record: ParsedRecord;
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

export function parseHaplotypeObservation(
  _resource: any,
  _idIndex: Map<string, string>,
  _ctx: ImportContext,
): HaplotypeParseOutput | null {
  return null;
}
