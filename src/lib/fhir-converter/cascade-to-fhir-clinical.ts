/**
 * Cascade -> FHIR reverse converters for clinical record types.
 *
 * Each function receives a predicate-value map (pv) for a single RDF subject
 * and returns a FHIR R4 resource object, or null if the type is not handled here.
 *
 * Handles:
 *   clinical:Medication               -> MedicationStatement
 *   health:ConditionRecord           -> Condition
 *   health:AllergyRecord             -> AllergyIntolerance
 *   health:LabResultRecord           -> Observation (lab)
 *   clinical:VitalSign               -> Observation (vital-signs)
 *   clinical:Procedure               -> Procedure
 *   clinical:ClinicalDocument        -> DocumentReference
 *   clinical:Encounter               -> Encounter
 *   clinical:LaboratoryReport        -> DiagnosticReport
 *   clinical:ImagingReport           -> DiagnosticReport
 *   clinical:MedicationAdministration -> MedicationAdministration
 *   clinical:ImplantedDevice         -> Device
 *   clinical:ImagingStudy            -> ImagingStudy
 */

import { NS } from './types.js';

type PV = Map<string, string[]>;
type FhirResource = Record<string, any>;

// ---------------------------------------------------------------------------
// Medications
// ---------------------------------------------------------------------------

export function restoreMedicationRecord(pv: PV, warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'MedicationStatement',
    status: 'active',
    medicationCodeableConcept: { text: getFirst(NS.clinical + 'drugName') ?? '' },
  };

  const status = getFirst(NS.clinical + 'status');
  if (status) fhirResource.status = status;

  const drugCodes = pv.get(NS.clinical + 'drugCode') ?? [];
  const codingArr: any[] = [];
  for (const uri of drugCodes) {
    if (uri.startsWith(NS.rxnorm)) {
      codingArr.push({ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: uri.slice(NS.rxnorm.length) });
    } else if (uri.startsWith(NS.sct)) {
      codingArr.push({ system: 'http://snomed.info/sct', code: uri.slice(NS.sct.length) });
    }
  }
  if (codingArr.length > 0) fhirResource.medicationCodeableConcept.coding = codingArr;

  const doseText = getFirst(NS.clinical + 'dosage');
  if (doseText) fhirResource.dosage = [{ text: doseText }];

  const startDate = getFirst(NS.health + 'startDate');
  const endDate = getFirst(NS.health + 'endDate');
  if (startDate || endDate) {
    fhirResource.effectivePeriod = {};
    if (startDate) fhirResource.effectivePeriod.start = startDate;
    if (endDate) fhirResource.effectivePeriod.end = endDate;
  }

  const srcId = getFirst(NS.health + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  // Warn about Cascade-only fields with no FHIR equivalent
  for (const field of [NS.clinical + 'provenanceClass', NS.clinical + 'clinicalIntent',
                        NS.cascade + 'schemaVersion', NS.health + 'medicationClass']) {
    if (getFirst(field)) {
      warnings.push(`Cascade field '${field.split('#')[1] ?? field}' has no FHIR equivalent and was not included in output`);
    }
  }

  return fhirResource;
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export function restoreConditionRecord(pv: PV, _warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'Condition',
    code: { text: getFirst(NS.health + 'conditionName') ?? '' },
  };

  const status = getFirst(NS.health + 'status');
  if (status) {
    fhirResource.clinicalStatus = {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: status }],
    };
  }

  // 3.262: `Condition.verificationStatus` has been emitted since wave 1 and was
  // read back by nothing, so `confirmed` and `refuted` — opposite claims about
  // whether the patient has the condition at all — exported identically.
  const verification = getFirst(NS.clinical + 'verificationStatus');
  if (verification) {
    fhirResource.verificationStatus = {
      coding: [
        { system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: verification },
      ],
    };
  }

  const onset = getFirst(NS.health + 'onsetDate');
  if (onset) fhirResource.onsetDateTime = onset;

  const codingArr: any[] = [];
  for (const uri of pv.get(NS.health + 'icd10Code') ?? []) {
    codingArr.push({ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: uri.startsWith(NS.icd10) ? uri.slice(NS.icd10.length) : uri });
  }
  for (const uri of pv.get(NS.health + 'snomedCode') ?? []) {
    codingArr.push({ system: 'http://snomed.info/sct', code: uri.startsWith(NS.sct) ? uri.slice(NS.sct.length) : uri });
  }
  if (codingArr.length > 0) fhirResource.code.coding = codingArr;

  const srcId = getFirst(NS.health + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  return fhirResource;
}

// ---------------------------------------------------------------------------
// Allergies
// ---------------------------------------------------------------------------

export function restoreAllergyRecord(pv: PV, _warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'AllergyIntolerance',
    code: { text: getFirst(NS.health + 'allergen') ?? '' },
  };

  // 3.262: both of AllergyIntolerance's status elements, emitted since wave 1
  // and read back by neither. A REFUTED allergy exported as an unqualified one
  // narrows treatment exactly as a confirmed allergy would.
  const clinicalStatus = getFirst(NS.clinical + 'status');
  if (clinicalStatus) {
    fhirResource.clinicalStatus = {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
          code: clinicalStatus,
        },
      ],
    };
  }
  const allergyVerification = getFirst(NS.clinical + 'verificationStatus');
  if (allergyVerification) {
    fhirResource.verificationStatus = {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification',
          code: allergyVerification,
        },
      ],
    };
  }

  const cat = getFirst(NS.health + 'allergyCategory');
  if (cat) fhirResource.category = [cat];

  const severity = getFirst(NS.health + 'allergySeverity');
  const reaction = getFirst(NS.health + 'reaction');
  if (reaction || severity) {
    const rxn: any = {};
    if (reaction) rxn.manifestation = [{ text: reaction }];
    if (severity) rxn.severity = severity;
    fhirResource.reaction = [rxn];
  }

  const onset = getFirst(NS.health + 'onsetDate');
  if (onset) fhirResource.onsetDateTime = onset;

  const srcId = getFirst(NS.health + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  return fhirResource;
}

// ---------------------------------------------------------------------------
// Lab results (Observation)
// ---------------------------------------------------------------------------

export function restoreLabResultRecord(pv: PV, _warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'Observation',
    code: { text: getFirst(NS.health + 'testName') ?? '' },
    category: [{ coding: [{ code: 'laboratory' }] }],
  };

  // 3.262: `Observation.status` reaches the pod on clinical:status (wave 1) and
  // was read back by nothing, so an AMENDED result exported as though nothing
  // had been amended — the same collapse on the way out that wave 1 fixed on
  // the way in. Observation.status is 1..1, so a record written before wave 1,
  // which states none, is exported without one rather than with an invented
  // value; that is a gap the pod can show, where "final" would be a claim.
  const obsStatus = getFirst(NS.clinical + 'status');
  if (obsStatus) fhirResource.status = obsStatus;

  const codingArr: any[] = [];
  for (const uri of pv.get(NS.health + 'testCode') ?? []) {
    codingArr.push({ system: 'http://loinc.org', code: uri.startsWith(NS.loinc) ? uri.slice(NS.loinc.length) : uri });
  }
  if (codingArr.length > 0) fhirResource.code.coding = codingArr;

  const resultVal = getFirst(NS.health + 'resultValue');
  const resultUnit = getFirst(NS.health + 'resultUnit');
  if (resultVal) {
    const numVal = parseFloat(resultVal);
    if (!isNaN(numVal)) {
      fhirResource.valueQuantity = { value: numVal };
      if (resultUnit) fhirResource.valueQuantity.unit = resultUnit;
    } else {
      fhirResource.valueString = resultVal;
    }
  }

  const perfDate = getFirst(NS.health + 'performedDate');
  if (perfDate) fhirResource.effectiveDateTime = perfDate;

  const interp = getFirst(NS.health + 'interpretation');
  if (interp) {
    const revInterpMap: Record<string, string> = { normal: 'N', abnormal: 'A', critical: 'HH', unknown: 'UNK' };
    fhirResource.interpretation = [{ coding: [{ code: revInterpMap[interp] ?? interp }] }];
  }

  const srcId = getFirst(NS.health + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  return fhirResource;
}

// ---------------------------------------------------------------------------
// Vital signs (Observation)
// ---------------------------------------------------------------------------

export function restoreVitalSign(pv: PV, warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'Observation',
    code: {},
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
  };

  // 3.262: same element, same predicate, same omission as the lab branch above.
  const vitalStatus = getFirst(NS.clinical + 'status');
  if (vitalStatus) fhirResource.status = vitalStatus;

  const loincUri = getFirst(NS.clinical + 'loincCode');
  if (loincUri) {
    const code = loincUri.startsWith(NS.loinc) ? loincUri.slice(NS.loinc.length) : loincUri;
    fhirResource.code.coding = [{ system: 'http://loinc.org', code }];
  }
  const vitalName = getFirst(NS.clinical + 'vitalTypeName');
  if (vitalName) fhirResource.code.text = vitalName;

  const value = getFirst(NS.clinical + 'value');
  const unit = getFirst(NS.clinical + 'unit');
  if (value) {
    fhirResource.valueQuantity = { value: parseFloat(value) };
    if (unit) fhirResource.valueQuantity.unit = unit;
  }

  const effDate = getFirst(NS.clinical + 'effectiveDate');
  if (effDate) fhirResource.effectiveDateTime = effDate;

  const srcId = getFirst(NS.health + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  if (getFirst(NS.clinical + 'snomedCode')) {
    warnings.push("Cascade field 'snomedCode' has no standard FHIR Observation field and was not included");
  }

  return fhirResource;
}

// ---------------------------------------------------------------------------
// Procedure
// ---------------------------------------------------------------------------

export function restoreProcedure(pv: PV, _warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'Procedure',
    code: { text: getFirst(NS.clinical + 'procedureName') ?? '' },
  };

  const status = getFirst(NS.clinical + 'procedureStatus');
  if (status) fhirResource.status = status;

  const performedDate = getFirst(NS.clinical + 'performedDate');
  if (performedDate) fhirResource.performedDateTime = performedDate;

  const srcId = getFirst(NS.clinical + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  const snomedUri = pv.get(NS.clinical + 'procedureSnomedCode')?.[0];
  if (snomedUri) {
    const code = snomedUri.startsWith(NS.sct) ? snomedUri.slice(NS.sct.length) : snomedUri;
    fhirResource.code.coding = [{ system: 'http://snomed.info/sct', code }];
  }

  return fhirResource;
}

// ---------------------------------------------------------------------------
// Clinical document (DocumentReference)
// ---------------------------------------------------------------------------

export function restoreClinicalDocument(pv: PV, _warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'DocumentReference',
    // `status` is 1..1 in FHIR, so the resource must carry one; "current" stands
    // in only when the pod states none, which is every record written before the
    // predicate existed. Where the pod DOES state it, the pod wins — a
    // superseded document exported as current is the forward defect (3.256)
    // reappearing on the way out.
    status: getFirst(NS.clinical + 'documentReferenceStatus') ?? 'current',
    type: { text: getFirst(NS.clinical + 'documentType') ?? '' },
  };

  // docStatus is 0..1 and is written only when the pod states it: unlike
  // `status` there is no value FHIR forces the resource to carry, so inventing
  // one would assert a document lifecycle the pod never recorded.
  const docStatus = getFirst(NS.clinical + 'status');
  if (docStatus) fhirResource.docStatus = docStatus;

  const docDate = getFirst(NS.clinical + 'documentDate');
  if (docDate) fhirResource.date = docDate;

  // EVERY author, in stored order, and the authenticator as its own element.
  // Restoring the authenticator as an author (or dropping it) would re-lose the
  // distinction the forward converter exists to keep: who signed a note is not
  // who wrote it.
  const authors = pv.get(NS.clinical + 'documentAuthorName') ?? [];
  if (authors.length > 0) {
    fhirResource.author = authors.map((display) => ({ display }));
  } else {
    // Pre-v1.16 records carry only the single display name. One author is a
    // truer restoration than none.
    const providerName = getFirst(NS.clinical + 'providerName');
    if (providerName) fhirResource.author = [{ display: providerName }];
  }

  const authenticator = getFirst(NS.clinical + 'authenticatorName');
  if (authenticator) fhirResource.authenticator = { display: authenticator };

  const contentType = getFirst(NS.clinical + 'contentType');
  const docUrl = getFirst(NS.clinical + 'documentUrl');
  const docTitle = getFirst(NS.clinical + 'documentTitle');
  if (contentType || docUrl || docTitle) {
    const attachment: any = {};
    if (contentType) attachment.contentType = contentType;
    if (docUrl) attachment.url = docUrl;
    if (docTitle) attachment.title = docTitle;
    fhirResource.content = [{ attachment }];
  }

  const srcId = getFirst(NS.clinical + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  return fhirResource;
}

// ---------------------------------------------------------------------------
// Encounter
// ---------------------------------------------------------------------------

/**
 * @param resolveNode reads the predicate-value map of another subject in the
 *   same graph, so `clinical:hasParticipant` edges can be followed to their
 *   `clinical:EncounterParticipant` nodes. Optional: a caller with only one
 *   subject in hand restores everything except the participations, which is what
 *   this function did before clinical v1.16 gave participations a node at all.
 */
export function restoreEncounter(
  pv: PV,
  _warnings: string[],
  resolveNode?: (iri: string) => PV | undefined,
): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'Encounter',
    status: getFirst(NS.clinical + 'encounterStatus') ?? 'finished',
  };

  // The class Coding, restored WHOLE. Writing back only the code would export a
  // bare vendor category id (`"5"`) with nothing saying which system it came
  // from — readable by nobody and mappable by no one, which is the state
  // clinical v1.16 was authored to end.
  const encClass = getFirst(NS.clinical + 'encounterClass');
  const classDisplay = getFirst(NS.clinical + 'encounterClassDisplay');
  const classSystem = getFirst(NS.clinical + 'encounterClassSystem');
  if (encClass || classDisplay || classSystem) {
    fhirResource.class = {};
    if (encClass) fhirResource.class.code = encClass;
    if (classDisplay) fhirResource.class.display = classDisplay;
    if (classSystem) fhirResource.class.system = classSystem;
  }

  const encType = getFirst(NS.clinical + 'encounterType');
  if (encType) fhirResource.type = [{ text: encType }];

  // Every reason, because Encounter.reasonCode is 0..* and the pod holds them
  // all. Restored as `.text`, which is the element the forward converter read.
  const reasons = pv.get(NS.clinical + 'encounterReason') ?? [];
  if (reasons.length > 0) fhirResource.reasonCode = reasons.map((text) => ({ text }));

  const admitSource = getFirst(NS.clinical + 'admitSource');
  const dischargeDisposition = getFirst(NS.clinical + 'dischargeDisposition');
  if (admitSource || dischargeDisposition) {
    fhirResource.hospitalization = {};
    if (admitSource) fhirResource.hospitalization.admitSource = { text: admitSource };
    if (dischargeDisposition) {
      fhirResource.hospitalization.dischargeDisposition = { text: dischargeDisposition };
    }
  }

  const start = getFirst(NS.clinical + 'encounterStart');
  const end = getFirst(NS.clinical + 'encounterEnd');
  if (start || end) {
    fhirResource.period = {};
    if (start) fhirResource.period.start = start;
    if (end) fhirResource.period.end = end;
  }

  // Participants: the participation NODES where the graph has them, and the
  // single summary name only where it has none.
  //
  // The order matters and is not a preference. Restoring providerName as a
  // participant AS WELL would emit the treating clinician twice, once with their
  // role and once without — and a consumer reading `participant[]` cannot tell
  // the duplicate from a second real participation. The nodes carry strictly
  // more than the summary slot does, including the summary name itself, so where
  // they exist they are the whole answer.
  const participantIris = pv.get(NS.clinical + 'hasParticipant') ?? [];
  const participants: any[] = [];
  for (const iri of participantIris) {
    const node = resolveNode?.(iri);
    if (!node) continue;
    const first = (pred: string) => node.get(pred)?.[0];
    const entry: any = {};
    const name = first(NS.clinical + 'participantName');
    if (name) entry.individual = { display: name };

    const role = first(NS.clinical + 'participantRole');
    const roleCodes = node.get(NS.clinical + 'participantRoleCode') ?? [];
    if (role || roleCodes.length > 0) {
      const type: any = {};
      if (role) type.text = role;
      if (roleCodes.length > 0) type.coding = roleCodes.map((code) => ({ code }));
      entry.type = [type];
    }

    const specialty = first(NS.clinical + 'participantSpecialty');
    if (specialty) {
      // Round-tripped through an extension because that is where the source
      // carried it and where the forward converter reads it. FHIR has no
      // Encounter.participant.specialty element; the standard's home for the
      // fact is PractitionerRole.specialty, and minting a PractitionerRole here
      // would invent a resource the pod does not hold.
      entry.extension = [
        {
          url: 'https://ns.cascadeprotocol.org/fhir/StructureDefinition/participant-specialty',
          valueCodeableConcept: { text: specialty },
        },
      ];
    }
    if (Object.keys(entry).length > 0) participants.push(entry);
  }
  if (participants.length > 0) {
    fhirResource.participant = participants;
  } else {
    const provName = getFirst(NS.clinical + 'providerName');
    if (provName) fhirResource.participant = [{ individual: { display: provName } }];
  }

  const facility = getFirst(NS.clinical + 'facilityName');
  if (facility) fhirResource.serviceProvider = { display: facility };

  const srcId = getFirst(NS.clinical + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  // Business identifiers, split back out of the token form they are stored in.
  //
  // This is the ONE place the token form is decomposed, and it is sound here in
  // a way it is never sound in the matcher: `{system}|{value}` is produced by
  // this codebase and `|` is not a character FHIR permits in an Identifier.system
  // URI, so the FIRST `|` is unambiguously the separator. A value with no `|`
  // was written bare, meaning the source stated no system — and no system is
  // invented for it here either.
  const businessIds = pv.get(NS.clinical + 'businessIdentifier') ?? [];
  if (businessIds.length > 0) {
    fhirResource.identifier = businessIds.map((token) => {
      const cut = token.indexOf('|');
      return cut === -1
        ? { value: token }
        : { system: token.slice(0, cut), value: token.slice(cut + 1) };
    });
  }

  return fhirResource;
}

// ---------------------------------------------------------------------------
// Diagnostic report (clinical:LaboratoryReport and clinical:ImagingReport)
// ---------------------------------------------------------------------------

/**
 * Restore a `DiagnosticReport` from either class the forward converter routes
 * it to.
 *
 * One function, because there is one FHIR resource. `clinical:ImagingReport`
 * and `clinical:LaboratoryReport` differ in what they MEAN, not in which
 * predicates a DiagnosticReport-derived record carries — the forward converter
 * emits the same set for both and chooses only the class — so a second
 * restorer would be the same body with a different name and one more place for
 * the two to drift apart. The class is not restated on the way out because
 * FHIR has no field for it: `category` already carries the distinction, which
 * is what the class was derived FROM, and it is restored below.
 */
export function restoreDiagnosticReport(pv: PV, _warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'DiagnosticReport',
    // 3.262: this was a hardcoded 'final'. The forward converter has emitted
    // DiagnosticReport.status on clinical:status since wave 1, so an `amended`
    // or `entered-in-error` report exported as `final` was the pod's own
    // correction being discarded on the way out. The literal remains as the
    // fallback for records written before that, because status is 1..1.
    status: getFirst(NS.clinical + 'status') ?? 'final',
    code: { text: getFirst(NS.clinical + 'panelName') ?? '' },
  };

  const loincUri = getFirst(NS.clinical + 'loincCode');
  if (loincUri) {
    const code = loincUri.startsWith(NS.loinc) ? loincUri.slice(NS.loinc.length) : loincUri;
    fhirResource.code.coding = [{ system: 'http://loinc.org', code }];
  }

  const category = getFirst(NS.clinical + 'reportCategory');
  if (category) fhirResource.category = [{ coding: [{ code: category }] }];

  const effDate = getFirst(NS.clinical + 'performedDate');
  if (effDate) fhirResource.effectiveDateTime = effDate;

  const srcId = getFirst(NS.clinical + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  return fhirResource;
}

// ---------------------------------------------------------------------------
// Medication administration
// ---------------------------------------------------------------------------

export function restoreMedicationAdministration(pv: PV, _warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'MedicationAdministration',
    status: getFirst(NS.clinical + 'administrationStatus') ?? 'completed',
    medicationCodeableConcept: { text: getFirst(NS.health + 'medicationName') ?? '' },
  };

  const adminDate = getFirst(NS.clinical + 'administeredDate');
  if (adminDate) fhirResource.effectiveDateTime = adminDate;

  const dose = getFirst(NS.clinical + 'administeredDose');
  const route = getFirst(NS.clinical + 'administeredRoute');
  if (dose || route) {
    fhirResource.dosage = {};
    if (dose) fhirResource.dosage.dose = { value: dose };
    if (route) fhirResource.dosage.route = { text: route };
  }

  const srcId = getFirst(NS.clinical + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  return fhirResource;
}

// ---------------------------------------------------------------------------
// Implanted device
// ---------------------------------------------------------------------------

export function restoreImplantedDevice(pv: PV, _warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'Device',
    status: getFirst(NS.clinical + 'deviceStatus') ?? 'active',
  };

  const deviceType = getFirst(NS.clinical + 'deviceType');
  if (deviceType) fhirResource.type = { text: deviceType };

  const manufacturer = getFirst(NS.clinical + 'deviceManufacturer');
  if (manufacturer) fhirResource.manufacturer = manufacturer;

  const udi = getFirst(NS.clinical + 'udiCarrier');
  if (udi) fhirResource.udiCarrier = [{ deviceIdentifier: udi }];

  const implantDate = getFirst(NS.clinical + 'implantDate');
  if (implantDate) fhirResource.manufactureDate = implantDate;

  const srcId = getFirst(NS.clinical + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  return fhirResource;
}

// ---------------------------------------------------------------------------
// Imaging study
// ---------------------------------------------------------------------------

export function restoreImagingStudy(pv: PV, _warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'ImagingStudy',
    status: 'available',
  };

  const modality = getFirst(NS.clinical + 'imagingModality');
  const description = getFirst(NS.clinical + 'studyDescription');
  if (description) fhirResource.description = description;

  const studyDate = getFirst(NS.clinical + 'studyDate');
  if (studyDate) fhirResource.started = studyDate;

  const dicomUid = getFirst(NS.clinical + 'dicomStudyUid');
  if (dicomUid) fhirResource.identifier = [{ value: dicomUid }];

  if (modality) fhirResource.series = [{ modality: { code: modality } }];

  const srcId = getFirst(NS.clinical + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  return fhirResource;
}
