import type { FieldDropManifest } from '../types.js';

/**
 * What `convertEncounter` does not emit.
 *
 * Seeded from the differential run over `test-fixtures/field-coverage/encounter.json`,
 * which reproduces the shape measured across 54 Epic R4 Encounters.
 *
 * The clinic, the role-correct provider and the visit's contact serial number
 * now survive. What still does not: the reason, the admission detail, every type
 * coding past the first, and every participant except the one that wins the role
 * ranking — including that participant's own specialty.
 */
export const ENCOUNTER_DROPS: FieldDropManifest = {
  resourceType: 'Encounter',
  provenance:
    'Differential run over test-fixtures/field-coverage/encounter.json; matches the field census taken over a 54-encounter Epic R4 pull.',
  drops: {
    'Encounter.meta': {
      disposition: 'acknowledged',
      reason:
        "FHIR server bookkeeping (versionId, lastUpdated) about the resource's life on a server, not about the patient. Cascade states its own provenance and keys records on sourceRecordId.",
    },
    'Encounter.identifier[0].use': {
      disposition: 'acknowledged',
      reason:
        "Whether the health system calls this identifier usual, official or secondary. The identifier itself is emitted, scoped by its assigning system, which is everything the join between a FHIR encounter and its C-CDA twin needs; the use code qualifies the label a chart would print it under and identifies nothing on its own.",
    },
    'Encounter.serviceType': {
      disposition: 'pending',
      backlog: '3.254',
      reason: 'The specialty the visit was booked under. No clinical: term carries it yet.',
    },
    'Encounter.subject': {
      disposition: 'acknowledged',
      reason:
        "A pod holds one person's records, so the subject link is the pod itself. A reference to a Patient resource the pod does not hold would dangle.",
    },
    'Encounter.length': {
      disposition: 'acknowledged',
      reason:
        'Duration is derivable from the emitted encounterStart and encounterEnd. Storing it as a second fact invites the two to disagree.',
    },
    'Encounter.reasonCode': {
      disposition: 'pending',
      backlog: '3.254',
      reason:
        'Why the visit happened, which is the single most orienting fact on a visit card. Needs vocabulary: check US Core and IPS Encounter before authoring a clinical: term.',
    },
    'Encounter.hospitalization': {
      disposition: 'pending',
      backlog: '3.254',
      reason:
        'Admit source and discharge disposition. Present on inpatient encounters only, and the part of an admission a reader most wants. Needs vocabulary.',
    },
    'Encounter.location[1]': {
      disposition: 'pending',
      backlog: '3.254',
      reason:
        'Only the first named location becomes clinical:facilityName. An encounter that moves between units states each of them, and every location after the first reaches nothing.',
    },
    'Encounter.location[0].status': {
      disposition: 'acknowledged',
      reason:
        "Whether the patient was planned for, present at, or finished with that location. It describes movement WITHIN a stay, which needs vocabulary Cascade does not have; the encounter's own status is emitted.",
    },
    'Encounter.location[0].period': {
      disposition: 'acknowledged',
      reason:
        "The interval the patient spent at that location. Same reasoning as location[0].status: intra-stay movement needs vocabulary, and the encounter's own period is emitted.",
    },
    'Encounter.class.system': {
      disposition: 'pending',
      backlog: '3.254',
      reason:
        'clinical:encounterClass is emitted as a bare code, so a vendor category id and a v3-ActCode arrive indistinguishable. The system is what makes the code readable.',
    },
    'Encounter.class.display': {
      disposition: 'pending',
      backlog: '3.254',
      reason:
        'The human label for the class ("Appointment", "Hospital Encounter"). Emitting the code without it leaves a bare id on screen.',
    },
    'Encounter.type[0].coding': {
      disposition: 'acknowledged',
      reason:
        'Only a SNOMED coding on the first type is emitted (as clinical:snomedCode). A vendor-local code identifies a row in the issuing EHR and means nothing outside it, so it is not carried.',
    },
    'Encounter.type[1]': {
      disposition: 'pending',
      backlog: '3.254',
      reason:
        'Only type[0] is read. An encounter routinely states several types (setting, service, admission kind) and all but the first are lost.',
    },
    'Encounter.type[2]': {
      disposition: 'pending',
      backlog: '3.254',
      reason:
        'Same gap as type[1], and this slot is where a SNOMED-coded type commonly sits: the converter looks for SNOMED in type[0] only.',
    },
    'Encounter.type[3]': {
      disposition: 'pending',
      backlog: '3.254',
      reason:
        'Same gap as type[1]. Epic routinely states four types on one encounter and three of them reach nothing.',
    },
    'Encounter.participant[0]': {
      disposition: 'pending',
      backlog: '3.254',
      reason:
        'Provider selection now ranks participants by declared role, so this generic-role participant reaches nothing once a treating role is present. Exactly ONE participant becomes clinical:providerName; the rest of the care team, roles included, is still dropped.',
    },
    'Encounter.participant[1].extension': {
      disposition: 'pending',
      backlog: '3.254',
      reason:
        'The specialty extension on the participant who WAS selected. The name reaches the pod and the specialty beside it does not, so "who treated me" arrives without "as what".',
    },
    'Encounter.participant[2]': {
      disposition: 'pending',
      backlog: '3.254',
      reason:
        'Same gap as participant[0]. A visit with four participants keeps one name and loses three, roles and all.',
    },
    'Encounter.participant[3]': {
      disposition: 'pending',
      backlog: '3.254',
      reason:
        'Same gap as participant[0]. A participant losing the ranking is a participant the pod never mentions.',
    },
  },
};
