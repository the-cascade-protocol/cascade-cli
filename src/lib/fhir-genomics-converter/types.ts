/**
 * Internal types and namespace constants for the FHIR Genomics IG → Cascade
 * converter.
 *
 * Reuses the shared NS constants and quad-emitting helpers from
 * `fhir-converter/types.ts` — those are the canonical Cascade infrastructure
 * and must not be redefined here.
 *
 * Public contract types (FormatImporter, ImportResult, VocabularyGap,
 * ImportContext) live in `lib/import-types.ts`.
 */

import type { Quad } from 'n3';
import { NS } from '../fhir-converter/types.js';

/** Genomics vocabulary namespace (`genomics:`). Not in core NS — added here. */
export const GENOMICS_NS = 'https://ns.cascadeprotocol.org/genomics/v1#';

/** Profile-URL fragment that identifies a FHIR Genomics IG resource. */
export const GENOMICS_PROFILE_PREFIX =
  'http://hl7.org/fhir/uv/genomics-reporting/';

/**
 * Per-profile constants used by detect() and the dispatcher.
 * Bundles often declare these in `meta.profile` on the resources they carry.
 */
export const GENOMICS_PROFILES = {
  variant: `${GENOMICS_PROFILE_PREFIX}StructureDefinition/variant`,
  haplotype: `${GENOMICS_PROFILE_PREFIX}StructureDefinition/haplotype`,
  genotype: `${GENOMICS_PROFILE_PREFIX}StructureDefinition/genotype`,
  diagnosticImplication: `${GENOMICS_PROFILE_PREFIX}StructureDefinition/diagnostic-implication`,
  therapeuticImplication: `${GENOMICS_PROFILE_PREFIX}StructureDefinition/therapeutic-implication`,
  medicationRecommendation: `${GENOMICS_PROFILE_PREFIX}StructureDefinition/medication-recommendation`,
  genomicReport: `${GENOMICS_PROFILE_PREFIX}StructureDefinition/genomic-report`,
  regionStudied: `${GENOMICS_PROFILE_PREFIX}StructureDefinition/region-studied`,
} as const;

/** Coding-system URLs that appear inside FHIR Genomics IG observations. */
export const CODING_SYSTEMS = {
  loinc: 'http://loinc.org',
  hgnc: 'http://www.genenames.org',
  refseq: 'http://www.ncbi.nlm.nih.gov/refseq',
  hgvs: 'http://varnomen.hgvs.org',
  clinvar: 'http://www.ncbi.nlm.nih.gov/clinvar',
  dbsnp: 'http://www.ncbi.nlm.nih.gov/projects/SNP',
  sequenceOntology: 'http://www.sequenceontology.org/',
  mondo: 'http://purl.obolibrary.org/obo/mondo.owl',
  hpo: 'http://purl.obolibrary.org/obo/hp.owl',
  pharmvar: 'http://www.pharmvar.org',
  imgtHla: 'http://www.ebi.ac.uk/ipd/imgt/hla',
  glstring: 'http://glstring.org',
} as const;

/**
 * LOINC component codes used inside variant Observations.
 * Centralized so observation-variant.ts and observation-haplotype.ts can
 * dispatch on them without scattering string literals.
 */
export const LOINC = {
  // Variant identity
  hgvsCDot: '48004-6',           // DNA change (c.HGVS)
  hgvsPDot: '48005-3',           // Amino acid change (p.HGVS)
  hgvsGDot: '81290-9',           // Genomic DNA change (g.HGVS)
  geneStudied: '48018-6',        // Gene studied [ID]
  transcriptRef: '51958-7',      // Transcript reference sequence [ID]
  genomicRefSeq: '48013-7',      // Genomic reference sequence [ID]
  discreteVariant: '81252-9',    // Discrete genetic variant
  zygosity: '53034-5',           // Allelic state
  alleleFreq: '81258-6',         // Sample variant allelic frequency
  variantPhase: '82120-7',       // Allelic phase (LOINC; Genomics IG uses 'phase' loosely)
  dnaChangeType: '48019-4',      // DNA change type (substitution etc.)

  // VCF-style coordinate components (wired in v1-draft.0.2)
  genomicRefAllele: '69547-8',   // Genomic ref allele [ID]
  genomicAltAllele: '69551-0',   // Genomic alt allele [ID]
  genomicStartEnd: '81254-5',    // Genomic allele start-end
  genomicSourceClass: '48002-0', // Genomic source class [Type] (germline/somatic)

  // Haplotype / Genotype
  haplotypeName: '84414-2',      // Haplotype name
  genotypeDisplay: '84413-4',    // Genotype display name

  // Diagnostic implication / interpretation
  variantClinSignificance: '53037-8', // Genetic variation clinical significance (ACMG)
  associatedCondition: '81259-4',     // Associated phenotype/condition

  // Genomic report
  geneticAnalysisReport: '51969-4',
} as const;

/**
 * LOINC answer codes for the ACMG five-tier classification, mapped to the
 * `genomics:AcmgClass` named individuals.
 */
export const ACMG_LOINC_TO_CLASS: Record<string, string> = {
  'LA6668-3': 'Pathogenic',
  'LA26332-9': 'LikelyPathogenic',
  'LA26333-7': 'VUS',
  'LA26334-5': 'LikelyBenign',
  'LA6675-8': 'Benign',
};

/**
 * LOINC answer codes for allelic state (zygosity), mapped to the
 * `genomics:ZygosityValue` named individuals.
 */
export const ZYGOSITY_LOINC_TO_VALUE: Record<string, string> = {
  'LA6705-3': 'Homozygous',
  'LA6706-1': 'Heterozygous',
  'LA6707-9': 'Hemizygous',
  'LA6704-6': 'HomozygousReference', // not strictly in genomics ontology — see gap
};

/**
 * Internal record returned by individual observation parsers. Holds the
 * minted Cascade IRI plus the quads describing it. The orchestrator merges
 * these and serializes to Turtle.
 */
export interface ParsedRecord {
  /** Cascade IRI for the produced resource. */
  iri: string;
  /** Type tag for downstream linking / reporting. */
  cascadeType: string;
  /** Original FHIR resource id (no prefix), used to resolve cross-references. */
  sourceId: string;
  /** Original FHIR resourceType (`Observation`, `DiagnosticReport`, ...). */
  fhirResourceType: string;
  /** Quads describing this resource. */
  quads: Quad[];
}

/** Re-export the n3 Quad type for parser modules. */
export type { Quad };

/**
 * Re-export the core NS constants alongside genomics: so consumers in this
 * module only need to import from one place.
 */
export const NS_ALL = {
  ...NS,
  genomics: GENOMICS_NS,
} as const;
