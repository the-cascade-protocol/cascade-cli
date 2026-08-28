import type { FieldDropManifest } from '../types.js';

/**
 * What `convertEncounter` does not emit.
 *
 * Seeded from the differential run over `test-fixtures/field-coverage/encounter.json`,
 * which reproduces the shape measured across 54 Epic R4 Encounters.
 *
 * WHAT WAVE 4 CLOSED. The reason, the admission detail, the readable class label
 * and its code system, every participant with its role and specialty, and the
 * visit's business identifiers on the canonical predicate all reach the pod now,
 * so their entries are gone from this file rather than downgraded. Eight entries
 * were deleted; what replaces them are the four SUB-elements the differential can
 * only see now that it descends into paths their parents used to hide.
 *
 * WHAT IS STILL LOST, and it is worth being precise about how little is left:
 * every `type` coding past the first, `serviceType`, and every `location` past
 * the one that becomes the facility. All three need vocabulary that clinical
 * v1.16 did not author.
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
    'Encounter.reasonCode[1].coding': {
      disposition: 'acknowledged',
      reason:
        "The coded form of a reason whose text is emitted. clinical:encounterReason carries the reason AS WRITTEN, and FHIR binds Encounter.reasonCode only preferred, so real exports mix local, free-text and SNOMED reasons in one element; a code beside an emitted text adds no fact the pod can act on. Where a coded reason names a record the pod already holds, clinical:indicationReference carries that as a traversable edge instead.",
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
    'Encounter.participant[0].period': {
      disposition: 'acknowledged',
      reason:
        "The interval this individual took part in, as distinct from the encounter's own period. clinical:EncounterParticipant models FHIR's participant as a name, a role and a specialty and deliberately carries no time: a participation interval describes movement WITHIN a visit, the same intra-stay axis Encounter.location[0].period sits on, and the encounter's own period is emitted. Both would need the same vocabulary, and neither should get it piecemeal.",
    },
  },
};
