/**
 * cascade pod add-record <pod-dir> --type <curie> --json '<propsJson>' [--by <actorIri>]
 *
 * Add a NEW self-reported record (NOT an annotation overlay). The record is
 * routed to its canonical bucket file (clinical/<type>.ttl or wellness/...) via
 * the SAME type->file map import.ts uses, tagged cascade:dataProvenance
 * cascade:SelfReported plus an optional actor and dct:created, with a minted
 * urn:uuid: id.
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
import * as fs from 'node:fs/promises';
import { printResult, printError, printVerbose, type OutputOptions } from '../../lib/output.js';
import { DATA_TYPES, resolvePodDir, fileExists, type DataTypeInfo } from './helpers.js';
import {
  resolvePodDek,
  mintUri,
  escapeTurtleString,
} from '../../lib/annotations.js';
import { readResource, writeResource } from '../../lib/pod-encryption.js';

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

const TURTLE_PREFIX_HEADER = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
@prefix coverage: <https://ns.cascadeprotocol.org/coverage/v1#> .
@prefix checkup: <https://ns.cascadeprotocol.org/checkup/v1#> .
@prefix pots: <https://ns.cascadeprotocol.org/pots/v1#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

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

      // Build the record's predicate/object lines from propsJson.
      const lines: string[] = [`    a ${options.type}`];
      for (const [curie, value] of Object.entries(props)) {
        // Validate each property CURIE expands to a known namespace.
        if (!expandCurie(curie)) {
          printError(`Unknown property CURIE prefix: ${curie}`, globalOpts);
          process.exitCode = 1;
          return;
        }
        lines.push(`    ${curie} "${escapeTurtleString(String(value))}"`);
      }
      lines.push('    cascade:dataProvenance cascade:SelfReported');
      if (options.by) {
        lines.push(`    prov:wasAttributedTo <${options.by}>`);
      }
      lines.push(`    dct:created "${escapeTurtleString(createdIso)}"^^xsd:dateTime`);

      const block = `<${recordUri}>\n${lines.join(' ;\n')} .\n`;

      const targetFile = path.join(podDir, bucket.info.directory, bucket.info.filename);

      // Read-merge-write into the bucket file (preserve a single prefix header).
      let mergedBody = block;
      if (await fileExists(targetFile)) {
        const existing = readResource(targetFile, dek);
        const existingBody = stripPrefixHeader(existing);
        mergedBody = existingBody.trim().length > 0
          ? `${existingBody.trimEnd()}\n\n${block}`
          : block;
      }
      const merged = `${TURTLE_PREFIX_HEADER}\n${mergedBody}`;

      await fs.mkdir(path.dirname(targetFile), { recursive: true });
      writeResource(targetFile, merged, dek);

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

/** Strip leading @prefix / @base header lines, returning the statement body. */
function stripPrefixHeader(turtle: string): string {
  const lines = turtle.split('\n');
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('@prefix') || trimmed.startsWith('@base')) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join('\n');
}
