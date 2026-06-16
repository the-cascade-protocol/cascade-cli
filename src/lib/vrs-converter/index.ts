/**
 * Public surface for the VRS → Cascade preserve-only importer.
 *
 * Per D-Q6: this importer ingests a GA4GH VRS Allele JSON-LD object,
 * validates the declared `id` matches the deterministic SHA-512-based
 * hash of its canonical form, and writes:
 *
 *   genomics:Variant
 *     genomics:vrsId      <the declared id, hash-validated>
 *     genomics:vrsObject  <the full Allele JSON, as a string literal>
 *
 * The importer NEVER computes a VRS digest from non-VRS input — it
 * refuses with a clear error. This is the deliberate posture per
 * implementation-plan TASK-3B.
 */

import type { Quad } from 'n3';
import type {
  ImportContext,
  ImportWarning,
  VocabularyGap,
  ImportedIdentifier,
} from '../import-types.js';
import { ingestVrsAllele, type ParsedRecord } from './allele.js';

export { detectVrs } from './detect.js';
export { vrsImporter } from './registry-entry.js';
export { ingestVrsAllele };

export interface VrsConversionResult {
  records: ParsedRecord[];
  quads: Quad[];
  warnings: ImportWarning[];
  vocabularyGaps: VocabularyGap[];
  importedIdentifiers: ImportedIdentifier[];
  errors: string[];
}

/**
 * Strip the corpus-style leading comment block (lines beginning `#`)
 * before JSON.parse. The conformance fixture starts with two `#`
 * comment lines describing the example.
 */
function stripCommentLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/**
 * Parse the input as a VRS Allele JSON document and emit a single
 * preserve-only Variant. Returns `errors` non-empty on hash mismatch
 * or shape failure.
 */
export async function convertVrs(
  input: string | Buffer,
  ctx: ImportContext,
): Promise<VrsConversionResult> {
  const result: VrsConversionResult = {
    records: [],
    quads: [],
    warnings: [],
    vocabularyGaps: [],
    importedIdentifiers: [],
    errors: [],
  };

  const text = Buffer.isBuffer(input) ? input.toString('utf-8') : input;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCommentLines(text));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Invalid JSON in VRS input: ${msg}`);
    return result;
  }

  if (!parsed || typeof parsed !== 'object') {
    result.errors.push('VRS input did not parse to an object.');
    return result;
  }

  const ingest = ingestVrsAllele(parsed, ctx);
  if (ingest.error) {
    result.errors.push(ingest.error);
    return result;
  }
  if (ingest.record) {
    result.records.push(ingest.record);
    result.quads.push(...ingest.record.quads);
    result.importedIdentifiers.push({
      cascadeIri: ingest.record.iri,
      cascadeType: ingest.record.cascadeType,
      sourceType: 'VRS.Allele',
      sourceId: ingest.record.sourceId,
    });
  }
  result.warnings.push(...ingest.warnings);
  result.vocabularyGaps.push(...ingest.gaps);
  return result;
}
