import type { FieldDropManifest } from '../types.js';

/** What `convertAllergyIntolerance` does not emit. */
export const ALLERGY_INTOLERANCE_DROPS: FieldDropManifest = {
  resourceType: 'AllergyIntolerance',
  provenance:
    'Differential run over test-fixtures/field-coverage/allergyintolerance.json.',
  drops: {
    'AllergyIntolerance.meta': {
      disposition: 'acknowledged',
      reason:
        "FHIR server bookkeeping (versionId, lastUpdated) about the resource's life on a server, not about the patient.",
    },
    'AllergyIntolerance.identifier': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The allergy record identifier in the issuing system, and the join key for the same allergy arriving over two transports.',
    },
    'AllergyIntolerance.clinicalStatus.text': {
      disposition: 'acknowledged',
      reason:
        'The coded clinical status is what is read, and it is emitted. The text is not consulted at all, so an allergy stating its status ONLY as text still arrives without one — mapping free text onto a status code set would be a guess, and the vendor output this was measured against always states the coding.',
    },
    'AllergyIntolerance.verificationStatus': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'confirmed, unconfirmed, refuted or entered-in-error. A refuted allergy presented as confirmed narrows treatment for no reason.',
    },
    'AllergyIntolerance.type': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'Allergy versus intolerance — an immune reaction and a side effect are different clinical facts with different consequences.',
    },
    'AllergyIntolerance.criticality': {
      disposition: 'acknowledged',
      reason:
        'Read only when no reaction severity is stated; with a reaction severity present that value wins. The mapping is deliberate (low/high/unable-to-assess to mild/severe/moderate) and stated once.',
    },
    'AllergyIntolerance.patient': {
      disposition: 'acknowledged',
      reason: "A pod holds one person's records, so the patient link is the pod itself.",
    },
    'AllergyIntolerance.recordedDate': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'When the allergy was recorded. health:onsetDate is emitted only from onsetDateTime, which allergy records rarely carry, so most allergies land in the pod with no date at all.',
    },
    'AllergyIntolerance.lastOccurrence': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'When the patient last reacted. It is how a reader judges whether an allergy is current.',
    },
    'AllergyIntolerance.code.coding': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The coded allergen (SNOMED or RxNorm). Only the display text is emitted, so allergy checking against a coded medication list cannot be done in the pod.',
    },
    'AllergyIntolerance.recorder.reference': {
      disposition: 'acknowledged',
      reason:
        'Practitioner resources are not imported as records, so the reference would dangle. The display is emitted as clinical:providerName.',
    },
    'AllergyIntolerance.reaction[0].substance': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The specific substance that produced the reaction, which can be narrower than the allergy code (a single drug within a class).',
    },
    'AllergyIntolerance.reaction[0].severity': {
      disposition: 'acknowledged',
      reason:
        'Redundant alternative in this shape: health:allergySeverity is taken from the reaction severity when stated and mapped from criticality otherwise, and here both express the same level. Deleting either alone leaves the value unchanged.',
    },
    'AllergyIntolerance.reaction[0].onset': {
      disposition: 'pending',
      backlog: '3.256',
      reason: 'When the reaction happened, which is what dates an allergy record in practice.',
    },
    'AllergyIntolerance.reaction[0].description': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The free-text account of what happened. health:reaction carries the coded manifestations only, which is the difference between "anaphylaxis" and what a reader can act on.',
    },
  },
};
