/**
 * ClinicalAssertion → SubmitterAssertion builder.
 *
 * Each ClinVar VCV's <ClinicalAssertionList> aggregates the individual
 * SCV submissions that contribute to the variant's aggregate
 * classification. Each ClinicalAssertion produces one
 * `genomics:SubmitterAssertion` record.
 *
 * Field mapping:
 *   <ClinVarAccession @Accession>        → genomics:scvAccession
 *                                          (primary key)
 *   <ClinVarAccession @SubmitterName>    → genomics:submitter
 *   <ClinVarAccession @OrgID>            → genomics:submitterOrgId
 *   <ClinVarAccession @OrganizationCategory>
 *                                        → genomics:submitterCategory (named individual)
 *   <Classification/GermlineClassification text>
 *                                        → genomics:assertedClassification
 *                                          (5-tier ACMG enum)
 *   <Classification/ReviewStatus>        → (info-gap; v1-draft has no
 *                                          per-SCV reviewStatus property,
 *                                          aggregate-level only)
 *   <Classification @DateLastEvaluated>  → (info-gap; v1-draft has no
 *                                          per-SCV assertionDate property)
 *   @ContributesToAggregateClassification → genomics:contributesToAggregate
 *
 * The brief mentions `genomics:supportsInterpretation` (Assertion →
 * Interpretation direction) but the v1-draft.0.1 vocabulary only declares
 * the opposite direction (`genomics:aggregatedFrom`, Interpretation →
 * Assertion). We emit `aggregatedFrom` triples on the matching
 * VariantInterpretation, derived via the TraitMapping table that links
 * each ClinicalAssertionID to a MedGen CUI / MONDO IRI. When no such
 * link can be established, the SubmitterAssertion is emitted unlinked
 * and a gap-info is surfaced.
 *
 * Note on the `genomics:assertionDate` / `genomics:assertionReviewStatus`
 * predicates referenced in the agent brief: these are NOT in v1-draft.0.1.
 * Per the brief's instruction ("if not yet there, emit info-severity
 * gap-warnings and continue"), we surface these as gaps and skip the
 * triples.
 */

import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import type { ClinvarParsedRecord, Quad } from './types.js';
import { GENOMICS_NS, ACMG_TEXT_TO_CLASS, SUBMITTER_CATEGORY_MAP } from './types.js';
import {
  NS,
  SCHEMA_VERSION,
  tripleType,
  tripleStr,
  tripleBool,
  tripleRef,
  deterministicUuid,
} from '../fhir-converter/types.js';

export interface ScvParseOutput {
  records: ClinvarParsedRecord[];
  /**
   * Aggregation links derived from TraitMapping: pairs of
   * (interpretation-key, submitterAssertion-iri) — the caller resolves
   * interpretation-key into the matching VariantInterpretation IRI and
   * emits the genomics:aggregatedFrom triple in that direction.
   *
   * interpretation-key is a normalized condition identifier (MedGen CUI,
   * MONDO accession, OMIM phenotype number, or label string) — the
   * caller does the matching against its own RCV-condition table.
   */
  aggregationHints: Array<{
    submitterAssertionIri: string;
    medgenCui?: string;
    mondoId?: string;
    omimId?: string;
    traitLabel?: string;
  }>;
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

function mintAssertionIri(
  scvAccession: string,
  ctx: ImportContext,
): string {
  const sys = ctx.sourceSystem ?? 'clinvar';
  return `urn:uuid:${deterministicUuid(`genomics:SubmitterAssertion:${sys}:${scvAccession}`)}`;
}

/**
 * Index <TraitMappingList> entries by ClinicalAssertionID, returning
 * each mapping's MedGen CUI / MONDO ID / OMIM ID for cross-link
 * resolution.
 */
export function buildTraitMappingIndex(
  classified: any,
): Map<string, Array<{ medgenCui?: string; mondoId?: string; omimId?: string; traitLabel?: string }>> {
  const idx = new Map<string, Array<{ medgenCui?: string; mondoId?: string; omimId?: string; traitLabel?: string }>>();
  const list = asArray(classified?.TraitMappingList?.TraitMapping);
  for (const tm of list) {
    const caId: string | undefined = tm?.['@_ClinicalAssertionID'];
    if (!caId) continue;
    const mappingRef: string | undefined = tm?.['@_MappingRef'];
    const mappingValue: string | undefined = tm?.['@_MappingValue'];
    const medgenCui: string | undefined = tm?.MedGen?.['@_CUI'];
    const traitLabel: string | undefined = tm?.MedGen?.['@_Name'];
    const entry: { medgenCui?: string; mondoId?: string; omimId?: string; traitLabel?: string } = {
      medgenCui,
      traitLabel,
    };
    if (mappingRef === 'MONDO' && mappingValue) entry.mondoId = mappingValue;
    if (mappingRef === 'OMIM' && mappingValue) entry.omimId = mappingValue;
    if (mappingRef === 'MedGen' && mappingValue && !entry.medgenCui) {
      entry.medgenCui = mappingValue;
    }

    const existing = idx.get(caId) ?? [];
    existing.push(entry);
    idx.set(caId, existing);
  }
  return idx;
}

/**
 * Parse a single ClinicalAssertion into a SubmitterAssertion record.
 */
export function parseClinicalAssertion(
  vcvAccession: string,
  ca: any,
  traitMappingIndex: Map<
    string,
    Array<{ medgenCui?: string; mondoId?: string; omimId?: string; traitLabel?: string }>
  >,
  ctx: ImportContext,
): { record: ClinvarParsedRecord; aggregationHints: ScvParseOutput['aggregationHints']; warnings: ImportWarning[]; gaps: VocabularyGap[] } | null {
  if (!ca || typeof ca !== 'object') return null;

  const clinicalAssertionId: string | undefined = ca?.['@_ID'];
  const clinVarAccession = ca?.ClinVarAccession;
  const scvAccession: string | undefined = clinVarAccession?.['@_Accession'];
  if (!scvAccession) return null; // Cannot mint identity without an SCV accession.

  const submitter: string | undefined = clinVarAccession?.['@_SubmitterName'];
  const orgId: string | undefined = clinVarAccession?.['@_OrgID'];
  const orgCategory: string | undefined = clinVarAccession?.['@_OrganizationCategory'];
  const submissionDate: string | undefined = ca?.['@_SubmissionDate'];
  const dateCreated: string | undefined = ca?.['@_DateCreated'];
  const dateLastUpdated: string | undefined = ca?.['@_DateLastUpdated'];
  const contributesAttr: string | undefined = ca?.['@_ContributesToAggregateClassification'];

  const recordStatus: string | undefined = textOf(ca?.RecordStatus);

  const classification = ca?.Classification;
  const reviewStatusStr: string | undefined = textOf(classification?.ReviewStatus);
  const dateLastEvaluated: string | undefined = classification?.['@_DateLastEvaluated'];
  // GermlineClassification / SomaticClinicalImpact / OncogenicityClassification
  // are normalized to arrays by the xml-parser config. Each is typically a
  // single text node (e.g. "Pathogenic"). Take the first.
  const germlineClassText: string | undefined = textOf(asArray(classification?.GermlineClassification)[0]);
  const somaticImpactText: string | undefined = textOf(asArray(classification?.SomaticClinicalImpact)[0]);
  const oncogenicityText: string | undefined = textOf(asArray(classification?.OncogenicityClassification)[0]);

  const iri = mintAssertionIri(scvAccession, ctx);
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];

  // ---- Type + provenance ----
  quads.push(tripleType(iri, GENOMICS_NS + 'SubmitterAssertion'));
  quads.push(tripleRef(iri, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'));
  quads.push(tripleStr(iri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));

  // ---- SCV accession (primary identifier) ----
  quads.push(tripleStr(iri, GENOMICS_NS + 'scvAccession', scvAccession));

  // ---- Submitter name (required by SubmitterAssertionShape) ----
  if (submitter) {
    quads.push(tripleStr(iri, GENOMICS_NS + 'submitter', submitter));
  } else {
    gaps.push({
      sourceField: `ClinicalAssertion[${clinicalAssertionId}]/ClinVarAccession@SubmitterName`,
      reason:
        'ClinicalAssertion has no SubmitterName; SubmitterAssertionShape requires genomics:submitter cardinality 1.',
      severity: 'warning',
      context: scvAccession,
    });
    warnings.push({
      message: `SubmitterAssertion ${scvAccession}: missing required submitter name`,
      recordRef: iri,
    });
  }

  // ---- Submitter organization ID ----
  if (orgId) {
    quads.push(tripleStr(iri, GENOMICS_NS + 'submitterOrgId', orgId));
  }

  // ---- Submitter category (named individual lookup) ----
  if (orgCategory) {
    const categoryName = SUBMITTER_CATEGORY_MAP[orgCategory.toLowerCase()];
    if (categoryName) {
      quads.push(
        tripleRef(iri, GENOMICS_NS + 'submitterCategory', GENOMICS_NS + categoryName),
      );
    } else {
      gaps.push({
        sourceField: `ClinicalAssertion[${clinicalAssertionId}]/ClinVarAccession@OrganizationCategory`,
        reason: `OrganizationCategory "${orgCategory}" has no SubmitterCategory mapping; v1-draft enum covers laboratory, consortium, expert-panel, research, single-clinician.`,
        severity: 'info',
        context: scvAccession,
      });
    }
  }

  // ---- Asserted classification ----
  // Prefer GermlineClassification; fall back to SomaticClinicalImpact /
  // OncogenicityClassification (these don't satisfy the 5-tier ACMG
  // sh:in constraint — surface as a gap and skip the triple).
  if (germlineClassText) {
    const acmgClass = ACMG_TEXT_TO_CLASS[germlineClassText.trim()];
    if (acmgClass) {
      quads.push(
        tripleRef(iri, GENOMICS_NS + 'assertedClassification', GENOMICS_NS + acmgClass),
      );
    } else {
      gaps.push({
        sourceField: `ClinicalAssertion[${clinicalAssertionId}]/Classification/GermlineClassification`,
        reason: `GermlineClassification "${germlineClassText}" is not one of the five canonical ACMG values; cannot emit genomics:assertedClassification. Common non-canonical strings: "Pathogenic, low penetrance", "established risk allele".`,
        severity: 'warning',
        context: scvAccession,
      });
    }
  } else if (somaticImpactText || oncogenicityText) {
    gaps.push({
      sourceField: `ClinicalAssertion[${clinicalAssertionId}]/Classification`,
      reason:
        'ClinicalAssertion classifies somatic impact or oncogenicity, not germline ACMG; v1-draft.0.1 has no genomics:somaticStatus / oncogenicityClass — these are v1-draft.0.2 candidates.',
      severity: 'info',
      context: scvAccession,
    });
  } else {
    gaps.push({
      sourceField: `ClinicalAssertion[${clinicalAssertionId}]/Classification`,
      reason:
        'ClinicalAssertion has no germline / somatic / oncogenicity classification text; SubmitterAssertionShape requires genomics:assertedClassification cardinality 1.',
      severity: 'warning',
      context: scvAccession,
    });
  }

  // ---- contributesToAggregate flag ----
  if (contributesAttr === 'true' || contributesAttr === 'false') {
    quads.push(tripleBool(iri, GENOMICS_NS + 'contributesToAggregate', contributesAttr === 'true'));
  }

  // ---- Per-SCV review-status / assertion-date / assertion-method ----
  // These are NOT in v1-draft.0.1. Per the agent brief: emit gap-info
  // and continue. The aggregate-level reviewStatus is on the
  // VariantInterpretation; per-SCV review status may be added in
  // v1-draft.0.2 as `genomics:assertionReviewStatus`.
  if (reviewStatusStr) {
    gaps.push({
      sourceField: `ClinicalAssertion[${clinicalAssertionId}]/Classification/ReviewStatus`,
      reason: `Per-SCV ReviewStatus "${reviewStatusStr}" has no v1-draft.0.1 predicate. Aggregate-level reviewStatus is on the parent VariantInterpretation. Candidate: genomics:assertionReviewStatus (v1-draft.0.2).`,
      severity: 'info',
      context: scvAccession,
    });
  }
  if (dateLastEvaluated) {
    gaps.push({
      sourceField: `ClinicalAssertion[${clinicalAssertionId}]/Classification@DateLastEvaluated`,
      reason: `Per-SCV DateLastEvaluated "${dateLastEvaluated}" has no v1-draft.0.1 predicate. Candidate: genomics:assertionDate (v1-draft.0.2).`,
      severity: 'info',
      context: scvAccession,
    });
  }
  if (submissionDate || dateCreated || dateLastUpdated) {
    gaps.push({
      sourceField: `ClinicalAssertion[${clinicalAssertionId}]/@SubmissionDate|@DateCreated|@DateLastUpdated`,
      reason:
        'Submission lifecycle dates have no v1-draft.0.1 predicate. Useful for chronology and audit; candidates for v1-draft.0.2.',
      severity: 'info',
      context: scvAccession,
    });
  }

  // ---- Methods + citations + assertion-method attribute set ----
  // These are v1-draft.0.2 candidates (genomics:assertionMethod, evidence
  // citation list). For now we surface as info gaps so the data isn't
  // silently dropped.
  const methods = asArray(ca?.ObservedInList?.ObservedIn).flatMap((o: any) =>
    asArray(o?.Method).map((m: any) => textOf(m?.MethodType)),
  );
  if (methods.some(Boolean)) {
    gaps.push({
      sourceField: `ClinicalAssertion[${clinicalAssertionId}]/ObservedInList/ObservedIn/Method`,
      reason: `Method types ${JSON.stringify(methods)} have no v1-draft predicate. Candidates: genomics:methodType (literature only / clinical testing / curation / research).`,
      severity: 'info',
      context: scvAccession,
    });
  }
  // Citations (PMIDs) — ClinVar carries them as <Citation><ID Source='PubMed'>...</ID></Citation>
  // No v1-draft predicate for per-assertion citations.
  const citations: string[] = [];
  for (const c of asArray(ca?.Classification?.Citation ?? ca?.Citation)) {
    const ids = asArray(c?.ID);
    for (const id of ids) {
      const src = id?.['@_Source'];
      const val = textOf(id);
      if (val) citations.push(`${src ?? '?'}:${val}`);
    }
  }
  if (citations.length > 0) {
    gaps.push({
      sourceField: `ClinicalAssertion[${clinicalAssertionId}]/Citation`,
      reason: `Citations carry ${citations.length} PMID/DOI references for the assertion's evidence. No v1-draft predicate; candidate genomics:supportingCitation (v1-draft.0.2).`,
      severity: 'info',
      context: scvAccession,
    });
  }
  // AssertionMethod attribute set (e.g., 'ACMG Guidelines, 2015',
  // 'ENIGMA BRCA1/2 Classification Criteria (2015)')
  for (const attrSet of asArray(ca?.AttributeSet)) {
    const attr = attrSet?.Attribute;
    const aType = attr?.['@_Type'];
    if (aType === 'AssertionMethod') {
      gaps.push({
        sourceField: `ClinicalAssertion[${clinicalAssertionId}]/AttributeSet[Type='AssertionMethod']`,
        reason: `Assertion method "${textOf(attr) ?? '<unknown>'}" — the criteria suite the submitter applied. No v1-draft predicate; candidate genomics:assertionMethod (v1-draft.0.2).`,
        severity: 'info',
        context: scvAccession,
      });
    }
  }

  // ---- RecordStatus (current / withdrawn / superseded) ----
  if (recordStatus && recordStatus !== 'current') {
    gaps.push({
      sourceField: `ClinicalAssertion[${clinicalAssertionId}]/RecordStatus`,
      reason: `RecordStatus "${recordStatus}" indicates a non-current record (withdrawn or superseded). v1-draft has no predicate to flag this state on a SubmitterAssertion.`,
      severity: 'info',
      context: scvAccession,
    });
  }

  // ---- Source identity passthrough ----
  quads.push(
    tripleStr(iri, NS.cascade + 'sourceFhirId', `${vcvAccession}:${scvAccession}`),
  );

  // ---- Aggregation hints ----
  // Resolve which Interpretations this Assertion contributed to via the
  // TraitMapping table (ClinicalAssertionID → MedGen CUI / MONDO ID).
  const aggregationHints: ScvParseOutput['aggregationHints'] = [];
  if (clinicalAssertionId) {
    const mappings = traitMappingIndex.get(clinicalAssertionId) ?? [];
    for (const m of mappings) {
      aggregationHints.push({
        submitterAssertionIri: iri,
        medgenCui: m.medgenCui,
        mondoId: m.mondoId,
        omimId: m.omimId,
        traitLabel: m.traitLabel,
      });
    }
    if (mappings.length === 0) {
      // No TraitMapping for this assertion — the assertion's TraitSet
      // can still be inspected, but the cross-link is best-effort.
      gaps.push({
        sourceField: `ClinicalAssertion[${clinicalAssertionId}]`,
        reason:
          'No <TraitMapping> entry for this ClinicalAssertion; cannot derive a deterministic genomics:aggregatedFrom link to a specific VariantInterpretation. The Assertion is emitted standalone.',
        severity: 'info',
        context: scvAccession,
      });
    }
  }

  return {
    record: {
      iri,
      cascadeType: 'genomics:SubmitterAssertion',
      sourceId: scvAccession,
      quads,
    },
    aggregationHints,
    warnings,
    gaps,
  };
}
