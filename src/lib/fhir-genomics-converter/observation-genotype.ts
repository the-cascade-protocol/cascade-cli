/**
 * Genotype Observation parser (TASK-1.4 stub).
 *
 * Maps FHIR Genomics IG `genotype`-profiled Observations to
 * `genomics:Diplotype` records, linking the two `genomics:Haplotype`
 * components via `genomics:hapA` / `genomics:hapB`.
 *
 * Currently a stub — populated in TASK-1.4.
 */

import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import type { ParsedRecord } from './types.js';

export interface GenotypeParseOutput {
  record: ParsedRecord;
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

export function parseGenotypeObservation(
  _resource: any,
  _idIndex: Map<string, string>,
  _ctx: ImportContext,
): GenotypeParseOutput | null {
  return null;
}
