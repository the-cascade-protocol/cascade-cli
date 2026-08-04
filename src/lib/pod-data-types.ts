/**
 * The registry of a pod's REGISTERED record files.
 *
 * This is the list that answers "is this file part of the record picture?", and
 * that question is load-bearing well beyond display: the read layer weighs a
 * parse failure differently for a registered record file (fatal — the count is
 * unknown, and unknown is not zero) than for any other `.ttl` a pod happens to
 * hold (a warning — a pod also carries notes, analyses, literature and profile
 * resources, and one stray file must not blank the whole record list).
 *
 * It lives in `lib/` rather than beside the pod subcommands so the read layer
 * can consult it without importing a command module, which would make the door
 * depend on the rooms it guards. `commands/pod/helpers.ts` re-exports both
 * symbols, so every existing `from './helpers.js'` import keeps working.
 */

import { CASCADE_NAMESPACES } from './turtle-parser.js';

/**
 * Known data file types and the rdf:type IRIs that identify records in them.
 */
export interface DataTypeInfo {
  label: string;
  rdfTypes: string[];
  directory: 'clinical' | 'wellness';
  filename: string;
  /** If true, type detection uses prefix-matching instead of exact IRI matching */
  isFhirPassthroughBucket?: boolean;
}

export const DATA_TYPES: Record<string, DataTypeInfo> = {
  medications: {
    label: 'Medications',
    rdfTypes: [CASCADE_NAMESPACES.clinical + 'Medication'],
    directory: 'clinical',
    filename: 'medications.ttl',
  },
  conditions: {
    label: 'Conditions',
    rdfTypes: [CASCADE_NAMESPACES.health + 'ConditionRecord'],
    directory: 'clinical',
    filename: 'conditions.ttl',
  },
  allergies: {
    label: 'Allergies',
    rdfTypes: [CASCADE_NAMESPACES.health + 'AllergyRecord'],
    directory: 'clinical',
    filename: 'allergies.ttl',
  },
  'lab-results': {
    label: 'Lab Results',
    rdfTypes: [CASCADE_NAMESPACES.health + 'LabResultRecord'],
    directory: 'clinical',
    filename: 'lab-results.ttl',
  },
  immunizations: {
    label: 'Immunizations',
    rdfTypes: [CASCADE_NAMESPACES.health + 'ImmunizationRecord'],
    directory: 'clinical',
    filename: 'immunizations.ttl',
  },
  'vital-signs': {
    label: 'Vital Signs',
    rdfTypes: [CASCADE_NAMESPACES.clinical + 'VitalSign'],
    directory: 'clinical',
    filename: 'vital-signs.ttl',
  },
  insurance: {
    label: 'Insurance',
    rdfTypes: [CASCADE_NAMESPACES.coverage + 'InsurancePlan'],
    directory: 'clinical',
    filename: 'insurance.ttl',
  },
  'patient-profile': {
    label: 'Patient Profile',
    rdfTypes: [CASCADE_NAMESPACES.cascade + 'PatientProfile'],
    directory: 'clinical',
    filename: 'patient-profile.ttl',
  },
  'heart-rate': {
    label: 'Heart Rate',
    rdfTypes: [CASCADE_NAMESPACES.health + 'DailyVitalReading', CASCADE_NAMESPACES.health + 'HeartRateData'],
    directory: 'wellness',
    filename: 'heart-rate.ttl',
  },
  'blood-pressure': {
    label: 'Blood Pressure',
    rdfTypes: [
      'http://hl7.org/fhir/Observation',
      CASCADE_NAMESPACES.health + 'BloodPressureData',
    ],
    directory: 'wellness',
    filename: 'blood-pressure.ttl',
  },
  activity: {
    label: 'Activity',
    rdfTypes: [CASCADE_NAMESPACES.health + 'DailyActivitySnapshot', CASCADE_NAMESPACES.health + 'ActivityData'],
    directory: 'wellness',
    filename: 'activity.ttl',
  },
  sleep: {
    label: 'Sleep',
    rdfTypes: [CASCADE_NAMESPACES.health + 'DailySleepSnapshot', CASCADE_NAMESPACES.health + 'SleepData'],
    directory: 'wellness',
    filename: 'sleep.ttl',
  },
  supplements: {
    label: 'Supplements',
    rdfTypes: [CASCADE_NAMESPACES.clinical + 'Supplement'],
    directory: 'wellness',
    filename: 'supplements.ttl',
  },
  procedures: {
    label: 'Procedures',
    rdfTypes: [CASCADE_NAMESPACES.clinical + 'Procedure'],
    directory: 'clinical',
    filename: 'procedures.ttl',
  },
  encounters: {
    label: 'Encounters',
    rdfTypes: [CASCADE_NAMESPACES.clinical + 'Encounter'],
    directory: 'clinical',
    filename: 'encounters.ttl',
  },
  documents: {
    label: 'Clinical Documents',
    rdfTypes: [CASCADE_NAMESPACES.clinical + 'ClinicalDocument'],
    directory: 'clinical',
    filename: 'documents.ttl',
  },
  'lab-reports': {
    label: 'Lab Reports',
    rdfTypes: [CASCADE_NAMESPACES.clinical + 'LaboratoryReport'],
    directory: 'clinical',
    filename: 'lab-reports.ttl',
  },
  'medication-administrations': {
    label: 'Medication Administrations',
    rdfTypes: [CASCADE_NAMESPACES.clinical + 'MedicationAdministration'],
    directory: 'clinical',
    filename: 'medication-administrations.ttl',
  },
  devices: {
    label: 'Implanted Devices',
    rdfTypes: [CASCADE_NAMESPACES.clinical + 'ImplantedDevice'],
    directory: 'clinical',
    filename: 'devices.ttl',
  },
  imaging: {
    label: 'Imaging Studies',
    rdfTypes: [CASCADE_NAMESPACES.clinical + 'ImagingStudy'],
    directory: 'clinical',
    filename: 'imaging.ttl',
  },
  claims: {
    label: 'Claims',
    rdfTypes: ['https://ns.cascadeprotocol.org/coverage/v1#ClaimRecord'],
    directory: 'clinical',
    filename: 'claims.ttl',
  },
  benefits: {
    label: 'Benefit Statements',
    rdfTypes: ['https://ns.cascadeprotocol.org/coverage/v1#BenefitStatement'],
    directory: 'clinical',
    filename: 'benefits.ttl',
  },
  'social-history': {
    label: 'Social History',
    rdfTypes: [CASCADE_NAMESPACES.clinical + 'SocialHistoryRecord'],
    directory: 'clinical',
    filename: 'social-history.ttl',
  },
  // The C-CDA Family History section emits `health:FamilyHistoryRecord`. Without
  // this entry `routeTypeKey` matched no registered type and fell through to the
  // FHIR passthrough bucket, so every family-history record a C-CDA import
  // produced landed in `clinical/fhir-passthrough.ttl` — not the
  // `clinical/family-history.ttl` the pod structure documents, and not anywhere
  // the read verbs present as family history.
  'family-history': {
    label: 'Family History',
    rdfTypes: [CASCADE_NAMESPACES.health + 'FamilyHistoryRecord'],
    directory: 'clinical',
    filename: 'family-history.ttl',
  },
  'ai-extraction-activities': {
    label: 'AI Extraction Activities',
    rdfTypes: [CASCADE_NAMESPACES.cascade + 'AIExtractionActivity'],
    directory: 'clinical',
    filename: 'ai-extraction-activities.ttl',
  },
  'fhir-passthrough': {
    label: 'FHIR Passthrough',
    rdfTypes: ['http://hl7.org/fhir/'],
    directory: 'clinical',
    filename: 'fhir-passthrough.ttl',
    isFhirPassthroughBucket: true,
  },
};
