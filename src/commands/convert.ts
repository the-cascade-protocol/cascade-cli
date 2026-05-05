/**
 * cascade convert --from <format> --to <format> [file]
 *
 * Convert between health data formats.
 *
 * Dispatch is registry-driven: src/lib/import-registry.ts holds the list
 * of FormatImporter instances. Each importer declares the --from value it
 * matches, the --to values it supports, optional sidecar CLI flags, and
 * a postProcess hook for sidecar work (manifest writing, narrative
 * extraction, etc.). New formats are added by registering an entry — no
 * edits to this file are required.
 *
 * Common options:
 *   --from <format>        Source format (registry-driven)
 *   --to <format>          Target format (registry-driven; valid values depend on --from)
 *   --format <output>      Output serialization format (turtle|jsonld) [default: turtle]
 *   --passthrough <mode>   Passthrough mode for unmapped FHIR types (full|minimal) [default: full]
 *   --source-system <name> Tag all records with a source-system name
 *   --json                 Output results as JSON envelope (machine-readable)
 *   --verbose              Show detailed conversion information
 *
 * Per-importer sidecar options are declared by their entries in
 * import-registry.ts and surfaced through --help.
 *
 * Supports stdin piping:
 *   cat patient.json | cascade convert --from fhir --to cascade
 *
 * Zero network calls. All conversion is local.
 */

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { printResult, printError, printVerbose, type OutputOptions } from '../lib/output.js';
import type { ImportContext, ImporterCliOption, OutputFormat } from '../lib/import-types.js';
import { getImporter, listFormats, autoDetect, importers } from '../lib/import-registry.js';

/**
 * Read input from file or stdin.
 * Returns a Buffer for binary inputs (ZIP) so callers can preserve binary content
 * for IHE XDM bundles, or a UTF-8 string for everything else.
 */
function readInput(file: string | undefined, asBinary: boolean): string | Buffer {
  if (file) {
    if (asBinary || file.toLowerCase().endsWith('.zip')) {
      return readFileSync(file);
    }
    return readFileSync(file, 'utf-8');
  }
  return readFileSync(0, 'utf-8');
}

/** Strip leading dashes and convert to camelCase to match Commander's option key. */
function flagToOptionKey(flag: string): string {
  // '--manifest [file]' → 'manifest'
  // '--extract-narratives' → 'extractNarratives'
  const long = flag.split(/\s+/)[0].replace(/^--/, '');
  return long.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Aggregate every importer's cliOptions, error if two importers declare
 * the same flag (the registration model would be silently broken in that case).
 */
function collectCliOptions(): ImporterCliOption[] {
  const seen = new Set<string>();
  const collected: ImporterCliOption[] = [];
  for (const imp of importers) {
    for (const opt of imp.cliOptions ?? []) {
      const key = opt.flag.split(/\s+/)[0];
      if (seen.has(key)) {
        throw new Error(
          `Duplicate CLI flag declared by importer '${imp.format}': ${opt.flag}. ` +
            `Each --flag must be unique across the importer registry.`,
        );
      }
      seen.add(key);
      collected.push(opt);
    }
  }
  return collected;
}

export function registerConvertCommand(program: Command): void {
  const formats = listFormats();
  const sidecarOptions = collectCliOptions();

  const cmd = program
    .command('convert')
    .description('Convert between health data formats')
    .argument('[file]', 'Input file (reads from stdin if omitted)')
    .requiredOption('--from <format>', `Source format (${formats.join('|')})`)
    .requiredOption('--to <format>', 'Target format (turtle|jsonld|fhir|cascade)')
    .option('--format <output>', 'Output serialization format (turtle|jsonld)', 'turtle')
    .option(
      '--source-system <name>',
      'Tag all records with a source system name (adds cascade:sourceSystem for reconciliation)',
    )
    .option(
      '--passthrough <mode>',
      'Passthrough mode for unmapped FHIR types: full (store fhirJson, round-trip supported) or minimal (omit fhirJson, smaller output)',
      'full',
    );

  // Importer-contributed sidecar flags
  for (const opt of sidecarOptions) {
    if (opt.defaultValue !== undefined) {
      cmd.option(opt.flag, opt.description, opt.defaultValue as string);
    } else {
      cmd.option(opt.flag, opt.description);
    }
  }

  cmd.action(
    async (
      file: string | undefined,
      options: {
        from: string;
        to: string;
        format: string;
        sourceSystem?: string;
        passthrough: string;
        // Sidecar options land here by Commander key; we shovel them all into ctx.options.
        [key: string]: unknown;
      },
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

      // 1. Look up importer
      const importer = getImporter(options.from);
      if (!importer) {
        printError(
          `Invalid source format: ${options.from}. Valid: ${formats.join(', ')}`,
          globalOpts,
        );
        process.exitCode = 1;
        return;
      }

      // 2. Validate --to against this importer's supported outputs
      if (!importer.supportedOutputs.includes(options.to as OutputFormat)) {
        printError(
          `Importer '${importer.format}' does not support --to ${options.to}. ` +
            `Valid: ${importer.supportedOutputs.join(', ')}`,
          globalOpts,
        );
        process.exitCode = 1;
        return;
      }

      // 3. Read input
      let input: string | Buffer;
      try {
        // C-CDA bundles can be ZIP (IHE XDM); other formats default to UTF-8.
        const wantsBinary = options.from === 'c-cda';
        input = readInput(file, wantsBinary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        printError(`Failed to read input: ${msg}`, globalOpts);
        process.exitCode = 1;
        return;
      }

      if (Buffer.isBuffer(input) ? input.length === 0 : !input.trim()) {
        printError('Empty input', globalOpts);
        process.exitCode = 1;
        return;
      }

      // 4. Auto-detect content vs declared --from; warn on mismatch
      const detected = autoDetect(input);
      if (detected && detected.format !== options.from) {
        printVerbose(
          `Note: Input appears to be ${detected.format} but --from says ${options.from}. Proceeding with declared format.`,
          globalOpts,
        );
      }

      // 5. Build context. Sidecar options land in ctx.options by Commander key.
      const sidecarBag: Record<string, unknown> = {};
      for (const opt of sidecarOptions) {
        const key = flagToOptionKey(opt.flag);
        if (key in options) sidecarBag[key] = options[key];
      }
      const ctx: ImportContext = {
        inputPath: file ?? '<stdin>',
        outputSerialization: options.format === 'jsonld' ? 'jsonld' : 'turtle',
        sourceSystem: options.sourceSystem,
        passthroughMinimal: options.passthrough === 'minimal',
        importedAt: new Date().toISOString(),
        options: sidecarBag,
      };
      if (ctx.passthroughMinimal) {
        printVerbose(
          'Passthrough mode: minimal (cascade:fhirJson omitted, round-trip export disabled)',
          globalOpts,
        );
      }

      // 6. Run conversion
      const result = await importer.convert(input, options.to as OutputFormat, ctx);

      // 7. Output / errors
      if (!result.success) {
        for (const err of result.errors) {
          printError(err, globalOpts);
        }
        for (const warn of result.warnings) {
          printVerbose(`Warning: ${warn.message}`, globalOpts);
        }
        process.exitCode = 1;
        return;
      }

      for (const warn of result.warnings) {
        printVerbose(`Warning: ${warn.message}`, globalOpts);
      }

      if (globalOpts.json) {
        printResult(
          {
            success: true,
            from: options.from,
            to: options.to,
            format: result.format,
            resourceCount: result.resourceCount,
            skippedCount: result.skippedCount,
            warnings: result.warnings.map((w) => w.message),
            output: result.output,
            resources:
              result.records?.map((r) => ({
                resourceType: r.resourceType,
                cascadeType: r.cascadeType,
                warnings: r.warnings,
              })) ?? [],
          },
          globalOpts,
        );
      } else {
        console.log(result.output);
        if (result.resourceCount > 0) {
          console.error(
            `Converted ${result.resourceCount} resource${result.resourceCount > 1 ? 's' : ''} ` +
              `(${options.from} -> ${result.format})`,
          );
        }
        if (result.skippedCount > 0) {
          printVerbose(
            `${result.skippedCount} resource type${result.skippedCount > 1 ? 's' : ''} skipped (CareTeam, CarePlan, SupplyDelivery — not patient health data)`,
            globalOpts,
          );
        }
        if (result.warnings.length > 0) {
          console.error(`${result.warnings.length} warning${result.warnings.length > 1 ? 's' : ''}`);
        }
      }

      // 8. Sidecar post-processing
      if (importer.postProcess) {
        try {
          await importer.postProcess(input, result, ctx);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Warning: postProcess for ${importer.format} failed: ${msg}`);
        }
      }
    },
  );
}
