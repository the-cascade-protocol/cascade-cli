/**
 * Import manifest types and builder for FHIR -> Cascade conversion.
 *
 * The manifest is built in the CLI command layer (not in the converter library)
 * after BatchConversionResult is returned. It records what was converted,
 * what used Layer 1 passthrough, and what was intentionally excluded.
 */

import type { BatchConversionResult } from './types.js';
import { EXCLUDED_REASONS } from './converters-passthrough.js';
import { analyzeCorpus, coverageDisclosure, type CoverageReport } from './field-coverage/analyze.js';

export interface ManifestEntry {
  count: number;
  strategy: 'mapped' | 'passthrough' | 'passthrough-minimal' | 'excluded';
  reason?: string;
}

/**
 * What the import did NOT carry across, at the field level.
 *
 * The manifest already said which resource TYPES were mapped, passed through or
 * excluded. Below the type, omissions were silent: a mapped Encounter counted as
 * a success in this document while the clinic, the reason and the care team it
 * stated reached nothing. This block closes that, in the same terms the
 * `cascade sources coverage` verb reports — element paths and counts, no values
 * — and states where the unimported data still is, since the source document is
 * retained and a re-import recovers it.
 */
export interface FieldCoverageDisclosure {
  /** One sentence a person can act on. */
  summary: string;
  populatedFields: number;
  importedFields: number;
  notImportedFields: number;
  /** Of the not-imported fields, how many each disposition accounts for. */
  acknowledged: number;
  pending: number;
  /** Not imported and on no converter's drop manifest. */
  unaccounted: number;
  /** Per type, the dropped element paths and how many resources populated each. */
  byType: CoverageReport['byType'];
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
  /** Absent when the caller did not supply the source resources to measure. */
  fieldCoverage?: FieldCoverageDisclosure;
}

/**
 * Measure what the converters did not emit, over the resources actually imported.
 *
 * Separate from {@link buildImportManifest} so the cost is the caller's choice:
 * it runs one conversion per populated element path, which is the price of an
 * answer that is measured rather than assumed.
 */
export function buildFieldCoverageDisclosure(resources: Iterable<unknown>): FieldCoverageDisclosure {
  const report = analyzeCorpus(resources);
  return {
    summary: coverageDisclosure(report),
    populatedFields: report.totals.populatedFields,
    importedFields: report.totals.emittedFields,
    notImportedFields: report.totals.droppedFields,
    acknowledged: report.totals.acknowledged,
    pending: report.totals.pending,
    unaccounted: report.totals.unaccounted,
    byType: report.byType,
  };
}

/**
 * Build an ImportManifest from a BatchConversionResult.
 *
 * Passthrough detection uses cascadeType prefix only:
 *   - 'fhir:*'          -> full passthrough (fhirJson stored, round-trip supported)
 *   - 'fhir-minimal:*'  -> minimal passthrough (no fhirJson, round-trip not supported)
 * All other cascadeType values are Layer 2 mapped records.
 *
 * @param result        The conversion result from the converter library
 * @param sourceFile    The source FHIR file path
 * @param sourceSystem  The --source-system CLI argument
 * @param excludedTypes Map of resource types that were excluded with their counts
 * @param fieldCoverage Optional field-level disclosure from
 *                      {@link buildFieldCoverageDisclosure}. Omitted rather than
 *                      faked when the caller has no source resources to measure:
 *                      an absent block means "not measured", and a zero would
 *                      mean "measured, nothing lost".
 */
export function buildImportManifest(
  result: BatchConversionResult,
  sourceFile: string,
  sourceSystem: string,
  excludedTypes: Record<string, number>,
  fieldCoverage?: FieldCoverageDisclosure,
): ImportManifest {
  const byType: Record<string, ManifestEntry> = {};
  let fullyMapped = 0;
  let passthrough = 0;

  for (const r of result.results) {
    const isFullPassthrough = r.cascadeType.startsWith('fhir:');
    const isMinimalPassthrough = r.cascadeType.startsWith('fhir-minimal:');
    const strategy: ManifestEntry['strategy'] = isMinimalPassthrough
      ? 'passthrough-minimal'
      : isFullPassthrough
        ? 'passthrough'
        : 'mapped';

    if (!byType[r.resourceType]) {
      byType[r.resourceType] = { count: 0, strategy };
    }
    byType[r.resourceType].count++;

    if (isFullPassthrough || isMinimalPassthrough) passthrough++;
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
    ...(fieldCoverage ? { fieldCoverage } : {}),
  };
}
