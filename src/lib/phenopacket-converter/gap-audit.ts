/**
 * Comprehensive vocabulary-gap audit for the phenopacket importer.
 *
 * The per-section parsers (subject, phenotypicFeatures, interpretations,
 * variation-descriptor, biosamples, medicalActions, pedigree) each emit
 * targeted info / warning gaps for fields they recognize but cannot map
 * fully. This module covers everything else — top-level phenopacket /
 * family / cohort fields that no per-section parser owns.
 *
 * Examples:
 *   - phenopacket.diseases[]            (top-level disease list — distinct
 *                                          from interpretations.diagnosis.disease)
 *   - phenopacket.measurements[]        (top-level lab values)
 *   - phenopacket.genes[] / variants[]  (Phenopackets v1 fields)
 *   - phenopacket.metaData.externalReferences
 *   - phenopacket.metaData.resources
 *   - cohort.description
 *
 * Per the implementation plan TASK-2B.10: don't drop data silently.
 */

import type { VocabularyGap } from '../import-types.js';

/**
 * The set of phenopacket / family / cohort top-level fields that ARE
 * processed by the per-section parsers and therefore should NOT trigger
 * a gap-audit gap when present.
 */
const HANDLED_TOP_LEVEL_FIELDS = new Set<string>([
  'id',
  'subject',
  'phenotypicFeatures',
  'interpretations',
  'biosamples',
  'medicalActions',
  'files',
  'metaData',
  // Family-resource keys
  'proband',
  'relatives',
  'pedigree',
  // Cohort-resource keys
  'members',
  // tpm3 v1 keys handled below specifically
]);

/**
 * Emit gaps for unhandled top-level fields on a phenopacket-shaped object.
 * Returns the gaps without mutating the input.
 */
export function auditPhenopacketTopLevel(
  pp: any,
  contextLabel: string,
): VocabularyGap[] {
  const gaps: VocabularyGap[] = [];
  if (!pp || typeof pp !== 'object') return gaps;

  // ---- Top-level diseases[] (distinct from interpretation.diagnosis.disease) ----
  if (Array.isArray(pp.diseases) && pp.diseases.length > 0) {
    gaps.push({
      sourceField: `${contextLabel}.diseases`,
      reason: `${pp.diseases.length} top-level disease entry(ies) dropped — Phenopackets carry diseases both at the top level (patient-level diagnoses) and inside interpretations.diagnosis (variant-linked). The variant-linked path is mapped via VariantInterpretation; the top-level list has no v1-draft slot.`,
      severity: 'info',
      context: typeof pp.id === 'string' ? pp.id : undefined,
    });
  }

  // ---- Top-level measurements[] (lab values, vital signs) ----
  if (Array.isArray(pp.measurements) && pp.measurements.length > 0) {
    gaps.push({
      sourceField: `${contextLabel}.measurements`,
      reason: `${pp.measurements.length} top-level measurement(s) dropped — lab values and vital-sign measurements have no genomics-importer routing; would need a separate observation-converter pass.`,
      severity: 'info',
      context: typeof pp.id === 'string' ? pp.id : undefined,
    });
  }

  // ---- Phenopackets v1: top-level genes[] ----
  if (Array.isArray(pp.genes) && pp.genes.length > 0) {
    gaps.push({
      sourceField: `${contextLabel}.genes`,
      reason: `${pp.genes.length} v1-style top-level gene(s) dropped — Phenopackets v1.0 carried genes/variants directly; v2 moved them under interpretations.diagnosis.genomicInterpretations[]. The v1 corpus path has no Variant emission yet.`,
      severity: 'warning',
      context: typeof pp.id === 'string' ? pp.id : undefined,
    });
  }

  // ---- Phenopackets v1: top-level variants[] ----
  if (Array.isArray(pp.variants) && pp.variants.length > 0) {
    gaps.push({
      sourceField: `${contextLabel}.variants`,
      reason: `${pp.variants.length} v1-style top-level variant(s) dropped — Phenopackets v1.0 used 'variants[]' with vcfAllele/zygosity, replaced in v2 by variationDescriptor inside interpretations. v1-shaped variants are not currently emitted as genomics:Variant records.`,
      severity: 'warning',
      context: typeof pp.id === 'string' ? pp.id : undefined,
    });
  }

  // ---- metaData.externalReferences / resources ----
  if (pp.metaData && typeof pp.metaData === 'object') {
    const md = pp.metaData;
    if (Array.isArray(md.externalReferences) && md.externalReferences.length > 0) {
      gaps.push({
        sourceField: `${contextLabel}.metaData.externalReferences`,
        reason: `${md.externalReferences.length} external reference(s) (PMIDs, DOIs) dropped — no v1-draft slot for top-level provenance citations.`,
        severity: 'info',
      });
    }
    if (md.submittedBy) {
      gaps.push({
        sourceField: `${contextLabel}.metaData.submittedBy`,
        reason: `submittedBy (${md.submittedBy}) dropped — no v1-draft slot for submitter provenance.`,
        severity: 'info',
      });
    }
    if (md.updates && Array.isArray(md.updates)) {
      gaps.push({
        sourceField: `${contextLabel}.metaData.updates`,
        reason: `${md.updates.length} update entries dropped — no v1-draft slot for record-update history.`,
        severity: 'info',
      });
    }
    // resources[] is the prefix-iri map — recognized but intentionally
    // not emitted (we use full URIs throughout). Don't flag this.
  }

  // ---- Unrecognized top-level fields ----
  for (const key of Object.keys(pp)) {
    if (
      !HANDLED_TOP_LEVEL_FIELDS.has(key) &&
      key !== 'diseases' &&
      key !== 'measurements' &&
      key !== 'genes' &&
      key !== 'variants' &&
      key !== 'description' &&
      key !== 'name' &&
      key !== 'datasets' // future GA4GH research-set field
    ) {
      gaps.push({
        sourceField: `${contextLabel}.${key}`,
        reason: `Unrecognized phenopacket field "${key}" — not mapped, not classified.`,
        severity: 'info',
      });
    }
  }

  return gaps;
}

/**
 * Audit a cohort wrapper. Cohorts have a top-level `description` that's
 * useful to preserve as a one-line patient-level annotation, but no
 * v1-draft slot. We surface the string in a gap so downstream tools can
 * pick it up.
 */
export function auditCohortWrapper(parsed: any): VocabularyGap[] {
  const gaps: VocabularyGap[] = [];
  if (typeof parsed?.description === 'string' && parsed.description.length > 0) {
    gaps.push({
      sourceField: 'cohort.description',
      reason: `Cohort description "${parsed.description}" dropped — no v1-draft slot for cohort-level annotations.`,
      severity: 'info',
    });
  }
  return gaps;
}
