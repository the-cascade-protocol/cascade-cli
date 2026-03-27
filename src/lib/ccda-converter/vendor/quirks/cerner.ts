/**
 * Cerner PowerChart quirks:
 * - Omits <id> on many entries; uses <setId> as fallback
 * - Some templateIds may be absent on section entries
 */

const SHOULD_BE_ARRAY = [
  'entry', 'component', 'observation', 'organizer',
  'substanceAdministration', 'act', 'encounter', 'procedure', 'name', 'id', 'telecom', 'addr',
];

export function normalizeCerner(doc: any): any {
  const result = JSON.parse(JSON.stringify(doc));
  normalizeArraysRecursive(result);
  return result;
}

function normalizeArraysRecursive(obj: any): void {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (SHOULD_BE_ARRAY.includes(key) && obj[key] && !Array.isArray(obj[key])) {
      obj[key] = [obj[key]];
    }
    if (typeof obj[key] === 'object') normalizeArraysRecursive(obj[key]);
  }
}
