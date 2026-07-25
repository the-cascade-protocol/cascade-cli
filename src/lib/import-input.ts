/**
 * Input routing for `cascade pod import`.
 *
 * Two decisions live here, both about the file the user handed us:
 *
 *  1. WHAT is it? (`classifyImportInput`) — C-CDA (zip or XML), FHIR JSON, or
 *     Cascade Turtle. A recognized extension is the fast path; anything with a
 *     missing or unrecognized extension is decided by SNIFFING THE BYTES, never
 *     by the name. Real portal downloads arrive extension-less (a URL-derived
 *     filename with no suffix), and an IHE XDM zip that falls through to the
 *     Turtle parser dies with `Unexpected "PK..."`.
 *
 *  2. WHERE is it? (`isPathInsidePod`) — an input path that resolves INSIDE the
 *     destination pod is a pod resource, not an external document, so on an
 *     encrypted pod it must be read through the pod DEK rather than as
 *     plaintext. Containment is answered by the filesystem (device + inode
 *     identity on the fully resolved path), not by string prefixes, because
 *     symlinks, `..` and case-insensitive filesystems all make string
 *     comparison wrong. Getting this wrong in the permissive direction would
 *     mean trying to decrypt a genuinely external file, so every uncertain case
 *     answers "outside".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── 1. What kind of document is this? ────────────────────────────────────────

/** The three converter paths `pod import` can route an input to. */
export type ImportInputKind = 'ccda' | 'fhir-json' | 'turtle';

/**
 * Extensions routed straight to the C-CDA converter (which takes raw bytes and
 * handles both a bare XML document and an IHE XDM zip).
 */
const CCDA_EXTENSIONS = new Set(['.zip', '.xml']);

/**
 * Extensions whose content is known to be text. These keep the historical
 * leading-character rule (`{`/`[` means FHIR JSON, anything else is Turtle) so
 * a `.ttl` document that legitimately opens with an IRI is never re-routed.
 */
const TEXT_EXTENSIONS = new Set(['.json', '.jsonld', '.ndjson', '.ttl']);

/** Bytes to decode when sniffing a header; enough for any leading whitespace. */
const SNIFF_WINDOW = 512;

/**
 * True when the decoded head of `bytes` opens a JSON object or array.
 * A UTF-8 BOM and any leading whitespace are skipped first.
 */
function looksLikeJson(bytes: Buffer): boolean {
  const head = decodeHead(bytes);
  return head.startsWith('{') || head.startsWith('[');
}

/** Decode the first {@link SNIFF_WINDOW} bytes, skipping a BOM and whitespace. */
function decodeHead(bytes: Buffer): string {
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3; // UTF-8 BOM
  }
  // A multi-byte character may be cut at the window edge; only the START of the
  // decoded text is ever inspected, so a trailing replacement char is harmless.
  return bytes.subarray(start, start + SNIFF_WINDOW).toString('utf-8').trimStart();
}

/**
 * True when `bytes` begins with a ZIP signature: a local file header
 * (`PK\x03\x04`), an empty archive's end-of-central-directory (`PK\x05\x06`),
 * or a spanned archive marker (`PK\x07\x08`).
 */
export function looksLikeZip(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false; // 'P' 'K'
  const [b2, b3] = [bytes[2], bytes[3]];
  return (
    (b2 === 0x03 && b3 === 0x04) ||
    (b2 === 0x05 && b3 === 0x06) ||
    (b2 === 0x07 && b3 === 0x08)
  );
}

/**
 * True when `bytes` begins with an XML declaration or a bare C-CDA root
 * element. Deliberately narrow: Turtle may legitimately start with `<` (an
 * IRI), so a generic "starts with an angle bracket" test would misroute it.
 */
export function looksLikeCcdaXml(bytes: Buffer): boolean {
  const head = decodeHead(bytes);
  return head.startsWith('<?xml') || head.startsWith('<ClinicalDocument');
}

/**
 * Decide the kind of an import input from its bytes alone. Returns `undefined`
 * when nothing recognizable is at the head, which the caller reads as "no
 * evidence" rather than "Turtle".
 */
export function sniffImportInput(bytes: Buffer): ImportInputKind | undefined {
  if (looksLikeZip(bytes)) return 'ccda';
  if (looksLikeCcdaXml(bytes)) return 'ccda';
  if (looksLikeJson(bytes)) return 'fhir-json';
  return undefined;
}

/**
 * Route one import input to a converter path.
 *
 * Fast path: a recognized extension decides without reading the head. When the
 * extension is missing or unrecognized the bytes decide, and Turtle remains the
 * final fallback (unchanged from the extension-only behavior).
 *
 * @param filePath the input path (only its extension is consulted)
 * @param bytes    the file's content, already decrypted if it was a pod resource
 */
export function classifyImportInput(filePath: string, bytes: Buffer): ImportInputKind {
  const ext = path.extname(filePath).toLowerCase();
  if (CCDA_EXTENSIONS.has(ext)) return 'ccda';
  if (TEXT_EXTENSIONS.has(ext)) return looksLikeJson(bytes) ? 'fhir-json' : 'turtle';
  return sniffImportInput(bytes) ?? 'turtle';
}

// ─── 2. Is this input a resource of the destination pod? ──────────────────────

/**
 * True when `filePath` resolves to a location inside `podDir`.
 *
 * Both paths are fully resolved (`fs.realpathSync`) before comparison, then the
 * input's ancestor chain is walked comparing device + inode against the pod
 * directory. Identity by inode is what makes this correct on a case-insensitive
 * filesystem and through symlinked ancestors (`/tmp` -> `/private/tmp`) without
 * guessing at case-folding rules.
 *
 * Conservative by construction:
 *  - The input file's OWN symlink is resolved, so a link planted inside the pod
 *    that points at an external file answers "outside".
 *  - Any error (missing file, unreadable directory) answers "outside", which
 *    means "treat it as an external plaintext document" — the pre-existing
 *    behavior.
 *  - The pod directory itself is not "inside" itself; only descendants are.
 */
export function isPathInsidePod(filePath: string, podDir: string): boolean {
  let podStat: fs.Stats;
  try {
    podStat = fs.statSync(fs.realpathSync(podDir));
  } catch {
    return false;
  }
  if (!podStat.isDirectory()) return false;

  let current: string;
  try {
    // Resolve the input itself, then start the walk at its parent: a file is
    // "inside" the pod when one of its ANCESTORS is the pod directory.
    current = path.dirname(fs.realpathSync(filePath));
  } catch {
    return false;
  }

  // Bounded by the filesystem depth of the resolved path.
  for (;;) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(current);
    } catch {
      return false;
    }
    if (stat.dev === podStat.dev && stat.ino === podStat.ino) return true;
    const parent = path.dirname(current);
    if (parent === current) return false; // reached the filesystem root
    current = parent;
  }
}
