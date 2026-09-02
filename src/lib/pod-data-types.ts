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
  // Two vocabularies spell a supplement, and both route HERE rather than to two
  // files. `clinical:Supplement` is the importer's spelling; the checkup
  // vocabulary's `checkup:SupplementSummary` is the patient-facing one, which
  // carries the regulatory classification (dietary supplement / OTC drug /
  // homeopathic / herbal) that separates a supplement from an FDA-approved
  // medication, and which is what a person adding their own supplement writes.
  //
  // It was registered nowhere, so `pod add-record --type
  // checkup:SupplementSummary` failed outright with "No known bucket for type"
  // and there was no way to record a supplement by hand at all. Filing it beside
  // `clinical:Supplement` (rather than in a checkup-only file) is what keeps
  // "show me the supplements" one read: a reader asking that question must not
  // have to know which of two vocabularies the writer happened to use.
  supplements: {
    label: 'Supplements',
    rdfTypes: [
      CASCADE_NAMESPACES.clinical + 'Supplement',
      CASCADE_NAMESPACES.checkup + 'SupplementSummary',
    ],
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
    rdfTypes: [
      CASCADE_NAMESPACES.clinical + 'Encounter',
      // The participation SUB-NODE lives in the same file as the encounter that
      // owns it, and that is not a filing convenience.
      //
      // Pods are partitioned per type and `cascade validate` validates each file
      // INDEPENDENTLY, so a `clinical:hasParticipant` edge crossing a file
      // boundary would be unresolvable to the validator — the same problem that
      // forced the sh:class constraints off the v1.10 graph edges. Routing it
      // anywhere else also sends it through `routeTypeKey`'s unknown-type
      // fallback into the FHIR passthrough bucket, where a Cascade-typed node
      // would sit among unconverted FHIR JSON and be counted as an imported
      // record of its own.
      //
      // It is deliberately NOT given a bucket of its own. A participation has no
      // existence apart from its encounter (FHIR models it as a BackboneElement,
      // which cannot be addressed independently at all), and a file of
      // participations detached from the visits they belong to would be a list
      // of names nobody could interpret.
      CASCADE_NAMESPACES.clinical + 'EncounterParticipant',
    ],
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
    label: 'Imaging',
    // The study (what was acquired) and the report (what a radiologist wrote
    // about it) are one part of the record picture and share one file. The
    // report class was added when the FHIR converter started routing
    // DiagnosticReport on category (3.221): an rdf:type no bucket claims falls
    // through routeTypeKey to `fhir-passthrough`, so a correctly typed
    // radiology report would have been filed as an unmapped Layer 1 record and
    // would not appear in `pod info` at all.
    //
    // ImagingStudy stays FIRST: `solid:forClass` in the type index is minted
    // from rdfTypes[0], so reordering would rewrite the registration that
    // existing pods already carry.
    rdfTypes: [
      CASCADE_NAMESPACES.clinical + 'ImagingStudy',
      CASCADE_NAMESPACES.clinical + 'ImagingReport',
    ],
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

/**
 * Subjects that are STRUCTURAL SUB-NODES of a record rather than records.
 *
 * A sub-node is stored in the pod, validated by its own shape, and routed into
 * the same file as the record that owns it — but it is not a thing a person has
 * one of. `clinical:EncounterParticipant` mirrors FHIR's
 * `Encounter.participant`, a BackboneElement with no independent existence in
 * FHIR at all: it exists to say who took part in ONE visit, and it is reached
 * only from that visit.
 *
 * WHY THIS SET EXISTS. Import counts subjects, which was exact for as long as
 * every subject was a record. The moment a converter minted its first sub-node
 * that stopped being true, and the arithmetic failed in the direction that
 * misleads: one Synthea bundle's 44 visits reported as 57 "Encounters", so
 * "Records imported" and the per-type summary would both have overstated what
 * the person actually has. The nodes are still written, still validated and
 * still read back; they are not COUNTED as records, because they are not
 * records.
 */
export const STRUCTURAL_SUBNODE_TYPES: ReadonlySet<string> = new Set([
  CASCADE_NAMESPACES.clinical + 'EncounterParticipant',
]);

/** True when a subject's quads describe a structural sub-node, not a record. */
export function isStructuralSubNode(quads: ReadonlyArray<{ predicate: { value: string }; object: { value: string } }>): boolean {
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  return quads.some((q) => q.predicate.value === RDF_TYPE && STRUCTURAL_SUBNODE_TYPES.has(q.object.value));
}
