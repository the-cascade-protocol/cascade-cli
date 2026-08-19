/**
 * The datatype a Cascade property is DECLARED to carry, read from the bundled
 * SHACL shapes, plus the one place a user-supplied string is turned into the
 * RDF literal that declaration calls for.
 *
 * WHY THIS EXISTS
 * ---------------
 * `cascade pod add-record` takes every property value as a string, because JSON
 * and a shell both hand it one. It then wrote every one of them as a PLAIN
 * literal. So a pod could hold
 *
 *     checkup:supplementIsActive "true" ;
 *     checkup:supplementStartDate "2026-01-15" ;
 *     checkup:patientCost "12.50" ;
 *
 * where the vocabulary declares `xsd:boolean`, `xsd:date` and `xsd:decimal`.
 * Nothing in the record says so, which has three consequences that compound:
 *
 *   1. `cascade validate` reports a `sh:datatype` violation for every one of
 *      them. They are Info-severity on the checkup shapes, so the file still
 *      PASSES and the defect is easy to walk past, but the violations are real,
 *      and the same properties on a shape that raises datatype at Warning would
 *      fail the pod outright.
 *   2. A consumer cannot compare or order the values without guessing. A date
 *      held as a plain string sorts lexically by luck, and a decimal held as a
 *      plain string cannot be summed at all without re-parsing it against a
 *      schema the pod does not carry.
 *   3. The pod disagrees with itself: the same property written by an IMPORT
 *      arrives correctly typed (the converters build typed terms), so one pod
 *      can hold both spellings of one property and no reader can tell which is
 *      canonical.
 *
 * WHY THE SHAPES ARE THE SOURCE
 * -----------------------------
 * The alternative is a hand-maintained table of property datatypes in this
 * repository, which is a second copy of something `spec/` already owns and
 * which would drift from it silently on the next vocabulary sync. The bundled
 * shapes ARE the synced copy, they are already loaded by `cascade validate`,
 * and they declare the datatype on the same `sh:path` the writer is about to
 * use. Reading the declaration from them means the writer and the validator can
 * never disagree about what a property is.
 *
 * WHAT IS DELIBERATELY NOT DONE
 * -----------------------------
 * A value whose lexical form does not fit its declared datatype is REFUSED, not
 * coerced and not silently written untyped. Coercion invents data ("yes" is not
 * a boolean, and guessing that it means `true` is a decision the pod cannot
 * later distinguish from the patient having said `true`), and writing it
 * untyped reproduces the very defect this module removes while looking like it
 * succeeded. Refusal is the stance `add-record` already takes on an unwritable
 * IRI, for the same reason: the input is the only place this is still fixable.
 */

import { DataFactory } from 'n3';
import type { Literal } from 'n3';
import { loadShapes } from './shacl-validator.js';
import { findIllegalIriChar } from './bucket-write.js';

const { literal, namedNode } = DataFactory;

const SH = 'http://www.w3.org/ns/shacl#';
const SH_PATH = `${SH}path`;
const SH_DATATYPE = `${SH}datatype`;

export const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** `http://www.w3.org/2001/XMLSchema#boolean` -> `xsd:boolean`. */
export function shortDatatype(iri: string): string {
  return iri.startsWith(XSD) ? `xsd:${iri.slice(XSD.length)}` : iri;
}

/**
 * Raised when a value cannot be the datatype its property declares. Carries the
 * pieces a caller needs to build its own message, not only a rendered string.
 */
export class DatatypeMismatchError extends Error {
  constructor(
    readonly predicateIri: string,
    readonly datatypeIri: string,
    readonly value: string,
  ) {
    super(
      `Value ${JSON.stringify(value)} is not a valid ${shortDatatype(datatypeIri)}. ` +
        `The bundled shapes declare ${predicateIri} as ${shortDatatype(datatypeIri)}, ` +
        `so writing it as given would put a literal in the pod that the pod's own ` +
        `vocabulary rejects. Nothing was written.`,
    );
    this.name = 'DatatypeMismatchError';
  }
}

// ---------------------------------------------------------------------------
// The declaration map
// ---------------------------------------------------------------------------

/** Every `sh:datatype` declared for each plain-predicate `sh:path`, unfiltered. */
function scanDeclarations(): Map<string, Set<string>> {
  const { store } = loadShapes();
  const byPath = new Map<string, Set<string>>();

  for (const q of store.getQuads(null, namedNode(SH_PATH), null, null)) {
    // Only a plain predicate path can be routed by a writer holding one CURIE.
    // Sequence and alternative paths are RDF lists, and a value written under
    // one of them is not a single property assignment.
    if (q.object.termType !== 'NamedNode') continue;
    for (const d of store.getObjects(q.subject, namedNode(SH_DATATYPE), null)) {
      if (d.termType !== 'NamedNode') continue;
      let set = byPath.get(q.object.value);
      if (!set) byPath.set(q.object.value, (set = new Set()));
      set.add(d.value);
    }
  }
  return byPath;
}

let cachedMap: Map<string, string> | undefined;

/**
 * Every property IRI the bundled shapes declare a single `sh:datatype` for.
 *
 * A property declared with two DIFFERENT datatypes across shapes is omitted
 * rather than resolved by precedence: the writer would then have to pick one,
 * and picking wrongly writes a literal the other shape rejects. Measured on the
 * shapes bundled at the time of writing, no such property exists, so the
 * exclusion is a guard rather than behaviour anyone relies on, and the typed
 * literal tests assert the count stays zero so a vocabulary sync that
 * introduces one is visible rather than silent.
 *
 * Cached: the shapes graph is roughly 13k quads and a CLI invocation reads it
 * once.
 */
export function shapeDeclaredDatatypes(): Map<string, string> {
  if (cachedMap) return cachedMap;

  const out = new Map<string, string>();
  for (const [predicate, datatypes] of scanDeclarations()) {
    if (datatypes.size !== 1) continue;
    out.set(predicate, [...datatypes][0]);
  }
  cachedMap = out;
  return out;
}

/** Properties the shapes declare with more than one datatype, sorted. */
export function ambiguouslyDeclaredProperties(): string[] {
  return [...scanDeclarations()]
    .filter(([, datatypes]) => datatypes.size > 1)
    .map(([predicate]) => predicate)
    .sort();
}

/** The datatype IRI declared for `predicateIri`, or undefined if none is. */
export function declaredDatatype(predicateIri: string): string | undefined {
  return shapeDeclaredDatatypes().get(predicateIri);
}

// ---------------------------------------------------------------------------
// Lexical forms
// ---------------------------------------------------------------------------

/** Whether (year, month, day) names a day that exists in the proleptic calendar. */
function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const max = month === 2 && leap ? 29 : lengths[month - 1];
  return day <= max;
}

const DATE_RE = /^(-?\d{4,})-(\d{2})-(\d{2})(Z|[+-]\d{2}:\d{2})?$/;
const DATETIME_RE =
  /^(-?\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

function validDate(v: string): boolean {
  const m = DATE_RE.exec(v);
  return m !== null && isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

function validDateTime(v: string): boolean {
  const m = DATETIME_RE.exec(v);
  if (!m) return false;
  if (!isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) return false;
  const [hour, minute, second] = [Number(m[4]), Number(m[5]), Number(m[6])];
  // 24:00:00 is the one legal hour-24 form in XML Schema.
  if (hour === 24) return minute === 0 && second === 0;
  return hour < 24 && minute < 60 && second < 60;
}

const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;

function validLong(v: string): boolean {
  if (!/^[+-]?\d+$/.test(v)) return false;
  const n = BigInt(v);
  return n >= LONG_MIN && n <= LONG_MAX;
}

function validBase64(v: string): boolean {
  const compact = v.replace(/\s+/g, '');
  return compact.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(compact);
}

/**
 * An anyURI may be relative and may be empty; what it may not contain is a
 * character Turtle cannot carry inside an IRI. Delegated to the bucket writer's
 * own rule rather than restated, so the two cannot drift. The value here is a
 * LITERAL and so is not itself subject to Turtle's IRIREF production, but a
 * value typed anyURI exists to be dereferenced, and one holding a space or a
 * control character is not a URI any consumer can use.
 */
function validAnyUri(v: string): boolean {
  return findIllegalIriChar(v) === undefined;
}

/**
 * Lexical-form check per XML Schema Part 2, one entry per datatype the bundled
 * shapes actually declare.
 *
 * The map is closed on purpose. A datatype with no entry here is REFUSED rather
 * than stamped unchecked, so a vocabulary sync that introduces one surfaces as
 * a refusal on a real write instead of as a pod full of literals nothing ever
 * checked. The typed literal tests assert that every datatype the bundled
 * shapes declare has an entry, so that refusal is caught in CI first.
 */
const LEXICAL_FORMS: Record<string, (v: string) => boolean> = {
  [`${XSD}string`]: () => true,
  [`${XSD}boolean`]: (v) => /^(true|false|1|0)$/.test(v),
  [`${XSD}decimal`]: (v) => /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(v),
  [`${XSD}integer`]: (v) => /^[+-]?\d+$/.test(v),
  [`${XSD}nonNegativeInteger`]: (v) => /^\+?\d+$/.test(v),
  [`${XSD}long`]: validLong,
  [`${XSD}double`]: (v) =>
    /^(INF|-INF|NaN)$/.test(v) || /^[+-]?(\d+(\.\d*)?|\.\d+)([Ee][+-]?\d+)?$/.test(v),
  [`${XSD}date`]: validDate,
  [`${XSD}dateTime`]: validDateTime,
  [`${XSD}anyURI`]: validAnyUri,
  [`${XSD}base64Binary`]: validBase64,
};

/** Datatypes this module knows how to check, sorted, for the coverage tripwire. */
export function checkedDatatypes(): string[] {
  return Object.keys(LEXICAL_FORMS).sort();
}

// ---------------------------------------------------------------------------
// The chokepoint
// ---------------------------------------------------------------------------

/**
 * Build the literal term for one user-supplied property value.
 *
 * A property the shapes declare a datatype for gets that datatype stamped on
 * the term. Everything else stays a plain literal, which is what an undeclared
 * property means: nothing has said what it is, so the writer must not invent an
 * answer.
 *
 * `xsd:string` is written as a plain literal rather than an explicit
 * `^^xsd:string`, because RDF 1.1 defines a plain literal to BE `xsd:string`
 * and the two are the same term. Writing the long form would rewrite every
 * existing string-valued bucket on its next merge for no semantic gain.
 *
 * @throws {DatatypeMismatchError} when the value is not a legal lexical form
 *         for the declared datatype, or when the declared datatype has no
 *         lexical-form check here.
 */
export function typedLiteralForPredicate(predicateIri: string, value: string): Literal {
  const datatype = declaredDatatype(predicateIri);
  if (datatype === undefined || datatype === `${XSD}string`) return literal(value);

  const check = LEXICAL_FORMS[datatype];
  if (!check || !check(value)) throw new DatatypeMismatchError(predicateIri, datatype, value);

  return literal(value, namedNode(datatype));
}
