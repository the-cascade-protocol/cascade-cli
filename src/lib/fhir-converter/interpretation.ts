/**
 * What `health:interpretation` is allowed to say, and how a FHIR
 * `Observation.interpretation` becomes one of those things.
 *
 * FHIR R4 binds `Observation.interpretation` to the HL7 v3
 * ObservationInterpretation code system
 * (http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation), and as of
 * health v2.6 `health:interpretation` is bound to the same 49 selectable codes,
 * plus the data-absent-reason code `unknown` and the ten English words the
 * previous five-member enum used.
 *
 * So the importer's job is now to CARRY the code, not to translate it. It used to
 * translate: H and L both became "abnormal", HH and LL both became "critical",
 * and every code outside a nine-entry map — every susceptibility (S/I/R),
 * detection (POS/NEG/DET/ND), reactivity (RR/WR/NR) and change (B/D/U/W) result —
 * became "unknown". That made "the organism is resistant to this antibiotic"
 * indistinguishable from "the source reported no interpretation", and no
 * downstream reader could tell which had happened.
 *
 * `unknown` now means one thing: the source Observation carried no interpretation.
 *
 * THE LIST BELOW IS A COPY, AND A COPY DRIFTS
 * -------------------------------------------
 * `src/shapes/health.shapes.ttl` is the authority; `src/shapes/` is synced from
 * `spec/` and is not editable here. This constant is the same list in the same
 * order, and `tests/fhir-interpretation-passthrough.test.ts` reads the shapes file
 * and fails if the two ever disagree — so the copy cannot quietly fall behind a
 * vocabulary release.
 */

/**
 * Every value `health:interpretation` accepts: the 49 selectable HL7 v3
 * ObservationInterpretation codes, the data-absent-reason code `unknown`, and the
 * ten retained health v2.5 words.
 */
export const ACCEPTED_INTERPRETATION_CODES: ReadonlySet<string> = new Set([
  'EX', 'HM', 'OBX', 'CAR', 'Carrier', 'B', 'D', 'U', 'W',
  '<', '>', 'AC', 'IE', 'QCF', 'TOX',
  'A', 'N', 'I', 'MS', 'NCL', 'NS', 'R', 'S', 'VS',
  'AA', 'H', 'L', 'HH', 'LL', 'HX', 'LX', 'H>', 'HU', 'E', 'L<', 'LU',
  'ND', 'IND', 'NEG', 'POS', 'EXP', 'UNE', 'DET',
  'SYN-R', 'NR', 'RR', 'WR', 'SDD', 'SYN-S',
  'unknown',
  'normal', 'high', 'low', 'abnormal', 'critical',
  'Normal', 'High', 'Low', 'Abnormal', 'Critical',
]);

/** The value written when the source carried no interpretation at all. */
export const INTERPRETATION_ABSENT = 'unknown';

/**
 * The pre-v2.6 flattening, kept only for codes the accepted set does not contain.
 *
 * Measured, because it reads as dead code otherwise: all nine of these keys ARE in
 * the accepted set, so a source writing any of them now takes the verbatim path
 * and never reaches this map. It is retained because dropping it would silently
 * change behaviour for a code that is added to it later, and because a nearest
 * mapping is a better answer than `unknown` if one ever applies.
 */
const NEAREST_LEGACY_MAPPING: Record<string, string> = {
  N: 'normal', H: 'abnormal', L: 'abnormal', A: 'abnormal',
  HH: 'critical', LL: 'critical', AA: 'critical',
  HU: 'critical', LU: 'critical',
};

/**
 * The `health:interpretation` value for one FHIR `Observation.interpretation`
 * array.
 *
 * - No interpretation, or one carrying no code  -> `unknown`
 * - A code the shapes accept                    -> that code, verbatim
 * - Anything else                               -> nearest legacy mapping, else
 *                                                  `unknown`, and a warning
 *                                                  naming the code that was lost
 */
export function interpretationValue(
  interpretation: unknown,
  warnings?: string[],
): string {
  if (!Array.isArray(interpretation) || interpretation.length === 0) {
    return INTERPRETATION_ABSENT;
  }

  const code = (interpretation[0] as any)?.coding?.[0]?.code;
  if (typeof code !== 'string' || !code) return INTERPRETATION_ABSENT;

  if (ACCEPTED_INTERPRETATION_CODES.has(code)) return code;

  const nearest = NEAREST_LEGACY_MAPPING[code];
  warnings?.push(
    `Observation.interpretation code "${code}" is not in the ObservationInterpretation ` +
      `set health:interpretation accepts; recorded as "${nearest ?? INTERPRETATION_ABSENT}"`,
  );
  return nearest ?? INTERPRETATION_ABSENT;
}
