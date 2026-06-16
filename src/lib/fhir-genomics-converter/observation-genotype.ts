/**
 * Genotype Observation parser.
 *
 * Maps a FHIR Genomics IG `genotype`-profiled Observation to a
 * `genomics:Diplotype` record.
 *
 * Mapping:
 *   valueCodeableConcept                 →  genomics:diplotypeNotation
 *     (prefer codings whose value contains '*1/*2'-style notation; otherwise
 *      fall back to the first coding's display/code.)
 *   derivedFrom[*]                       →  genomics:hapA / genomics:hapB
 *     (FHIR Genomics IG genotype profile uses derivedFrom to point at the
 *      two constituent Haplotype Observations. Order is arbitrary but
 *      stable: first → hapA, second → hapB.)
 *   component[48018-6]                   →  genomics:geneSymbol on Diplotype
 *     (Multi-gene genotypes — cgexample's CYP2C9 / VKORC1 — emit a gap.)
 *
 * Compound-heterozygous handling:
 *   The compound-het bundle uses Genotype with hasMember[] referencing two
 *   Variants and a valueCodeableConcept containing HGVS bracket-semicolon
 *   notation ('c.[53A>G];[769G>A]'). When we detect this pattern we emit
 *   `genomics:phasedWith` between the two Variants plus `genomics:phase`
 *   `genomics:Trans` (semicolon = trans per HGVS convention, slash = unspecified).
 *   This is THE only path that produces phasedWith in Phase 1.
 */

import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import {
  GENOMICS_NS,
  CODING_SYSTEMS,
  LOINC,
  type ParsedRecord,
  type Quad,
} from './types.js';
import { firstComponentByLoinc, findCoding, ccCode } from './observation-utils.js';
import {
  NS,
  SCHEMA_VERSION,
  tripleType,
  tripleStr,
  tripleRef,
  deterministicUuid,
} from '../fhir-converter/types.js';
import { emitPhasedWithLink } from './observation-variant.js';

export interface GenotypeParseOutput {
  record: ParsedRecord;
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

function mintDiplotypeIri(resource: any, ctx: ImportContext): string {
  const id = resource?.id ?? Math.random().toString(36);
  const sys = ctx.sourceSystem ?? 'fhir-genomics';
  return `urn:uuid:${deterministicUuid(`genomics:Diplotype:${sys}:${id}`)}`;
}

/**
 * Resolve a FHIR Reference through the idIndex. Tries 'ResourceType/id',
 * then bare id, then `urn:uuid:` passthrough as a last resort.
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
 * Detect HGVS phased notation in a value coding string.
 *   'c.[53A>G];[769G>A]'  → Trans   (semicolon between bracketed alleles)
 *   'c.[53A>G;769G>A]'    → Cis     (semicolon inside one bracket = cis)
 *   any other notation    → null    (unphased / unknown)
 */
function detectHgvsPhase(s: string | undefined): 'Cis' | 'Trans' | null {
  if (!s) return null;
  // Trans pattern: ];[
  if (/\]\s*;\s*\[/.test(s)) return 'Trans';
  // Cis pattern: bracket-internal semicolon, e.g. [a;b]
  if (/\[[^;\]]*;[^\]]*\]/.test(s)) return 'Cis';
  return null;
}

export function parseGenotypeObservation(
  resource: any,
  idIndex: Map<string, string>,
  ctx: ImportContext,
): GenotypeParseOutput | null {
  if (!resource || resource.resourceType !== 'Observation') return null;

  const sourceId: string = resource.id ?? '<no-id>';
  const iri = mintDiplotypeIri(resource, ctx);
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];

  quads.push(tripleType(iri, GENOMICS_NS + 'Diplotype'));
  quads.push(tripleRef(iri, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'));
  quads.push(tripleStr(iri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));

  // ---- Diplotype notation ----
  // Prefer a coding whose code or display has '*' (PharmVar / HLA notation),
  // then a glstring-system coding (HLA), then any first coding.
  const valueCcc = resource.valueCodeableConcept;
  let diplotypeNotation: string | undefined;
  if (valueCcc) {
    function pick(coding: any): string | undefined {
      if (!coding) return undefined;
      if (coding.code?.includes('*')) return coding.code;
      if (coding.display?.includes('*')) return coding.display;
      return coding.display ?? coding.code;
    }
    diplotypeNotation =
      pick(findCoding(valueCcc, CODING_SYSTEMS.pharmvar)) ??
      pick(findCoding(valueCcc, CODING_SYSTEMS.glstring)) ??
      pick(findCoding(valueCcc, CODING_SYSTEMS.imgtHla)) ??
      pick(valueCcc.coding?.[0]);
    if (diplotypeNotation) {
      quads.push(tripleStr(iri, GENOMICS_NS + 'diplotypeNotation', diplotypeNotation));
    }
  }

  // ---- Gene symbol on Diplotype ----
  const geneCcc = firstComponentByLoinc(resource, LOINC.geneStudied)?.valueCodeableConcept;
  if (geneCcc) {
    const hgnc = findCoding(geneCcc, CODING_SYSTEMS.hgnc);
    if (hgnc?.display) quads.push(tripleStr(iri, GENOMICS_NS + 'geneSymbol', hgnc.display));
    if (hgnc?.code) quads.push(tripleStr(iri, GENOMICS_NS + 'hgncId', hgnc.code));
  }

  // Multi-gene gene-studied components (cgexample carries CYP2C9 + VKORC1) —
  // emit gap; v1-draft Diplotype assumes a single gene.
  const geneComponents = resource.component?.filter(
    (c: any) =>
      c.code?.coding?.some(
        (k: any) => k.code === LOINC.geneStudied,
      ),
  ) ?? [];
  if (geneComponents.length > 1) {
    gaps.push({
      sourceField: `Observation/${sourceId}.component[48018-6]`,
      reason: `Genotype Observation references ${geneComponents.length} distinct genes; v1-draft Diplotype assumes a single gene. Only the first gene is materialized; others (${geneComponents
        .slice(1)
        .map(
          (c: any) =>
            c.valueCodeableConcept?.coding?.[0]?.display ??
            c.valueCodeableConcept?.coding?.[0]?.code ??
            '<unknown>',
        )
        .join(', ')}) are dropped.`,
      severity: 'warning',
      context: sourceId,
    });
  }

  // ---- derivedFrom → hapA / hapB (link to Haplotype IRIs) ----
  // Resolve any derivedFrom that points at a previously-parsed Haplotype.
  const derived: any[] = resource.derivedFrom ?? [];
  const haplotypeIris: string[] = [];
  for (const ref of derived) {
    const refStr: string = ref?.reference ?? '';
    if (refStr.includes('MolecularSequence') || ref?.type === 'MolecularSequence') {
      gaps.push({
        sourceField: `Observation/${sourceId}.derivedFrom`,
        reason:
          'Genotype derivedFrom MolecularSequence — sequence-level evidence has no genomics v1-draft term yet.',
        severity: 'info',
        context: sourceId,
      });
      continue;
    }
    const resolved = resolveRef(ref, idIndex);
    if (resolved) {
      haplotypeIris.push(resolved);
    } else {
      gaps.push({
        sourceField: `Observation/${sourceId}.derivedFrom`,
        reason: `Genotype derivedFrom reference ${refStr} could not be resolved against parsed Haplotypes.`,
        severity: 'warning',
        context: sourceId,
      });
    }
  }

  if (haplotypeIris.length >= 1) {
    quads.push(tripleRef(iri, GENOMICS_NS + 'hapA', haplotypeIris[0]));
  }
  if (haplotypeIris.length >= 2) {
    quads.push(tripleRef(iri, GENOMICS_NS + 'hapB', haplotypeIris[1]));
  }
  if (haplotypeIris.length > 2) {
    gaps.push({
      sourceField: `Observation/${sourceId}.derivedFrom`,
      reason: `Genotype Observation references ${haplotypeIris.length} haplotypes; only first two materialized as hapA/hapB.`,
      severity: 'warning',
      context: sourceId,
    });
  }

  // ---- Compound-heterozygous detection (hasMember + HGVS phase notation) ----
  // The compound-het bundle uses genotype.hasMember to link two Variants and
  // genotype.valueCodeableConcept for the bracket-semicolon HGVS string.
  const hasMembers: any[] = resource.hasMember ?? [];
  const memberVariantIris: string[] = [];
  for (const m of hasMembers) {
    const resolved = resolveRef(m, idIndex);
    if (resolved) memberVariantIris.push(resolved);
  }

  // Inspect every value-coding for HGVS phase; ClinVar RCV codes also live here.
  let hgvsPhase: 'Cis' | 'Trans' | null = null;
  if (valueCcc) {
    for (const coding of valueCcc.coding ?? []) {
      const candidate = coding.display ?? coding.code;
      const phase = detectHgvsPhase(candidate);
      if (phase) {
        hgvsPhase = phase;
        break;
      }
    }
    // Some bundles expose a ClinVar RCV identifier on the genotype value.
    const rcv = findCoding(valueCcc, CODING_SYSTEMS.clinvar);
    if (rcv?.code?.startsWith('RCV')) {
      // Stash on the Diplotype as informational; v1-draft has no clinvarRcvId
      // on Diplotype directly.
      gaps.push({
        sourceField: `Observation/${sourceId}.value`,
        reason: `ClinVar RCV accession ${rcv.code} on genotype; v1-draft attaches RCV to VariantInterpretation, not Diplotype.`,
        severity: 'info',
        context: sourceId,
      });
    }
  }

  if (memberVariantIris.length === 2 && hgvsPhase) {
    // Append phasedWith + phase triples to the quad stream. These triples
    // refer to the Variant IRIs (already emitted in Pass 1) — the merge
    // happens automatically when convertGenomicsBundle concatenates quads.
    const phasedTriples = emitPhasedWithLink(
      memberVariantIris[0],
      memberVariantIris[1],
      hgvsPhase,
    );
    quads.push(...phasedTriples);
  } else if (memberVariantIris.length >= 2 && !hgvsPhase) {
    gaps.push({
      sourceField: `Observation/${sourceId}.value`,
      reason: `Genotype Observation links ${memberVariantIris.length} Variants via hasMember but no HGVS phase notation (e.g. 'c.[a];[b]') was detected; phase set to PhaseUnknown.`,
      severity: 'info',
      context: sourceId,
    });
    const phasedTriples = emitPhasedWithLink(
      memberVariantIris[0],
      memberVariantIris[1],
      'PhaseUnknown',
    );
    quads.push(...phasedTriples);
  }

  // Source identity passthrough.
  quads.push(tripleStr(iri, NS.cascade + 'sourceFhirId', sourceId));

  // Variant valueCcc.code expression (silenced lint).
  void ccCode;

  const record: ParsedRecord = {
    iri,
    cascadeType: 'genomics:Diplotype',
    sourceId,
    fhirResourceType: 'Observation',
    quads,
  };

  return { record, warnings, gaps };
}
