/**
 * EHR vendor detection from C-CDA custodian organization name.
 */

export type EhrVendor = 'epic' | 'cerner' | 'athena' | 'unknown';

export function detectVendor(doc: any): EhrVendor {
  const custodianName = (
    doc?.ClinicalDocument?.custodian?.assignedCustodian?.representedCustodianOrganization?.name?.['#text'] ??
    doc?.ClinicalDocument?.custodian?.assignedCustodian?.representedCustodianOrganization?.name ??
    ''
  ).toLowerCase();

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
  return (
    doc?.ClinicalDocument?.custodian?.assignedCustodian?.representedCustodianOrganization?.name?.['#text'] ??
    doc?.ClinicalDocument?.custodian?.assignedCustodian?.representedCustodianOrganization?.name ??
    'Unknown EHR'
  );
}
