import type { FieldDropManifest } from '../types.js';

/**
 * What `convertClinicalDocument` does not emit.
 *
 * `docStatus` is emitted now, so an amended note is no longer byte-identical to
 * a final one. `status` still is not: a superseded or retracted document reads
 * as a live one.
 *
 * Attribution is no longer absent either: `appendProvenanceQuads` reads `author`
 * (falling back to `authenticator`) and `custodian`, so a note names its writer
 * and the organization holding it. What remains dropped is narrower — the
 * co-author, the practitioner references themselves, and the author/attester
 * DISTINCTION — and each is stated below.
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
    'DocumentReference.status': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'current, superseded and entered-in-error import identically, so a retracted document reads as a live one.',
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
    'DocumentReference.author[1]': {
      disposition: 'acknowledged',
      reason:
        'Only the first author reaches clinical:providerName, which is sh:maxCount 1 on every shape that constrains it, so a co-author cannot be added without producing records that fail validation. Naming the writer is the fact a note most needs; a second author would need a repeatable contributor predicate that does not exist.',
    },
    'DocumentReference.author[0].reference': {
      disposition: 'acknowledged',
      reason:
        'Practitioner resources are not imported as records, so the reference would dangle. The display is emitted as clinical:providerName.',
    },
    'DocumentReference.authenticator': {
      disposition: 'acknowledged',
      reason:
        'Read only when the document names no author; with an author present that value is the provider. Attestation as a fact DISTINCT from authorship — who signed a note someone else wrote — would need its own predicate, and none exists, so what is dropped here is the distinction rather than the name.',
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
