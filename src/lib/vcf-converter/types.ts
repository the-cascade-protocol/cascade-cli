/**
 * Internal types and namespace constants for the VCF → Cascade converter.
 *
 * Reuses the shared NS constants and quad-emitting helpers from
 * `fhir-converter/types.ts` and the genomics namespace + LOINC dispatch
 * tables from `fhir-genomics-converter/types.ts`. New genomics-only
 * namespace surface for VCF lives here.
 *
 * Public contract types (FormatImporter, ImportResult, VocabularyGap,
 * ImportContext) live in `lib/import-types.ts`.
 *
 * Vocabulary status (against spec/ontologies/genomics/v1-draft @ owl:versionInfo
 * "1.0-draft"):
 *
 *   PRESENT  — genomics:Variant, genomics:SequencingRun, genomics:zygosity,
 *              genomics:dbsnpRsId, genomics:clinvarVariationId, genomics:vrsId,
 *              genomics:vrsObject, genomics:hgvsCDot, genomics:hgvsGDot,
 *              genomics:referenceGenome, genomics:variantCallerVersion,
 *              genomics:fileGenerationDate, genomics:dataQualityTier,
 *              genomics:ClinicalGrade / ResearchGrade / ConsumerGrade /
 *              UnknownQuality
 *
 *   MISSING — genomics:refAllele, genomics:altAllele, genomics:genomicStartEnd,
 *             genomics:variantAlleleFrequency, genomics:observedIn,
 *             genomics:variantQuality, genomics:passedFilter
 *             (the concurrent vocab-evolution agent is adding these as
 *              v1-draft.0.2; the importer emits gap-info entries when it
 *              encounters these fields and falls back to provenance
 *              comments in the meantime).
 */

import type { Quad } from 'n3';
import { NS } from '../fhir-converter/types.js';
import { GENOMICS_NS } from '../fhir-genomics-converter/types.js';

export { GENOMICS_NS };

/**
 * Re-export the core NS constants alongside genomics: so consumers in this
 * module only need to import from one place.
 */
export const NS_ALL = {
  ...NS,
  genomics: GENOMICS_NS,
} as const;

/**
 * INFO and FORMAT field metadata captured from the VCF header.
 * Mirrors the per-key entries `@gmod/vcf` exposes via getMetadata('INFO', id).
 */
export interface VcfFieldMeta {
  Number?: string | number;
  Type?: 'Integer' | 'Float' | 'String' | 'Character' | 'Flag' | string;
  Description?: string;
}

/**
 * Result of parsing the `##` header lines plus the column-header line.
 * Drives downstream record parsing and the SequencingRun emission.
 */
export interface VcfHeader {
  /** e.g., "VCFv4.1", "VCFv4.2", "VCFv4.3". */
  fileFormat: string;

  /** ##reference= value (e.g., 'GRCh38', 'hg19'). */
  reference?: string;

  /** ##fileDate= value (ISO 8601 or YYYYMMDD). */
  fileDate?: string;

  /** ##source= value (e.g., 'ClinVar'). */
  source?: string;

  /** Contig records keyed by ID. */
  contigs: Map<string, { length?: number; assembly?: string }>;

  /** ##INFO=<ID=...> entries. */
  info: Map<string, VcfFieldMeta>;

  /** ##FORMAT=<ID=...> entries. */
  format: Map<string, VcfFieldMeta>;

  /** ##SAMPLE=<...> records keyed by ID. */
  samples: Map<string, Record<string, string>>;

  /** Sample column names from the #CHROM line, in column order. */
  sampleColumns: string[];

  /** All raw `##` lines, retained for the @gmod/vcf parser. */
  rawHeader: string;
}

/**
 * Source-level provenance signals derived from the VCF header. Drives
 * the D-QUALITY-TIER heuristic (e.g., ClinVar weekly export → ClinicalGrade).
 */
export interface VcfSourceProfile {
  /** Lowercase, whitespace-collapsed source string from ##source=. */
  sourceLower: string;
  /** True if header strongly indicates a curated clinical aggregate (ClinVar). */
  isClinvarLike: boolean;
}

/** Re-export the n3 Quad type for record-emission modules. */
export type { Quad };
