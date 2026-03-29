/**
 * cascade convert --from <format> --to <format> [file]
 *
 * Convert between health data formats.
 * Supports FHIR R4, Cascade Protocol Turtle, and JSON-LD.
 *
 * Options:
 *   --from <format>        Source format (fhir|cascade|c-cda)
 *   --to <format>          Target format (turtle|jsonld|fhir|cascade)
 *   --format <output>      Output serialization format (turtle|jsonld) [default: turtle]
 *   --passthrough <mode>   Passthrough mode for unmapped FHIR types (full|minimal) [default: full]
 *                          full: stores original FHIR JSON for lossless round-trip
 *                          minimal: omits fhirJson; smaller output, no round-trip support
 *   --json                 Output results as JSON envelope (machine-readable)
 *   --verbose              Show detailed conversion information
 *
 * Supports stdin piping:
 *   cat patient.json | cascade convert --from fhir --to cascade
 *
 * Zero network calls. All conversion is local.
 */

import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { printResult, printError, printVerbose, type OutputOptions } from '../lib/output.js';
import { convert, detectFormat, type InputFormat, type OutputFormat } from '../lib/fhir-converter/index.js';
import { buildImportManifest } from '../lib/fhir-converter/import-manifest.js';
import { EXCLUDED_TYPES } from '../lib/fhir-converter/converters-passthrough.js';
import { parseCcdaXml } from '../lib/ccda-converter/parser.js';
import { collectNarrativeBlocks } from '../lib/ccda-converter/narrative-extractor.js';

/**
 * Read input from file or stdin.
 * If file is provided, reads from disk.
 * Otherwise reads all of stdin synchronously.
 */
function readInput(file: string | undefined): string {
  if (file) {
    return readFileSync(file, 'utf-8');
  }
  // Read from stdin
  return readFileSync(0, 'utf-8');
}

export function registerConvertCommand(program: Command): void {
  program
    .command('convert')
    .description('Convert between health data formats')
    .argument('[file]', 'Input file (reads from stdin if omitted)')
    .requiredOption('--from <format>', 'Source format (fhir|cascade|c-cda)')
    .requiredOption('--to <format>', 'Target format (turtle|jsonld|fhir|cascade)')
    .option('--format <output>', 'Output serialization format (turtle|jsonld)', 'turtle')
    .option('--source-system <name>', 'Tag all records with a source system name (adds cascade:sourceSystem for reconciliation)')
    .option('--passthrough <mode>', 'Passthrough mode for unmapped FHIR types: full (store fhirJson, round-trip supported) or minimal (omit fhirJson, smaller output)', 'full')
    .option('--manifest [file]', 'Write import manifest JSON alongside output (default: {input}-manifest.json). Only applies when --from fhir.')
    .option('--extract-narratives', 'Extract narrative text blocks from C-CDA sections and write a JSON sidecar <file>.narratives.json. Only applies when --from c-cda.')
    .action(
      async (
        file: string | undefined,
        options: { from: string; to: string; format: string; sourceSystem?: string; passthrough: string; manifest?: string | boolean; extractNarratives?: boolean },
      ) => {
        const globalOpts = program.opts() as OutputOptions;

        printVerbose(`Converting from ${options.from} to ${options.to}`, globalOpts);
        if (file) {
          printVerbose(`Input file: ${file}`, globalOpts);
        } else {
          printVerbose('Reading from stdin', globalOpts);
        }
        printVerbose(`Output format: ${options.format}`, globalOpts);
        if (options.sourceSystem) {
          printVerbose(`Source system: ${options.sourceSystem}`, globalOpts);
        }

        // 1. Read input
        let input: string;
        try {
          input = readInput(file);
        } catch (err: any) {
          printError(`Failed to read input: ${err.message}`, globalOpts);
          process.exitCode = 1;
          return;
        }

        if (!input.trim()) {
          printError('Empty input', globalOpts);
          process.exitCode = 1;
          return;
        }

        // 2. Validate source/target formats
        const validInputFormats = ['fhir', 'cascade', 'c-cda'];
        const validOutputFormats = ['turtle', 'jsonld', 'fhir', 'cascade'];

        if (!validInputFormats.includes(options.from)) {
          printError(`Invalid source format: ${options.from}. Valid: ${validInputFormats.join(', ')}`, globalOpts);
          process.exitCode = 1;
          return;
        }

        if (!validOutputFormats.includes(options.to)) {
          printError(`Invalid target format: ${options.to}. Valid: ${validOutputFormats.join(', ')}`, globalOpts);
          process.exitCode = 1;
          return;
        }

        // 3. Auto-detect format if helpful (validate matches declared)
        const detected = detectFormat(input);
        if (detected && detected !== options.from) {
          printVerbose(
            `Note: Input appears to be ${detected} but --from says ${options.from}. Proceeding with declared format.`,
            globalOpts,
          );
        }

        // 4. Run conversion
        const outputSerialization = (options.format === 'jsonld' ? 'jsonld' : 'turtle') as 'turtle' | 'jsonld';
        const passthroughMinimal = options.passthrough === 'minimal';
        if (passthroughMinimal) {
          printVerbose('Passthrough mode: minimal (cascade:fhirJson omitted, round-trip export disabled)', globalOpts);
        }
        const result = await convert(
          input,
          options.from as InputFormat,
          options.to as OutputFormat,
          outputSerialization,
          options.sourceSystem,
          passthroughMinimal,
        );

        // 5. Output
        if (!result.success) {
          for (const err of result.errors) {
            printError(err, globalOpts);
          }
          for (const warn of result.warnings) {
            printVerbose(`Warning: ${warn}`, globalOpts);
          }
          process.exitCode = 1;
          return;
        }

        // Print warnings in verbose mode
        for (const warn of result.warnings) {
          printVerbose(`Warning: ${warn}`, globalOpts);
        }

        if (globalOpts.json) {
          // JSON envelope for machine-readable output
          printResult(
            {
              success: true,
              from: options.from,
              to: options.to,
              format: result.format,
              resourceCount: result.resourceCount,
              skippedCount: result.skippedCount,
              warnings: result.warnings,
              output: result.output,
              resources: result.results.map(r => ({
                resourceType: r.resourceType,
                cascadeType: r.cascadeType,
                warnings: r.warnings,
              })),
            },
            globalOpts,
          );
        } else {
          // Direct output (Turtle, JSON-LD, or FHIR JSON)
          console.log(result.output);

          // Print summary to stderr so it does not pollute piped output
          if (result.resourceCount > 0) {
            console.error(
              `Converted ${result.resourceCount} resource${result.resourceCount > 1 ? 's' : ''} ` +
              `(${options.from} -> ${result.format})`,
            );
          }
          if (result.skippedCount > 0) {
            printVerbose(`${result.skippedCount} resource type${result.skippedCount > 1 ? 's' : ''} skipped (CareTeam, CarePlan, SupplyDelivery — not patient health data)`, globalOpts);
          }
          if (result.warnings.length > 0) {
            console.error(`${result.warnings.length} warning${result.warnings.length > 1 ? 's' : ''}`);
          }
        }

        // Write import manifest if requested (FHIR -> Cascade only)
        if (options.manifest !== undefined && options.from === 'fhir' && result.success) {
          // Count excluded types from the source bundle
          const excludedCounts: Record<string, number> = {};
          try {
            const parsed = JSON.parse(input);
            const resources: any[] =
              parsed.resourceType === 'Bundle'
                ? (parsed.entry ?? []).map((e: any) => e.resource).filter(Boolean)
                : [parsed];
            for (const res of resources) {
              if (res?.resourceType && EXCLUDED_TYPES.has(res.resourceType)) {
                excludedCounts[res.resourceType] = (excludedCounts[res.resourceType] ?? 0) + 1;
              }
            }
          } catch {
            // Input already validated as parseable JSON above; this should not fail
          }

          const manifest = buildImportManifest(
            result,
            file ?? '<stdin>',
            options.sourceSystem ?? '',
            excludedCounts,
          );

          let manifestPath: string;
          if (typeof options.manifest === 'string') {
            manifestPath = options.manifest;
          } else if (file) {
            manifestPath = join(dirname(file), `${basename(file, '.json')}-manifest.json`);
          } else {
            manifestPath = 'fhir-import-manifest.json';
          }

          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
          console.error(`Import manifest written to: ${manifestPath}`);
        }

        // P5.1-C: --extract-narratives (c-cda only)
        // Writes a JSON sidecar <file>.narratives.json with all narrative blocks.
        // Stdout remains TTL-only per RC-6 stdout discipline — all status goes to stderr.
        if (options.extractNarratives && options.from === 'c-cda' && result.success) {
          try {
            const parsedDoc = parseCcdaXml(input);
            const blocks = collectNarrativeBlocks(parsedDoc);

            let narrativesPath: string;
            if (file) {
              narrativesPath = join(dirname(file), `${basename(file)}.narratives.json`);
            } else {
              narrativesPath = 'ccda-narratives.json';
            }

            writeFileSync(narrativesPath, JSON.stringify(blocks, null, 2));
            console.error(`Narrative blocks written to: ${narrativesPath}`);
          } catch (err: any) {
            console.error(`Warning: Failed to extract narratives: ${err.message}`);
          }
        } else if (options.extractNarratives && options.from !== 'c-cda') {
          console.error('Warning: --extract-narratives is only supported for --from c-cda');
        }
      },
    );
}
