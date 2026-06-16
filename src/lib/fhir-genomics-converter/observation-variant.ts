/**
 * Variant Observation parser.
 *
 * Parses a FHIR Observation conforming to the FHIR Genomics IG `variant`
 * profile (`http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/variant`)
 * into a `genomics:Variant` record (a stream of n3 quads).
 *
 * LOINC components handled:
 *   48004-6  → genomics:hgvsCDot
 *   48005-3  → genomics:hgvsPDot
 *   81290-9  → genomics:hgvsGDot
 *   48018-6  → genomics:geneSymbol + genomics:hgncId
 *   51958-7  → genomics:transcriptRef
 *   53034-5  → genomics:zygosity (LOINC answer codes LA670x → ZygosityValue)
 *   81252-9  → genomics:clinvarVariationId (when ClinVar coding) +
 *              genomics:dbsnpRsId (when dbSNP coding)
 *   48019-4  → recognized; emitted as gap (no DNA-change-type term in v1-draft)
 *   69547-8  → genomics:refAllele                 (v1-draft.0.2)
 *   69551-0  → genomics:altAllele                 (v1-draft.0.2)
 *   81254-5  → genomics:genomicStartEnd           (v1-draft.0.2)
 *   48002-0  → genomics:somaticStatus             (v1-draft.0.2)
 *   81258-6  → genomics:variantAlleleFrequency    (v1-draft.0.2; was mosaicismFraction)
 *
 * Other components (coverage 82121-5, ref/alt counts, 48013-7 genomic ref,
 * etc.) emit info-severity vocabulary gaps — they're recognized but the
 * v1-draft genomics ontology has no place for them yet.
 *
 * VRS hashes (D-Q6): preserved only — never computed. Looked for under
 * Observation.extension and (per Genomics IG draft proposals) under a
 * 'vrs-allele' / 'vrs-id' extension URL. If absent, the Variant just has
 * no vrsId triple.
 *
 * D-QUALITY-TIER: every emitted Variant carries genomics:dataQualityTier.
 * For FHIR Genomics IG bundles the default is genomics:ClinicalGrade
 * because these are real clinical-lab reports running validated panels
 * (the IG itself is built around the clinical-reporting workflow).
 * Bundles whose meta indicates research provenance would tag ResearchGrade
 * but no such marker exists in the corpus today.
 */

import { DataFactory } from 'n3';
import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import {
  GENOMICS_NS,
  CODING_SYSTEMS,
  LOINC,
  ZYGOSITY_LOINC_TO_VALUE,
  type ParsedRecord,
  type Quad,
} from './types.js';
import {
  componentsByLoinc,
  firstComponentByLoinc,
  findCoding,
  ccCode,
  ccDisplayOrCode,
} from './observation-utils.js';
import {
  NS,
  SCHEMA_VERSION,
  tripleType,
  tripleStr,
  tripleRef,
  deterministicUuid,
} from '../fhir-converter/types.js';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export interface VariantParseOutput {
  record: ParsedRecord;
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

/**
 * Mint a Cascade IRI for a Variant. Inputs:
 *   - sourceSystem (optional ctx tag)
 *   - bundle/resource id (FHIR Observation id)
 * Falls back to bundle-relative deterministic minting if no id.
 */
function mintVariantIri(resource: any, ctx: ImportContext): string {
  const id = resource?.id as string | undefined;
  const sys = ctx.sourceSystem ?? 'fhir-genomics';
  if (id) {
    return `urn:uuid:${deterministicUuid(`genomics:Variant:${sys}:${id}`)}`;
  }
  return `urn:uuid:${deterministicUuid(`genomics:Variant:${sys}:${ctx.importedAt}:${Math.random()}`)}`;
}

/**
 * Search Observation.extension for a VRS allele identifier or full VRS
 * object. Multiple extension URL forms are accepted because the IG is
 * still finalizing the VRS extension shape.
 */
function extractVrs(resource: any): { vrsId?: string; vrsObject?: string } {
  const ext: any[] = resource?.extension ?? [];
  let vrsId: string | undefined;
  let vrsObject: string | undefined;
  for (const e of ext) {
    if (typeof e?.url !== 'string') continue;
    const url = e.url.toLowerCase();
    if (url.includes('vrs') && (url.includes('id') || url.endsWith('vrs-allele-id'))) {
      vrsId = e.valueString ?? e.valueIdentifier?.value ?? undefined;
    }
    if (url.includes('vrs') && (url.includes('object') || url.includes('allele'))) {
      // Capture full object as JSON string if a structured value is present.
      if (e.valueAttachment?.data) vrsObject = e.valueAttachment.data;
      else if (e.valueString && e.valueString.startsWith('{')) vrsObject = e.valueString;
    }
  }
  return { vrsId, vrsObject };
}

/**
 * The set of LOINC component codes the parser explicitly handles.
 * Used to flag everything else as a vocabulary gap.
 */
const HANDLED_LOINCS = new Set<string>([
  LOINC.hgvsCDot,
  LOINC.hgvsPDot,
  LOINC.hgvsGDot,
  LOINC.geneStudied,
  LOINC.transcriptRef,
  LOINC.zygosity,
  LOINC.discreteVariant,
  // Recognized but emitted as a gap (no v1-draft term yet).
  LOINC.dnaChangeType,
  LOINC.alleleFreq,
  LOINC.genomicRefSeq,
  // v1-draft.0.2 — VCF-style coordinate components, somatic status.
  LOINC.genomicRefAllele,
  LOINC.genomicAltAllele,
  LOINC.genomicStartEnd,
  LOINC.genomicSourceClass,
  // Quantitative coverage / ref-alt counts used by some labs.
  '82121-5', // ref allele count
  '82155-3', // alt allele count
  '81299-0', // variant probability
  '81300-6', // base position
  '81301-4', // copy number range / range start
  '81302-2', // genomic alt allele count or interpretation
]);

/**
 * Map LOINC answer codes / display strings on component 48002-0
 * (Genomic source class) to the genomics:SomaticStatus named individuals.
 *
 *   LA6683-2 / "Germline" → Germline
 *   LA6684-0 / "Somatic"  → Somatic
 *   anything else         → UnknownSomaticStatus
 */
function mapSomaticStatus(
  cc:
    | { coding?: { system?: string; code?: string; display?: string }[]; text?: string }
    | undefined,
): 'Germline' | 'Somatic' | 'UnknownSomaticStatus' {
  if (!cc) return 'UnknownSomaticStatus';
  for (const c of cc.coding ?? []) {
    const code = c.code ?? '';
    const disp = (c.display ?? '').toLowerCase();
    if (code === 'LA6683-2' || disp.startsWith('germline')) return 'Germline';
    if (code === 'LA6684-0' || disp.startsWith('somatic')) return 'Somatic';
  }
  const text = (cc.text ?? '').toLowerCase();
  if (text.startsWith('germline')) return 'Germline';
  if (text.startsWith('somatic')) return 'Somatic';
  return 'UnknownSomaticStatus';
}

export function parseVariantObservation(
  resource: any,
  ctx: ImportContext,
): VariantParseOutput | null {
  if (!resource || resource.resourceType !== 'Observation') return null;

  const sourceId: string = resource.id ?? '<no-id>';
  const iri = mintVariantIri(resource, ctx);
  const subject = namedNode(iri);
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];

  // ---- Type + provenance ----
  quads.push(tripleType(iri, GENOMICS_NS + 'Variant'));
  quads.push(tripleRef(iri, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'));
  quads.push(tripleStr(iri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));

  // ---- D-QUALITY-TIER ----
  // FHIR Genomics IG bundles are clinical-lab reports by construction.
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

  // ---- HGVS strings ----
  const cDot = ccCode(firstComponentByLoinc(resource, LOINC.hgvsCDot)?.valueCodeableConcept);
  if (cDot) quads.push(tripleStr(iri, GENOMICS_NS + 'hgvsCDot', cDot));

  const pDot = ccCode(firstComponentByLoinc(resource, LOINC.hgvsPDot)?.valueCodeableConcept);
  if (pDot) quads.push(tripleStr(iri, GENOMICS_NS + 'hgvsPDot', pDot));

  const gDot = ccCode(firstComponentByLoinc(resource, LOINC.hgvsGDot)?.valueCodeableConcept);
  if (gDot) quads.push(tripleStr(iri, GENOMICS_NS + 'hgvsGDot', gDot));

  // ---- Transcript reference ----
  const transcript = ccCode(firstComponentByLoinc(resource, LOINC.transcriptRef)?.valueCodeableConcept);
  if (transcript) quads.push(tripleStr(iri, GENOMICS_NS + 'transcriptRef', transcript));

  // ---- Gene symbol + HGNC ID (component 48018-6 with HGNC coding) ----
  const geneCcc = firstComponentByLoinc(resource, LOINC.geneStudied)?.valueCodeableConcept;
  if (geneCcc) {
    const hgncCoding = findCoding(geneCcc, CODING_SYSTEMS.hgnc);
    if (hgncCoding?.display) quads.push(tripleStr(iri, GENOMICS_NS + 'geneSymbol', hgncCoding.display));
    if (hgncCoding?.code) quads.push(tripleStr(iri, GENOMICS_NS + 'hgncId', hgncCoding.code));
  } else {
    gaps.push({
      sourceField: `Observation/${sourceId}.component[48018-6]`,
      reason:
        'No gene-studied component (LOINC 48018-6) found on Variant Observation; SHACL requires geneSymbol cardinality 1.',
      severity: 'warning',
      context: sourceId,
    });
    warnings.push({
      message: `Variant ${sourceId}: missing required gene symbol component (LOINC 48018-6)`,
      recordRef: iri,
    });
  }

  // ---- Zygosity (LOINC 53034-5, value is a LOINC answer code LA670x) ----
  const zygCcc = firstComponentByLoinc(resource, LOINC.zygosity)?.valueCodeableConcept;
  if (zygCcc) {
    const zygCoding = findCoding(zygCcc, CODING_SYSTEMS.loinc);
    const zygValue = zygCoding?.code ? ZYGOSITY_LOINC_TO_VALUE[zygCoding.code] : undefined;
    if (zygValue) {
      quads.push(tripleRef(iri, GENOMICS_NS + 'zygosity', GENOMICS_NS + zygValue));
    } else {
      gaps.push({
        sourceField: `Observation/${sourceId}.component[53034-5].value`,
        reason: `Unrecognized zygosity LOINC answer code: ${zygCoding?.code ?? '<missing>'}.`,
        severity: 'warning',
        context: sourceId,
      });
    }
  }

  // ---- Stable identifiers from 81252-9 (may appear multiple times) ----
  for (const c of componentsByLoinc(resource, LOINC.discreteVariant)) {
    const cc = c.valueCodeableConcept;
    if (!cc) continue;
    const clinVar = findCoding(cc, CODING_SYSTEMS.clinvar);
    if (clinVar?.code) {
      // Strip any 'VCV' / 'RCV' prefix per upstream convention; keep numeric for VCV.
      // ClinVar variation IDs in this corpus are bare numeric (e.g., '30880') so we
      // store them as-is. RCV codes go to clinvarRcvId on the Interpretation.
      if (clinVar.code.startsWith('RCV')) {
        // Variant-level shouldn't have RCV; record but under Variant for completeness.
        gaps.push({
          sourceField: `Observation/${sourceId}.component[81252-9]`,
          reason: `RCV accession (${clinVar.code}) found on Variant component; expected on VariantInterpretation.`,
          severity: 'info',
          context: sourceId,
        });
      } else {
        quads.push(tripleStr(iri, GENOMICS_NS + 'clinvarVariationId', clinVar.code));
      }
    }
    const dbsnp = findCoding(cc, CODING_SYSTEMS.dbsnp);
    if (dbsnp?.code) {
      quads.push(tripleStr(iri, GENOMICS_NS + 'dbsnpRsId', dbsnp.code));
    }
  }

  // ---- ClinGen Allele Registry CAid (canonical allele ID) ----
  // Look for it under any extension carrying a 'caid'-shaped value.
  const ext: any[] = resource?.extension ?? [];
  for (const e of ext) {
    if (typeof e?.url !== 'string') continue;
    const u = e.url.toLowerCase();
    if (u.includes('caid') || u.includes('canonical-allele') || u.includes('allele-registry')) {
      const v = e.valueString ?? e.valueIdentifier?.value;
      if (typeof v === 'string') {
        quads.push(tripleStr(iri, GENOMICS_NS + 'caId', v));
      }
    }
  }

  // ---- VRS preservation (D-Q6) ----
  const { vrsId, vrsObject } = extractVrs(resource);
  if (vrsId) quads.push(tripleStr(iri, GENOMICS_NS + 'vrsId', vrsId));
  if (vrsObject) quads.push(tripleStr(iri, GENOMICS_NS + 'vrsObject', vrsObject));

  // ---- Variant Allele Frequency (LOINC 81258-6) ----
  // v1-draft.0.2: emit to genomics:variantAlleleFrequency. Was previously
  // shoehorned into genomics:mosaicismFraction (semantically wrong — those
  // two are now distinct properties per the v0.2 changelog).
  const vafComp = firstComponentByLoinc(resource, LOINC.alleleFreq);
  if (vafComp?.valueQuantity?.value !== undefined) {
    const v = vafComp.valueQuantity.value;
    // Convert percent to fraction if the unit/code indicates percent.
    const codeUnit = vafComp.valueQuantity.code ?? vafComp.valueQuantity.unit;
    const asFraction = codeUnit === '%' && v > 1 ? v / 100 : v;
    // Store as xsd:decimal-typed literal manually (no decimal helper in fhir-converter).
    quads.push(
      makeQuad(
        subject,
        namedNode(GENOMICS_NS + 'variantAlleleFrequency'),
        literal(String(asFraction), namedNode(NS.xsd + 'decimal')),
      ),
    );
  }

  // ---- VCF-style coordinate properties (v1-draft.0.2) ----
  // 69547-8 (Genomic ref allele) → genomics:refAllele
  const refAlleleComp = firstComponentByLoinc(resource, LOINC.genomicRefAllele);
  const refAlleleVal =
    refAlleleComp?.valueString ??
    ccCode(refAlleleComp?.valueCodeableConcept) ??
    undefined;
  if (refAlleleVal) {
    quads.push(tripleStr(iri, GENOMICS_NS + 'refAllele', refAlleleVal));
  }

  // 69551-0 (Genomic alt allele) → genomics:altAllele
  const altAlleleComp = firstComponentByLoinc(resource, LOINC.genomicAltAllele);
  const altAlleleVal =
    altAlleleComp?.valueString ??
    ccCode(altAlleleComp?.valueCodeableConcept) ??
    undefined;
  if (altAlleleVal) {
    quads.push(tripleStr(iri, GENOMICS_NS + 'altAllele', altAlleleVal));
  }

  // 81254-5 (Genomic allele start-end) → genomics:genomicStartEnd
  // Inputs vary: valueRange { low.value, high.value } in IG examples;
  // valueString fallback for "<low>-<high>" form.
  const startEndComp = firstComponentByLoinc(resource, LOINC.genomicStartEnd);
  if (startEndComp) {
    let startEndStr: string | undefined;
    const lo = startEndComp.valueRange?.low?.value;
    const hi = startEndComp.valueRange?.high?.value;
    if (lo !== undefined && hi !== undefined) {
      startEndStr = `${lo}-${hi}`;
    } else if (typeof startEndComp.valueString === 'string') {
      startEndStr = startEndComp.valueString.trim();
    }
    if (startEndStr) {
      quads.push(tripleStr(iri, GENOMICS_NS + 'genomicStartEnd', startEndStr));
    }
  }

  // 48002-0 (Genomic source class) → genomics:somaticStatus
  const sourceClassComp = firstComponentByLoinc(resource, LOINC.genomicSourceClass);
  if (sourceClassComp) {
    const status = mapSomaticStatus(sourceClassComp.valueCodeableConcept);
    quads.push(tripleRef(iri, GENOMICS_NS + 'somaticStatus', GENOMICS_NS + status));
  }

  // ---- Source identity passthrough ----
  quads.push(tripleStr(iri, NS.cascade + 'sourceFhirId', sourceId));

  // ---- Vocabulary-gap reporting for unhandled components ----
  const components: any[] = resource?.component ?? [];
  for (const c of components) {
    const codings: any[] = c?.code?.coding ?? [];
    for (const coding of codings) {
      if (coding.system && (coding.system === CODING_SYSTEMS.loinc || coding.system === 'http://loinc.org/')) {
        const code = coding.code as string;
        if (!HANDLED_LOINCS.has(code)) {
          gaps.push({
            sourceField: `Observation/${sourceId}.component[${code}]`,
            reason: `LOINC component ${code} (${coding.display ?? '<no display>'}) not mapped in genomics v1-draft.`,
            severity: 'info',
            context: sourceId,
          });
        } else if (
          code === LOINC.dnaChangeType ||
          code === LOINC.alleleFreq ||
          code === LOINC.genomicRefSeq
        ) {
          // alleleFreq is mapped (above) — only emit gap for the others
          if (code !== LOINC.alleleFreq) {
            gaps.push({
              sourceField: `Observation/${sourceId}.component[${code}]`,
              reason: `LOINC component ${code} (${coding.display ?? '<no display>'}) recognized but no v1-draft term yet.`,
              severity: 'info',
              context: sourceId,
            });
          }
        }
      }
    }
  }

  // hasMember (used by the cgexample 'complex-variant' to chain to D + E
  // sub-variants) — emit gap to surface the linking pattern explicitly.
  if (Array.isArray(resource.hasMember) && resource.hasMember.length > 0) {
    gaps.push({
      sourceField: `Observation/${sourceId}.hasMember`,
      reason:
        'Variant Observation uses hasMember to chain sub-Variants (complex variant pattern). The sub-Variants are imported individually, but no aggregate-Variant linking exists in genomics v1-draft yet.',
      severity: 'info',
      context: sourceId,
    });
  }

  // valueCodeableConcept on the Observation (Present / Absent — LA9633-4 / LA9634-2)
  const presence = findCoding(resource.valueCodeableConcept, CODING_SYSTEMS.loinc);
  if (presence?.code === 'LA9634-2') {
    // Absent = "no variant called" — rare in IG examples; emit gap.
    gaps.push({
      sourceField: `Observation/${sourceId}.value`,
      reason: 'Variant Observation reports "Absent"; absence-encoding has no v1-draft Variant representation.',
      severity: 'info',
      context: sourceId,
    });
  }

  const display = ccDisplayOrCode(geneCcc) ?? cDot ?? gDot ?? sourceId;
  void display;

  const record: ParsedRecord = {
    iri,
    cascadeType: 'genomics:Variant',
    sourceId,
    fhirResourceType: 'Observation',
    quads,
  };

  return { record, warnings, gaps };
}

/**
 * Add `genomics:phasedWith` + `genomics:phase` triples linking two
 * already-emitted Variants. Called by the Genotype/Diplotype parser
 * (TASK-1.4) when it detects a compound-heterozygous pattern.
 *
 * The Variants must already exist in the quad stream — this function
 * appends the relationship triples to a target list and returns them.
 * Caller is responsible for merging the returned quads.
 */
export function emitPhasedWithLink(
  variantIriA: string,
  variantIriB: string,
  phase: 'Cis' | 'Trans' | 'PhaseUnknown',
): Quad[] {
  return [
    tripleRef(variantIriA, GENOMICS_NS + 'phasedWith', variantIriB),
    tripleRef(variantIriB, GENOMICS_NS + 'phasedWith', variantIriA),
    tripleRef(variantIriA, GENOMICS_NS + 'phase', GENOMICS_NS + phase),
    tripleRef(variantIriB, GENOMICS_NS + 'phase', GENOMICS_NS + phase),
  ];
}
