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
import { readingLoincCodesForFile } from './apple-health-wellness/rules.js';

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
  /**
   * `health:DailyVitalReading` is one class for every daily vital, but
   * pod-structure.md section 4.2 files the readings by domain (heart rate,
   * HRV, body measurements, activity). A reading whose `cascade:loincCode` is
   * one of these (full LOINC IRIs) belongs in THIS file; a reading with any
   * other code, or none, falls back to the class route (`heart-rate`).
   * Derived from the wellness rules table, so the importer that places a
   * reading and every verb that later rewrites the file agree on where it lives.
   */
  readingLoincCodes?: readonly string[];
}

const LOINC_NS = 'http://loinc.org/rdf#';
const loincIris = (fileKey: string): string[] => readingLoincCodesForFile(fileKey).map((c) => LOINC_NS + c);

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
    // health:Workout is listed on the activity container (serialization
    // section 12.13), so workouts share its file.
    rdfTypes: [
      CASCADE_NAMESPACES.health + 'DailyActivitySnapshot',
      CASCADE_NAMESPACES.health + 'ActivityData',
      CASCADE_NAMESPACES.health + 'Workout',
    ],
    directory: 'wellness',
    filename: 'activity.ttl',
    readingLoincCodes: loincIris('activity'),
  },
  hrv: {
    label: 'Heart Rate Variability',
    rdfTypes: [CASCADE_NAMESPACES.health + 'HRVData'],
    directory: 'wellness',
    filename: 'hrv.ttl',
    readingLoincCodes: loincIris('hrv'),
  },
  'body-measurements': {
    label: 'Body Measurements',
    rdfTypes: [CASCADE_NAMESPACES.health + 'BodyMeasurements'],
    directory: 'wellness',
    filename: 'body-measurements.ttl',
    readingLoincCodes: loincIris('body-measurements'),
  },
  // PROVISIONAL placement. pod-structure.md section 4.2 does not yet place
  // health:Device (health v2.10). One file beside the readings that reference
  // it is the smallest consistent option; distinct from clinical/devices.ttl,
  // which holds implanted devices.
  'wellness-devices': {
    label: 'Wellness Devices',
    rdfTypes: [CASCADE_NAMESPACES.health + 'Device'],
    directory: 'wellness',
    filename: 'devices.ttl',
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

const RDF_TYPE_IRI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DAILY_VITAL_READING = CASCADE_NAMESPACES.health + 'DailyVitalReading';
const LOINC_CODE_PREDICATE = CASCADE_NAMESPACES.cascade + 'loincCode';

/**
 * Whether the records of a data type go through the reconciler.
 *
 * The reconciler matches clinical records (conditions, medications, labs and
 * the rest) across sources. The `wellness/` buckets hold device data and daily
 * aggregates it has no matcher for, and a pod with a year of wellness data holds
 * hundreds of thousands of quads there. Loading them into every clinical import
 * and every `pod reconcile` only to carry them through untouched costs minutes
 * and risks nothing but a rewrite of files that must not change. So they stay
 * out of the reconciler's reads, and a write that lands a record in one of them
 * is ADDITIVE (the file keeps what it holds) rather than a replacement.
 */
export function isReconciledDataType(info: DataTypeInfo): boolean {
  return info.directory === 'clinical';
}

/**
 * THE router: which registered data file a subject belongs in, or undefined
 * when no registered data type claims it.
 *
 * Every verb that files or re-files records (`pod import`, `pod reconcile` and
 * its undo, `pod add-record`) asks this one function, so a record is always
 * rewritten into the file it was written to. Routing by the first `rdf:type`,
 * with one refinement: a `health:DailyVitalReading` is filed by its
 * `cascade:loincCode` where a data type claims that code
 * ({@link DataTypeInfo.readingLoincCodes}).
 */
export function registeredDataTypeKeyForSubject(
  quads: ReadonlyArray<{ predicate: { value: string }; object: { value: string } }>,
): string | undefined {
  const typeIri = quads.find((q) => q.predicate.value === RDF_TYPE_IRI)?.object.value ?? '';
  if (typeIri === DAILY_VITAL_READING) {
    const code = quads.find((q) => q.predicate.value === LOINC_CODE_PREDICATE)?.object.value;
    if (code) {
      for (const [key, info] of Object.entries(DATA_TYPES)) {
        if (info.readingLoincCodes?.includes(code)) return key;
      }
    }
  }
  for (const [key, info] of Object.entries(DATA_TYPES)) {
    if (info.isFhirPassthroughBucket) continue;
    if (info.rdfTypes.includes(typeIri)) return key;
  }
  return undefined;
}

/**
 * {@link registeredDataTypeKeyForSubject}, with the FHIR passthrough bucket for
 * a subject no registered type claims: the routing `pod import` and
 * `pod reconcile` file records by.
 */
export function dataTypeKeyForSubject(
  quads: ReadonlyArray<{ predicate: { value: string }; object: { value: string } }>,
): string {
  return registeredDataTypeKeyForSubject(quads) ?? 'fhir-passthrough';
}
