/**
 * Deterministic medication-field normalization for cascade-cli.
 *
 * CANONICAL SOURCE: `sdk-typescript/src/utils/medication-normalize.ts`.
 *
 * This is a deliberate, byte-identical port — the same pattern cascade-cli uses
 * for `deterministicUuid` (its own copy in `fhir-converter/types.ts`). The CLI
 * does not take a runtime dependency on `@the-cascade-protocol/sdk`; instead the
 * SDK is the single canonical definition and this copy is held to it by a parity
 * test (`tests/medication-normalize.test.ts`) whose vectors match the SDK's
 * (`sdk-typescript/tests/medication-normalize.test.ts`). If you change the
 * behaviour here, change it in the SDK in the same pass and update both vector
 * sets, or the matcher and the conversation grounder will silently disagree.
 *
 * Determinism-first: regex and string-replacement only. No ML, no I/O, no
 * locale-sensitive operations. Identical input always yields identical output.
 */

/**
 * Canonicalize a medication name for identity matching.
 *
 * Lowercases, strips embedded dose/unit and form/route tokens, and collapses
 * whitespace. This is the match-identity form, not a display name. Dose tokens
 * are intentionally stripped so "Lisinopril 10 mg" and "Lisinopril 20 mg" share
 * an identity; the dose difference is compared separately (see normalizeDose)
 * and surfaced as a conflict, not treated as a different drug.
 */
export function normalizeMedName(name: string): string {
  return name.toLowerCase()
    .replace(/\d+(\.\d+)?\s*(mg|mcg|g|ml|%|iu|units?|meq)\b/gi, '')
    .replace(/\b(oral|tablet|capsule|solution|injection|extended|release|er|xr|cr|sr|hr)\b/gi, '')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Canonicalize a dose string for value comparison. Lowercases, removes
 * whitespace, and folds spelled-out / plural units to abbreviations. Replacement
 * order is significant and preserved (longer unit words before bare `gram`).
 */
export function normalizeDose(dose: string): string {
  return dose.toLowerCase()
    .replaceAll(' ', '')
    .replaceAll('milligram', 'mg')
    .replaceAll('microgram', 'mcg')
    .replaceAll('gram', 'g')
    .replaceAll('mgs', 'mg')
    .replaceAll('mcgs', 'mcg');
}

/**
 * Canonicalize a dosing frequency to a clinical abbreviation. Replacement order
 * is significant and preserved (specific `... daily` phrases before bare
 * `daily`), so "once daily" yields `qd`, not `once qd`.
 */
export function normalizeFrequency(frequency: string): string {
  return frequency.toLowerCase()
    .replaceAll('once daily', 'qd')
    .replaceAll('once a day', 'qd')
    .replaceAll('twice daily', 'bid')
    .replaceAll('twice a day', 'bid')
    .replaceAll('three times daily', 'tid')
    .replaceAll('three times a day', 'tid')
    .replaceAll('four times daily', 'qid')
    .replaceAll('four times a day', 'qid')
    .replaceAll('every day', 'qd')
    .replaceAll('daily', 'qd')
    .trim();
}

/** Known route surface forms -> canonical route. */
const ROUTE_SYNONYMS: Record<string, string> = {
  'oral': 'oral',
  'po': 'oral',
  'by mouth': 'oral',
  'orally': 'oral',
  'inhalation': 'inhalation',
  'inhaled': 'inhalation',
  'inhale': 'inhalation',
  'nebulized': 'inhalation',
  'iv': 'intravenous',
  'intravenous': 'intravenous',
  'im': 'intramuscular',
  'intramuscular': 'intramuscular',
  'subcutaneous': 'subcutaneous',
  'subcut': 'subcutaneous',
  'sc': 'subcutaneous',
  'sq': 'subcutaneous',
  'topical': 'topical',
  'transdermal': 'transdermal',
  'sublingual': 'sublingual',
  'sl': 'sublingual',
  'rectal': 'rectal',
  'pr': 'rectal',
  'nasal': 'nasal',
  'intranasal': 'nasal',
  'ophthalmic': 'ophthalmic',
  'otic': 'otic',
};

/**
 * Canonicalize a route of administration. Maps a known surface form to its
 * canonical route; unknown routes degrade to the lowercased, trimmed input
 * (identity), so this is safe to apply unconditionally.
 */
export function normalizeRoute(route: string): string {
  const cleaned = route.toLowerCase().trim();
  return ROUTE_SYNONYMS[cleaned] ?? cleaned;
}
