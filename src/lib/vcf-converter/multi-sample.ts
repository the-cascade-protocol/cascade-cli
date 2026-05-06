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

/** Mint a SequencingRun IRI deterministically from input + header coords. */
function mintSequencingRunIri(header: VcfHeader, ctx: ImportContext): string {
  const parts = [
    'SequencingRun',
    ctx.inputPath ?? '<stdin>',
    header.fileDate ?? '',
    header.source ?? '',
    header.reference ?? '',
  ].join('|');
  return `urn:uuid:${deterministicUuid(parts)}`;
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
 */
export function emitSequencingRun(
  header: VcfHeader,
  ctx: ImportContext,
): ParsedRecord & { sampleIris: Map<string, string>; gaps: VocabularyGap[] } {
  const iri = mintSequencingRunIri(header, ctx);
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

  return {
    iri,
    cascadeType: 'genomics:SequencingRun',
    sourceId: ctx.inputPath ?? '<stdin>',
    quads,
    sampleIris,
    gaps,
  };
}
