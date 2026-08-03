/**
 * Cerner PowerChart quirks:
 * - Omits <id> on many entries; uses <setId> as fallback
 * - Some templateIds may be absent on section entries
 *
 * Array shape is not decided here. See the note in `epic.ts` and the header of
 * `ccda-converter/multivalued.ts`: one list, applied by the parser to every
 * document. This shim's canonicalization is a no-op on parser output and exists
 * only so it stays correct on a document assembled some other way.
 */

import { canonicalizeMultivaluedElements } from '../../multivalued.js';

export function normalizeCerner(doc: any): any {
  const result = JSON.parse(JSON.stringify(doc));
  canonicalizeMultivaluedElements(result);
  return result;
}
