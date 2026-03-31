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
  convertProcedure,
  convertClinicalDocument,
  convertEncounter,
  convertLaboratoryReport,
  convertMedicationAdministration,
  convertDevice,
  convertImagingStudy,
} from '../src/lib/fhir-converter/converters-clinical.js';
import {
  convertPatient,
  convertImmunization,
  convertCoverage,
} from '../src/lib/fhir-converter/converters-demographics.js';
import {
  convertClaim,
  convertExplanationOfBenefit,
} from '../src/lib/fhir-converter/converters-clinical-admin.js';
import {
  convertFhirPassthrough,
  EXCLUDED_TYPES,
  EXCLUDED_REASONS,
} from '../src/lib/fhir-converter/converters-passthrough.js';
import {
  buildImportManifest,
} from '../src/lib/fhir-converter/import-manifest.js';
import {
  NS,
  ensureDateTimeWithTz,
  extractCodings,
  codeableConceptText,
  mintSubjectUri,
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

    it('should serialize component answers for panel observations (e.g., PRAPARE survey)', () => {
      const obs = {
        resourceType: 'Observation',
        id: 'prapare-1',
        code: { text: 'PRAPARE' },
        category: [{ coding: [{ code: 'survey' }] }],
        effectiveDateTime: '2024-06-01T10:00:00Z',
        component: [
          {
            code: { coding: [{ code: '76501-6', display: 'Afraid of partner', system: 'http://loinc.org' }] },
            valueCodeableConcept: { coding: [{ code: 'LA32-8', display: 'No' }], text: 'No' },
          },
          {
            code: { text: 'Are you a refugee' },
            valueCodeableConcept: { text: 'No' },
          },
          {
            code: { text: 'Stress level' },
            valueQuantity: { value: 3, unit: '/10' },
          },
        ],
      };
      const result = convertObservationLab(obs);
      expect(result.warnings).not.toContain('No result value found in Observation resource');
      const val = findQuadValue(result._quads, NS.health + 'resultValue');
      expect(val).toContain('Afraid of partner: No');
      expect(val).toContain('Are you a refugee: No');
      expect(val).toContain('Stress level: 3 /10');
    });

    it('should still warn when component array has no extractable answers', () => {
      const obs = {
        resourceType: 'Observation',
        code: { text: 'Empty panel' },
        component: [{ code: { text: 'Q1' } }], // no value fields on component
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

    it('should extract systolic and diastolic from BP panel component observation', () => {
      const bpPanel = {
        resourceType: 'Observation',
        id: 'bp-panel-1',
        code: {
          coding: [{ system: 'http://loinc.org', code: '55284-4', display: 'Blood pressure panel' }],
          text: 'Blood pressure panel with all children optional',
        },
        category: [{ coding: [{ code: 'vital-signs' }] }],
        effectiveDateTime: '2024-01-15T10:30:00Z',
        component: [
          {
            code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic Blood Pressure' }] },
            valueQuantity: { value: 131, unit: 'mm[Hg]' },
          },
          {
            code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic Blood Pressure' }] },
            valueQuantity: { value: 70, unit: 'mm[Hg]' },
          },
        ],
      };
      const result = convertObservationVital(bpPanel);
      expect(result.warnings).not.toContain('No valueQuantity found in vital sign Observation');
      const quads = result._quads;
      expect(findQuadValue(quads, NS.clinical + 'bloodPressureSystolicValue')).toBe('131');
      expect(findQuadValue(quads, NS.clinical + 'bloodPressureSystolicUnit')).toBe('mm[Hg]');
      expect(findQuadValue(quads, NS.clinical + 'bloodPressureDiastolicValue')).toBe('70');
      expect(findQuadValue(quads, NS.clinical + 'bloodPressureDiastolicUnit')).toBe('mm[Hg]');
    });

    it('should still warn when component children have no known LOINC codes', () => {
      const obs = {
        resourceType: 'Observation',
        id: 'panel-unknown-1',
        code: { coding: [{ system: 'http://loinc.org', code: '99999-9', display: 'Unknown panel' }] },
        category: [{ coding: [{ code: 'vital-signs' }] }],
        component: [
          {
            code: { coding: [{ system: 'http://loinc.org', code: '99998-8' }] },
            valueQuantity: { value: 5, unit: 'unit' },
          },
        ],
      };
      const result = convertObservationVital(obs);
      expect(result.warnings).toContain('No valueQuantity found in vital sign Observation');
    });

    it('should fall back to display name slug silently for unmapped vital LOINC codes', () => {
      const obs = {
        resourceType: 'Observation',
        id: 'novel-vital-1',
        code: {
          coding: [{ system: 'http://loinc.org', code: '99997-7', display: 'Novel Vital Sign' }],
          text: 'Novel Vital Sign',
        },
        category: [{ coding: [{ code: 'vital-signs' }] }],
        valueQuantity: { value: 42, unit: 'units' },
        effectiveDateTime: '2024-01-15T10:30:00Z',
      };
      const result = convertObservationVital(obs);
      // Data preserved, no warning emitted
      expect(result.warnings).toHaveLength(0);
      expect(findQuadValue(result._quads, NS.clinical + 'vitalType')).toBe('novel_vital_sign');
      expect(findQuadValue(result._quads, NS.clinical + 'vitalTypeName')).toBe('Novel Vital Sign');
      expect(findQuadValue(result._quads, NS.clinical + 'value')).toBe('42');
    });

    it('should map newly added vital LOINC codes (pain, IOP, pediatric)', () => {
      const painObs = {
        resourceType: 'Observation',
        id: 'pain-1',
        code: { coding: [{ system: 'http://loinc.org', code: '72514-3' }] },
        category: [{ coding: [{ code: 'vital-signs' }] }],
        valueQuantity: { value: 4, unit: '{score}' },
        effectiveDateTime: '2024-01-15T10:30:00Z',
      };
      const painResult = convertObservationVital(painObs);
      expect(painResult.warnings).toHaveLength(0);
      expect(findQuadValue(painResult._quads, NS.clinical + 'vitalType')).toBe('painSeverity');

      const iopObs = {
        resourceType: 'Observation',
        id: 'iop-1',
        code: { coding: [{ system: 'http://loinc.org', code: '79893-4' }] },
        category: [{ coding: [{ code: 'vital-signs' }] }],
        valueQuantity: { value: 16, unit: 'mm[Hg]' },
        effectiveDateTime: '2024-01-15T10:30:00Z',
      };
      const iopResult = convertObservationVital(iopObs);
      expect(iopResult.warnings).toHaveLength(0);
      expect(findQuadValue(iopResult._quads, NS.clinical + 'vitalType')).toBe('intraocularPressureRightEye');
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

    it('should detect vital sign by category text fallback', () => {
      const obs = {
        resourceType: 'Observation',
        category: [{ text: 'Vital Signs' }], // text only, no structured coding
        code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
        valueQuantity: { value: 72, unit: 'bpm' },
      };
      expect(isVitalSignObservation(obs)).toBe(true);
    });

    it('should detect vital sign via https LOINC system URL variant', () => {
      const obs = {
        resourceType: 'Observation',
        code: { coding: [{ system: 'https://loinc.org', code: '8867-4' }] },
        valueQuantity: { value: 72, unit: 'bpm' },
      };
      expect(isVitalSignObservation(obs)).toBe(true);
    });

    it('should detect vital sign via LOINC OID system URL (C-CDA origin)', () => {
      const obs = {
        resourceType: 'Observation',
        code: { coding: [{ system: 'urn:oid:2.16.840.1.113883.6.1', code: '8867-4' }] },
        valueQuantity: { value: 72, unit: 'bpm' },
      };
      expect(isVitalSignObservation(obs)).toBe(true);
    });

    it('should emit correct vitalType when LOINC system is https variant', () => {
      const obs = {
        resourceType: 'Observation',
        status: 'final',
        code: { coding: [{ system: 'https://loinc.org', code: '8867-4', display: 'Heart rate' }] },
        valueQuantity: { value: 72, unit: 'bpm' },
      };
      const result = convertObservationVital(obs);
      expect(result.warnings).toHaveLength(0);
      expect(findQuadValue(result._quads, NS.clinical + 'vitalType')).toBe('heartRate');
    });
  });

  describe('MedicationStatement -> clinical:Medication', () => {
    it('should convert MedicationStatement with full details', () => {
      const result = convertMedicationStatement(sampleMedicationStatement);
      expect(result.cascadeType).toBe('clinical:Medication');

      const quads = result._quads;
      expect(findQuadValue(quads, NS.clinical + 'drugName')).toBe('Metformin 500mg');
      expect(findQuadValue(quads, NS.clinical + 'status')).toBe('active');
      expect(findQuadValue(quads, NS.clinical + 'dosage')).toBe('500mg twice daily');
      expect(findQuadValue(quads, NS.clinical + 'route')).toBe('oral');
      expect(findQuadValue(quads, NS.clinical + 'frequency')).toBe('2 times daily');
      expect(findQuadValue(quads, NS.clinical + 'sourceFhirResourceType')).toBe('MedicationStatement');
      expect(findQuadValue(quads, NS.clinical + 'clinicalIntent')).toBe('reportedUse');
    });

    it('should map RxNorm drug codes', () => {
      const result = convertMedicationStatement(sampleMedicationStatement);
      const quads = result._quads;
      const rxCodes = findAllQuadValues(quads, NS.clinical + 'rxNormCode');
      expect(rxCodes).toContain(NS.rxnorm + '1049502');
    });

    it('should include notes', () => {
      const result = convertMedicationStatement(sampleMedicationStatement);
      expect(findQuadValue(result._quads, NS.health + 'notes')).toBe('Take with meals');
    });
  });

  describe('MedicationRequest -> clinical:Medication', () => {
    it('should convert MedicationRequest with prescribed intent', () => {
      const result = convertMedicationStatement(sampleMedicationRequest);
      expect(result.cascadeType).toBe('clinical:Medication');

      const quads = result._quads;
      expect(findQuadValue(quads, NS.clinical + 'drugName')).toBe('Lisinopril 10mg');
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
  describe('clinical:Medication -> MedicationStatement', () => {
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
    expect(result.output).toContain('clinical:Medication');
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
    // Practitioner is now preserved as a Layer 1 passthrough, so resourceCount is 2
    expect(result.resourceCount).toBe(2);
    // Passthrough warning is emitted for Practitioner
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
  it('should return passthrough result for unknown resource types', () => {
    const result = convertFhirResourceToQuads({ resourceType: 'Practitioner' });
    // Unknown types are now preserved as Layer 1 passthrough, not null
    expect(result).not.toBeNull();
    expect(result?.cascadeType).toBe('fhir:Practitioner');
    expect(result?.warnings.some(w => w.includes('Layer 1 passthrough'))).toBe(true);
  });

  it('should return null for resources without resourceType', () => {
    const result = convertFhirResourceToQuads({ id: 'something' });
    expect(result).toBeNull();
  });

  it('should handle empty/null input gracefully via convertFhirToCascade', async () => {
    // Encounter is now a fully mapped type — use a truly unsupported resourceType
    const result = await convertFhirToCascade({ resourceType: undefined });
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

  it('should fail gracefully for invalid C-CDA XML', async () => {
    // Now that C-CDA is supported, an empty/invalid doc returns no output (not an "unsupported" error)
    const result = await convert('<xml/>', 'c-cda', 'turtle');
    expect(result.success).toBe(false);
    expect(result.resourceCount).toBe(0);
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
    expect(findQuadValue(result._quads, NS.clinical + 'status')).toBe('stopped');
  });

  it('should include common triples on every converted resource', () => {
    const result = convertCondition({ resourceType: 'Condition', code: { text: 'Test' } });
    const quads = result._quads;
    expect(findQuadValue(quads, NS.cascade + 'dataProvenance')).toBe(NS.cascade + 'ClinicalGenerated');
    expect(findQuadValue(quads, NS.cascade + 'schemaVersion')).toBe('1.3');
  });
});

// =============================================================================
// Tests: mintSubjectUri (Phase A)
// =============================================================================

describe('mintSubjectUri', () => {
  it('should return urn:uuid: prefixed URI', () => {
    const result = mintSubjectUri({ resourceType: 'Patient', id: 'test-id' });
    expect(result).toMatch(/^urn:uuid:/);
  });

  it('should return deterministic URI for valid UUID v4 id', () => {
    const resource = { resourceType: 'Patient', id: '550e8400-e29b-41d4-a716-446655440000' };
    const result1 = mintSubjectUri(resource);
    const result2 = mintSubjectUri(resource);
    expect(result1).toBe(result2);
    expect(result1).toBe('urn:uuid:550e8400-e29b-41d4-a716-446655440000');
  });

  it('should return deterministic URI for non-UUID id (hash-based)', () => {
    const resource = { resourceType: 'Condition', id: 'cond-abc-123' };
    const result1 = mintSubjectUri(resource);
    const result2 = mintSubjectUri(resource);
    expect(result1).toBe(result2);
    expect(result1).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  });

  it('should return different URIs for different resourceType+id combinations', () => {
    const r1 = mintSubjectUri({ resourceType: 'Patient', id: 'abc' });
    const r2 = mintSubjectUri({ resourceType: 'Condition', id: 'abc' });
    expect(r1).not.toBe(r2);
  });

  it('should return random UUID when no id present', () => {
    const r1 = mintSubjectUri({ resourceType: 'Patient' });
    const r2 = mintSubjectUri({ resourceType: 'Patient' });
    expect(r1).toMatch(/^urn:uuid:/);
    // Two calls with no id should produce different URIs
    expect(r1).not.toBe(r2);
  });
});

// =============================================================================
// Tests: New FHIR -> Cascade converters (Phase B)
// =============================================================================

const sampleProcedure = {
  resourceType: 'Procedure',
  id: 'proc-1',
  status: 'completed',
  code: {
    coding: [
      { system: 'http://snomed.info/sct', code: '80146002', display: 'Appendectomy' },
    ],
    text: 'Appendectomy',
  },
  performedDateTime: '2023-06-15T10:00:00Z',
};

const sampleDocumentReference = {
  resourceType: 'DocumentReference',
  id: 'doc-1',
  status: 'current',
  type: {
    coding: [{ display: 'Discharge Summary' }],
    text: 'Discharge Summary',
  },
  date: '2023-06-16T14:00:00Z',
  content: [
    {
      attachment: {
        contentType: 'application/pdf',
        url: 'https://example.org/docs/discharge-1.pdf',
        title: 'Discharge Summary June 2023',
      },
    },
  ],
};

const sampleEncounter = {
  resourceType: 'Encounter',
  id: 'enc-1',
  status: 'finished',
  class: { code: 'AMB', system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode' },
  type: [
    {
      coding: [{ system: 'http://snomed.info/sct', code: '11429006', display: 'Consultation' }],
      text: 'Consultation',
    },
  ],
  period: {
    start: '2023-06-15T09:00:00Z',
    end: '2023-06-15T10:30:00Z',
  },
  participant: [
    { individual: { display: 'Dr. Jane Smith' } },
  ],
  serviceProvider: { display: 'General Hospital' },
};

const sampleDiagnosticReport = {
  resourceType: 'DiagnosticReport',
  id: 'dr-1',
  status: 'final',
  category: [{ coding: [{ code: 'LAB' }] }],
  code: {
    coding: [{ system: 'http://loinc.org', code: '58410-2', display: 'Complete Blood Count' }],
    text: 'Complete Blood Count',
  },
  effectiveDateTime: '2023-06-15T08:00:00Z',
  performer: [{ display: 'Quest Diagnostics' }],
  result: [
    { reference: 'Observation/obs-wbc-1' },
    { reference: 'Observation/obs-rbc-1' },
  ],
};

const sampleMedicationAdmin = {
  resourceType: 'MedicationAdministration',
  id: 'medadmin-1',
  status: 'completed',
  medicationCodeableConcept: {
    coding: [{ display: 'Cefazolin 1g IV' }],
    text: 'Cefazolin 1g IV',
  },
  effectiveDateTime: '2023-06-15T07:30:00Z',
  dosage: {
    dose: { value: 1, unit: 'g' },
    route: { coding: [{ display: 'Intravenous' }], text: 'Intravenous' },
  },
};

const sampleDevice = {
  resourceType: 'Device',
  id: 'dev-1',
  status: 'active',
  type: {
    coding: [{ display: 'Cardiac Pacemaker' }],
    text: 'Cardiac Pacemaker',
  },
  manufacturer: 'Medtronic',
  udiCarrier: [{ deviceIdentifier: '00844588003288' }],
  manufactureDate: '2022-01-15T00:00:00Z',
};

const sampleImagingStudy = {
  resourceType: 'ImagingStudy',
  id: 'img-1',
  status: 'available',
  started: '2023-06-14T11:00:00Z',
  description: 'CT Abdomen with contrast',
  numberOfSeries: 3,
  series: [
    { modality: { code: 'CT' } },
  ],
  identifier: [{ value: '2.16.840.1.113883.19.5.99999.1' }],
};

const sampleClaim = {
  resourceType: 'Claim',
  id: 'claim-1',
  status: 'active',
  type: { coding: [{ code: 'professional' }] },
  created: '2023-06-20T00:00:00Z',
  provider: { display: 'General Hospital' },
  total: { value: 1250.00 },
  diagnosis: [
    {
      sequence: 1,
      diagnosisCodeableConcept: {
        coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'K37', display: 'Appendicitis' }],
      },
    },
  ],
};

const sampleEOB = {
  resourceType: 'ExplanationOfBenefit',
  id: 'eob-1',
  status: 'active',
  outcome: 'complete',
  created: '2023-06-25T00:00:00Z',
  claim: { reference: 'Claim/claim-1' },
  total: [
    { category: { coding: [{ code: 'submitted' }] }, amount: { value: 1250.00 } },
    { category: { coding: [{ code: 'benefit' }] }, amount: { value: 800.00 } },
    { category: { coding: [{ code: 'patientpay' }] }, amount: { value: 450.00 } },
  ],
};

describe('Procedure -> clinical:Procedure', () => {
  it('should convert Procedure to clinical:Procedure', () => {
    const result = convertProcedure(sampleProcedure);
    expect(result.cascadeType).toBe('clinical:Procedure');
    expect(result.resourceType).toBe('Procedure');

    const quads = result._quads;
    expect(findQuadValue(quads, NS.rdf + 'type')).toBe(NS.clinical + 'Procedure');
    expect(findQuadValue(quads, NS.clinical + 'procedureName')).toBe('Appendectomy');
    expect(findQuadValue(quads, NS.clinical + 'procedureStatus')).toBe('completed');
    expect(findQuadValue(quads, NS.clinical + 'sourceRecordId')).toBe('proc-1');
  });

  it('should extract SNOMED code', () => {
    const result = convertProcedure(sampleProcedure);
    const snomedCodes = findAllQuadValues(result._quads, NS.clinical + 'procedureSnomedCode');
    expect(snomedCodes).toContain(NS.sct + '80146002');
  });

  it('should extract performedDate', () => {
    const result = convertProcedure(sampleProcedure);
    expect(findQuadValue(result._quads, NS.clinical + 'performedDate')).toBeTruthy();
  });

  it('should be annotated FullyMapped', () => {
    const result = convertProcedure(sampleProcedure);
    expect(findQuadValue(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(NS.cascade + 'FullyMapped');
  });

  it('should round-trip Procedure', async () => {
    const fhirResult = await convertFhirToCascade(sampleProcedure);
    expect(fhirResult.turtle).toBeTruthy();

    const reverseResult = await convertCascadeToFhir(fhirResult.turtle);
    expect(reverseResult.resources).toHaveLength(1);
    const fhir = reverseResult.resources[0];
    expect(fhir.resourceType).toBe('Procedure');
    expect(fhir.code.text).toBe('Appendectomy');
    expect(fhir.id).toBe('proc-1');
  });
});

describe('DocumentReference -> clinical:ClinicalDocument', () => {
  it('should convert DocumentReference to clinical:ClinicalDocument', () => {
    const result = convertClinicalDocument(sampleDocumentReference);
    expect(result.cascadeType).toBe('clinical:ClinicalDocument');

    const quads = result._quads;
    expect(findQuadValue(quads, NS.clinical + 'documentType')).toBe('Discharge Summary');
    expect(findQuadValue(quads, NS.clinical + 'contentType')).toBe('application/pdf');
    expect(findQuadValue(quads, NS.clinical + 'sourceRecordId')).toBe('doc-1');
  });

  it('should be annotated FullyMapped', () => {
    const result = convertClinicalDocument(sampleDocumentReference);
    expect(findQuadValue(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(NS.cascade + 'FullyMapped');
  });
});

describe('Encounter -> clinical:Encounter', () => {
  it('should convert Encounter to clinical:Encounter', () => {
    const result = convertEncounter(sampleEncounter);
    expect(result.cascadeType).toBe('clinical:Encounter');

    const quads = result._quads;
    expect(findQuadValue(quads, NS.rdf + 'type')).toBe(NS.clinical + 'Encounter');
    expect(findQuadValue(quads, NS.clinical + 'encounterClass')).toBe('AMB');
    expect(findQuadValue(quads, NS.clinical + 'encounterStatus')).toBe('finished');
    expect(findQuadValue(quads, NS.clinical + 'encounterType')).toBe('Consultation');
    expect(findQuadValue(quads, NS.clinical + 'providerName')).toBe('Dr. Jane Smith');
    expect(findQuadValue(quads, NS.clinical + 'facilityName')).toBe('General Hospital');
    expect(findQuadValue(quads, NS.clinical + 'sourceRecordId')).toBe('enc-1');
  });

  it('should extract period start and end', () => {
    const result = convertEncounter(sampleEncounter);
    const quads = result._quads;
    expect(findQuadValue(quads, NS.clinical + 'encounterStart')).toBeTruthy();
    expect(findQuadValue(quads, NS.clinical + 'encounterEnd')).toBeTruthy();
  });

  it('should extract SNOMED encounter code', () => {
    const result = convertEncounter(sampleEncounter);
    const snomedCodes = findAllQuadValues(result._quads, NS.clinical + 'snomedCode');
    expect(snomedCodes).toContain(NS.sct + '11429006');
  });

  it('should be annotated FullyMapped', () => {
    const result = convertEncounter(sampleEncounter);
    expect(findQuadValue(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(NS.cascade + 'FullyMapped');
  });

  it('should round-trip Encounter', async () => {
    const fhirResult = await convertFhirToCascade(sampleEncounter);
    const reverseResult = await convertCascadeToFhir(fhirResult.turtle);

    expect(reverseResult.resources).toHaveLength(1);
    const fhir = reverseResult.resources[0];
    expect(fhir.resourceType).toBe('Encounter');
    expect(fhir.status).toBe('finished');
    expect(fhir.id).toBe('enc-1');
  });
});

describe('DiagnosticReport -> clinical:LaboratoryReport', () => {
  it('should convert DiagnosticReport to clinical:LaboratoryReport', () => {
    const result = convertLaboratoryReport(sampleDiagnosticReport);
    expect(result.cascadeType).toBe('clinical:LaboratoryReport');

    const quads = result._quads;
    expect(findQuadValue(quads, NS.rdf + 'type')).toBe(NS.clinical + 'LaboratoryReport');
    expect(findQuadValue(quads, NS.clinical + 'panelName')).toBe('Complete Blood Count');
    expect(findQuadValue(quads, NS.clinical + 'reportCategory')).toBe('LAB');
    expect(findQuadValue(quads, NS.clinical + 'providerName')).toBe('Quest Diagnostics');
    expect(findQuadValue(quads, NS.clinical + 'sourceRecordId')).toBe('dr-1');
  });

  it('should link hasLabResult to constituent observations', () => {
    const result = convertLaboratoryReport(sampleDiagnosticReport);
    const labResults = findAllQuadValues(result._quads, NS.clinical + 'hasLabResult');
    expect(labResults).toHaveLength(2);
    expect(labResults).toContain('urn:uuid:obs-wbc-1');
    expect(labResults).toContain('urn:uuid:obs-rbc-1');
  });

  it('should extract LOINC code', () => {
    const result = convertLaboratoryReport(sampleDiagnosticReport);
    const loincCodes = findAllQuadValues(result._quads, NS.clinical + 'loincCode');
    expect(loincCodes).toContain(NS.loinc + '58410-2');
  });

  it('should be annotated FullyMapped', () => {
    const result = convertLaboratoryReport(sampleDiagnosticReport);
    expect(findQuadValue(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(NS.cascade + 'FullyMapped');
  });
});

describe('MedicationAdministration -> clinical:MedicationAdministration', () => {
  it('should convert MedicationAdministration', () => {
    const result = convertMedicationAdministration(sampleMedicationAdmin);
    expect(result.cascadeType).toBe('clinical:MedicationAdministration');

    const quads = result._quads;
    expect(findQuadValue(quads, NS.health + 'medicationName')).toBe('Cefazolin 1g IV');
    expect(findQuadValue(quads, NS.clinical + 'administrationStatus')).toBe('completed');
    expect(findQuadValue(quads, NS.clinical + 'administeredRoute')).toBe('Intravenous');
    expect(findQuadValue(quads, NS.clinical + 'sourceRecordId')).toBe('medadmin-1');
  });

  it('should be annotated FullyMapped', () => {
    const result = convertMedicationAdministration(sampleMedicationAdmin);
    expect(findQuadValue(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(NS.cascade + 'FullyMapped');
  });

  it('should round-trip MedicationAdministration', async () => {
    const fhirResult = await convertFhirToCascade(sampleMedicationAdmin);
    const reverseResult = await convertCascadeToFhir(fhirResult.turtle);

    expect(reverseResult.resources).toHaveLength(1);
    const fhir = reverseResult.resources[0];
    expect(fhir.resourceType).toBe('MedicationAdministration');
    expect(fhir.status).toBe('completed');
    expect(fhir.id).toBe('medadmin-1');
  });
});

describe('Device -> clinical:ImplantedDevice', () => {
  it('should convert Device to clinical:ImplantedDevice', () => {
    const result = convertDevice(sampleDevice);
    expect(result.cascadeType).toBe('clinical:ImplantedDevice');

    const quads = result._quads;
    expect(findQuadValue(quads, NS.rdf + 'type')).toBe(NS.clinical + 'ImplantedDevice');
    expect(findQuadValue(quads, NS.clinical + 'deviceType')).toBe('Cardiac Pacemaker');
    expect(findQuadValue(quads, NS.clinical + 'deviceManufacturer')).toBe('Medtronic');
    expect(findQuadValue(quads, NS.clinical + 'udiCarrier')).toBe('00844588003288');
    expect(findQuadValue(quads, NS.clinical + 'deviceStatus')).toBe('active');
    expect(findQuadValue(quads, NS.clinical + 'sourceRecordId')).toBe('dev-1');
  });

  it('should be annotated FullyMapped', () => {
    const result = convertDevice(sampleDevice);
    expect(findQuadValue(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(NS.cascade + 'FullyMapped');
  });

  it('should round-trip Device', async () => {
    const fhirResult = await convertFhirToCascade(sampleDevice);
    const reverseResult = await convertCascadeToFhir(fhirResult.turtle);

    expect(reverseResult.resources).toHaveLength(1);
    const fhir = reverseResult.resources[0];
    expect(fhir.resourceType).toBe('Device');
    expect(fhir.type.text).toBe('Cardiac Pacemaker');
    expect(fhir.id).toBe('dev-1');
  });
});

describe('ImagingStudy -> clinical:ImagingStudy', () => {
  it('should convert ImagingStudy', () => {
    const result = convertImagingStudy(sampleImagingStudy);
    expect(result.cascadeType).toBe('clinical:ImagingStudy');

    const quads = result._quads;
    expect(findQuadValue(quads, NS.rdf + 'type')).toBe(NS.clinical + 'ImagingStudy');
    expect(findQuadValue(quads, NS.clinical + 'imagingModality')).toBe('CT');
    expect(findQuadValue(quads, NS.clinical + 'studyDescription')).toBe('CT Abdomen with contrast');
    expect(findQuadValue(quads, NS.clinical + 'dicomStudyUid')).toBe('2.16.840.1.113883.19.5.99999.1');
    expect(findQuadValue(quads, NS.clinical + 'sourceRecordId')).toBe('img-1');
  });

  it('should be annotated FullyMapped', () => {
    const result = convertImagingStudy(sampleImagingStudy);
    expect(findQuadValue(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(NS.cascade + 'FullyMapped');
  });
});

describe('Claim -> coverage:ClaimRecord', () => {
  it('should convert Claim to coverage:ClaimRecord', () => {
    const result = convertClaim(sampleClaim);
    expect(result.cascadeType).toBe('coverage:ClaimRecord');

    const quads = result._quads;
    expect(findQuadValue(quads, NS.rdf + 'type')).toBe(NS.coverage + 'ClaimRecord');
    expect(findQuadValue(quads, NS.coverage + 'claimStatus')).toBe('active');
    expect(findQuadValue(quads, NS.coverage + 'claimType')).toBe('professional');
    expect(findQuadValue(quads, NS.coverage + 'billingProvider')).toBe('General Hospital');
    expect(findQuadValue(quads, NS.coverage + 'sourceRecordId')).toBe('claim-1');
  });

  it('should extract diagnosis codes', () => {
    const result = convertClaim(sampleClaim);
    const diagnoses = findAllQuadValues(result._quads, NS.coverage + 'hasDiagnosis');
    expect(diagnoses).toContain('K37');
  });

  it('should be annotated FullyMapped', () => {
    const result = convertClaim(sampleClaim);
    expect(findQuadValue(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(NS.cascade + 'FullyMapped');
  });

  it('should round-trip Claim', async () => {
    const fhirResult = await convertFhirToCascade(sampleClaim);
    const reverseResult = await convertCascadeToFhir(fhirResult.turtle);

    expect(reverseResult.resources).toHaveLength(1);
    const fhir = reverseResult.resources[0];
    expect(fhir.resourceType).toBe('Claim');
    expect(fhir.status).toBe('active');
    expect(fhir.id).toBe('claim-1');
  });
});

describe('ExplanationOfBenefit -> coverage:BenefitStatement', () => {
  it('should convert ExplanationOfBenefit to coverage:BenefitStatement', () => {
    const result = convertExplanationOfBenefit(sampleEOB);
    expect(result.cascadeType).toBe('coverage:BenefitStatement');

    const quads = result._quads;
    expect(findQuadValue(quads, NS.rdf + 'type')).toBe(NS.coverage + 'BenefitStatement');
    expect(findQuadValue(quads, NS.coverage + 'adjudicationStatus')).toBe('active');
    expect(findQuadValue(quads, NS.coverage + 'outcomeCode')).toBe('complete');
    expect(findQuadValue(quads, NS.coverage + 'sourceRecordId')).toBe('eob-1');
  });

  it('should extract totals', () => {
    const result = convertExplanationOfBenefit(sampleEOB);
    const quads = result._quads;
    expect(findQuadValue(quads, NS.coverage + 'totalBilled')).toBe('1250');
    expect(findQuadValue(quads, NS.coverage + 'totalPaid')).toBe('800');
    expect(findQuadValue(quads, NS.coverage + 'patientResponsibility')).toBe('450');
  });

  it('should link relatedClaim', () => {
    const result = convertExplanationOfBenefit(sampleEOB);
    const relatedClaim = findQuadValue(result._quads, NS.coverage + 'relatedClaim');
    expect(relatedClaim).toBeTruthy();
    expect(relatedClaim).toContain('claim-1');
  });

  it('should be annotated FullyMapped', () => {
    const result = convertExplanationOfBenefit(sampleEOB);
    expect(findQuadValue(result._quads, NS.cascade + 'layerPromotionStatus')).toBe(NS.cascade + 'FullyMapped');
  });

  it('should round-trip ExplanationOfBenefit', async () => {
    const fhirResult = await convertFhirToCascade(sampleEOB);
    const reverseResult = await convertCascadeToFhir(fhirResult.turtle);

    expect(reverseResult.resources).toHaveLength(1);
    const fhir = reverseResult.resources[0];
    expect(fhir.resourceType).toBe('ExplanationOfBenefit');
    expect(fhir.id).toBe('eob-1');
  });
});

// =============================================================================
// Tests: Layer 1 passthrough (Phase B4)
// =============================================================================

describe('Layer 1 FHIR passthrough', () => {
  const sampleUnknownResource = {
    resourceType: 'Practitioner',
    id: 'prac-1',
    name: [{ text: 'Dr. Unknown' }],
    date: '2023-01-01',
  };

  it('should preserve unknown resource types as passthrough', () => {
    const result = convertFhirPassthrough(sampleUnknownResource);
    expect(result.cascadeType).toBe('fhir:Practitioner');
    expect(result.resourceType).toBe('Practitioner');

    const quads = result._quads;
    expect(findQuadValue(quads, NS.cascade + 'layerPromotionStatus')).toBe(NS.cascade + 'PendingLayerTwoPromotion');
    expect(findQuadValue(quads, NS.cascade + 'fhirResourceType')).toBe('Practitioner');
  });

  it('should embed original FHIR JSON in cascade:fhirJson', () => {
    const result = convertFhirPassthrough(sampleUnknownResource);
    const fhirJson = findQuadValue(result._quads, NS.cascade + 'fhirJson');
    expect(fhirJson).toBeTruthy();
    const parsed = JSON.parse(fhirJson!);
    expect(parsed.resourceType).toBe('Practitioner');
    expect(parsed.id).toBe('prac-1');
  });

  it('should emit a passthrough warning', () => {
    const result = convertFhirPassthrough(sampleUnknownResource);
    expect(result.warnings.some(w => w.includes('Layer 1 passthrough'))).toBe(true);
  });

  it('should produce a round-trip-identical FHIR resource via cascade-to-fhir', async () => {
    const fhirResult = await convertFhirToCascade(sampleUnknownResource);
    expect(fhirResult.turtle).toBeTruthy();
    expect(fhirResult.cascadeType).toBe('fhir:Practitioner');

    const reverseResult = await convertCascadeToFhir(fhirResult.turtle);
    expect(reverseResult.resources).toHaveLength(1);
    const restored = reverseResult.resources[0];
    expect(restored.resourceType).toBe('Practitioner');
    expect(restored.id).toBe('prac-1');
  });

  it('should have EXCLUDED_TYPES for intentionally excluded resources', () => {
    expect(EXCLUDED_TYPES.has('SupplyDelivery')).toBe(true);
    expect(EXCLUDED_TYPES.has('CareTeam')).toBe(true);
    expect(EXCLUDED_TYPES.has('CarePlan')).toBe(true);
    expect(EXCLUDED_TYPES.has('Provenance')).toBe(true);
    expect(EXCLUDED_TYPES.has('Medication')).toBe(true);
  });

  it('should have documented reasons for all excluded types', () => {
    for (const type of EXCLUDED_TYPES) {
      expect(EXCLUDED_REASONS[type]).toBeTruthy();
    }
  });

  it('should skip excluded types in batch conversion and track skippedCount', async () => {
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        { resource: sampleClaim },
        { resource: { resourceType: 'SupplyDelivery', id: 'sd-1' } },
      ],
    };
    const result = await convert(JSON.stringify(bundle), 'fhir', 'turtle');
    expect(result.success).toBe(true);
    expect(result.resourceCount).toBe(1); // Only Claim converted
    expect(result.skippedCount).toBe(1);  // SupplyDelivery counted in skippedCount, not as a warning
  });
});

// =============================================================================
// Tests: Import manifest (Phase C)
// =============================================================================

describe('buildImportManifest', () => {
  it('should build a manifest from BatchConversionResult', () => {
    const batchResult = {
      success: true,
      output: '',
      format: 'turtle' as const,
      resourceCount: 3,
      warnings: ['Claim preserved as Layer 1 passthrough — no Layer 2 mapping yet'],
      errors: [],
      results: [
        { turtle: '', warnings: [], resourceType: 'Condition', cascadeType: 'health:ConditionRecord' },
        { turtle: '', warnings: [], resourceType: 'Procedure', cascadeType: 'clinical:Procedure' },
        { turtle: '', warnings: ['Practitioner preserved as Layer 1 passthrough — no Layer 2 mapping yet'], resourceType: 'Practitioner', cascadeType: 'fhir:Practitioner' },
      ],
    };
    const manifest = buildImportManifest(batchResult, '/path/to/patient.json', 'primary-care', {});

    expect(manifest.sourceFile).toBe('/path/to/patient.json');
    expect(manifest.sourceSystem).toBe('primary-care');
    expect(manifest.summary.total).toBe(3);
    expect(manifest.summary.fullyMapped).toBe(2);
    expect(manifest.summary.passthrough).toBe(1);
    expect(manifest.summary.excluded).toBe(0);
    expect(manifest.byType['Condition'].strategy).toBe('mapped');
    expect(manifest.byType['Procedure'].strategy).toBe('mapped');
    expect(manifest.byType['Practitioner'].strategy).toBe('passthrough');
  });

  it('should include excluded types in manifest', () => {
    const batchResult = {
      success: true, output: '', format: 'turtle' as const, resourceCount: 1,
      warnings: [], errors: [],
      results: [{ turtle: '', warnings: [], resourceType: 'Condition', cascadeType: 'health:ConditionRecord' }],
    };
    const manifest = buildImportManifest(batchResult, 'test.json', 'test', { SupplyDelivery: 5 });

    expect(manifest.summary.excluded).toBe(5);
    expect(manifest.summary.total).toBe(6);
    expect(manifest.byType['SupplyDelivery'].strategy).toBe('excluded');
    expect(manifest.byType['SupplyDelivery'].reason).toBeTruthy();
  });

  it('should produce a manifest with convertedAt timestamp', () => {
    const batchResult = {
      success: true, output: '', format: 'turtle' as const, resourceCount: 0,
      warnings: [], errors: [], results: [],
    };
    const manifest = buildImportManifest(batchResult, 'test.json', 'test', {});
    expect(manifest.convertedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// =============================================================================
// Tests: Batch conversion with new types
// =============================================================================

describe('Batch conversion with all new types', () => {
  it('should convert a FHIR bundle with all new Layer 2 types', async () => {
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        { resource: sampleProcedure },
        { resource: sampleEncounter },
        { resource: sampleDiagnosticReport },
        { resource: sampleMedicationAdmin },
        { resource: sampleDevice },
        { resource: sampleClaim },
        { resource: sampleEOB },
      ],
    };

    const result = await convert(JSON.stringify(bundle), 'fhir', 'turtle');
    expect(result.success).toBe(true);
    expect(result.resourceCount).toBe(7);
    expect(result.output).toContain('clinical:Procedure');
    expect(result.output).toContain('clinical:Encounter');
    expect(result.output).toContain('clinical:LaboratoryReport');
    expect(result.output).toContain('clinical:MedicationAdministration');
    expect(result.output).toContain('clinical:ImplantedDevice');
    expect(result.output).toContain('coverage:ClaimRecord');
    expect(result.output).toContain('coverage:BenefitStatement');
  });

  it('should passthrough unknown types with zero silent drops', async () => {
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        { resource: sampleCondition },
        { resource: { resourceType: 'Practitioner', id: 'prac-2', name: [{ text: 'Test' }] } },
        { resource: { resourceType: 'Organization', id: 'org-1', name: 'Test Hospital' } },
      ],
    };

    const result = await convert(JSON.stringify(bundle), 'fhir', 'turtle');
    expect(result.success).toBe(true);
    // All 3 resources should be in results (1 Layer 2, 2 passthrough)
    expect(result.resourceCount).toBe(3);
    // Passthrough resources should be in the output TTL
    expect(result.output).toContain('PendingLayerTwoPromotion');
  });
});
