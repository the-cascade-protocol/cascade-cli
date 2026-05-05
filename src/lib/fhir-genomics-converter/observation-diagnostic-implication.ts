/**
 * Diagnostic-implication Observation parser (TASK-1.5 stub).
 *
 * Maps FHIR Genomics IG `diagnostic-implication`-profiled Observations
 * to `genomics:VariantInterpretation` records. Per D-Q5 (cardinality
 * 1..1 on `condition`), one Observation that references multiple
 * conditions emits one VariantInterpretation per condition.
 *
 * Currently a stub — populated in TASK-1.5.
 */

import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import type { ParsedRecord } from './types.js';

export interface DiagnosticImplicationParseOutput {
  records: ParsedRecord[];
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

export function parseDiagnosticImplication(
  _resource: any,
  _idIndex: Map<string, string>,
  _ctx: ImportContext,
): DiagnosticImplicationParseOutput | null {
  return null;
}
