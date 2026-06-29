/**
 * Source adapters: the CONTAINER layer above the per-file FormatImporters.
 *
 * A FormatImporter (import-registry.ts) knows one file FORMAT (FHIR JSON, C-CDA
 * XML, ...). It does not know that a real-world health artifact is often a
 * CONTAINER: a folder, a zip, a vendor export with many files plus a few giant
 * ones. A SourceAdapter fills that gap. It detects a container shape and expands
 * it into the concrete files worth importing, recording what it deliberately
 * skipped (and why), so the importer never silently drops data and never chokes
 * on a multi-GB payload it should not have read whole.
 *
 * This is the first slice of the streaming-ingestion architecture
 * (cascade-assets .../2026-06-26-ingestion-architecture-and-streaming-spike.md).
 * It reuses the existing FormatImporters unchanged: an adapter yields file
 * paths, the proven per-file import path converts them. Streaming converters for
 * the skipped multi-GB artifacts (device time-series) come in a later slice.
 */

/** One artifact an adapter chose not to import, with a human-readable reason. */
export interface SkippedArtifact {
  /** Absolute path of the skipped file or directory. */
  path: string;
  /** Why it was skipped (e.g. "device export, streaming import not yet supported"). */
  reason: string;
}

/**
 * Per-file source provenance an adapter recovered from a container's manifest,
 * keyed (in ExpandedSource.fileSources) by the absolute path of the file it
 * describes.
 *
 * The motivating case: an Apple Health export wraps every clinical record in an
 * `<ClinicalRecord sourceName="..." sourceURL="..." receivedDate="...">` element
 * in export.xml. `sourceName` is the EHR/account of origin exactly as the Health
 * app shows it ("Providence Health & Services", "Swedish", "Kaiser Permanente"),
 * and it is AUTHORITATIVE — present even for records whose FHIR payload omits an
 * absolute organization host (Epic relative references), which is precisely the
 * data the per-resource derivation cannot recover. The container knew the source
 * all along; this carries it through to conversion instead of discarding it.
 */
export interface FileSourceMeta {
  /** The EHR / account of origin as the container labels it (authoritative). */
  sourceEhr?: string;
  /** The source FHIR endpoint URL this record was synced from. */
  sourceUrl?: string;
  /** When the container received this record from the source (as written). */
  receivedDate?: string;
}

/** The result of expanding a container into importable inputs. */
export interface ExpandedSource {
  /** Absolute paths of the concrete files to feed the per-file import path. */
  files: string[];
  /** Artifacts intentionally not imported (surfaced to the user, never silent). */
  skipped: SkippedArtifact[];
  /** What the adapter recognized, for the import report / verbose log. */
  sourceLabel: string;
  /**
   * Optional per-file source provenance recovered from the container manifest,
   * keyed by the absolute file path (matching entries in `files`). The Apple
   * Health adapter populates this from export.xml's `<ClinicalRecord>` wrappers;
   * a plain directory import leaves it undefined. Files absent from the map (or
   * the whole map being undefined) simply fall back to per-resource derivation.
   */
  fileSources?: Record<string, FileSourceMeta>;
}

/**
 * Recognizes a container shape and expands it to importable files. Detection and
 * expansion are synchronous filesystem reads (inputs are local, run once per
 * import). `detect` must never throw.
 */
export interface SourceAdapter {
  /** Stable id (e.g. "apple-health"). */
  id: string;
  /** Human description for help/verbose output. */
  description: string;
  /** True iff this adapter handles `targetPath` (a directory or file). */
  detect(targetPath: string): boolean;
  /** Expand the container into concrete importable files plus skip notes. */
  expand(targetPath: string): ExpandedSource;
}
