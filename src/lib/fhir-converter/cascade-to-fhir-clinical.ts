/**
 * Cascade -> FHIR reverse converters for clinical record types.
 *
 * Each function receives a predicate-value map (pv) for a single RDF subject
 * and returns a FHIR R4 resource object, or null if the type is not handled here.
 *
 * Handles:
 *   health:MedicationRecord          -> MedicationStatement
 *   health:ConditionRecord           -> Condition
 *   health:AllergyRecord             -> AllergyIntolerance
 *   health:LabResultRecord           -> Observation (lab)
 *   clinical:VitalSign               -> Observation (vital-signs)
 *   clinical:Procedure               -> Procedure
 *   clinical:ClinicalDocument        -> DocumentReference
 *   clinical:Encounter               -> Encounter
 *   clinical:LaboratoryReport        -> DiagnosticReport
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
    medicationCodeableConcept: { text: getFirst(NS.health + 'medicationName') ?? '' },
  };

  const isActive = getFirst(NS.health + 'isActive');
  if (isActive === 'false') fhirResource.status = 'stopped';

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

  const doseText = getFirst(NS.health + 'dose');
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
    status: 'current',
    type: { text: getFirst(NS.clinical + 'documentType') ?? '' },
  };

  const docDate = getFirst(NS.clinical + 'documentDate');
  if (docDate) fhirResource.date = docDate;

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

export function restoreEncounter(pv: PV, _warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'Encounter',
    status: getFirst(NS.clinical + 'encounterStatus') ?? 'finished',
  };

  const encClass = getFirst(NS.clinical + 'encounterClass');
  if (encClass) fhirResource.class = { code: encClass };

  const encType = getFirst(NS.clinical + 'encounterType');
  if (encType) fhirResource.type = [{ text: encType }];

  const start = getFirst(NS.clinical + 'encounterStart');
  const end = getFirst(NS.clinical + 'encounterEnd');
  if (start || end) {
    fhirResource.period = {};
    if (start) fhirResource.period.start = start;
    if (end) fhirResource.period.end = end;
  }

  const provName = getFirst(NS.clinical + 'providerName');
  if (provName) fhirResource.participant = [{ individual: { display: provName } }];

  const facility = getFirst(NS.clinical + 'facilityName');
  if (facility) fhirResource.serviceProvider = { display: facility };

  const srcId = getFirst(NS.clinical + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  return fhirResource;
}

// ---------------------------------------------------------------------------
// Laboratory report (DiagnosticReport)
// ---------------------------------------------------------------------------

export function restoreLaboratoryReport(pv: PV, _warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'DiagnosticReport',
    status: 'final',
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
