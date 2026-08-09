/**
 * SHACL violations that the C-CDA converter is currently known to produce, and
 * the rule that keeps the list from becoming a place to hide new ones.
 *
 * WHY THIS EXISTS
 * ---------------
 * health v2.5 defines and shapes five record classes that were emitted but
 * undefined. Records the validator previously reported as conforming — because
 * no shape selected them, and a conforming report over zero constraints is
 * indistinguishable from a conforming report over many — are now actually
 * checked. Everything below is a finding of that kind: the converter's output
 * did not change, the constraints did.
 *
 * WHAT CHANGED AT health v2.6 / clinical v1.14
 * --------------------------------------------
 * The vocabulary question this file said the emitter fix was blocked on has
 * been answered, in the direction this file argued for. The date properties
 * below are no longer `sh:datatype xsd:dateTime`; they are
 * `sh:or ( [ sh:datatype xsd:date ] [ sh:datatype xsd:dateTime ] )`, because
 * FHIR's `dateTime` primitive is explicitly partial-precision and a C-CDA
 * `<effectiveTime value="20250311"/>` states a calendar day and nothing more.
 * Appending `T00:00:00` to satisfy a validator would have fabricated precision
 * the source never had.
 *
 * THE GAP DID NOT GO AWAY, AND IS NOW SMALLER AND SHARPER. The remaining
 * violation is no longer a disagreement about which datatype is right. It is
 * that the emitters write `literal(dateStr)` — a PLAIN literal, which is
 * `xsd:string` — and `xsd:string` is neither `xsd:date` nor `xsd:dateTime`. The
 * shapes now accept exactly what the source can honestly say; the converter
 * still has to say it, by typing the literal. `2025-03-11`^^`xsd:date`
 * validates today, with no invented time and no shape change.
 *
 * That emitter fix is deliberately still not made here, for reason 1 below: a
 * change that syncs vocabulary and shapes must not also alter what the
 * converter writes. Reason 2 — "the correct fix is not obvious" — no longer
 * applies and has been struck.
 *
 * THE ONE FINDING, STATED PRECISELY
 * ---------------------------------
 * Four C-CDA section handlers read `<effectiveTime value="20250311"/>`, slice it
 * to `2025-03-11`, and write it with `literal(dateStr)` — a plain literal, so
 * `xsd:string`:
 *
 *   sections/procedures.ts    -> health:performedDate
 *   sections/vitals.ts        -> health:performedDate
 *   sections/labs.ts          -> health:performedDate
 *   sections/problems.ts      -> health:onsetDate
 *   sections/immunizations.ts -> health:administrationDate
 *
 * health v2.5 constrained all three predicates with `sh:datatype xsd:dateTime`;
 * health v2.6 widened them to `xsd:date` OR `xsd:dateTime`. Either way the
 * emitters disagree with the ratified vocabulary, because a plain literal is
 * `xsd:string` and always was. Nothing was checking until v2.5 shaped these
 * classes at all.
 *
 * `labs.ts:292` already writes `clinical:performedDate` through a
 * `tripleDateTime()` helper that types the literal correctly. The helper exists.
 * It was never propagated to the other sites — the same shape of defect as the
 * identity helpers that had to be pulled into a chokepoint.
 *
 * WHY THIS IS PINNED RATHER THAN FIXED HERE
 * -----------------------------------------
 * One reason now, not two.
 *
 * 1. This change syncs vocabulary and shapes; it deliberately alters no emission
 *    site. Fixing a converter here would mix a data-output change into a
 *    vocabulary sync, and the two need to be reviewed and released separately.
 *
 * 2. STRUCK at health v2.6. It read: "the correct fix is not obvious", because
 *    a single `sh:datatype` could not express FHIR's partial-precision
 *    `dateTime` and the emitter fix was therefore blocked on a vocabulary
 *    decision. That decision is made. The fix is now obvious and small: type
 *    the literal `xsd:date` at the five sites listed above, using the same
 *    kind of helper `labs.ts:292` already uses for `clinical:performedDate`.
 *
 * HOW THIS STAYS HONEST
 * ---------------------
 * `assertOnlyKnownViolations` fails if a violation appears on any property not
 * listed here, and `expectKnownViolationsStillPresent` fails once they stop
 * being produced. So the list cannot silently absorb a new defect, and it cannot
 * outlive the defect it describes.
 */

import { expect } from 'vitest';

export interface SeverityIssue {
  severity: string;
  shape: string;
  property: string;
  message: string;
}

/**
 * Local names of the properties whose date-datatype constraint the C-CDA
 * converter currently violates by emitting an untyped day-precision string.
 */
export const KNOWN_DATE_DATATYPE_PROPERTIES = new Set([
  'performedDate',
  'onsetDate',
  'administrationDate',
]);

/**
 * The substring that identifies the date-datatype finding specifically.
 *
 * At health v2.5 this was the `xsd:dateTime` IRI, which appeared in the
 * `sh:datatype` report. health v2.6 replaced that constraint with an `sh:or`
 * over `xsd:date` and `xsd:dateTime`, and an `sh:or` report carries the
 * property shape's own `sh:message` instead. So the matcher keys on that
 * message. This is deliberately a phrase from the SHAPES, not a phrase invented
 * here: if `spec` reworded or dropped the message, the match stops and this
 * file is forced open rather than silently widening.
 */
const DATE_DATATYPE_MESSAGE = 'must be an xsd:date or an xsd:dateTime';

function isKnownDateDatatypeViolation(v: SeverityIssue): boolean {
  return (
    KNOWN_DATE_DATATYPE_PROPERTIES.has(v.property) &&
    v.message.includes(DATE_DATATYPE_MESSAGE)
  );
}

/**
 * Assert that every violation present is one of the known date-datatype ones.
 *
 * The message check matters: without it, ANY violation on `performedDate` — a
 * missing value, a cardinality breach — would be swallowed by the property name
 * alone.
 */
export function assertOnlyKnownViolations(violations: SeverityIssue[]): void {
  const unexpected = violations.filter((v) => !isKnownDateDatatypeViolation(v));
  expect(
    unexpected,
    `Unexpected SHACL violations (not the known date-datatype gap):\n${unexpected
      .map((v) => `  ${v.shape}: ${v.message} (${v.property})`)
      .join('\n')}`,
  ).toHaveLength(0);
}

/**
 * Assert the known gap is still actually being produced.
 *
 * Without this, `assertOnlyKnownViolations` would pass on output containing no
 * violations at all — including output where the converter had been fixed, or
 * where a shape had been dropped and stopped firing. Either of those should
 * force this file to be revisited rather than pass quietly.
 */
export function expectKnownViolationsStillPresent(
  violations: SeverityIssue[],
  expectedProperties: string[],
): void {
  const seen = [...new Set(violations.map((v) => v.property))].sort();
  expect(seen).toEqual([...expectedProperties].sort());
}
