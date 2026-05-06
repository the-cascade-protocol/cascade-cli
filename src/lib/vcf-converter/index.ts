/**
 * Public surface for the VCF → Cascade converter.
 *
 * Orchestrator function `convertVcf()` consumes a VCF file (plain or gzipped),
 * streams through it, parses the header (header.ts) and emits per-record
 * `genomics:Variant` quads (record.ts) plus a single `genomics:SequencingRun`
 * record (multi-sample.ts).
 *
 * Streaming is mandatory — clinical VCFs run to GBs. We use Node's
 * `readline` over a gunzip stream, never loading the whole file into a
 * JS string.
 *
 * VRS hashes (D-Q6) are preserved only — the VCF importer never computes
 * VRS digests; that's the VRS importer's job, and even there only when
 * the input *is* a VRS Allele.
 *
 * Quality-tier defaulting (D-QUALITY-TIER):
 *   - `##source=ClinVar` → `genomics:ClinicalGrade` (curated clinical aggregate)
 *   - everything else    → `genomics:ResearchGrade`
 */

import type { Quad } from 'n3';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { createGunzip, constants as zlibConstants } from 'node:zlib';

import type {
  ImportContext,
  ImportWarning,
  VocabularyGap,
  ImportedIdentifier,
} from '../import-types.js';
import { isGzipped } from './detect.js';
import { parseHeaderLines, classifySource } from './header.js';
import { parseRecordLine, type ParsedRecord } from './record.js';
import { emitSequencingRun } from './multi-sample.js';

export { detectVcf, isGzipped, inflateGzip } from './detect.js';
export { vcfImporter } from './registry-entry.js';

/** Result of a VCF conversion run. */
export interface VcfConversionResult {
  records: ParsedRecord[];
  quads: Quad[];
  warnings: ImportWarning[];
  vocabularyGaps: VocabularyGap[];
  importedIdentifiers: ImportedIdentifier[];
  /** SequencingRun IRI minted from the header; every Variant references it via prov:wasGeneratedBy. */
  sequencingRunIri?: string;
  /** Number of VCF records read (one per line; multi-ALT records still count once). */
  recordsRead: number;
  /** Number of variants emitted (= recordsRead × ALT alleles). */
  variantsEmitted: number;
}

/**
 * Build a Readable stream over the input, transparently piping through
 * gunzip when the buffer is gzipped. Strings are wrapped with Readable.from.
 */
function inputToLineStream(input: string | Buffer): NodeJS.ReadableStream {
  if (Buffer.isBuffer(input)) {
    if (isGzipped(input)) {
      const src = Readable.from([input]);
      // Z_SYNC_FLUSH lets us read truncated multi-block BGZF without throwing
      // — clinical VCFs from bgzip-indexed extracts (e.g. the conformance
      // fixture, a 64KB head of a much larger file) end mid-block and
      // would otherwise crash with "unexpected end of file".
      const gunzip = createGunzip({ finishFlush: zlibConstants.Z_SYNC_FLUSH });
      return src.pipe(gunzip);
    }
    return Readable.from([input]);
  }
  return Readable.from([Buffer.from(input, 'utf-8')]);
}

/**
 * Stream-parse a VCF file and emit Variant + SequencingRun quads.
 *
 * Two-phase flow per record:
 *   1. Buffer `##` and `#CHROM` header lines until the first non-header
 *      line. Build the parser + record-level metadata.
 *   2. For each record line, emit one Variant per ALT allele.
 */
export async function convertVcf(
  input: string | Buffer,
  ctx: ImportContext,
): Promise<VcfConversionResult> {
  const result: VcfConversionResult = {
    records: [],
    quads: [],
    warnings: [],
    vocabularyGaps: [],
    importedIdentifiers: [],
    recordsRead: 0,
    variantsEmitted: 0,
  };

  const headerLines: string[] = [];
  let headerParsed = false;
  let header: ReturnType<typeof parseHeaderLines> | null = null;
  let sequencingRunIri: string | undefined;

  const stream = inputToLineStream(input);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;

    // Phase 1 — buffer header
    if (!headerParsed) {
      if (line.startsWith('#')) {
        headerLines.push(line);
        continue;
      }
      // First non-`#` line: finalize header, then fall through to record parsing.
      header = parseHeaderLines(headerLines);
      const sequencingRun = emitSequencingRun(header, ctx);
      sequencingRunIri = sequencingRun.iri;
      result.sequencingRunIri = sequencingRunIri;
      result.records.push(sequencingRun);
      result.quads.push(...sequencingRun.quads);
      result.importedIdentifiers.push({
        cascadeIri: sequencingRun.iri,
        cascadeType: sequencingRun.cascadeType,
        sourceType: 'VCF.Header',
        sourceId: ctx.inputPath,
      });
      headerParsed = true;
    }

    // Phase 2 — record line
    if (!header || !sequencingRunIri) {
      // Defensive: shouldn't happen because Phase 1 above sets these.
      continue;
    }
    const sourceProfile = classifySource(header);
    const out = parseRecordLine(line, header, sourceProfile, sequencingRunIri, ctx);
    if (!out) {
      // Malformed line; record.ts already emitted a warning.
      continue;
    }
    result.recordsRead += 1;
    for (const variantRecord of out.records) {
      result.records.push(variantRecord);
      result.quads.push(...variantRecord.quads);
      result.importedIdentifiers.push({
        cascadeIri: variantRecord.iri,
        cascadeType: variantRecord.cascadeType,
        sourceType: 'VCF.Variant',
        sourceId: variantRecord.sourceId,
      });
      result.variantsEmitted += 1;
    }
    result.warnings.push(...out.warnings);
    result.vocabularyGaps.push(...out.gaps);
  }

  // Edge case: a VCF with header lines only (no records). Still emit
  // SequencingRun if header was buffered but never finalized.
  if (!headerParsed && headerLines.length > 0) {
    header = parseHeaderLines(headerLines);
    const sequencingRun = emitSequencingRun(header, ctx);
    result.sequencingRunIri = sequencingRun.iri;
    result.records.push(sequencingRun);
    result.quads.push(...sequencingRun.quads);
    result.importedIdentifiers.push({
      cascadeIri: sequencingRun.iri,
      cascadeType: sequencingRun.cascadeType,
      sourceType: 'VCF.Header',
      sourceId: ctx.inputPath,
    });
  }

  return result;
}
