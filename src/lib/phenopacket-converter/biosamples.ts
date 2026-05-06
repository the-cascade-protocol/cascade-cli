/**
 * Phenopacket biosamples[] → fhir:Specimen records.
 *
 * Biosamples carry tissue type, taxonomy, age at collection, optional
 * histopathological / molecular markers, and (per D-DIRECTORY) optional
 * file references. When a biosample's `files[]` carries FASTQ / BAM / CRAM
 * / VCF entries we ALSO emit genomics:RawFile pointer-and-hash records.
 *
 * v1-draft has no first-class fhir:Specimen-derived class. We anchor on
 * the bare `fhir:Specimen` IRI as the rdf:type and carry tissue / taxonomy
 * / collection-age via cascade-prefixed predicates so the data isn't lost
 * even though no Layer 2 wrapper exists yet. An info gap calls this out.
 *
 * Phenopacket biosample shape:
 *
 *   {
 *     id, individualId,
 *     description,
 *     sampledTissue: { id: 'UBERON:...', label: '...' },
 *     taxonomy:      { id: 'NCBITaxon:9606', label: 'homo sapiens' },
 *     timeOfCollection: { age: { iso8601duration: 'P14Y' } },
 *     histologicalDiagnosis: { id, label },
 *     tumorProgression:      { id, label },
 *     tumorGrade:            { id, label },
 *     diagnosticMarkers: [...],
 *     materialSample: { id, label },
 *     phenotypicFeatures: [...],
 *     measurements: [...],
 *     files: [{ uri, fileAttributes: { genomeAssembly, fileFormat } }]
 *   }
 *
 * Acceptance: every biosample from retinoblastoma + bethlem-myopathy +
 * v2-phenopacket round-trips as a fhir:Specimen anchor with at least
 * tissue + collection-age preserved; D-DIRECTORY raw-file refs produce
 * genomics:RawFile records.
 */

import { GENOMICS_NS } from './types.js';
import type { Quad, ParsedRecord } from './types.js';
import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import {
  NS,
  SCHEMA_VERSION,
  tripleType,
  tripleStr,
  tripleRef,
  deterministicUuid,
} from '../fhir-converter/types.js';

export interface BiosampleParseOutput {
  records: ParsedRecord[];
  quads: Quad[];
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

const FHIR_SPECIMEN_TYPE = 'http://hl7.org/fhir/Specimen';

const FILE_FORMAT_MAP: Record<string, string> = {
  BAM: 'BAM',
  CRAM: 'CRAM',
  FASTQ: 'FASTQ',
  VCF: 'VCF',
  GVCF: 'VCF',
  BCF: 'BCF',
  VCF_GZ: 'VCF',
  vcf: 'VCF',
  bam: 'BAM',
  cram: 'CRAM',
  fastq: 'FASTQ',
  bcf: 'BCF',
  gvcf: 'VCF',
};

function mintSpecimenIri(biosampleId: string, ctx: ImportContext): string {
  const sys = ctx.sourceSystem ?? 'phenopacket';
  return `urn:uuid:${deterministicUuid(`Specimen:${sys}:${biosampleId}`)}`;
}

function mintRawFileIri(uri: string, ctx: ImportContext): string {
  const sys = ctx.sourceSystem ?? 'phenopacket';
  return `urn:uuid:${deterministicUuid(`genomics:RawFile:${sys}:${uri}`)}`;
}

/**
 * Detect a phenopacket file format string and map to a v1-draft FileFormat
 * named individual. Falls back to OtherFileFormat when unrecognized.
 */
function fileFormatNamedIndividual(fmt: string | undefined): string {
  if (!fmt) return 'OtherFileFormat';
  const upper = fmt.toUpperCase().replace(/\.GZ$/, '');
  return FILE_FORMAT_MAP[upper] ?? FILE_FORMAT_MAP[fmt] ?? 'OtherFileFormat';
}

/**
 * Detect file format from URI extension when fileAttributes.fileFormat is
 * absent.
 */
function fileFormatFromUri(uri: string): string | undefined {
  const lower = uri.toLowerCase();
  if (lower.endsWith('.bam')) return 'BAM';
  if (lower.endsWith('.cram')) return 'CRAM';
  if (lower.endsWith('.vcf') || lower.endsWith('.vcf.gz')) return 'VCF';
  if (lower.endsWith('.gvcf') || lower.endsWith('.gvcf.gz')) return 'VCF';
  if (lower.endsWith('.bcf')) return 'BCF';
  if (lower.endsWith('.fastq') || lower.endsWith('.fq') || lower.endsWith('.fastq.gz')) return 'FASTQ';
  return undefined;
}

/**
 * Emit a genomics:RawFile record for a phenopacket file reference.
 */
export function buildRawFileRecord(
  fileNode: any,
  ctx: ImportContext,
  contextLabel: string,
): { record: ParsedRecord; gaps: VocabularyGap[] } | null {
  const gaps: VocabularyGap[] = [];
  const uri: string | undefined = fileNode?.uri;
  if (typeof uri !== 'string' || uri.length === 0) return null;

  const iri = mintRawFileIri(uri, ctx);
  const quads: Quad[] = [];
  quads.push(tripleType(iri, GENOMICS_NS + 'RawFile'));
  quads.push(tripleRef(iri, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'));
  quads.push(tripleStr(iri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));
  quads.push(tripleStr(iri, GENOMICS_NS + 'fileLocation', uri));

  const declaredFormat: string | undefined = fileNode?.fileAttributes?.fileFormat;
  const format = fileFormatNamedIndividual(declaredFormat ?? fileFormatFromUri(uri));
  quads.push(tripleRef(iri, GENOMICS_NS + 'fileFormat', GENOMICS_NS + format));

  const refGenome: string | undefined = fileNode?.fileAttributes?.genomeAssembly;
  if (refGenome) {
    quads.push(tripleStr(iri, GENOMICS_NS + 'referenceGenome', refGenome));
  }

  // No SHA-256 hash carried in phenopackets — emit info gap.
  gaps.push({
    sourceField: `${contextLabel}.files`,
    reason: `RawFile ${uri} carries no SHA-256 hash — phenopackets do not track file-content integrity. fileSizeBytes also unavailable.`,
    severity: 'info',
    context: uri,
  });

  // Other fileAttributes flags
  const attrs = fileNode?.fileAttributes;
  if (attrs && typeof attrs === 'object') {
    for (const k of Object.keys(attrs)) {
      if (k !== 'genomeAssembly' && k !== 'fileFormat' && k !== 'description') {
        gaps.push({
          sourceField: `${contextLabel}.files.fileAttributes.${k}`,
          reason: `Unhandled file attribute "${k}=${String(attrs[k])}" — no v1-draft RawFile slot for it.`,
          severity: 'info',
          context: uri,
        });
      }
    }
    if (typeof attrs.description === 'string' && attrs.description.length > 0) {
      quads.push(tripleStr(iri, NS.cascade + 'displayName', attrs.description));
    }
  }

  return {
    record: {
      iri,
      cascadeType: 'genomics:RawFile',
      sourceId: uri,
      fhirResourceType: 'DocumentReference',
      quads,
    },
    gaps,
  };
}

/**
 * Parse a single biosample into a fhir:Specimen-anchored record + any
 * raw-file records its `files[]` produces.
 */
export function parseBiosample(
  bs: any,
  patientIri: string | undefined,
  ctx: ImportContext,
  contextLabel: string,
): BiosampleParseOutput {
  const records: ParsedRecord[] = [];
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];

  if (!bs || typeof bs !== 'object') return { records, quads, warnings, gaps };

  const sourceId: string =
    typeof bs.id === 'string' && bs.id.length > 0 ? bs.id : `biosample:${ctx.importedAt}:${Math.random()}`;
  const iri = mintSpecimenIri(sourceId, ctx);
  const sQuads: Quad[] = [];

  // ---- Type + provenance ----
  // We anchor on fhir:Specimen as the L1 type — no v1-draft Specimen-class
  // wrapper exists. Emit an info gap so the gap-audit picks this up.
  sQuads.push(tripleType(iri, FHIR_SPECIMEN_TYPE));
  sQuads.push(tripleRef(iri, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'));
  sQuads.push(tripleStr(iri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));
  sQuads.push(tripleStr(iri, NS.cascade + 'sourceFhirId', sourceId));

  gaps.push({
    sourceField: `${contextLabel}.biosamples[${sourceId}]`,
    reason:
      'Biosample anchored on fhir:Specimen (Layer 1) — v1-draft has no Layer-2 specimen class. Tissue / taxonomy / collection-age stored under cascade-prefixed predicates as a stop-gap.',
    severity: 'info',
    context: sourceId,
  });

  // ---- Patient anchor ----
  if (patientIri) {
    sQuads.push(tripleRef(iri, NS.cascade + 'aboutPatient', patientIri));
  }

  // ---- Description ----
  if (typeof bs.description === 'string' && bs.description.length > 0) {
    sQuads.push(tripleStr(iri, NS.cascade + 'displayName', bs.description));
  }

  // ---- sampledTissue ----
  if (bs.sampledTissue?.id) {
    sQuads.push(tripleStr(iri, NS.cascade + 'sampledTissueId', bs.sampledTissue.id));
    if (bs.sampledTissue.label) {
      sQuads.push(tripleStr(iri, NS.cascade + 'sampledTissueLabel', bs.sampledTissue.label));
    }
  }

  // ---- taxonomy ----
  if (bs.taxonomy?.id) {
    sQuads.push(tripleStr(iri, NS.cascade + 'speciesTaxon', bs.taxonomy.id));
    if (bs.taxonomy.label) {
      sQuads.push(tripleStr(iri, NS.cascade + 'speciesLabel', bs.taxonomy.label));
    }
  }

  // ---- timeOfCollection / individualAgeAtCollection ----
  const ageIso: string | undefined =
    bs.timeOfCollection?.age?.iso8601duration ??
    bs.individualAgeAtCollection?.age ??
    bs.individualAgeAtCollection?.iso8601duration;
  if (typeof ageIso === 'string') {
    sQuads.push(tripleStr(iri, NS.cascade + 'ageAtCollection', ageIso));
  }

  // ---- materialSample / histologicalDiagnosis / tumor* — info gaps ----
  for (const fld of [
    'materialSample',
    'histologicalDiagnosis',
    'tumorProgression',
    'tumorGrade',
    'pathologicalStage',
    'pathologicalTnmFinding',
    'tumorStage',
    'diagnosticMarkers',
    'procedure',
    'phenotypicFeatures',
    'measurements',
  ]) {
    if (bs[fld] !== undefined) {
      gaps.push({
        sourceField: `${contextLabel}.biosamples[${sourceId}].${fld}`,
        reason: `Biosample field "${fld}" dropped — v1-draft has no Specimen-level slot for tumor / histopathology / measurement detail.`,
        severity: 'info',
        context: sourceId,
      });
    }
  }

  // ---- files[] (D-DIRECTORY) ----
  if (Array.isArray(bs.files)) {
    for (const f of bs.files) {
      const rfOut = buildRawFileRecord(f, ctx, `${contextLabel}.biosamples[${sourceId}]`);
      if (rfOut) {
        records.push(rfOut.record);
        quads.push(...rfOut.record.quads);
        gaps.push(...rfOut.gaps);
        // Specimen → RawFile link (use cascade:hasRawFile until v1-draft adds one)
        sQuads.push(tripleRef(iri, NS.cascade + 'hasRawFile', rfOut.record.iri));
      }
    }
  }

  records.push({
    iri,
    cascadeType: 'fhir:Specimen',
    sourceId,
    fhirResourceType: 'Specimen',
    quads: sQuads,
  });
  quads.push(...sQuads);

  return { records, quads, warnings, gaps };
}
