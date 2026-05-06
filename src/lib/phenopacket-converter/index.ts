/**
 * Public surface for the GA4GH Phenopacket → Cascade converter.
 *
 * `convertPhenopacket()` is the orchestrator. It detects the top-level shape
 * (single phenopacket vs family vs cohort), dispatches each resource through
 * the per-section parsers, and returns the merged quad stream + per-record
 * metadata.
 *
 * Stub at TASK-2B.1: orchestrator returns an empty result for any
 * recognized phenopacket shape — just enough to wire detection +
 * registry-dispatch end to end. Subsequent tasks fill in:
 *
 *   TASK-2B.2  — subject.ts             (subject → cascade:PatientProfile)
 *   TASK-2B.3  — phenotypic-features.ts (HPO terms on the patient)
 *   TASK-2B.4  — interpretations.ts     (genomics:VariantInterpretation)
 *   TASK-2B.5  — variation-descriptor.ts (genomics:Variant + CNV)
 *   TASK-2B.6  — pedigree.ts            (genomics:Pedigree, family resource)
 *   TASK-2B.7  — biosamples.ts          (fhir:Specimen + RawFile)
 *   TASK-2B.8  — medical-actions.ts     (checkup:recommendedActions text)
 *
 * D-Q5: multi-condition cardinality — one VariantInterpretation per
 *       (variant, condition) pair.
 * D-Q6: VRS hashes preserved only — never computed.
 * D-DIRECTORY: biosample/file refs that look like FASTQ/BAM/VCF emit
 *              genomics:RawFile pointer-and-hash records.
 * D-QUALITY-TIER: phenopackets are research-context by default →
 *                 genomics:ResearchGrade. CLIA/clinical signals upgrade
 *                 to ClinicalGrade (rare in this corpus).
 */

import type { Quad } from 'n3';
import type {
  ImportContext,
  ImportWarning,
  VocabularyGap,
  ImportedIdentifier,
} from '../import-types.js';
import type { ParsedRecord } from '../fhir-genomics-converter/types.js';
import { classifyPhenopacket } from './detect.js';

export { detectPhenopacket, classifyPhenopacket } from './detect.js';
export { phenopacketImporter } from './registry-entry.js';

export interface PhenopacketConversionResult {
  records: ParsedRecord[];
  quads: Quad[];
  warnings: ImportWarning[];
  vocabularyGaps: VocabularyGap[];
  importedIdentifiers: ImportedIdentifier[];
  skippedCount: number;
}

/**
 * Walk a parsed phenopacket / family / cohort resource and emit the
 * Cascade-shaped record stream.
 *
 * Stub: classifies the input, emits a gap-warning if the shape is
 * unrecognized, and returns an empty result. Subsequent tasks fill in
 * subject + interpretation + variant parsing.
 */
export async function convertPhenopacket(
  parsed: any,
  ctx: ImportContext,
): Promise<PhenopacketConversionResult> {
  void ctx;
  const records: ParsedRecord[] = [];
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const vocabularyGaps: VocabularyGap[] = [];
  const importedIdentifiers: ImportedIdentifier[] = [];
  let skippedCount = 0;

  const kind = classifyPhenopacket(parsed);
  if (kind === null) {
    vocabularyGaps.push({
      sourceField: '<root>',
      reason:
        'Input does not match any recognized phenopacket top-level shape (phenopacket, family, cohort).',
      severity: 'warning',
      context: typeof parsed?.id === 'string' ? parsed.id : undefined,
    });
    skippedCount += 1;
  }

  return {
    records,
    quads,
    warnings,
    vocabularyGaps,
    importedIdentifiers,
    skippedCount,
  };
}
