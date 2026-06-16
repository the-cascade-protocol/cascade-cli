/**
 * Registry adapter for the GA4GH Phenopacket → Cascade converter.
 *
 * `convert()` is wired up incrementally across TASK-2B.2 → TASK-2B.10. At
 * TASK-2B.1 it succeeds for any recognized phenopacket / family / cohort
 * shape but emits zero records — enough to satisfy the importer-registry
 * contract end-to-end so detection + dispatcher integration can be
 * exercised before the per-section parsers land.
 *
 * VRS hashes (D-Q6) are preserved only — never computed.
 * Phenopackets default to `genomics:ResearchGrade` quality tier
 * (D-QUALITY-TIER) since the corpus skews research-context — clinical
 * lab markers flip to ClinicalGrade where present.
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
import { detectPhenopacket } from './detect.js';
import { convertPhenopacket } from './index.js';

export const phenopacketImporter: FormatImporter = {
  format: 'phenopacket',
  description:
    'GA4GH Phenopacket Schema v1/v2 (single phenopacket, family, or cohort) — phenotypic features, variant interpretations, biosamples, medical actions, pedigree.',
  supportedOutputs: ['turtle', 'jsonld', 'cascade'],

  detect(input) {
    return detectPhenopacket(input);
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

    const conversion = await convertPhenopacket(parsed, ctx);

    const warnings: ImportWarning[] = conversion.warnings;
    const gaps: VocabularyGap[] = conversion.vocabularyGaps;
    const ids: ImportedIdentifier[] = conversion.importedIdentifiers;

    let serialized = '';
    if (conversion.quads.length > 0) {
      if (to === 'jsonld' || ctx.outputSerialization === 'jsonld') {
        serialized = JSON.stringify(quadsToJsonLd(conversion.quads, 'phenopacket'), null, 2);
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
