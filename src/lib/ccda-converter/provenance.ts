/**
 * C-CDA provenance: the source EHR / organization of origin, and a shared
 * post-pass that stamps every converted record with cascade:dataProvenance +
 * cascade:schemaVersion.
 *
 * The EHR of origin for a C-CDA is its *custodian* organization (the system that
 * holds the legal record), per HL7 CDA R2 §4.2.2.4. That is a ratified, document-
 * level signal — preferable to the import-batch label (which is how the data got
 * in, not where it came from). We derive it once per document and stamp it onto
 * the ClinicalDocument records (required by SHACL) and every structured record so
 * the source-organized Records view attributes them correctly.
 *
 * When neither custodian nor author organization names the source, we fall back
 * to the ratified FHIR/HL7 Data Absent Reason token "unknown" (SOURCE_EHR_UNKNOWN
 * from the FHIR converter) rather than fabricating a value.
 */

import type { Quad } from 'n3';
import { DataFactory } from 'n3';

import {
  NS,
  SCHEMA_VERSION,
  commonTriples,
} from '../fhir-converter/types.js';
import { SOURCE_EHR_UNKNOWN } from '../fhir-converter/provenance.js';

const { namedNode } = DataFactory;

/** Unwrap a CDA <name> element (string, array, or { '#text' } shapes). */
function nameText(name: any): string {
  if (name == null) return '';
  if (Array.isArray(name)) return nameText(name[0]);
  if (typeof name === 'string') return name.trim();
  if (typeof name === 'object') return (name['#text'] ?? '').toString().trim();
  return String(name).trim();
}

/**
 * Derive the source EHR for a parsed ClinicalDocument node.
 *
 * Priority (ratified-standards principle):
 *   1. custodian/assignedCustodian/representedCustodianOrganization/name
 *   2. author/assignedAuthor/representedOrganization/name
 *   3. SOURCE_EHR_UNKNOWN ("unknown", HL7 Data Absent Reason)
 *
 * @param ccdaDoc  the parsed ClinicalDocument node (not the document root)
 */
export function deriveSourceEhr(ccdaDoc: any): string {
  const custodianName = nameText(
    ccdaDoc?.custodian?.assignedCustodian?.representedCustodianOrganization?.name,
  );
  if (custodianName) return custodianName.slice(0, 100);

  // author may be an array (multiple authors / authoring devices)
  const authorRaw = ccdaDoc?.author;
  const authors = Array.isArray(authorRaw) ? authorRaw : authorRaw ? [authorRaw] : [];
  for (const author of authors) {
    const orgName = nameText(author?.assignedAuthor?.representedOrganization?.name);
    if (orgName) return orgName.slice(0, 100);
  }

  return SOURCE_EHR_UNKNOWN;
}

/**
 * Post-pass over a document's converted quads: for every record subject (every
 * subject carrying an rdf:type), ensure cascade:dataProvenance and
 * cascade:schemaVersion are present, adding them only when absent. Idempotent —
 * never duplicates a triple a section handler already emitted.
 */
export function ensureProvenanceQuads(quads: Quad[]): void {
  const subjects = new Set<string>();
  const hasProvenance = new Set<string>();
  const hasSchemaVersion = new Set<string>();

  for (const q of quads) {
    const p = q.predicate.value;
    if (p === NS.rdf + 'type') subjects.add(q.subject.value);
    else if (p === NS.cascade + 'dataProvenance') hasProvenance.add(q.subject.value);
    else if (p === NS.cascade + 'schemaVersion') hasSchemaVersion.add(q.subject.value);
  }

  for (const subject of subjects) {
    if (!hasProvenance.has(subject) && !hasSchemaVersion.has(subject)) {
      quads.push(...commonTriples(subject));
      continue;
    }
    // Partial coverage: add just the missing half (commonTriples emits both).
    for (const t of commonTriples(subject)) {
      const p = t.predicate.value;
      if (p === NS.cascade + 'dataProvenance' && hasProvenance.has(subject)) continue;
      if (p === NS.cascade + 'schemaVersion' && hasSchemaVersion.has(subject)) continue;
      quads.push(t);
    }
  }
}

/**
 * Stamp clinical:sourceEHR onto every record subject (every subject carrying an
 * rdf:type) that does not already have it. Document-level value derived once via
 * deriveSourceEhr(); applied uniformly so the source-organized Records view
 * attributes every structured record to its EHR of origin.
 */
export function ensureSourceEhrQuads(quads: Quad[], sourceEhr: string): void {
  if (!sourceEhr) return;
  const subjects = new Set<string>();
  const hasSourceEhr = new Set<string>();
  for (const q of quads) {
    const p = q.predicate.value;
    if (p === NS.rdf + 'type') subjects.add(q.subject.value);
    else if (p === NS.clinical + 'sourceEHR') hasSourceEhr.add(q.subject.value);
  }
  for (const subject of subjects) {
    if (!hasSourceEhr.has(subject)) {
      quads.push(
        DataFactory.quad(
          namedNode(subject),
          namedNode(NS.clinical + 'sourceEHR'),
          DataFactory.literal(sourceEhr, namedNode(NS.xsd + 'string')),
        ),
      );
    }
  }
}

export { SCHEMA_VERSION };
