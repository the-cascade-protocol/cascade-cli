/**
 * Phenopacket interpretations[] → genomics:VariantInterpretation records.
 *
 * Phenopacket shape (v2):
 *
 *   interpretations[]: {
 *     id, progressStatus,
 *     diagnosis: {
 *       disease: { id: 'NCIT:Cxxxx' or 'OMIM:nnnnnn' or 'MONDO:...' },
 *       genomicInterpretations[]: {
 *         subjectOrBiosampleId,
 *         interpretationStatus: 'CAUSATIVE' | 'CONTRIBUTORY' | ...,
 *         variantInterpretation: {
 *           acmgPathogenicityClassification: 'PATHOGENIC' | 'LIKELY_PATHOGENIC' | ...,
 *           therapeuticActionability: 'ACTIONABLE' | 'NOT_ACTIONABLE',
 *           variationDescriptor: { ... }   // <- variant carrier
 *         }
 *       }
 *     }
 *   }
 *
 * Mapping to v1-draft genomics:
 *
 *   interpretationStatus    → genomics:interpretationStatus  (CausalityStatus)
 *   variantInterpretation.acmgPathogenicityClassification
 *                           → genomics:acmgClassification    (AcmgClass)
 *   diagnosis.disease.id    → genomics:condition + genomics:mondoId|omimId|orphaCode
 *   variationDescriptor     → genomics:variantInterpreted    (Variant IRI from
 *                              parseVariationDescriptor)
 *   therapeuticActionability → emit info gap (no v1-draft slot)
 *
 * D-Q5 (multi-condition cardinality): each VariantInterpretation has 1..1
 * cardinality on `condition`. If a single phenopacket interpretation
 * carries multiple diseases (rare — phenopackets typically carry one
 * disease per interpretation entry), we emit one VariantInterpretation
 * per (variant, disease) pair. In practice the corpus has one disease
 * per interpretation, so the multi-condition path is exercised mostly
 * by defensive coverage rather than real input.
 *
 * Reclassification chains (multiple phenopacket interpretations
 * referencing the same descriptor with different ACMG calls) are NOT
 * inferred here — phenopackets are one-shot reports, not change-history
 * records.
 */

import { GENOMICS_NS, INTERPRETATION_STATUS_TO_CAUSALITY, ACMG_TO_NAMED_INDIVIDUAL } from './types.js';
import type { ParsedRecord, Quad } from './types.js';
import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import {
  NS,
  SCHEMA_VERSION,
  tripleType,
  tripleStr,
  tripleRef,
  tripleBool,
  deterministicUuid,
} from '../fhir-converter/types.js';
import { parseVariationDescriptor } from './variation-descriptor.js';

export interface InterpretationsParseOutput {
  /** All emitted records (Variants + VariantInterpretations). */
  records: ParsedRecord[];
  /** Quads for every emitted record (for the global stream). */
  quads: Quad[];
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

/**
 * Mint a deterministic IRI for a VariantInterpretation. Inputs:
 *   - parent interpretation id
 *   - genomic-interpretation index (so multi-variant interpretations don't collide)
 *   - condition index (D-Q5 fan-out)
 */
function mintInterpretationIri(
  parentId: string,
  giIndex: number,
  condIndex: number,
  ctx: ImportContext,
): string {
  const sys = ctx.sourceSystem ?? 'phenopacket';
  return `urn:uuid:${deterministicUuid(
    `genomics:VariantInterpretation:${sys}:${parentId}:${giIndex}:${condIndex}`,
  )}`;
}

/**
 * Map a phenopacket disease term to (condition IRI, predicate-key, code).
 * Returns the IRI to use for genomics:condition + the matching auxiliary
 * datatype property (mondoId / omimId / orphaCode) when applicable.
 */
function mapDiseaseTerm(
  diseaseId: string,
  diseaseLabel: string | undefined,
): { conditionIri: string; auxPredicate?: string; auxValue?: string } {
  // Normalize prefix → URI mapping. Phenopackets use compact CURIEs:
  //   MONDO:0007254 → http://purl.obolibrary.org/obo/MONDO_0007254
  //   OMIM:101600   → https://omim.org/entry/101600
  //   ORPHA:145     → http://www.orpha.net/ORDO/Orphanet_145
  //   NCIT:C7541    → http://purl.obolibrary.org/obo/NCIT_C7541
  if (diseaseId.startsWith('MONDO:')) {
    const num = diseaseId.slice('MONDO:'.length);
    return {
      conditionIri: `http://purl.obolibrary.org/obo/MONDO_${num}`,
      auxPredicate: GENOMICS_NS + 'mondoId',
      auxValue: diseaseId,
    };
  }
  if (diseaseId.startsWith('OMIM:')) {
    const num = diseaseId.slice('OMIM:'.length);
    return {
      conditionIri: `https://omim.org/entry/${num}`,
      auxPredicate: GENOMICS_NS + 'omimId',
      auxValue: num,
    };
  }
  if (diseaseId.startsWith('ORPHA:')) {
    const num = diseaseId.slice('ORPHA:'.length);
    return {
      conditionIri: `http://www.orpha.net/ORDO/Orphanet_${num}`,
      auxPredicate: GENOMICS_NS + 'orphaCode',
      auxValue: diseaseId,
    };
  }
  if (diseaseId.startsWith('NCIT:')) {
    const num = diseaseId.slice('NCIT:'.length);
    return {
      conditionIri: `http://purl.obolibrary.org/obo/NCIT_${num}`,
    };
  }
  // Fallback: treat the CURIE as opaque and use it directly.
  void diseaseLabel;
  return {
    conditionIri: `urn:cascade:condition:${encodeURIComponent(diseaseId)}`,
  };
}

/**
 * Parse a phenopacket interpretations[] array. Returns Variant + CNV +
 * VariantInterpretation records merged into a single output.
 */
export function parseInterpretations(
  interpretations: any[] | undefined,
  patientIri: string,
  ctx: ImportContext,
  contextLabel: string,
): InterpretationsParseOutput {
  const records: ParsedRecord[] = [];
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];

  if (!Array.isArray(interpretations) || interpretations.length === 0) {
    return { records, quads, warnings, gaps };
  }

  for (let ii = 0; ii < interpretations.length; ii++) {
    const interp = interpretations[ii] ?? {};
    const interpId: string = typeof interp.id === 'string' ? interp.id : `${contextLabel}:${ii}`;
    const diagnosis = interp.diagnosis;
    if (!diagnosis || typeof diagnosis !== 'object') {
      gaps.push({
        sourceField: `${contextLabel}.interpretations[${ii}].diagnosis`,
        reason: 'Phenopacket interpretation has no diagnosis — entire entry skipped.',
        severity: 'warning',
        context: interpId,
      });
      continue;
    }

    // ---- Diagnosis disease(s) (D-Q5: 1..1; if multi, fan out) ----
    const diseases: any[] = Array.isArray(diagnosis.diseases)
      ? diagnosis.diseases
      : diagnosis.disease
        ? [diagnosis.disease]
        : [];
    if (diseases.length === 0) {
      gaps.push({
        sourceField: `${contextLabel}.interpretations[${ii}].diagnosis.disease`,
        reason: 'Phenopacket interpretation has no disease — VariantInterpretations will lack required genomics:condition.',
        severity: 'warning',
        context: interpId,
      });
    }

    // ---- progressStatus → emit info gap (no v1-draft slot) ----
    if (typeof interp.progressStatus === 'string') {
      gaps.push({
        sourceField: `${contextLabel}.interpretations[${ii}].progressStatus`,
        reason: `progressStatus (${interp.progressStatus}) dropped — no v1-draft slot for diagnostic-progress state.`,
        severity: 'info',
        context: interpId,
      });
    }

    const gints: any[] = Array.isArray(diagnosis.genomicInterpretations)
      ? diagnosis.genomicInterpretations
      : [];
    if (gints.length === 0) {
      // SOLVED interpretations sometimes carry a disease but no
      // genomicInterpretations — still useful as patient-level context.
      gaps.push({
        sourceField: `${contextLabel}.interpretations[${ii}].diagnosis.genomicInterpretations`,
        reason: 'No genomicInterpretations[] under diagnosis — no Variant or VariantInterpretation emitted.',
        severity: 'info',
        context: interpId,
      });
      continue;
    }

    for (let gi = 0; gi < gints.length; gi++) {
      const g = gints[gi] ?? {};
      const vi = g.variantInterpretation;
      if (!vi || typeof vi !== 'object') {
        gaps.push({
          sourceField: `${contextLabel}.interpretations[${ii}].diagnosis.genomicInterpretations[${gi}].variantInterpretation`,
          reason: 'No variantInterpretation block — no Variant or VariantInterpretation emitted for this entry.',
          severity: 'warning',
          context: interpId,
        });
        continue;
      }

      // ---- Variant (delegated to TASK-2B.5 parser) ----
      const variantOut = parseVariationDescriptor(
        vi.variationDescriptor,
        ctx,
        `${contextLabel}.interpretations[${ii}].genomicInterpretations[${gi}]`,
      );
      if (!variantOut) {
        // gap already emitted by the variant parser; nothing further.
        continue;
      }
      records.push(variantOut.record);
      quads.push(...variantOut.record.quads);
      warnings.push(...variantOut.warnings);
      gaps.push(...variantOut.gaps);

      // ---- D-Q5: one VariantInterpretation per (variant, condition) pair ----
      const conditionsForFanout = diseases.length > 0 ? diseases : [undefined];
      for (let ci = 0; ci < conditionsForFanout.length; ci++) {
        const disease = conditionsForFanout[ci];
        const interpIri = mintInterpretationIri(interpId, gi, ci, ctx);
        const ipQuads: Quad[] = [];

        // Type + provenance
        ipQuads.push(tripleType(interpIri, GENOMICS_NS + 'VariantInterpretation'));
        ipQuads.push(
          tripleRef(interpIri, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'),
        );
        ipQuads.push(tripleStr(interpIri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));

        // Required: variantInterpreted → variant IRI
        ipQuads.push(tripleRef(interpIri, GENOMICS_NS + 'variantInterpreted', variantOut.record.iri));

        // interpretationStatus → CausalityStatus
        if (typeof g.interpretationStatus === 'string') {
          const namedInd = INTERPRETATION_STATUS_TO_CAUSALITY[g.interpretationStatus];
          if (namedInd) {
            ipQuads.push(
              tripleRef(interpIri, GENOMICS_NS + 'interpretationStatus', GENOMICS_NS + namedInd),
            );
          } else {
            gaps.push({
              sourceField: `${contextLabel}.interpretations[${ii}].genomicInterpretations[${gi}].interpretationStatus`,
              reason: `Unrecognized interpretationStatus enum: ${g.interpretationStatus}`,
              severity: 'warning',
              context: interpId,
            });
          }
        }

        // ACMG classification
        if (typeof vi.acmgPathogenicityClassification === 'string') {
          const acmg = ACMG_TO_NAMED_INDIVIDUAL[vi.acmgPathogenicityClassification];
          if (acmg) {
            ipQuads.push(
              tripleRef(interpIri, GENOMICS_NS + 'acmgClassification', GENOMICS_NS + acmg),
            );
          } else if (vi.acmgPathogenicityClassification !== 'NOT_PROVIDED') {
            gaps.push({
              sourceField: `${contextLabel}.interpretations[${ii}].genomicInterpretations[${gi}].variantInterpretation.acmgPathogenicityClassification`,
              reason: `Unrecognized ACMG enum: ${vi.acmgPathogenicityClassification}`,
              severity: 'warning',
              context: interpId,
            });
          }
        }

        // therapeuticActionability → info gap (no v1-draft slot)
        if (typeof vi.therapeuticActionability === 'string') {
          gaps.push({
            sourceField: `${contextLabel}.interpretations[${ii}].genomicInterpretations[${gi}].variantInterpretation.therapeuticActionability`,
            reason: `therapeuticActionability (${vi.therapeuticActionability}) dropped — v1-draft has no slot.`,
            severity: 'info',
            context: interpId,
          });
        }

        // condition (D-Q5 1..1)
        if (disease && typeof disease === 'object' && typeof disease.id === 'string') {
          const { conditionIri, auxPredicate, auxValue } = mapDiseaseTerm(
            disease.id,
            disease.label,
          );
          ipQuads.push(tripleRef(interpIri, GENOMICS_NS + 'condition', conditionIri));
          if (auxPredicate && auxValue) {
            ipQuads.push(tripleStr(interpIri, auxPredicate, auxValue));
          }
          if (typeof disease.label === 'string') {
            ipQuads.push(tripleStr(interpIri, NS.cascade + 'displayName', disease.label));
          }
        }

        // Patient anchor — VariantInterpretation belongs to a patient.
        ipQuads.push(tripleRef(interpIri, NS.cascade + 'aboutPatient', patientIri));

        // ---- D-QUALITY-TIER safety: research-grade pathogenic/likely-pathogenic
        // requires confirmation per the SHACL constraint. Set the flag.
        const acmgNamed = ACMG_TO_NAMED_INDIVIDUAL[vi.acmgPathogenicityClassification ?? ''];
        if (acmgNamed === 'Pathogenic' || acmgNamed === 'LikelyPathogenic') {
          // Variants emitted from phenopackets are ResearchGrade by default,
          // so the SHACL constraint requires requiresConfirmation=true.
          ipQuads.push(tripleBool(interpIri, GENOMICS_NS + 'requiresConfirmation', true));
        }

        // ---- Source passthrough ----
        ipQuads.push(tripleStr(interpIri, NS.cascade + 'sourceFhirId', interpId));

        records.push({
          iri: interpIri,
          cascadeType: 'genomics:VariantInterpretation',
          sourceId: interpId,
          fhirResourceType: 'Observation',
          quads: ipQuads,
        });
        quads.push(...ipQuads);
      }
    }
  }

  return { records, quads, warnings, gaps };
}
