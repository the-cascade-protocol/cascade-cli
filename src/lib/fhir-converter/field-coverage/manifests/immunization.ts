import type { FieldDropManifest } from '../types.js';

/** What `convertImmunization` does not emit. */
export const IMMUNIZATION_DROPS: FieldDropManifest = {
  resourceType: 'Immunization',
  provenance:
    'Differential run over test-fixtures/field-coverage/immunization.json; matches the field census taken over the Epic R4 immunization set.',
  drops: {
    'Immunization.meta': {
      disposition: 'acknowledged',
      reason:
        "FHIR server bookkeeping (versionId, lastUpdated) about the resource's life on a server, not about the patient.",
    },
    'Immunization.identifier': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The registry or EHR identifier for the dose, and the join key for the same dose arriving from a state registry and from a clinic.',
    },
    'Immunization.status': {
      disposition: 'acknowledged',
      reason:
        "Redundant with the converter's default: health:status is emitted, but an ABSENT status is emitted as 'completed', so deleting a 'completed' status changes nothing. A source stating not-done or entered-in-error does move the output — and a source stating nothing is reported as completed, which is the defaulting this entry exists to make visible.",
    },
    'Immunization.patient': {
      disposition: 'acknowledged',
      reason: "A pod holds one person's records, so the patient link is the pod itself.",
    },
    'Immunization.primarySource': {
      disposition: 'acknowledged',
      reason:
        'Whether the record came from the administering source or from a report of it. Cascade records provenance on its own axes (cascade:dataProvenance, clinical:sourceEHR).',
    },
    'Immunization.expirationDate': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The lot expiry. The lot number is emitted, so the pod can say which lot was given but not whether it was in date — the pair is only useful together.',
    },
    'Immunization.protocolApplied': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'Dose number within the series. Whether a two-dose series was completed is the question an immunization record is most often asked.',
    },
    'Immunization.location.reference': {
      disposition: 'acknowledged',
      reason:
        'Location resources are not imported as records, so the reference would dangle. The display is emitted as health:administeringLocation.',
    },
    'Immunization.manufacturer.reference': {
      disposition: 'acknowledged',
      reason:
        'Organization resources are not imported as records, so the reference would dangle. The display is emitted as health:manufacturer.',
    },
    'Immunization.site.coding': {
      disposition: 'acknowledged',
      reason:
        'health:site carries the stated text, which is what a reader needs. The coded body site would need a coded-value term no consumer reads today.',
    },
    'Immunization.route.coding': {
      disposition: 'acknowledged',
      reason:
        'health:route carries the stated text. Same reasoning as site.coding.',
    },
    'Immunization.doseQuantity.system': {
      disposition: 'acknowledged',
      reason:
        'Names the code system for doseQuantity.code. Carrying it while the code itself is not stored would state a system for nothing.',
    },
    'Immunization.doseQuantity.code': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The UCUM unit code for the dose. health:doseQuantity carries value and display unit only, so doses cannot be compared without parsing prose.',
    },
    'Immunization.performer[0].function': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'Whether the performer administered the dose or ordered it. health:administeringProvider is filled from performer[0] regardless, which is the same role-blind selection Encounter.participant has.',
    },
  },
};
