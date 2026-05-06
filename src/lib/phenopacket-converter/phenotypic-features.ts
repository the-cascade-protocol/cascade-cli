/**
 * Phenopacket phenotypicFeatures → HPO term references on a patient.
 *
 * Each phenotypic feature is shaped:
 *
 *   {
 *     type:     { id: 'HP:0030084', label: 'Clinodactyly' }
 *     excluded: boolean (or `negated: true` in v1)
 *     onset:    { age: { iso8601duration: 'P3M' } }       // or an HPO onset term
 *     severity: { id: 'HP:0012825', label: 'Mild' }
 *     evidence: [...]
 *     modifiers: [{ id: 'HP:0012834', label: 'Right' }, ...]
 *   }
 *
 * Mapping to v1-draft genomics ontology:
 *
 *   feature.type.id           → genomics:hpoTerm   (xsd:string, multiple per patient)
 *   feature.excluded === true → genomics:negatedHpoTerm  (NEW PREDICATE — see gap)
 *   feature.onset.age         → genomics:phenotypeOnsetAge or onset string
 *   feature.severity          → no v1-draft slot — emit info gap
 *   feature.modifiers         → no v1-draft slot — emit info gap
 *   feature.evidence          → no v1-draft slot — emit info gap
 *
 * The v1-draft genomics ontology has `genomics:hpoTerm` (xsd:string) for
 * positive findings but NO dedicated negation slot. We use a synthetic
 * `genomics:negatedHpoTerm` predicate for excluded features and emit an
 * info gap so the gap audit catches the schema-evolution opportunity. The
 * concurrent vocab-evolution agent may add a structured term later — when
 * it does, this importer should switch.
 *
 * Acceptance: the retinoblastoma example's 4 HPO terms (Clinodactyly,
 * Leukocoria, Strabismus, Retinal detachment) are preserved on the patient.
 */

import { GENOMICS_NS } from './types.js';
import type { Quad } from './types.js';
import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import { tripleStr, tripleInt } from '../fhir-converter/types.js';

export interface PhenotypicFeaturesOutput {
  quads: Quad[];
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
  /** Number of features attached (positive + negated). */
  attached: number;
}

/**
 * Convert an ISO 8601 duration of the form `P##Y` (or `P##M`, `P##Y##M##D`)
 * to a whole-number year value when possible. Returns undefined if the
 * duration is unparseable or sub-year.
 */
function isoDurationToYears(d: string | undefined): number | undefined {
  if (!d || typeof d !== 'string') return undefined;
  const m = /^P(\d+)Y/.exec(d);
  if (m) return parseInt(m[1], 10);
  return undefined;
}

/**
 * Parse the `phenotypicFeatures[]` array of a phenopacket and emit
 * `genomics:hpoTerm` triples (or negation-form triples for excluded
 * features) on the given patient IRI. Contextual fields (onset, severity,
 * modifiers, evidence) emit info-severity gaps where v1-draft has no slot.
 *
 * Phenopacket v1 used the field name `negated`; v2 uses `excluded`. Both
 * are accepted.
 */
export function parsePhenotypicFeatures(
  features: any[] | undefined,
  patientIri: string,
  ctx: ImportContext,
  contextLabel: string,
): PhenotypicFeaturesOutput {
  void ctx;
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];
  let attached = 0;

  if (!Array.isArray(features) || features.length === 0) {
    return { quads, warnings, gaps, attached };
  }

  for (let i = 0; i < features.length; i++) {
    const feat = features[i] ?? {};
    const typeId: string | undefined = feat?.type?.id;
    const typeLabel: string | undefined = feat?.type?.label;
    const isExcluded = feat?.excluded === true || feat?.negated === true;

    if (typeof typeId !== 'string' || typeId.length === 0) {
      gaps.push({
        sourceField: `${contextLabel}.phenotypicFeatures[${i}].type.id`,
        reason: 'Phenotypic feature has no type.id — feature dropped.',
        severity: 'warning',
        context: contextLabel,
      });
      continue;
    }

    if (isExcluded) {
      // No structured negation slot in v1-draft; use a stable parallel
      // predicate and report the gap so the schema can evolve.
      quads.push(tripleStr(patientIri, GENOMICS_NS + 'negatedHpoTerm', typeId));
      gaps.push({
        sourceField: `${contextLabel}.phenotypicFeatures[${i}].excluded`,
        reason: `Excluded HPO term ${typeId} (${typeLabel ?? '<no label>'}) stored under genomics:negatedHpoTerm — v1-draft has no first-class negation slot.`,
        severity: 'info',
        context: contextLabel,
      });
    } else {
      quads.push(tripleStr(patientIri, GENOMICS_NS + 'hpoTerm', typeId));
    }
    attached += 1;

    // ---- onset (years if expressible, else info gap) ----
    const onsetIso: string | undefined = feat?.onset?.age?.iso8601duration;
    if (typeof onsetIso === 'string') {
      const years = isoDurationToYears(onsetIso);
      if (years !== undefined && !isExcluded) {
        // Only emit phenotypeOnsetAge for positive findings (range is
        // tied to the term, not the patient — but absent a per-term slot
        // we attach to the patient as a coarse signal).
        quads.push(tripleInt(patientIri, GENOMICS_NS + 'phenotypeOnsetAge', years));
      } else if (years === undefined) {
        gaps.push({
          sourceField: `${contextLabel}.phenotypicFeatures[${i}].onset.age.iso8601duration`,
          reason: `Sub-year onset duration ${onsetIso} dropped — v1-draft phenotypeOnsetAge is xsd:integer (years).`,
          severity: 'info',
          context: contextLabel,
        });
      }
    } else if (feat?.onset?.ontologyClass?.id) {
      // HPO onset term (e.g., HP:0011461 "Fetal onset") — info gap; we have
      // the positive HPO term recorded already; the onset class is lost.
      gaps.push({
        sourceField: `${contextLabel}.phenotypicFeatures[${i}].onset.ontologyClass`,
        reason: `Onset HPO class ${feat.onset.ontologyClass.id} (${feat.onset.ontologyClass.label ?? ''}) dropped — v1-draft has no per-feature onset-term slot.`,
        severity: 'info',
        context: contextLabel,
      });
    }

    // ---- severity ----
    if (feat?.severity?.id) {
      gaps.push({
        sourceField: `${contextLabel}.phenotypicFeatures[${i}].severity`,
        reason: `Severity ${feat.severity.id} (${feat.severity.label ?? ''}) dropped — v1-draft has no per-feature severity slot.`,
        severity: 'info',
        context: contextLabel,
      });
    }

    // ---- modifiers (laterality, frequency, etc.) ----
    if (Array.isArray(feat?.modifiers) && feat.modifiers.length > 0) {
      gaps.push({
        sourceField: `${contextLabel}.phenotypicFeatures[${i}].modifiers`,
        reason: `${feat.modifiers.length} modifier term(s) dropped — v1-draft has no per-feature modifiers slot.`,
        severity: 'info',
        context: contextLabel,
      });
    }

    // ---- evidence ----
    if (Array.isArray(feat?.evidence) && feat.evidence.length > 0) {
      gaps.push({
        sourceField: `${contextLabel}.phenotypicFeatures[${i}].evidence`,
        reason: `${feat.evidence.length} evidence reference(s) dropped — v1-draft has no per-feature evidence slot.`,
        severity: 'info',
        context: contextLabel,
      });
    }

    // ---- resolution (status: present/resolved/...) ----
    if (feat?.resolution || feat?.resolutionStatus) {
      gaps.push({
        sourceField: `${contextLabel}.phenotypicFeatures[${i}].resolution`,
        reason: 'Resolution status dropped — v1-draft has no per-feature resolution slot.',
        severity: 'info',
        context: contextLabel,
      });
    }
  }

  return { quads, warnings, gaps, attached };
}
