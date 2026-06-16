/**
 * Registry adapter for the ClinVar VCV XML → Cascade converter.
 *
 * `convert()` is wired up incrementally across TASK-2A.1 → TASK-2A.6.
 * At TASK-2A.1 it succeeds for any ClinVar XML but emits zero records —
 * just enough to satisfy the importer-registry contract end-to-end so
 * detection + dispatcher integration can be exercised.
 *
 * Subsequent tasks fill in:
 *   TASK-2A.2  — simple-allele.ts          (Variant)
 *   TASK-2A.3  — rcv-interpretation.ts     (VariantInterpretation, multi-condition per D-Q5)
 *   TASK-2A.4  — scv-submitter-assertion.ts (SubmitterAssertion per submitter)
 *   TASK-2A.5  — review-status-map.ts      (7-tier review-status enum)
 *
 * VRS hashes (D-Q6) are preserved only — never computed.
 * Every Variant carries `dataQualityTier genomics:ClinicalGrade`
 * (D-QUALITY-TIER) because ClinVar aggregates clinical-lab submissions.
 */

import type {
  FormatImporter,
  ImportContext,
  ImportResult,
  ImportWarning,
  VocabularyGap,
  ImportedIdentifier,
} from '../import-types.js';
import type { OutputFormat } from '../fhir-converter/types.js';
import { quadsToTurtle, quadsToJsonLd } from '../fhir-converter/types.js';
import { detectClinvar } from './detect.js';
import { convertClinvarXml } from './index.js';

export const clinvarImporter: FormatImporter = {
  format: 'clinvar',
  description:
    'ClinVar VCV XML (variation archive: aggregated SimpleAllele + RCVAccession + ClinicalAssertion records → Cascade Variant + VariantInterpretation + SubmitterAssertion graph)',
  supportedOutputs: ['turtle', 'jsonld', 'cascade'],

  detect(input) {
    return detectClinvar(input);
  },

  async convert(
    input: string | Buffer,
    to: OutputFormat,
    ctx: ImportContext,
  ): Promise<ImportResult> {
    const text = Buffer.isBuffer(input) ? input.toString('utf-8') : input;

    const conversion = await convertClinvarXml(text, ctx);

    const warnings: ImportWarning[] = conversion.warnings;
    const gaps: VocabularyGap[] = conversion.vocabularyGaps;
    const ids: ImportedIdentifier[] = conversion.importedIdentifiers;

    let serialized = '';
    if (conversion.quads.length > 0) {
      if (to === 'jsonld' || ctx.outputSerialization === 'jsonld') {
        serialized = JSON.stringify(quadsToJsonLd(conversion.quads, 'genomics'), null, 2);
      } else {
        serialized = await quadsToTurtle(conversion.quads);
      }
    }

    return {
      success: true,
      output: serialized,
      format: to,
      resourceCount: conversion.records.length,
      skippedCount: conversion.skippedCount,
      warnings,
      errors: [],
      vocabularyGaps: gaps,
      importedIdentifiers: ids,
      records: conversion.records.map((r) => ({
        resourceType: 'VariationArchive',
        cascadeType: r.cascadeType,
        warnings: [],
      })),
      quads: conversion.quads,
    };
  },
};
