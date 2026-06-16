/**
 * Registry adapter for the FHIR Genomics IG → Cascade converter.
 *
 * `convert()` is wired up incrementally across TASK-1.2 → TASK-1.7. At
 * TASK-1.1 it succeeds for any genomics bundle but emits zero records —
 * just enough to satisfy the importer-registry contract end-to-end so
 * detection + dispatcher integration can be exercised.
 *
 * Subsequent tasks fill in:
 *   TASK-1.2  — observation-variant.ts          (Variant Observations)
 *   TASK-1.3  — observation-haplotype.ts        (Haplotype Observations)
 *   TASK-1.4  — observation-genotype.ts         (Genotype / Diplotype)
 *   TASK-1.5  — observation-diagnostic-implication.ts (VariantInterpretation)
 *   TASK-1.6  — diagnostic-report.ts            (GeneticTest)
 *   TASK-1.7  — service-request.ts              (GeneticTestOrder)
 *
 * VRS hashes (D-Q6) are preserved only — never computed.
 * Every Variant carries `dataQualityTier` (D-QUALITY-TIER); for
 * FHIR Genomics IG bundles the default is `genomics:ClinicalGrade`.
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
import { detectFhirGenomics } from './detect.js';
import { convertGenomicsBundle } from './index.js';

export const fhirGenomicsImporter: FormatImporter = {
  format: 'fhir-genomics',
  description:
    'HL7 FHIR Genomics Reporting IG bundle (variants, haplotypes, diplotypes, diagnostic implications, genomic reports, service requests)',
  supportedOutputs: ['turtle', 'jsonld', 'cascade'],

  detect(input) {
    return detectFhirGenomics(input);
  },

  async convert(
    input: string | Buffer,
    to: OutputFormat,
    ctx: ImportContext,
  ): Promise<ImportResult> {
    const text = Buffer.isBuffer(input) ? input.toString('utf-8') : input;

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: '',
        format: to,
        resourceCount: 0,
        skippedCount: 0,
        warnings: [],
        errors: [`Invalid JSON: ${message}`],
        vocabularyGaps: [],
        importedIdentifiers: [],
      };
    }

    const conversion = await convertGenomicsBundle(parsed, ctx);

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
        resourceType: r.fhirResourceType,
        cascadeType: r.cascadeType,
        warnings: [],
      })),
      quads: conversion.quads,
    };
  },
};
