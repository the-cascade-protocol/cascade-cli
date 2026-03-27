/**
 * Extract patient demographics from C-CDA recordTarget → cascade:PatientProfile
 */

import { NS, contentHashedUri } from '../../fhir-converter/types.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

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
  if (dob) {
    // Convert YYYYMMDD to YYYY-MM-DD
    const dobFormatted = dob.length >= 8 ? `${dob.slice(0, 4)}-${dob.slice(4, 6)}-${dob.slice(6, 8)}` : dob;
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'dateOfBirth'), literal(dobFormatted)));
  }
  if (sex) quads.push(makeQuad(subj, namedNode(NS.cascade + 'biologicalSex'), literal(sex)));

  return { quads, patientUri };
}
