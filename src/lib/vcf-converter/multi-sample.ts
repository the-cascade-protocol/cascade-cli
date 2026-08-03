/**
 * Multi-sample handling + SequencingRun emission.
 *
 * One VCF maps to one `genomics:SequencingRun`. Every Variant emitted from
 * record.ts links back to the SequencingRun via `prov:wasGeneratedBy`.
 *
 * SequencingRun properties wired up here (those present in
 * spec/ontologies/genomics/v1-draft @ owl:versionInfo "1.0-draft"):
 *
 *   - genomics:referenceGenome     ← header.reference (e.g. GRCh38)
 *   - genomics:variantCallerVersion ← header.source   (e.g. ClinVar /
 *                                      "GATK HaplotypeCaller v4.5")
 *   - genomics:fileGenerationDate  ← header.fileDate (xsd:date)
 *
 * Per-sample IRIs are minted from header.samples + header.sampleColumns
 * and tracked in the returned record so record.ts (TASK-3A.4 extension)
 * can attach genomics:observedIn once that predicate lands. Until
 * v1-draft.0.2 ships those IRIs aren't published into the graph; we just
 * mint them so the multi-sample plumbing is in place.
 */

import { DataFactory, type Quad } from 'n3';
import type { ImportContext, VocabularyGap } from '../import-types.js';
import {
  NS,
  SCHEMA_VERSION,
  deterministicUuid,
  tripleType,
  tripleStr,
  tripleTyped,
} from '../fhir-converter/types.js';
import { GENOMICS_NS } from '../fhir-genomics-converter/types.js';
import type { VcfHeader } from './types.js';
import type { ParsedRecord } from './record.js';

const { namedNode } = DataFactory;
void namedNode;

/**
 * Mint a SequencingRun IRI from the content of the VCF, and nothing else.
 *
 * Key:  `SequencingRun|sha256:<digest of the decompressed VCF bytes>`
 *
 * The invariant this buys: **the same VCF content always has the same run
 * identity, no matter where the file sits, what it is named, or whether it
 * is gzipped.** Every `genomics:Variant` IRI derives from the run IRI
 * (`mintVariantIri` in record.ts) and so does every sample IRI
 * (`mintSampleIri` below), so this one key fixes the identity of the whole
 * subgraph. Re-importing a moved, renamed, or re-compressed copy of a VCF
 * therefore reconciles against the records already in the pod instead of
 * minting a duplicate run with a duplicate set of variants.
 *
 * Two things this key deliberately does NOT contain:
 *
 *   - `ImportContext.inputPath`. Hashing the absolute path was the original
 *     scheme, and it is exactly what made run identity non-reproducible:
 *     identical bytes at two paths minted two different runs. The path is
 *     still recorded as `sourceId` on the import manifest entry, which is
 *     the right home for "where did these bytes come from" — provenance,
 *     not identity.
 *   - The header coordinates (`fileDate`, `source`, `reference`) that the
 *     old key carried alongside the path. They are read out of the content,
 *     so the digest already determines them; including them again would
 *     imply they contribute identity when they cannot.
 *
 * A basename would also be path-independent, but it is not content-
 * addressed: two unrelated VCFs both named `sample.vcf.gz` would collide
 * into one run. The digest is the only key here that is both stable under
 * relocation and distinct across distinct content.
 */
function mintSequencingRunIri(contentDigest: string): string {
  return `urn:uuid:${deterministicUuid(`SequencingRun|sha256:${contentDigest}`)}`;
}

/** Mint a per-sample IRI deterministic on (sequencingRunIri, sampleName). */
export function mintSampleIri(sequencingRunIri: string, sampleName: string): string {
  return `urn:uuid:${deterministicUuid(`Sample|${sequencingRunIri}|${sampleName}`)}`;
}

/**
 * Normalize VCF ##fileDate values into ISO 8601 dates where possible:
 *   2026-05-03   → '2026-05-03'  (already ISO)
 *   20260503     → '2026-05-03'  (compact YYYYMMDD)
 *   anything else → undefined    (don't emit a malformed xsd:date)
 */
function normalizeFileDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{8}$/.test(trimmed)) {
    return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
  }
  return undefined;
}

/**
 * Emit the SequencingRun record for the VCF. Properties the v1-draft
 * doesn't yet model (per-sample observedIn, contig manifest) are returned
 * via `gaps` so the orchestrator can fold them into the run-level audit.
 *
 * `contentDigest` is the SHA-256 of the decompressed VCF bytes, computed
 * once by the orchestrator (`computeContentDigest` in index.ts). It is the
 * sole input to the run's identity — see `mintSequencingRunIri` above.
 */
export function emitSequencingRun(
  header: VcfHeader,
  ctx: ImportContext,
  contentDigest: string,
): ParsedRecord & { sampleIris: Map<string, string>; gaps: VocabularyGap[] } {
  const iri = mintSequencingRunIri(contentDigest);
  const quads: Quad[] = [];
  const gaps: VocabularyGap[] = [];

  quads.push(tripleType(iri, GENOMICS_NS + 'SequencingRun'));
  // Common provenance + schema-version triples (mirrors fhir-converter).
  quads.push(
    DataFactory.quad(
      namedNode(iri),
      namedNode(NS.cascade + 'dataProvenance'),
      namedNode(NS.cascade + 'ClinicalGenerated'),
    ),
  );
  quads.push(tripleStr(iri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));

  if (header.reference) {
    quads.push(tripleStr(iri, GENOMICS_NS + 'referenceGenome', header.reference));
  }
  if (header.source) {
    quads.push(tripleStr(iri, GENOMICS_NS + 'variantCallerVersion', header.source));
  }
  const fileDate = normalizeFileDate(header.fileDate);
  if (fileDate) {
    quads.push(tripleTyped(iri, GENOMICS_NS + 'fileGenerationDate', fileDate, NS.xsd + 'date'));
  } else if (header.fileDate) {
    // Preserve the raw value so it isn't silently dropped.
    quads.push(tripleStr(iri, NS.cascade + 'unmappedField', `VCF.fileDate=${header.fileDate}`));
    gaps.push({
      sourceField: 'VCF.fileDate',
      reason: `Unparseable ##fileDate value "${header.fileDate}" — expected YYYY-MM-DD or YYYYMMDD.`,
      severity: 'info',
      context: iri,
    });
  }

  // Sample IRI minting. ##SAMPLE=<ID=...> headers and the #CHROM column
  // names are merged — column names take precedence (they always exist
  // for multi-sample VCFs; ##SAMPLE is optional metadata).
  const sampleNames = new Set<string>();
  for (const id of header.samples.keys()) sampleNames.add(id);
  for (const name of header.sampleColumns) sampleNames.add(name);

  const sampleIris = new Map<string, string>();
  for (const name of sampleNames) {
    sampleIris.set(name, mintSampleIri(iri, name));
  }

  // Gap-info: per-sample observedIn predicate isn't in v1-draft.0.1.
  // Mint the IRIs so they're stable for downstream tooling, but don't
  // emit edges yet — the orchestrator picks this up alongside the
  // VCF.multi-sample warning in record.ts.
  if (sampleNames.size > 0) {
    gaps.push({
      sourceField: 'VCF.SAMPLE',
      reason: `${sampleNames.size} sample IRI(s) minted; genomics:observedIn predicate pending v1-draft.0.2 — sample-level observation links not yet emitted.`,
      severity: 'info',
      context: iri,
    });
  }

  // Gap-info: SHACL on SequencingRun requires genomics:coverageDepth and
  // genomics:sequencingTechnology. VCF carries neither directly — those
  // come from the upstream sequencing pipeline / lab metadata, not the
  // variant-call output. Surface as warnings so users know the resulting
  // graph won't pass strict SHACL until the pipeline emits a separate
  // SequencingRun annotation. The acceptance bar here per the v0.1
  // implementation plan is "validates OR has documented gaps".
  gaps.push({
    sourceField: 'SequencingRun.coverageDepth',
    reason:
      'VCF format does not carry per-run coverage; SHACL requires genomics:coverageDepth on every SequencingRun. Enrich from FASTQ-step QC metadata downstream or accept the SHACL violation.',
    severity: 'warning',
    context: iri,
  });
  gaps.push({
    sourceField: 'SequencingRun.sequencingTechnology',
    reason:
      'VCF format does not carry sequencing-technology metadata; SHACL requires genomics:sequencingTechnology on every SequencingRun. Enrich from upstream pipeline metadata (Illumina vs ONT vs PacBio) or accept the SHACL violation.',
    severity: 'warning',
    context: iri,
  });

  return {
    iri,
    cascadeType: 'genomics:SequencingRun',
    sourceId: ctx.inputPath ?? '<stdin>',
    quads,
    sampleIris,
    gaps,
  };
}
