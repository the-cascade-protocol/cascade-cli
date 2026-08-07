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
 * Exit codes:
 *   0 — the record was erased
 *   1 — usage error (no --confirm, no pod, the record genuinely is not there)
 *   2 — a file that might hold the record could NOT be read
 *
 * The third one matters more here than anywhere else. The search loop used to
 * `catch { continue }` past any file it could not open, so on an encrypted pod
 * read without the key EVERY bucket was skipped and the command reported
 * "Record not found" — about a record sitting right there. For an erasure verb
 * the direction of the error is the whole point: never say "not found" about a
 * file you could not open. A record that IS found while other files were
 * unreadable still warns, because the search was not exhaustive.
 *
 * --json result:
 *   { erased: true, tombstoneUri, recordUri, action }
 */

import type { Command } from 'commander';
import * as path from 'node:path';
import { type Quad } from 'n3';
import {
  printResult,
  printError,
  printErrorDetail,
  printVerbose,
  printWarning,
  type OutputOptions,
} from '../../lib/output.js';
import { resolvePodDir, fileExists, discoverTtlFiles } from './helpers.js';
import {
  appendOverlay,
  mintUri,
  iriRef,
  strLit,
  type OverlayLine,
} from '../../lib/annotations.js';
import {
  openPod,
  listFiles,
  PodUnreadableError,
  type PodReader,
  type PodReadFailure,
} from '../../lib/pod-read.js';
import { mergeIntoBucket, derelativizeQuads, relBase, relBaseFor } from '../../lib/bucket-write.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** The action this command records on its Tombstone. */
const ERASE_ACTION = 'hard-erase';

/** Default actor for the erasure audit event (the Pod patient WebID). */
const PATIENT_WEBID = '/profile/card.ttl#me';

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

      // Open the pod ONCE. Exit 2, not 1: a pod that will not open is "could
      // not read what exists", and the caller must be able to tell that apart
      // from the record genuinely not being there.
      let reader: PodReader;
      try {
        reader = await openPod(podDir);
      } catch (e: unknown) {
        if (e instanceof PodUnreadableError) {
          printErrorDetail(
            e.message,
            { encrypted: true, readable: false, reason: e.reason },
            globalOpts,
          );
        } else {
          printError(e instanceof Error ? e.message : String(e), globalOpts);
        }
        process.exitCode = 2;
        return;
      }
      const dek = reader.dek;

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
      // Every file the search could not open. ANY failure counts here, not just
      // the ones the read layer calls fatal elsewhere: a file this command
      // could not parse might be the file holding the record, and "I did not
      // look there" is not "it is not there".
      const unreadable: PodReadFailure[] = [];

      for (const file of allTtl) {
        if (excludeFiles.has(file)) continue;
        if ([...excludeDirs].some((d) => file.startsWith(d + path.sep))) continue;

        // A SENTINEL base, not the file URL and not '': the surviving quads are
        // re-serialized back to this same file, so a relative IRI must come out
        // exactly as it went in. The file URL would rewrite it absolutely; ''
        // leaves N3's _baseRoot undefined and silently turns
        // </profile/card.ttl#me> into "undefined/profile/card.ttl#me".
        // derelativizeQuads strips the sentinel straight back off, so the
        // subject match below compares the IRI the user typed.
        //
        // relBaseFor sees this file's decrypted text and guarantees the base is
        // not already in it, so an IRI a third party wrote to LOOK like the
        // sentinel is left alone rather than rewritten into another resource.
        const parsed = reader.parseFile(file, { baseIri: relBaseFor });
        if (!parsed.ok) {
          unreadable.push(parsed.failure);
          continue;
        }
        // Keep walking after a hit. Only the FIRST match is erased (unchanged),
        // but the loop no longer stops there, because whether the user is told
        // about an unreadable file must not depend on where it happens to sort
        // relative to the file the record was found in.
        if (foundFile) continue;

        // relBaseFor has just made that base the active one, so it is the base
        // this file was parsed under.
        const quads = derelativizeQuads(parsed.value.quads, relBase());
        const match = quads.filter((q) => q.subject.value === options.record);
        if (match.length > 0) {
          foundFile = file;
          subjectQuads = match;
          remainingQuads = quads.filter((q) => q.subject.value !== options.record);
        }
      }

      if (!foundFile) {
        // "Not found" is only honest when everything was actually searched.
        if (unreadable.length > 0) {
          printErrorDetail(
            `Could not read ${unreadable.length} file(s) while searching ${podDir} for ` +
              `${options.record}: ${listFiles(unreadable)}. The record was not found in the ` +
              `files that COULD be read, which is not the same as the record not existing. ` +
              `Nothing was erased.`,
            {
              readable: false,
              reason: 'files-unreadable',
              erased: false,
              files: unreadable.map((f) => f.file),
            },
            globalOpts,
          );
          process.exitCode = 2;
          return;
        }
        printError(`Record not found in any bucket file: ${options.record}`, globalOpts);
        process.exitCode = 1;
        return;
      }

      // Found it, but the sweep still stepped over files. The erasure below is
      // correct; the claim "this record is now gone from the pod" is only as
      // good as the files that were searched, so say which were not.
      if (unreadable.length > 0) {
        printWarning(
          `Erasing ${options.record}, but ${unreadable.length} file(s) could not be read and ` +
            `were not searched: ${listFiles(unreadable)}. If a copy of this record is in one of ` +
            `them it was NOT erased.`,
          globalOpts,
        );
      }

      // Capture the erased type (category only, if present). We deliberately do
      // NOT hash the erased content: a hash of low-entropy health triples is
      // still pseudonymised personal data and would defeat the erasure.
      const typeQuad = subjectQuads.find((q) => q.predicate.value === RDF_TYPE);
      const erasedType = typeQuad ? shortenType(typeQuad.object.value) : undefined;

      // Re-serialize the bucket WITHOUT the erased subject and write it back,
      // through the chokepoint so the file keeps the prefixes it declared
      // rather than being flattened onto whichever set this command knows.
      try {
        await mergeIntoBucket(foundFile, [], dek, { combine: () => remainingQuads });
      } catch (e: unknown) {
        printError(e instanceof Error ? e.message : String(e), globalOpts);
        process.exitCode = 1;
        return;
      }

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
