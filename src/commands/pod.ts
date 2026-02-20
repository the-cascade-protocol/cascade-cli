/**
 * cascade pod <subcommand>
 *
 * Manage Cascade Pod structures.
 *
 * Subcommands:
 *   init <directory>    Initialize a new Cascade Pod
 *   query <pod-dir>     Query data within a pod
 *   export <pod-dir>    Export pod data
 *   info <pod-dir>      Show pod metadata and statistics
 *
 * Query options:
 *   --medications       Query medications
 *   --conditions        Query conditions
 *   --allergies         Query allergies
 *   --lab-results       Query lab results
 *   --immunizations     Query immunizations
 *   --vital-signs       Query vital signs
 *   --all               Query all data
 *   --json              Output as JSON
 *
 * Export options:
 *   --format <fmt>      Export format (zip|directory) [default: zip]
 *   --output <path>     Output path for export
 */

import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { printResult, printError, printVerbose, type OutputOptions } from '../lib/output.js';
import {
  parseTurtleFile,
  getSubjectsByType,
  getProperties,
  shortenIRI,
  extractLabel,
  CASCADE_NAMESPACES,
} from '../lib/turtle-parser.js';

// ─── Pod Init Templates ──────────────────────────────────────────────────────

function wellKnownSolid(absPath: string): string {
  return JSON.stringify(
    {
      '@context': 'https://www.w3.org/ns/solid/terms',
      pod_root: '/',
      profile: '/profile/card.ttl#me',
      storage: '/',
      publicTypeIndex: '/settings/publicTypeIndex.ttl',
      privateTypeIndex: '/settings/privateTypeIndex.ttl',
      podUri: `file://${absPath}/`,
      version: '1.0',
    },
    null,
    2,
  );
}

const PROFILE_CARD_TTL = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix pim: <http://www.w3.org/ns/pim/space#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

# =============================================================================
# WebID Profile Card
# =============================================================================
# This is a Solid-compatible WebID profile for the Pod owner.
# Edit this file to add patient demographics and identity information.
#
# The <#me> fragment serves as the WebID for this Pod.
# =============================================================================

<#me> a foaf:Person ;
    # ── Edit the fields below to personalize your Pod ──
    # foaf:name "First Last" ;
    # foaf:givenName "First" ;
    # foaf:familyName "Last" ;
    # cascade:dateOfBirth "1990-01-01"^^xsd:date ;

    # ── Discovery links (do not remove) ──
    solid:publicTypeIndex </settings/publicTypeIndex.ttl> ;
    solid:privateTypeIndex </settings/privateTypeIndex.ttl> ;
    pim:storage </> ;

    cascade:schemaVersion "1.3" .
`;

const PUBLIC_TYPE_INDEX_TTL = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .

# =============================================================================
# Public Type Index
# =============================================================================
# Maps data types to their storage locations in the Pod.
# Public registrations are visible to authorized applications.
#
# As you populate your Pod with data, add type registrations here so that
# agents and applications can discover where to find each data type.
# =============================================================================

<> a solid:TypeIndex, solid:ListedDocument .

# Type registrations will be added as data is populated.
# Example:
# <#medications> a solid:TypeRegistration ;
#     solid:forClass health:MedicationRecord ;
#     solid:instance </clinical/medications.ttl> .
#
# <#conditions> a solid:TypeRegistration ;
#     solid:forClass health:ConditionRecord ;
#     solid:instance </clinical/conditions.ttl> .
`;

const PRIVATE_TYPE_INDEX_TTL = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .

# =============================================================================
# Private Type Index
# =============================================================================
# Maps wellness and device data types to their storage locations.
# Private registrations require explicit authorization to access.
#
# Wellness data (heart rate, activity, sleep, etc.) is typically registered
# here rather than in the public type index.
# =============================================================================

<> a solid:TypeIndex, solid:UnlistedDocument .

# Type registrations will be added as wellness data is populated.
# Example:
# <#heartRate> a solid:TypeRegistration ;
#     solid:forClass health:HeartRateData ;
#     solid:instance </wellness/heart-rate.ttl> .
`;

function indexTtl(dirName: string): string {
  const now = new Date().toISOString();
  return `@prefix ldp: <http://www.w3.org/ns/ldp#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

# =============================================================================
# Root LDP Container
# =============================================================================
# This is the root index of this Cascade Pod, structured as an LDP Basic
# Container per Solid Protocol conventions. It enumerates every resource
# in the Pod for discoverability by agents and applications.
#
# Update this file as you add or remove resources.
# =============================================================================

<> a ldp:BasicContainer ;
    dcterms:title "${dirName} -- Cascade Pod" ;
    dcterms:description "A Cascade Protocol Pod initialized with the cascade CLI." ;
    dcterms:created "${now}"^^xsd:dateTime ;
    cascade:schemaVersion "1.3" ;

    # ── Profile & Settings ──
    ldp:contains
        <profile/card.ttl> ,
        <settings/publicTypeIndex.ttl> ,
        <settings/privateTypeIndex.ttl> .

    # ── Add clinical and wellness resources below as they are created ──
    # ldp:contains <clinical/medications.ttl> .
    # ldp:contains <wellness/heart-rate.ttl> .
`;
}

const README_MD = `# Cascade Protocol Pod

This directory is a **Cascade Protocol Pod** -- a portable, self-describing collection of personal health data serialized as RDF/Turtle files.

## Structure

\`\`\`
.well-known/
  solid              # Pod discovery document (JSON)
profile/
  card.ttl           # WebID profile (identity + discovery links)
settings/
  publicTypeIndex.ttl    # Maps clinical data types to file locations
  privateTypeIndex.ttl   # Maps wellness data types to file locations
clinical/            # Clinical records (EHR-sourced data)
wellness/            # Wellness records (device and self-reported data)
index.ttl            # Root LDP container listing all resources
\`\`\`

## Getting Started

1. Edit \`profile/card.ttl\` to set the Pod owner's name and demographics.
2. Add clinical data files (e.g., \`clinical/medications.ttl\`) and register them in \`settings/publicTypeIndex.ttl\`.
3. Add wellness data files (e.g., \`wellness/heart-rate.ttl\`) and register them in \`settings/privateTypeIndex.ttl\`.
4. Update \`index.ttl\` to list all resources.

## Useful Commands

\`\`\`bash
cascade pod info .           # Show Pod summary
cascade pod query . --all    # Query all data in the Pod
cascade pod export . --format zip   # Export as ZIP archive
cascade validate .           # Validate against SHACL shapes
\`\`\`

## Learn More

- Cascade Protocol: https://cascadeprotocol.org
- Pod Structure Spec: https://cascadeprotocol.org/docs/spec/pod-structure
- Cascade SDK: https://github.com/nickthorpe71/cascade-sdk-swift
`;

// ─── Data Type Registry ──────────────────────────────────────────────────────

/**
 * Known data file types and the rdf:type IRIs that identify records in them.
 */
interface DataTypeInfo {
  label: string;
  rdfTypes: string[];
  directory: 'clinical' | 'wellness';
  filename: string;
}

const DATA_TYPES: Record<string, DataTypeInfo> = {
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a pod directory path to an absolute path.
 */
function resolvePodDir(podDir: string): string {
  return path.resolve(process.cwd(), podDir);
}

/**
 * Check if a path exists and is a directory.
 */
async function isDirectory(dirPath: string): Promise<boolean> {
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
async function fileExists(filePath: string): Promise<boolean> {
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
async function discoverTtlFiles(podDir: string): Promise<string[]> {
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

/**
 * Parse a single TTL file and extract typed records.
 */
async function parseDataFile(filePath: string): Promise<{
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
async function readPatientProfile(podDir: string): Promise<{
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

// ─── Command Registration ────────────────────────────────────────────────────

export function registerPodCommand(program: Command): void {
  const pod = program.command('pod').description('Manage Cascade Pod structures');

  // ── cascade pod init <directory> ───────────────────────────────────────────

  pod
    .command('init')
    .description('Initialize a new Cascade Pod')
    .argument('<directory>', 'Directory to initialize as a Cascade Pod')
    .action(async (directory: string) => {
      const globalOpts = program.opts() as OutputOptions;
      const absDir = resolvePodDir(directory);
      const dirName = path.basename(absDir);

      printVerbose(`Initializing pod at: ${absDir}`, globalOpts);

      try {
        // Check if directory already has pod structure
        if (await fileExists(path.join(absDir, 'index.ttl'))) {
          printError(`Directory already contains a Cascade Pod: ${absDir}`, globalOpts);
          process.exitCode = 1;
          return;
        }

        // Create directory structure
        const dirs = [
          path.join(absDir, '.well-known'),
          path.join(absDir, 'profile'),
          path.join(absDir, 'settings'),
          path.join(absDir, 'clinical'),
          path.join(absDir, 'wellness'),
        ];

        for (const dir of dirs) {
          await fs.mkdir(dir, { recursive: true });
        }

        // Write template files
        await fs.writeFile(path.join(absDir, '.well-known', 'solid'), wellKnownSolid(absDir));
        await fs.writeFile(path.join(absDir, 'profile', 'card.ttl'), PROFILE_CARD_TTL);
        await fs.writeFile(path.join(absDir, 'settings', 'publicTypeIndex.ttl'), PUBLIC_TYPE_INDEX_TTL);
        await fs.writeFile(path.join(absDir, 'settings', 'privateTypeIndex.ttl'), PRIVATE_TYPE_INDEX_TTL);
        await fs.writeFile(path.join(absDir, 'index.ttl'), indexTtl(dirName));
        await fs.writeFile(path.join(absDir, 'README.md'), README_MD);

        const filesCreated = [
          '.well-known/solid',
          'profile/card.ttl',
          'settings/publicTypeIndex.ttl',
          'settings/privateTypeIndex.ttl',
          'clinical/',
          'wellness/',
          'index.ttl',
          'README.md',
        ];

        if (globalOpts.json) {
          printResult(
            {
              status: 'created',
              directory: absDir,
              files: filesCreated,
              message: 'Cascade Pod initialized successfully.',
            },
            globalOpts,
          );
        } else {
          console.log(`Cascade Pod initialized at: ${absDir}\n`);
          console.log('Created:');
          for (const f of filesCreated) {
            console.log(`  ${f}`);
          }
          console.log('\nNext steps:');
          console.log('  1. Edit profile/card.ttl to set patient name and demographics');
          console.log('  2. Add data files to clinical/ and wellness/ directories');
          console.log('  3. Register data types in settings/publicTypeIndex.ttl');
          console.log(`  4. Run: cascade pod info ${directory}`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        printError(`Failed to initialize pod: ${message}`, globalOpts);
        process.exitCode = 1;
      }
    });

  // ── cascade pod query <pod-dir> ────────────────────────────────────────────

  pod
    .command('query')
    .description('Query data within a pod')
    .argument('<pod-dir>', 'Path to the Cascade Pod')
    .option('--medications', 'Query medications')
    .option('--conditions', 'Query conditions')
    .option('--allergies', 'Query allergies')
    .option('--lab-results', 'Query lab results')
    .option('--immunizations', 'Query immunizations')
    .option('--vital-signs', 'Query vital signs')
    .option('--supplements', 'Query supplements')
    .option('--all', 'Query all data')
    .action(
      async (
        podDir: string,
        options: {
          medications?: boolean;
          conditions?: boolean;
          allergies?: boolean;
          labResults?: boolean;
          immunizations?: boolean;
          vitalSigns?: boolean;
          supplements?: boolean;
          all?: boolean;
        },
      ) => {
        const globalOpts = program.opts() as OutputOptions;
        const absDir = resolvePodDir(podDir);

        printVerbose(`Querying pod: ${absDir}`, globalOpts);
        printVerbose(`Filters: ${JSON.stringify(options)}`, globalOpts);

        // Validate pod exists
        if (!(await isDirectory(absDir))) {
          printError(`Pod directory not found: ${absDir}`, globalOpts);
          process.exitCode = 1;
          return;
        }

        try {
          // Determine which data types to query
          let requestedTypes: string[];

          if (options.all) {
            // Discover all TTL files in the pod
            requestedTypes = Object.keys(DATA_TYPES);
          } else {
            requestedTypes = [];
            if (options.medications) requestedTypes.push('medications');
            if (options.conditions) requestedTypes.push('conditions');
            if (options.allergies) requestedTypes.push('allergies');
            if (options.labResults) requestedTypes.push('lab-results');
            if (options.immunizations) requestedTypes.push('immunizations');
            if (options.vitalSigns) requestedTypes.push('vital-signs');
            if (options.supplements) requestedTypes.push('supplements');
          }

          if (requestedTypes.length === 0) {
            printError(
              'No query filter specified. Use --medications, --conditions, --all, etc.',
              globalOpts,
            );
            process.exitCode = 1;
            return;
          }

          // Process each requested data type
          const queryResults: Record<
            string,
            {
              count: number;
              file: string;
              records: Array<{
                id: string;
                type: string;
                properties: Record<string, string>;
              }>;
              error?: string;
            }
          > = {};

          // If --all, also discover any TTL files not in the registry
          const extraFiles: string[] = [];
          if (options.all) {
            const allTtlFiles = await discoverTtlFiles(absDir);
            const knownPaths = new Set(
              Object.values(DATA_TYPES).map((dt) =>
                path.join(absDir, dt.directory, dt.filename),
              ),
            );
            // Also exclude index.ttl, manifest.ttl, profile/card.ttl, type indexes
            const excludePaths = new Set([
              path.join(absDir, 'index.ttl'),
              path.join(absDir, 'manifest.ttl'),
              path.join(absDir, 'profile', 'card.ttl'),
              path.join(absDir, 'settings', 'publicTypeIndex.ttl'),
              path.join(absDir, 'settings', 'privateTypeIndex.ttl'),
            ]);
            for (const f of allTtlFiles) {
              if (!knownPaths.has(f) && !excludePaths.has(f)) {
                extraFiles.push(f);
              }
            }
          }

          for (const typeName of requestedTypes) {
            const typeInfo = DATA_TYPES[typeName];
            if (!typeInfo) continue;

            const filePath = path.join(absDir, typeInfo.directory, typeInfo.filename);
            if (!(await fileExists(filePath))) {
              printVerbose(`Skipping ${typeName}: file not found at ${filePath}`, globalOpts);
              continue;
            }

            const { records, error } = await parseDataFile(filePath);

            queryResults[typeName] = {
              count: records.length,
              file: `${typeInfo.directory}/${typeInfo.filename}`,
              records: records.map((r) => ({
                id: r.id,
                type: r.type,
                properties: r.properties,
              })),
              error,
            };
          }

          // Process extra files found in --all mode
          for (const extraFile of extraFiles) {
            const relPath = path.relative(absDir, extraFile);
            const baseName = path.basename(extraFile, '.ttl');

            const { records, error } = await parseDataFile(extraFile);
            if (records.length > 0) {
              queryResults[baseName] = {
                count: records.length,
                file: relPath,
                records: records.map((r) => ({
                  id: r.id,
                  type: r.type,
                  properties: r.properties,
                })),
                error,
              };
            }
          }

          // Output results
          if (globalOpts.json) {
            printResult(
              {
                pod: podDir,
                dataTypes: queryResults,
              },
              globalOpts,
            );
          } else {
            // Human-readable output
            const typeKeys = Object.keys(queryResults);
            if (typeKeys.length === 0) {
              console.log('No data found for the specified query filters.');
              return;
            }

            for (const typeName of typeKeys) {
              const data = queryResults[typeName];
              const typeInfo = DATA_TYPES[typeName];
              const displayLabel = typeInfo?.label ?? typeName;

              console.log(`\n=== ${displayLabel} (${data.count} records) ===`);
              if (data.error) {
                console.log(`  Error: ${data.error}`);
                continue;
              }
              console.log(`  File: ${data.file}\n`);

              for (let i = 0; i < data.records.length; i++) {
                const rec = data.records[i];
                const label = extractLabelFromProps(rec.properties);
                const idShort = rec.id.length > 40 ? rec.id.substring(0, 40) + '...' : rec.id;

                console.log(`  ${i + 1}. ${label ?? rec.type} (${idShort})`);

                // Show key properties
                const keyProps = selectKeyProperties(typeName, rec.properties);
                for (const [key, value] of Object.entries(keyProps)) {
                  console.log(`     ${key}: ${value}`);
                }
                console.log('');
              }
            }
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          printError(`Failed to query pod: ${message}`, globalOpts);
          process.exitCode = 1;
        }
      },
    );

  // ── cascade pod export <pod-dir> ───────────────────────────────────────────

  pod
    .command('export')
    .description('Export pod data')
    .argument('<pod-dir>', 'Path to the Cascade Pod')
    .option('--format <fmt>', 'Export format (zip|directory)', 'zip')
    .option('--output <path>', 'Output path for export')
    .action(async (podDir: string, options: { format: string; output?: string }) => {
      const globalOpts = program.opts() as OutputOptions;
      const absDir = resolvePodDir(podDir);

      printVerbose(`Exporting pod: ${absDir} as ${options.format}`, globalOpts);

      // Validate pod exists
      if (!(await isDirectory(absDir))) {
        printError(`Pod directory not found: ${absDir}`, globalOpts);
        process.exitCode = 1;
        return;
      }

      try {
        if (options.format === 'directory') {
          // Copy to new directory
          const outputDir = options.output ?? `${absDir}-export`;
          await copyDirectory(absDir, outputDir);

          if (globalOpts.json) {
            printResult(
              {
                status: 'exported',
                format: 'directory',
                source: absDir,
                output: outputDir,
              },
              globalOpts,
            );
          } else {
            console.log(`Pod exported to directory: ${outputDir}`);
          }
        } else if (options.format === 'zip') {
          // Create ZIP archive
          const outputZip =
            options.output ?? `${path.basename(absDir)}.zip`;
          const absOutputZip = path.resolve(process.cwd(), outputZip);

          await createZipArchive(absDir, absOutputZip);

          if (globalOpts.json) {
            printResult(
              {
                status: 'exported',
                format: 'zip',
                source: absDir,
                output: absOutputZip,
              },
              globalOpts,
            );
          } else {
            console.log(`Pod exported to ZIP: ${absOutputZip}`);
          }
        } else {
          printError(
            `Unknown export format: ${options.format}. Use 'zip' or 'directory'.`,
            globalOpts,
          );
          process.exitCode = 1;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        printError(`Failed to export pod: ${message}`, globalOpts);
        process.exitCode = 1;
      }
    });

  // ── cascade pod info <pod-dir> ─────────────────────────────────────────────

  pod
    .command('info')
    .description('Show pod metadata and statistics')
    .argument('<pod-dir>', 'Path to the Cascade Pod')
    .action(async (podDir: string) => {
      const globalOpts = program.opts() as OutputOptions;
      const absDir = resolvePodDir(podDir);

      printVerbose(`Getting info for pod: ${absDir}`, globalOpts);

      // Validate pod exists
      if (!(await isDirectory(absDir))) {
        printError(`Pod directory not found: ${absDir}`, globalOpts);
        process.exitCode = 1;
        return;
      }

      try {
        // Read patient profile info
        const profile = await readPatientProfile(absDir);

        // Scan data files
        const clinicalSummary: Array<{ file: string; records: number; provenance: string; label: string }> = [];
        const wellnessSummary: Array<{ file: string; records: number; provenance: string; label: string }> = [];
        const provenanceSources = new Set<string>();

        // Get last modified time of the pod
        let lastModified: Date | undefined;
        const allTtlFiles = await discoverTtlFiles(absDir);

        for (const filePath of allTtlFiles) {
          const stat = await fs.stat(filePath);
          if (!lastModified || stat.mtime > lastModified) {
            lastModified = stat.mtime;
          }
        }

        // Analyze each known data type
        for (const [, typeInfo] of Object.entries(DATA_TYPES)) {
          const filePath = path.join(absDir, typeInfo.directory, typeInfo.filename);
          if (!(await fileExists(filePath))) continue;

          const result = await parseTurtleFile(filePath);
          if (!result.success) continue;

          // Count records by type
          let recordCount = 0;
          for (const rdfType of typeInfo.rdfTypes) {
            recordCount += getSubjectsByType(result.store, rdfType).length;
          }

          // If no records found by type, count all typed subjects
          if (recordCount === 0 && result.subjects.length > 0) {
            recordCount = result.subjects.length;
          }

          // Detect provenance
          const provenanceValues = new Set<string>();
          for (const subject of result.subjects) {
            const props = getProperties(result.store, subject.uri);
            const prov = props[CASCADE_NAMESPACES.cascade + 'dataProvenance'];
            if (prov) {
              for (const p of prov) {
                const shortProv = normalizeProvenanceLabel(shortenIRI(p));
                provenanceValues.add(shortProv);
                provenanceSources.add(shortProv);
              }
            }
          }

          // For wellness files, also check for prov:wasGeneratedBy / cascade:sourceType
          // which indicates DeviceGenerated provenance
          if (provenanceValues.size === 0) {
            const allQuads = result.quads;
            const hasDeviceSource = allQuads.some(
              (q) =>
                (q.predicate.value === CASCADE_NAMESPACES.cascade + 'sourceType' &&
                  (q.object.value === 'healthKit' || q.object.value === 'bluetoothDevice')) ||
                // Also detect device provenance from prov:wasGeneratedBy patterns
                (q.predicate.value === 'http://www.w3.org/ns/prov#wasGeneratedBy'),
            );
            // If in wellness directory and has device data patterns, infer DeviceGenerated
            if (hasDeviceSource || typeInfo.directory === 'wellness') {
              const hasDeviceTypes = allQuads.some(
                (q) =>
                  q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
                  (q.object.value.includes('HeartRateData') ||
                    q.object.value.includes('BloodPressureData') ||
                    q.object.value.includes('ActivityData') ||
                    q.object.value.includes('SleepData') ||
                    q.object.value.includes('DailyVitalReading') ||
                    q.object.value.includes('DailyActivitySnapshot') ||
                    q.object.value.includes('DailySleepSnapshot') ||
                    q.object.value === 'http://hl7.org/fhir/Observation'),
              );
              if (hasDeviceSource || hasDeviceTypes) {
                provenanceValues.add('cascade:DeviceGenerated');
                provenanceSources.add('cascade:DeviceGenerated');
              }
            }
          }

          const provenanceStr = provenanceValues.size > 0
            ? Array.from(provenanceValues).join(', ')
            : 'Unknown';

          // Determine record description
          let recordDesc: string;
          // For time-series data (vital signs, heart rate, etc.), show as "X days" if applicable
          const isTimeSeries = ['vital-signs', 'heart-rate', 'blood-pressure', 'activity', 'sleep'].some(
            (ts) => typeInfo.filename.includes(ts.replace('-', '-')),
          );
          if (isTimeSeries && recordCount >= 28) {
            recordDesc = `${recordCount} days`;
          } else if (recordCount === 1) {
            recordDesc = '1 record';
          } else {
            recordDesc = `${recordCount} records`;
          }

          const entry = {
            file: typeInfo.filename,
            records: recordCount,
            provenance: provenanceStr,
            label: `${typeInfo.filename.padEnd(22)} ${recordDesc.padEnd(16)} (${provenanceStr})`,
          };

          if (typeInfo.directory === 'clinical') {
            clinicalSummary.push(entry);
          } else {
            wellnessSummary.push(entry);
          }
        }

        if (globalOpts.json) {
          printResult(
            {
              pod: podDir,
              patient: {
                name: profile.name,
                age: profile.age,
                dateOfBirth: profile.dateOfBirth,
              },
              schemaVersion: profile.schemaVersion,
              lastModified: lastModified?.toISOString(),
              clinical: clinicalSummary.map((s) => ({
                file: s.file,
                records: s.records,
                provenance: s.provenance,
              })),
              wellness: wellnessSummary.map((s) => ({
                file: s.file,
                records: s.records,
                provenance: s.provenance,
              })),
              provenanceSources: Array.from(provenanceSources),
            },
            globalOpts,
          );
        } else {
          // Human-readable output
          console.log(`\nCascade Pod: ${podDir}\n`);

          if (profile.name) {
            const ageStr = profile.age ? ` (age ${profile.age})` : '';
            console.log(`Patient: ${profile.name}${ageStr}`);
          }
          if (profile.schemaVersion) {
            console.log(`Schema Version: ${profile.schemaVersion}`);
          }
          if (lastModified) {
            console.log(`Last Modified: ${lastModified.toISOString().split('T')[0]}`);
          }

          if (clinicalSummary.length > 0) {
            console.log('\nData Summary:');
            console.log('  Clinical:');
            for (const entry of clinicalSummary) {
              console.log(`    ${entry.label}`);
            }
          }

          if (wellnessSummary.length > 0) {
            if (clinicalSummary.length === 0) {
              console.log('\nData Summary:');
            }
            console.log('  Wellness:');
            for (const entry of wellnessSummary) {
              console.log(`    ${entry.label}`);
            }
          }

          if (provenanceSources.size > 0) {
            console.log(`\nProvenance Sources: ${Array.from(provenanceSources).join(', ')}`);
          }

          if (clinicalSummary.length === 0 && wellnessSummary.length === 0) {
            console.log('\nThis pod has no data files yet.');
            console.log('Add TTL files to the clinical/ or wellness/ directories to get started.');
          }

          console.log('');
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        printError(`Failed to read pod info: ${message}`, globalOpts);
        process.exitCode = 1;
      }
    });
}

// ─── Export Helpers ──────────────────────────────────────────────────────────

/**
 * Recursively copy a directory.
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
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
async function createZipArchive(sourceDir: string, outputPath: string): Promise<void> {
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

// ─── Display Helpers ─────────────────────────────────────────────────────────

/**
 * Normalize provenance label for consistent display.
 * Converts "core:ClinicalGenerated" to "cascade:ClinicalGenerated" since
 * the "core" and "cascade" prefixes map to the same namespace.
 */
function normalizeProvenanceLabel(label: string): string {
  if (label.startsWith('core:')) {
    return 'cascade:' + label.slice(5);
  }
  return label;
}

/**
 * Extract a display label from already-shortened property keys.
 */
function extractLabelFromProps(properties: Record<string, string>): string | undefined {
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
function selectKeyProperties(
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
