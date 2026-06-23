/**
 * cascade pod annotate <pod-dir> --record <uri> [--text <note>]
 *                                [--property <curie> --value <val>] [--by <actorIri>]
 *
 * Write an append-only workbench:Annotation overlay that ADDS a note or extra
 * attribute to an existing record (does not override). The original record is
 * never modified.
 *
 * --json result:
 *   { annotated: true, annotationUri, recordUri }
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

export function registerAnnotateSubcommand(pod: Command, program: Command): void {
  pod
    .command('annotate')
    .description('Add a note or extra attribute to a record via an append-only Annotation overlay')
    .argument('<pod-dir>', 'Path to the Cascade Pod directory')
    .requiredOption('--record <uri>', 'IRI of the record to annotate')
    .option('--text <note>', 'Free-text note to attach to the record')
    .option('--property <curie>', 'Predicate CURIE of an extra attribute (paired with --value)')
    .option('--value <val>', 'Value of the extra attribute named by --property')
    .option('--by <actorIri>', 'Optional actor IRI (prov:wasAttributedTo)')
    .action(async (
      podDirArg: string,
      options: { record: string; text?: string; property?: string; value?: string; by?: string },
    ) => {
      const globalOpts = program.opts() as OutputOptions;
      const podDir = resolvePodDir(podDirArg);

      if (!(await fileExists(path.join(podDir, 'index.ttl')))) {
        printError(`Pod not found at ${podDir} (no index.ttl). Run 'cascade pod init' first.`, globalOpts);
        process.exitCode = 1;
        return;
      }

      // Require at least one of --text or --value (mirrors the SHACL shape).
      if (!options.text && !options.value) {
        printError('Provide at least one of --text or --value (with --property).', globalOpts);
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

      const annotationUri = mintUri();
      const createdIso = new Date().toISOString();

      const lines: OverlayLine[] = [
        { predicate: 'workbench:annotatesRecord', object: iriRef(options.record) },
      ];
      if (options.text) {
        lines.push({ predicate: 'workbench:annotationText', object: strLit(options.text) });
      }
      if (options.property) {
        lines.push({ predicate: 'workbench:annotationProperty', object: strLit(options.property) });
      }
      if (options.value) {
        lines.push({ predicate: 'workbench:annotationValue', object: strLit(options.value) });
      }

      try {
        await appendOverlay(
          podDir,
          {
            fileName: 'annotations.ttl',
            subjectUri: annotationUri,
            rdfType: 'workbench:Annotation',
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
        annotated: true,
        annotationUri,
        recordUri: options.record,
      };

      if (globalOpts.json) {
        printResult(result, globalOpts);
      } else {
        printVerbose('Wrote Annotation to annotations/annotations.ttl', globalOpts);
        console.log(`Annotation written: ${annotationUri}`);
        console.log(`  Record: ${options.record}`);
      }
    });
}
