/**
 * SHACL validation utilities.
 *
 * Wraps rdf-validate-shacl to validate RDF data against
 * Cascade Protocol SHACL shapes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Store, DataFactory } from 'n3';
import type { Term } from '@rdfjs/types';
import SHACLValidator from 'rdf-validate-shacl';
import {
  parseTurtle,
  collectSubClassOfEdges,
  expandToSuperClasses,
  CASCADE_NAMESPACES,
  RDF_TYPE_IRI,
} from './turtle-parser.js';
import type { ParseResult } from './turtle-parser.js';
import { readResource } from './pod-encryption.js';

const { namedNode } = DataFactory;

export interface ValidationResult {
  valid: boolean;
  file: string;
  results: ValidationIssue[];
  /**
   * Shape *files* that contributed at least one shape which selected a focus
   * node in this data graph. This is derived from actual target resolution, not
   * from which prefixes the file happens to declare.
   */
  shapesUsed: string[];
  /** Local names of the individual shapes that selected at least one focus node. */
  shapesFired: string[];
  quadCount: number;
  subjects: Array<{ uri: string; types: string[] }>;
  /** How much of the data graph any loaded shape actually applied to. */
  coverage: ShapeCoverage;
}

/**
 * How much of a data graph the loaded shapes actually reached.
 *
 * A file whose subjects match no `sh:targetClass` runs zero constraints, so a
 * conforming SHACL report on it means "nothing was checked", not "everything is
 * correct". Reporting that difference is the point of this structure.
 */
export interface ShapeCoverage {
  /** Subjects in the data graph carrying at least one `rdf:type`. */
  totalSubjects: number;
  /** Of those, the number selected as a focus node by at least one shape. */
  checkedSubjects: number;
  /** The typed subjects no loaded shape applies to. */
  unshapedSubjects: Array<{ uri: string; types: string[] }>;
  /**
   * Counts of the `rdf:type` values carried by unshaped subjects, sorted by
   * descending count then by type IRI so the output is deterministic.
   */
  unshapedTypes: Array<{ type: string; count: number }>;
}

export interface ValidationIssue {
  severity: 'violation' | 'warning' | 'info';
  shape: string;
  property: string;
  message: string;
  focusNode?: string;
  value?: string;
  specLink?: string;
}

/** Mapping from shape file prefixes to their documentation base URLs */
const SPEC_BASE_URLS: Record<string, string> = {
  core: 'https://cascadeprotocol.org/docs/core/v1',
  health: 'https://cascadeprotocol.org/docs/health/v1',
  clinical: 'https://cascadeprotocol.org/docs/clinical/v1',
  pots: 'https://cascadeprotocol.org/docs/pots/v1',
  checkup: 'https://cascadeprotocol.org/docs/checkup/v1',
  coverage: 'https://cascadeprotocol.org/docs/coverage/v1',
};

/**
 * Resolve the bundled shapes directory.
 * Works from both src/ (dev via tsx) and dist/ (built).
 */
function getShapesDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // When running from dist/lib/, shapes are at dist/shapes/
  // When running from src/lib/ (dev), shapes are at src/shapes/
  const shapesDir = path.resolve(__dirname, '..', 'shapes');

  if (!fs.existsSync(shapesDir)) {
    throw new Error(
      `Shapes directory not found at ${shapesDir}. ` +
        'Run "npm run build" to bundle shapes.',
    );
  }
  return shapesDir;
}

/** SHACL and RDF terms needed to resolve targets without re-running the engine. */
const SH = 'http://www.w3.org/ns/shacl#';
const SH_TARGET_CLASS = `${SH}targetClass`;
const SH_TARGET_NODE = `${SH}targetNode`;
const SH_TARGET_SUBJECTS_OF = `${SH}targetSubjectsOf`;
const SH_TARGET_OBJECTS_OF = `${SH}targetObjectsOf`;
const SH_NODE_SHAPE = `${SH}NodeShape`;
const SH_PROPERTY = `${SH}property`;
const SH_NODE = `${SH}node`;
const SH_PATH = `${SH}path`;
/** Logical constraint components whose members are themselves shapes. */
const SH_LOGICAL = [`${SH}or`, `${SH}and`, `${SH}xone`, `${SH}not`];
const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';
const RDF_REST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest';
const RDF_NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';

/**
 * The `sh:target*` declarations of a loaded shapes graph, inverted so a data
 * node can be resolved to the shapes that select it.
 */
interface ShapeIndex {
  /** target class IRI -> shape IRIs declaring `sh:targetClass` on it */
  byClass: Map<string, string[]>;
  /** `sh:targetNode` node IRI -> shape IRIs */
  byNode: Map<string, string[]>;
  /** `sh:targetSubjectsOf` predicate IRI -> shape IRIs */
  bySubjectsOf: Map<string, string[]>;
  /** `sh:targetObjectsOf` predicate IRI -> shape IRIs */
  byObjectsOf: Map<string, string[]>;
  /** shape IRI -> the `*.shapes.ttl` that declares it, when known */
  fileOfShape: Map<string, string>;
}

/**
 * Shape indexes are derived once per loaded shapes graph and reused across every
 * file in a run. Keyed weakly on the store so callers keep their existing
 * `loadShapes()` / `validateFile()` signatures.
 */
const shapeIndexCache = new WeakMap<Store, ShapeIndex>();
/** Shape-IRI to shape-file attribution, recorded by `loadShapes`. */
const shapeFileAttribution = new WeakMap<Store, Map<string, string>>();

function pushInto(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * Invert the `sh:target*` declarations of a shapes graph.
 */
function buildShapeIndex(shapesStore: Store): ShapeIndex {
  const index: ShapeIndex = {
    byClass: new Map(),
    byNode: new Map(),
    bySubjectsOf: new Map(),
    byObjectsOf: new Map(),
    fileOfShape: shapeFileAttribution.get(shapesStore) ?? new Map(),
  };

  const targetPredicates: Array<[string, Map<string, string[]>]> = [
    [SH_TARGET_CLASS, index.byClass],
    [SH_TARGET_NODE, index.byNode],
    [SH_TARGET_SUBJECTS_OF, index.bySubjectsOf],
    [SH_TARGET_OBJECTS_OF, index.byObjectsOf],
  ];

  for (const [predicate, target] of targetPredicates) {
    for (const quad of shapesStore.getQuads(null, namedNode(predicate), null, null)) {
      pushInto(target, quad.object.value, quad.subject.value);
    }
  }

  return index;
}

function getShapeIndex(shapesStore: Store): ShapeIndex {
  let index = shapeIndexCache.get(shapesStore);
  if (!index) {
    index = buildShapeIndex(shapesStore);
    shapeIndexCache.set(shapesStore, index);
  }
  return index;
}

/**
 * Read an RDF collection (`rdf:first`/`rdf:rest` chain) into an array of terms.
 * Returns an empty array for a node that is not a list head.
 *
 * Terms are carried rather than IRI strings throughout target resolution: SHACL
 * property shapes and logical-constraint members are overwhelmingly blank
 * nodes, and rebuilding a blank node as a named node silently matches nothing.
 */
function readRdfList(store: Store, head: Term): Term[] {
  const items: Term[] = [];
  const seen = new Set<string>();
  let current: Term | undefined = head;

  while (current && current.value !== RDF_NIL && !seen.has(current.value)) {
    seen.add(current.value);
    const first = store.getObjects(current, namedNode(RDF_FIRST), null);
    if (first.length === 0) break;
    items.push(first[0]);
    const rest = store.getObjects(current, namedNode(RDF_REST), null);
    if (rest.length === 0) break;
    current = rest[0];
  }
  return items;
}

/**
 * Resolve the values of a SHACL property path from a focus node.
 *
 * Supports the two path forms the Cascade shapes use: a plain predicate IRI and
 * a sequence path (an RDF list of predicate IRIs). Other SHACL path forms
 * (inverse, alternative, zeroOrMore, ...) are not currently authored in any
 * Cascade vocabulary; they resolve to no values here, which can only ever make
 * coverage reporting more conservative (a node reported as unshaped), never
 * less.
 */
function resolvePathValues(dataStore: Store, focus: Term, pathNode: Term): Term[] {
  const sequence = readRdfList(dataStore, pathNode);
  const steps = sequence.length > 0 ? sequence : [pathNode];

  let current: Term[] = [focus];
  for (const step of steps) {
    const next: Term[] = [];
    for (const node of current) {
      for (const obj of dataStore.getObjects(node, step, null)) {
        next.push(obj);
      }
    }
    if (next.length === 0) return [];
    current = next;
  }
  return current;
}

/**
 * Given a shape that has fired on a focus node, find the shapes it hands work
 * off to via `sh:node`, together with the focus nodes they receive.
 *
 * Traverses `sh:property` (applying `sh:path` to reach new focus nodes), direct
 * `sh:node` on the shape itself, and the members of `sh:or`/`sh:and`/`sh:xone`/
 * `sh:not`. This matters because a node reached only through a parent shape's
 * `sh:node` *is* validated, and reporting it as having "no applicable shape"
 * would be the same false report this module exists to remove.
 */
function expandShape(
  shapesStore: Store,
  dataStore: Store,
  shape: Term,
  focus: Term,
): Array<[Term, Term]> {
  const out: Array<[Term, Term]> = [];
  // Nested shape structure reachable without changing the focus node.
  const sameFocus = new Set<string>([shape.value]);
  const stack: Term[] = [shape];

  while (stack.length > 0) {
    const current = stack.pop() as Term;

    // sh:node directly on this shape keeps the focus node.
    for (const child of shapesStore.getObjects(current, namedNode(SH_NODE), null)) {
      out.push([child, focus]);
    }

    // Logical constraint members are shapes over the same focus node.
    for (const predicate of SH_LOGICAL) {
      for (const member of shapesStore.getObjects(current, namedNode(predicate), null)) {
        const listed = readRdfList(shapesStore, member);
        const members = listed.length > 0 ? listed : [member];
        for (const m of members) {
          if (!sameFocus.has(m.value)) {
            sameFocus.add(m.value);
            stack.push(m);
          }
        }
      }
    }

    // Property shapes move the focus along sh:path.
    for (const prop of shapesStore.getObjects(current, namedNode(SH_PROPERTY), null)) {
      const paths = shapesStore.getObjects(prop, namedNode(SH_PATH), null);
      if (paths.length === 0) continue;
      const children = shapesStore.getObjects(prop, namedNode(SH_NODE), null);
      if (children.length === 0) continue;
      const values = resolvePathValues(dataStore, focus, paths[0]);
      for (const child of children) {
        for (const value of values) {
          out.push([child, value]);
        }
      }
    }
  }

  return out;
}

/**
 * Determine which subjects of a data graph any loaded shape actually applies to.
 *
 * Class targets are resolved per SHACL 2.1.3.1: a node is targeted by
 * `sh:targetClass C` when its `rdf:type` is `C` or any class reaching `C`
 * through `rdfs:subClassOf*`. The subclass hierarchy is read from the **data
 * graph**, which is what the SHACL specification says ("SHACL instance ... in
 * that graph") and what the underlying engine does. An `rdfs:subClassOf` axiom
 * that exists only in the ontology therefore does not activate a superclass
 * shape, and this function deliberately reports that state of affairs rather
 * than papering over it.
 *
 * https://www.w3.org/TR/shacl/#targetClass
 */
export function computeShapeCoverage(
  parseResult: ParseResult,
  shapesStore: Store,
): { coverage: ShapeCoverage; firedShapes: Set<string> } {
  const index = getShapeIndex(shapesStore);
  const dataStore = parseResult.store;
  const subClassEdges = collectSubClassOfEdges(dataStore);

  const firedShapes = new Set<string>();
  const checkedNodes = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<[Term, Term]> = [];

  // sh:targetClass, honouring rdfs:subClassOf*.
  for (const quad of dataStore.getQuads(null, namedNode(RDF_TYPE_IRI), null, null)) {
    for (const cls of expandToSuperClasses(quad.object.value, subClassEdges)) {
      for (const shape of index.byClass.get(cls) ?? []) {
        queue.push([namedNode(shape), quad.subject]);
      }
    }
  }

  // sh:targetNode.
  for (const [node, shapes] of index.byNode) {
    const term = namedNode(node);
    if (dataStore.countQuads(term, null, null, null) > 0) {
      for (const shape of shapes) queue.push([namedNode(shape), term]);
    }
  }

  // sh:targetSubjectsOf / sh:targetObjectsOf.
  if (index.bySubjectsOf.size > 0 || index.byObjectsOf.size > 0) {
    for (const quad of dataStore.getQuads(null, null, null, null)) {
      for (const shape of index.bySubjectsOf.get(quad.predicate.value) ?? []) {
        queue.push([namedNode(shape), quad.subject]);
      }
      for (const shape of index.byObjectsOf.get(quad.predicate.value) ?? []) {
        queue.push([namedNode(shape), quad.object]);
      }
    }
  }

  // Propagate through sh:node so nodes validated via a parent shape count as
  // checked.
  while (queue.length > 0) {
    const [shape, focus] = queue.pop() as [Term, Term];
    const key = `${shape.value} ${focus.value}`;
    if (visited.has(key)) continue;
    visited.add(key);

    firedShapes.add(shape.value);
    checkedNodes.add(focus.value);

    for (const next of expandShape(shapesStore, dataStore, shape, focus)) {
      queue.push(next);
    }
  }

  const unshapedSubjects = parseResult.subjects.filter((s) => !checkedNodes.has(s.uri));

  const typeCounts = new Map<string, number>();
  for (const subject of unshapedSubjects) {
    for (const type of subject.types) {
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    }
  }
  const unshapedTypes = Array.from(typeCounts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => (b.count - a.count) || a.type.localeCompare(b.type));

  return {
    coverage: {
      totalSubjects: parseResult.subjects.length,
      checkedSubjects: parseResult.subjects.length - unshapedSubjects.length,
      unshapedSubjects,
      unshapedTypes,
    },
    firedShapes,
  };
}

/**
 * Load and parse a Turtle file into an N3 Store.
 */
function loadTurtleFile(filePath: string): Store {
  const content = fs.readFileSync(filePath, 'utf-8');
  const parser = new Parser({ baseIRI: '' });
  const store = new Store();
  const quads = parser.parse(content);
  store.addQuads(quads);
  return store;
}

/**
 * Collect the IRIs of the shapes a single shapes file declares: anything typed
 * `sh:NodeShape`, plus anything carrying a `sh:target*` declaration.
 */
function collectDeclaredShapes(fileStore: Store): string[] {
  const shapes = new Set<string>();

  for (const quad of fileStore.getQuads(
    null,
    namedNode(RDF_TYPE_IRI),
    namedNode(SH_NODE_SHAPE),
    null,
  )) {
    if (quad.subject.termType === 'NamedNode') shapes.add(quad.subject.value);
  }

  for (const predicate of [
    SH_TARGET_CLASS,
    SH_TARGET_NODE,
    SH_TARGET_SUBJECTS_OF,
    SH_TARGET_OBJECTS_OF,
  ]) {
    for (const quad of fileStore.getQuads(null, namedNode(predicate), null, null)) {
      if (quad.subject.termType === 'NamedNode') shapes.add(quad.subject.value);
    }
  }

  return Array.from(shapes);
}

/**
 * Load all bundled SHACL shapes from the shapes directory into a single store.
 * If a custom shapes path is provided, load from there instead.
 */
export function loadShapes(customShapesPath?: string): { store: Store; shapeFiles: string[] } {
  const shapesDir = customShapesPath ?? getShapesDir();
  const store = new Store();
  const shapeFiles: string[] = [];

  if (!fs.existsSync(shapesDir)) {
    throw new Error(`Shapes directory not found: ${shapesDir}`);
  }

  const files = fs.readdirSync(shapesDir).filter((f) => f.endsWith('.shapes.ttl'));

  if (files.length === 0) {
    throw new Error(`No SHACL shape files (*.shapes.ttl) found in ${shapesDir}`);
  }

  // Which file declares which shape. Merging every file into one store loses
  // that, and it is what lets a run report the shape files that actually fired.
  const fileOfShape = new Map<string, string>();

  for (const file of files) {
    const filePath = path.join(shapesDir, file);
    const fileStore = loadTurtleFile(filePath);
    for (const shape of collectDeclaredShapes(fileStore)) {
      if (!fileOfShape.has(shape)) fileOfShape.set(shape, file);
    }
    for (const quad of fileStore) {
      store.addQuad(quad);
    }
    shapeFiles.push(file);
  }

  shapeFileAttribution.set(store, fileOfShape);

  // Also load vocabulary/ontology files so the validator knows about class hierarchies
  const vocabFiles = fs.readdirSync(shapesDir).filter(
    (f) => f.endsWith('.ttl') && !f.endsWith('.shapes.ttl'),
  );

  for (const file of vocabFiles) {
    const filePath = path.join(shapesDir, file);
    const fileStore = loadTurtleFile(filePath);
    for (const quad of fileStore) {
      store.addQuad(quad);
    }
  }

  return { store, shapeFiles };
}

/**
 * Generate a spec link from a shape URI.
 *
 * Examples:
 *   https://ns.cascadeprotocol.org/clinical/v1#MedicationShape
 *     -> https://cascadeprotocol.org/docs/clinical/v1#Medication
 *   https://ns.cascadeprotocol.org/health/v1#SelfReportShape
 *     -> https://cascadeprotocol.org/docs/health/v1#SelfReport
 */
function generateSpecLink(shapeUri: string): string | undefined {
  for (const [vocab, ns] of Object.entries(CASCADE_NAMESPACES)) {
    if (shapeUri.startsWith(ns)) {
      const localName = shapeUri.slice(ns.length);
      // Remove "Shape" suffix for the spec link
      const className = localName.replace(/Shape$/, '');
      const baseUrl = SPEC_BASE_URLS[vocab];
      if (baseUrl) {
        return `${baseUrl}#${className}`;
      }
    }
  }
  return undefined;
}

/**
 * Map SHACL severity URI to our severity level.
 */
function mapSeverity(severityUri: string): 'violation' | 'warning' | 'info' {
  if (severityUri.endsWith('#Violation') || severityUri.endsWith('Violation')) {
    return 'violation';
  }
  if (severityUri.endsWith('#Warning') || severityUri.endsWith('Warning')) {
    return 'warning';
  }
  if (severityUri.endsWith('#Info') || severityUri.endsWith('Info')) {
    return 'info';
  }
  // Default to violation for unknown severity
  return 'violation';
}

/**
 * Extract a human-readable name from a URI by taking the fragment or last path segment.
 */
function uriToName(uri: string): string {
  if (uri.includes('#')) {
    return uri.split('#').pop() ?? uri;
  }
  return uri.split('/').pop() ?? uri;
}

/** Coverage placeholder for results produced without a parsed data graph. */
function emptyCoverage(): ShapeCoverage {
  return { totalSubjects: 0, checkedSubjects: 0, unshapedSubjects: [], unshapedTypes: [] };
}

/**
 * Validate an already-parsed Turtle file against SHACL shapes.
 */
export function validateParsed(
  parseResult: ParseResult,
  shapesStore: Store,
  shapeFiles: string[],
  filePath: string,
): ValidationResult {
  if (!parseResult.success) {
    return {
      valid: false,
      file: filePath,
      results: parseResult.errors.map((err) => ({
        severity: 'violation' as const,
        shape: '',
        property: '',
        message: `Parse error: ${err}`,
      })),
      shapesUsed: [],
      shapesFired: [],
      quadCount: 0,
      subjects: [],
      coverage: emptyCoverage(),
    };
  }

  // Work out which shapes actually select a focus node in this data graph. Only
  // those ran constraints; naming any other shape would claim work that never
  // happened.
  const { coverage, firedShapes } = computeShapeCoverage(parseResult, shapesStore);
  const index = getShapeIndex(shapesStore);

  const firedFiles = new Set<string>();
  for (const shape of firedShapes) {
    const file = index.fileOfShape.get(shape);
    if (file) firedFiles.add(file);
  }
  const shapesUsed = shapeFiles.filter((f) => firedFiles.has(f));
  const shapesFired = Array.from(firedShapes, uriToName).sort((a, b) => a.localeCompare(b));

  // Run SHACL validation
  const validator = new SHACLValidator(shapesStore, { allowNamedNodeInList: true });
  const report = validator.validate(parseResult.store);

  // Map results to our interface
  const issues: ValidationIssue[] = [];

  for (const result of report.results) {
    const severityUri = result.severity?.value ?? '';
    const severity = mapSeverity(severityUri);

    const shapeUri = result.sourceShape?.value ?? '';
    const pathUri = result.path?.value ?? '';
    const focusNodeUri = result.focusNode?.value ?? '';
    const valueStr = result.value?.value;

    // Get the message - result.message is an array of Terms
    const messages = result.message ?? [];
    const messageText = messages.length > 0
      ? messages.map((m) => m.value).join('; ')
      : `Constraint violation on ${uriToName(pathUri)} of ${uriToName(shapeUri)}`;

    const specLink = generateSpecLink(shapeUri);

    issues.push({
      severity,
      shape: uriToName(shapeUri),
      property: uriToName(pathUri),
      message: messageText,
      focusNode: focusNodeUri || undefined,
      value: valueStr,
      specLink,
    });
  }

  return {
    valid: report.conforms,
    file: filePath,
    results: issues,
    shapesUsed,
    shapesFired,
    quadCount: parseResult.quadCount,
    subjects: parseResult.subjects,
    coverage,
  };
}

/**
 * Validate a Turtle string against SHACL shapes.
 */
export function validateTurtle(
  turtleContent: string,
  shapesStore: Store,
  shapeFiles: string[],
  filePath: string,
): ValidationResult {
  const parseResult = parseTurtle(turtleContent);
  return validateParsed(parseResult, shapesStore, shapeFiles, filePath);
}

/**
 * Validate a Turtle file against SHACL shapes.
 *
 * When `dek` is supplied, the file is decrypted (combined AES-256-GCM layout)
 * before parsing; otherwise it is read as plaintext UTF-8.
 */
export function validateFile(
  filePath: string,
  shapesStore: Store,
  shapeFiles: string[],
  dek?: Buffer,
): ValidationResult {
  if (!fs.existsSync(filePath)) {
    return {
      valid: false,
      file: filePath,
      results: [{
        severity: 'violation',
        shape: '',
        property: '',
        message: `File not found: ${filePath}`,
      }],
      shapesUsed: [],
      shapesFired: [],
      quadCount: 0,
      subjects: [],
      coverage: emptyCoverage(),
    };
  }

  const content = dek
    ? readResource(filePath, dek)
    : fs.readFileSync(filePath, 'utf-8');
  return validateTurtle(content, shapesStore, shapeFiles, filePath);
}

/**
 * Recursively find all .ttl files in a directory.
 */
export function findTurtleFiles(dirPath: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden directories and node_modules
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          walk(fullPath);
        }
      } else if (entry.isFile() && entry.name.endsWith('.ttl')) {
        results.push(fullPath);
      }
    }
  }

  walk(dirPath);
  return results.sort();
}
