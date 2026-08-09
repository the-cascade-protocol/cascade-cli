/**
 * SHACL violations that the C-CDA converter is currently known to produce, and
 * the rule that keeps the list from becoming a place to hide new ones.
 *
 * THE DATE-DATATYPE GAP IS CLOSED
 * -------------------------------
 * This file used to document one finding: five section handlers sliced
 * `<effectiveTime value="20250311"/>` to `2025-03-11` and wrote it with
 * `literal(dateStr)` — a PLAIN literal, which is `xsd:string`, which is neither
 * `xsd:date` nor `xsd:dateTime`. It has been fixed rather than re-described. The
 * five sites now build the literal through `ccdaDateQuad` in
 * `src/lib/ccda-converter/dates.ts`, which types it from the precision of the
 * source value: `xsd:dateTime` when the document stated a time, `xsd:date` when
 * it stated a calendar day, and NOT `T00:00:00` appended to make a datatype check
 * pass. `tests/ccda-typed-dates.test.ts` carries the cases, including the
 * fixture-wide assertion that no date property is left plain.
 *
 * That is why this file shrank instead of growing a "still known" entry. A list
 * of known gaps that outlives the gap it describes is worse than no list, because
 * the next reader trusts it.
 *
 * THE ONE FINDING THAT REMAINS
 * ----------------------------
 * `clinical:ProcedureShape` requires `clinical:procedureName` (`sh:minCount 1`).
 * `sections/procedures.ts` writes the procedure's name to `health:procedureName`,
 * which no shape targeting `clinical:Procedure` declares. So every C-CDA-converted
 * procedure record violates the name constraint while CARRYING a name, and the
 * name it carries is validated by nothing.
 *
 * Measured against the public sample corpus this repository tests with: 2 of 2
 * procedures in one transition-of-care sample, 7 of 7 in another, 1 of 1 in a
 * third. It is not a fixture artefact and it is not rare.
 *
 * WHY IT IS PINNED HERE RATHER THAN FIXED
 * ---------------------------------------
 * Deciding which predicate a procedure's name lands on is not a converter detail:
 * `health:procedureName` is what has been written to date, so anything already
 * querying a pod for procedure names reads that predicate, and moving it (or
 * emitting both) is a data change for every existing consumer. It wants its own
 * change, with its own note about what to re-query. What it does NOT want is to
 * be discovered again from scratch, which is what this entry prevents.
 *
 * HOW THIS STAYS HONEST
 * ---------------------
 * `assertOnlyKnownViolations` fails if a violation appears on any property not
 * listed here, and `expectKnownViolationsStillPresent` fails once they stop being
 * produced. So the list cannot silently absorb a new defect, and it cannot
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
 * Local names of the properties the C-CDA converter is currently known to
 * violate.
 */
export const KNOWN_VIOLATION_PROPERTIES = new Set(['procedureName']);

/**
 * The substring that identifies the finding specifically.
 *
 * Deliberately a phrase from the SHAPES, not one invented here: if `spec`
 * reworded or dropped the message, the match stops and this file is forced open
 * rather than silently widening to cover some other `procedureName` failure.
 */
const PROCEDURE_NAME_MESSAGE = 'Procedure must have a name';

function isKnownViolation(v: SeverityIssue): boolean {
  return (
    KNOWN_VIOLATION_PROPERTIES.has(v.property) && v.message.includes(PROCEDURE_NAME_MESSAGE)
  );
}

/**
 * Assert that every violation present is one of the known ones.
 *
 * The message check matters: without it, ANY violation on `procedureName` — a
 * cardinality breach, a datatype mismatch — would be swallowed by the property
 * name alone.
 */
export function assertOnlyKnownViolations(violations: SeverityIssue[]): void {
  const unexpected = violations.filter((v) => !isKnownViolation(v));
  expect(
    unexpected,
    `Unexpected SHACL violations (not a known gap):\n${unexpected
      .map((v) => `  ${v.shape}: ${v.message} (${v.property})`)
      .join('\n')}`,
  ).toHaveLength(0);
}

/**
 * Assert the known gap is still actually being produced.
 *
 * Without this, `assertOnlyKnownViolations` would pass on output containing no
 * violations at all — including output where the converter had been fixed, or
 * where a shape had been dropped and stopped firing. Either of those should force
 * this file to be revisited rather than pass quietly.
 */
export function expectKnownViolationsStillPresent(
  violations: SeverityIssue[],
  expectedProperties: string[],
): void {
  const seen = [...new Set(violations.map((v) => v.property))].sort();
  expect(seen).toEqual([...expectedProperties].sort());
}
