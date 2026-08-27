import type { FieldDropManifest } from '../types.js';

/**
 * What `convertMedicationStatement` does not emit for a MedicationRequest.
 *
 * The converter serves both MedicationStatement and MedicationRequest; the paths
 * here are the ones a prescription carries.
 */
export const MEDICATION_REQUEST_DROPS: FieldDropManifest = {
  resourceType: 'MedicationRequest',
  provenance:
    'Differential run over test-fixtures/field-coverage/medicationrequest.json; matches the field census taken over 25 Epic R4 MedicationRequests.',
  drops: {
    'MedicationRequest.meta': {
      disposition: 'acknowledged',
      reason:
        "FHIR server bookkeeping (versionId, lastUpdated) about the resource's life on a server, not about the patient.",
    },
    'MedicationRequest.identifier': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The prescription number in the issuing system, and the key that would let one prescription arriving over two transports be recognised as one.',
    },
    'MedicationRequest.intent': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'order versus plan versus proposal. A drug a clinician considered and a drug a patient was actually prescribed import identically, and clinical:clinicalIntent is set from the RESOURCE TYPE rather than from this field.',
    },
    'MedicationRequest.category': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'inpatient, outpatient or community. It is how a medication list separates what a patient takes at home from what was given during an admission.',
    },
    'MedicationRequest.recorder': {
      disposition: 'acknowledged',
      reason:
        'Redundant alternative: the provenance pass reads the first populated of performer, requester, recorder, asserter and serviceProvider. With a requester present, the recorder adds nothing.',
    },
    'MedicationRequest.dispenseRequest': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'Quantity, refills and the validity period of the prescription. An earlier corpus-wide value match reported this as retained; the differential shows the values matched other records and the field reaches nothing.',
    },
    'MedicationRequest.requester.reference': {
      disposition: 'acknowledged',
      reason:
        'Practitioner resources are not imported as records, so the reference would dangle. The display is emitted as clinical:providerName.',
    },
    'MedicationRequest.dosageInstruction[0].patientInstruction': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The instruction written for the patient rather than for the pharmacy, which is the phrasing a person actually follows.',
    },
    'MedicationRequest.dosageInstruction[0].doseAndRate': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The numeric dose. clinical:dosage carries the free-text sig, so dose comparisons run on prose. Dose is deliberately excluded from the medication identity key precisely so a dose CHANGE raises a conflict, and a dose nobody stored cannot.',
    },
    'MedicationRequest.dosageInstruction[1]': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'Only the first Dosage element is read. A tapering or step-up regimen keeps its first step and loses the rest.',
    },
  },
};
