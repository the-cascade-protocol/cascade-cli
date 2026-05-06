/**
 * Registry adapter for the VCF → Cascade converter.
 *
 * `convert()` runs the streaming `convertVcf()` orchestrator and serializes
 * the resulting quads to Turtle or JSON-LD. Errors fall through to a
 * non-success ImportResult; per-record warnings and vocabulary gaps are
 * surfaced unchanged.
 *
 * VRS hashes (D-Q6) are preserved only — never computed by the VCF
 * importer. Quality tier (D-QUALITY-TIER) is derived inside the orchestrator
 * from the ##source= header (ClinVar → ClinicalGrade, anything else →
 * ResearchGrade).
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
import { detectVcf } from './detect.js';
import { convertVcf } from './index.js';

export const vcfImporter: FormatImporter = {
  format: 'vcf',
  description:
    'VCF (Variant Call Format) v4.0+ — streaming import of variant records into genomics:Variant + genomics:SequencingRun. Plain or gzipped/BGZF input.',
  supportedOutputs: ['turtle', 'jsonld', 'cascade'],

  detect(input) {
    return detectVcf(input);
  },

  async convert(
    input: string | Buffer,
    to: OutputFormat,
    ctx: ImportContext,
  ): Promise<ImportResult> {
    let conversion;
    try {
      conversion = await convertVcf(input, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: '',
        format: to,
        resourceCount: 0,
        skippedCount: 0,
        warnings: [],
        errors: [`VCF conversion failed: ${message}`],
        vocabularyGaps: [],
        importedIdentifiers: [],
      };
    }

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
      skippedCount: 0,
      warnings,
      errors: [],
      vocabularyGaps: gaps,
      importedIdentifiers: ids,
      records: conversion.records.map((r) => ({
        resourceType: r.fhirResourceType ?? 'VCF',
        cascadeType: r.cascadeType,
        warnings: [],
      })),
      quads: conversion.quads,
    };
  },
};
