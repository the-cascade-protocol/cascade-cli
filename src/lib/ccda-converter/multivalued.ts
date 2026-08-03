/**
 * The one list of C-CDA elements that may repeat, and the two accessors that
 * read them.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A C-CDA element that the CDA R2.1 schema declares 0..* is a JavaScript array
 * when the source repeated it and a plain object when the source wrote it once.
 * Every hand-built fixture writes it once. Real exports write it once too, most
 * of the time. So a handler written as `entry.organizer.component` looks correct,
 * passes every test, and returns `undefined` on the documents where it matters.
 *
 * That shape ambiguity used to be resolved in two independent places that could
 * disagree, and did:
 *
 *   - the XML parser's `isArray` predicate, which forced 13 element names to
 *     arrays on every document; and
 *   - each vendor quirk module's own SHOULD_BE_ARRAY list, which forced a
 *     DIFFERENT set on documents from that vendor only.
 *
 * `organizer` and `supply` were in the vendor lists and not in the parser's.
 * The result: `entry.organizer` was an object on most documents and an array on
 * documents whose custodian matched a vendor, so `entry.organizer.component`
 * was correct on the corpus and `undefined` in production. Labs, vital signs,
 * family history and implanted devices all read it that way and all imported
 * zero records, with no error, no warning and no skip count.
 *
 * THE GUARANTEE
 * -------------
 * There is now ONE list, and the parser applies it to EVERY document. A
 * repeatable element is an array always, on every document, from every vendor,
 * before any handler sees it. Vendor normalization can no longer change the
 * shape of anything behind a handler's back, and a test asserts exactly that
 * (`tests/ccda-multivalued-shape.test.ts`), so the shape a test feeds a handler
 * is the shape a real import feeds it.
 *
 * A handler must therefore never dereference a property of one of these
 * containers directly. Use `firstOf()` for the "there is one of these" reading
 * and `listOf()` to iterate. `tests/ccda-multivalued-shape.test.ts` fails the
 * build on a direct dereference, which is what stops the next occurrence — this
 * defect shape shipped three times before that test existed.
 */

/**
 * C-CDA elements parsed as arrays on every document.
 *
 * This is the union of what the parser and the vendor quirk modules used to
 * force independently. It is deliberately NOT the full set of 0..* elements in
 * the CDA R2.1 schema: widening it changes the shape every handler reads, so a
 * name is added here together with the handler changes that name requires.
 *
 * `coding` was in the Epic quirk list and is not a CDA element at all (it is a
 * FHIR JSON key); it never matched anything and is not carried over.
 */
export const CCDA_MULTIVALUED_ELEMENTS = [
  'act',
  'addr',
  'component',
  'encounter',
  'entry',
  'entryRelationship',
  'id',
  'name',
  'observation',
  'organizer',
  'participant',
  'procedure',
  'substanceAdministration',
  'supply',
  'telecom',
] as const;

export type CcdaMultivaluedElement = (typeof CCDA_MULTIVALUED_ELEMENTS)[number];

const MULTIVALUED = new Set<string>(CCDA_MULTIVALUED_ELEMENTS);

/** True when the parser forces this element name to an array. */
export function isMultivaluedElement(name: string): boolean {
  return MULTIVALUED.has(name);
}

/**
 * The single occurrence of a repeatable element, or `undefined` when absent.
 *
 * Use where the document model allows repetition but a handler reads one — an
 * `<entry>` wrapping one `<organizer>`, an `<entry>` wrapping one `<supply>`.
 * Where more than one occurrence carries data, iterate with `listOf` instead;
 * this deliberately keeps the first and drops the rest.
 */
export function firstOf<T>(value: T | T[] | null | undefined): T | undefined {
  if (Array.isArray(value)) return value.length > 0 ? value[0] : undefined;
  return value ?? undefined;
}

/**
 * Every occurrence of a repeatable element as an array, empty when absent.
 * Accepts an already-unwrapped object so it is safe on hand-built input too.
 */
export function listOf<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value.filter((v) => v != null) as T[];
  return value == null ? [] : [value];
}

/**
 * Force every repeatable element in a parsed document to an array, in place.
 *
 * The parser already does this for documents it parsed. This exists for the
 * vendor shims, which must stay correct when handed a document assembled by
 * something other than `parseCcdaXml` (a test, a future adapter). On real parser
 * output it is a no-op, and the shape test asserts that it is.
 */
export function canonicalizeMultivaluedElements(node: unknown): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) canonicalizeMultivaluedElements(item);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (MULTIVALUED.has(key) && value != null && !Array.isArray(value)) {
      obj[key] = [value];
    }
    canonicalizeMultivaluedElements(obj[key]);
  }
}
