/**
 * Extract C-CDA section narrative <text> blocks as clinical:ClinicalDocument nodes.
 *
 * Emits the section text once, as clinical:narrativeText (plain text, markup
 * stripped), and cascade:requiresLLMExtraction (true when the section has no
 * <entry> children). Earlier releases wrote the same text under two undeclared
 * spellings, cascade:narrativeText and clinical:content; neither is written
 * any more, and readers accept all three through lib/narrative-text.ts.
 */

import { NS } from '../fhir-converter/types.js';
import { ccdaRecordUri } from './record-identity.js';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';
import { extractNarrativeText } from './narrative-extractor.js';
import { NARRATIVE_TEXT_PREDICATE } from '../narrative-text.js';
import { contentFingerprint, EMPTY_SEED } from '../identity.js';

const { namedNode, literal, quad: makeQuad } = DataFactory;

const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';

/**
 * Where a section narrative belongs: the document SET, and the document itself
 * only when it states no set.
 *
 * An EHR that regenerates a summary on every download mints a new
 * `ClinicalDocument/id` each time and keeps the `setId`, bumping
 * `versionNumber`. Measured on two downloads of the same document set from one
 * EHR: 0 of 385 section narratives kept their name while the context was the
 * document id, and 25 of the 26 documents shared their `setId` across the two
 * downloads. The set is what stays the same when the document is re-issued, so
 * it is the context; the two keys are spelled differently so a set id and a
 * document id can never be read as one another.
 */
export type NarrativeDocumentContext = { documentSet: string } | { document: string };

/**
 * Narrative markup that the EHR regenerates on every download and that says
 * nothing about the section's content. Measured, between two downloads of one
 * set with unchanged clinical text: `@ID` on `table`, `caption`, `tr`, `td`,
 * `content`, `paragraph` and `footnote` (element ids renumbered), footnote text
 * (a retrieval stamp) and `@styleCode` (rendering). A footnote reference
 * (`footnoteRef`, whose only content is an `@IDREF` to one of those ids) goes
 * with them.
 */
export const NARRATIVE_EXCLUDED_ATTRIBUTES: ReadonlySet<string> = new Set(['@_ID', '@_styleCode']);
export const NARRATIVE_EXCLUDED_ELEMENTS: ReadonlySet<string> = new Set(['footnote', 'footnoteRef']);

/** The narrative with the excluded markup removed, pruning what becomes empty. */
export function canonicalNarrative(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items = value.map(canonicalNarrative).filter((v) => v !== undefined);
    return items.length > 0 ? items : undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (NARRATIVE_EXCLUDED_ATTRIBUTES.has(k) || NARRATIVE_EXCLUDED_ELEMENTS.has(k)) continue;
    const kept = canonicalNarrative(v);
    if (kept !== undefined) out[k] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function extractNarrativeQuads(
  sectionText: any,
  sectionLoincCode: string,
  documentType: string,
  documentContext: NarrativeDocumentContext,
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

  // A section narrative has no `<id>` of its own, so it takes the door with no
  // source id and is named from: the document context (above), the section
  // code, and a digest of the narrative itself under the canonicalisation
  // above. The digest is what makes a section whose clinical text changed a new
  // record rather than a second value on its predecessor's subject.
  //
  // The import batch label is not an input. It is ingestion, not origin (see
  // `source-identity.ts`), and by default it is the downloaded file's name, so
  // while it was in this key the same section imported from two downloads, or
  // under two `--source-system` labels, was two records.
  const narrativeDigest = contentFingerprint(canonicalNarrative(sectionText));
  const uri = ccdaRecordUri({
    type: 'ClinicalDocument',
    content: {
      section: sectionLoincCode,
      ...documentContext,
      narrative: narrativeDigest === EMPTY_SEED ? undefined : narrativeDigest,
    },
    // The narrative itself is the salvage-tier content for a section document
    // that somehow carries no section code, document context or text.
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

  // The section text, plain (LLM-ready), on the declared predicate only.
  if (narrativeStr.trim()) {
    quads.push(makeQuad(subj, namedNode(NARRATIVE_TEXT_PREDICATE), literal(narrativeStr)));
  }

  // Mark narrative-only sections
  quads.push(makeQuad(
    subj,
    namedNode(NS.cascade + 'requiresLLMExtraction'),
    literal(String(requiresLLMExtraction), namedNode(XSD_BOOLEAN)),
  ));

  return quads;
}
