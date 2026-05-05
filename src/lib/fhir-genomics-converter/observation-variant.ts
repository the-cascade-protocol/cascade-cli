/**
 * Variant Observation parser (TASK-1.2 stub).
 *
 * Parses a FHIR Observation conforming to the FHIR Genomics IG `variant`
 * profile into a `genomics:Variant` record.
 *
 * Currently a stub — populated in TASK-1.2.
 */

import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import type { ParsedRecord } from './types.js';

export interface VariantParseOutput {
  record: ParsedRecord;
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

export function parseVariantObservation(
  _resource: any,
  _ctx: ImportContext,
): VariantParseOutput | null {
  return null;
}
