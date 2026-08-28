import type { FieldDropManifest } from '../types.js';

/**
 * What `convertClinicalDocument` does not emit.
 *
 * Both statuses are emitted now, on their own predicates: `docStatus` as
 * `clinical:status` (wave 1) and `status` as `clinical:documentReferenceStatus`
 * (wave 4), so a superseded reference no longer reads as a live one and
 * "entered-in-error" is no longer ambiguous between the two.
 *
 * Attribution is complete too. `appendProvenanceQuads` still writes the single
 * display name to `clinical:providerName`, and wave 4 adds
 * `clinical:documentAuthorName` for EVERY author and `clinical:authenticatorName`
 * for the signer — so a note co-signed by a resident and an attending keeps both,
 * and who SIGNED it is no longer stored as though they wrote it.
 *
 * What is left is the practitioner REFERENCES (resources the pod does not hold,
 * so the links would dangle) and three fields with no term yet.
 */
export const DOCUMENT_REFERENCE_DROPS: FieldDropManifest = {
  resourceType: 'DocumentReference',
  provenance:
    'Differential run over test-fixtures/field-coverage/documentreference.json; matches the field census taken over 57 Epic R4 DocumentReferences.',
  drops: {
    'DocumentReference.meta': {
      disposition: 'acknowledged',
      reason:
        "FHIR server bookkeeping (versionId, lastUpdated) about the resource's life on a server, not about the patient.",
    },
    'DocumentReference.identifier': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The document\'s own identifier in the issuing system, and the key that would let the same note arriving over two transports be recognised as one note.',
    },
    'DocumentReference.category': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The class of document (clinical note, imaging report, discharge summary). It is what a document list is grouped by.',
    },
    'DocumentReference.subject': {
      disposition: 'acknowledged',
      reason:
        "A pod holds one person's records, so the subject link is the pod itself.",
    },
    'DocumentReference.author[0].reference': {
      disposition: 'acknowledged',
      reason:
        'Practitioner resources are not imported as records, so the reference would dangle. The display is emitted as clinical:documentAuthorName and, for the first author, as clinical:providerName.',
    },
    'DocumentReference.author[1].reference': {
      disposition: 'acknowledged',
      reason:
        'Same as author[0].reference: a link to a Practitioner resource the pod does not hold. Visible to the differential only now that author[1] itself is emitted, because the walk stops descending at a dropped parent. The co-author\'s NAME reaches the pod as clinical:documentAuthorName.',
    },
    'DocumentReference.authenticator.reference': {
      disposition: 'acknowledged',
      reason:
        'Same as the author references: the Practitioner resource is not imported, so the link would dangle. The signer\'s NAME is emitted as clinical:authenticatorName, which is the fact that carries the clinical and legal weight; the reference only says where the source would have looked it up.',
    },
    'DocumentReference.custodian.reference': {
      disposition: 'acknowledged',
      reason:
        'Organization resources are not imported as records, so the reference would dangle. The display is emitted as clinical:sourceEHR.',
    },
    'DocumentReference.description': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The one-line description of the document, which is where a source commonly states what an amendment changed.',
    },
    'DocumentReference.type.coding': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The LOINC document-type code. Only the display text reaches the pod, so documents cannot be selected by code.',
    },
    'DocumentReference.context.period': {
      disposition: 'acknowledged',
      reason:
        'The service period the document covers. The document date is emitted and the encounter edge carries the visit interval, so this restates facts already in the graph.',
    },
    'DocumentReference.context.facilityType': {
      disposition: 'acknowledged',
      reason:
        'The care setting. Duplicated by the linked encounter\'s own type, which is where a reader looks for it.',
    },
    'DocumentReference.content[0].format': {
      disposition: 'acknowledged',
      reason:
        'An IHE format code describing how to render the attachment. clinical:contentType is emitted and is what a reader needs to open it.',
    },
  },
};
