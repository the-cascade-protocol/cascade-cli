/**
 * cascade pod add-record <pod-dir> --type <curie> --json '<propsJson>' [--by <actorIri>]
 *
 * Add a NEW self-reported record (NOT an annotation overlay). The record is
 * routed to its canonical bucket file (clinical/<type>.ttl or wellness/...) via
 * the SAME type->file map import.ts uses, tagged on two orthogonal axes:
 *   - SOURCE: cascade:dataProvenance cascade:SelfReported + a real
 *     prov:wasAttributedTo actor (the --by IRI, else the Pod patient WebID).
 *   - VERIFICATION: workbench:verificationStatus workbench:Unverified (self-
 *     entered data is unverified until corroborated; mirrors FHIR).
 * Plus dct:created and a minted urn:uuid: id.
 *
 * <propsJson> is an object of { "<curie>": "<value>" }. It is read from the
 * --json arg, or from the CASCADE_RECORD_JSON environment variable when --json
 * is omitted (useful for large payloads).
 *
 * --json result (global --json flag):
 *   { added: true, recordUri, type }
 */

import type { Command } from 'commander';
import * as path from 'node:path';
import { DataFactory } from 'n3';
import type { Quad } from 'n3';
import { printResult, printError, printVerbose, type OutputOptions } from '../../lib/output.js';
import { DATA_TYPES, resolvePodDir, fileExists, type DataTypeInfo } from './helpers.js';
import { resolvePodDek, mintUri } from '../../lib/annotations.js';
import { mergeIntoBucket, KNOWN_PREFIXES } from '../../lib/bucket-write.js';

const { namedNode, literal, quad: makeQuad } = DataFactory;

// CURIE prefix -> namespace IRI for expanding --type and property CURIEs.
const PREFIX_NS: Record<string, string> = {
  cascade: 'https://ns.cascadeprotocol.org/core/v1#',
  core: 'https://ns.cascadeprotocol.org/core/v1#',
  health: 'https://ns.cascadeprotocol.org/health/v1#',
  clinical: 'https://ns.cascadeprotocol.org/clinical/v1#',
  coverage: 'https://ns.cascadeprotocol.org/coverage/v1#',
  checkup: 'https://ns.cascadeprotocol.org/checkup/v1#',
  pots: 'https://ns.cascadeprotocol.org/pots/v1#',
  workbench: 'https://ns.cascadeprotocol.org/workbench/v1#',
  fhir: 'http://hl7.org/fhir/',
};

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// The Pod's canonical patient WebID (see `cascade pod init`), used as the
// default prov:wasAttributedTo actor for a self-entered record when --by is
// not supplied — so attribution is a real PROV-O triple that survives export,
// not just a UI affordance.
const PATIENT_WEBID = '/profile/card.ttl#me';

/** Expand a CURIE (prefix:local) to a full IRI, or return it unchanged. */
function expandCurie(curie: string): string | undefined {
  const idx = curie.indexOf(':');
  if (idx < 0) return undefined;
  const prefix = curie.slice(0, idx);
  const local = curie.slice(idx + 1);
  const ns = PREFIX_NS[prefix];
  if (!ns) return undefined;
  return ns + local;
}

/** Find the DATA_TYPES bucket key whose rdfTypes contains the type IRI. */
function findBucketForType(typeIri: string): { key: string; info: DataTypeInfo } | undefined {
  for (const [key, info] of Object.entries(DATA_TYPES)) {
    if (info.isFhirPassthroughBucket) continue;
    if (info.rdfTypes.includes(typeIri)) return { key, info };
  }
  return undefined;
}

export function registerAddRecordSubcommand(pod: Command, program: Command): void {
  pod
    .command('add-record')
    .description('Add a new self-reported record to its canonical bucket file')
    .argument('<pod-dir>', 'Path to the Cascade Pod directory')
    // propsJson is an optional positional so the documented `--json '<propsJson>'`
    // surface works: the global boolean `--json` flag absorbs `--json` and the
    // following `'{...}'` value lands here. CASCADE_RECORD_JSON is the env fallback.
    .argument('[propsJson]', 'JSON object of { "<curie>": "<value>" } properties')
    .requiredOption('--type <curie>', 'rdf:type CURIE of the new record, e.g. clinical:Medication')
    .option('--by <actorIri>', 'Optional actor IRI (prov:wasAttributedTo)')
    .action(async (
      podDirArg: string,
      propsJson: string | undefined,
      options: { type: string; by?: string },
    ) => {
      const globalOpts = program.opts() as OutputOptions;
      const podDir = resolvePodDir(podDirArg);

      if (!(await fileExists(path.join(podDir, 'index.ttl')))) {
        printError(`Pod not found at ${podDir} (no index.ttl). Run 'cascade pod init' first.`, globalOpts);
        process.exitCode = 1;
        return;
      }

      // Resolve the type CURIE to a full IRI and its destination bucket.
      const typeIri = expandCurie(options.type);
      if (!typeIri) {
        printError(`Unknown type CURIE prefix: ${options.type}`, globalOpts);
        process.exitCode = 1;
        return;
      }
      const bucket = findBucketForType(typeIri);
      if (!bucket) {
        printError(
          `No known bucket for type ${options.type}. Supported types are the Cascade record classes registered in the data-type map.`,
          globalOpts,
        );
        process.exitCode = 1;
        return;
      }

      // Read propsJson from the positional arg (e.g. `--json '{...}'`), else from
      // the CASCADE_RECORD_JSON env var.
      const rawProps = propsJson ?? process.env.CASCADE_RECORD_JSON;
      if (!rawProps) {
        printError('No properties provided. Pass --json \'{...}\' or set CASCADE_RECORD_JSON.', globalOpts);
        process.exitCode = 1;
        return;
      }
      let props: Record<string, unknown>;
      try {
        props = JSON.parse(rawProps) as Record<string, unknown>;
        if (typeof props !== 'object' || props === null || Array.isArray(props)) {
          throw new Error('propsJson must be a JSON object');
        }
      } catch (e: unknown) {
        printError(`Invalid --json payload: ${e instanceof Error ? e.message : String(e)}`, globalOpts);
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

      const recordUri = mintUri();
      const createdIso = new Date().toISOString();

      // Build the record as QUADS, never as text. Every CURIE is expanded here,
      // so the serializer decides how (or whether) to abbreviate it — which is
      // why `--type core:X` / `core:someProperty` can no longer emit a CURIE
      // whose prefix the header never declared.
      const subject = namedNode(recordUri);
      const newQuads: Quad[] = [makeQuad(subject, namedNode(RDF_TYPE), namedNode(typeIri))];
      for (const [curie, value] of Object.entries(props)) {
        // Validate each property CURIE expands to a known namespace.
        const predicateIri = expandCurie(curie);
        if (!predicateIri) {
          printError(`Unknown property CURIE prefix: ${curie}`, globalOpts);
          process.exitCode = 1;
          return;
        }
        newQuads.push(makeQuad(subject, namedNode(predicateIri), literal(String(value))));
      }
      // Source axis: who reported it (self) — and a real attribution triple.
      newQuads.push(makeQuad(
        subject,
        namedNode(KNOWN_PREFIXES.cascade + 'dataProvenance'),
        namedNode(KNOWN_PREFIXES.cascade + 'SelfReported'),
      ));
      newQuads.push(makeQuad(
        subject,
        namedNode(KNOWN_PREFIXES.prov + 'wasAttributedTo'),
        namedNode(options.by ?? PATIENT_WEBID),
      ));
      // Verification axis (orthogonal to source): self-entered data is unverified
      // until corroborated. Mirrors FHIR verificationStatus.
      newQuads.push(makeQuad(
        subject,
        namedNode(KNOWN_PREFIXES.workbench + 'verificationStatus'),
        namedNode(KNOWN_PREFIXES.workbench + 'Unverified'),
      ));
      newQuads.push(makeQuad(
        subject,
        namedNode(KNOWN_PREFIXES.dct + 'created'),
        literal(createdIso, namedNode(KNOWN_PREFIXES.xsd + 'dateTime')),
      ));

      const targetFile = path.join(podDir, bucket.info.directory, bucket.info.filename);

      // Read-merge-write through the bucket chokepoint: the existing document's
      // own prefix declarations are harvested and kept, so a bucket an import
      // wrote does not lose `rxnorm:` / `sct:` / `loinc:` / `vcard:` the moment
      // a hand-entered record lands in it.
      try {
        await mergeIntoBucket(targetFile, newQuads, dek);
      } catch (e: unknown) {
        printError(e instanceof Error ? e.message : String(e), globalOpts);
        process.exitCode = 1;
        return;
      }

      const result = { added: true, recordUri, type: options.type };

      // The documented `--json '<propsJson>'` surface sets the global boolean
      // `--json` (the value lands in the positional), so JSON output is the norm.
      if (globalOpts.json) {
        printResult(result, globalOpts);
      } else {
        printVerbose(`Wrote record to ${bucket.info.directory}/${bucket.info.filename}`, globalOpts);
        console.log(`Record added: ${recordUri}`);
        console.log(`  Type: ${options.type}`);
        console.log(`  File: ${bucket.info.directory}/${bucket.info.filename}`);
      }
    });
}
