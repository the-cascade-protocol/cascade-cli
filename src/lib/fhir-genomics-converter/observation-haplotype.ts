/**
 * Haplotype Observation parser.
 *
 * Maps a FHIR Genomics IG `haplotype`-profiled Observation to a
 * `genomics:Haplotype` record.
 *
 * Mapping:
 *   valueCodeableConcept.coding[*].code  →  genomics:starAlleleSymbol
 *     (PharmVar / IPD-IMGT/HLA naming, e.g. 'HLA-DQB1*02:01', 'CYP2C19*2')
 *   component[code=48018-6]              →  genomics:geneSymbol on Haplotype
 *   derivedFrom                          →  genomics:hasComponent (per Variant
 *                                            it points to; resolved via the
 *                                            Pass 1 idIndex)
 *
 * The component variants must already be in the idIndex (parsed in Pass 1).
 * Haplotypes whose derivedFrom points to MolecularSequence (HLA bundle) emit
 * an info-severity gap — sequence-level evidence has no v1-draft term.
 */

import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import {
  GENOMICS_NS,
  CODING_SYSTEMS,
  LOINC,
  type ParsedRecord,
  type Quad,
} from './types.js';
import { firstComponentByLoinc, findCoding } from './observation-utils.js';
import {
  NS,
  SCHEMA_VERSION,
  tripleType,
  tripleStr,
  tripleRef,
  deterministicUuid,
} from '../fhir-converter/types.js';

export interface HaplotypeParseOutput {
  record: ParsedRecord;
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

function mintHaplotypeIri(resource: any, ctx: ImportContext): string {
  const id = resource?.id ?? Math.random().toString(36);
  const sys = ctx.sourceSystem ?? 'fhir-genomics';
  return `urn:uuid:${deterministicUuid(`genomics:Haplotype:${sys}:${id}`)}`;
}

/**
 * Resolve a FHIR Reference to a Cascade IRI through the index.
 * Tries 'ResourceType/id' first, then bare id, then urn:uuid passthrough.
 */
function resolveRef(
  ref: { reference?: string } | undefined,
  idIndex: Map<string, string>,
): string | undefined {
  const r = ref?.reference;
  if (!r) return undefined;
  if (idIndex.has(r)) return idIndex.get(r);
  // Strip leading "ResourceType/"
  const slashIdx = r.indexOf('/');
  if (slashIdx > 0 && idIndex.has(r.slice(slashIdx + 1))) {
    return idIndex.get(r.slice(slashIdx + 1));
  }
  // urn:uuid:* references can resolve directly when the bundle entry's
  // fullUrl was indexed under the same urn.
  if (r.startsWith('urn:uuid:')) return r;
  return undefined;
}

export function parseHaplotypeObservation(
  resource: any,
  idIndex: Map<string, string>,
  ctx: ImportContext,
): HaplotypeParseOutput | null {
  if (!resource || resource.resourceType !== 'Observation') return null;

  const sourceId: string = resource.id ?? '<no-id>';
  const iri = mintHaplotypeIri(resource, ctx);
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];

  quads.push(tripleType(iri, GENOMICS_NS + 'Haplotype'));
  quads.push(tripleRef(iri, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'));
  quads.push(tripleStr(iri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));

  // Star-allele symbol — prefer the human-readable form ('HLA-X*Y' or '*Y'
  // with the asterisk) over opaque internal accessions. IPD-IMGT/HLA codings
  // ship the accession in `code` (e.g. 'HGG00041') with the canonical allele
  // name in `display` (e.g. 'HLA-B*15:01:01G'), so we have to inspect both.
  function pickStarAllele(coding: { code?: string; display?: string } | undefined): string | undefined {
    if (!coding) return undefined;
    const code = coding.code;
    const display = coding.display;
    const isStarLike = (s: string | undefined): boolean => !!s && s.includes('*');
    if (isStarLike(display)) return display;
    if (isStarLike(code)) return code;
    return display ?? code;
  }

  const valueCcc = resource.valueCodeableConcept;
  let starAllele: string | undefined;
  if (valueCcc) {
    starAllele =
      pickStarAllele(findCoding(valueCcc, CODING_SYSTEMS.imgtHla)) ??
      pickStarAllele(findCoding(valueCcc, CODING_SYSTEMS.pharmvar)) ??
      pickStarAllele(valueCcc.coding?.[0]);
    if (starAllele) {
      quads.push(tripleStr(iri, GENOMICS_NS + 'starAlleleSymbol', starAllele));
    }
  }

  if (!starAllele) {
    gaps.push({
      sourceField: `Observation/${sourceId}.valueCodeableConcept`,
      reason: 'Haplotype Observation has no value carrying a star-allele symbol.',
      severity: 'warning',
      context: sourceId,
    });
    warnings.push({
      message: `Haplotype ${sourceId}: missing star-allele symbol`,
      recordRef: iri,
    });
  }

  // Gene studied (component 48018-6) — useful for HLA / PGx clarity.
  const geneCcc = firstComponentByLoinc(resource, LOINC.geneStudied)?.valueCodeableConcept;
  if (geneCcc) {
    const hgnc = findCoding(geneCcc, CODING_SYSTEMS.hgnc);
    if (hgnc?.display) quads.push(tripleStr(iri, GENOMICS_NS + 'geneSymbol', hgnc.display));
    if (hgnc?.code) quads.push(tripleStr(iri, GENOMICS_NS + 'hgncId', hgnc.code));
  }

  // derivedFrom → genomics:hasComponent (link to Variants).
  // FHIR Genomics IG haplotype profile uses derivedFrom to point at the
  // constituent Variant Observations (or MolecularSequence resources for HLA).
  const derived: any[] = resource.derivedFrom ?? [];
  for (const ref of derived) {
    const refStr: string = ref?.reference ?? '';
    if (refStr.includes('MolecularSequence') || ref?.type === 'MolecularSequence') {
      gaps.push({
        sourceField: `Observation/${sourceId}.derivedFrom`,
        reason:
          'Haplotype derivedFrom MolecularSequence — sequence-level evidence has no genomics v1-draft term yet (would require importing MolecularSequence as a separate genomics record).',
        severity: 'info',
        context: sourceId,
      });
      continue;
    }
    const resolved = resolveRef(ref, idIndex);
    if (resolved) {
      quads.push(tripleRef(iri, GENOMICS_NS + 'hasComponent', resolved));
    } else {
      gaps.push({
        sourceField: `Observation/${sourceId}.derivedFrom`,
        reason: `Haplotype derivedFrom reference ${refStr} could not be resolved against parsed Variants.`,
        severity: 'warning',
        context: sourceId,
      });
    }
  }

  // Source identity passthrough.
  quads.push(tripleStr(iri, NS.cascade + 'sourceFhirId', sourceId));

  // Observation.method (NGS panel description) is recognized but unmapped.
  if (resource.method) {
    gaps.push({
      sourceField: `Observation/${sourceId}.method`,
      reason: 'Haplotype.method (typing methodology) has no genomics v1-draft term.',
      severity: 'info',
      context: sourceId,
    });
  }

  const record: ParsedRecord = {
    iri,
    cascadeType: 'genomics:Haplotype',
    sourceId,
    fhirResourceType: 'Observation',
    quads,
  };

  return { record, warnings, gaps };
}
