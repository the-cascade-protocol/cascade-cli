/**
 * OID to namespace URI mapping table for C-CDA code systems.
 */

export const OID_TO_URI: Record<string, string> = {
  '2.16.840.1.113883.6.88':   'http://www.nlm.nih.gov/research/umls/rxnorm/',
  '2.16.840.1.113883.6.96':   'http://snomed.info/id/',
  '2.16.840.1.113883.6.1':    'http://loinc.org/',
  '2.16.840.1.113883.6.90':   'http://hl7.org/fhir/sid/icd-10-cm/',
  '2.16.840.1.113883.6.103':  'http://hl7.org/fhir/sid/icd-9-cm/',
  '2.16.840.1.113883.6.12':   'http://www.ama-assn.org/go/cpt/',
  '2.16.840.1.113883.6.285':  'http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets/',
  '2.16.840.1.113883.6.69':   'http://hl7.org/fhir/sid/ndc/',
  '2.16.840.1.113883.12.292': 'http://hl7.org/fhir/sid/cvx/',
  '2.16.840.1.113883.12.227': 'http://www.cdc.gov/vaccines/programs/vfc/cdsi/cdsi-mvx/',
  '2.16.840.1.113883.5.2':    'http://terminology.hl7.org/CodeSystem/v3-MaritalStatus/',
  '2.16.840.1.113883.5.1':    'http://terminology.hl7.org/CodeSystem/v3-AdministrativeGender/',
  '2.16.840.1.113883.3.26.1.1': 'http://ncimeta.nci.nih.gov/',
  '2.16.840.1.113883.6.8':    'http://unitsofmeasure.org/',
  '2.16.840.1.113883.4.6':    'http://hl7.org/fhir/sid/us-npi/',
};

export function resolveCodeUri(oid: string, code: string): string {
  // Strip urn:oid: prefix if present (Epic adds this)
  const cleanOid = oid.startsWith('urn:oid:') ? oid.slice(8) : oid;
  const base = OID_TO_URI[cleanOid];
  return base ? `${base}${code}` : `urn:oid:${cleanOid}:${code}`;
}
