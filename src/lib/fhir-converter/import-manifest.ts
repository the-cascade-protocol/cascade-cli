/**
 * Import manifest types and builder for FHIR -> Cascade conversion.
 *
 * The manifest is built in the CLI command layer (not in the converter library)
 * after BatchConversionResult is returned. It records what was converted,
 * what used Layer 1 passthrough, and what was intentionally excluded.
 */

import type { BatchConversionResult } from './types.js';
import { EXCLUDED_REASONS } from './converters-passthrough.js';

export interface ManifestEntry {
  count: number;
  strategy: 'mapped' | 'passthrough' | 'excluded';
  reason?: string;
}

export interface ImportManifest {
  sourceFile: string;
  sourceSystem: string;
  convertedAt: string;
  summary: {
    total: number;
    fullyMapped: number;
    passthrough: number;
    excluded: number;
  };
  byType: Record<string, ManifestEntry>;
}

/**
 * Build an ImportManifest from a BatchConversionResult.
 *
 * @param result        The conversion result from the converter library
 * @param sourceFile    The source FHIR file path
 * @param sourceSystem  The --source-system CLI argument
 * @param excludedTypes Map of resource types that were excluded (from EXCLUDED_TYPES Set) with their counts
 */
export function buildImportManifest(
  result: BatchConversionResult,
  sourceFile: string,
  sourceSystem: string,
  excludedTypes: Record<string, number>,
): ImportManifest {
  const byType: Record<string, ManifestEntry> = {};
  let fullyMapped = 0;
  let passthrough = 0;

  for (const r of result.results) {
    const isPassthrough = r.cascadeType.startsWith('fhir:') || r.warnings.some(w => w.includes('Layer 1 passthrough'));
    const strategy: 'mapped' | 'passthrough' = isPassthrough ? 'passthrough' : 'mapped';

    if (!byType[r.resourceType]) {
      byType[r.resourceType] = { count: 0, strategy };
    }
    byType[r.resourceType].count++;

    if (strategy === 'passthrough') passthrough++;
    else fullyMapped++;
  }

  // Add excluded types
  let excluded = 0;
  for (const [type, count] of Object.entries(excludedTypes)) {
    byType[type] = {
      count,
      strategy: 'excluded',
      reason: EXCLUDED_REASONS[type] ?? 'Intentionally excluded',
    };
    excluded += count;
  }

  return {
    sourceFile,
    sourceSystem,
    convertedAt: new Date().toISOString(),
    summary: {
      total: fullyMapped + passthrough + excluded,
      fullyMapped,
      passthrough,
      excluded,
    },
    byType,
  };
}
