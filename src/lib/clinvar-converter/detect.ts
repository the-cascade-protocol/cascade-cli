/**
 * Format detection for ClinVar VCV XML.
 *
 * Heuristic: ClinVar exports the VCV-aggregate format as
 *   `<ClinVarResult-Set><VariationArchive ...>...</VariationArchive></ClinVarResult-Set>`
 *
 * Older / alternative ClinVar shapes also use `<ReleaseSet>` (FTP bulk),
 * `<ClinVarSet>` (legacy public release), and `<VariationReport>` (the
 * single-variant query result). All four are accepted.
 *
 * This is a regex-first detector; we only fall back to XML parsing if
 * the cheap path is inconclusive. Must not throw on malformed input —
 * returns false instead.
 */

const ROOT_HINT_RE = /<(\?xml[^>]*\?>\s*)?(<!--[^]*?-->\s*)*<(ClinVarResult-Set|ReleaseSet|ClinVarSet|VariationArchive|VariationReport)\b/;

/**
 * Returns true when the input looks like a ClinVar VCV / variation XML
 * export. Safe for binary buffers (returns false on ZIP magic).
 */
export function detectClinvar(input: string | Buffer): boolean {
  let text: string;
  if (Buffer.isBuffer(input)) {
    if (input.length >= 2 && input[0] === 0x50 && input[1] === 0x4b) return false;
    text = input.toString('utf-8');
  } else {
    text = input;
  }

  const trimmed = text.trimStart();
  if (!trimmed.startsWith('<')) return false;

  // Cheap path: scan only the leading kilobyte for the root element hint.
  const head = trimmed.slice(0, 4096);
  if (ROOT_HINT_RE.test(head)) return true;

  // Some ClinVar exports prepend long XML comments before the root.
  // Quick fallback — search the whole stripped prefix for a known root tag.
  const headFull = trimmed.slice(0, 16384);
  if (
    /<ClinVarResult-Set[\s>]/.test(headFull) ||
    /<ReleaseSet[\s>]/.test(headFull) ||
    /<ClinVarSet[\s>]/.test(headFull) ||
    /<VariationArchive[\s>]/.test(headFull) ||
    /<VariationReport[\s>]/.test(headFull)
  ) {
    return true;
  }

  return false;
}
