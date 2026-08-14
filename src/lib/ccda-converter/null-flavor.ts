/**
 * HL7 v3 NullFlavor to FHIR data-absent-reason.
 *
 * WHY A MAPPING AND NOT A PASSTHROUGH
 * -----------------------------------
 * A C-CDA document states WHY an element is missing, using
 * http://terminology.hl7.org/CodeSystem/v3-NullFlavor (OID
 * 2.16.840.1.113883.5.1008). Cascade records that reason on
 * `cascade:dataAbsentReason`, which core v3.6 binds to
 * http://terminology.hl7.org/CodeSystem/data-absent-reason (value set
 * http://hl7.org/fhir/ValueSet/data-absent-reason) — the flat, all-selectable
 * set FHIR R4 binds `Observation.dataAbsentReason` to.
 *
 * The raw nullFlavor code is deliberately NOT written through. Accepting both
 * spellings would give every absence two encodings and turn "are these the same
 * absence?" into a string-comparison question, and the shape in `core.shapes.ttl`
 * rejects a raw NullFlavor code for exactly that reason. The mapping is stated
 * normatively on `cascade:dataAbsentReason` in `spec/ontologies/core/v1/core.ttl`;
 * this table is that statement, executable. Change one and change the other.
 *
 * WHAT IS DELIBERATELY NOT MAPPED
 * -------------------------------
 * `DER`, `UNC`, `QS` and `TRC` are not absences. They say a value exists and is
 * derivable, unencoded, non-zero-but-unquantified, or trace — claims about the
 * value, not about its absence — and flattening them into an absence reason
 * would assert something the source did not. They return `undefined`, which
 * leaves the record exactly as it is today rather than making it wrong.
 */

/**
 * The 15 codes of the data-absent-reason code system, in the order the code
 * system lists them. Exported so a test can assert this file and the shape's
 * `sh:in` still agree; a mapping that produces a code the shape rejects would
 * write an invalid pod.
 */
export const DATA_ABSENT_REASON_CODES = [
  'unknown',
  'asked-unknown',
  'temp-unknown',
  'not-asked',
  'asked-declined',
  'masked',
  'not-applicable',
  'unsupported',
  'as-text',
  'error',
  'not-a-number',
  'negative-infinity',
  'positive-infinity',
  'not-performed',
  'not-permitted',
] as const;

export type DataAbsentReason = (typeof DATA_ABSENT_REASON_CODES)[number];

const NULL_FLAVOR_TO_DATA_ABSENT_REASON: Record<string, DataAbsentReason> = {
  // A proper value applies but is not known.
  UNK: 'unknown',
  // No information at all, and no reason offered. The weakest claim there is,
  // so it maps to the weakest code rather than to a specific reason.
  NI: 'unknown',
  // Information was sought and not found: somebody asked.
  ASKU: 'asked-unknown',
  // Not sought at all. Distinct from ASKU, and this distinction is the single
  // most common thing lost by dropping nullFlavor.
  NASK: 'not-asked',
  // Not available now, expected later.
  NAV: 'temp-unknown',
  // Not available, with no expectation of later availability. There is no
  // data-absent-reason code for "never coming", so it lands on the honest
  // weaker claim rather than borrowing temp-unknown, which would assert an
  // expectation the source explicitly denied.
  NAVU: 'unknown',
  // Withheld for security or privacy.
  MSK: 'masked',
  // Known to have no proper value.
  NA: 'not-applicable',
  // The real value is outside the permitted value domain.
  OTH: 'unsupported',
  NINF: 'negative-infinity',
  PINF: 'positive-infinity',
};

/**
 * Map one nullFlavor attribute to a data-absent-reason code.
 *
 * Returns `undefined` when there is no nullFlavor, when it is not a string, or
 * when it is one of the codes above that is not an absence. Any OTHER
 * unrecognised code maps to `unknown`, which asserts only that a value was
 * expected and is missing — true of every nullFlavor by definition, so it can
 * never be wrong, whereas guessing a specific reason can.
 */
export function mapNullFlavorToDataAbsentReason(raw: unknown): DataAbsentReason | undefined {
  if (typeof raw !== 'string') return undefined;
  const code = raw.trim().toUpperCase();
  if (code.length === 0) return undefined;
  // Claims about a value that exists, not about its absence. See the header.
  if (code === 'DER' || code === 'UNC' || code === 'QS' || code === 'TRC') return undefined;
  return NULL_FLAVOR_TO_DATA_ABSENT_REASON[code] ?? 'unknown';
}
