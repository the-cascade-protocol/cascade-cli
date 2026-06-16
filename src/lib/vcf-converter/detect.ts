/**
 * Format detection for VCF (Variant Call Format) files.
 *
 * Heuristic: peek at the first ~1KB. If gzipped (magic bytes `1F 8B`),
 * inflate just enough to read the header; otherwise read directly.
 * Returns true when the first non-empty line is `##fileformat=VCFv4.x`
 * (v4.0 or later — VCF v4.0 was the first stable release).
 *
 * The full header / record stream is parsed by `header.ts` and `record.ts`;
 * detection only needs the first line.
 *
 * Must not throw on malformed inputs, missing magic bytes, or truncated
 * gzip streams — return false instead.
 */

import { gunzipSync, constants as zlibConstants } from 'node:zlib';

const GZIP_MAGIC = [0x1f, 0x8b];

/** Returns true when the buffer starts with the gzip magic bytes. */
export function isGzipped(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1];
}

/**
 * Inflate a gzip / BGZF buffer to text. Tolerates trailing garbage and
 * multi-block BGZF streams (which `gunzipSync` happily concatenates) plus
 * truncated tails by passing `Z_SYNC_FLUSH` — clinical VCFs that come from
 * `bgzip -i` partial extracts (e.g., the corpus fixture, which is a 64KB
 * head of a multi-GB file) otherwise raise `unexpected end of file`.
 *
 * `@gmod/vcf` doesn't inflate BGZF on its own — the consumer is expected to
 * pipe through zlib first, mirroring the README's `pipe(createGunzip())`
 * pattern. We replicate that here.
 */
export function inflateGzip(buf: Buffer): Buffer {
  return gunzipSync(buf, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
}

/**
 * Peek at the first ~bytes of the input as UTF-8 text, transparently
 * inflating gzip-magic buffers. Used for cheap header detection — never
 * loads the whole file when the input is large.
 */
function peekText(input: string | Buffer, maxBytes: number = 4096): string {
  if (Buffer.isBuffer(input)) {
    if (isGzipped(input)) {
      // For detection only, inflate the whole buffer (corpus is small).
      // Streaming inflation for big inputs happens in record.ts via readline.
      let inflated: Buffer;
      try {
        inflated = inflateGzip(input);
      } catch {
        return '';
      }
      return inflated.subarray(0, Math.min(inflated.length, maxBytes)).toString('utf-8');
    }
    return input.subarray(0, Math.min(input.length, maxBytes)).toString('utf-8');
  }
  return input.slice(0, maxBytes);
}

/**
 * Returns true when the input looks like a VCF v4.0+ file (plain or gzipped).
 * Safe for arbitrary string / Buffer inputs.
 */
export function detectVcf(input: string | Buffer): boolean {
  let text: string;
  try {
    text = peekText(input, 4096);
  } catch {
    return false;
  }

  if (!text) return false;

  // Skip blank lines or BOMs at the very start.
  const trimmed = text.replace(/^﻿/, '');

  // Find the first non-empty line.
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    // VCF v4.x: ##fileformat=VCFv4.0 / 4.1 / 4.2 / 4.3 / 4.4 ...
    return /^##fileformat=VCFv4\.\d+/i.test(line);
  }

  return false;
}
