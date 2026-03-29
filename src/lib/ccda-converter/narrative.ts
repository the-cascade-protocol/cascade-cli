/**
 * Extract C-CDA section narrative <text> blocks as clinical:ClinicalDocument nodes.
 *
 * P5.1-A: Emits cascade:narrativeText (plain text, markup stripped) and
 * cascade:requiresLLMExtraction (true when section has no <entry> children).
 */

import { NS, contentHashedUri } from '../fhir-converter/types.js';
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
): Quad[] {
  if (!sectionText && !requiresLLMExtraction) return [];

  // Convert the narrative to a plain-text string (P5.1-A: strip XML markup)
  const narrativeStr = extractNarrativeText(sectionText);

  // If no text and not a narrative-only section, skip
  if (!narrativeStr.trim() && !requiresLLMExtraction) return [];

  const uri = contentHashedUri('ClinicalDocument', {
    section: sectionLoincCode,
    document: documentId,
    source: sourceSystem,
  });

  const subj = namedNode(uri);
  const quads: Quad[] = [
    makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.clinical + 'ClinicalDocument')),
    makeQuad(subj, namedNode(NS.clinical + 'documentType'), literal(documentType)),
    makeQuad(subj, namedNode(NS.cascade + 'sectionCode'), literal(sectionLoincCode)),
    makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(sourceSystem)),
    makeQuad(subj, namedNode(NS.prov + 'generatedAtTime'), literal(importedAt, namedNode(NS.xsd + 'dateTime'))),
  ];

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
