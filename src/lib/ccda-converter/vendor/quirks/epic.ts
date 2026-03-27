/**
 * Epic MyChart quirks:
 * - Single-element arrays serialized as objects, not arrays
 * - urn:oid: prefix on all code system OIDs
 */

// Fields that should always be arrays in C-CDA
const SHOULD_BE_ARRAY = [
  'entry', 'component', 'observation', 'organizer', 'substanceAdministration',
  'act', 'encounter', 'procedure', 'supply', 'name', 'id', 'telecom', 'addr', 'coding',
];

export function normalizeEpic(doc: any): any {
  // Deep clone to avoid mutating input
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
    if (typeof obj[key] === 'object') {
      normalizeArraysRecursive(obj[key]);
    }
  }
}
