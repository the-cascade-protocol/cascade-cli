/**
 * cascade pod query <pod-dir>
 *
 * Query data within a Cascade Pod by type (medications, conditions, etc.)
 * or across all data types.
 */

import type { Command } from 'commander';
import * as path from 'path';
import { printResult, printError, printVerbose, type OutputOptions } from '../../lib/output.js';
import {
  DATA_TYPES,
  resolvePodDir,
  isDirectory,
  fileExists,
  discoverTtlFiles,
  parseDataFile,
  extractLabelFromProps,
  selectKeyProperties,
} from './helpers.js';
import { isPodEncrypted, resolveDek, PodDecryptError } from '../../lib/pod-encryption.js';
import { obtainPassphrase } from '../../lib/passphrase.js';
import { expandCurie } from '../../lib/turtle-parser.js';
import { loadPodGraph, recordEdges, neighborhood } from './graph.js';

/**
 * Classify an unregistered ("extra") TTL file discovered by `--all` into a
 * stable, humanized bucket key, so the query never leaks raw filenames
 * (`ai-extraction-<epoch>`, UUID-named bundles, conversation artifacts) as if
 * they were record types. Files under `analysis/` and any `ai-extraction-*`
 * output collapse into one `ai-extracted` bucket; every other unrecognized TTL
 * collapses into `other`. Several files can map to the same bucket — their
 * records are aggregated by the caller. The app-side display map turns these
 * keys into labels/badges.
 */
function classifyExtraBucket(relPath: string, baseName: string): string {
  const topDir = relPath.split(/[\\/]/)[0];
  if (topDir === 'analysis' || baseName.startsWith('ai-extraction')) {
    return 'ai-extracted';
  }
  return 'other';
}

export function registerQuerySubcommand(pod: Command, program: Command): void {
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
    .option('--insurance', 'Query insurance / coverage plans')
    .option('--procedures', 'Query procedures')
    .option('--encounters', 'Query encounters')
    .option('--documents', 'Query clinical documents')
    .option('--lab-reports', 'Query laboratory reports (DiagnosticReport)')
    .option('--medication-administrations', 'Query medication administrations')
    .option('--devices', 'Query implanted devices')
    .option('--imaging', 'Query imaging studies')
    .option('--claims', 'Query insurance claims')
    .option('--benefits', 'Query explanation of benefits')
    .option('--fhir-passthrough', 'Query FHIR passthrough records (unmapped types)')
    .option('--all', 'Query all data')
    .option(
      '--neighbors <iri>',
      'Return the typed neighborhood of a record (traverses stored edges both directions)',
    )
    .option('--hops <n>', 'Traversal depth for --neighbors (default 1, capped at 3)')
    .option(
      '--edge <predicate>',
      'Restrict --neighbors traversal to this edge predicate (repeatable; full IRI or prefix:local CURIE)',
      (val: string, acc: string[]) => {
        acc.push(val);
        return acc;
      },
      [] as string[],
    )
    .option('--edges', 'With --all, add a record-to-record edge projection to the output')
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
          insurance?: boolean;
          procedures?: boolean;
          encounters?: boolean;
          documents?: boolean;
          labReports?: boolean;
          medicationAdministrations?: boolean;
          devices?: boolean;
          imaging?: boolean;
          claims?: boolean;
          benefits?: boolean;
          fhirPassthrough?: boolean;
          all?: boolean;
          neighbors?: string;
          hops?: string;
          edge?: string[];
          edges?: boolean;
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

        // If the pod is encrypted, resolve the DEK so reads can decrypt.
        let dek: Buffer | undefined;
        if (isPodEncrypted(absDir)) {
          try {
            const passphrase = await obtainPassphrase();
            dek = resolveDek(absDir, passphrase);
            printVerbose('Pod is encrypted; decrypting resources for query.', globalOpts);
          } catch (e: unknown) {
            const msg =
              e instanceof PodDecryptError ? e.message : e instanceof Error ? e.message : String(e);
            printError(`Cannot read encrypted pod: ${msg}`, globalOpts);
            process.exitCode = 1;
            return;
          }
        }

        try {
          // ─── Graph traversal: --neighbors <iri> ──────────────────────────
          if (options.neighbors !== undefined) {
            await runNeighborsQuery(absDir, podDir, options, globalOpts, dek);
            return;
          }

          // --edges is an additive projection on --all; it needs the full graph.
          if (options.edges && !options.all) {
            printError('--edges requires --all.', globalOpts);
            process.exitCode = 1;
            return;
          }

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
            if (options.insurance) requestedTypes.push('insurance');
            if (options.procedures) requestedTypes.push('procedures');
            if (options.encounters) requestedTypes.push('encounters');
            if (options.documents) requestedTypes.push('documents');
            if (options.labReports) requestedTypes.push('lab-reports');
            if (options.medicationAdministrations) requestedTypes.push('medication-administrations');
            if (options.devices) requestedTypes.push('devices');
            if (options.imaging) requestedTypes.push('imaging');
            if (options.claims) requestedTypes.push('claims');
            if (options.benefits) requestedTypes.push('benefits');
            if (options.fhirPassthrough) requestedTypes.push('fhir-passthrough');
          }

          if (requestedTypes.length === 0) {
            printError(
              'No query filter specified. Use --medications, --conditions, --procedures, --all, etc.',
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

            const { records, error } = await parseDataFile(filePath, dek);

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

          // Process extra files found in --all mode. Instead of leaking each
          // file's raw basename as a record type, classify it into a stable,
          // humanized bucket (ai-extracted / other) and AGGREGATE records, so
          // the UI never shows `ai-extraction-<epoch>` or a UUID as a "type".
          for (const extraFile of extraFiles) {
            const relPath = path.relative(absDir, extraFile);
            const baseName = path.basename(extraFile, '.ttl');

            const { records, error } = await parseDataFile(extraFile, dek);
            if (records.length === 0) continue;

            const bucketKey = classifyExtraBucket(relPath, baseName);
            const mapped = records.map((r) => ({
              id: r.id,
              type: r.type,
              properties: r.properties,
            }));
            const existing = queryResults[bucketKey];
            if (existing) {
              existing.count += records.length;
              existing.records.push(...mapped);
              if (error && !existing.error) existing.error = error;
            } else {
              queryResults[bucketKey] = {
                count: records.length,
                file: relPath, // representative source; bucket may aggregate many
                records: mapped,
                error,
              };
            }
          }

          // With --all --edges, compute the record-to-record edge projection.
          // This is strictly additive: without --edges the output object is
          // built exactly as before, so existing consumers see no change.
          let edges: ReturnType<typeof recordEdges> | undefined;
          if (options.all && options.edges) {
            const graph = await loadPodGraph(absDir, dek);
            edges = recordEdges(graph);
          }

          // Output results
          if (globalOpts.json) {
            const payload: {
              pod: string;
              dataTypes: typeof queryResults;
              edges?: ReturnType<typeof recordEdges>;
            } = {
              pod: podDir,
              dataTypes: queryResults,
            };
            if (edges !== undefined) payload.edges = edges;
            printResult(payload, globalOpts);
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

            if (edges !== undefined) {
              console.log(`\n=== Edges (${edges.length} record-to-record) ===\n`);
              for (const e of edges) {
                console.log(`  ${e.subject}`);
                console.log(`    --${e.predicate}--> ${e.object}`);
              }
              console.log('');
            }
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          printError(`Failed to query pod: ${message}`, globalOpts);
          process.exitCode = 1;
        }
      },
    );
}

/**
 * Handle `pod query --neighbors <iri> [--hops N] [--edge <pred>...]`.
 *
 * Loads the pod graph, validates the flags, traverses the seed's neighborhood,
 * and prints the result (JSON contract or a human summary). Sets
 * `process.exitCode = 1` on any clean error (bad flag, unknown seed).
 */
async function runNeighborsQuery(
  absDir: string,
  podDir: string,
  options: { neighbors?: string; hops?: string; edge?: string[] },
  globalOpts: OutputOptions,
  dek: Buffer | undefined,
): Promise<void> {
  const seedIri = options.neighbors as string;

  // --hops: default 1, capped at 3, reject non-positive-integers cleanly.
  let hops = 1;
  if (options.hops !== undefined) {
    const parsed = Number(options.hops);
    if (!Number.isInteger(parsed) || parsed < 1) {
      printError(`Invalid --hops value "${options.hops}": expected a positive integer.`, globalOpts);
      process.exitCode = 1;
      return;
    }
    hops = Math.min(parsed, 3);
  }

  // --edge: expand each CURIE / IRI; a value with an unknown prefix errors.
  const edgeFilters: string[] = [];
  const badEdges: string[] = [];
  for (const raw of options.edge ?? []) {
    const expanded = expandCurie(raw);
    if (expanded === null) badEdges.push(raw);
    else edgeFilters.push(expanded);
  }
  if (badEdges.length > 0) {
    printError(
      `Unknown edge predicate${badEdges.length > 1 ? 's' : ''}: ${badEdges.join(', ')}. ` +
        `Use a full IRI or a known prefix:local CURIE (e.g. clinical:hasLabResult).`,
      globalOpts,
    );
    process.exitCode = 1;
    return;
  }

  const graph = await loadPodGraph(absDir, dek);
  const result = neighborhood(graph, seedIri, { hops, edgeFilters });

  if (result === null) {
    printError(`No record found with IRI: ${seedIri}`, globalOpts);
    process.exitCode = 1;
    return;
  }

  if (globalOpts.json) {
    printResult({ pod: podDir, ...result }, globalOpts);
    return;
  }

  // Human-readable summary.
  console.log(`\nSeed: ${result.seed.iri}`);
  console.log(`  type: ${result.seed.type}`);
  if (result.seed.label) console.log(`  label: ${result.seed.label}`);

  const filterNote = result.edgeFilters.length ? `, edges: ${result.edgeFilters.join(', ')}` : '';
  console.log(
    `\n=== Neighbors (${result.neighbors.length}) within ${result.hops} hop(s)${filterNote} ===\n`,
  );
  if (result.neighbors.length === 0) {
    console.log('  (none)\n');
    return;
  }
  for (const n of result.neighbors) {
    const arrow = n.direction === 'out' ? `--${n.edge}-->` : `<--${n.edge}--`;
    console.log(`  [hop ${n.hop}] ${arrow} ${n.iri} (${n.type})`);
  }
  console.log('');
}
