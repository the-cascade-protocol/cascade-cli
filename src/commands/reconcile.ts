/**
 * cascade reconcile <file1> <file2> [file3...] [options]
 *
 * Reconcile Cascade Protocol Turtle files from multiple sources into a
 * single normalized record set.
 *
 * Detects and resolves:
 *   - Exact duplicates (same record from multiple systems)
 *   - Near-duplicates (same record, minor value drift)
 *   - Status conflicts (active vs resolved)
 *   - Value conflicts (same test, different result)
 *
 * Adds reconciliation provenance to the merged output:
 *   cascade:reconciliationStatus  "canonical" | "merged" | "conflict-resolved" | "unresolved-conflict"
 *   cascade:mergedFrom            <source-uri1>, <source-uri2>, ...
 *   cascade:mergedSources         "system-a, system-b"
 *   cascade:conflictResolution    "trust_priority" | "merge_values"
 *
 * Options:
 *   --output <file>                     Write merged Turtle to file (default: stdout)
 *   --report <file>                     Write JSON transformation report to file
 *   --trust <system=score,...>          Set trust scores (e.g. hospital=0.95,specialist=0.85)
 *   --lab-tolerance <number>            Numeric tolerance for lab value matching (default: 0.05)
 *   --json                              Output report as JSON to stdout
 *
 * Examples:
 *   cascade reconcile primary-care.ttl specialist.ttl hospital.ttl --output merged.ttl --report report.json
 *   cascade reconcile *.ttl --trust hospital=0.95
 */

import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { printResult, printError, printVerbose, type OutputOptions } from '../lib/output.js';
import { runReconciliation } from '../lib/reconciler.js';

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerReconcileCommand(program: Command): void {
  program
    .command('reconcile')
    .description('Reconcile Cascade RDF from multiple sources into a normalized record set')
    .argument('<files...>', 'Cascade Turtle files to reconcile (2 or more)')
    .option('--output <file>', 'Write merged Turtle output to file (default: stdout)')
    .option('--report <file>', 'Write JSON transformation report to file')
    .option('--trust <scores>', 'Source trust scores: system1=0.9,system2=0.85')
    .option('--lab-tolerance <number>', 'Lab value match tolerance as fraction (default: 0.05)', '0.05')
    .action(async (files: string[], options: { output?: string; report?: string; trust?: string; labTolerance: string }) => {
      const globalOpts = program.opts() as OutputOptions;

      if (files.length < 2) {
        printError('reconcile requires at least 2 input files', globalOpts);
        process.exitCode = 1;
        return;
      }

      const trustScores: Record<string, number> = {};
      if (options.trust) {
        for (const pair of options.trust.split(',')) {
          const [sys, score] = pair.split('=');
          if (sys && score) trustScores[sys] = parseFloat(score);
        }
      }
      const labTolerance = parseFloat(options.labTolerance);

      printVerbose(`Reconciling ${files.length} files`, globalOpts);
      printVerbose(`Trust scores: ${JSON.stringify(trustScores)}`, globalOpts);

      // Read all files
      const inputs: Array<{ content: string; systemName: string; file: string }> = [];
      for (const filePath of files) {
        let turtle: string;
        try {
          turtle = readFileSync(filePath, 'utf-8');
        } catch {
          printError(`Cannot read file: ${filePath}`, globalOpts);
          process.exitCode = 1;
          return;
        }

        const systemName = basename(filePath, '.ttl').replace(/_/g, '-');
        inputs.push({ content: turtle, systemName, file: filePath });
        printVerbose(`  Loading ${filePath} (system: ${systemName})`, globalOpts);
      }

      const result = await runReconciliation(
        inputs.map(i => ({ content: i.content, systemName: i.systemName })),
        { trustScores, labTolerance },
      );

      // Output
      if (options.output) {
        writeFileSync(options.output, result.turtle);
        console.error(`Merged Turtle written to: ${options.output}`);
      } else {
        console.log(result.turtle);
      }

      const reportData = {
        generatedAt: new Date().toISOString(),
        sources: result.report.sources,
        summary: result.report.summary,
        transformations: result.report.transformations,
        unresolvedConflicts: result.report.unresolvedConflicts,
      };

      if (options.report) {
        writeFileSync(options.report, JSON.stringify(reportData, null, 2));
        console.error(`Report written to: ${options.report}`);
      }

      // Summary to stderr
      const { summary } = result.report;
      console.error(`\nReconciliation summary:`);
      console.error(`  Input records:       ${summary.totalInputRecords}`);
      console.error(`  Exact duplicates:    -${summary.exactDuplicatesRemoved}`);
      console.error(`  Near-duplicates:     ~${summary.nearDuplicatesMerged} merged`);
      console.error(`  Conflicts resolved:  ${summary.conflictsResolved}`);
      if (summary.conflictsUnresolved > 0) {
        console.error(`  Unresolved:          ${summary.conflictsUnresolved}`);
      }
      console.error(`  Final records:       ${summary.finalRecordCount}`);

      if (globalOpts.json) {
        printResult(reportData, globalOpts);
      }
    });
}
