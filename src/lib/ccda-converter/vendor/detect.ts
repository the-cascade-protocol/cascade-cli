/**
 * EHR vendor detection from C-CDA custodian organization name.
 */

export type EhrVendor = 'epic' | 'cerner' | 'athena' | 'unknown';

function extractOrgName(doc: any): string {
  const raw =
    doc?.ClinicalDocument?.custodian?.assignedCustodian?.representedCustodianOrganization?.name?.['#text'] ??
    doc?.ClinicalDocument?.custodian?.assignedCustodian?.representedCustodianOrganization?.name ??
    '';
  // fast-xml-parser's isArray config may wrap <name> in an array
  if (Array.isArray(raw)) return (raw[0]?.['#text'] ?? raw[0] ?? '').toString();
  return raw.toString();
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
