/**
 * Registry adapter for the FHIR R4 → Cascade and Cascade → FHIR conversions.
 *
 * The legacy convert() / detectFormat() in this module pre-date the unified
 * importer registry. This file wraps them as two FormatImporter instances:
 *
 *   - fhirImporter      handles --from fhir   (FHIR Bundle/Resource → Cascade)
 *   - cascadeFhirImporter handles --from cascade --to fhir (reverse path)
 *
 * The legacy fhir-converter is otherwise unchanged.
 */

import { writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

import type {
  FormatImporter,
  ImportResult,
  ImportedIdentifier,
  ImportWarning,
} from '../import-types.js';
import { convert as legacyConvert, detectFormat } from './index.js';
import type { BatchConversionResult, InputFormat } from './types.js';
import { buildImportManifest } from './import-manifest.js';
import { EXCLUDED_TYPES } from './converters-passthrough.js';

function adapt(r: BatchConversionResult): ImportResult {
  const warnings: ImportWarning[] = r.warnings.map((message) => ({ message }));
  const importedIdentifiers: ImportedIdentifier[] = [];
  return {
    success: r.success,
    output: r.output,
    format: r.format,
    resourceCount: r.resourceCount,
    skippedCount: r.skippedCount,
    warnings,
    errors: r.errors,
    vocabularyGaps: [],
    importedIdentifiers,
    records: r.results.map((res) => ({
      resourceType: res.resourceType,
      cascadeType: res.cascadeType,
      warnings: res.warnings,
    })),
  };
}

export const fhirImporter: FormatImporter = {
  format: 'fhir',
  description: 'FHIR R4 JSON Bundle or single resource',
  supportedOutputs: ['turtle', 'jsonld', 'cascade'],

  detect(input) {
    if (Buffer.isBuffer(input)) return false;
    return detectFormat(input) === 'fhir';
  },

  async convert(input, to, ctx) {
    const r = await legacyConvert(
      input,
      'fhir',
      to,
      ctx.outputSerialization,
      ctx.sourceSystem,
      ctx.passthroughMinimal ?? false,
    );
    return adapt(r);
  },

  cliOptions: [
    {
      flag: '--manifest [file]',
      description:
        'Write import manifest JSON alongside output (default: {input}-manifest.json). Only meaningful when --from fhir.',
    },
  ],

  async postProcess(input, result, ctx) {
    const manifestOpt = ctx.options['manifest'];
    if (manifestOpt === undefined || !result.success) return;

    // Count excluded resource types from the original FHIR Bundle.
    const excludedCounts: Record<string, number> = {};
    try {
      const inputStr = Buffer.isBuffer(input) ? input.toString('utf-8') : input;
      const parsed = JSON.parse(inputStr);
      const resources: Array<{ resourceType?: string }> =
        parsed.resourceType === 'Bundle'
          ? (parsed.entry ?? []).map((e: { resource?: unknown }) => e.resource).filter(Boolean)
          : [parsed];
      for (const res of resources) {
        if (res?.resourceType && EXCLUDED_TYPES.has(res.resourceType)) {
          excludedCounts[res.resourceType] = (excludedCounts[res.resourceType] ?? 0) + 1;
        }
      }
    } catch {
      // JSON already validated upstream by the converter; ignore.
    }

    // buildImportManifest expects the legacy BatchConversionResult shape;
    // ImportResult is a strict superset of the fields it reads, so we
    // construct the minimum it needs from our adapted result.
    const legacyForManifest: BatchConversionResult = {
      success: result.success,
      output: result.output,
      format: result.format,
      resourceCount: result.resourceCount,
      skippedCount: result.skippedCount,
      warnings: result.warnings.map((w) => w.message),
      errors: result.errors,
      results: (result.records ?? []).map((rec) => ({
        turtle: '',
        warnings: rec.warnings,
        resourceType: rec.resourceType,
        cascadeType: rec.cascadeType,
      })),
    };

    const manifest = buildImportManifest(
      legacyForManifest,
      ctx.inputPath,
      ctx.sourceSystem ?? '',
      excludedCounts,
    );

    let manifestPath: string;
    if (typeof manifestOpt === 'string') {
      manifestPath = manifestOpt;
    } else if (ctx.inputPath !== '<stdin>') {
      manifestPath = join(
        dirname(ctx.inputPath),
        `${basename(ctx.inputPath, '.json')}-manifest.json`,
      );
    } else {
      manifestPath = 'fhir-import-manifest.json';
    }

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.error(`Import manifest written to: ${manifestPath}`);
  },
};

/**
 * Reverse converter: Cascade Turtle/JSON-LD → FHIR JSON.
 * --from cascade --to fhir.
 */
export const cascadeFhirImporter: FormatImporter = {
  format: 'cascade',
  description: 'Cascade Protocol Turtle or JSON-LD (reverse conversion to FHIR)',
  supportedOutputs: ['fhir'],

  detect(input) {
    if (Buffer.isBuffer(input)) return false;
    return detectFormat(input) === 'cascade';
  },

  async convert(input, to, ctx) {
    if (to !== 'fhir') {
      return {
        success: false,
        output: '',
        format: to,
        resourceCount: 0,
        skippedCount: 0,
        warnings: [],
        errors: [`--from cascade only supports --to fhir (got ${to})`],
        vocabularyGaps: [],
        importedIdentifiers: [],
      };
    }
    const r = await legacyConvert(
      input,
      'cascade' as InputFormat,
      'fhir',
      ctx.outputSerialization,
      ctx.sourceSystem,
      ctx.passthroughMinimal ?? false,
    );
    return adapt(r);
  },
};
