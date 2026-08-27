import type { FieldDropManifest } from '../types.js';

/**
 * What `convertClinicalDocument` does not emit.
 *
 * `docStatus` is emitted now, so an amended note is no longer byte-identical to
 * a final one. `status` still is not: a superseded or retracted document reads
 * as a live one.
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
    'DocumentReference.author': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'Who wrote the note. The provenance recovery pass reads performer/requester/recorder/asserter/serviceProvider and DocumentReference states none of them, so the author is lost on every document.',
    },
    'DocumentReference.authenticator': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'Who attested the note. Distinct from the author on any note signed by a supervising clinician.',
    },
    'DocumentReference.custodian': {
      disposition: 'pending',
      backlog: '3.256',
      reason:
        'The organization holding the document, which is this record\'s source EHR. provenance.ts does not read `custodian`, so a bundle whose only organization signal is this field derives no source label.',
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
