/**
 * cascade pod export <pod-dir>
 *
 * Export pod data as a ZIP archive or directory copy.
 */

import type { Command } from 'commander';
import * as path from 'path';
import { printResult, printError, printVerbose, type OutputOptions } from '../../lib/output.js';
import { resolvePodDir, isDirectory, copyDirectory, createZipArchive } from './helpers.js';

export function registerExportSubcommand(pod: Command, program: Command): void {
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
}
