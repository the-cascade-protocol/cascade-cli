/**
 * Resolving `<reference value="#id"/>` against a C-CDA section's own narrative.
 *
 * A C-CDA section's `<text>` block is the attested, human-readable rendering, and
 * the structured entries are allowed to point INTO it rather than repeat what it
 * says:
 *
 *   <text>…<content ID="labname1">Hemoglobin</content>…</text>
 *   …
 *   <code code="30313-1" codeSystem="…6.1">
 *     <originalText><reference value="#labname1"/></originalText>
 *   </code>
 *
 * There is no `@displayName` there, and the name is not missing — it is one
 * dereference away. A handler that reads `@displayName` only concludes the record
 * has no name and drops it, which is how lab results reached a pod with no
 * `health:testName` (a `sh:minCount 1` property) despite the document naming
 * every one of them.
 *
 * WHY THIS IS SHARED
 * ------------------
 * `medications.ts` already carried a private copy of this resolution, written for
 * Epic's `#medNN` paragraphs, and `allergies.ts` carries a note asking for the
 * same thing. That is the beginning of the pattern this repository keeps paying
 * for: one correct implementation, copied to the site that needed it, and absent
 * from the four that needed it later. The medications copy is now this module,
 * moved rather than reimplemented, so its behaviour is unchanged and the other
 * handlers call the same code.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It never invents a name. An ID no element declares, and an element holding only
 * whitespace, both resolve to the empty string, and callers emit nothing. The
 * resulting `minCount` violation is a true statement about a document that did
 * not name the record in any place this converter can read.
 */

/**
 * Every narrative element that declares an `ID`, mapped to its flattened text.
 *
 * Only non-empty text is mapped, so a caller cannot tell an ID apart from a blank
 * one — deliberately: both mean "no name here".
 */
export function buildNarrativeIdMap(sectionText: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const id = node['@_ID'];
    if (typeof id === 'string' && id) {
      const text = collapseText(node);
      if (text) map[id] = text;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('@_')) continue;
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(sectionText);
  return map;
}

/** Collect all `#text` descendants of a parsed node into a single trimmed string. */
export function collapseText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collapseText).filter(Boolean).join(' ').trim();
  if (typeof node === 'object') {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('@_')) continue;
      const t = collapseText(value);
      if (t) parts.push(t);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

/**
 * The text a narrative CONTAINER stands for: the element it references, or the
 * text it carries inline. Empty string when it stands for nothing.
 *
 * A container is any element that may hold `<reference value="#id"/>` — an
 * `<originalText>`, an entry's `<text>`, a `<value>`'s `<originalText>`.
 */
export function narrativeTextFor(
  container: any,
  narrativeIdMap: Record<string, string>,
  warnings?: string[],
): string {
  if (container == null) return '';

  const ref = container?.reference?.['@_value'] ?? container?.reference?.value ?? '';
  if (typeof ref === 'string' && ref.startsWith('#')) {
    const resolved = narrativeIdMap[ref.slice(1)];
    if (resolved) return resolved;
    // A dangling reference is not a name. Fall through to any inline text rather
    // than returning early, then give up.
    //
    // But say so. In the pod a record whose reference did not resolve is
    // byte-indistinguishable from one that carried no name anywhere, so "the
    // rendering we were given was incomplete" and "this test was never named"
    // arrive as the same absence. The warning is the only place the difference
    // still exists, and it costs nothing: the record still gains NO name, since
    // inventing one from the code would fabricate the attested rendering.
    warnings?.push(
      `C-CDA narrative reference "${ref}" does not resolve: no element in the section's ` +
        `<text> declares that ID. The record is imported without the name it pointed at.`,
    );
  }

  const inline = typeof container === 'string' ? container : container?.['#text'];
  if (typeof inline === 'string') return inline.trim();
  if (typeof inline === 'number') return String(inline);
  return '';
}

/**
 * The name a coded element states outside `@displayName`: its `<originalText>`,
 * resolved through the narrative when that is a reference.
 */
export function resolveNarrativeName(
  codeEl: any,
  narrativeIdMap: Record<string, string>,
  warnings?: string[],
): string {
  return narrativeTextFor(codeEl?.originalText, narrativeIdMap, warnings);
}
