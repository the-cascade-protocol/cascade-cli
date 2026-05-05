/**
 * Diagnostic-implication Observation parser.
 *
 * Maps FHIR Genomics IG `diagnostic-implication`-profiled Observations to
 * `genomics:VariantInterpretation` records.
 *
 * Mapping:
 *   derivedFrom[*]                       →  genomics:variantInterpreted
 *     (cardinality 1..1 in v1-draft per D-Q5; if multiple are present the
 *      first is taken, others are gap-warned.)
 *   component[code=53037-8]              →  genomics:acmgClassification
 *     (valueCodeableConcept's LOINC answer code → AcmgClass named individual:
 *      LA6668-3 → Pathogenic, LA26332-9 → LikelyPathogenic, LA26333-7 → VUS,
 *      LA26334-5 → LikelyBenign, LA6675-8 → Benign.)
 *   component[code=81259-4]              →  genomics:condition (one
 *     VariantInterpretation per condition coding per D-Q5).
 *
 * Per D-Q5: each VariantInterpretation has cardinality 1..1 on `condition`.
 * If the source Observation references multiple conditions we emit ONE
 * Interpretation PER CONDITION (each linking back to the same Variant).
 *
 * Per D-QUALITY-TIER: any Pathogenic / LikelyPathogenic interpretation must
 * either reference a ClinicalGrade Variant OR carry requiresConfirmation
 * true. FHIR Genomics IG bundles produce ClinicalGrade Variants by
 * construction (see TASK-1.2), so this constraint is structurally satisfied
 * — we don't set requiresConfirmation in Phase 1. (Phase 2C consumer-array
 * importer will set it on every Pathogenic/LikelyPathogenic interpretation.)
 */

import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import {
  GENOMICS_NS,
  CODING_SYSTEMS,
  LOINC,
  ACMG_LOINC_TO_CLASS,
  type ParsedRecord,
  type Quad,
} from './types.js';
import {
  componentsByLoinc,
  firstComponentByLoinc,
  findCoding,
  ccDisplayOrCode,
} from './observation-utils.js';
import {
  NS,
  SCHEMA_VERSION,
  tripleType,
  tripleStr,
  tripleRef,
  tripleDate,
  deterministicUuid,
} from '../fhir-converter/types.js';

export interface DiagnosticImplicationParseOutput {
  records: ParsedRecord[];
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

function mintInterpretationIri(
  resource: any,
  conditionCode: string,
  ctx: ImportContext,
): string {
  const id = resource?.id ?? Math.random().toString(36);
  const sys = ctx.sourceSystem ?? 'fhir-genomics';
  return `urn:uuid:${deterministicUuid(`genomics:VariantInterpretation:${sys}:${id}:${conditionCode}`)}`;
}

/**
 * Resolve a FHIR Reference through the idIndex.
 */
function resolveRef(
  ref: { reference?: string } | undefined,
  idIndex: Map<string, string>,
): string | undefined {
  const r = ref?.reference;
  if (!r) return undefined;
  if (idIndex.has(r)) return idIndex.get(r);
  const slashIdx = r.indexOf('/');
  if (slashIdx > 0 && idIndex.has(r.slice(slashIdx + 1))) {
    return idIndex.get(r.slice(slashIdx + 1));
  }
  if (r.startsWith('urn:uuid:')) return r;
  return undefined;
}

/**
 * Map a condition CodeableConcept's first coding to a stable label-key
 * used to disambiguate multiple Interpretations from the same source obs.
 */
function conditionKey(cc: { coding?: any[] } | undefined): string {
  const c = cc?.coding?.[0];
  if (!c) return 'unknown';
  return `${c.system ?? ''}:${c.code ?? ''}`;
}

/**
 * Mondo / OMIM / Orphanet condition coding extraction. Returns the IRI for
 * the condition (URI form per the v1-draft genomics ontology) plus the
 * structured ID values to attach.
 */
function conditionTriples(
  subjectIri: string,
  cc: { coding?: any[] } | undefined,
): {
  triples: Quad[];
  conditionIri: string | undefined;
  /** True when at least one structured (MONDO/OMIM/Orpha) coding was found. */
  matched: boolean;
} {
  if (!cc) return { triples: [], conditionIri: undefined, matched: false };
  const triples: Quad[] = [];
  let conditionIri: string | undefined;
  let matched = false;

  const mondo = cc.coding?.find(
    (c: any) =>
      c?.system === CODING_SYSTEMS.mondo ||
      c?.system === 'http://purl.obolibrary.org/obo/MONDO' ||
      (typeof c?.code === 'string' && c.code.startsWith('MONDO:')),
  );
  if (mondo?.code) {
    triples.push(tripleStr(subjectIri, GENOMICS_NS + 'mondoId', mondo.code));
    conditionIri = `http://purl.obolibrary.org/obo/MONDO_${mondo.code.replace(/^MONDO:/, '')}`;
    triples.push(tripleRef(subjectIri, GENOMICS_NS + 'condition', conditionIri));
    matched = true;
  }

  const omim = cc.coding?.find(
    (c: any) =>
      c?.system === 'https://omim.org' ||
      c?.system === 'http://www.omim.org' ||
      c?.system === 'https://www.omim.org' ||
      (typeof c?.code === 'string' && /^\d{6}$/.test(c.code)),
  );
  if (omim?.code) {
    triples.push(tripleStr(subjectIri, GENOMICS_NS + 'omimId', omim.code));
    if (!conditionIri) {
      conditionIri = `https://omim.org/entry/${omim.code}`;
      triples.push(tripleRef(subjectIri, GENOMICS_NS + 'condition', conditionIri));
    }
    matched = true;
  }

  const orpha = cc.coding?.find(
    (c: any) =>
      typeof c?.code === 'string' &&
      (c.code.startsWith('ORPHA:') || c.code.startsWith('Orphanet')),
  );
  if (orpha?.code) {
    triples.push(tripleStr(subjectIri, GENOMICS_NS + 'orphaCode', orpha.code));
    if (!conditionIri) {
      conditionIri = `http://www.orpha.net/ORDO/Orphanet_${orpha.code.replace(/^ORPHA:/, '')}`;
      triples.push(tripleRef(subjectIri, GENOMICS_NS + 'condition', conditionIri));
    }
    matched = true;
  }

  return { triples, conditionIri, matched };
}

export function parseDiagnosticImplication(
  resource: any,
  idIndex: Map<string, string>,
  ctx: ImportContext,
): DiagnosticImplicationParseOutput | null {
  if (!resource || resource.resourceType !== 'Observation') return null;

  const sourceId: string = resource.id ?? '<no-id>';
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];

  // ---- Resolve the variant being interpreted ----
  // FHIR Genomics IG diagnostic-implication uses derivedFrom for the
  // Variant Observation reference. (v1-draft cardinality 1..1.)
  const derived: any[] = resource.derivedFrom ?? [];
  let variantIri: string | undefined;
  let unresolvedCount = 0;
  for (const ref of derived) {
    const resolved = resolveRef(ref, idIndex);
    if (resolved) {
      if (!variantIri) {
        variantIri = resolved;
      } else {
        // multi-variant — extras are gap-warned
        unresolvedCount += 1;
      }
    }
  }
  if (!variantIri) {
    gaps.push({
      sourceField: `Observation/${sourceId}.derivedFrom`,
      reason: 'Diagnostic-implication has no resolvable Variant reference; cannot link variantInterpreted (cardinality 1..1).',
      severity: 'warning',
      context: sourceId,
    });
    warnings.push({
      message: `Diagnostic-implication ${sourceId}: no resolvable Variant reference; record skipped.`,
    });
    return { records: [], warnings, gaps };
  }
  if (unresolvedCount > 0) {
    gaps.push({
      sourceField: `Observation/${sourceId}.derivedFrom`,
      reason: `Diagnostic-implication references ${unresolvedCount + 1} Variants; v1-draft cardinality 1..1 — only the first is materialized.`,
      severity: 'warning',
      context: sourceId,
    });
  }

  // ---- ACMG classification (LOINC 53037-8 component) ----
  const acmgComp = firstComponentByLoinc(resource, LOINC.variantClinSignificance);
  let acmgIndividual: string | undefined;
  if (acmgComp?.valueCodeableConcept) {
    const loincAnswer = findCoding(acmgComp.valueCodeableConcept, CODING_SYSTEMS.loinc);
    if (loincAnswer?.code && ACMG_LOINC_TO_CLASS[loincAnswer.code]) {
      acmgIndividual = ACMG_LOINC_TO_CLASS[loincAnswer.code];
    } else {
      gaps.push({
        sourceField: `Observation/${sourceId}.component[53037-8].value`,
        reason: `ACMG classification LOINC answer code ${loincAnswer?.code ?? '<missing>'} not recognized.`,
        severity: 'warning',
        context: sourceId,
      });
    }
  }

  // ---- Condition components (LOINC 81259-4) ----
  // Per D-Q5: cardinality 1..1 — emit ONE VariantInterpretation per condition.
  const conditionComps = componentsByLoinc(resource, LOINC.associatedCondition);
  const records: ParsedRecord[] = [];

  if (conditionComps.length === 0) {
    gaps.push({
      sourceField: `Observation/${sourceId}.component[81259-4]`,
      reason: 'Diagnostic-implication has no associated-phenotype component (LOINC 81259-4); SHACL cardinality 1..1 on genomics:condition cannot be satisfied. Record skipped.',
      severity: 'warning',
      context: sourceId,
    });
    return { records: [], warnings, gaps };
  }

  // Interpretation date — fall back to issued / effective.
  const issued: string | undefined = resource.issued ?? resource.effectiveDateTime;
  const performer = resource.performer?.[0]?.display ?? resource.performer?.[0]?.reference;

  for (const cc of conditionComps) {
    const condCcc = cc.valueCodeableConcept;
    const key = conditionKey(condCcc);
    const iri = mintInterpretationIri(resource, key, ctx);
    const quads: Quad[] = [];

    quads.push(tripleType(iri, GENOMICS_NS + 'VariantInterpretation'));
    quads.push(tripleRef(iri, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'));
    quads.push(tripleStr(iri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));

    quads.push(tripleRef(iri, GENOMICS_NS + 'variantInterpreted', variantIri));

    if (acmgIndividual) {
      quads.push(tripleRef(iri, GENOMICS_NS + 'acmgClassification', GENOMICS_NS + acmgIndividual));
    }

    // Condition triples (mondoId / omimId / orphaCode + condition IRI ref)
    const { triples: condTriples, matched } = conditionTriples(iri, condCcc);
    if (matched) {
      quads.push(...condTriples);
    } else {
      const display = ccDisplayOrCode(condCcc) ?? '<unknown>';
      gaps.push({
        sourceField: `Observation/${sourceId}.component[81259-4].value`,
        reason: `Associated-condition coding "${display}" doesn't match a recognized vocabulary (MONDO/OMIM/Orphanet); cardinality 1..1 on genomics:condition not structurally satisfied.`,
        severity: 'warning',
        context: sourceId,
      });
    }

    if (issued) {
      // interpretedDate is xsd:date (per ontology) — use date-only form.
      // Year-only strings (Genomics IG corpus has 'effectiveDateTime: 2016')
      // would fail xsd:date validation; upgrade to YYYY-01-01.
      let dateOnly = String(issued).split('T')[0];
      if (/^\d{4}$/.test(dateOnly)) dateOnly = `${dateOnly}-01-01`;
      if (/^\d{4}-\d{2}$/.test(dateOnly)) dateOnly = `${dateOnly}-01`;
      quads.push(tripleDate(iri, GENOMICS_NS + 'interpretedDate', dateOnly));
    }
    if (performer) {
      quads.push(tripleStr(iri, GENOMICS_NS + 'interpretedBy', performer));
    }

    quads.push(tripleStr(iri, NS.cascade + 'sourceFhirId', sourceId));

    records.push({
      iri,
      cascadeType: 'genomics:VariantInterpretation',
      sourceId,
      fhirResourceType: 'Observation',
      quads,
    });
  }

  return { records, warnings, gaps };
}
