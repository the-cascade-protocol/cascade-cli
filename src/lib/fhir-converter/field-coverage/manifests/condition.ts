import type { FieldDropManifest } from '../types.js';

/** What `convertCondition` does not emit. */
export const CONDITION_DROPS: FieldDropManifest = {
  resourceType: 'Condition',
  provenance:
    'Differential run over test-fixtures/field-coverage/condition.json; matches the field census taken over 46 Epic R4 Conditions.',
  drops: {
    'Condition.meta': {
      disposition: 'acknowledged',
      reason:
        "FHIR server bookkeeping (versionId, lastUpdated) about the resource's life on a server, not about the patient.",
    },
    'Condition.identifier': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        "The problem's identifier in the issuing system, and the join key for the same problem arriving over two transports.",
    },
    'Condition.clinicalStatus': {
      disposition: 'acknowledged',
      reason:
        "Redundant with the converter's default: health:status is emitted from the stated clinical status, but an ABSENT clinicalStatus is emitted as 'active'. Deleting a stated 'active' therefore changes nothing, while a stated 'resolved' does move the output. The defaulting is the part worth knowing: a source that says nothing is reported as active.",
    },
    'Condition.verificationStatus.text': {
      disposition: 'acknowledged',
      reason:
        'The coded verification status is what is read, and it is emitted. The text is not consulted, so a problem stating confirmed-or-refuted ONLY as text still arrives without it; mapping free text onto that code set would be a guess.',
    },
    'Condition.severity': {
      disposition: 'pending',
      backlog: '3.256',
      reason: 'Mild, moderate or severe. It changes what the same diagnosis means.',
    },
    'Condition.subject': {
      disposition: 'acknowledged',
      reason: "A pod holds one person's records, so the subject link is the pod itself.",
    },
    'Condition.recordedDate': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'When the problem was written down, as distinct from when it began. A problem list entry with no onset has nothing to place it in time without this.',
    },
    'Condition.recorder.reference': {
      disposition: 'acknowledged',
      reason:
        'Practitioner resources are not imported as records, so the reference would dangle. The display is emitted as clinical:providerName.',
    },
    'Condition.category[0].text': {
      disposition: 'acknowledged',
      reason:
        'Read only when the category states no coding. With a coding present the code is emitted as health:conditionCategory and the text restates it.',
    },
  },
};
