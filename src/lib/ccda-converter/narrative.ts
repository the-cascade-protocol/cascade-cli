/**
 * Extract C-CDA section narrative <text> blocks as clinical:ClinicalDocument nodes.
 */

import { NS, contentHashedUri } from '../fhir-converter/types.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export function extractNarrativeQuads(
  sectionText: any,
  sectionLoincCode: string,
  documentType: string,
  documentId: string,
  sourceSystem: string,
  importedAt: string,
): Quad[] {
  if (!sectionText) return [];

  // Convert the narrative to a string
  let narrativeStr = '';
  if (typeof sectionText === 'string') {
    narrativeStr = sectionText;
  } else if (typeof sectionText === 'object') {
    narrativeStr = JSON.stringify(sectionText);
  }
  if (!narrativeStr.trim()) return [];

  const uri = contentHashedUri('ClinicalDocument', {
    section: sectionLoincCode,
    document: documentId,
    source: sourceSystem,
  });

  const subj = namedNode(uri);
  return [
    makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'ClinicalDocument')),
    makeQuad(subj, namedNode(NS.clinical + 'documentType'), literal(documentType)),
    makeQuad(subj, namedNode(NS.cascade + 'sectionCode'), literal(sectionLoincCode)),
    makeQuad(subj, namedNode(NS.clinical + 'content'), literal(narrativeStr)),
    makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)),
    makeQuad(subj, namedNode(NS.prov + 'generatedAtTime'), literal(importedAt, namedNode(NS.xsd + 'dateTime'))),
  ];
}
