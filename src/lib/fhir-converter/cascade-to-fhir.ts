/**
 * Cascade -> FHIR (reverse conversion).
 *
 * Parses Cascade Protocol Turtle using n3, identifies the resource type from
 * rdf:type, and maps Cascade predicates back to FHIR R4 fields.
 *
 * Not all Cascade fields have FHIR equivalents -- lost fields are reported
 * as warnings.
 */

import { Parser, type Quad } from 'n3';
import { NS } from './types.js';

/**
 * Convert Cascade Turtle to FHIR R4 JSON.
 */
export async function convertCascadeToFhir(turtle: string): Promise<{
  resources: any[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const resources: any[] = [];

  // Parse Turtle
  const parser = new Parser();
  const quads: Quad[] = [];
  try {
    const parsed = parser.parse(turtle);
    quads.push(...parsed);
  } catch (err: any) {
    return { resources: [], warnings: [`Turtle parse error: ${err.message}`] };
  }

  // Group quads by subject
  const subjects = new Map<string, Quad[]>();
  for (const q of quads) {
    const subj = q.subject.value;
    if (!subjects.has(subj)) subjects.set(subj, []);
    subjects.get(subj)!.push(q);
  }

  for (const [_subjectUri, subjectQuads] of subjects) {
    // Find rdf:type
    const typeQuad = subjectQuads.find(q => q.predicate.value === NS.rdf + 'type');
    if (!typeQuad) continue;

    const rdfType = typeQuad.object.value;

    // Build a predicate->value map for quick access
    const pv = new Map<string, string[]>();
    for (const q of subjectQuads) {
      const pred = q.predicate.value;
      if (!pv.has(pred)) pv.set(pred, []);
      pv.get(pred)!.push(q.object.value);
    }

    const getFirst = (pred: string): string | undefined => pv.get(pred)?.[0];

    if (rdfType === NS.health + 'MedicationRecord') {
      const fhirResource: any = {
        resourceType: 'MedicationStatement',
        status: 'active',
        medicationCodeableConcept: { text: getFirst(NS.health + 'medicationName') ?? '' },
      };

      // isActive -> status
      const isActive = getFirst(NS.health + 'isActive');
      if (isActive === 'false') fhirResource.status = 'stopped';

      // Drug codes
      const drugCodes = pv.get(NS.clinical + 'drugCode') ?? [];
      const codingArr: any[] = [];
      for (const uri of drugCodes) {
        if (uri.startsWith(NS.rxnorm)) {
          codingArr.push({ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: uri.slice(NS.rxnorm.length) });
        } else if (uri.startsWith(NS.sct)) {
          codingArr.push({ system: 'http://snomed.info/sct', code: uri.slice(NS.sct.length) });
        }
      }
      if (codingArr.length > 0) {
        fhirResource.medicationCodeableConcept.coding = codingArr;
      }

      // Dosage
      const doseText = getFirst(NS.health + 'dose');
      if (doseText) {
        fhirResource.dosage = [{ text: doseText }];
      }

      // Dates
      const startDate = getFirst(NS.health + 'startDate');
      const endDate = getFirst(NS.health + 'endDate');
      if (startDate || endDate) {
        fhirResource.effectivePeriod = {};
        if (startDate) fhirResource.effectivePeriod.start = startDate;
        if (endDate) fhirResource.effectivePeriod.end = endDate;
      }

      // Source record ID
      const srcId = getFirst(NS.health + 'sourceRecordId');
      if (srcId) fhirResource.id = srcId;

      // Cascade-only fields that have no FHIR equivalent
      const cascadeOnlyFields = [
        NS.clinical + 'provenanceClass',
        NS.clinical + 'clinicalIntent',
        NS.cascade + 'schemaVersion',
        NS.health + 'medicationClass',
      ];
      for (const field of cascadeOnlyFields) {
        if (getFirst(field)) {
          const shortName = field.split('#')[1] ?? field;
          warnings.push(`Cascade field '${shortName}' has no FHIR equivalent and was not included in output`);
        }
      }

      resources.push(fhirResource);
    } else if (rdfType === NS.health + 'ConditionRecord') {
      const fhirResource: any = {
        resourceType: 'Condition',
        code: {
          text: getFirst(NS.health + 'conditionName') ?? '',
        },
      };

      // Status
      const status = getFirst(NS.health + 'status');
      if (status) {
        fhirResource.clinicalStatus = {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: status }],
        };
      }

      // Onset
      const onset = getFirst(NS.health + 'onsetDate');
      if (onset) fhirResource.onsetDateTime = onset;

      // Codes
      const codingArr: any[] = [];
      const icd10 = pv.get(NS.health + 'icd10Code') ?? [];
      for (const uri of icd10) {
        codingArr.push({ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: uri.startsWith(NS.icd10) ? uri.slice(NS.icd10.length) : uri });
      }
      const snomed = pv.get(NS.health + 'snomedCode') ?? [];
      for (const uri of snomed) {
        codingArr.push({ system: 'http://snomed.info/sct', code: uri.startsWith(NS.sct) ? uri.slice(NS.sct.length) : uri });
      }
      if (codingArr.length > 0) fhirResource.code.coding = codingArr;

      const srcId = getFirst(NS.health + 'sourceRecordId');
      if (srcId) fhirResource.id = srcId;

      resources.push(fhirResource);
    } else if (rdfType === NS.health + 'AllergyRecord') {
      const fhirResource: any = {
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

      resources.push(fhirResource);
    } else if (rdfType === NS.health + 'LabResultRecord') {
      const fhirResource: any = {
        resourceType: 'Observation',
        code: { text: getFirst(NS.health + 'testName') ?? '' },
        category: [{ coding: [{ code: 'laboratory' }] }],
      };

      // LOINC code
      const testCode = pv.get(NS.health + 'testCode') ?? [];
      const codingArr: any[] = [];
      for (const uri of testCode) {
        const code = uri.startsWith(NS.loinc) ? uri.slice(NS.loinc.length) : uri;
        codingArr.push({ system: 'http://loinc.org', code });
      }
      if (codingArr.length > 0) fhirResource.code.coding = codingArr;

      // Value
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

      // Date
      const perfDate = getFirst(NS.health + 'performedDate');
      if (perfDate) fhirResource.effectiveDateTime = perfDate;

      // Interpretation
      const interp = getFirst(NS.health + 'interpretation');
      if (interp) {
        const revInterpMap: Record<string, string> = {
          normal: 'N', abnormal: 'A', critical: 'HH', unknown: 'UNK',
        };
        fhirResource.interpretation = [{
          coding: [{ code: revInterpMap[interp] ?? interp }],
        }];
      }

      const srcId = getFirst(NS.health + 'sourceRecordId');
      if (srcId) fhirResource.id = srcId;

      resources.push(fhirResource);
    } else if (rdfType === NS.clinical + 'VitalSign') {
      const fhirResource: any = {
        resourceType: 'Observation',
        code: {},
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
      };

      // LOINC code
      const loincUri = getFirst(NS.clinical + 'loincCode');
      if (loincUri) {
        const code = loincUri.startsWith(NS.loinc) ? loincUri.slice(NS.loinc.length) : loincUri;
        fhirResource.code.coding = [{ system: 'http://loinc.org', code }];
      }
      const vitalName = getFirst(NS.clinical + 'vitalTypeName');
      if (vitalName) fhirResource.code.text = vitalName;

      // Value
      const value = getFirst(NS.clinical + 'value');
      const unit = getFirst(NS.clinical + 'unit');
      if (value) {
        fhirResource.valueQuantity = { value: parseFloat(value) };
        if (unit) fhirResource.valueQuantity.unit = unit;
      }

      // Date
      const effDate = getFirst(NS.clinical + 'effectiveDate');
      if (effDate) fhirResource.effectiveDateTime = effDate;

      const srcId = getFirst(NS.health + 'sourceRecordId');
      if (srcId) fhirResource.id = srcId;

      // Warn about Cascade-specific fields
      if (getFirst(NS.clinical + 'snomedCode')) {
        warnings.push("Cascade field 'snomedCode' has no standard FHIR Observation field and was not included");
      }

      resources.push(fhirResource);
    } else if (rdfType === NS.cascade + 'PatientProfile') {
      const fhirResource: any = {
        resourceType: 'Patient',
      };

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

      // Warn about Cascade-only fields
      const cascadeOnly = ['computedAge', 'ageGroup', 'genderIdentity'];
      for (const field of cascadeOnly) {
        if (getFirst(NS.cascade + field)) {
          warnings.push(`Cascade field '${field}' has no FHIR Patient equivalent and was not included`);
        }
      }

      resources.push(fhirResource);
    } else if (rdfType === NS.health + 'ImmunizationRecord') {
      const fhirResource: any = {
        resourceType: 'Immunization',
        status: getFirst(NS.health + 'status') ?? 'completed',
        vaccineCode: { text: getFirst(NS.health + 'vaccineName') ?? '' },
      };

      const adminDate = getFirst(NS.health + 'administrationDate');
      if (adminDate) fhirResource.occurrenceDateTime = adminDate;

      const vaccineCode = getFirst(NS.health + 'vaccineCode');
      if (vaccineCode) {
        // Strip "CVX-" prefix
        const code = vaccineCode.startsWith('CVX-') ? vaccineCode.slice(4) : vaccineCode;
        fhirResource.vaccineCode.coding = [{ system: 'http://hl7.org/fhir/sid/cvx', code }];
      }

      const manufacturer = getFirst(NS.health + 'manufacturer');
      if (manufacturer) fhirResource.manufacturer = { display: manufacturer };

      const lotNumber = getFirst(NS.health + 'lotNumber');
      if (lotNumber) fhirResource.lotNumber = lotNumber;

      const srcId = getFirst(NS.health + 'sourceRecordId');
      if (srcId) fhirResource.id = srcId;

      resources.push(fhirResource);
    } else if (rdfType === NS.coverage + 'InsurancePlan') {
      const fhirResource: any = {
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

      resources.push(fhirResource);
    } else {
      warnings.push(`Unknown Cascade RDF type: ${rdfType}`);
    }
  }

  return { resources, warnings };
}
