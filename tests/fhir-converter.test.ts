/**
 * Unit tests for the FHIR converter modules.
 *
 * Tests FHIR -> Cascade conversion (all 9 resource types),
 * Cascade -> FHIR reverse conversion, batch Bundle conversion,
 * and edge cases.
 */

import { describe, it, expect } from 'vitest';
import {
  convertFhirToCascade,
  convertFhirResourceToQuads,
  convert,
} from '../src/lib/fhir-converter/index.js';
import { convertCascadeToFhir } from '../src/lib/fhir-converter/cascade-to-fhir.js';
import {
  convertMedicationStatement,
  convertCondition,
  convertAllergyIntolerance,
  convertObservationLab,
  convertObservationVital,
  isVitalSignObservation,
} from '../src/lib/fhir-converter/converters-clinical.js';
import {
  convertPatient,
  convertImmunization,
  convertCoverage,
} from '../src/lib/fhir-converter/converters-demographics.js';
import {
  NS,
  ensureDateTimeWithTz,
  extractCodings,
  codeableConceptText,
} from '../src/lib/fhir-converter/types.js';

// =============================================================================
// Sample FHIR resources for testing
// =============================================================================

const samplePatient = {
  resourceType: 'Patient',
  id: 'patient-1',
  birthDate: '1985-06-15',
  gender: 'female',
  address: [
    {
      city: 'Portland',
      state: 'OR',
      postalCode: '97201',
      country: 'US',
      line: ['123 Main St'],
    },
  ],
  maritalStatus: {
    coding: [{ code: 'M' }],
    text: 'Married',
  },
};

const sampleCondition = {
  resourceType: 'Condition',
  id: 'condition-1',
  code: {
    coding: [
      { system: 'http://snomed.info/sct', code: '73211009', display: 'Diabetes Mellitus' },
      { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'E11.9', display: 'Type 2 diabetes mellitus without complications' },
    ],
    text: 'Diabetes Mellitus',
  },
  clinicalStatus: {
    coding: [{ code: 'active' }],
  },
  onsetDateTime: '2020-03-15',
  note: [{ text: 'Patient diagnosed during routine screening' }],
};

const sampleAllergy = {
  resourceType: 'AllergyIntolerance',
  id: 'allergy-1',
  code: {
    coding: [{ display: 'Penicillin' }],
    text: 'Penicillin',
  },
  category: ['medication'],
  reaction: [
    {
      manifestation: [{ text: 'Hives' }, { text: 'Rash' }],
      severity: 'moderate',
    },
  ],
  onsetDateTime: '2015-01-01',
};

const sampleLabObservation = {
  resourceType: 'Observation',
  id: 'lab-1',
  code: {
    coding: [{ system: 'http://loinc.org', code: '2345-7', display: 'Glucose' }],
    text: 'Glucose',
  },
  category: [{ coding: [{ code: 'laboratory' }] }],
  valueQuantity: { value: 105, unit: 'mg/dL' },
  interpretation: [{ coding: [{ code: 'H' }] }],
  effectiveDateTime: '2024-01-15T10:30:00Z',
  referenceRange: [{ low: { value: 70, unit: 'mg/dL' }, high: { value: 100, unit: 'mg/dL' } }],
};

const sampleVitalObservation = {
  resourceType: 'Observation',
  id: 'vital-1',
  code: {
    coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic Blood Pressure' }],
  },
  category: [{ coding: [{ code: 'vital-signs' }] }],
  valueQuantity: { value: 128, unit: 'mmHg' },
  effectiveDateTime: '2024-01-15T10:30:00Z',
  referenceRange: [{ low: { value: 90 }, high: { value: 120 } }],
  interpretation: [{ coding: [{ code: 'H' }] }],
};

const sampleMedicationStatement = {
  resourceType: 'MedicationStatement',
  id: 'med-1',
  status: 'active',
  medicationCodeableConcept: {
    coding: [
      { system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '1049502', display: 'Metformin 500mg' },
    ],
    text: 'Metformin 500mg',
  },
  dosage: [
    {
      text: '500mg twice daily',
      route: { text: 'oral' },
      timing: { repeat: { frequency: 2, periodUnit: 'd' } },
    },
  ],
  effectivePeriod: {
    start: '2020-03-15',
  },
  note: [{ text: 'Take with meals' }],
};

const sampleMedicationRequest = {
  resourceType: 'MedicationRequest',
  id: 'med-req-1',
  status: 'active',
  medicationCodeableConcept: {
    coding: [
      { system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '860975', display: 'Lisinopril 10mg' },
    ],
    text: 'Lisinopril 10mg',
  },
  dosage: [{ text: '10mg once daily' }],
};

const sampleImmunization = {
  resourceType: 'Immunization',
  id: 'imm-1',
  status: 'completed',
  vaccineCode: {
    coding: [
      { system: 'http://hl7.org/fhir/sid/cvx', code: '208', display: 'COVID-19 mRNA' },
    ],
    text: 'COVID-19 mRNA Vaccine',
  },
  occurrenceDateTime: '2021-04-15T09:00:00Z',
  manufacturer: { display: 'Pfizer' },
  lotNumber: 'EL9264',
  performer: [{ actor: { display: 'Dr. Smith' } }],
  location: { display: 'City Health Clinic' },
  note: [{ text: 'First dose' }],
};

const sampleCoverage = {
  resourceType: 'Coverage',
  id: 'cov-1',
  status: 'active',
  subscriberId: 'XYZ123456',
  payor: [{ display: 'Blue Cross Blue Shield' }],
  type: { coding: [{ code: 'HIP' }] },
  class: [
    { type: { coding: [{ code: 'group' }] }, value: 'GRP-001', name: 'Premium Plan' },
    { type: { coding: [{ code: 'rxbin' }] }, value: '015432' },
    { type: { coding: [{ code: 'rxpcn' }] }, value: 'PCN99' },
    { type: { coding: [{ code: 'rxgroup' }] }, value: 'RXGRP01' },
  ],
  period: {
    start: '2024-01-01',
    end: '2024-12-31',
  },
  relationship: { coding: [{ code: 'self' }] },
};

// =============================================================================
// Helper: find quad value by predicate
// =============================================================================

function findQuadValue(quads: any[], predicateIri: string): string | undefined {
  const q = quads.find((q: any) => q.predicate.value === predicateIri);
  return q?.object?.value;
}

function findAllQuadValues(quads: any[], predicateIri: string): string[] {
  return quads
    .filter((q: any) => q.predicate.value === predicateIri)
    .map((q: any) => q.object.value);
}

// =============================================================================
// Tests: Helper functions from types.ts
// =============================================================================

describe('FHIR converter helpers', () => {
  describe('ensureDateTimeWithTz', () => {
    it('should return empty string for empty input', () => {
      expect(ensureDateTimeWithTz('')).toBe('');
    });

    it('should append T00:00:00Z to date-only strings', () => {
      expect(ensureDateTimeWithTz('2024-01-15')).toBe('2024-01-15T00:00:00Z');
    });

    it('should pass through strings with timezone', () => {
      expect(ensureDateTimeWithTz('2024-01-15T10:30:00Z')).toBe('2024-01-15T10:30:00Z');
    });

    it('should pass through strings with offset timezone', () => {
      expect(ensureDateTimeWithTz('2024-01-15T10:30:00+05:00')).toBe('2024-01-15T10:30:00+05:00');
    });

    it('should append Z to time without timezone', () => {
      expect(ensureDateTimeWithTz('2024-01-15T10:30:00')).toBe('2024-01-15T10:30:00Z');
    });
  });

  describe('extractCodings', () => {
    it('should return empty array for null input', () => {
      expect(extractCodings(null)).toEqual([]);
    });

    it('should return empty array for codeable concept without codings', () => {
      expect(extractCodings({ text: 'Something' })).toEqual([]);
    });

    it('should extract codings with system, code, and display', () => {
      const cc = {
        coding: [
          { system: 'http://loinc.org', code: '2345-7', display: 'Glucose' },
          { system: 'http://snomed.info/sct', code: '33747003' },
        ],
      };
      const result = extractCodings(cc);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ system: 'http://loinc.org', code: '2345-7', display: 'Glucose' });
      expect(result[1]).toEqual({ system: 'http://snomed.info/sct', code: '33747003', display: undefined });
    });

    it('should skip codings without system or code', () => {
      const cc = { coding: [{ display: 'Only display' }] };
      expect(extractCodings(cc)).toEqual([]);
    });
  });

  describe('codeableConceptText', () => {
    it('should return undefined for null input', () => {
      expect(codeableConceptText(null)).toBeUndefined();
    });

    it('should prefer .text property', () => {
      const cc = { text: 'My Text', coding: [{ display: 'Coded Display' }] };
      expect(codeableConceptText(cc)).toBe('My Text');
    });

    it('should fall back to coding[0].display', () => {
      const cc = { coding: [{ display: 'Coded Display' }] };
      expect(codeableConceptText(cc)).toBe('Coded Display');
    });
  });
});

// =============================================================================
// Tests: FHIR -> Cascade (per resource type)
// =============================================================================

describe('FHIR -> Cascade converters', () => {
  describe('Patient -> PatientProfile', () => {
    it('should convert Patient to cascade:PatientProfile', () => {
      const result = convertPatient(samplePatient);
      expect(result.resourceType).toBe('Patient');
      expect(result.cascadeType).toBe('cascade:PatientProfile');

      const quads = result._quads;
      const typeValue = findQuadValue(quads, NS.rdf + 'type');
      expect(typeValue).toBe(NS.cascade + 'PatientProfile');

      // Gender -> biologicalSex
      expect(findQuadValue(quads, NS.cascade + 'biologicalSex')).toBe('female');

      // Address fields
      expect(findQuadValue(quads, NS.cascade + 'addressCity')).toBe('Portland');
      expect(findQuadValue(quads, NS.cascade + 'addressState')).toBe('OR');
      expect(findQuadValue(quads, NS.cascade + 'addressPostalCode')).toBe('97201');

      // Marital status
      expect(findQuadValue(quads, NS.cascade + 'maritalStatus')).toBe('married');

      // Profile ID
      expect(findQuadValue(quads, NS.cascade + 'profileId')).toBe('patient-1');
    });

    it('should compute age and age group', () => {
      const result = convertPatient(samplePatient);
      const quads = result._quads;
      const computedAge = findQuadValue(quads, NS.cascade + 'computedAge');
      expect(computedAge).toBeDefined();
      expect(parseInt(computedAge!, 10)).toBeGreaterThan(30);

      const ageGroup = findQuadValue(quads, NS.cascade + 'ageGroup');
      expect(ageGroup).toBe('adult');
    });

    it('should warn when birthDate is missing', () => {
      const result = convertPatient({ resourceType: 'Patient' });
      expect(result.warnings).toContain('No birthDate found in Patient resource');
    });
  });

  describe('Condition -> ConditionRecord', () => {
    it('should convert Condition to health:ConditionRecord', () => {
      const result = convertCondition(sampleCondition);
      expect(result.cascadeType).toBe('health:ConditionRecord');

      const quads = result._quads;
      expect(findQuadValue(quads, NS.rdf + 'type')).toBe(NS.health + 'ConditionRecord');
      expect(findQuadValue(quads, NS.health + 'conditionName')).toBe('Diabetes Mellitus');
      expect(findQuadValue(quads, NS.health + 'status')).toBe('active');
      expect(findQuadValue(quads, NS.health + 'sourceRecordId')).toBe('condition-1');
    });

    it('should map ICD-10 and SNOMED codes', () => {
      const result = convertCondition(sampleCondition);
      const quads = result._quads;

      const snomedCodes = findAllQuadValues(quads, NS.health + 'snomedCode');
      expect(snomedCodes).toContain(NS.sct + '73211009');

      const icd10Codes = findAllQuadValues(quads, NS.health + 'icd10Code');
      expect(icd10Codes).toContain(NS.icd10 + 'E11.9');
    });

    it('should include notes', () => {
      const result = convertCondition(sampleCondition);
      const quads = result._quads;
      expect(findQuadValue(quads, NS.health + 'notes')).toBe('Patient diagnosed during routine screening');
    });
  });

  describe('AllergyIntolerance -> AllergyRecord', () => {
    it('should convert AllergyIntolerance to health:AllergyRecord', () => {
      const result = convertAllergyIntolerance(sampleAllergy);
      expect(result.cascadeType).toBe('health:AllergyRecord');

      const quads = result._quads;
      expect(findQuadValue(quads, NS.health + 'allergen')).toBe('Penicillin');
      expect(findQuadValue(quads, NS.health + 'allergyCategory')).toBe('medication');
      expect(findQuadValue(quads, NS.health + 'reaction')).toBe('Hives, Rash');
      expect(findQuadValue(quads, NS.health + 'allergySeverity')).toBe('moderate');
    });

    it('should fall back to criticality when reaction severity is missing', () => {
      const allergy = {
        resourceType: 'AllergyIntolerance',
        code: { text: 'Peanuts' },
        criticality: 'high',
      };
      const result = convertAllergyIntolerance(allergy);
      expect(findQuadValue(result._quads, NS.health + 'allergySeverity')).toBe('severe');
    });
  });

  describe('Observation (lab) -> LabResultRecord', () => {
    it('should convert lab Observation to health:LabResultRecord', () => {
      const result = convertObservationLab(sampleLabObservation);
      expect(result.cascadeType).toBe('health:LabResultRecord');

      const quads = result._quads;
      expect(findQuadValue(quads, NS.health + 'testName')).toBe('Glucose');
      expect(findQuadValue(quads, NS.health + 'resultValue')).toBe('105');
      expect(findQuadValue(quads, NS.health + 'resultUnit')).toBe('mg/dL');
      expect(findQuadValue(quads, NS.health + 'interpretation')).toBe('abnormal');
    });

    it('should handle referenceRange', () => {
      const result = convertObservationLab(sampleLabObservation);
      expect(findQuadValue(result._quads, NS.health + 'referenceRange')).toBe('70-100 mg/dL');
    });

    it('should handle valueString', () => {
      const obs = {
        resourceType: 'Observation',
        code: { text: 'Blood Type' },
        valueString: 'A+',
        effectiveDateTime: '2024-01-15',
      };
      const result = convertObservationLab(obs);
      expect(findQuadValue(result._quads, NS.health + 'resultValue')).toBe('A+');
    });

    it('should warn when result value is missing', () => {
      const obs = {
        resourceType: 'Observation',
        code: { text: 'Empty' },
        effectiveDateTime: '2024-01-15',
      };
      const result = convertObservationLab(obs);
      expect(result.warnings).toContain('No result value found in Observation resource');
    });

    it('should map LOINC test codes', () => {
      const result = convertObservationLab(sampleLabObservation);
      const testCodes = findAllQuadValues(result._quads, NS.health + 'testCode');
      expect(testCodes).toContain(NS.loinc + '2345-7');
    });
  });

  describe('Observation (vital) -> VitalSign', () => {
    it('should convert vital Observation to clinical:VitalSign', () => {
      const result = convertObservationVital(sampleVitalObservation);
      expect(result.cascadeType).toBe('clinical:VitalSign');

      const quads = result._quads;
      expect(findQuadValue(quads, NS.rdf + 'type')).toBe(NS.clinical + 'VitalSign');
      expect(findQuadValue(quads, NS.clinical + 'vitalType')).toBe('bloodPressureSystolic');
      expect(findQuadValue(quads, NS.clinical + 'vitalTypeName')).toBe('Systolic Blood Pressure');
    });

    it('should map LOINC code and SNOMED code', () => {
      const result = convertObservationVital(sampleVitalObservation);
      const quads = result._quads;
      expect(findQuadValue(quads, NS.clinical + 'loincCode')).toBe(NS.loinc + '8480-6');
      expect(findQuadValue(quads, NS.clinical + 'snomedCode')).toBe(NS.sct + '271649006');
    });

    it('should include value and unit', () => {
      const result = convertObservationVital(sampleVitalObservation);
      const quads = result._quads;
      expect(findQuadValue(quads, NS.clinical + 'value')).toBe('128');
      expect(findQuadValue(quads, NS.clinical + 'unit')).toBe('mmHg');
    });

    it('should include reference range', () => {
      const result = convertObservationVital(sampleVitalObservation);
      const quads = result._quads;
      expect(findQuadValue(quads, NS.clinical + 'referenceRangeLow')).toBe('90');
      expect(findQuadValue(quads, NS.clinical + 'referenceRangeHigh')).toBe('120');
    });

    it('should include interpretation', () => {
      const result = convertObservationVital(sampleVitalObservation);
      expect(findQuadValue(result._quads, NS.clinical + 'interpretation')).toBe('high');
    });
  });

  describe('isVitalSignObservation', () => {
    it('should detect vital sign by category', () => {
      expect(isVitalSignObservation(sampleVitalObservation)).toBe(true);
    });

    it('should detect vital sign by LOINC code alone', () => {
      const obs = {
        resourceType: 'Observation',
        code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
      };
      expect(isVitalSignObservation(obs)).toBe(true);
    });

    it('should return false for lab observation', () => {
      expect(isVitalSignObservation(sampleLabObservation)).toBe(false);
    });
  });

  describe('MedicationStatement -> MedicationRecord', () => {
    it('should convert MedicationStatement with full details', () => {
      const result = convertMedicationStatement(sampleMedicationStatement);
      expect(result.cascadeType).toBe('health:MedicationRecord');

      const quads = result._quads;
      expect(findQuadValue(quads, NS.health + 'medicationName')).toBe('Metformin 500mg');
      expect(findQuadValue(quads, NS.health + 'isActive')).toBe('true');
      expect(findQuadValue(quads, NS.health + 'dose')).toBe('500mg twice daily');
      expect(findQuadValue(quads, NS.health + 'route')).toBe('oral');
      expect(findQuadValue(quads, NS.health + 'frequency')).toBe('2 times daily');
      expect(findQuadValue(quads, NS.clinical + 'sourceFhirResourceType')).toBe('MedicationStatement');
      expect(findQuadValue(quads, NS.clinical + 'clinicalIntent')).toBe('reportedUse');
    });

    it('should map RxNorm drug codes', () => {
      const result = convertMedicationStatement(sampleMedicationStatement);
      const quads = result._quads;
      const rxCodes = findAllQuadValues(quads, NS.health + 'rxNormCode');
      expect(rxCodes).toContain(NS.rxnorm + '1049502');
    });

    it('should include notes', () => {
      const result = convertMedicationStatement(sampleMedicationStatement);
      expect(findQuadValue(result._quads, NS.health + 'notes')).toBe('Take with meals');
    });
  });

  describe('MedicationRequest -> MedicationRecord', () => {
    it('should convert MedicationRequest with prescribed intent', () => {
      const result = convertMedicationStatement(sampleMedicationRequest);
      expect(result.cascadeType).toBe('health:MedicationRecord');

      const quads = result._quads;
      expect(findQuadValue(quads, NS.health + 'medicationName')).toBe('Lisinopril 10mg');
      expect(findQuadValue(quads, NS.clinical + 'sourceFhirResourceType')).toBe('MedicationRequest');
      expect(findQuadValue(quads, NS.clinical + 'clinicalIntent')).toBe('prescribed');
    });
  });

  describe('Immunization -> ImmunizationRecord', () => {
    it('should convert Immunization to health:ImmunizationRecord', () => {
      const result = convertImmunization(sampleImmunization);
      expect(result.cascadeType).toBe('health:ImmunizationRecord');

      const quads = result._quads;
      expect(findQuadValue(quads, NS.health + 'vaccineName')).toBe('COVID-19 mRNA Vaccine');
      expect(findQuadValue(quads, NS.health + 'status')).toBe('completed');
      expect(findQuadValue(quads, NS.health + 'vaccineCode')).toBe('CVX-208');
      expect(findQuadValue(quads, NS.health + 'manufacturer')).toBe('Pfizer');
      expect(findQuadValue(quads, NS.health + 'lotNumber')).toBe('EL9264');
      expect(findQuadValue(quads, NS.health + 'administeringProvider')).toBe('Dr. Smith');
      expect(findQuadValue(quads, NS.health + 'administeringLocation')).toBe('City Health Clinic');
    });

    it('should include notes', () => {
      const result = convertImmunization(sampleImmunization);
      expect(findQuadValue(result._quads, NS.health + 'notes')).toBe('First dose');
    });

    it('should warn for occurrenceString', () => {
      const imm = {
        resourceType: 'Immunization',
        vaccineCode: { text: 'Flu Shot' },
        occurrenceString: 'sometime in 2020',
      };
      const result = convertImmunization(imm);
      expect(result.warnings.some(w => w.includes('string'))).toBe(true);
    });
  });

  describe('Coverage -> InsurancePlan', () => {
    it('should convert Coverage to coverage:InsurancePlan', () => {
      const result = convertCoverage(sampleCoverage);
      expect(result.cascadeType).toBe('coverage:InsurancePlan');

      const quads = result._quads;
      expect(findQuadValue(quads, NS.coverage + 'providerName')).toBe('Blue Cross Blue Shield');
      expect(findQuadValue(quads, NS.coverage + 'memberId')).toBe('XYZ123456');
      expect(findQuadValue(quads, NS.coverage + 'subscriberId')).toBe('XYZ123456');
      expect(findQuadValue(quads, NS.coverage + 'coverageType')).toBe('HIP');
      expect(findQuadValue(quads, NS.coverage + 'groupNumber')).toBe('GRP-001');
      expect(findQuadValue(quads, NS.coverage + 'planName')).toBe('Premium Plan');
      expect(findQuadValue(quads, NS.coverage + 'rxBin')).toBe('015432');
      expect(findQuadValue(quads, NS.coverage + 'rxPcn')).toBe('PCN99');
      expect(findQuadValue(quads, NS.coverage + 'rxGroup')).toBe('RXGRP01');
      expect(findQuadValue(quads, NS.coverage + 'subscriberRelationship')).toBe('self');
    });

    it('should warn when payor is missing', () => {
      const cov = { resourceType: 'Coverage' };
      const result = convertCoverage(cov);
      expect(result.warnings).toContain('No payor information found in Coverage resource');
      expect(findQuadValue(result._quads, NS.coverage + 'providerName')).toBe('Unknown Insurance');
    });

    it('should fall back to identifier when subscriberId is missing', () => {
      const cov = {
        resourceType: 'Coverage',
        identifier: [{ value: 'ID-999' }],
      };
      const result = convertCoverage(cov);
      expect(findQuadValue(result._quads, NS.coverage + 'memberId')).toBe('ID-999');
    });
  });
});

// =============================================================================
// Tests: Cascade -> FHIR (reverse conversion)
// =============================================================================

describe('Cascade -> FHIR converters', () => {
  describe('MedicationRecord -> MedicationStatement', () => {
    it('should round-trip MedicationStatement', async () => {
      const fhirResult = await convertFhirToCascade(sampleMedicationStatement);
      expect(fhirResult.turtle).toBeTruthy();

      const reverseResult = await convertCascadeToFhir(fhirResult.turtle);
      expect(reverseResult.resources).toHaveLength(1);

      const fhir = reverseResult.resources[0];
      expect(fhir.resourceType).toBe('MedicationStatement');
      expect(fhir.medicationCodeableConcept.text).toBe('Metformin 500mg');
      expect(fhir.status).toBe('active');
      expect(fhir.id).toBe('med-1');
    });
  });

  describe('ConditionRecord -> Condition', () => {
    it('should round-trip Condition', async () => {
      const fhirResult = await convertFhirToCascade(sampleCondition);
      const reverseResult = await convertCascadeToFhir(fhirResult.turtle);

      expect(reverseResult.resources).toHaveLength(1);
      const fhir = reverseResult.resources[0];
      expect(fhir.resourceType).toBe('Condition');
      expect(fhir.code.text).toBe('Diabetes Mellitus');
      expect(fhir.clinicalStatus.coding[0].code).toBe('active');
      expect(fhir.id).toBe('condition-1');
    });
  });

  describe('AllergyRecord -> AllergyIntolerance', () => {
    it('should round-trip AllergyIntolerance', async () => {
      const fhirResult = await convertFhirToCascade(sampleAllergy);
      const reverseResult = await convertCascadeToFhir(fhirResult.turtle);

      expect(reverseResult.resources).toHaveLength(1);
      const fhir = reverseResult.resources[0];
      expect(fhir.resourceType).toBe('AllergyIntolerance');
      expect(fhir.code.text).toBe('Penicillin');
      expect(fhir.category).toEqual(['medication']);
      expect(fhir.reaction[0].severity).toBe('moderate');
    });
  });

  describe('LabResultRecord -> Observation', () => {
    it('should round-trip lab Observation', async () => {
      const fhirResult = await convertFhirToCascade(sampleLabObservation);
      const reverseResult = await convertCascadeToFhir(fhirResult.turtle);

      expect(reverseResult.resources).toHaveLength(1);
      const fhir = reverseResult.resources[0];
      expect(fhir.resourceType).toBe('Observation');
      expect(fhir.code.text).toBe('Glucose');
      expect(fhir.valueQuantity.value).toBe(105);
      expect(fhir.valueQuantity.unit).toBe('mg/dL');
    });
  });

  describe('VitalSign -> Observation', () => {
    it('should round-trip vital sign Observation', async () => {
      const fhirResult = await convertFhirToCascade(sampleVitalObservation);
      const reverseResult = await convertCascadeToFhir(fhirResult.turtle);

      expect(reverseResult.resources).toHaveLength(1);
      const fhir = reverseResult.resources[0];
      expect(fhir.resourceType).toBe('Observation');
      expect(fhir.category[0].coding[0].code).toBe('vital-signs');
      expect(fhir.valueQuantity.value).toBe(128);
      expect(fhir.code.text).toBe('Systolic Blood Pressure');
    });
  });

  describe('PatientProfile -> Patient', () => {
    it('should round-trip Patient', async () => {
      const fhirResult = await convertFhirToCascade(samplePatient);
      const reverseResult = await convertCascadeToFhir(fhirResult.turtle);

      expect(reverseResult.resources).toHaveLength(1);
      const fhir = reverseResult.resources[0];
      expect(fhir.resourceType).toBe('Patient');
      expect(fhir.gender).toBe('female');
      expect(fhir.id).toBe('patient-1');
    });

    it('should warn about Cascade-only fields', async () => {
      const fhirResult = await convertFhirToCascade(samplePatient);
      const reverseResult = await convertCascadeToFhir(fhirResult.turtle);

      // computedAge and ageGroup have no FHIR equivalent
      expect(reverseResult.warnings.some(w => w.includes('computedAge'))).toBe(true);
      expect(reverseResult.warnings.some(w => w.includes('ageGroup'))).toBe(true);
    });
  });

  describe('ImmunizationRecord -> Immunization', () => {
    it('should round-trip Immunization', async () => {
      const fhirResult = await convertFhirToCascade(sampleImmunization);
      const reverseResult = await convertCascadeToFhir(fhirResult.turtle);

      expect(reverseResult.resources).toHaveLength(1);
      const fhir = reverseResult.resources[0];
      expect(fhir.resourceType).toBe('Immunization');
      expect(fhir.vaccineCode.text).toBe('COVID-19 mRNA Vaccine');
      expect(fhir.status).toBe('completed');
      expect(fhir.manufacturer.display).toBe('Pfizer');
      expect(fhir.lotNumber).toBe('EL9264');
    });
  });

  describe('InsurancePlan -> Coverage', () => {
    it('should round-trip Coverage', async () => {
      const fhirResult = await convertFhirToCascade(sampleCoverage);
      const reverseResult = await convertCascadeToFhir(fhirResult.turtle);

      expect(reverseResult.resources).toHaveLength(1);
      const fhir = reverseResult.resources[0];
      expect(fhir.resourceType).toBe('Coverage');
      expect(fhir.payor[0].display).toBe('Blue Cross Blue Shield');
      expect(fhir.subscriberId).toBe('XYZ123456');
    });
  });
});

// =============================================================================
// Tests: Batch conversion (FHIR Bundle)
// =============================================================================

describe('Batch conversion', () => {
  it('should convert a FHIR Bundle with multiple resources', async () => {
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        { resource: sampleCondition },
        { resource: sampleAllergy },
        { resource: sampleMedicationStatement },
      ],
    };

    const result = await convert(JSON.stringify(bundle), 'fhir', 'turtle');
    expect(result.success).toBe(true);
    expect(result.resourceCount).toBe(3);
    expect(result.output).toContain('MedicationRecord');
    expect(result.output).toContain('ConditionRecord');
    expect(result.output).toContain('AllergyRecord');
  });

  it('should convert a single resource (not Bundle)', async () => {
    const result = await convert(JSON.stringify(sampleCondition), 'fhir', 'turtle');
    expect(result.success).toBe(true);
    expect(result.resourceCount).toBe(1);
    expect(result.output).toContain('ConditionRecord');
  });

  it('should skip unsupported resource types in a Bundle', async () => {
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        { resource: sampleCondition },
        { resource: { resourceType: 'Practitioner', id: 'prac-1' } },
      ],
    };

    const result = await convert(JSON.stringify(bundle), 'fhir', 'turtle');
    expect(result.success).toBe(true);
    expect(result.resourceCount).toBe(1);
    expect(result.warnings.some(w => w.includes('Practitioner'))).toBe(true);
  });

  it('should convert to JSON-LD when requested', async () => {
    const result = await convert(JSON.stringify(sampleCondition), 'fhir', 'jsonld', 'jsonld');
    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
    const parsed = JSON.parse(result.output);
    expect(parsed['@context']).toBeDefined();
  });

  it('should convert Cascade Turtle back to FHIR Bundle', async () => {
    // First convert FHIR Bundle to Cascade
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        { resource: sampleCondition },
        { resource: sampleAllergy },
      ],
    };
    const cascadeResult = await convert(JSON.stringify(bundle), 'fhir', 'turtle');

    // Then convert back to FHIR
    const fhirResult = await convert(cascadeResult.output, 'cascade', 'fhir');
    expect(fhirResult.success).toBe(true);
    expect(fhirResult.resourceCount).toBe(2);
    const parsed = JSON.parse(fhirResult.output);
    expect(parsed.resourceType).toBe('Bundle');
    expect(parsed.entry).toHaveLength(2);
  });
});

// =============================================================================
// Tests: Edge cases
// =============================================================================

describe('Edge cases', () => {
  it('should return null for unknown resource types', () => {
    const result = convertFhirResourceToQuads({ resourceType: 'Practitioner' });
    expect(result).toBeNull();
  });

  it('should return null for resources without resourceType', () => {
    const result = convertFhirResourceToQuads({ id: 'something' });
    expect(result).toBeNull();
  });

  it('should handle empty/null input gracefully via convertFhirToCascade', async () => {
    const result = await convertFhirToCascade({ resourceType: 'Encounter' });
    expect(result.turtle).toBe('');
    expect(result.warnings.some(w => w.includes('Unsupported'))).toBe(true);
    expect(result.cascadeType).toBe('unknown');
  });

  it('should handle invalid JSON in batch convert', async () => {
    const result = await convert('not valid json', 'fhir', 'turtle');
    expect(result.success).toBe(false);
    expect(result.errors).toContain('Invalid JSON input');
  });

  it('should handle invalid Turtle in Cascade -> FHIR', async () => {
    const result = await convertCascadeToFhir('@@@ not valid turtle @@@');
    expect(result.resources).toHaveLength(0);
    expect(result.warnings.some(w => w.includes('parse error'))).toBe(true);
  });

  it('should handle unknown Cascade RDF type', async () => {
    const turtle = `
      @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix custom: <http://example.org/custom#> .
      <urn:uuid:test> rdf:type custom:UnknownType .
    `;
    const result = await convertCascadeToFhir(turtle);
    expect(result.resources).toHaveLength(0);
    expect(result.warnings.some(w => w.includes('Unknown Cascade RDF type'))).toBe(true);
  });

  it('should reject unsupported conversion direction', async () => {
    const result = await convert('<xml/>', 'c-cda', 'turtle');
    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.includes('C-CDA'))).toBe(true);
  });

  it('should handle Condition with missing optional fields', () => {
    const minimal = {
      resourceType: 'Condition',
      code: { text: 'Unknown' },
    };
    const result = convertCondition(minimal);
    expect(result.cascadeType).toBe('health:ConditionRecord');
    expect(findQuadValue(result._quads, NS.health + 'conditionName')).toBe('Unknown');
    // No onset, no codes, no notes -- should not throw
    expect(result.warnings).toEqual([]);
  });

  it('should handle medication with stopped status', () => {
    const stopped = {
      resourceType: 'MedicationStatement',
      status: 'stopped',
      medicationCodeableConcept: { text: 'OldMed' },
    };
    const result = convertMedicationStatement(stopped);
    expect(findQuadValue(result._quads, NS.health + 'isActive')).toBe('false');
  });

  it('should include common triples on every converted resource', () => {
    const result = convertCondition({ resourceType: 'Condition', code: { text: 'Test' } });
    const quads = result._quads;
    expect(findQuadValue(quads, NS.cascade + 'dataProvenance')).toBe(NS.cascade + 'ClinicalGenerated');
    expect(findQuadValue(quads, NS.cascade + 'schemaVersion')).toBe('1.3');
  });
});
