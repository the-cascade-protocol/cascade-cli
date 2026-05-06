/**
 * Public surface for the ClinVar VCV XML → Cascade converter.
 *
 * The orchestrator function `convertClinvarXml()` parses a VCV XML file,
 * walks every `<VariationArchive>` block, and returns the merged quad
 * stream + per-record metadata.
 *
 * Stub at TASK-2A.1: dispatcher returns an empty result for every input.
 * Subsequent tasks fill in:
 *   TASK-2A.2  — simple-allele.ts          (Variant)
 *   TASK-2A.3  — rcv-interpretation.ts     (VariantInterpretation, multi-condition)
 *   TASK-2A.4  — scv-submitter-assertion.ts (SubmitterAssertion per submitter)
 *   TASK-2A.5  — review-status-map.ts      (7-tier review-status enum)
 *   TASK-2A.6  — registry wire-up + e2e
 *   TASK-2A.7  — vocabulary gap audit
 *
 * VRS hashes (D-Q6) are preserved only — never computed.
 * Every Variant carries `dataQualityTier genomics:ClinicalGrade`
 * (D-QUALITY-TIER) because ClinVar aggregates clinical-lab submissions.
 */

import type { Quad } from 'n3';
import type {
  ImportContext,
  ImportWarning,
  VocabularyGap,
  ImportedIdentifier,
} from '../import-types.js';
import type { ClinvarParsedRecord } from './types.js';
import { parseClinvarXml } from './xml-parser.js';
import { parseSimpleAllele } from './simple-allele.js';
import { buildTraitSetIndex, parseRcvAccession } from './rcv-interpretation.js';
import {
  buildTraitMappingIndex,
  parseClinicalAssertion,
} from './scv-submitter-assertion.js';
import { GENOMICS_NS } from './types.js';
import { tripleRef } from '../fhir-converter/types.js';

export { detectClinvar } from './detect.js';
export { clinvarImporter } from './registry-entry.js';

export interface ClinvarConversionResult {
  records: ClinvarParsedRecord[];
  quads: Quad[];
  warnings: ImportWarning[];
  vocabularyGaps: VocabularyGap[];
  importedIdentifiers: ImportedIdentifier[];
  skippedCount: number;
}

/**
 * Walk a parsed ClinVar VCV XML tree and dispatch each VariationArchive
 * to the per-archive parser. The per-archive parser emits a Variant,
 * one VariantInterpretation per RCV, and one SubmitterAssertion per
 * ClinicalAssertion.
 *
 * At TASK-2A.1 this is a stub — it parses the XML to validate the
 * shape but emits zero records, just enough to satisfy the importer
 * registry contract end-to-end.
 */
export async function convertClinvarXml(
  xml: string,
  ctx: ImportContext,
): Promise<ClinvarConversionResult> {
  const records: ClinvarParsedRecord[] = [];
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const vocabularyGaps: VocabularyGap[] = [];
  const importedIdentifiers: ImportedIdentifier[] = [];
  let skippedCount = 0;

  // Parse defensively — malformed XML is not a hard error here; surface as a warning.
  let parsed: any;
  try {
    parsed = parseClinvarXml(xml);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push({ message: `ClinVar XML parse error: ${message}` });
    return { records, quads, warnings, vocabularyGaps, importedIdentifiers, skippedCount };
  }

  // Locate the VariationArchive list. ClinVar exports nest it inside
  // <ClinVarResult-Set>; older / alternative formats nest it directly.
  const archives: any[] = collectVariationArchives(parsed);
  if (archives.length === 0) {
    warnings.push({
      message:
        'ClinVar XML contained no <VariationArchive> elements; nothing to convert.',
    });
  }

  // Per-archive walk: emit a Variant from the SimpleAllele block.
  // RCV → VariantInterpretation and ClinicalAssertion → SubmitterAssertion
  // are wired up in TASK-2A.3 / 2A.4.
  for (const archive of archives) {
    const vcvAccession: string =
      archive?.['@_Accession'] ?? '<no-accession>';
    const vcvVariationId: string | undefined = archive?.['@_VariationID'];

    // ClinVar VariationArchive may carry either ClassifiedRecord (the
    // common case) or IncludedRecord (rarer; haplotype/genotype rollups).
    const classified = archive?.ClassifiedRecord ?? archive?.IncludedRecord;
    const simpleAllele = classified?.SimpleAllele;

    if (!simpleAllele) {
      vocabularyGaps.push({
        sourceField: `VariationArchive[${vcvAccession}]`,
        reason:
          'VariationArchive has no SimpleAllele block; only Haplotype / Genotype variants are present (deferred — no v1-draft Cascade representation for ClinVar haplotype-level records yet).',
        severity: 'warning',
        context: vcvAccession,
      });
      skippedCount += 1;
      continue;
    }

    // ---- Variant ----
    const out = parseSimpleAllele(vcvAccession, vcvVariationId, simpleAllele, ctx);
    if (!out) {
      skippedCount += 1;
      continue;
    }
    records.push(out.record);
    quads.push(...out.record.quads);
    warnings.push(...out.warnings);
    vocabularyGaps.push(...out.gaps);
    importedIdentifiers.push({
      cascadeIri: out.record.iri,
      cascadeType: out.record.cascadeType,
      sourceType: 'ClinVar.VariationArchive',
      sourceId: vcvAccession,
    });

    const variantIri = out.record.iri;

    // ---- Aggregate Classifications block (citations, conditions, criteria) ----
    // The VariationArchive's <Classifications>/<GermlineClassification> at
    // the variant-level carries the curated aggregate (review status,
    // SubmissionCount, Citations, ConditionList). Most of this is
    // redundant with the per-RCV / per-SCV blocks we already process,
    // but the rich citation list and explicit aggregate ContributesToAggregate
    // counts have no per-record analogue. Surface as a single info gap
    // so downstream tooling knows the source carries the aggregate.
    if (classified?.Classifications) {
      const agg = Array.isArray(classified.Classifications.GermlineClassification)
        ? classified.Classifications.GermlineClassification[0]
        : classified.Classifications.GermlineClassification;
      if (agg?.Citation) {
        const citCount = Array.isArray(agg.Citation) ? agg.Citation.length : 1;
        vocabularyGaps.push({
          sourceField: `VariationArchive[${vcvAccession}]/Classifications/GermlineClassification/Citation`,
          reason: `Aggregate-level Classifications block carries ${citCount} curated citations (PubMed, DOI). No v1-draft predicate at the Variant level; candidate genomics:supportingEvidence (v1-draft.0.2).`,
          severity: 'info',
          context: vcvAccession,
        });
      }
      if (agg?.['@_NumberOfSubmissions']) {
        vocabularyGaps.push({
          sourceField: `VariationArchive[${vcvAccession}]/Classifications/GermlineClassification/@NumberOfSubmissions|@NumberOfSubmitters`,
          reason: `Aggregate counts (NumberOfSubmissions, NumberOfSubmitters) drive the ClinGen star-rating UI. No v1-draft predicate; candidate genomics:numberOfSubmitters.`,
          severity: 'info',
          context: vcvAccession,
        });
      }
    }

    // ---- TraitMappingList (referenced from SCVs; here we surface it as a separate field) ----
    if (classified?.TraitMappingList) {
      vocabularyGaps.push({
        sourceField: `VariationArchive[${vcvAccession}]/TraitMappingList`,
        reason:
          'TraitMappingList connects each ClinicalAssertion to a normalized condition (MedGen / MONDO / OMIM). The mapping is consumed during SCV → SubmitterAssertion aggregation, but the per-mapping evidence (MappingType, MappingValue) is not preserved on the resulting graph.',
        severity: 'info',
        context: vcvAccession,
      });
    }


    // ---- RCVAccession → VariantInterpretation (one per condition; D-Q5) ----
    const traitSetIndex = buildTraitSetIndex(classified?.Classifications);
    const rcvList: any[] = Array.isArray(classified?.RCVList?.RCVAccession)
      ? classified.RCVList.RCVAccession
      : classified?.RCVList?.RCVAccession
      ? [classified.RCVList.RCVAccession]
      : [];

    // Track each Interpretation's matchable condition keys for SCV
    // aggregation. A SubmitterAssertion's TraitMapping points at a
    // MedGen CUI / MONDO ID; we use these to find the matching
    // VariantInterpretation and emit `genomics:aggregatedFrom`.
    const interpretationsByKey = new Map<string, string[]>();
    const recordKey = (key: string, iri: string) => {
      const existing = interpretationsByKey.get(key) ?? [];
      existing.push(iri);
      interpretationsByKey.set(key, existing);
    };

    for (const rcv of rcvList) {
      const rcvOut = parseRcvAccession(
        vcvAccession,
        variantIri,
        rcv,
        traitSetIndex,
        ctx,
      );

      // Pre-compute the per-condition keys for THIS RCV, paralleling the
      // index expansion in parseRcvAccession. Each Interpretation
      // corresponds to one condition entry; we want to index by every
      // matchable identifier (MONDO ID, MedGen CUI, OMIM phenotype) so
      // SCV TraitMapping cross-refs resolve regardless of which
      // identifier the trait happened to carry.
      const ccs: any[] = Array.isArray(rcv?.ClassifiedConditionList?.ClassifiedCondition)
        ? rcv.ClassifiedConditionList.ClassifiedCondition
        : rcv?.ClassifiedConditionList?.ClassifiedCondition
        ? [rcv.ClassifiedConditionList.ClassifiedCondition]
        : [];
      const traitSetId: string | undefined = rcv?.ClassifiedConditionList?.['@_TraitSetID'];
      const mondoFromTraitSet = traitSetId ? traitSetIndex.get(traitSetId) ?? [] : [];

      for (let i = 0; i < rcvOut.records.length; i++) {
        const rec = rcvOut.records[i];
        records.push(rec);
        quads.push(...rec.quads);
        importedIdentifiers.push({
          cascadeIri: rec.iri,
          cascadeType: rec.cascadeType,
          sourceType: 'ClinVar.RCVAccession',
          sourceId: rec.sourceId,
        });

        // Direct DB/ID on the ClassifiedCondition.
        const cc = ccs[i];
        const ccDb: string | undefined = cc?.['@_DB'];
        const ccId: string | undefined = cc?.['@_ID'];
        if (ccDb === 'MedGen' && ccId) {
          recordKey(`medgen:${ccId}`, rec.iri);
        }
        if (ccDb === 'MONDO' && ccId) {
          // Normalize 'MONDO:0011450' as the index key.
          recordKey(`mondo:${ccId}`, rec.iri);
        }
        // Cross-reference resolutions from the Trait block (MONDO, MedGen).
        const traitInfo = mondoFromTraitSet[i];
        if (traitInfo?.mondoIri) {
          // mondoIri is the OBO PURL; convert back to 'MONDO:00..' form
          // for index keying.
          const numeric = traitInfo.mondoIri.replace(
            'http://purl.obolibrary.org/obo/MONDO_',
            '',
          );
          recordKey(`mondo:MONDO:${numeric}`, rec.iri);
        }
        if (traitInfo?.medgenId) {
          recordKey(`medgen:${traitInfo.medgenId}`, rec.iri);
        }

        // Also index by quads (covers any case the above missed).
        for (const q of rec.quads) {
          if (q.predicate.value === GENOMICS_NS + 'mondoId') {
            recordKey(`mondo:${q.object.value}`, rec.iri);
          } else if (q.predicate.value === GENOMICS_NS + 'condition') {
            recordKey(`iri:${q.object.value}`, rec.iri);
            const maybeMedgen = q.object.value.startsWith(
              'https://www.ncbi.nlm.nih.gov/medgen/',
            )
              ? q.object.value.replace('https://www.ncbi.nlm.nih.gov/medgen/', '')
              : undefined;
            if (maybeMedgen) recordKey(`medgen:${maybeMedgen}`, rec.iri);
          }
        }
      }
      warnings.push(...rcvOut.warnings);
      vocabularyGaps.push(...rcvOut.gaps);
    }

    // ---- ClinicalAssertion → SubmitterAssertion ----
    const traitMappingIndex = buildTraitMappingIndex(classified);
    const caList: any[] = Array.isArray(classified?.ClinicalAssertionList?.ClinicalAssertion)
      ? classified.ClinicalAssertionList.ClinicalAssertion
      : classified?.ClinicalAssertionList?.ClinicalAssertion
      ? [classified.ClinicalAssertionList.ClinicalAssertion]
      : [];

    for (const ca of caList) {
      const scvOut = parseClinicalAssertion(vcvAccession, ca, traitMappingIndex, ctx);
      if (!scvOut) {
        skippedCount += 1;
        continue;
      }
      records.push(scvOut.record);
      quads.push(...scvOut.record.quads);
      importedIdentifiers.push({
        cascadeIri: scvOut.record.iri,
        cascadeType: scvOut.record.cascadeType,
        sourceType: 'ClinVar.ClinicalAssertion',
        sourceId: scvOut.record.sourceId,
      });
      warnings.push(...scvOut.warnings);
      vocabularyGaps.push(...scvOut.gaps);

      // Resolve aggregation hints → genomics:aggregatedFrom triples on
      // the matching VariantInterpretation(s). Try keys in priority
      // order: MONDO > MedGen CUI. If none match, fall back to MedGen
      // CUI direct (some RCVs reference conditions by CUI only).
      const matchedInterpretations = new Set<string>();
      for (const hint of scvOut.aggregationHints) {
        const tryKeys: string[] = [];
        if (hint.mondoId) tryKeys.push(`mondo:${hint.mondoId}`);
        if (hint.medgenCui) tryKeys.push(`medgen:${hint.medgenCui}`);
        for (const key of tryKeys) {
          for (const iri of interpretationsByKey.get(key) ?? []) {
            matchedInterpretations.add(iri);
          }
        }
      }
      for (const iri of matchedInterpretations) {
        quads.push(
          tripleRef(iri, GENOMICS_NS + 'aggregatedFrom', scvOut.record.iri),
        );
      }
    }
  }

  return {
    records,
    quads,
    warnings,
    vocabularyGaps,
    importedIdentifiers,
    skippedCount,
  };
}

/**
 * Collect every VariationArchive node from a parsed ClinVar XML tree,
 * regardless of which root wrapper was used. Always returns an array
 * (the xml-parser configuration normalizes single-archive bundles).
 */
export function collectVariationArchives(parsed: any): any[] {
  if (!parsed || typeof parsed !== 'object') return [];
  // Common case: <ClinVarResult-Set><VariationArchive>...
  const wrapper =
    parsed['ClinVarResult-Set'] ??
    parsed.ReleaseSet ??
    parsed.ClinVarSet ??
    parsed;
  const archives = wrapper?.VariationArchive;
  if (Array.isArray(archives)) return archives;
  if (archives && typeof archives === 'object') return [archives];

  // <VariationReport> single-record form: treat the report itself as a
  // VariationArchive-equivalent and let the per-archive parser cope.
  if (parsed.VariationReport) {
    return Array.isArray(parsed.VariationReport)
      ? parsed.VariationReport
      : [parsed.VariationReport];
  }

  return [];
}
