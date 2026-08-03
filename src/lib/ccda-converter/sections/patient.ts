/**
 * Extract patient demographics from C-CDA recordTarget → cascade:PatientProfile
 */

import { NS, structuredKey } from '../../fhir-converter/types.js';
import { firstOf, listOf } from '../multivalued.js';
import { ccdaRecordUri, ccdaSourceId } from '../record-identity.js';
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
  /**
   * Collects a tier-4 identity-collapse notice. This used to be the ONE C-CDA
   * site that could reach tier 4, because every other section keyed on
   * `patient: patientUri` — always a non-empty `urn:uuid:` — so their content
   * tier always fired. That component is gone from the section keys, so the
   * salvage and loud-collapse tiers are reachable across the whole path now.
   */
  warnings?: string[],
): { quads: Quad[]; patientUri: string } {
  // recordTarget may be an array (Epic wraps it)
  const rt = Array.isArray(recordTarget) ? recordTarget[0] : recordTarget;
  const patient = rt?.patientRole?.patient ?? rt?.patient ?? {};
  // const patientRole = rt?.patientRole ?? rt ?? {};

  // Extract demographics
  const nameEl = firstOf<any>(patient.name) ?? {};
  const given = Array.isArray(nameEl.given) ? nameEl.given[0] : nameEl.given ?? '';
  const family = Array.isArray(nameEl.family) ? nameEl.family[0] : nameEl.family ?? '';
  const givenStr = typeof given === 'string' ? given : given?.['#text'] ?? '';
  const familyStr = typeof family === 'string' ? family : family?.['#text'] ?? '';

  const dob = patient?.birthTime?.['@_value'] ?? patient?.birthTime?.value ?? '';
  const sex = patient?.administrativeGenderCode?.['@_code'] ?? patient?.administrativeGenderCode?.code ?? '';

  // Extract address from patientRole
  const patientRole = rt?.patientRole ?? rt ?? {};
  const addr = firstOf<any>(patientRole.addr) ?? {};
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
  const telecomArr = listOf<any>(patientRole.telecom);
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

  // IDENTITY.
  //
  // Tier 1 is the MRN. `patientRole/id` is where a C-CDA carries the medical
  // record number — the identifier the EHR itself uses to tell two patients
  // apart — and this call passed `undefined` where the id belongs, so it did not
  // even ATTEMPT it. Measured on `main`: two different people, distinct MRNs,
  // sharing a birth date, a sex, a surname and a first given name minted ONE
  // profile IRI, and every record of either then hung off it.
  //
  // Tier 2 is the demographics, and the four fields it used to be
  // ({dob, sex, family, given[0]}) are exactly the four the FHIR Patient key was
  // widened away from in the same release, for the same reason: reading
  // `given[0]` alone means middle names, suffixes and maiden names contribute
  // nothing, and everything the converter SERIALIZES but leaves out of the key
  // is a field two people sharing one IRI can disagree on. So the key now
  // fingerprints the whole `name` array, the whole `addr` array and the whole
  // `telecom` array. (`telecom` is excluded on the FHIR path because that
  // converter does not serialize it; this one emits vcard:hasTelephone and
  // vcard:hasEmail, so here it must be in the key.)
  //
  // THE SAME PERSON FROM TWO EHRs STILL RECONCILES. Two exports carrying two
  // MRNs now mint two profiles where they previously minted one; they do not
  // stay two, because `matchPatientProfiles` merges on date of birth plus sex at
  // 0.95 against a 0.65 threshold — with a merge trail, and with a conflict
  // raised wherever they disagree. The merge moves out of a hash nobody can
  // inspect and into the layer built to make it reviewable.
  const patientUri = ccdaRecordUri({
    type: 'Patient',
    sourceId: ccdaSourceId(patientRole?.id),
    content: {
      dob: dob.slice(0, 8),  // YYYYMMDD
      sex: sex,
      name: structuredKey(patient?.name),
      address: structuredKey(patientRole?.addr),
      telecom: structuredKey(patientRole?.telecom),
    },
    source: patientRole,
    warnings,
    label: 'C-CDA patient (recordTarget)',
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
