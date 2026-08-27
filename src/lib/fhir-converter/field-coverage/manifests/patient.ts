import type { FieldDropManifest } from '../types.js';

/**
 * What `convertPatient` does not emit.
 *
 * The entry worth reading first is `Patient.name`: the FHIR path stores the
 * profile's date of birth, sex, address and marital status and never the
 * person's name.
 */
export const PATIENT_DROPS: FieldDropManifest = {
  resourceType: 'Patient',
  provenance:
    'Differential run over test-fixtures/field-coverage/patient.json.',
  drops: {
    'Patient.meta': {
      disposition: 'acknowledged',
      reason:
        "FHIR server bookkeeping (versionId, lastUpdated) about the resource's life on a server, not about the patient.",
    },
    'Patient.identifier': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The medical record number and every other identifier the EHR itself uses to tell two patients apart. It is already an input to the profile identity key, so it decides which profiles merge while never appearing as a fact.',
    },
    'Patient.active': {
      disposition: 'acknowledged',
      reason:
        "Whether the record is active in the source system. That is the source's own bookkeeping about its chart, not a fact about the person.",
    },
    'Patient.name': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        "The person's name. The FHIR path emits date of birth, computed age, sex, address and marital status and no name at all, so a profile imported from FHIR is nameless while the C-CDA path fills it in.",
    },
    'Patient.telecom': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'Phone numbers and email. The address is emitted, so the profile carries where a person lives but no way to reach them.',
    },
    'Patient.deceasedBoolean': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'Whether the source states the person has died. It is in the identity key already, so it can split a profile while never being visible in one.',
    },
    'Patient.communication': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'Preferred language and whether an interpreter is needed — a care-delivery fact, not a demographic nicety.',
    },
    'Patient.generalPractitioner': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        "The person's own clinician. Every record in the pod can name the clinician who performed it while the profile cannot name the one who follows them.",
    },
    'Patient.managingOrganization': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        "The organization holding the chart. deriveBundleOrigin does not read this field, so a bundle whose only organization signal is here derives no source label and every record falls back to the endpoint host or to unknown.",
    },
    'Patient.maritalStatus.coding': {
      disposition: 'acknowledged',
      reason:
        'Redundant alternative: cascade:maritalStatus is mapped from the coding when present and from the text otherwise, and both spellings map to the same value.',
    },
    'Patient.maritalStatus.text': {
      disposition: 'acknowledged',
      reason:
        'Redundant alternative: see maritalStatus.coding. Either alone produces the same cascade:maritalStatus.',
    },
    'Patient.address[0].use': {
      disposition: 'acknowledged',
      reason:
        'home, work or temporary. Only one address is flattened onto the profile and Cascade has no term to qualify which kind it is.',
    },
  },
};
