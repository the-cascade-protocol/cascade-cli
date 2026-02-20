/**
 * SHACL validation utilities.
 *
 * Wraps rdf-validate-shacl to validate RDF data against
 * Cascade Protocol SHACL shapes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Store } from 'n3';
import SHACLValidator from 'rdf-validate-shacl';
import { parseTurtle, detectVocabularies, CASCADE_NAMESPACES } from './turtle-parser.js';
import type { ParseResult } from './turtle-parser.js';

export interface ValidationResult {
  valid: boolean;
  file: string;
  results: ValidationIssue[];
  shapesUsed: string[];
  quadCount: number;
  subjects: Array<{ uri: string; types: string[] }>;
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

  for (const file of files) {
    const filePath = path.join(shapesDir, file);
    const fileStore = loadTurtleFile(filePath);
    for (const quad of fileStore) {
      store.addQuad(quad);
    }
    shapeFiles.push(file);
  }

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
      quadCount: 0,
      subjects: [],
    };
  }

  // Detect vocabularies used so we can report which shapes apply
  const vocabsUsed = detectVocabularies(parseResult);
  const shapesUsed = shapeFiles.filter((f) => {
    const vocabName = f.replace('.shapes.ttl', '');
    return vocabsUsed.includes(vocabName);
  });

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
    quadCount: parseResult.quadCount,
    subjects: parseResult.subjects,
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
 */
export function validateFile(
  filePath: string,
  shapesStore: Store,
  shapeFiles: string[],
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
      quadCount: 0,
      subjects: [],
    };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
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
