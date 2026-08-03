/**
 * Extract C-CDA section narrative <text> blocks as clinical:ClinicalDocument nodes.
 *
 * P5.1-A: Emits cascade:narrativeText (plain text, markup stripped) and
 * cascade:requiresLLMExtraction (true when section has no <entry> children).
 */

import { NS } from '../fhir-converter/types.js';
import { ccdaRecordUri } from './record-identity.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';
import { extractNarrativeText } from './narrative-extractor.js';

const { namedNode, literal, quad: makeQuad } = DataFactory;

const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';

export function extractNarrativeQuads(
  sectionText: any,
  sectionLoincCode: string,
  documentType: string,
  documentId: string,
  sourceSystem: string,
  importedAt: string,
  requiresLLMExtraction: boolean = false,
  sourceEhr: string = '',
  warnings?: string[],
): Quad[] {
  if (!sectionText && !requiresLLMExtraction) return [];

  // Convert the narrative to a plain-text string (P5.1-A: strip XML markup)
  const narrativeStr = extractNarrativeText(sectionText);

  // If no text and not a narrative-only section, skip
  if (!narrativeStr.trim() && !requiresLLMExtraction) return [];

  // A section narrative node has no `<id>` of its own — the id in play is the
  // enclosing DOCUMENT's, which is already a content field — so this takes the
  // door with no source id rather than being the one mint that sits outside it.
  // The IRI is byte-identical to what this call produced before.
  const uri = ccdaRecordUri({
    type: 'ClinicalDocument',
    content: {
      section: sectionLoincCode,
      document: documentId,
      source: sourceSystem,
    },
    // The narrative itself is the salvage-tier content for a section document
    // that somehow carries no section code, document id or source system.
    source: sectionText,
    warnings,
    label: 'C-CDA section narrative',
  });

  const subj = namedNode(uri);
  const quads: Quad[] = [
    makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'ClinicalDocument')),
    makeQuad(subj, namedNode(NS.clinical + 'documentType'), literal(documentType)),
    makeQuad(subj, namedNode(NS.cascade + 'sectionCode'), literal(sectionLoincCode)),
    makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)),
    makeQuad(subj, namedNode(NS.prov + 'generatedAtTime'), literal(importedAt, namedNode(NS.xsd + 'dateTime'))),
    // ClinicalDocumentShape required fields. A CDA section document is the CDA
    // analog of a FHIR DocumentReference.
    makeQuad(subj, namedNode(NS.clinical + 'importedAt'), literal(importedAt, namedNode(NS.xsd + 'dateTime'))),
    makeQuad(subj, namedNode(NS.clinical + 'fhirResourceId'), literal(uri.replace(/^urn:uuid:/, ''))),
    makeQuad(subj, namedNode(NS.clinical + 'fhirResourceType'), literal('DocumentReference')),
  ];

  // Required: sourceEHR (custodian organization). Bounded to the shape's 100-char
  // maxLength; falls back to the source-system label only if no EHR was derived.
  const ehr = (sourceEhr || sourceSystem || '').slice(0, 100);
  if (ehr) {
    quads.push(makeQuad(subj, namedNode(NS.clinical + 'sourceEHR'), literal(ehr, namedNode(NS.xsd + 'string'))));
  }

  // P5.1-A: emit cascade:narrativeText as plain text (LLM-ready)
  if (narrativeStr.trim()) {
    quads.push(makeQuad(subj, namedNode(NS.cascade + 'narrativeText'), literal(narrativeStr)));
  }

  // Legacy: keep cascade:content for backward compatibility (was clinical:content)
  if (narrativeStr.trim()) {
    quads.push(makeQuad(subj, namedNode(NS.clinical + 'content'), literal(narrativeStr)));
  }

  // P5.1-A: mark narrative-only sections
  quads.push(makeQuad(
    subj,
    namedNode(NS.cascade + 'requiresLLMExtraction'),
    literal(String(requiresLLMExtraction), namedNode(XSD_BOOLEAN)),
  ));

  return quads;
}
