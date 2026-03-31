/**
 * Turtle parsing utilities.
 *
 * Wraps the n3 library to provide Cascade-specific Turtle parsing
 * with support for Cascade Protocol namespaces.
 */

import { Parser, Store, DataFactory } from 'n3';
import type { Quad } from 'n3';
import * as fs from 'fs/promises';

const { namedNode } = DataFactory;

/** Well-known RDF predicates */
const RDF_TYPE_IRI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** Known Cascade Protocol namespace prefixes */
export const CASCADE_NAMESPACES: Record<string, string> = {
  core: 'https://ns.cascadeprotocol.org/core/v1#',
  cascade: 'https://ns.cascadeprotocol.org/core/v1#',
  health: 'https://ns.cascadeprotocol.org/health/v1#',
  clinical: 'https://ns.cascadeprotocol.org/clinical/v1#',
  pots: 'https://ns.cascadeprotocol.org/pots/v1#',
  checkup: 'https://ns.cascadeprotocol.org/checkup/v1#',
  coverage: 'https://ns.cascadeprotocol.org/coverage/v1#',
} as const;

/** Well-known non-Cascade namespaces for IRI shortening */
const WELL_KNOWN_NAMESPACES: Record<string, string> = {
  foaf: 'http://xmlns.com/foaf/0.1/',
  solid: 'http://www.w3.org/ns/solid/terms#',
  ldp: 'http://www.w3.org/ns/ldp#',
  dct: 'http://purl.org/dc/terms/',
  dcterms: 'http://purl.org/dc/terms/',
  prov: 'http://www.w3.org/ns/prov#',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  fhir: 'http://hl7.org/fhir/',
  rxnorm: 'http://www.nlm.nih.gov/research/umls/rxnorm/',
  sct: 'http://snomed.info/sct/',
  loinc: 'http://loinc.org/rdf#',
  icd10: 'http://hl7.org/fhir/sid/icd-10-cm/',
  cvx: 'http://hl7.org/fhir/sid/cvx/',
};

export interface ParseResult {
  success: boolean;
  quads: Quad[];
  store: Store;
  quadCount: number;
  prefixes: Record<string, string>;
  errors: string[];
  subjects: SubjectInfo[];
}

export interface SubjectInfo {
  uri: string;
  types: string[];
}

/**
 * Parse a Turtle string into quads and a Store.
 */
export function parseTurtle(input: string, baseIRI?: string): ParseResult {
  const parser = new Parser({ baseIRI: baseIRI ?? '' });
  const store = new Store();
  const prefixes: Record<string, string> = {};
  const errors: string[] = [];

  let quads: Quad[];
  try {
    quads = parser.parse(input, null, (prefix, prefixNode) => {
      prefixes[prefix] = prefixNode.value;
    });
    store.addQuads(quads);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      quads: [],
      store,
      quadCount: 0,
      prefixes,
      errors: [msg],
      subjects: [],
    };
  }

  // Extract subjects with their types
  const subjects = extractSubjectsWithTypes(store);

  return {
    success: true,
    quads,
    store,
    quadCount: quads.length,
    prefixes,
    errors,
    subjects,
  };
}

/**
 * Extract all subjects with their rdf:type values from a store.
 */
function extractSubjectsWithTypes(store: Store): SubjectInfo[] {
  const subjectMap = new Map<string, string[]>();

  const typeQuads = store.getQuads(null, namedNode(RDF_TYPE_IRI), null, null);
  for (const quad of typeQuads) {
    const subjectUri = quad.subject.value;
    const typeUri = quad.object.value;
    if (!subjectMap.has(subjectUri)) {
      subjectMap.set(subjectUri, []);
    }
    subjectMap.get(subjectUri)!.push(typeUri);
  }

  return Array.from(subjectMap.entries()).map(([uri, types]) => ({ uri, types }));
}

/**
 * Detect which Cascade Protocol vocabularies are used in a parsed Turtle file
 * based on prefixes and type URIs.
 */
export function detectVocabularies(result: ParseResult): string[] {
  const vocabs = new Set<string>();

  // Check prefix declarations
  for (const [, iri] of Object.entries(result.prefixes)) {
    for (const [name, ns] of Object.entries(CASCADE_NAMESPACES)) {
      if (iri === ns || iri.startsWith(ns.replace(/#$/, ''))) {
        vocabs.add(name);
      }
    }
  }

  // Check type URIs
  for (const subject of result.subjects) {
    for (const typeUri of subject.types) {
      for (const [name, ns] of Object.entries(CASCADE_NAMESPACES)) {
        if (typeUri.startsWith(ns)) {
          vocabs.add(name);
        }
      }
    }
  }

  // Also scan all quads for namespace usage (predicates, objects)
  for (const quad of result.quads) {
    const values = [quad.predicate.value, quad.object.value];
    for (const val of values) {
      for (const [name, ns] of Object.entries(CASCADE_NAMESPACES)) {
        if (val.startsWith(ns)) {
          vocabs.add(name);
        }
      }
    }
  }

  return Array.from(vocabs);
}

/**
 * Parse a Turtle file from disk.
 */
export async function parseTurtleFile(filePath: string): Promise<ParseResult> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return parseTurtle(content, `file://${filePath}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      quads: [],
      store: new Store(),
      quadCount: 0,
      prefixes: {},
      errors: [`Failed to read file ${filePath}: ${message}`],
      subjects: [],
    };
  }
}

/**
 * Return all subject URIs that have rdf:type matching the given type IRI.
 */
export function getSubjectsByType(store: Store, rdfType: string): string[] {
  const subjects = store.getSubjects(namedNode(RDF_TYPE_IRI), namedNode(rdfType), null);
  return subjects.map((s) => s.value);
}

/**
 * Return all predicate-value pairs for a given subject.
 * Returns a map of predicate IRI -> array of object values.
 */
export function getProperties(store: Store, subject: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const quads = store.getQuads(subject as never, null, null, null);

  for (const quad of quads) {
    const predicate = quad.predicate.value;
    if (!result[predicate]) {
      result[predicate] = [];
    }
    result[predicate].push(quad.object.value);
  }

  return result;
}

/**
 * Count subjects of a given rdf:type.
 */
export function countSubjectsByType(store: Store, rdfType: string): number {
  return store.countQuads(null, namedNode(RDF_TYPE_IRI), namedNode(rdfType), null);
}

/**
 * Get all unique rdf:type values in the store.
 */
export function getAllTypes(store: Store): string[] {
  const objects = store.getObjects(null, namedNode(RDF_TYPE_IRI), null);
  const types = new Set<string>();
  for (const obj of objects) {
    types.add(obj.value);
  }
  return Array.from(types);
}

/**
 * Shorten a full IRI using known Cascade namespace prefixes.
 * Returns the prefixed form (e.g., "clinical:Medication") or the full IRI if no match.
 */
export function shortenIRI(iri: string, prefixes?: Record<string, string>): string {
  const allPrefixes: Record<string, string> = {
    ...CASCADE_NAMESPACES,
    ...WELL_KNOWN_NAMESPACES,
    ...(prefixes ?? {}),
  };

  for (const [prefix, namespace] of Object.entries(allPrefixes)) {
    if (iri.startsWith(namespace)) {
      return `${prefix}:${iri.slice(namespace.length)}`;
    }
  }
  return iri;
}

/**
 * Extract a human-readable label for a record from its properties.
 * Tries common name predicates in order of preference.
 */
export function extractLabel(props: Record<string, string[]>): string | undefined {
  const namePredicates = [
    CASCADE_NAMESPACES.health + 'medicationName',
    CASCADE_NAMESPACES.health + 'conditionName',
    CASCADE_NAMESPACES.health + 'allergen',
    CASCADE_NAMESPACES.clinical + 'supplementName',
    CASCADE_NAMESPACES.clinical + 'vaccineName',
    CASCADE_NAMESPACES.health + 'vaccineName',
    CASCADE_NAMESPACES.health + 'testName',
    CASCADE_NAMESPACES.health + 'labTestName',
    CASCADE_NAMESPACES.clinical + 'planName',
    CASCADE_NAMESPACES.cascade + 'planName',
    'http://xmlns.com/foaf/0.1/name',
    'http://xmlns.com/foaf/0.1/givenName',
    'http://purl.org/dc/terms/title',
  ];

  for (const pred of namePredicates) {
    if (props[pred]?.[0]) {
      return props[pred][0];
    }
  }
  return undefined;
}
