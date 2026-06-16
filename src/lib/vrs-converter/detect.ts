/**
 * Format detection for GA4GH VRS Allele JSON-LD documents.
 *
 * Heuristic: parse the input as JSON; return true when the document
 * looks like a VRS Allele:
 *
 *   - parsed.type === 'Allele' AND parsed.location AND parsed.state
 *     (the canonical Allele shape)
 *   - OR parsed['@context'] is a string / array containing a VRS
 *     context URL ("vrs.ga4gh.org" or ".../vrs/...")
 *
 * Must not throw on malformed JSON or unexpected shapes.
 */

interface VrsCandidate {
  '@context'?: unknown;
  type?: unknown;
  location?: unknown;
  state?: unknown;
  id?: unknown;
}

function contextMentionsVrs(ctx: unknown): boolean {
  if (typeof ctx === 'string') {
    return ctx.includes('vrs.ga4gh.org') || /\/vrs\/v?\d/.test(ctx);
  }
  if (Array.isArray(ctx)) {
    return ctx.some(contextMentionsVrs);
  }
  return false;
}

export function detectVrs(input: string | Buffer): boolean {
  let text: string;
  if (Buffer.isBuffer(input)) {
    // Reject obvious binary buffers — JSON inputs are UTF-8 text.
    if (input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b) return false; // gzip
    if (input.length >= 4 && input[0] === 0x50 && input[1] === 0x4b) return false; // ZIP
    text = input.toString('utf-8');
  } else {
    text = input;
  }

  // Strip leading comment block ("# ..."), the corpus fixture has one.
  const cleanedLines = text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
    .trim();
  if (!cleanedLines.startsWith('{')) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanedLines);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const obj = parsed as VrsCandidate;

  // VRS context match
  if (contextMentionsVrs(obj['@context'])) return true;

  // Canonical Allele shape
  if (
    obj.type === 'Allele' &&
    obj.location &&
    typeof obj.location === 'object' &&
    obj.state &&
    typeof obj.state === 'object'
  ) {
    return true;
  }

  // VRS-namespaced ID is also a strong signal even if @context is missing
  // (corpus fixture: `id: "ga4gh:VA.S3LWLZ-..."`)
  if (typeof obj.id === 'string' && obj.id.startsWith('ga4gh:VA.')) return true;

  return false;
}
