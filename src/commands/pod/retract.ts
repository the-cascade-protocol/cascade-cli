/**
 * cascade pod retract <pod-dir> --record <uri> [--reason <r>]
 *                              [--superseded-by <keptUri>] [--by <actorIri>]
 *
 * Write an append-only workbench:Retraction overlay that soft-deletes /
 * supersedes a record (the entered-in-error pattern). The retracted record's
 * bytes are retained; this overlay marks it withdrawn and may point at the kept
 * record when merging duplicates.
 *
 * --json result:
 *   { retracted: true, retractionUri, recordUri, supersededBy }
 */

import type { Command } from 'commander';
import { printResult, printError, printVerbose, type OutputOptions } from '../../lib/output.js';
import { resolvePodDir, fileExists } from './helpers.js';
import {
  resolvePodDek,
  appendOverlay,
  mintUri,
  iriRef,
  strLit,
  type OverlayLine,
} from '../../lib/annotations.js';
import * as path from 'node:path';

export function registerRetractSubcommand(pod: Command, program: Command): void {
  pod
    .command('retract')
    .description('Soft-delete / supersede a record via an append-only Retraction overlay')
    .argument('<pod-dir>', 'Path to the Cascade Pod directory')
    .requiredOption('--record <uri>', 'IRI of the record to retract')
    .option('--reason <r>', 'Optional rationale (e.g. "entered in error")')
    .option('--superseded-by <keptUri>', 'Optional IRI of the kept record when merging duplicates')
    .option('--by <actorIri>', 'Optional actor IRI (prov:wasAttributedTo)')
    .action(async (
      podDirArg: string,
      options: { record: string; reason?: string; supersededBy?: string; by?: string },
    ) => {
      const globalOpts = program.opts() as OutputOptions;
      const podDir = resolvePodDir(podDirArg);

      if (!(await fileExists(path.join(podDir, 'index.ttl')))) {
        printError(`Pod not found at ${podDir} (no index.ttl). Run 'cascade pod init' first.`, globalOpts);
        process.exitCode = 1;
        return;
      }

      let dek: Buffer | undefined;
      try {
        dek = await resolvePodDek(podDir);
      } catch (e: unknown) {
        printError(e instanceof Error ? e.message : String(e), globalOpts);
        process.exitCode = 1;
        return;
      }

      const retractionUri = mintUri();
      const createdIso = new Date().toISOString();

      const lines: OverlayLine[] = [
        { predicate: 'workbench:retractsRecord', object: iriRef(options.record) },
      ];
      if (options.reason) {
        lines.push({ predicate: 'workbench:retractionReason', object: strLit(options.reason) });
      }
      if (options.supersededBy) {
        lines.push({ predicate: 'workbench:supersededBy', object: iriRef(options.supersededBy) });
      }

      try {
        await appendOverlay(
          podDir,
          {
            fileName: 'retractions.ttl',
            subjectUri: retractionUri,
            rdfType: 'workbench:Retraction',
            lines,
            actorIri: options.by,
            createdIso,
          },
          dek,
        );
      } catch (e: unknown) {
        printError(e instanceof Error ? e.message : String(e), globalOpts);
        process.exitCode = 1;
        return;
      }

      const result = {
        retracted: true,
        retractionUri,
        recordUri: options.record,
        supersededBy: options.supersededBy ?? null,
      };

      if (globalOpts.json) {
        printResult(result, globalOpts);
      } else {
        printVerbose('Wrote Retraction to annotations/retractions.ttl', globalOpts);
        console.log(`Retraction written: ${retractionUri}`);
        console.log(`  Record: ${options.record}`);
        if (options.supersededBy) {
          console.log(`  Superseded by: ${options.supersededBy}`);
        }
      }
    });
}
