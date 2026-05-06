/**
 * Public surface for the ClinVar VCV XML → Cascade converter.
 *
 * The orchestrator function `convertClinvarXml()` parses a VCV XML file,
 * walks every `<VariationArchive>` block, and returns the merged quad
 * stream + per-record metadata.
 *
 * Stub at TASK-2A.1: dispatcher returns an empty result for every input.
 * Subsequent tasks fill in:
 *   TASK-2A.2  — simple-allele.ts          (Variant)
 *   TASK-2A.3  — rcv-interpretation.ts     (VariantInterpretation, multi-condition)
 *   TASK-2A.4  — scv-submitter-assertion.ts (SubmitterAssertion per submitter)
 *   TASK-2A.5  — review-status-map.ts      (7-tier review-status enum)
 *   TASK-2A.6  — registry wire-up + e2e
 *   TASK-2A.7  — vocabulary gap audit
 *
 * VRS hashes (D-Q6) are preserved only — never computed.
 * Every Variant carries `dataQualityTier genomics:ClinicalGrade`
 * (D-QUALITY-TIER) because ClinVar aggregates clinical-lab submissions.
 */

import type { Quad } from 'n3';
import type {
  ImportContext,
  ImportWarning,
  VocabularyGap,
  ImportedIdentifier,
} from '../import-types.js';
import type { ClinvarParsedRecord } from './types.js';
import { parseClinvarXml } from './xml-parser.js';

export { detectClinvar } from './detect.js';
export { clinvarImporter } from './registry-entry.js';

export interface ClinvarConversionResult {
  records: ClinvarParsedRecord[];
  quads: Quad[];
  warnings: ImportWarning[];
  vocabularyGaps: VocabularyGap[];
  importedIdentifiers: ImportedIdentifier[];
  skippedCount: number;
}

/**
 * Walk a parsed ClinVar VCV XML tree and dispatch each VariationArchive
 * to the per-archive parser. The per-archive parser emits a Variant,
 * one VariantInterpretation per RCV, and one SubmitterAssertion per
 * ClinicalAssertion.
 *
 * At TASK-2A.1 this is a stub — it parses the XML to validate the
 * shape but emits zero records, just enough to satisfy the importer
 * registry contract end-to-end.
 */
export async function convertClinvarXml(
  xml: string,
  _ctx: ImportContext,
): Promise<ClinvarConversionResult> {
  const records: ClinvarParsedRecord[] = [];
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const vocabularyGaps: VocabularyGap[] = [];
  const importedIdentifiers: ImportedIdentifier[] = [];
  let skippedCount = 0;

  // Parse defensively — malformed XML is not a hard error here; surface as a warning.
  let parsed: any;
  try {
    parsed = parseClinvarXml(xml);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push({ message: `ClinVar XML parse error: ${message}` });
    return { records, quads, warnings, vocabularyGaps, importedIdentifiers, skippedCount };
  }

  // Locate the VariationArchive list. ClinVar exports nest it inside
  // <ClinVarResult-Set>; older / alternative formats nest it directly.
  const archives: any[] = collectVariationArchives(parsed);
  if (archives.length === 0) {
    warnings.push({
      message:
        'ClinVar XML contained no <VariationArchive> elements; nothing to convert.',
    });
  }

  // TASK-2A.1: stub. Real per-archive walk lands in TASK-2A.2 → 2A.4.
  for (const _archive of archives) {
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

/**
 * Collect every VariationArchive node from a parsed ClinVar XML tree,
 * regardless of which root wrapper was used. Always returns an array
 * (the xml-parser configuration normalizes single-archive bundles).
 */
export function collectVariationArchives(parsed: any): any[] {
  if (!parsed || typeof parsed !== 'object') return [];
  // Common case: <ClinVarResult-Set><VariationArchive>...
  const wrapper =
    parsed['ClinVarResult-Set'] ??
    parsed.ReleaseSet ??
    parsed.ClinVarSet ??
    parsed;
  const archives = wrapper?.VariationArchive;
  if (Array.isArray(archives)) return archives;
  if (archives && typeof archives === 'object') return [archives];

  // <VariationReport> single-record form: treat the report itself as a
  // VariationArchive-equivalent and let the per-archive parser cope.
  if (parsed.VariationReport) {
    return Array.isArray(parsed.VariationReport)
      ? parsed.VariationReport
      : [parsed.VariationReport];
  }

  return [];
}
