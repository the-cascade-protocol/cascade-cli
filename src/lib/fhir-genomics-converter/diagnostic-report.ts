/**
 * DiagnosticReport → GeneticTest parser (TASK-1.6 stub).
 *
 * Maps a FHIR DiagnosticReport carrying the `genomic-report` profile to
 * a `genomics:GeneticTest` record, linking results, gene panel scope,
 * test type, and ordering / performing context.
 *
 * Currently a stub — populated in TASK-1.6.
 */

import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import type { ParsedRecord } from './types.js';

export interface DiagnosticReportParseOutput {
  record: ParsedRecord;
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

export function parseDiagnosticReport(
  _resource: any,
  _idIndex: Map<string, string>,
  _ctx: ImportContext,
): DiagnosticReportParseOutput | null {
  return null;
}
