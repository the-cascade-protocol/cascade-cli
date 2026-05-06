/**
 * RCVAccession → VariantInterpretation builder.
 *
 * Per D-Q5, each VariantInterpretation has cardinality 1..1 on
 * `genomics:variantInterpreted` AND on `genomics:condition`. ClinVar's
 * RCVAccession aggregates a (variant, condition-set) pair; if an RCV
 * lists multiple ClassifiedConditions (e.g., the BRCA1 RCV005003390
 * "multiple conditions" rollup of 3 distinct MedGen CUIs), we EXPAND
 * into one VariantInterpretation per condition — so the SHACL
 * cardinality-1..1 constraint is preserved.
 *
 * Field mapping:
 *   <RCVAccession Accession>                      → genomics:clinvarRcvId
 *   <RCVClassifications/GermlineClassification>
 *     <ReviewStatus>                              → genomics:reviewStatus
 *     <Description>{ACMG text}</Description>      → genomics:acmgClassification
 *     <Description @DateLastEvaluated>            → genomics:interpretedDate
 *     <Description @SubmissionCount>              → (gap-info, no v1-draft predicate)
 *   <ClassifiedConditionList/ClassifiedCondition> → genomics:condition
 *     - Per-condition expansion (D-Q5)
 *     - DB='MONDO' coding → MONDO IRI;
 *       DB='MedGen' coding → MedGen IRI fallback;
 *       MONDO ID looked up from <Classifications>/<Trait>/<XRef DB="MONDO"> via TraitSetID
 *
 * Cross-link: each Interpretation declares
 *   genomics:variantInterpreted <iri-of-VCV-Variant>
 *
 * D-QUALITY-TIER safety constraint: the upstream Variant always carries
 * `dataQualityTier ClinicalGrade`, so the SHACL constraint passes for
 * Pathogenic / LikelyPathogenic interpretations (verified by an explicit
 * assertion in the unit tests).
 *
 * Vocabulary gaps:
 * - genomics v1-draft.0.1 has no `genomics:lastEvaluatedDate` distinct
 *   from `genomics:interpretedDate`. We map RCV's DateLastEvaluated to
 *   `genomics:interpretedDate` (closest semantic match).
 */

import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import type { ClinvarParsedRecord, Quad } from './types.js';
import { GENOMICS_NS, ACMG_TEXT_TO_CLASS } from './types.js';
import {
  NS,
  SCHEMA_VERSION,
  tripleType,
  tripleStr,
  tripleRef,
  tripleDate,
  deterministicUuid,
} from '../fhir-converter/types.js';
import { mapReviewStatus } from './review-status-map.js';

const MONDO_IRI_PREFIX = 'http://purl.obolibrary.org/obo/MONDO_';
const MEDGEN_IRI_PREFIX = 'https://www.ncbi.nlm.nih.gov/medgen/';

export interface RcvInterpretationParseOutput {
  records: ClinvarParsedRecord[];
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(node: unknown): string | undefined {
  if (node == null) return undefined;
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && '#text' in (node as object)) {
    const v = (node as { '#text': unknown })['#text'];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

/**
 * Build a TraitSetID → MONDO IRI lookup from the parent Classifications
 * block. RCVs reference TraitSetID; MONDO XRefs live on the Trait under
 * the same TraitSetID.
 *
 * Returned shape: TraitSetID → array of { mondoIri?, medgenId?, label? }
 * (one entry per Trait inside the TraitSet).
 */
export function buildTraitSetIndex(
  classifications: any,
): Map<string, Array<{ mondoIri?: string; medgenId?: string; label?: string }>> {
  const index = new Map<string, Array<{ mondoIri?: string; medgenId?: string; label?: string }>>();

  // Three classification kinds may appear: Germline, Somatic, Oncogenicity.
  // Walk all three.
  const classKinds = [
    classifications?.GermlineClassification,
    classifications?.SomaticClinicalImpact,
    classifications?.OncogenicityClassification,
  ];

  for (const c of classKinds) {
    for (const kind of asArray(c)) {
      const traitSets = asArray(kind?.ConditionList?.TraitSet);
      for (const ts of traitSets) {
        const tsId: string | undefined = ts?.['@_ID'];
        if (!tsId) continue;
        const traits = asArray(ts?.Trait);
        const acc: Array<{ mondoIri?: string; medgenId?: string; label?: string }> = [];
        for (const t of traits) {
          let mondoIri: string | undefined;
          let medgenId: string | undefined;
          let label: string | undefined;
          // Top-level XRefs on the Trait
          for (const xref of asArray(t?.XRef)) {
            const db = xref?.['@_DB'];
            const id = xref?.['@_ID'];
            if (typeof id !== 'string') continue;
            if (db === 'MONDO' && !mondoIri) {
              const numeric = id.replace(/^MONDO:0*/, '');
              mondoIri = MONDO_IRI_PREFIX + numeric.padStart(7, '0');
            } else if (db === 'MedGen' && !medgenId) {
              medgenId = id;
            }
          }
          // XRefs nested inside Name elements
          for (const n of asArray(t?.Name)) {
            for (const xref of asArray(n?.XRef)) {
              const db = xref?.['@_DB'];
              const id = xref?.['@_ID'];
              if (typeof id !== 'string') continue;
              if (db === 'MONDO' && !mondoIri) {
                const numeric = id.replace(/^MONDO:0*/, '');
                mondoIri = MONDO_IRI_PREFIX + numeric.padStart(7, '0');
              }
            }
          }
          // Preferred name
          for (const n of asArray(t?.Name)) {
            const ev = n?.ElementValue;
            const evType = ev?.['@_Type'];
            const evText = textOf(ev);
            if (evType === 'Preferred' && evText && !label) label = evText;
          }
          acc.push({ mondoIri, medgenId, label });
        }
        index.set(tsId, acc);
      }
    }
  }
  return index;
}

/**
 * Mint a deterministic Cascade IRI for a VariantInterpretation. Identity is
 * (RCV accession, condition index inside the RCV) — multi-condition RCVs
 * yield distinct IRIs per condition expansion.
 */
function mintInterpretationIri(
  rcvAccession: string,
  conditionIndex: number,
  ctx: ImportContext,
): string {
  const sys = ctx.sourceSystem ?? 'clinvar';
  return `urn:uuid:${deterministicUuid(
    `genomics:VariantInterpretation:${sys}:${rcvAccession}:${conditionIndex}`,
  )}`;
}

/**
 * Parse one RCVAccession, expanding into one VariantInterpretation per
 * ClassifiedCondition (per D-Q5).
 */
export function parseRcvAccession(
  vcvAccession: string,
  variantIri: string,
  rcv: any,
  traitSetIndex: Map<string, Array<{ mondoIri?: string; medgenId?: string; label?: string }>>,
  ctx: ImportContext,
): RcvInterpretationParseOutput {
  const records: ClinvarParsedRecord[] = [];
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];

  const rcvAccession: string = rcv?.['@_Accession'] ?? '<no-rcv>';

  // GermlineClassification is normalized as an array by xml-parser. RCVs
  // typically carry exactly one germline classification block; we take
  // the first if multiple are present.
  const germline = asArray(rcv?.RCVClassifications?.GermlineClassification)[0];
  const somatic = asArray(rcv?.RCVClassifications?.SomaticClinicalImpact)[0];
  const oncogenic = asArray(rcv?.RCVClassifications?.OncogenicityClassification)[0];

  if (somatic || oncogenic) {
    gaps.push({
      sourceField: `RCVAccession[${rcvAccession}]/RCVClassifications`,
      reason:
        'RCV carries SomaticClinicalImpact or OncogenicityClassification; v1-draft.0.1 has no genomics:somaticStatus / oncogenicityClassification predicates yet — these are v1-draft.0.2 candidates.',
      severity: 'info',
      context: rcvAccession,
    });
  }

  if (!germline) {
    // Without a germline classification we cannot satisfy the ACMG
    // sh:in constraint. Skip with a warning gap.
    gaps.push({
      sourceField: `RCVAccession[${rcvAccession}]/RCVClassifications/GermlineClassification`,
      reason:
        'RCV has no GermlineClassification block; cannot emit a VariantInterpretation (ACMG classification is required).',
      severity: 'warning',
      context: rcvAccession,
    });
    return { records, warnings, gaps };
  }

  // Pull the aggregate classification text and date.
  const reviewStatusStr = textOf(germline?.ReviewStatus);
  const desc = germline?.Description;
  const acmgText = textOf(desc) ?? (typeof desc === 'string' ? desc : undefined);
  const dateLastEvaluated: string | undefined = desc?.['@_DateLastEvaluated'];
  const submissionCount: string | undefined = desc?.['@_SubmissionCount'];

  if (submissionCount) {
    // Useful for star-rating computation but no v1-draft predicate yet.
    gaps.push({
      sourceField: `RCVAccession[${rcvAccession}]/Description@SubmissionCount`,
      reason:
        'RCV submission count carries the per-condition aggregate count; v1-draft has no genomics:submissionCount predicate. Star rating is computed via genomics:reviewStatus instead.',
      severity: 'info',
      context: rcvAccession,
    });
  }

  // Classified conditions. May be 1 or N (multi-condition RCV).
  const classifiedConditions = asArray(rcv?.ClassifiedConditionList?.ClassifiedCondition);
  const traitSetId: string | undefined = rcv?.ClassifiedConditionList?.['@_TraitSetID'];
  const mondoFromTraitSet = traitSetId ? traitSetIndex.get(traitSetId) ?? [] : [];

  if (classifiedConditions.length === 0) {
    gaps.push({
      sourceField: `RCVAccession[${rcvAccession}]/ClassifiedConditionList`,
      reason:
        'RCV has no ClassifiedCondition entries; cannot emit VariantInterpretation (genomics:condition is required, cardinality 1..1 per D-Q5).',
      severity: 'warning',
      context: rcvAccession,
    });
    return { records, warnings, gaps };
  }

  // Per D-Q5: expand to one Interpretation per condition.
  for (let i = 0; i < classifiedConditions.length; i++) {
    const cc = classifiedConditions[i];
    const ccDb: string | undefined = cc?.['@_DB'];
    const ccId: string | undefined = cc?.['@_ID'];
    const ccLabel = textOf(cc) ?? '';

    const iri = mintInterpretationIri(rcvAccession, i, ctx);
    const quads: Quad[] = [];

    quads.push(tripleType(iri, GENOMICS_NS + 'VariantInterpretation'));
    quads.push(tripleRef(iri, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'));
    quads.push(tripleStr(iri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));

    // ---- Variant-interpreted link (D-Q5 cardinality 1..1) ----
    quads.push(tripleRef(iri, GENOMICS_NS + 'variantInterpreted', variantIri));

    // ---- Condition: try MONDO from TraitSet index first; fall back to MedGen ----
    let conditionIri: string | undefined;
    // Direct DB on the ClassifiedCondition
    if (ccDb === 'MONDO' && ccId) {
      const numeric = ccId.replace(/^MONDO:0*/, '');
      conditionIri = MONDO_IRI_PREFIX + numeric.padStart(7, '0');
    }
    // Look up MONDO via TraitSet → Trait XRefs
    if (!conditionIri && mondoFromTraitSet[i]?.mondoIri) {
      conditionIri = mondoFromTraitSet[i].mondoIri;
    }
    // Fall back to the MedGen CUI as an IRI (no MONDO mapping in source)
    if (!conditionIri && ccDb === 'MedGen' && ccId) {
      conditionIri = MEDGEN_IRI_PREFIX + ccId;
    }
    // Last resort: synthesize a stable IRI from the label so cardinality-1
    // is satisfied. Surface as a gap because the IRI is non-resolvable.
    if (!conditionIri) {
      const synthetic =
        'urn:cascade:condition:' +
        deterministicUuid(`clinvar-condition:${rcvAccession}:${i}:${ccLabel || ccId || 'unknown'}`);
      conditionIri = synthetic;
      gaps.push({
        sourceField: `RCVAccession[${rcvAccession}]/ClassifiedCondition[${i}]`,
        reason: `Condition "${ccLabel}" (DB=${ccDb ?? 'none'}, ID=${ccId ?? 'none'}) had no resolvable MONDO/MedGen identifier; synthesized a Cascade-local IRI to satisfy cardinality 1..1 on genomics:condition. Recommended: source XML carries no MONDO mapping for this trait.`,
        severity: 'warning',
        context: rcvAccession,
      });
    }
    quads.push(tripleRef(iri, GENOMICS_NS + 'condition', conditionIri));

    // ---- MedGen ID datatype (preserve when available, even alongside MONDO) ----
    if (ccDb === 'MedGen' && ccId) {
      // No genomics:medgenId predicate; surface as info gap.
      gaps.push({
        sourceField: `RCVAccession[${rcvAccession}]/ClassifiedCondition[${i}]@DB='MedGen'`,
        reason:
          'MedGen CUI carries the original ClinVar trait identifier; no v1-draft genomics:medgenId predicate (could be added in v1-draft.0.2 alongside mondoId).',
        severity: 'info',
        context: rcvAccession,
      });
    }
    // Capture MONDO ID as a string too (alongside the IRI link)
    if (conditionIri.startsWith(MONDO_IRI_PREFIX)) {
      const mondoNumeric = conditionIri.slice(MONDO_IRI_PREFIX.length);
      quads.push(
        tripleStr(iri, GENOMICS_NS + 'mondoId', `MONDO:${mondoNumeric}`),
      );
    }

    // ---- ACMG classification ----
    if (acmgText) {
      const acmgClass = ACMG_TEXT_TO_CLASS[acmgText.trim()];
      if (acmgClass) {
        quads.push(
          tripleRef(iri, GENOMICS_NS + 'acmgClassification', GENOMICS_NS + acmgClass),
        );
      } else {
        // ClinVar carries some non-canonical descriptions ("Pathogenic, low penetrance",
        // "Conflicting classifications of pathogenicity", etc.). These don't
        // satisfy the ACMG sh:in constraint; surface as a gap.
        gaps.push({
          sourceField: `RCVAccession[${rcvAccession}]/Description`,
          reason: `Description text "${acmgText}" is not one of the five canonical ACMG values (Pathogenic, Likely pathogenic, Uncertain significance, Likely benign, Benign); cannot emit genomics:acmgClassification. v1-draft has no extended classification enum yet.`,
          severity: 'warning',
          context: rcvAccession,
        });
      }
    }

    // ---- Review status (TASK-2A.5 lookup table) ----
    if (reviewStatusStr) {
      const rsName = mapReviewStatus(reviewStatusStr);
      if (rsName) {
        quads.push(tripleRef(iri, GENOMICS_NS + 'reviewStatus', GENOMICS_NS + rsName));
      } else {
        gaps.push({
          sourceField: `RCVAccession[${rcvAccession}]/RCVClassifications/GermlineClassification/ReviewStatus`,
          reason: `Unknown ReviewStatus "${reviewStatusStr}"; not one of the seven published ClinGen tiers.`,
          severity: 'warning',
          context: rcvAccession,
        });
      }
    }

    // ---- Last-evaluated date ----
    if (dateLastEvaluated) {
      quads.push(tripleDate(iri, GENOMICS_NS + 'interpretedDate', dateLastEvaluated));
    }

    // ---- RCV accession (preserve as a stable identifier) ----
    quads.push(tripleStr(iri, GENOMICS_NS + 'clinvarRcvId', rcvAccession));

    // ---- Source identity passthrough ----
    quads.push(tripleStr(iri, NS.cascade + 'sourceFhirId', `${vcvAccession}:${rcvAccession}:${i}`));

    records.push({
      iri,
      cascadeType: 'genomics:VariantInterpretation',
      sourceId: `${rcvAccession}#${i}`,
      quads,
    });
  }

  return { records, warnings, gaps };
}
