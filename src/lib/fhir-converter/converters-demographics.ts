/**
 * FHIR -> Cascade converters for demographics and administrative types.
 *
 * Converts:
 *   - Patient -> cascade:PatientProfile
 *   - Immunization -> health:ImmunizationRecord
 *   - Coverage -> coverage:InsurancePlan
 */

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
  mintSubjectUri,
  idOrContentUri,
  codeableConceptKey,
  structuredKey,
} from './types.js';
import { pushEncounterEdge } from './reference-resolution.js';

// ---------------------------------------------------------------------------
// Patient converter
// ---------------------------------------------------------------------------

/**
 * The subject IRI for a Patient.
 *
 * WHY THIS IS NO LONGER
 * `contentHashedUri('Patient', {dob, sex, family, given}, resource.id)`
 * --------------------------------------------------------------------
 * The `resource.id` was passed as `fallbackId`, which is dead on any Patient
 * carrying a name or a birth date. Measured: the same demographics under id
 * `server-id-A` and id `server-id-B` minted ONE IRI.
 *
 * And the key was four fields: birth date, gender, `name[0].family` and
 * `name[0].given[0]`. It read the FIRST given name only and no other name
 * entry, so middle names, suffixes, maiden names and every `identifier` — the
 * medical record number, the member id, the fields an EHR itself uses to tell
 * two patients apart — contributed nothing. Two different people sharing a
 * first name, a surname, a sex and a date of birth therefore merged into one
 * profile, and every record belonging to either of them then hung off it. In a
 * store whose whole premise is that the record is about one person, that is the
 * worst merge available.
 *
 * WHAT DOES NOT CHANGE: THE SAME PERSON FROM TWO SOURCES STILL RECONCILES.
 * -----------------------------------------------------------------------
 * Two exports of one person from two EHRs carry two server ids and so now mint
 * two profile IRIs where they previously minted one. They do not stay two
 * records: `matchPatientProfiles` in the reconciler matches on date of birth
 * plus sex at 0.95 confidence, far above the 0.65 threshold, and merges them —
 * with a merge trail, and with a conflict raised where the two disagree. The
 * merge moves from a hash nobody can inspect to the layer built to make it
 * reviewable. That is the whole of the change.
 *
 * WITHOUT AN ID the key adds the complete `name` array (every entry, every
 * given name, prefixes and suffixes) and the complete `identifier` array, both
 * fingerprinted.
 *
 * `address` is in the key even though it changes for the same person, because
 * it is SERIALIZED (as `cascade:addressCity` and its siblings) and the rule
 * these keys are built to — stated in full on `conditionSubjectUri` — is that a
 * serialized field outside the key is a field two records sharing an IRI can
 * disagree on. The cost is the recoverable direction: an id-less patient whose
 * address changed splits, and `matchPatientProfiles` puts the two back together
 * on date of birth plus sex while raising the differing address as a conflict,
 * which is the outcome a person can actually act on. Excluding it would instead
 * merge two same-named people at two addresses, and that is unrecoverable.
 *
 * `telecom` is excluded, and can be: this converter does not serialize it, so
 * two Patients differing only there produce identical records.
 */
function patientSubjectUri(resource: any, warnings: string[]): string {
  return idOrContentUri('Patient', resource, {
    dob: resource?.birthDate,
    sex: resource?.gender,
    // The whole name array, not `name[0].family` + `name[0].given[0]`.
    name: structuredKey(resource?.name),
    // The strongest discriminator a Patient resource carries, and it was
    // absent from the key entirely.
    identifier: structuredKey(resource?.identifier),
    maritalStatus: codeableConceptKey(resource?.maritalStatus),
    address: structuredKey(resource?.address),
    deceased: resource?.deceasedDateTime
      ?? (resource?.deceasedBoolean !== undefined ? String(resource.deceasedBoolean) : undefined),
  }, warnings);
}

export function convertPatient(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = patientSubjectUri(resource, warnings);
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

/**
 * The subject IRI for an Immunization.
 *
 * WHY THIS IS NO LONGER
 * `contentHashedUri('Immunization', {patient, cvxCode, date}, resource.id)`
 * ------------------------------------------------------------------------
 * The `resource.id` was dead as a `fallbackId`. Measured: the same dose under
 * id `server-id-A` and id `server-id-B` minted ONE IRI.
 *
 * The key itself was defended on the grounds that two flu shots recorded on one
 * day really are one dose. That is true of two RECORDS OF one dose and false of
 * two doses, and the key could not tell those apart, because it read
 * `vaccineCode.coding[0].code` — the first coding, without its system, so a CVX
 * code and an NDC or local code sharing digits collided — and truncated the
 * occurrence to a calendar day. Everything that distinguishes two same-day
 * administrations was outside it: the LOT NUMBER, the dose quantity, the body
 * SITE, the route, the manufacturer, and the status. A left-arm and a right-arm
 * injection given in one visit were one record; so were a `completed` dose and
 * a `not-done` entry for the same vaccine on the same day, which is the pair
 * whose merge tells a reader a dose was given when the source says it was not.
 *
 * That was the standing assumption this entry was filed to remove: the safety
 * of `{patient, code, date}` was a claim about the data, not a property of the
 * key, and it expired the moment any discriminating field was looked at.
 *
 * WITHOUT AN ID the key carries the full vaccine code, the occurrence at FULL
 * precision, the status, the lot number, the dose, the site, the route, the
 * manufacturer and the encounter.
 *
 * `vaccineName` is NOT a key field: the converter defaults it to 'Unknown
 * Vaccine'. Neither is the serialized status, which defaults to 'completed' —
 * the key reads `resource.status` raw, so an absent status stays absent instead
 * of arriving as a constant.
 */
function immunizationSubjectUri(resource: any, warnings: string[]): string {
  return idOrContentUri('Immunization', resource, {
    patient: resource?.patient?.reference,
    vaccine: codeableConceptKey(resource?.vaccineCode),
    // Full precision, and `occurrenceString` where the source gives prose.
    occurrence: resource?.occurrenceDateTime ?? resource?.occurrenceString,
    // Raw, not the serialized `?? 'completed'`.
    status: resource?.status,
    lotNumber: resource?.lotNumber,
    dose: structuredKey(resource?.doseQuantity),
    site: codeableConceptKey(resource?.site),
    route: codeableConceptKey(resource?.route),
    manufacturer: resource?.manufacturer?.display ?? resource?.manufacturer?.reference,
    encounter: resource?.encounter?.reference,
    // Serialized as health:administeringProvider / administeringLocation /
    // notes. See the completeness rule on `conditionSubjectUri`: a serialized
    // field outside the key is a field two records sharing an IRI can disagree
    // on.
    performer: structuredKey(resource?.performer),
    location: resource?.location?.display ?? resource?.location?.reference,
    note: structuredKey(resource?.note),
  }, warnings);
}

export function convertImmunization(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = immunizationSubjectUri(resource, warnings);
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

  // The visit this immunization was administered in (Immunization.encounter).
  pushEncounterEdge(quads, subjectUri, resource.encounter);

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

/**
 * ACKNOWLEDGED DROP: `Coverage.status` (active | cancelled | draft |
 * entered-in-error).
 *
 * Whether a plan is still in force is worth storing — a cancelled policy
 * displayed like a current one is a wrong answer to the only question anyone
 * asks an insurance record. It is not emitted because there is no predicate
 * that can carry it truthfully:
 *
 *   - The coverage: namespace defines no status property for
 *     `coverage:InsurancePlan`. `coverage:claimStatus` is domain-restricted to
 *     `coverage:ClaimRecord` and `coverage:adjudicationStatus` to
 *     `coverage:BenefitStatement`; both would be false here.
 *   - `clinical:status` declares no domain, but clinical: is the EHR clinical
 *     record namespace and an insurance plan is not one of its records. The
 *     health:/clinical: split is documented as historical rather than semantic;
 *     coverage: carries no such note, so borrowing across it would be a
 *     judgement made in a converter about vocabulary scope.
 *
 * The fix is a `coverage:status` term, authored through the vocabulary
 * checklist. Until then this is a stated omission rather than a silent one.
 */
export function convertCoverage(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource, warnings);
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
