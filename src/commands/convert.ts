/**
 * cascade convert --from <format> --to <format> [file]
 *
 * Convert between health data formats.
 * Supports FHIR R4, Cascade Protocol Turtle, and JSON-LD.
 *
 * Options:
 *   --from <format>     Source format (fhir|cascade|c-cda)
 *   --to <format>       Target format (turtle|jsonld|fhir|cascade)
 *   --format <output>   Output serialization format (turtle|jsonld) [default: turtle]
 *   --json              Output results as JSON envelope (machine-readable)
 *   --verbose           Show detailed conversion information
 *
 * Supports stdin piping:
 *   cat patient.json | cascade convert --from fhir --to cascade
 *
 * Zero network calls. All conversion is local.
 */

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { printResult, printError, printVerbose, type OutputOptions } from '../lib/output.js';
import { convert, detectFormat, type InputFormat, type OutputFormat } from '../lib/fhir-converter/index.js';

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
    .action(
      async (
        file: string | undefined,
        options: { from: string; to: string; format: string; sourceSystem?: string },
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
        const result = await convert(
          input,
          options.from as InputFormat,
          options.to as OutputFormat,
          outputSerialization,
          options.sourceSystem,
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
          if (result.warnings.length > 0) {
            console.error(`${result.warnings.length} warning${result.warnings.length > 1 ? 's' : ''}`);
          }
        }
      },
    );
}
