/**
 * Registry adapter for the VRS → Cascade preserve-only importer.
 *
 * Per D-Q6: VRS digest computation is OUT OF SCOPE; this importer
 * preserves what the input declares and validates the hash. Inputs
 * that aren't valid VRS Alleles (e.g. raw HGVS strings, plain JSON
 * documents) are rejected with `success: false`.
 */

import type {
  FormatImporter,
  ImportContext,
  ImportResult,
} from '../import-types.js';
import type { OutputFormat } from '../fhir-converter/types.js';
import { quadsToTurtle, quadsToJsonLd } from '../fhir-converter/types.js';
import { detectVrs } from './detect.js';
import { convertVrs } from './index.js';

export const vrsImporter: FormatImporter = {
  format: 'vrs',
  description:
    'GA4GH Variation Representation Spec (VRS) Allele JSON-LD — preserve-only ingestion. Writes vrsId + full vrsObject onto a genomics:Variant; rejects non-VRS input rather than computing a hash.',
  supportedOutputs: ['turtle', 'jsonld', 'cascade'],

  detect(input) {
    return detectVrs(input);
  },

  async convert(
    input: string | Buffer,
    to: OutputFormat,
    ctx: ImportContext,
  ): Promise<ImportResult> {
    const conversion = await convertVrs(input, ctx);

    if (conversion.errors.length > 0) {
      return {
        success: false,
        output: '',
        format: to,
        resourceCount: 0,
        skippedCount: 0,
        warnings: conversion.warnings,
        errors: conversion.errors,
        vocabularyGaps: conversion.vocabularyGaps,
        importedIdentifiers: conversion.importedIdentifiers,
      };
    }

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
      warnings: conversion.warnings,
      errors: [],
      vocabularyGaps: conversion.vocabularyGaps,
      importedIdentifiers: conversion.importedIdentifiers,
      records: conversion.records.map((r) => ({
        resourceType: r.fhirResourceType ?? 'VRS',
        cascadeType: r.cascadeType,
        warnings: [],
      })),
      quads: conversion.quads,
    };
  },
};
