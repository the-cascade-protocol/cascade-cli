/**
 * Shared importer interface for the `cascade convert` registry.
 *
 * Every input format the CLI supports is represented as a FormatImporter.
 * The registry (import-registry.ts) holds the list. The convert command
 * (commands/convert.ts) is a thin dispatcher: it looks up an importer by
 * --from value, calls convert(), then optionally postProcess() for sidecar
 * work like writing import manifests or narrative-block sidecars.
 *
 * New importers (fhir-genomics, clinvar, phenopacket, vcf, vrs, lab-pdf,
 * counselor-letter, etc.) implement this interface directly and register a
 * one-line entry. They do not edit convert.ts.
 *
 * The legacy fhir-converter and ccda-converter retain their internal types
 * (ConversionResult / BatchConversionResult). Their registry entries adapt
 * those internal shapes to the unified ImportResult here so genomics
 * importers and the rest of the CLI see a consistent contract.
 */

import type { Quad } from 'n3';
import type { OutputFormat } from './fhir-converter/types.js';

export type { OutputFormat };

/**
 * Per-conversion runtime context. Importers receive this on every call.
 * Sidecar options (--manifest, --extract-narratives, ...) are passed
 * through `options` so importers can declare and consume their own flags
 * without convert.ts knowing about them.
 */
export interface ImportContext {
  /**
   * Path to the input file, or '<stdin>' when reading from stdin.
   * Importers use this for sidecar file naming (e.g., manifest co-location).
   */
  inputPath: string;

  /** Output serialization for Cascade Turtle/JSON-LD targets. */
  outputSerialization: 'turtle' | 'jsonld';

  /** Optional --source-system tag injected onto every converted record. */
  sourceSystem?: string;

  /** FHIR passthrough mode — full preserves cascade:fhirJson, minimal omits it. */
  passthroughMinimal?: boolean;

  /** ISO 8601 timestamp captured at convert-command entry. */
  importedAt: string;

  /** Per-importer flag bag. Keys correspond to declarations in cliOptions. */
  options: Record<string, unknown>;
}

/**
 * A field in the source format that has no mapping into Cascade vocabulary.
 * Surfaced so users can see where data was dropped or left at L1 passthrough.
 * Genomics importers populate this; legacy FHIR + C-CDA leave it empty for now.
 */
export interface VocabularyGap {
  /** Dot-path or other locator for the source field. */
  sourceField: string;

  /** Why this field has no Cascade mapping. */
  reason: string;

  /**
   * One of:
   *   'info'    — field recognized but deliberately not mapped (acceptable loss)
   *   'warning' — field carried meaningful data that was dropped or only partially preserved
   */
  severity: 'info' | 'warning';

  /** Optional: pointer to the source-record IRI or path where this gap occurred. */
  context?: string;
}

/** Non-fatal warning produced during conversion. */
export interface ImportWarning {
  message: string;
  /** Optional: IRI of the converted record this warning relates to. */
  recordRef?: string;
}

/**
 * Identifier of a converted record. Useful for downstream reconcile, dedup,
 * and audit reporting. Legacy importers populate sparsely; genomics importers
 * are expected to populate completely.
 */
export interface ImportedIdentifier {
  /** The new Cascade IRI. */
  cascadeIri: string;
  /** e.g., 'clinical:Medication', 'genomics:Variant'. */
  cascadeType: string;
  /** e.g., 'FHIR.MedicationStatement', 'ClinVar.VCV000017661'. */
  sourceType?: string;
  /** Original ID in the source format. */
  sourceId?: string;
}

/**
 * Unified return shape from any importer's convert() call.
 *
 * Designed to subsume the legacy BatchConversionResult while leaving
 * room for genomics-era enrichments (vocabulary gaps, structured warnings,
 * stable-identifier provenance).
 */
export interface ImportResult {
  success: boolean;
  /** Serialized output (Turtle, JSON-LD, FHIR JSON). */
  output: string;
  format: OutputFormat;
  resourceCount: number;
  skippedCount: number;
  warnings: ImportWarning[];
  errors: string[];
  vocabularyGaps: VocabularyGap[];
  importedIdentifiers: ImportedIdentifier[];

  /**
   * Per-record summary, populated by importers that produce multiple
   * records from a single input (FHIR Bundles, FHIR Genomics IG bundles,
   * Phenopacket cohorts, multi-record ClinVar exports). Optional.
   */
  records?: Array<{
    resourceType: string;
    cascadeType: string;
    warnings: string[];
  }>;

  /**
   * Raw quads, opt-in. Importers may attach for downstream tooling
   * (manifest builders, gap reporters). Most consumers should rely on `output`.
   */
  quads?: Quad[];
}

/**
 * CLI option declaration that an importer contributes to `cascade convert`.
 * Wired into Commander at command registration; the value lands in
 * ImportContext.options under the camelCased flag key.
 */
export interface ImporterCliOption {
  /** Commander option spec, e.g., '--manifest [file]'. */
  flag: string;
  description: string;
  /** Optional default (passed through to Commander). */
  defaultValue?: unknown;
}

/**
 * The contract every importer implements. Registered by adding one entry
 * to the array in import-registry.ts.
 */
export interface FormatImporter {
  /** Matches the value passed to --from. Lowercase, no whitespace. */
  format: string;

  /** Human-readable. Used in --help and `cascade capabilities`. */
  description: string;

  /** Output formats this importer supports; --to is validated against this list. */
  supportedOutputs: OutputFormat[];

  /**
   * Heuristic content-based detection. Returns true if `input` looks like
   * this format. Used both for the auto-detect warning ("input appears to be X
   * but --from says Y") and for `--from auto` (future). Must not throw.
   */
  detect(input: string | Buffer): boolean;

  /**
   * The actual conversion. Importers wrap their existing converter here,
   * adapting internal result shapes to ImportResult.
   */
  convert(
    input: string | Buffer,
    to: OutputFormat,
    ctx: ImportContext,
  ): Promise<ImportResult>;

  /**
   * Optional post-conversion sidecar work — writing import manifests,
   * narrative-block sidecars, gap reports, etc. Runs only on success and
   * only when relevant flags are set. Errors here are logged to stderr,
   * not fatal to the main conversion.
   */
  postProcess?(
    input: string | Buffer,
    result: ImportResult,
    ctx: ImportContext,
  ): Promise<void>;

  /**
   * Optional sidecar CLI flags this importer contributes. The dispatcher
   * registers them on the convert command at startup; values land in
   * ImportContext.options. Flags are deduplicated across importers — if
   * two importers declare the same flag, the dispatcher errors at startup.
   */
  cliOptions?: ImporterCliOption[];
}
