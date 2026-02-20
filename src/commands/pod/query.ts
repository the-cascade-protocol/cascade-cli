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
}
