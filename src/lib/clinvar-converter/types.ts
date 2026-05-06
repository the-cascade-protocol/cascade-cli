/**
 * Internal types and namespace constants for the ClinVar VCV XML → Cascade
 * converter.
 *
 * Reuses the shared NS constants and quad-emitting helpers from
 * `fhir-converter/types.ts` and the GENOMICS_NS / CODING_SYSTEMS exports
 * from `fhir-genomics-converter/types.ts`. Cross-module reuse keeps the
 * vocabulary surface consistent across importers.
 *
 * Public contract types (FormatImporter, ImportResult, VocabularyGap,
 * ImportContext) live in `lib/import-types.ts`.
 */

import type { Quad } from 'n3';
import { GENOMICS_NS, CODING_SYSTEMS } from '../fhir-genomics-converter/types.js';

export { GENOMICS_NS, CODING_SYSTEMS };

/**
 * ClinVar's seven-tier review-status taxonomy. The strings here are the
 * exact values that appear in `<ReviewStatus>` elements in VCV XML.
 */
export const CLINVAR_REVIEW_STATUS_STRINGS = [
  'no assertion provided',
  'no assertion criteria provided',
  'criteria provided, single submitter',
  'criteria provided, conflicting interpretations',
  'criteria provided, conflicting classifications',
  'criteria provided, multiple submitters, no conflicts',
  'reviewed by expert panel',
  'practice guideline',
] as const;

/**
 * ClinVar germline-classification description strings → genomics:AcmgClass
 * named individuals.
 *
 * The set is intentionally restrictive: only the canonical 5-tier ACMG
 * values pass; modifiers like "Pathogenic, low penetrance" or compound
 * "Conflicting classifications of pathogenicity" surface as gap-warnings
 * (and the calling parser falls back to no acmgClassification triple).
 */
export const ACMG_TEXT_TO_CLASS: Record<string, string> = {
  'Pathogenic': 'Pathogenic',
  'Likely pathogenic': 'LikelyPathogenic',
  'Likely Pathogenic': 'LikelyPathogenic',
  'Uncertain significance': 'VUS',
  'Uncertain Significance': 'VUS',
  'Likely benign': 'LikelyBenign',
  'Likely Benign': 'LikelyBenign',
  'Benign': 'Benign',
};

/** OrganizationCategory string → genomics:SubmitterCategory named individual. */
export const SUBMITTER_CATEGORY_MAP: Record<string, string> = {
  laboratory: 'SubmitterLaboratory',
  consortium: 'SubmitterConsortium',
  'expert-panel': 'SubmitterExpertPanel',
  'expert panel': 'SubmitterExpertPanel',
  'research group': 'SubmitterResearch',
  research: 'SubmitterResearch',
  resource: 'SubmitterLaboratory', // 'resource' (e.g., OMIM) — closest fit
  clinician: 'SubmitterClinician',
  'single clinician': 'SubmitterClinician',
};

/** Re-export the n3 Quad type for parser modules. */
export type { Quad };

/**
 * Internal record returned by individual ClinVar XML parsers. Holds the
 * minted Cascade IRI plus the quads describing it.
 */
export interface ClinvarParsedRecord {
  /** Cascade IRI for the produced resource. */
  iri: string;
  /** Type tag for downstream linking / reporting. */
  cascadeType: string;
  /** Original ClinVar identifier (VCV / RCV / SCV accession). */
  sourceId: string;
  /** Quads describing this resource. */
  quads: Quad[];
}

/**
 * The shape of a parsed VariationArchive after fast-xml-parser. Loosely typed
 * — we walk it defensively because ClinVar XML is dense and frequently
 * carries optional / repeating elements.
 */
export interface VariationArchive {
  '@_VariationID'?: string;
  '@_Accession'?: string;
  '@_Version'?: string;
  '@_RecordType'?: string;
  '@_NumberOfSubmissions'?: string;
  '@_NumberOfSubmitters'?: string;
  '@_DateLastUpdated'?: string;
  '@_DateCreated'?: string;
  '@_VariationName'?: string;
  '@_VariationType'?: string;
  RecordStatus?: string;
  Species?: string;
  ClassifiedRecord?: any;
  IncludedRecord?: any;
}
