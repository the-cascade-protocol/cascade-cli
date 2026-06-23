/**
 * cascade pod erase <pod-dir> --record <uri> --confirm [--reason <r>] [--by <actorIri>]
 *
 * HARD delete: locate the record's subject in its bucket file, remove that
 * subject from the bucket file (read-merge-write minus the subject,
 * re-encrypting), and write a CONTENT-FREE workbench:Tombstone audit marker to
 * annotations/.
 *
 * The Tombstone records only the EVENT — the erased record's opaque id, the
 * action, the actor (prov:wasAttributedTo), and the timestamp (dct:created). It
 * deliberately retains NO content hash: a SHA-256 of an erased record's triples
 * is still pseudonymised personal data (EDPB Guidelines 01/2025; WP29 WP216),
 * because health content is low-entropy and enumerable, so a hash is
 * brute-forceable and would re-create the very erasure obligation this command
 * discharges. The Tombstone is thus the content-free audit/provenance event.
 *
 * This is the ONLY records command that mutates a base bucket file (removal);
 * every other command is purely additive. `--confirm` is REQUIRED.
 *
 * --json result:
 *   { erased: true, tombstoneUri, recordUri, action }
 */

import type { Command } from 'commander';
import * as path from 'node:path';
import { Parser, type Quad } from 'n3';
import { printResult, printError, printVerbose, type OutputOptions } from '../../lib/output.js';
import { resolvePodDir, fileExists, discoverTtlFiles } from './helpers.js';
import {
  resolvePodDek,
  appendOverlay,
  mintUri,
  iriRef,
  strLit,
  type OverlayLine,
} from '../../lib/annotations.js';
import { readResource, writeResource } from '../../lib/pod-encryption.js';
import { quadsToTurtle } from '../../lib/fhir-converter/types.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** The action this command records on its Tombstone. */
const ERASE_ACTION = 'hard-erase';

/** Default actor for the erasure audit event (the Pod patient WebID). */
const PATIENT_WEBID = '/profile/card.ttl#me';

/** Parse Turtle into a flat quad array. */
function parseQuads(turtle: string): Quad[] {
  const parser = new Parser({ format: 'Turtle' });
  return parser.parse(turtle);
}

/** Shorten a known rdf:type IRI to a CURIE for the Tombstone audit marker. */
function shortenType(iri: string): string {
  const map: Record<string, string> = {
    'https://ns.cascadeprotocol.org/core/v1#': 'cascade:',
    'https://ns.cascadeprotocol.org/health/v1#': 'health:',
    'https://ns.cascadeprotocol.org/clinical/v1#': 'clinical:',
    'https://ns.cascadeprotocol.org/coverage/v1#': 'coverage:',
    'https://ns.cascadeprotocol.org/checkup/v1#': 'checkup:',
    'https://ns.cascadeprotocol.org/pots/v1#': 'pots:',
    'http://hl7.org/fhir/': 'fhir:',
  };
  for (const [ns, prefix] of Object.entries(map)) {
    if (iri.startsWith(ns)) return prefix + iri.slice(ns.length);
  }
  return iri;
}

export function registerEraseSubcommand(pod: Command, program: Command): void {
  pod
    .command('erase')
    .description('Hard-delete a record from its bucket file and write a Tombstone audit marker')
    .argument('<pod-dir>', 'Path to the Cascade Pod directory')
    .requiredOption('--record <uri>', 'IRI of the record to erase')
    .option('--confirm', 'Required confirmation for the destructive hard delete')
    .option('--reason <r>', 'Optional rationale for the erasure')
    .option('--by <actorIri>', 'Optional actor IRI (prov:wasAttributedTo)')
    .action(async (
      podDirArg: string,
      options: { record: string; confirm?: boolean; reason?: string; by?: string },
    ) => {
      const globalOpts = program.opts() as OutputOptions;
      const podDir = resolvePodDir(podDirArg);

      if (!(await fileExists(path.join(podDir, 'index.ttl')))) {
        printError(`Pod not found at ${podDir} (no index.ttl). Run 'cascade pod init' first.`, globalOpts);
        process.exitCode = 1;
        return;
      }

      if (!options.confirm) {
        printError('Refusing to hard-erase without --confirm (this permanently removes the record bytes).', globalOpts);
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

      // Find the bucket file that contains the subject. Search data + extra
      // ttl files, excluding overlays, indexes, profile, and settings.
      const allTtl = await discoverTtlFiles(podDir);
      const excludeDirs = new Set([
        path.join(podDir, 'annotations'),
        path.join(podDir, 'settings'),
        path.join(podDir, 'profile'),
      ]);
      const excludeFiles = new Set([
        path.join(podDir, 'index.ttl'),
        path.join(podDir, 'manifest.ttl'),
      ]);

      let foundFile: string | undefined;
      let subjectQuads: Quad[] = [];
      let remainingQuads: Quad[] = [];

      for (const file of allTtl) {
        if (excludeFiles.has(file)) continue;
        if ([...excludeDirs].some((d) => file.startsWith(d + path.sep))) continue;

        let quads: Quad[];
        try {
          quads = parseQuads(readResource(file, dek));
        } catch {
          continue;
        }
        const match = quads.filter((q) => q.subject.value === options.record);
        if (match.length > 0) {
          foundFile = file;
          subjectQuads = match;
          remainingQuads = quads.filter((q) => q.subject.value !== options.record);
          break;
        }
      }

      if (!foundFile) {
        printError(`Record not found in any bucket file: ${options.record}`, globalOpts);
        process.exitCode = 1;
        return;
      }

      // Capture the erased type (category only, if present). We deliberately do
      // NOT hash the erased content: a hash of low-entropy health triples is
      // still pseudonymised personal data and would defeat the erasure.
      const typeQuad = subjectQuads.find((q) => q.predicate.value === RDF_TYPE);
      const erasedType = typeQuad ? shortenType(typeQuad.object.value) : undefined;

      // Re-serialize the bucket WITHOUT the erased subject and write it back.
      const newBucketTurtle = await quadsToTurtle(remainingQuads);
      writeResource(foundFile, newBucketTurtle, dek);

      // Write the content-free Tombstone overlay (the erasure audit event).
      const tombstoneUri = mintUri();
      const createdIso = new Date().toISOString();

      const lines: OverlayLine[] = [
        { predicate: 'workbench:erasedRecord', object: iriRef(options.record) },
        { predicate: 'workbench:erasureAction', object: strLit(ERASE_ACTION) },
      ];
      if (erasedType) {
        lines.push({ predicate: 'workbench:erasedType', object: strLit(erasedType) });
      }
      if (options.reason) {
        lines.push({ predicate: 'workbench:erasureReason', object: strLit(options.reason) });
      }

      try {
        await appendOverlay(
          podDir,
          {
            fileName: 'tombstones.ttl',
            subjectUri: tombstoneUri,
            rdfType: 'workbench:Tombstone',
            lines,
            // Always attribute the erasure so the audit event records WHO; the
            // tombstone is then id + actor + timestamp + action (content-free).
            actorIri: options.by ?? PATIENT_WEBID,
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
        erased: true,
        tombstoneUri,
        recordUri: options.record,
        action: ERASE_ACTION,
      };

      if (globalOpts.json) {
        printResult(result, globalOpts);
      } else {
        printVerbose(`Removed ${options.record} from ${path.relative(podDir, foundFile)}`, globalOpts);
        console.log(`Record erased: ${options.record}`);
        console.log(`  Action:    ${ERASE_ACTION}`);
        console.log(`  Tombstone: ${tombstoneUri}`);
      }
    });
}
