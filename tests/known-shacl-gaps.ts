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
 * health v2.5 constrains all three predicates with `sh:datatype xsd:dateTime`.
 * That constraint is not new and not an overreach: `health.ttl` declares
 * `rdfs:range xsd:dateTime` on each of the three, and it is the same constraint
 * `clinical:onsetDate` has carried since before this release. The emitters have
 * disagreed with the ratified vocabulary the whole time; nothing was checking.
 *
 * `labs.ts:292` already writes `clinical:performedDate` through a
 * `tripleDateTime()` helper that types the literal correctly. The helper exists.
 * It was never propagated to the other sites — the same shape of defect as the
 * identity helpers that had to be pulled into a chokepoint.
 *
 * WHY THIS IS PINNED RATHER THAN FIXED HERE
 * -----------------------------------------
 * Two reasons, and the second is why it is not a one-line change.
 *
 * 1. This change syncs vocabulary and shapes; it deliberately alters no emission
 *    site. Fixing a converter here would mix a data-output change into a
 *    vocabulary sync, and the two need to be reviewed and released separately.
 *
 * 2. The correct fix is not obvious. The source carries DAY precision. Typing
 *    `2025-03-11` as `xsd:dateTime` requires appending a time — `T00:00:00` —
 *    which fabricates precision the C-CDA never had, and midnight-local is a
 *    real value that downstream arithmetic will treat as real. FHIR R4's
 *    `dateTime` primitive accepts `YYYY`, `YYYY-MM`, `YYYY-MM-DD` and full
 *    instants precisely to avoid this, and `health:administrationDate`'s own
 *    comment says it "Corresponds to FHIR R4 Immunization.occurrence". A single
 *    `sh:datatype` cannot express that; expressing it needs `sh:or` over
 *    `xsd:date` / `xsd:dateTime` in the shapes. So the emitter fix is blocked on
 *    a vocabulary decision, and guessing at it in this change would ratify the
 *    guess.
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
 * Local names of the properties whose `sh:datatype xsd:dateTime` constraint the
 * C-CDA converter currently violates by emitting an untyped day-precision string.
 */
export const KNOWN_DATE_DATATYPE_PROPERTIES = new Set([
  'performedDate',
  'onsetDate',
  'administrationDate',
]);

function isKnownDateDatatypeViolation(v: SeverityIssue): boolean {
  return (
    KNOWN_DATE_DATATYPE_PROPERTIES.has(v.property) &&
    v.message.includes('http://www.w3.org/2001/XMLSchema#dateTime')
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
