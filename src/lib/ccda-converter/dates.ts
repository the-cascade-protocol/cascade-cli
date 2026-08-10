/**
 * The one place a C-CDA date becomes an RDF literal.
 *
 * WHY THIS IS A MODULE AND NOT A LINE IN EACH HANDLER
 * ---------------------------------------------------
 * Five section handlers each sliced `<effectiveTime value="20250311"/>` into
 * `2025-03-11` with their own copy of the same three-line expression and wrote it
 * with `literal(dateStr)` — a PLAIN literal, which is `xsd:string`. The shapes
 * constrain those properties to `xsd:date` or `xsd:dateTime`, so every one of
 * those records failed validation on a property the document had stated
 * perfectly well. A correct helper (`tripleDateTime`) already existed in the FHIR
 * converter and had been used at exactly one C-CDA site; four siblings never got
 * it. Five copies of a rule is five chances to fix it in four places, so the rule
 * lives here and the handlers call it.
 *
 * WHAT THE PRECISION RULE IS
 * --------------------------
 * HL7 v3 `TS` is `YYYYMMDDHHMMSS[.SSSS][±ZZzz]`, truncated on the right at
 * whatever precision the system actually knows. FHIR's `dateTime` primitive is
 * partial in the same way, and the shapes accept `xsd:date` OR `xsd:dateTime`
 * for that reason. So:
 *
 *   20250311143000-0500  ->  "2025-03-11T14:30:00-05:00"^^xsd:dateTime
 *   20250311             ->  "2025-03-11"^^xsd:date
 *
 * A day-precision value is NOT promoted to `T00:00:00`. Appending midnight would
 * satisfy a datatype check by asserting a time of day the source never gave, and
 * a fabricated 00:00 is indistinguishable downstream from a real midnight draw.
 * The same reasoning applies to the zone: a time with no offset is left with no
 * offset (`xsd:dateTime` permits that) rather than being stamped `Z`, because
 * the document did not say UTC.
 *
 * Anything coarser than a calendar day (`2025`, `202503`) yields null and is not
 * emitted. `xsd:date` is `YYYY-MM-DD` exactly, `xsd:gYearMonth` is not in the
 * shapes' accepted list, and an untyped literal is the defect this file removes.
 * Callers that need to notice the drop can check for null.
 */

import { NS } from '../fhir-converter/types.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

const XSD_DATE = NS.xsd + 'date';
const XSD_DATETIME = NS.xsd + 'dateTime';

/** A lexical form plus the datatype IRI it is well-formed for. */
export interface CcdaDateTerm {
  value: string;
  datatype: string;
  /**
   * True when the source value was MALFORMED and the day below it was salvaged.
   *
   * `effectiveTime="201102013"` is nine digits: neither the 8-digit calendar day
   * nor the 10-digit hour precision, so the value is wrong past the day. Taking
   * the first eight digits is the right call — throwing a record's date away
   * over a stray digit loses more than it saves — but the result is then a
   * calendar day stated with full confidence on the strength of a value the
   * source got wrong, and byte-indistinguishable from a well-formed day. This
   * flag is what lets the caller say which of the two it is holding.
   */
  salvaged?: boolean;
}

/** `Z` or `±HHMM` / `±HH:MM` at the end of an HL7 TS value. */
const ZONE = /(Z|[+-]\d{2}:?\d{2})$/;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * Convert one C-CDA `effectiveTime`/`@value` to the literal that states it.
 *
 * Returns null when the value is absent, unparseable, or coarser than a day —
 * i.e. whenever there is no honest `xsd:date` or `xsd:dateTime` to write.
 */
export function ccdaDateTerm(raw: unknown): CcdaDateTerm | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Some vendor shims hand back an already-normalized ISO value. Take it as it
  // stands rather than round-tripping it through the digit parser.
  if (ISO_DATE.test(s)) return { value: s, datatype: XSD_DATE };
  if (ISO_DATETIME.test(s)) return { value: s, datatype: XSD_DATETIME };

  const zoneMatch = s.match(ZONE);
  let zone = zoneMatch ? zoneMatch[1] : '';
  const withoutZone = zone ? s.slice(0, s.length - zone.length) : s;
  // Fractional seconds carry no information either datatype needs here.
  const digits = withoutZone.replace(/\.\d+$/, '');

  if (!/^\d+$/.test(digits)) return null;
  if (digits.length < 8) return null;

  const day = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;

  // Day precision. Any zone the source attached is dropped: `2025-03-11` names
  // the same calendar day in every zone, and carrying an offset on a date
  // invites it to be read as a time.
  if (digits.length === 8) return { value: day, datatype: XSD_DATE };

  // Hour, minute or second precision. An odd length past the day means the value
  // is malformed beyond the day; the day is still known and is what gets said —
  // flagged, so the caller can report that the day was salvaged rather than
  // stated.
  if (digits.length !== 10 && digits.length !== 12 && digits.length < 14) {
    return { value: day, datatype: XSD_DATE, salvaged: true };
  }

  const hh = digits.slice(8, 10);
  const mm = digits.length >= 12 ? digits.slice(10, 12) : '00';
  const ss = digits.length >= 14 ? digits.slice(12, 14) : '00';

  // xsd:dateTime writes the offset with a colon; HL7 writes it without.
  if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;

  return { value: `${day}T${hh}:${mm}:${ss}${zone}`, datatype: XSD_DATETIME };
}

/**
 * The quad for a C-CDA date property, or null when there is no date to state.
 *
 * Callers emit conditionally — `const q = ccdaDateQuad(...); if (q) quads.push(q)`
 * — which is the same shape as the `if (dateStr)` guard they had before.
 *
 * `warnings` is where a SALVAGED day is reported. Pass it wherever the import
 * report is reachable: without it a malformed source value becomes a confident
 * calendar day and the import says nothing, so a reader has no way to tell a
 * date the document stated from one this function recovered. The record still
 * gets its day either way — the warning is the only thing that changes.
 */
export function ccdaDateQuad(
  subject: string,
  predicate: string,
  raw: unknown,
  warnings?: string[],
): Quad | null {
  const term = ccdaDateTerm(raw);
  if (!term) return null;
  if (term.salvaged) {
    warnings?.push(
      `C-CDA date "${String(raw).trim()}" is malformed past the calendar day ` +
        `(HL7 v3 TS is YYYYMMDD[HHMMSS]); recorded as ${term.value} from its first eight digits.`,
    );
  }
  return makeQuad(
    namedNode(subject),
    namedNode(predicate),
    literal(term.value, namedNode(term.datatype)),
  );
}
