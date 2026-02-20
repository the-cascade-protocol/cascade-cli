/**
 * Shared helpers for pod subcommands.
 *
 * Includes file-system utilities, the data type registry, parsing helpers,
 * and display-formatting functions used by multiple pod subcommands.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  parseTurtleFile,
  getProperties,
  shortenIRI,
  extractLabel,
  CASCADE_NAMESPACES,
} from '../../lib/turtle-parser.js';

// ─── Data Type Registry ──────────────────────────────────────────────────────

/**
 * Known data file types and the rdf:type IRIs that identify records in them.
 */
export interface DataTypeInfo {
  label: string;
  rdfTypes: string[];
  directory: 'clinical' | 'wellness';
  filename: string;
}

export const DATA_TYPES: Record<string, DataTypeInfo> = {
  medications: {
    label: 'Medications',
    rdfTypes: [CASCADE_NAMESPACES.health + 'MedicationRecord'],
    directory: 'clinical',
    filename: 'medications.ttl',
  },
  conditions: {
    label: 'Conditions',
    rdfTypes: [CASCADE_NAMESPACES.health + 'ConditionRecord'],
    directory: 'clinical',
    filename: 'conditions.ttl',
  },
  allergies: {
    label: 'Allergies',
    rdfTypes: [CASCADE_NAMESPACES.health + 'AllergyRecord'],
    directory: 'clinical',
    filename: 'allergies.ttl',
  },
  'lab-results': {
    label: 'Lab Results',
    rdfTypes: [CASCADE_NAMESPACES.health + 'LabResultRecord'],
    directory: 'clinical',
    filename: 'lab-results.ttl',
  },
  immunizations: {
    label: 'Immunizations',
    rdfTypes: [CASCADE_NAMESPACES.health + 'ImmunizationRecord'],
    directory: 'clinical',
    filename: 'immunizations.ttl',
  },
  'vital-signs': {
    label: 'Vital Signs',
    rdfTypes: [CASCADE_NAMESPACES.clinical + 'VitalSign'],
    directory: 'clinical',
    filename: 'vital-signs.ttl',
  },
  insurance: {
    label: 'Insurance',
    rdfTypes: [CASCADE_NAMESPACES.clinical + 'CoverageRecord'],
    directory: 'clinical',
    filename: 'insurance.ttl',
  },
  'patient-profile': {
    label: 'Patient Profile',
    rdfTypes: [CASCADE_NAMESPACES.cascade + 'PatientProfile'],
    directory: 'clinical',
    filename: 'patient-profile.ttl',
  },
  'heart-rate': {
    label: 'Heart Rate',
    rdfTypes: [CASCADE_NAMESPACES.health + 'DailyVitalReading', CASCADE_NAMESPACES.health + 'HeartRateData'],
    directory: 'wellness',
    filename: 'heart-rate.ttl',
  },
  'blood-pressure': {
    label: 'Blood Pressure',
    rdfTypes: [
      'http://hl7.org/fhir/Observation',
      CASCADE_NAMESPACES.health + 'BloodPressureData',
    ],
    directory: 'wellness',
    filename: 'blood-pressure.ttl',
  },
  activity: {
    label: 'Activity',
    rdfTypes: [CASCADE_NAMESPACES.health + 'DailyActivitySnapshot', CASCADE_NAMESPACES.health + 'ActivityData'],
    directory: 'wellness',
    filename: 'activity.ttl',
  },
  sleep: {
    label: 'Sleep',
    rdfTypes: [CASCADE_NAMESPACES.health + 'DailySleepSnapshot', CASCADE_NAMESPACES.health + 'SleepData'],
    directory: 'wellness',
    filename: 'sleep.ttl',
  },
  supplements: {
    label: 'Supplements',
    rdfTypes: [CASCADE_NAMESPACES.clinical + 'Supplement'],
    directory: 'wellness',
    filename: 'supplements.ttl',
  },
};

// Re-export CASCADE_NAMESPACES for convenience
export { CASCADE_NAMESPACES };

// ─── File-System Helpers ─────────────────────────────────────────────────────

/**
 * Resolve a pod directory path to an absolute path.
 */
export function resolvePodDir(podDir: string): string {
  return path.resolve(process.cwd(), podDir);
}

/**
 * Check if a path exists and is a directory.
 */
export async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if a file exists.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover all TTL files in a pod directory recursively.
 */
export async function discoverTtlFiles(podDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.ttl')) {
        files.push(fullPath);
      }
    }
  }

  await walk(podDir);
  return files.sort();
}

// ─── Parsing Helpers ─────────────────────────────────────────────────────────

/**
 * Parse a single TTL file and extract typed records.
 */
export async function parseDataFile(filePath: string): Promise<{
  records: Array<{
    id: string;
    type: string;
    label: string | undefined;
    properties: Record<string, string>;
  }>;
  totalQuads: number;
  error?: string;
}> {
  const result = await parseTurtleFile(filePath);
  if (!result.success) {
    return { records: [], totalQuads: 0, error: result.errors.join('; ') };
  }

  const records: Array<{
    id: string;
    type: string;
    label: string | undefined;
    properties: Record<string, string>;
  }> = [];

  for (const subject of result.subjects) {
    // Skip blank nodes that are just structural (e.g., nested blank nodes for provenance)
    // Keep named subjects (URNs, URIs) and typed blank nodes with meaningful types
    const meaningfulTypes = subject.types.filter(
      (t) =>
        !t.startsWith('http://www.w3.org/ns/prov#') &&
        t !== 'http://www.w3.org/ns/solid/terms#TypeRegistration' &&
        t !== 'http://www.w3.org/ns/solid/terms#TypeIndex' &&
        t !== 'http://www.w3.org/ns/solid/terms#ListedDocument' &&
        t !== 'http://www.w3.org/ns/solid/terms#UnlistedDocument' &&
        t !== 'http://www.w3.org/ns/ldp#BasicContainer',
    );

    if (meaningfulTypes.length === 0) continue;

    const props = getProperties(result.store, subject.uri);
    const label = extractLabel(props);

    // Flatten properties for display (take first value of each, shorten IRIs)
    const flatProps: Record<string, string> = {};
    for (const [pred, values] of Object.entries(props)) {
      const shortPred = shortenIRI(pred);
      // Skip rdf:type since we have it separately
      if (pred === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') continue;
      flatProps[shortPred] = values.length === 1 ? values[0] : values.join(', ');
    }

    records.push({
      id: subject.uri,
      type: shortenIRI(meaningfulTypes[0]),
      label,
      properties: flatProps,
    });
  }

  return { records, totalQuads: result.quadCount };
}

/**
 * Read the patient profile from a pod to extract name, age, schema version.
 */
export async function readPatientProfile(podDir: string): Promise<{
  name?: string;
  age?: string;
  schemaVersion?: string;
  dateOfBirth?: string;
}> {
  // Try clinical/patient-profile.ttl first, then profile/card.ttl
  const profilePaths = [
    path.join(podDir, 'clinical', 'patient-profile.ttl'),
    path.join(podDir, 'profile', 'card.ttl'),
  ];

  let name: string | undefined;
  let age: string | undefined;
  let schemaVersion: string | undefined;
  let dateOfBirth: string | undefined;

  for (const profilePath of profilePaths) {
    if (!(await fileExists(profilePath))) continue;

    const result = await parseTurtleFile(profilePath);
    if (!result.success) continue;

    for (const subject of result.subjects) {
      const props = getProperties(result.store, subject.uri);
      if (!name) {
        name = props['http://xmlns.com/foaf/0.1/name']?.[0];
      }
      if (!age) {
        age = props[CASCADE_NAMESPACES.cascade + 'computedAge']?.[0];
      }
      if (!schemaVersion) {
        schemaVersion = props[CASCADE_NAMESPACES.cascade + 'schemaVersion']?.[0];
      }
      if (!dateOfBirth) {
        dateOfBirth = props[CASCADE_NAMESPACES.cascade + 'dateOfBirth']?.[0];
      }
    }
  }

  return { name, age, schemaVersion, dateOfBirth };
}

// ─── Display Helpers ─────────────────────────────────────────────────────────

/**
 * Normalize provenance label for consistent display.
 * Converts "core:ClinicalGenerated" to "cascade:ClinicalGenerated" since
 * the "core" and "cascade" prefixes map to the same namespace.
 */
export function normalizeProvenanceLabel(label: string): string {
  if (label.startsWith('core:')) {
    return 'cascade:' + label.slice(5);
  }
  return label;
}

/**
 * Extract a display label from already-shortened property keys.
 */
export function extractLabelFromProps(properties: Record<string, string>): string | undefined {
  const labelKeys = [
    'health:medicationName',
    'health:conditionName',
    'health:allergen',
    'clinical:supplementName',
    'clinical:vaccineName',
    'health:vaccineName',
    'health:testName',
    'health:labTestName',
    'foaf:name',
    'dcterms:title',
  ];

  for (const key of labelKeys) {
    if (properties[key]) {
      return properties[key];
    }
  }
  return undefined;
}

/**
 * Select the most relevant properties for display based on data type.
 */
export function selectKeyProperties(
  typeName: string,
  properties: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};

  // Common properties to always show if present
  const commonKeys = ['cascade:dataProvenance', 'cascade:schemaVersion'];

  // Type-specific key properties
  const typeKeys: Record<string, string[]> = {
    medications: [
      'health:dose',
      'health:frequency',
      'health:route',
      'health:isActive',
      'health:startDate',
      'health:prescriber',
      'health:rxNormCode',
      'health:medicationClass',
    ],
    conditions: [
      'health:status',
      'health:onsetDate',
      'health:icd10Code',
      'health:snomedCode',
      'health:conditionClass',
    ],
    allergies: [
      'health:allergyCategory',
      'health:reaction',
      'health:allergySeverity',
      'health:onsetDate',
    ],
    'lab-results': [
      'health:value',
      'health:unit',
      'health:referenceRange',
      'health:interpretation',
      'health:effectiveDate',
    ],
    immunizations: [
      'health:vaccineDate',
      'health:lotNumber',
      'health:site',
      'health:manufacturer',
    ],
    supplements: [
      'clinical:dose',
      'clinical:frequency',
      'clinical:form',
      'clinical:isActive',
      'clinical:evidenceStrength',
    ],
  };

  const keysToShow = [...(typeKeys[typeName] ?? []), ...commonKeys];

  for (const key of keysToShow) {
    if (properties[key]) {
      result[key] = properties[key];
    }
  }

  // If no specific keys matched, show first few properties
  if (Object.keys(result).length === 0) {
    const allKeys = Object.keys(properties);
    for (const key of allKeys.slice(0, 5)) {
      result[key] = properties[key];
    }
  }

  return result;
}

// ─── Export Helpers ──────────────────────────────────────────────────────────

/**
 * Recursively copy a directory.
 */
export async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Create a ZIP archive of the pod directory using the archiver package.
 */
export async function createZipArchive(sourceDir: string, outputPath: string): Promise<void> {
  // Dynamic import of archiver
  let archiverModule: { default: (format: string, options?: Record<string, unknown>) => import('archiver').Archiver };
  try {
    archiverModule = await import('archiver') as typeof archiverModule;
  } catch {
    throw new Error(
      'The "archiver" package is required for ZIP export. ' +
        'Install it with: npm install archiver',
    );
  }

  const { createWriteStream } = await import('fs');

  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiverModule.default('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    archive.on('error', (err: Error) => reject(err));

    archive.pipe(output);
    archive.directory(sourceDir, path.basename(sourceDir));
    void archive.finalize();
  });
}
