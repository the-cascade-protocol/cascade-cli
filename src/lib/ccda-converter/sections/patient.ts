/**
 * Extract patient demographics from C-CDA recordTarget → cascade:PatientProfile
 */

import { NS, contentHashedUri } from '../../fhir-converter/types.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

/**
 * Map an HL7 AdministrativeGender code (CDA administrativeGenderCode/@code) to the
 * cascade:biologicalSex enum the PatientProfileShape accepts ("male", "female",
 * "intersex"). Returns undefined for unknown / data-absent codes (UN, nullFlavor)
 * so we omit the property rather than emit an out-of-enum value.
 * @see http://terminology.hl7.org/CodeSystem/v3-AdministrativeGender
 */
function mapBiologicalSex(code: string): string | undefined {
  switch ((code ?? '').trim().toUpperCase()) {
    case 'M':
      return 'male';
    case 'F':
      return 'female';
    // HL7 v3 has no "intersex"; map common intersex/indeterminate codes through.
    case 'I':       // Intersex (some EHR local extensions)
    case 'IN':
      return 'intersex';
    default:
      return undefined; // UN (Undifferentiated) / unknown -> omit
  }
}

export function extractPatientQuads(
  recordTarget: any,
  sourceSystem: string,
): { quads: Quad[]; patientUri: string } {
  // recordTarget may be an array (Epic wraps it)
  const rt = Array.isArray(recordTarget) ? recordTarget[0] : recordTarget;
  const patient = rt?.patientRole?.patient ?? rt?.patient ?? {};
  // const patientRole = rt?.patientRole ?? rt ?? {};

  // Extract demographics
  const nameArr = Array.isArray(patient.name) ? patient.name : (patient.name ? [patient.name] : []);
  const nameEl = nameArr[0] ?? {};
  const given = Array.isArray(nameEl.given) ? nameEl.given[0] : nameEl.given ?? '';
  const family = Array.isArray(nameEl.family) ? nameEl.family[0] : nameEl.family ?? '';
  const givenStr = typeof given === 'string' ? given : given?.['#text'] ?? '';
  const familyStr = typeof family === 'string' ? family : family?.['#text'] ?? '';

  const dob = patient?.birthTime?.['@_value'] ?? patient?.birthTime?.value ?? '';
  const sex = patient?.administrativeGenderCode?.['@_code'] ?? patient?.administrativeGenderCode?.code ?? '';

  // Extract address from patientRole
  const patientRole = rt?.patientRole ?? rt ?? {};
  const addrArr = Array.isArray(patientRole.addr) ? patientRole.addr : (patientRole.addr ? [patientRole.addr] : []);
  const addr = addrArr[0] ?? {};
  const street = (() => {
    const sl = addr.streetAddressLine;
    if (!sl) return '';
    const lines = Array.isArray(sl) ? sl : [sl];
    return lines.map((l: any) => (typeof l === 'string' ? l : l?.['#text'] ?? '')).filter(Boolean).join(', ');
  })();
  const city = typeof addr.city === 'string' ? addr.city : addr.city?.['#text'] ?? '';
  const state = typeof addr.state === 'string' ? addr.state : addr.state?.['#text'] ?? '';
  const postalCode = addr.postalCode != null ? String(addr.postalCode) : '';

  // Extract phone and email from patientRole telecom
  const telecomArr = Array.isArray(patientRole.telecom) ? patientRole.telecom : (patientRole.telecom ? [patientRole.telecom] : []);
  const phone = (() => {
    const t = telecomArr.find((t: any) => {
      const val: string = t?.['@_value'] ?? t?.value ?? '';
      return val.startsWith('tel:');
    });
    const raw: string = t?.['@_value'] ?? t?.value ?? '';
    return raw.replace(/^tel:/, '');
  })();
  const email = (() => {
    const t = telecomArr.find((t: any) => {
      const val: string = t?.['@_value'] ?? t?.value ?? '';
      return val.startsWith('mailto:');
    });
    const raw: string = t?.['@_value'] ?? t?.value ?? '';
    return raw.replace(/^mailto:/, '');
  })();

  // Deterministic URI from identity fields
  const patientUri = contentHashedUri('Patient', {
    dob: dob.slice(0, 8),  // YYYYMMDD
    sex: sex,
    family: familyStr.toLowerCase(),
    given: givenStr.toLowerCase(),
  });

  const subj = namedNode(patientUri);
  const quads: Quad[] = [
    makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.cascade + 'PatientProfile')),
    makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)),
  ];

  if (givenStr) quads.push(makeQuad(subj, namedNode(NS.cascade + 'givenName'), literal(givenStr)));
  if (familyStr) quads.push(makeQuad(subj, namedNode(NS.cascade + 'familyName'), literal(familyStr)));
  if (dob && dob.length >= 8) {
    // PatientProfileShape requires cascade:dateOfBirth as xsd:date (YYYY-MM-DD).
    const dobFormatted = `${dob.slice(0, 4)}-${dob.slice(4, 6)}-${dob.slice(6, 8)}`;
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'dateOfBirth'), literal(dobFormatted, namedNode(NS.xsd + 'date'))));
  }
  // PatientProfileShape requires cascade:biologicalSex in ("male" "female"
  // "intersex"). Map the HL7 AdministrativeGender code (M/F/...) to the enum.
  const mappedSex = mapBiologicalSex(sex);
  if (mappedSex) quads.push(makeQuad(subj, namedNode(NS.cascade + 'biologicalSex'), literal(mappedSex, namedNode(NS.xsd + 'string'))));
  // Flat address predicates (blank node structure is built when writing profile/extended.ttl)
  if (street) quads.push(makeQuad(subj, namedNode(NS.cascade + 'addressLine'), literal(street)));
  if (city) quads.push(makeQuad(subj, namedNode(NS.cascade + 'addressCity'), literal(city)));
  if (state) quads.push(makeQuad(subj, namedNode(NS.cascade + 'addressState'), literal(state)));
  if (postalCode) quads.push(makeQuad(subj, namedNode(NS.cascade + 'addressPostalCode'), literal(postalCode)));
  if (phone) quads.push(makeQuad(subj, namedNode(NS.vcard + 'hasTelephone'), literal(phone)));
  if (email) quads.push(makeQuad(subj, namedNode(NS.vcard + 'hasEmail'), literal(email)));

  return { quads, patientUri };
}
