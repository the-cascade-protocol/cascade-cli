/**
 * FHIR -> Cascade converters for clinical record types.
 *
 * Converts:
 *   - MedicationStatement / MedicationRequest -> health:MedicationRecord
 *   - Condition -> health:ConditionRecord
 *   - AllergyIntolerance -> health:AllergyRecord
 *   - Observation (lab) -> health:LabResultRecord
 *   - Observation (vital) -> clinical:VitalSign
 *   - Procedure -> clinical:Procedure
 *   - DocumentReference -> clinical:ClinicalDocument
 *   - Encounter -> clinical:Encounter
 *   - DiagnosticReport -> clinical:LaboratoryReport
 *   - MedicationAdministration -> clinical:MedicationAdministration
 *   - Device -> clinical:ImplantedDevice
 *   - ImagingStudy -> clinical:ImagingStudy
 */

import type { Quad } from 'n3';

import {
  type ConversionResult,
  NS,
  CODING_SYSTEM_MAP,
  VITAL_LOINC_CODES,
  VITAL_CATEGORIES,
  extractCodings,
  codeableConceptText,
  tripleStr,
  tripleBool,
  tripleDouble,
  tripleRef,
  tripleType,
  tripleDateTime,
  tripleTyped,
  commonTriples,
  quadsToJsonLd,
  mintSubjectUri,
} from './types.js';

// ---------------------------------------------------------------------------
// Medication converter
// ---------------------------------------------------------------------------

export function convertMedicationStatement(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.health + 'MedicationRecord'));
  quads.push(...commonTriples(subjectUri));

  // Medication name
  const medName = codeableConceptText(resource.medicationCodeableConcept)
    ?? resource.medicationReference?.display
    ?? 'Unknown Medication';
  quads.push(tripleStr(subjectUri, NS.health + 'medicationName', medName));

  // isActive from FHIR status
  const status = resource.status as string | undefined;
  const isActive = status === 'active' || status === 'intended' || status === 'on-hold';
  quads.push(tripleBool(subjectUri, NS.health + 'isActive', isActive));

  // Drug codes
  const codings = extractCodings(resource.medicationCodeableConcept);
  for (const coding of codings) {
    const nsUri = CODING_SYSTEM_MAP[coding.system];
    if (nsUri) {
      quads.push(tripleRef(subjectUri, NS.clinical + 'drugCode', nsUri + coding.code));
      if (nsUri === NS.rxnorm) {
        quads.push(tripleRef(subjectUri, NS.health + 'rxNormCode', nsUri + coding.code));
      }
    } else {
      warnings.push(`Unknown coding system: ${coding.system} (code ${coding.code})`);
    }
  }

  // Dosage
  const dosage = Array.isArray(resource.dosage) ? resource.dosage[0] : undefined;
  if (dosage) {
    if (dosage.text) {
      quads.push(tripleStr(subjectUri, NS.health + 'dose', dosage.text));
    }
    if (dosage.route?.text) {
      quads.push(tripleStr(subjectUri, NS.health + 'route', dosage.route.text));
    } else if (dosage.route?.coding?.[0]?.display) {
      quads.push(tripleStr(subjectUri, NS.health + 'route', dosage.route.coding[0].display));
    }
    if (dosage.timing?.repeat?.frequency) {
      const freq = dosage.timing.repeat.frequency;
      const periodUnit = dosage.timing.repeat.periodUnit ?? 'd';
      const unitLabel = periodUnit === 'd' ? 'daily' : periodUnit === 'wk' ? 'weekly' : periodUnit;
      const freqText = freq === 1 ? `once ${unitLabel}` : `${freq} times ${unitLabel}`;
      quads.push(tripleStr(subjectUri, NS.health + 'frequency', freqText));
    }
  }

  // Effective period
  if (resource.effectivePeriod?.start) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'startDate', resource.effectivePeriod.start));
  } else if (resource.effectiveDateTime) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'startDate', resource.effectiveDateTime));
  }
  if (resource.effectivePeriod?.end) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'endDate', resource.effectivePeriod.end));
  }

  // Provenance class -- based on resource type
  const fhirResourceType = resource.resourceType as string;
  if (fhirResourceType === 'MedicationStatement') {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceFhirResourceType', 'MedicationStatement'));
    quads.push(tripleStr(subjectUri, NS.clinical + 'clinicalIntent', 'reportedUse'));
  } else if (fhirResourceType === 'MedicationRequest') {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceFhirResourceType', 'MedicationRequest'));
    quads.push(tripleStr(subjectUri, NS.clinical + 'clinicalIntent', 'prescribed'));
  }
  quads.push(tripleStr(subjectUri, NS.clinical + 'provenanceClass', 'imported'));

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  if (resource.note && Array.isArray(resource.note)) {
    const noteText = resource.note.map((n: any) => n.text).filter(Boolean).join('; ');
    if (noteText) quads.push(tripleStr(subjectUri, NS.health + 'notes', noteText));
  }

  return {
    turtle: '',
    warnings,
    resourceType: fhirResourceType,
    cascadeType: 'health:MedicationRecord',
    jsonld: quadsToJsonLd(quads, 'health:MedicationRecord'),
    _quads: quads,
  } as ConversionResult & { _quads: Quad[] };
}

// ---------------------------------------------------------------------------
// Condition converter
// ---------------------------------------------------------------------------

export function convertCondition(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.health + 'ConditionRecord'));
  quads.push(...commonTriples(subjectUri));

  const condName = codeableConceptText(resource.code) ?? 'Unknown Condition';
  quads.push(tripleStr(subjectUri, NS.health + 'conditionName', condName));

  const clinicalStatus = resource.clinicalStatus?.coding?.[0]?.code ?? 'active';
  quads.push(tripleStr(subjectUri, NS.health + 'status', clinicalStatus));

  if (resource.onsetDateTime) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'onsetDate', resource.onsetDateTime));
  } else if (resource.onsetPeriod?.start) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'onsetDate', resource.onsetPeriod.start));
  }

  if (resource.abatementDateTime) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'abatementDate', resource.abatementDateTime));
  }

  const codings = extractCodings(resource.code);
  for (const coding of codings) {
    const nsUri = CODING_SYSTEM_MAP[coding.system];
    if (nsUri === NS.icd10) {
      quads.push(tripleRef(subjectUri, NS.health + 'icd10Code', nsUri + coding.code));
    } else if (nsUri === NS.sct) {
      quads.push(tripleRef(subjectUri, NS.health + 'snomedCode', nsUri + coding.code));
    } else if (nsUri) {
      warnings.push(`Condition code from non-standard system: ${coding.system}`);
    }
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  if (resource.note && Array.isArray(resource.note)) {
    const noteText = resource.note.map((n: any) => n.text).filter(Boolean).join('; ');
    if (noteText) quads.push(tripleStr(subjectUri, NS.health + 'notes', noteText));
  }

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'health:ConditionRecord'),
    warnings,
    resourceType: 'Condition',
    cascadeType: 'health:ConditionRecord',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// AllergyIntolerance converter
// ---------------------------------------------------------------------------

export function convertAllergyIntolerance(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.health + 'AllergyRecord'));
  quads.push(...commonTriples(subjectUri));

  const allergen = codeableConceptText(resource.code) ?? 'Unknown Allergen';
  quads.push(tripleStr(subjectUri, NS.health + 'allergen', allergen));

  if (Array.isArray(resource.category) && resource.category.length > 0) {
    quads.push(tripleStr(subjectUri, NS.health + 'allergyCategory', resource.category[0]));
  }

  if (Array.isArray(resource.reaction) && resource.reaction.length > 0) {
    const manifestations = resource.reaction
      .flatMap((r: any) => r.manifestation ?? [])
      .map((m: any) => codeableConceptText(m))
      .filter(Boolean);
    if (manifestations.length > 0) {
      quads.push(tripleStr(subjectUri, NS.health + 'reaction', manifestations.join(', ')));
    }
    const severity = resource.reaction[0]?.severity;
    if (severity) {
      const severityMap: Record<string, string> = { mild: 'mild', moderate: 'moderate', severe: 'severe' };
      quads.push(tripleStr(subjectUri, NS.health + 'allergySeverity', severityMap[severity] ?? severity));
    }
  }

  if (resource.criticality && !(Array.isArray(resource.reaction) && resource.reaction[0]?.severity)) {
    const critMap: Record<string, string> = { low: 'mild', high: 'severe', 'unable-to-assess': 'moderate' };
    quads.push(tripleStr(subjectUri, NS.health + 'allergySeverity', critMap[resource.criticality] ?? resource.criticality));
  }

  if (resource.onsetDateTime) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'onsetDate', resource.onsetDateTime));
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  if (resource.note && Array.isArray(resource.note)) {
    const noteText = resource.note.map((n: any) => n.text).filter(Boolean).join('; ');
    if (noteText) quads.push(tripleStr(subjectUri, NS.health + 'notes', noteText));
  }

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'health:AllergyRecord'),
    warnings,
    resourceType: 'AllergyIntolerance',
    cascadeType: 'health:AllergyRecord',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// Observation: vital sign detection
// ---------------------------------------------------------------------------

export function isVitalSignObservation(resource: any): boolean {
  if (Array.isArray(resource.category)) {
    for (const cat of resource.category) {
      if (Array.isArray(cat.coding)) {
        for (const c of cat.coding) {
          if (VITAL_CATEGORIES.includes(c.code)) return true;
        }
      }
    }
  }
  const codings = extractCodings(resource.code);
  for (const c of codings) {
    if (c.system === 'http://loinc.org' && VITAL_LOINC_CODES[c.code]) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Observation (lab) converter
// ---------------------------------------------------------------------------

export function convertObservationLab(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.health + 'LabResultRecord'));
  quads.push(...commonTriples(subjectUri));

  const testName = codeableConceptText(resource.code) ?? 'Unknown Lab Test';
  quads.push(tripleStr(subjectUri, NS.health + 'testName', testName));

  if (resource.valueQuantity) {
    quads.push(tripleStr(subjectUri, NS.health + 'resultValue', String(resource.valueQuantity.value)));
    if (resource.valueQuantity.unit) {
      quads.push(tripleStr(subjectUri, NS.health + 'resultUnit', resource.valueQuantity.unit));
    }
  } else if (resource.valueString) {
    quads.push(tripleStr(subjectUri, NS.health + 'resultValue', resource.valueString));
  } else if (resource.valueCodeableConcept) {
    const valText = codeableConceptText(resource.valueCodeableConcept) ?? '';
    quads.push(tripleStr(subjectUri, NS.health + 'resultValue', valText));
  } else {
    quads.push(tripleStr(subjectUri, NS.health + 'resultValue', ''));
    warnings.push('No result value found in Observation resource');
  }

  if (resource.interpretation && Array.isArray(resource.interpretation) && resource.interpretation.length > 0) {
    const interpCode = resource.interpretation[0]?.coding?.[0]?.code ?? 'unknown';
    const interpMap: Record<string, string> = {
      N: 'normal', H: 'abnormal', L: 'abnormal', A: 'abnormal',
      HH: 'critical', LL: 'critical', AA: 'critical',
      HU: 'critical', LU: 'critical',
    };
    quads.push(tripleStr(subjectUri, NS.health + 'interpretation', interpMap[interpCode] ?? 'unknown'));
  } else {
    quads.push(tripleStr(subjectUri, NS.health + 'interpretation', 'unknown'));
  }

  const effectiveDate = resource.effectiveDateTime ?? resource.effectivePeriod?.start ?? resource.issued;
  if (effectiveDate) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'performedDate', effectiveDate));
  } else {
    warnings.push('No effective date found in Observation resource');
  }

  const codings = extractCodings(resource.code);
  for (const c of codings) {
    if (c.system === 'http://loinc.org') {
      quads.push(tripleRef(subjectUri, NS.health + 'testCode', NS.loinc + c.code));
    }
  }

  if (Array.isArray(resource.category)) {
    for (const cat of resource.category) {
      if (Array.isArray(cat.coding)) {
        for (const c of cat.coding) {
          if (c.code && c.code !== 'laboratory') {
            quads.push(tripleStr(subjectUri, NS.health + 'labCategory', c.code));
          }
        }
      }
      if (cat.text) {
        quads.push(tripleStr(subjectUri, NS.health + 'labCategory', cat.text));
      }
    }
  }

  if (Array.isArray(resource.referenceRange) && resource.referenceRange.length > 0) {
    const rr = resource.referenceRange[0];
    const parts: string[] = [];
    if (rr.low?.value !== undefined) parts.push(String(rr.low.value));
    if (rr.high?.value !== undefined) parts.push(String(rr.high.value));
    const unit = rr.low?.unit ?? rr.high?.unit ?? '';
    if (parts.length === 2) {
      quads.push(tripleStr(subjectUri, NS.health + 'referenceRange', `${parts[0]}-${parts[1]} ${unit}`.trim()));
    } else if (rr.text) {
      quads.push(tripleStr(subjectUri, NS.health + 'referenceRange', rr.text));
    }
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'health:LabResultRecord'),
    warnings,
    resourceType: 'Observation',
    cascadeType: 'health:LabResultRecord',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// Observation (vital sign) converter
// ---------------------------------------------------------------------------

export function convertObservationVital(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'VitalSign'));
  quads.push(...commonTriples(subjectUri));

  const codings = extractCodings(resource.code);
  let vitalInfo: { type: string; name: string; unit: string; snomedCode: string } | undefined;
  for (const c of codings) {
    if (c.system === 'http://loinc.org' && VITAL_LOINC_CODES[c.code]) {
      vitalInfo = VITAL_LOINC_CODES[c.code];
      quads.push(tripleRef(subjectUri, NS.clinical + 'loincCode', NS.loinc + c.code));
      break;
    }
  }

  if (vitalInfo) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'vitalType', vitalInfo.type));
    quads.push(tripleStr(subjectUri, NS.clinical + 'vitalTypeName', vitalInfo.name));
    quads.push(tripleRef(subjectUri, NS.clinical + 'snomedCode', NS.sct + vitalInfo.snomedCode));
  } else {
    const name = codeableConceptText(resource.code) ?? 'Unknown Vital';
    quads.push(tripleStr(subjectUri, NS.clinical + 'vitalType', name.toLowerCase().replace(/\s+/g, '_')));
    quads.push(tripleStr(subjectUri, NS.clinical + 'vitalTypeName', name));
    warnings.push(`Unknown vital sign LOINC code -- using display name: ${name}`);
  }

  if (resource.valueQuantity) {
    quads.push(tripleDouble(subjectUri, NS.clinical + 'value', resource.valueQuantity.value));
    quads.push(tripleStr(subjectUri, NS.clinical + 'unit', resource.valueQuantity.unit ?? vitalInfo?.unit ?? ''));
  } else {
    warnings.push('No valueQuantity found in vital sign Observation');
  }

  const effectiveDate = resource.effectiveDateTime ?? resource.effectivePeriod?.start;
  if (effectiveDate) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'effectiveDate', effectiveDate));
  }

  if (Array.isArray(resource.referenceRange) && resource.referenceRange.length > 0) {
    const rr = resource.referenceRange[0];
    if (rr.low?.value !== undefined) {
      quads.push(tripleDouble(subjectUri, NS.clinical + 'referenceRangeLow', rr.low.value));
    }
    if (rr.high?.value !== undefined) {
      quads.push(tripleDouble(subjectUri, NS.clinical + 'referenceRangeHigh', rr.high.value));
    }
  }

  if (resource.interpretation && Array.isArray(resource.interpretation) && resource.interpretation.length > 0) {
    const interpCode = resource.interpretation[0]?.coding?.[0]?.code ?? 'unknown';
    const interpMap: Record<string, string> = {
      N: 'normal', H: 'high', L: 'low', A: 'abnormal',
      HH: 'critical', LL: 'critical',
    };
    quads.push(tripleStr(subjectUri, NS.clinical + 'interpretation', interpMap[interpCode] ?? interpCode));
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:VitalSign'),
    warnings,
    resourceType: 'Observation',
    cascadeType: 'clinical:VitalSign',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// Procedure converter (B1)
// ---------------------------------------------------------------------------

export function convertProcedure(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'Procedure'));
  quads.push(...commonTriples(subjectUri));

  // Procedure name
  const name = codeableConceptText(resource.code) ?? 'Unknown Procedure';
  quads.push(tripleStr(subjectUri, NS.clinical + 'procedureName', name));

  // Procedure codes
  const codings = extractCodings(resource.code);
  for (const c of codings) {
    if (c.system === 'http://snomed.info/sct') {
      quads.push(tripleRef(subjectUri, NS.clinical + 'procedureSnomedCode', NS.sct + c.code));
    } else if (c.system === 'http://www.ama-assn.org/go/cpt' || c.system.includes('cpt')) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'cptCode', c.code));
    }
  }

  // performedDate -- use performedDateTime first, fall back to performedPeriod.start
  const performedDate = resource.performedDateTime ?? resource.performedPeriod?.start;
  if (performedDate) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'performedDate', performedDate));
  }

  // Status
  if (resource.status) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'procedureStatus', resource.status));
  }

  // Source record ID
  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceRecordId', resource.id));
  }

  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'FullyMapped'));

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:Procedure'),
    warnings,
    resourceType: 'Procedure',
    cascadeType: 'clinical:Procedure',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// ClinicalDocument converter (B1)
// ---------------------------------------------------------------------------

export function convertClinicalDocument(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'ClinicalDocument'));
  quads.push(...commonTriples(subjectUri));

  // Document type
  const docType = codeableConceptText(resource.type) ?? 'Unknown Document';
  quads.push(tripleStr(subjectUri, NS.clinical + 'documentType', docType));

  // Date
  const docDate = resource.date ?? resource.indexed;
  if (docDate) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'documentDate', docDate));
  }

  // Content type and URL from first attachment
  if (Array.isArray(resource.content) && resource.content.length > 0) {
    const attachment = resource.content[0]?.attachment;
    if (attachment) {
      if (attachment.contentType) {
        quads.push(tripleStr(subjectUri, NS.clinical + 'contentType', attachment.contentType));
      }
      if (attachment.url) {
        quads.push(tripleStr(subjectUri, NS.clinical + 'documentUrl', attachment.url));
      }
      if (attachment.title) {
        quads.push(tripleStr(subjectUri, NS.clinical + 'documentTitle', attachment.title));
      }
    }
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceRecordId', resource.id));
  }

  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'FullyMapped'));

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:ClinicalDocument'),
    warnings,
    resourceType: 'DocumentReference',
    cascadeType: 'clinical:ClinicalDocument',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// Encounter converter (B2)
// ---------------------------------------------------------------------------

export function convertEncounter(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'Encounter'));
  quads.push(...commonTriples(subjectUri));

  // Encounter class (ambulatory, emergency, inpatient, etc.)
  const encounterClass = resource.class?.code ?? resource.class?.coding?.[0]?.code;
  if (encounterClass) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'encounterClass', encounterClass));
  }

  // Status
  if (resource.status) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'encounterStatus', resource.status));
  }

  // Encounter type (from type[0])
  if (Array.isArray(resource.type) && resource.type.length > 0) {
    const typeText = codeableConceptText(resource.type[0]);
    if (typeText) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'encounterType', typeText));
    }
    // SNOMED code from type
    const codings = extractCodings(resource.type[0]);
    for (const c of codings) {
      if (c.system === 'http://snomed.info/sct') {
        quads.push(tripleRef(subjectUri, NS.clinical + 'snomedCode', NS.sct + c.code));
        break;
      }
    }
  }

  // Period
  if (resource.period?.start) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'encounterStart', resource.period.start));
  }
  if (resource.period?.end) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'encounterEnd', resource.period.end));
  }

  // Provider from first participant
  if (Array.isArray(resource.participant) && resource.participant.length > 0) {
    const providerName = resource.participant[0]?.individual?.display;
    if (providerName) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'providerName', providerName));
    }
  }

  // Facility from serviceProvider
  if (resource.serviceProvider?.display) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'facilityName', resource.serviceProvider.display));
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceRecordId', resource.id));
  }

  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'FullyMapped'));

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:Encounter'),
    warnings,
    resourceType: 'Encounter',
    cascadeType: 'clinical:Encounter',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// LaboratoryReport (DiagnosticReport) converter (B5)
// ---------------------------------------------------------------------------

export function convertLaboratoryReport(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'LaboratoryReport'));
  quads.push(...commonTriples(subjectUri));

  // Panel name from code.text or first coding display
  const panelName = codeableConceptText(resource.code) ?? 'Unknown Panel';
  quads.push(tripleStr(subjectUri, NS.clinical + 'panelName', panelName));

  // LOINC code
  const codings = extractCodings(resource.code);
  for (const c of codings) {
    if (c.system === 'http://loinc.org') {
      quads.push(tripleRef(subjectUri, NS.clinical + 'loincCode', NS.loinc + c.code));
      break;
    }
  }

  // Report category
  if (Array.isArray(resource.category) && resource.category.length > 0) {
    const catCode = resource.category[0]?.coding?.[0]?.code ?? codeableConceptText(resource.category[0]);
    if (catCode) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'reportCategory', catCode));
    }
  }

  // Effective date
  const effectiveDate = resource.effectiveDateTime ?? resource.effectivePeriod?.start;
  if (effectiveDate) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'performedDate', effectiveDate));
  }

  // Provider from first performer
  if (Array.isArray(resource.performer) && resource.performer.length > 0) {
    const provName = resource.performer[0]?.display;
    if (provName) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'providerName', provName));
    }
  }

  // Link to constituent LabResult Observations via hasLabResult
  if (Array.isArray(resource.result)) {
    for (const ref of resource.result) {
      // Extract ID from reference like "Observation/uuid-here"
      const refStr = ref.reference as string | undefined;
      if (refStr) {
        const parts = refStr.split('/');
        const obsId = parts[parts.length - 1];
        if (obsId) {
          // Mint deterministic URI for the referenced Observation
          const obsUri = `urn:uuid:${obsId}`;
          quads.push(tripleRef(subjectUri, NS.clinical + 'hasLabResult', obsUri));
        }
      }
    }
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceRecordId', resource.id));
  }

  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'FullyMapped'));

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:LaboratoryReport'),
    warnings,
    resourceType: 'DiagnosticReport',
    cascadeType: 'clinical:LaboratoryReport',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// MedicationAdministration converter (B5)
// ---------------------------------------------------------------------------

export function convertMedicationAdministration(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'MedicationAdministration'));
  quads.push(...commonTriples(subjectUri));

  // Medication name
  const medName = codeableConceptText(resource.medicationCodeableConcept)
    ?? resource.medicationReference?.display
    ?? 'Unknown Medication';
  quads.push(tripleStr(subjectUri, NS.health + 'medicationName', medName));

  // Status
  if (resource.status) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'administrationStatus', resource.status));
  }

  // Administered date
  const adminDate = resource.effectiveDateTime ?? resource.effectivePeriod?.start;
  if (adminDate) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'administeredDate', adminDate));
  }

  // Dose and route from dosage
  if (resource.dosage) {
    if (resource.dosage.dose) {
      const dose = `${resource.dosage.dose.value ?? ''} ${resource.dosage.dose.unit ?? ''}`.trim();
      if (dose) quads.push(tripleStr(subjectUri, NS.clinical + 'administeredDose', dose));
    }
    const route = codeableConceptText(resource.dosage.route);
    if (route) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'administeredRoute', route));
    }
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceRecordId', resource.id));
  }

  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'FullyMapped'));

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:MedicationAdministration'),
    warnings,
    resourceType: 'MedicationAdministration',
    cascadeType: 'clinical:MedicationAdministration',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// Device (ImplantedDevice) converter (B5)
// ---------------------------------------------------------------------------

export function convertDevice(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'ImplantedDevice'));
  quads.push(...commonTriples(subjectUri));

  // Device type
  const deviceType = codeableConceptText(resource.type) ?? 'Unknown Device';
  quads.push(tripleStr(subjectUri, NS.clinical + 'deviceType', deviceType));

  // Status
  if (resource.status) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'deviceStatus', resource.status));
  }

  // Manufacturer
  if (resource.manufacturer) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'deviceManufacturer', resource.manufacturer));
  }

  // UDI carrier
  if (Array.isArray(resource.udiCarrier) && resource.udiCarrier.length > 0) {
    const udi = resource.udiCarrier[0]?.deviceIdentifier ?? resource.udiCarrier[0]?.carrierHRF;
    if (udi) quads.push(tripleStr(subjectUri, NS.clinical + 'udiCarrier', udi));
  }

  // Implant date (from manufactureDate or extension)
  if (resource.manufactureDate) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'implantDate', resource.manufactureDate));
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceRecordId', resource.id));
  }

  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'FullyMapped'));

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:ImplantedDevice'),
    warnings,
    resourceType: 'Device',
    cascadeType: 'clinical:ImplantedDevice',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// ImagingStudy converter (B5)
// ---------------------------------------------------------------------------

export function convertImagingStudy(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'ImagingStudy'));
  quads.push(...commonTriples(subjectUri));

  // Modality from first series
  const modality = resource.series?.[0]?.modality?.code;
  if (modality) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'imagingModality', modality));
  }

  // Description
  if (resource.description) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'studyDescription', resource.description));
  }

  // Number of series
  if (resource.numberOfSeries !== undefined) {
    quads.push(tripleTyped(subjectUri, NS.clinical + 'numberOfSeries', String(resource.numberOfSeries), NS.xsd + 'integer'));
  }

  // Study date
  if (resource.started) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'studyDate', resource.started));
  }

  // DICOM Study UID from identifier[0]
  if (Array.isArray(resource.identifier) && resource.identifier.length > 0) {
    const uid = resource.identifier[0]?.value;
    if (uid) quads.push(tripleStr(subjectUri, NS.clinical + 'dicomStudyUid', uid));
  }

  // Retrieve URL from first series endpoint
  const retrieveUrl = resource.series?.[0]?.endpoint?.[0]?.reference;
  if (retrieveUrl) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'retrieveUrl', retrieveUrl));
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceRecordId', resource.id));
  }

  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'FullyMapped'));

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:ImagingStudy'),
    warnings,
    resourceType: 'ImagingStudy',
    cascadeType: 'clinical:ImagingStudy',
    _quads: quads,
  };
}
