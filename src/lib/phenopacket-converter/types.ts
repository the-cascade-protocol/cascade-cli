/**
 * Internal types and namespace constants for the GA4GH Phenopacket → Cascade
 * converter.
 *
 * Reuses the shared NS constants and quad-emitting helpers from
 * `fhir-converter/types.ts` and the genomics namespace + ParsedRecord shape
 * from `fhir-genomics-converter/types.ts` — those are the canonical Cascade
 * infrastructure and must not be redefined here.
 *
 * Public contract types (FormatImporter, ImportResult, VocabularyGap,
 * ImportContext) live in `lib/import-types.ts`.
 */

import type { Quad } from 'n3';
import { GENOMICS_NS, type ParsedRecord } from '../fhir-genomics-converter/types.js';

export { GENOMICS_NS };
export type { Quad, ParsedRecord };

/**
 * Phenopacket top-level shapes accepted by the importer.
 *   - 'phenopacket' — single-subject phenopacket (`phenopacket-tools` schema)
 *   - 'family'      — proband + relatives + pedigree resource
 *   - 'cohort'      — `members[]` with phenopacket per member
 */
export type PhenopacketKind = 'phenopacket' | 'family' | 'cohort';

/**
 * Phenopacket InterpretationStatus enum → genomics:CausalityStatus
 * named-individual mapping.
 *
 * Values come from the GA4GH Phenopackets v2 InterpretationStatus enum.
 * See: https://phenopacket-schema.readthedocs.io/en/latest/genomic-interpretation.html
 */
export const INTERPRETATION_STATUS_TO_CAUSALITY: Record<string, string> = {
  CAUSATIVE: 'Causative',
  CONTRIBUTORY: 'Contributory',
  UNKNOWN_SIGNIFICANCE: 'UncertainCausality',
  REJECTED: 'Rejected',
  NOT_PROVIDED: 'UncertainCausality',
};

/**
 * Phenopacket AcmgPathogenicityClassification enum → genomics:AcmgClass
 * named individuals.
 */
export const ACMG_TO_NAMED_INDIVIDUAL: Record<string, string> = {
  PATHOGENIC: 'Pathogenic',
  LIKELY_PATHOGENIC: 'LikelyPathogenic',
  UNCERTAIN_SIGNIFICANCE: 'VUS',
  LIKELY_BENIGN: 'LikelyBenign',
  BENIGN: 'Benign',
  NOT_PROVIDED: '',
};

/**
 * Phenopacket sex enum → cascade:biologicalSex string values.
 * Mirrors the canonical mapping used by the FHIR Patient converter.
 */
export const PHENOPACKET_SEX_TO_BIOLOGICAL_SEX: Record<string, string> = {
  MALE: 'male',
  FEMALE: 'female',
  OTHER_SEX: 'intersex',
  UNKNOWN_SEX: 'intersex',
};

/**
 * GENO ontology zygosity term IDs → genomics:ZygosityValue named individuals.
 * Used by variation-descriptor parsing when allelicState is encoded as a
 * GENO term rather than free text.
 */
export const GENO_ZYGOSITY_TO_VALUE: Record<string, string> = {
  'GENO:0000135': 'Heterozygous',
  'GENO:0000136': 'Homozygous',
  'GENO:0000134': 'Hemizygous',
};

/**
 * Phenopacket pedigree affected-status → genomics:CarrierStatus named
 * individuals. Note: AFFECTED is a phenotype outcome; we map to
 * PositiveAffected when the proband's variant is also tested-positive,
 * else carry as a free-text gap.
 */
export const AFFECTED_STATUS_HINTS: Record<string, string> = {
  AFFECTED: 'AFFECTED',
  UNAFFECTED: 'UNAFFECTED',
  MISSING: 'UNKNOWN',
};

/**
 * HL7 v3 RoleCode named individuals defined in genomics.ttl.
 * Used by the pedigree parser to map (paternalId, maternalId) edges to
 * relativeRole values.
 */
export const PEDIGREE_ROLE_NAMED_INDIVIDUALS = new Set<string>([
  'Proband',
  'MTH',
  'FTH',
  'SIS',
  'BRO',
  'DAU',
  'SON',
  'MAUNT',
  'MUNCLE',
  'PAUNT',
  'PUNCLE',
  'MGRMTH',
  'MGRFTH',
  'PGRMTH',
  'PGRFTH',
  'MCOUSN',
  'PCOUSN',
  'NIECE',
  'NEPHEW',
]);
