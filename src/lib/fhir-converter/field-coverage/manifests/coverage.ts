import type { FieldDropManifest } from '../types.js';

/** What `convertCoverage` does not emit. */
export const COVERAGE_DROPS: FieldDropManifest = {
  resourceType: 'Coverage',
  provenance: 'Differential run over test-fixtures/field-coverage/coverage.json.',
  drops: {
    'Coverage.meta': {
      disposition: 'acknowledged',
      reason:
        "FHIR server bookkeeping (versionId, lastUpdated) about the resource's life on a server, not about the patient.",
    },
    'Coverage.identifier': {
      disposition: 'acknowledged',
      reason:
        'Read only as a fallback for coverage:memberId when the resource states no subscriberId. With a subscriberId present that value is the member id.',
    },
    'Coverage.subscriber': {
      disposition: 'acknowledged',
      reason:
        "A pod holds one person's records. Who the policy holder is relative to that person is carried by coverage:subscriberRelationship, which is emitted.",
    },
    'Coverage.beneficiary': {
      disposition: 'acknowledged',
      reason: "A pod holds one person's records, so the beneficiary link is the pod itself.",
    },
    'Coverage.order': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'Which policy pays first. With two plans in a pod and no order, nothing says which is primary.',
    },
    'Coverage.network': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The network the plan pays in-network rates for, which is what decides whether a given clinic is covered.',
    },
    'Coverage.type.text': {
      disposition: 'acknowledged',
      reason:
        'Read only when the type states no coding. With a coding present the code is emitted as coverage:coverageType and the text restates it.',
    },
    'Coverage.relationship.text': {
      disposition: 'acknowledged',
      reason:
        "The coded relationship is what is read; the text restates it and is not consulted. A relationship stated ONLY as text now yields no triple at all, rather than the 'self' this converter used to substitute — the sh:in list is the HL7 SubscriberPolicyholder system and picking a member of it out of prose would be the same guess.",
    },
    'Coverage.payor[0].reference': {
      disposition: 'acknowledged',
      reason:
        'Organization resources are not imported as records, so the reference would dangle. The display is emitted as coverage:providerName.',
    },
  },
};
