/**
 * cascade pod amend <pod-dir> --record <uri> --property <curie> --value <val>
 *                             [--reason <r>] [--by <actorIri>]
 *
 * Write an append-only workbench:Amendment overlay that overrides one property
 * value on an existing record. The original record is never modified.
 *
 * --json result:
 *   { amended: true, amendmentUri, recordUri, property, value }
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

export function registerAmendSubcommand(pod: Command, program: Command): void {
  pod
    .command('amend')
    .description('Override one property value on a record via an append-only Amendment overlay')
    .argument('<pod-dir>', 'Path to the Cascade Pod directory')
    .requiredOption('--record <uri>', 'IRI of the record to amend')
    .requiredOption('--property <curie>', 'Predicate CURIE being overridden, e.g. clinical:dosage')
    .requiredOption('--value <val>', 'The new value that supersedes the original')
    .option('--reason <r>', 'Optional rationale for the amendment')
    .option('--by <actorIri>', 'Optional actor IRI (prov:wasAttributedTo)')
    .action(async (
      podDirArg: string,
      options: { record: string; property: string; value: string; reason?: string; by?: string },
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

      const amendmentUri = mintUri();
      const createdIso = new Date().toISOString();

      const lines: OverlayLine[] = [
        { predicate: 'workbench:amendsRecord', object: iriRef(options.record) },
        { predicate: 'workbench:amendsProperty', object: strLit(options.property) },
        { predicate: 'workbench:amendedValue', object: strLit(options.value) },
      ];
      if (options.reason) {
        lines.push({ predicate: 'workbench:amendmentReason', object: strLit(options.reason) });
      }

      try {
        await appendOverlay(
          podDir,
          {
            fileName: 'amendments.ttl',
            subjectUri: amendmentUri,
            rdfType: 'workbench:Amendment',
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
        amended: true,
        amendmentUri,
        recordUri: options.record,
        property: options.property,
        value: options.value,
      };

      if (globalOpts.json) {
        printResult(result, globalOpts);
      } else {
        printVerbose(`Wrote Amendment to annotations/amendments.ttl`, globalOpts);
        console.log(`Amendment written: ${amendmentUri}`);
        console.log(`  Record:   ${options.record}`);
        console.log(`  Override: ${options.property} = ${options.value}`);
      }
    });
}
