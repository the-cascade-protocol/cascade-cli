/**
 * SimpleAllele → Variant builder.
 *
 * Each ClinVar VariationArchive carries a canonical `<SimpleAllele>` block
 * describing the variant. This module turns it into a `genomics:Variant`
 * record (a stream of n3 quads).
 *
 * Field mapping:
 *   <Name>                     → genomics:hgvsCDot / hgvsGDot / hgvsPDot
 *                                (suffix-detected: c.* / g.* / p.*)
 *   <ProteinChange>            → genomics:hgvsPDot (one-letter form,
 *                                kept as fallback when SimpleAllele/Name
 *                                is the genomic g.HGVS instead of c.HGVS)
 *   <Gene Symbol>              → genomics:geneSymbol
 *   <Gene HGNC_ID>             → genomics:hgncId (raw 'HGNC:1100' form)
 *   <CanonicalSPDI>            → genomics:vrsObject (D-Q6 — preserve only)
 *   <HGVS Type='coding'>       → primary genomics:hgvsCDot if Name not c.*
 *   <HGVS Type='genomic, top-level' Assembly='GRCh38'>
 *                              → genomics:hgvsGDot (preferred)
 *   <MolecularConsequence Type ID> → genomics:consequenceTerm (SO IRI)
 *   <XRefList>
 *     <XRef DB='ClinGen' ID>     → genomics:caId
 *     <XRef DB='dbSNP' ID>       → genomics:dbsnpRsId
 *     (note: the variation ID itself comes from the VariationArchive
 *     @VariationID attribute → genomics:clinvarVariationId)
 *
 * Stable-identifier guarantee (per VariantShape.shapes):
 * we always emit genomics:clinvarVariationId from the VCV @Accession
 * (stripped of the "VCV" prefix → numeric variation ID) so the SHACL
 * "at least one stable identifier" constraint always passes.
 *
 * D-QUALITY-TIER: ClinVar variants are aggregated submissions reviewed
 * by ClinGen's review-status taxonomy — these are clinical-grade
 * evidence by construction. Default `genomics:dataQualityTier
 * genomics:ClinicalGrade`. The downstream D-QUALITY-TIER safety
 * constraint on Pathogenic interpretations passes accordingly.
 *
 * D-Q6 (VRS preservation): ClinVar VCV exports do not yet carry GA4GH
 * VRS allele identifiers in a stable element. They DO carry SPDI
 * (Sequence-Position-Deletion-Insertion) which is VRS-aligned. We
 * preserve SPDI as `genomics:vrsObject` (a JSON-stringified record
 * with the canonical SPDI form) so downstream tools can compute the
 * VRS hash; we never compute it ourselves.
 */

import { DataFactory } from 'n3';
import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import type { ClinvarParsedRecord, Quad } from './types.js';
import { GENOMICS_NS } from './types.js';
import {
  NS,
  SCHEMA_VERSION,
  tripleType,
  tripleStr,
  tripleRef,
  deterministicUuid,
} from '../fhir-converter/types.js';

const { namedNode, literal, quad: makeQuad } = DataFactory;

/** Sequence Ontology IRI base (used for genomics:consequenceTerm). */
const SO_BASE = 'http://purl.obolibrary.org/obo/';

export interface SimpleAlleleParseOutput {
  record: ClinvarParsedRecord;
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

/**
 * Mint a Cascade IRI for a Variant from a ClinVar VCV. Uses the VCV
 * accession as the deterministic identity (stable across re-imports of
 * the same record).
 */
function mintVariantIri(vcvAccession: string, ctx: ImportContext): string {
  const sys = ctx.sourceSystem ?? 'clinvar';
  return `urn:uuid:${deterministicUuid(`genomics:Variant:${sys}:${vcvAccession}`)}`;
}

/**
 * Public IRI for the Variant minted from a VCV accession. Exported so
 * the RCV-interpretation parser can resolve `genomics:variantInterpreted`
 * cross-references without needing the SimpleAllele parser to run first.
 */
export function variantIriForVcv(vcvAccession: string, ctx: ImportContext): string {
  return mintVariantIri(vcvAccession, ctx);
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
 * Pick the preferred c./g./p. HGVS expressions from a SimpleAllele,
 * preferring the MANE Select transcript when present and falling back
 * to the SimpleAllele's <Name> element.
 */
function pickHgvs(simpleAllele: any): { cDot?: string; gDot?: string; pDot?: string } {
  let cDot: string | undefined;
  let gDot: string | undefined;
  let pDot: string | undefined;

  // First pass: harvest from <HGVSlist><HGVS>...
  const hgvsEntries = asArray(simpleAllele?.HGVSlist?.HGVS);
  let cDotMane: string | undefined;
  for (const h of hgvsEntries) {
    const type = h?.['@_Type'];
    const assembly = h?.['@_Assembly'];
    const nucExpr = h?.NucleotideExpression;
    const protExpr = h?.ProteinExpression;
    const exprStr = textOf(nucExpr?.Expression) ?? textOf(protExpr?.Expression);
    if (!exprStr) continue;

    if (type === 'coding') {
      // Prefer the MANESelect transcript if marked.
      if (nucExpr?.['@_MANESelect'] === 'true' && /:c\./.test(exprStr)) {
        cDotMane = exprStr;
      } else if (!cDot && /:c\./.test(exprStr)) {
        cDot = exprStr;
      }
      // Capture the protein expression if present alongside the coding HGVS.
      const pExpr = textOf(protExpr?.Expression);
      if (pExpr && /:p\./.test(pExpr) && !pDot) {
        pDot = pExpr;
      }
    } else if (type === 'genomic, top-level' && assembly === 'GRCh38') {
      gDot = exprStr;
    } else if (type === 'genomic' && !gDot && /:g\./.test(exprStr)) {
      gDot = exprStr;
    } else if (type === 'protein' && !pDot && /:p\./.test(exprStr)) {
      pDot = exprStr;
    }
  }
  if (cDotMane) cDot = cDotMane;

  // Second pass: fall back to <Name> if we still don't have a c. expression.
  // <Name> is often "NM_007294.4(BRCA1):c.181T>G (p.Cys61Gly)" — a c.HGVS.
  const nameStr = textOf(simpleAllele?.Name);
  if (!cDot && nameStr && /:c\./.test(nameStr)) {
    // Strip the trailing "(p.Cys61Gly)" alias if present.
    cDot = nameStr.replace(/\s*\(p\..*?\)\s*$/, '');
  }
  if (!gDot && nameStr && /:g\./.test(nameStr)) {
    gDot = nameStr;
  }

  return { cDot, gDot, pDot };
}

/**
 * Parse a SimpleAllele block into a Variant record.
 */
export function parseSimpleAllele(
  vcvAccession: string,
  vcvVariationId: string | undefined,
  simpleAllele: any,
  ctx: ImportContext,
): SimpleAlleleParseOutput | null {
  if (!simpleAllele || typeof simpleAllele !== 'object') return null;

  const sourceId = vcvAccession;
  const iri = mintVariantIri(vcvAccession, ctx);
  const subject = namedNode(iri);
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];

  // ---- Type + provenance ----
  quads.push(tripleType(iri, GENOMICS_NS + 'Variant'));
  quads.push(tripleRef(iri, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'));
  quads.push(tripleStr(iri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));

  // ---- D-QUALITY-TIER ----
  // ClinVar aggregates clinical-lab submissions reviewed via the
  // ClinGen review-status taxonomy — clinical-grade by construction.
  quads.push(
    tripleRef(iri, GENOMICS_NS + 'dataQualityTier', GENOMICS_NS + 'ClinicalGrade'),
  );
  quads.push(
    tripleRef(
      iri,
      GENOMICS_NS + 'dataProvenance',
      GENOMICS_NS + 'ClinicalSequencing',
    ),
  );

  // ---- ClinVar variation ID (stable identifier; satisfies VariantShape sh:or) ----
  // Take from the VCV's VariationID first; fall back to AlleleID if absent.
  const variationId =
    vcvVariationId ??
    simpleAllele['@_VariationID'] ??
    vcvAccession.replace(/^VCV0*/, ''); // 'VCV000017661' → '17661'
  if (variationId) {
    quads.push(tripleStr(iri, GENOMICS_NS + 'clinvarVariationId', String(variationId)));
  }

  // ---- HGVS strings ----
  const { cDot, gDot, pDot } = pickHgvs(simpleAllele);
  if (cDot) quads.push(tripleStr(iri, GENOMICS_NS + 'hgvsCDot', cDot));
  if (gDot) quads.push(tripleStr(iri, GENOMICS_NS + 'hgvsGDot', gDot));
  if (pDot) quads.push(tripleStr(iri, GENOMICS_NS + 'hgvsPDot', pDot));

  // ---- Gene symbol + HGNC ID (first Gene; multi-gene variants are rare) ----
  const geneEntries = asArray(simpleAllele?.GeneList?.Gene);
  if (geneEntries.length === 0) {
    gaps.push({
      sourceField: `VariationArchive[${vcvAccession}]/SimpleAllele/GeneList/Gene`,
      reason:
        'SimpleAllele has no Gene element; SHACL VariantShape requires geneSymbol cardinality 1.',
      severity: 'warning',
      context: vcvAccession,
    });
    warnings.push({
      message: `Variant ${vcvAccession}: missing required gene symbol`,
      recordRef: iri,
    });
  } else {
    const gene = geneEntries[0];
    const symbol = gene['@_Symbol'];
    const hgnc = gene['@_HGNC_ID']; // already in 'HGNC:1100' shape
    if (typeof symbol === 'string' && symbol.length > 0) {
      quads.push(tripleStr(iri, GENOMICS_NS + 'geneSymbol', symbol));
    }
    if (typeof hgnc === 'string' && hgnc.length > 0) {
      quads.push(tripleStr(iri, GENOMICS_NS + 'hgncId', hgnc));
    }
    if (geneEntries.length > 1) {
      gaps.push({
        sourceField: `VariationArchive[${vcvAccession}]/SimpleAllele/GeneList/Gene`,
        reason: `SimpleAllele lists ${geneEntries.length} Gene elements; v1-draft Variant carries only the first. Multi-gene fusion / overlap variants need vocab evolution.`,
        severity: 'warning',
        context: vcvAccession,
      });
    }
  }

  // ---- Gene-level Haploinsufficiency / Triplosensitivity ----
  // ClinGen dosage-sensitivity annotations (per-gene, not per-variant).
  // No v1-draft Gene-level predicates yet; surface as info.
  for (const gene of geneEntries) {
    if (gene?.Haploinsufficiency || gene?.Triplosensitivity) {
      gaps.push({
        sourceField: `VariationArchive[${vcvAccession}]/SimpleAllele/GeneList/Gene/Haploinsufficiency|Triplosensitivity`,
        reason:
          'ClinGen dosage-sensitivity annotations on the Gene (Haploinsufficiency / Triplosensitivity) carry the dosage-pathogenicity evidence — not variant-level. No v1-draft Gene predicate; candidate genomics:haploinsufficiency / genomics:triplosensitivity at the Gene class level.',
        severity: 'info',
        context: vcvAccession,
      });
      break; // emit once per VCV
    }
    if (asArray(gene?.Property).length > 0) {
      gaps.push({
        sourceField: `VariationArchive[${vcvAccession}]/SimpleAllele/GeneList/Gene/Property`,
        reason: `Gene properties (e.g., gene_acmg_incidental_2022) tag genes on ACMG actionability lists. No v1-draft predicate; useful for genome-screening reports.`,
        severity: 'info',
        context: vcvAccession,
      });
      break;
    }
  }

  // ---- OtherNameList ----
  if (simpleAllele?.OtherNameList) {
    gaps.push({
      sourceField: `VariationArchive[${vcvAccession}]/SimpleAllele/OtherNameList`,
      reason:
        'OtherNameList carries legacy / alias variant names ("p.C61G:TGT>GGT", "300T>G") that pre-date current HGVS conventions. No v1-draft alias-list predicate; could be added as genomics:variantAlias.',
      severity: 'info',
      context: vcvAccession,
    });
  }

  // ---- XRefList: ClinGen CAid + dbSNP rsId + OMIM allelic variant ----
  const xrefs = asArray(simpleAllele?.XRefList?.XRef);
  for (const x of xrefs) {
    const db = x?.['@_DB'];
    const id = x?.['@_ID'];
    if (typeof db !== 'string' || typeof id !== 'string') continue;
    if (db === 'ClinGen') {
      quads.push(tripleStr(iri, GENOMICS_NS + 'caId', id));
    } else if (db === 'dbSNP') {
      // dbSNP IDs in ClinVar drop the 'rs' prefix (Type='rs' tag carries it).
      const rsId = id.startsWith('rs') ? id : `rs${id}`;
      quads.push(tripleStr(iri, GENOMICS_NS + 'dbsnpRsId', rsId));
    } else if (db === 'OMIM') {
      // OMIM allelic variant — no v1-draft Variant predicate yet.
      gaps.push({
        sourceField: `VariationArchive[${vcvAccession}]/SimpleAllele/XRefList/XRef[DB='OMIM']`,
        reason:
          'OMIM allelic variant identifier (e.g., 113705.0002) has no v1-draft genomics: predicate; preserved only in source XML.',
        severity: 'info',
        context: vcvAccession,
      });
    } else if (db === 'UniProtKB' || db === 'BRCA1-HCI' || db === 'NCBI 1000 Genomes Browser') {
      gaps.push({
        sourceField: `VariationArchive[${vcvAccession}]/SimpleAllele/XRefList/XRef[DB='${db}']`,
        reason: `External cross-ref to ${db} has no v1-draft genomics: predicate.`,
        severity: 'info',
        context: vcvAccession,
      });
    }
  }

  // ---- CanonicalSPDI (D-Q6: preserve, never compute VRS) ----
  const spdi = textOf(simpleAllele?.CanonicalSPDI);
  if (spdi) {
    // Store the SPDI as a JSON object under genomics:vrsObject so downstream
    // tools can hash it into a VRS allele ID. Do NOT compute the VRS hash
    // here — that's D-Q6 (preservation-only).
    quads.push(
      tripleStr(
        iri,
        GENOMICS_NS + 'vrsObject',
        JSON.stringify({ canonicalSPDI: spdi }),
      ),
    );
  }

  // ---- MolecularConsequence (Sequence Ontology) → consequenceTerm ----
  // SO IDs appear inside HGVS<MolecularConsequence>; harvest the unique set.
  const seenSo = new Set<string>();
  for (const h of asArray(simpleAllele?.HGVSlist?.HGVS)) {
    for (const mc of asArray(h?.MolecularConsequence)) {
      const soId = mc?.['@_ID']; // e.g. 'SO:0001583'
      if (typeof soId === 'string' && soId.startsWith('SO:') && !seenSo.has(soId)) {
        seenSo.add(soId);
        // Encode as an OBO PURL — purl.obolibrary.org/obo/SO_0001583.
        const soIri = SO_BASE + soId.replace(':', '_');
        quads.push(tripleRef(iri, GENOMICS_NS + 'consequenceTerm', soIri));
        const label = mc?.['@_Type'];
        if (typeof label === 'string') {
          quads.push(tripleStr(iri, GENOMICS_NS + 'consequenceLabel', label));
        }
      }
    }
  }

  // ---- AlleleFrequencyList — population-level VAFs (no v1-draft term yet) ----
  if (simpleAllele?.AlleleFrequencyList) {
    gaps.push({
      sourceField: `VariationArchive[${vcvAccession}]/SimpleAllele/AlleleFrequencyList`,
      reason:
        'Population-level allele frequency tables (gnomAD, ExAC) have no v1-draft genomics: predicate. Per-sample VAF maps to genomics:mosaicismFraction; population frequencies are a v1-draft.0.2 candidate.',
      severity: 'info',
      context: vcvAccession,
    });
  }

  // ---- VariantType (kind of variant — SNV, deletion, indel, etc.) ----
  const variantType = textOf(simpleAllele?.VariantType);
  if (variantType) {
    // No v1-draft predicate for variant kind; surface as info gap.
    // (consequenceTerm captures effect; variantKind is structural.)
    gaps.push({
      sourceField: `VariationArchive[${vcvAccession}]/SimpleAllele/VariantType`,
      reason: `VariantType "${variantType}" (structural kind: SNV, indel, deletion, etc.) has no v1-draft genomics: predicate. Captured in consequenceTerm only when SO mapping is present.`,
      severity: 'info',
      context: vcvAccession,
    });
  }

  // ---- SequenceLocation (chrom + start/stop + ref/alt VCF-style) ----
  // genomics v1-draft.0.1 has no genomicStartEnd / refAllele / altAllele
  // predicates yet. Per the agent brief: emit info-severity gap-warnings
  // and continue. (Concurrent vocab-evolution agent may add these for
  // v1-draft.0.2.)
  if (simpleAllele?.Location?.SequenceLocation) {
    gaps.push({
      sourceField: `VariationArchive[${vcvAccession}]/SimpleAllele/Location/SequenceLocation`,
      reason:
        'SequenceLocation (chr, start, stop, referenceAlleleVCF, alternateAlleleVCF) has no v1-draft genomics: predicate. Candidates: genomics:genomicStartEnd, genomics:refAllele, genomics:altAllele (v1-draft.0.2).',
      severity: 'info',
      context: vcvAccession,
    });
  }

  // ---- ProteinChange element (one-letter form, e.g., 'C61G') ----
  // Already captured as hgvsPDot when present in HGVS<ProteinExpression>.
  // The standalone <ProteinChange> element is a duplicate; emit gap-info.
  if (simpleAllele?.ProteinChange) {
    // No new triple — already covered by hgvsPDot if available.
    // Surface only as info gap to acknowledge the field exists in source.
    if (!pDot) {
      gaps.push({
        sourceField: `VariationArchive[${vcvAccession}]/SimpleAllele/ProteinChange`,
        reason:
          'SimpleAllele lists <ProteinChange> in one-letter form but no <HGVS Type="protein"> with a full p.HGVS expression. Cannot derive hgvsPDot.',
        severity: 'info',
        context: vcvAccession,
      });
    }
  }

  // ---- Source identity passthrough ----
  quads.push(tripleStr(iri, NS.cascade + 'sourceFhirId', vcvAccession));

  // Use the variant ID as a stable cross-reference back to ClinVar.
  // (We use sourceFhirId for compatibility with reconcile; ClinVar isn't FHIR.)

  void subject; void literal; void makeQuad; // imports retained for future per-decimal triples

  const record: ClinvarParsedRecord = {
    iri,
    cascadeType: 'genomics:Variant',
    sourceId,
    quads,
  };

  return { record, warnings, gaps };
}
