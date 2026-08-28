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
 * Vaccine'. The status is keyed RAW — `resource.status`, not the serialized
 * value — so an absent status stays absent instead of arriving as a constant.
 * That is also why removing the serializer's `?? 'completed'` moved no IRI: the
 * key never saw the default.
 */
function immunizationSubjectUri(resource: any, warnings: string[]): string {
  return idOrContentUri('Immunization', resource, {
    patient: resource?.patient?.reference,
    vaccine: codeableConceptKey(resource?.vaccineCode),
    // Full precision, and `occurrenceString` where the source gives prose.
    occurrence: resource?.occurrenceDateTime ?? resource?.occurrenceString,
    // Raw. The serializer no longer defaults, but keying the raw element is what
    // made that change free of IRI movement, so it stays stated.
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

  // Immunization.status — completed | entered-in-error | not-done.
  //
  // NO DEFAULT. This read `resource.status ?? 'completed'`, so a source that
  // stated nothing was stored indistinguishably from a source that asserted the
  // dose was given. That is the amended/final collapse inverted: there the pod
  // under-claimed, here it over-claimed, on the one field whose whole job is to
  // say whether the vaccine went in.
  //
  // Omitting is safe against the shape: `health:ImmunizationRecordShape`
  // constrains `health:status` with `sh:maxCount 1` and an `sh:in` value set,
  // and asserts no `sh:minCount` — checked before this line changed.
  //
  // No IRI moves: `immunizationSubjectUri` keys `resource?.status` RAW and says
  // so in as many words, so identity never saw the default in the first place.
  if (resource.status) {
    quads.push(tripleStr(subjectUri, NS.health + 'status', resource.status));
  }

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
 * `Coverage.status` reaches the pod as `coverage:status`, from coverage v1.5.
 *
 * Whether a plan is in force is the only question an insurance record is really
 * asked, and FHIR marks the element a MODIFIER: a cancelled or erroneous
 * Coverage must not be read as describing coverage the patient has. It is also
 * 1..1 with a REQUIRED binding, so it is the one element a conformant Coverage
 * has to carry — and through coverage v1.4 this vocabulary had no property for
 * it, so an importer reading a conformant resource had to discard it.
 *
 * The predicate is `coverage:status` and not `clinical:status`, which the
 * converter could have borrowed at any point. It was not borrowed because
 * clinical: is the EHR clinical-record namespace and an insurance plan is not
 * one of its records; `coverage:claimStatus` and `coverage:adjudicationStatus`
 * are not substitutes either, since they describe what happened to a CLAIM
 * rather than whether a plan is in force. Deciding vocabulary scope inside a
 * converter is what the wait avoided.
 *
 * NOT DEFAULTED, unlike `coverageType` two fields below (tracked separately): a
 * source that states no status is stored stating none. Substituting "active"
 * for a missing modifier element is 3.257's defect on the field where it costs
 * the most.
 */
export function convertCoverage(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource, warnings);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.coverage + 'InsurancePlan'));
  quads.push(...commonTriples(subjectUri));

  // See the note above this function: a modifier element, reported and never
  // invented.
  if (resource.status) {
    quads.push(tripleStr(subjectUri, NS.coverage + 'status', resource.status));
  }

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

  // Coverage.relationship — the policyholder's relation to the patient.
  //
  // NO DEFAULT. The guard was `if (resource.relationship)` and the value was
  // `coding[0].code ?? 'self'`, so a relationship that was PRESENT but stated
  // only as text became the pod asserting the policy is the patient's own. On a
  // dependent's plan that is the wrong answer to the only question an insurance
  // record is asked. Free text is not mapped onto the code set either: the
  // `sh:in` list is the HL7 SubscriberPolicyholder system and picking a member
  // of it from prose would be the same guess wearing a different hat.
  //
  // Omitting is safe against the shape: `coverage:InsurancePlanShape` constrains
  // this path at `sh:Warning` with `sh:maxCount 1` and no `sh:minCount`.
  //
  // No IRI moves: `convertCoverage` mints through `mintSubjectUri`, which seeds
  // from `resource.id` or from a hash of the RAW resource — never from a
  // serialized value this function computed.
  const relCode = resource.relationship?.coding?.[0]?.code;
  if (relCode) {
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
