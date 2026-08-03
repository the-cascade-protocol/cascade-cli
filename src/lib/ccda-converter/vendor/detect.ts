/**
 * EHR vendor detection from C-CDA custodian organization name.
 */

import { firstOf } from '../multivalued.js';

export type EhrVendor = 'epic' | 'cerner' | 'athena' | 'unknown';

function extractOrgName(doc: any): string {
  // `<name>` is a repeatable element and is therefore an ARRAY (see
  // `multivalued.ts`), so take its single occurrence before reading a value out
  // of it. The element may hold a bare string or a { '#text' } node.
  const name = firstOf<any>(
    doc?.ClinicalDocument?.custodian?.assignedCustodian?.representedCustodianOrganization?.name,
  );
  if (name == null) return '';
  if (typeof name === 'string') return name;
  return (name['#text'] ?? '').toString();
}

export function detectVendor(doc: any): EhrVendor {
  const custodianName = extractOrgName(doc).toLowerCase();

  if (custodianName.includes('epic') || custodianName.includes('mychart') || custodianName.includes('kaiser') || custodianName.includes('ucsf') || custodianName.includes('stanford')) {
    return 'epic';
  }
  if (custodianName.includes('cerner') || custodianName.includes('powerchart')) {
    return 'cerner';
  }
  if (custodianName.includes('athena')) {
    return 'athena';
  }
  return 'unknown';
}

export function getSourceSystemName(doc: any): string {
  const name = extractOrgName(doc);
  return name || 'Unknown EHR';
}
