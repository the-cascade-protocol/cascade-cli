/**
 * FHIR -> Cascade converters for demographics and administrative types.
 *
 * Converts:
 *   - Patient -> cascade:PatientProfile
 *   - Immunization -> health:ImmunizationRecord
 *   - Coverage -> coverage:InsurancePlan
 */

import { randomUUID } from 'node:crypto';
import type { Quad } from 'n3';

import {
  type ConversionResult,
  NS,
  extractCodings,
  codeableConceptText,
  tripleStr,
  tripleInt,
  tripleType,
  tripleDateTime,
  tripleDate,
  commonTriples,
  quadsToJsonLd,
} from './types.js';

// ---------------------------------------------------------------------------
// Patient converter
// ---------------------------------------------------------------------------

export function convertPatient(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = `urn:uuid:${randomUUID()}`;
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.cascade + 'PatientProfile'));
  quads.push(...commonTriples(subjectUri));

  if (resource.birthDate) {
    quads.push(tripleDate(subjectUri, NS.cascade + 'dateOfBirth', resource.birthDate));
    const dob = new Date(resource.birthDate);
    const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    const monthDiff = now.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) {
      age--;
    }
    quads.push(tripleInt(subjectUri, NS.cascade + 'computedAge', age));
    let ageGroup: string;
    if (age < 18) ageGroup = 'pediatric';
    else if (age < 40) ageGroup = 'young_adult';
    else if (age < 65) ageGroup = 'adult';
    else ageGroup = 'senior';
    quads.push(tripleStr(subjectUri, NS.cascade + 'ageGroup', ageGroup));
  } else {
    warnings.push('No birthDate found in Patient resource');
  }

  if (resource.gender) {
    const genderMap: Record<string, string> = {
      male: 'male', female: 'female', other: 'intersex', unknown: 'intersex',
    };
    quads.push(tripleStr(subjectUri, NS.cascade + 'biologicalSex', genderMap[resource.gender] ?? resource.gender));
  }

  if (Array.isArray(resource.address) && resource.address.length > 0) {
    const addr = resource.address[0];
    if (addr.city) quads.push(tripleStr(subjectUri, NS.cascade + 'addressCity', addr.city));
    if (addr.state) quads.push(tripleStr(subjectUri, NS.cascade + 'addressState', addr.state));
    if (addr.postalCode) quads.push(tripleStr(subjectUri, NS.cascade + 'addressPostalCode', addr.postalCode));
    if (addr.country) quads.push(tripleStr(subjectUri, NS.cascade + 'addressCountry', addr.country));
    if (Array.isArray(addr.line)) {
      for (const line of addr.line) {
        quads.push(tripleStr(subjectUri, NS.cascade + 'addressLine', line));
      }
    }
    warnings.push('Patient address flattened onto profile (blank node structure simplified)');
  }

  if (resource.maritalStatus) {
    const maritalText = codeableConceptText(resource.maritalStatus);
    if (maritalText) {
      const maritalMap: Record<string, string> = {
        S: 'single', M: 'married', D: 'divorced', W: 'widowed',
        A: 'separated', T: 'domestic_partnership', UNK: 'prefer_not_to_say',
        'Never Married': 'single', 'Married': 'married', 'Divorced': 'divorced',
        'Widowed': 'widowed', 'Separated': 'separated',
      };
      const code = resource.maritalStatus.coding?.[0]?.code;
      const mapped = maritalMap[code] ?? maritalMap[maritalText] ?? maritalText.toLowerCase();
      quads.push(tripleStr(subjectUri, NS.cascade + 'maritalStatus', mapped));
    }
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.cascade + 'profileId', resource.id));
  }

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'cascade:PatientProfile'),
    warnings,
    resourceType: 'Patient',
    cascadeType: 'cascade:PatientProfile',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// Immunization converter
// ---------------------------------------------------------------------------

export function convertImmunization(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = `urn:uuid:${randomUUID()}`;
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.health + 'ImmunizationRecord'));
  quads.push(...commonTriples(subjectUri));

  const vaccineName = codeableConceptText(resource.vaccineCode) ?? 'Unknown Vaccine';
  quads.push(tripleStr(subjectUri, NS.health + 'vaccineName', vaccineName));

  if (resource.occurrenceDateTime) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'administrationDate', resource.occurrenceDateTime));
  } else if (resource.occurrenceString) {
    warnings.push(`Immunization date is a string: ${resource.occurrenceString}`);
  }

  quads.push(tripleStr(subjectUri, NS.health + 'status', resource.status ?? 'completed'));

  const codings = extractCodings(resource.vaccineCode);
  for (const c of codings) {
    if (c.system === 'http://hl7.org/fhir/sid/cvx' || c.system === 'urn:oid:2.16.840.1.113883.12.292') {
      quads.push(tripleStr(subjectUri, NS.health + 'vaccineCode', `CVX-${c.code}`));
      break;
    }
  }

  if (resource.manufacturer?.display) {
    quads.push(tripleStr(subjectUri, NS.health + 'manufacturer', resource.manufacturer.display));
  }

  if (resource.lotNumber) {
    quads.push(tripleStr(subjectUri, NS.health + 'lotNumber', resource.lotNumber));
  }

  if (resource.doseQuantity) {
    const qty = `${resource.doseQuantity.value} ${resource.doseQuantity.unit ?? ''}`.trim();
    quads.push(tripleStr(subjectUri, NS.health + 'doseQuantity', qty));
  }

  if (resource.route) {
    const routeText = codeableConceptText(resource.route);
    if (routeText) quads.push(tripleStr(subjectUri, NS.health + 'route', routeText));
  }

  if (resource.site) {
    const siteText = codeableConceptText(resource.site);
    if (siteText) quads.push(tripleStr(subjectUri, NS.health + 'site', siteText));
  }

  if (Array.isArray(resource.performer) && resource.performer.length > 0) {
    const performer = resource.performer[0]?.actor?.display;
    if (performer) quads.push(tripleStr(subjectUri, NS.health + 'administeringProvider', performer));
  }

  if (resource.location?.display) {
    quads.push(tripleStr(subjectUri, NS.health + 'administeringLocation', resource.location.display));
  }

  if (resource.note && Array.isArray(resource.note)) {
    const noteText = resource.note.map((n: any) => n.text).filter(Boolean).join('; ');
    if (noteText) quads.push(tripleStr(subjectUri, NS.health + 'notes', noteText));
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'health:ImmunizationRecord'),
    warnings,
    resourceType: 'Immunization',
    cascadeType: 'health:ImmunizationRecord',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// Coverage converter
// ---------------------------------------------------------------------------

export function convertCoverage(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = `urn:uuid:${randomUUID()}`;
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.coverage + 'InsurancePlan'));
  quads.push(...commonTriples(subjectUri));

  if (Array.isArray(resource.payor) && resource.payor.length > 0) {
    const payorName = resource.payor[0]?.display ?? 'Unknown Insurance';
    quads.push(tripleStr(subjectUri, NS.coverage + 'providerName', payorName));
  } else {
    quads.push(tripleStr(subjectUri, NS.coverage + 'providerName', 'Unknown Insurance'));
    warnings.push('No payor information found in Coverage resource');
  }

  if (resource.subscriberId) {
    quads.push(tripleStr(subjectUri, NS.coverage + 'memberId', resource.subscriberId));
    quads.push(tripleStr(subjectUri, NS.coverage + 'subscriberId', resource.subscriberId));
  } else if (resource.identifier && Array.isArray(resource.identifier) && resource.identifier.length > 0) {
    const memberId = resource.identifier[0]?.value ?? '';
    quads.push(tripleStr(subjectUri, NS.coverage + 'memberId', memberId));
  } else {
    warnings.push('No member/subscriber ID found in Coverage resource');
  }

  if (resource.type) {
    const typeText = resource.type.coding?.[0]?.code ?? codeableConceptText(resource.type) ?? 'primary';
    quads.push(tripleStr(subjectUri, NS.coverage + 'coverageType', typeText));
  } else {
    quads.push(tripleStr(subjectUri, NS.coverage + 'coverageType', 'primary'));
  }

  if (Array.isArray(resource.class)) {
    for (const cls of resource.class) {
      const clsType = cls.type?.coding?.[0]?.code ?? '';
      if (clsType === 'group' && cls.value) {
        quads.push(tripleStr(subjectUri, NS.coverage + 'groupNumber', cls.value));
        if (cls.name) quads.push(tripleStr(subjectUri, NS.coverage + 'planName', cls.name));
      } else if (clsType === 'plan' && cls.value) {
        quads.push(tripleStr(subjectUri, NS.coverage + 'planName', cls.name ?? cls.value));
      } else if (clsType === 'rxbin' && cls.value) {
        quads.push(tripleStr(subjectUri, NS.coverage + 'rxBin', cls.value));
      } else if (clsType === 'rxpcn' && cls.value) {
        quads.push(tripleStr(subjectUri, NS.coverage + 'rxPcn', cls.value));
      } else if (clsType === 'rxgroup' && cls.value) {
        quads.push(tripleStr(subjectUri, NS.coverage + 'rxGroup', cls.value));
      }
    }
  }

  if (resource.relationship) {
    const relCode = resource.relationship.coding?.[0]?.code ?? 'self';
    quads.push(tripleStr(subjectUri, NS.coverage + 'subscriberRelationship', relCode));
  }

  if (resource.period?.start) {
    quads.push(tripleDate(subjectUri, NS.coverage + 'effectiveStart', resource.period.start.substring(0, 10)));
  }
  if (resource.period?.end) {
    quads.push(tripleDate(subjectUri, NS.coverage + 'effectiveEnd', resource.period.end.substring(0, 10)));
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'coverage:InsurancePlan'),
    warnings,
    resourceType: 'Coverage',
    cascadeType: 'coverage:InsurancePlan',
    _quads: quads,
  };
}
