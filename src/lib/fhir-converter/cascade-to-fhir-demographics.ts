/**
 * Cascade -> FHIR reverse converters for demographic and administrative types.
 *
 * Handles:
 *   cascade:PatientProfile    -> Patient
 *   health:ImmunizationRecord -> Immunization
 *   coverage:InsurancePlan    -> Coverage
 */

import { NS } from './types.js';

type PV = Map<string, string[]>;
type FhirResource = Record<string, any>;

// ---------------------------------------------------------------------------
// Patient
// ---------------------------------------------------------------------------

export function restorePatientProfile(pv: PV, warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = { resourceType: 'Patient' };

  const dob = getFirst(NS.cascade + 'dateOfBirth');
  if (dob) fhirResource.birthDate = dob;

  const sex = getFirst(NS.cascade + 'biologicalSex');
  if (sex) {
    const sexMap: Record<string, string> = { male: 'male', female: 'female', intersex: 'other' };
    fhirResource.gender = sexMap[sex] ?? 'unknown';
  }

  const marital = getFirst(NS.cascade + 'maritalStatus');
  if (marital) {
    const maritalMap: Record<string, string> = {
      single: 'S', married: 'M', divorced: 'D', widowed: 'W',
      separated: 'A', domestic_partnership: 'T',
    };
    fhirResource.maritalStatus = {
      coding: [{ code: maritalMap[marital] ?? 'UNK' }],
      text: marital,
    };
  }

  const profileId = getFirst(NS.cascade + 'profileId');
  if (profileId) fhirResource.id = profileId;

  for (const field of ['computedAge', 'ageGroup', 'genderIdentity']) {
    if (getFirst(NS.cascade + field)) {
      warnings.push(`Cascade field '${field}' has no FHIR Patient equivalent and was not included`);
    }
  }

  return fhirResource;
}

// ---------------------------------------------------------------------------
// Immunization
// ---------------------------------------------------------------------------

export function restoreImmunizationRecord(pv: PV, _warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'Immunization',
    status: getFirst(NS.health + 'status') ?? 'completed',
    vaccineCode: { text: getFirst(NS.health + 'vaccineName') ?? '' },
  };

  const adminDate = getFirst(NS.health + 'administrationDate');
  if (adminDate) fhirResource.occurrenceDateTime = adminDate;

  const vaccineCode = getFirst(NS.health + 'vaccineCode');
  if (vaccineCode) {
    const code = vaccineCode.startsWith('CVX-') ? vaccineCode.slice(4) : vaccineCode;
    fhirResource.vaccineCode.coding = [{ system: 'http://hl7.org/fhir/sid/cvx', code }];
  }

  const manufacturer = getFirst(NS.health + 'manufacturer');
  if (manufacturer) fhirResource.manufacturer = { display: manufacturer };

  const lotNumber = getFirst(NS.health + 'lotNumber');
  if (lotNumber) fhirResource.lotNumber = lotNumber;

  const srcId = getFirst(NS.health + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  return fhirResource;
}

// ---------------------------------------------------------------------------
// Coverage (Insurance)
// ---------------------------------------------------------------------------

export function restoreInsurancePlan(pv: PV, _warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'Coverage',
    status: 'active',
  };

  const providerName = getFirst(NS.coverage + 'providerName');
  if (providerName) fhirResource.payor = [{ display: providerName }];

  const memberId = getFirst(NS.coverage + 'memberId');
  if (memberId) fhirResource.subscriberId = memberId;

  const groupNum = getFirst(NS.coverage + 'groupNumber');
  const planName = getFirst(NS.coverage + 'planName');
  const classArr: any[] = [];
  if (groupNum) classArr.push({ type: { coding: [{ code: 'group' }] }, value: groupNum, name: planName });
  else if (planName) classArr.push({ type: { coding: [{ code: 'plan' }] }, value: planName });
  if (classArr.length > 0) fhirResource.class = classArr;

  const start = getFirst(NS.coverage + 'effectiveStart');
  const end = getFirst(NS.coverage + 'effectiveEnd');
  if (start || end) {
    fhirResource.period = {};
    if (start) fhirResource.period.start = start;
    if (end) fhirResource.period.end = end;
  }

  const rel = getFirst(NS.coverage + 'subscriberRelationship');
  if (rel) fhirResource.relationship = { coding: [{ code: rel }] };

  const srcId = getFirst(NS.health + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  return fhirResource;
}
