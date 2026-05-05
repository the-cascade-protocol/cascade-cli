/**
 * ServiceRequest → GeneticTestOrder parser (TASK-1.7 stub).
 *
 * Maps a FHIR ServiceRequest to a `genomics:GeneticTestOrder` record,
 * linking it (when traceable) to a fulfilling GeneticTest via
 * `genomics:resultedIn`.
 *
 * Currently a stub — populated in TASK-1.7.
 */

import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import type { ParsedRecord } from './types.js';

export interface ServiceRequestParseOutput {
  record: ParsedRecord;
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

export function parseServiceRequest(
  _resource: any,
  _ctx: ImportContext,
): ServiceRequestParseOutput | null {
  return null;
}
