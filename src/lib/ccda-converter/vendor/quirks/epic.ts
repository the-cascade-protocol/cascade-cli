/**
 * Epic MyChart quirks:
 * - urn:oid: prefix on all code system OIDs (handled where codes are resolved,
 *   in `code-systems.ts`)
 * - Single-element collections serialized as objects rather than arrays
 *
 * The second one is no longer this module's business. It used to keep its OWN
 * list of element names to force to arrays, and that list did not match the
 * parser's: `organizer` and `supply` were in this list and not in the parser's,
 * so those two elements changed shape depending on the document's custodian.
 * Four section handlers read the object shape, and produced zero records on
 * every document that reached this branch. The list now lives in
 * `ccda-converter/multivalued.ts` and the parser applies it to every document,
 * so the walk below is a no-op on parser output — asserted, not assumed, by
 * `tests/ccda-multivalued-shape.test.ts`.
 *
 * It is kept rather than deleted so the shim stays correct if it is ever handed
 * a document assembled by something other than `parseCcdaXml`.
 */

import { canonicalizeMultivaluedElements } from '../../multivalued.js';

export function normalizeEpic(doc: any): any {
  // Deep clone to avoid mutating input
  const result = JSON.parse(JSON.stringify(doc));
  canonicalizeMultivaluedElements(result);
  return result;
}
