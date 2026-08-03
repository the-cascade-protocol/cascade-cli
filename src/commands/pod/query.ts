/**
 * cascade pod query <pod-dir>
 *
 * Query data within a Cascade Pod by type (medications, conditions, etc.)
 * or across all data types.
 *
 * Exit codes:
 *   0 — the query ran and every file it needed was read
 *   1 — usage error (no filter, bad --hops, unknown --edge, unknown --neighbors seed)
 *   2 — the pod, or a file inside it, could NOT be read
 *
 * The third one is the point, and it is the same lesson `pod conflicts` learned:
 * a file that cannot be read must never be reported as a file with nothing in
 * it. Every read here goes through the pod read layer (`lib/pod-read.ts`),
 * which resolves the DEK once and returns a typed failure per file. Those
 * errors used to travel in a per-bucket `error` field on an otherwise
 * successful (exit 0) payload whose counts were all zero — so a consumer that
 * read only `count` saw an empty pod, and said so, over a pod full of records.
 * A read failure now fails the command with a message naming the files.
 *
 * The decrypt-vs-parse weighting lives in the read layer's `PodReadLedger`, so
 * this command states the rule by using it rather than by restating it.
 */

import type { Command } from 'commander';
import * as path from 'path';
import {
  printResult,
  printError,
  printVerbose,
  printWarning,
  type OutputOptions,
} from '../../lib/output.js';
import {
  DATA_TYPES,
  extractLabelFromProps,
  selectKeyProperties,
} from './helpers.js';
import {
  openPod,
  resolvePodDir,
  isDirectory,
  fileExists,
  discoverTtlFiles,
  unreadableFilesMessage,
  skippedFilesMessage,
  PodReadLedger,
  type PodReader,
  type PodReadFailure,
} from '../../lib/pod-read.js';
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

/**
 * Weigh a loaded graph's read failures and say so.
 *
 * Returns `false` (having set exit 2 and printed the error) on any failure the
 * read layer calls fatal: the pod's key is wrong for that file, or a registered
 * record file would not parse, and no traversal over the result means anything.
 * The rest are warned about and stepped over — a pod also holds notes,
 * investigations and reports, and one stray file must not take the whole graph
 * down with it.
 */
function reportGraphReadFailures(
  absDir: string,
  graph: { readFailures: PodReadFailure[]; files: string[] },
  globalOpts: OutputOptions,
): boolean {
  const ledger = new PodReadLedger();
  ledger.attempted = graph.files.length;
  for (const failure of graph.readFailures) ledger.record(failure);

  if (ledger.hasFatal) {
    printError(unreadableFilesMessage(absDir, ledger.fatal, ledger.attempted), globalOpts);
    process.exitCode = 2;
    return false;
  }
  if (ledger.skipped.length > 0) printWarning(skippedFilesMessage(ledger.skipped), globalOpts);
  return true;
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

        // Open the pod ONCE: resolves the DEK when it is encrypted, and fails
        // here rather than letting a keyless read report ciphertext as nothing.
        let reader: PodReader;
        try {
          reader = await openPod(absDir);
          if (reader.encrypted) {
            printVerbose('Pod is encrypted; decrypting resources for query.', globalOpts);
          }
        } catch (e: unknown) {
          // Exit 2, not 1: this is "could not open the pod", the same hard read
          // failure `pod conflicts` exits 2 on. A caller must be able to tell it
          // apart from a usage error AND from an empty result.
          printError(e instanceof Error ? e.message : String(e), globalOpts);
          process.exitCode = 2;
          return;
        }

        try {
          // ─── Graph traversal: --neighbors <iri> ──────────────────────────
          if (options.neighbors !== undefined) {
            await runNeighborsQuery(absDir, podDir, options, globalOpts, reader);
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

          // Failures are collected rather than thrown on the first one, so the
          // message can name all of them (a sealed pod read without the key
          // fails on every file, and the useful report is "the pod", not
          // "clinical/allergies.ttl"). The ledger applies the read layer's rule:
          // fatal for a key problem or a broken REGISTERED record file, a
          // warning for any other stray `.ttl`.
          const ledger = new PodReadLedger();

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

            ledger.attempt();
            // A REGISTERED record file is the record picture. Either failure on
            // one of these — a key that will not open it, or bytes that are not
            // Turtle — leaves the count unknown, and unknown is not zero.
            const read = reader.readRecords(filePath);
            const records = read.ok ? read.value.records : [];
            const error = read.ok ? undefined : read.failure.reason;
            if (!read.ok) ledger.record(read.failure);

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

            ledger.attempt();
            // Recorded BEFORE the empty-file skip below: an unreadable file and
            // an empty one are indistinguishable after that `continue`, which is
            // exactly the conflation this command must not make.
            //
            // An unregistered file that will not DECRYPT is still a key problem
            // and still fatal. One that decrypts and is not valid Turtle is a
            // stray file, not a broken pod — a pod holds notes, investigations
            // and reports too — so the ledger reports it and steps over it.
            const read = reader.readRecords(extraFile);
            const records = read.ok ? read.value.records : [];
            const error = read.ok ? undefined : read.failure.reason;
            if (!read.ok) ledger.record(read.failure);
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

          // A file that could not be read fails the QUERY. Reporting the
          // readable part with a per-bucket `error` field was tried and is what
          // produced the bug: consumers read `count`, saw zero, and rendered a
          // pod full of records as an empty one.
          if (ledger.hasFatal) {
            printError(
              unreadableFilesMessage(absDir, ledger.fatal, ledger.attempted),
              globalOpts,
            );
            process.exitCode = 2;
            return;
          }

          // Not fatal, but never silent: the sweep stepped over files it could
          // not parse, and the caller is entitled to know the list is of what
          // could be read.
          if (ledger.skipped.length > 0) {
            printWarning(skippedFilesMessage(ledger.skipped), globalOpts);
          }

          // With --all --edges, compute the record-to-record edge projection.
          // This is strictly additive: without --edges the output object is
          // built exactly as before, so existing consumers see no change.
          let edges: ReturnType<typeof recordEdges> | undefined;
          if (options.all && options.edges) {
            const graph = await loadPodGraph(reader);
            // `loadPodGraph` collects its read failures instead of throwing, so
            // an unread file would otherwise become "this record has no edges".
            // Same split as above: a file that will not decrypt is fatal, a file
            // that is not valid Turtle is reported and stepped over.
            if (!reportGraphReadFailures(absDir, graph, globalOpts)) return;
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
  reader: PodReader,
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

  const graph = await loadPodGraph(reader);
  // Before "no record found with that IRI": over a graph with files that would
  // not decrypt, that sentence is a guess dressed as an answer.
  if (!reportGraphReadFailures(absDir, graph, globalOpts)) return;
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
