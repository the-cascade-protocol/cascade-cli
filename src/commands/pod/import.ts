/**
 * cascade pod import <pod-dir> <files...>
 *
 * Import FHIR JSON or Cascade Turtle files into a Cascade Pod.
 *
 * Converts FHIR to Cascade Turtle if needed, optionally reconciles multiple
 * inputs, routes records by type to the correct pod data files, updates type
 * indexes, and appends ldp:contains references to index.ttl.
 *
 * Options:
 *   --source-system <name>   Tag all records with this system name
 *   --no-reconcile           Skip reconciliation even with multiple files
 *   --trust <scores>         Trust scores e.g. hospital=0.95,clinic=0.85
 *   --dry-run                Preview without writing any files
 *   --report <file>          Write import report JSON to file
 *   --passthrough <mode>     Passthrough mode: full|minimal (default: full)
 */

import type { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Parser } from 'n3';
import type { Quad } from 'n3';
import { printResult, printError, printVerbose, printWarning, type OutputOptions } from '../../lib/output.js';
import { convert } from '../../lib/fhir-converter/index.js';
import { type SectionCensusEntry } from '../../lib/fhir-converter/types.js';
import { SOURCE_EHR_UNKNOWN } from '../../lib/fhir-converter/provenance.js';
import {
  resolveReferenceEdges,
  buildResourceRefsFromQuads,
  RECORD_EDGE_PREDICATES,
} from '../../lib/fhir-converter/reference-resolution.js';
import { runReconciliation, type ReconcilerInput } from '../../lib/reconciler.js';
import {
  liftTrappedLiterals,
  emptyLiftSummary,
  mergeLiftSummary,
  liftSummaryTotal,
  type LiteralLiftSummary,
} from '../../lib/literal-lifting.js';
import { detectSource, type FileSourceMeta, type CompletenessCheck } from '../../lib/source-adapters/registry.js';
import {
  DATA_TYPES,
  resolvePodDir,
  fileExists,
  applyCardIdentityName,
} from './helpers.js';
import {
  writePendingConflicts,
  generateConflictId,
  type PendingConflict,
} from '../../lib/user-resolutions.js';
import { randomUUID } from 'node:crypto';
import {
  isPodEncrypted,
  resolveDek,
  readResource,
  writeResource,
  PodDecryptError,
} from '../../lib/pod-encryption.js';
import { obtainPassphrase } from '../../lib/passphrase.js';
import { classifyImportInput, isPathInsidePod } from '../../lib/import-input.js';
import { mergeIntoBucket, derelativizeQuads, relBaseFor } from '../../lib/bucket-write.js';
import { toJsonText } from '../../lib/json-output.js';
import { appendTier0Journal, TIER0_JOURNAL_RELATIVE_PATH } from '../../lib/tier0-journal.js';
import { shellCommand } from '../../lib/shell-quote.js';

// ---------------------------------------------------------------------------
// Import report type
// ---------------------------------------------------------------------------

interface ImportReport {
  importedAt: string;
  podDir: string;
  sources: Array<{ file: string; system: string; resourceCount: number; warnings: string[] }>;
  reconciliation?: {
    enabled: boolean;
    crossBatch?: boolean;
    existingRecordsLoaded?: number;
    summary?: object;
  };
  filesWritten: Array<{
    path: string;
    recordsAdded: number;
    /**
     * Of `recordsAdded`, how many subjects the target file did not already hold.
     * `recordsAdded` counts every subject WRITTEN, which on the cross-batch
     * replace path is the file's whole post-merge content, so on a re-import of
     * data the pod already has it equals the total and reads as if everything
     * were new.
     */
    recordsNew: number;
    type: string;
  }>;
  typeCounts: Record<string, number>;
  /**
   * Pod-relative bucket paths this import REFUSED to write because the file
   * already on disk could not be read as Turtle. Their records were not
   * imported and those files are byte-unchanged. Non-empty means a non-zero
   * exit code: an unreadable bucket holds unknown content, and overwriting it
   * would turn a broken header into lost records.
   */
  bucketsRefused: string[];
  /** Record counts grouped by EHR of origin (clinical:sourceEHR), for the plan. */
  sourceBreakdown: Record<string, number>;
  /** "Do we have everything?" checks from container adapters (e.g. source labels). */
  completeness: CompletenessCheck[];
  totalRecordsImported: number;
  /**
   * Of `totalRecordsImported`, how many subjects the pod did not already hold,
   * and how many it did. An honest re-import summary: a 100% duplicate import
   * reports `recordsNew: 0` instead of restating the whole pod as if it were
   * fresh. The fuller {new, duplicate, conflict} record report is tracked separately;
   * these two are the subset of it this command can answer from disk today.
   */
  recordsNew: number;
  recordsAlreadyPresent: number;
  /**
   * Cross-record edge resolution tally across all converted inputs: how many
   * reference edges (clinical:hasLabResult, coverage:relatedClaim) were written
   * as resolved subject IRIs vs dropped because the referenced record was not in
   * the batch. The fuller {new, duplicate, conflict} record report is tracked separately.
   */
  edgeResolution: {
    resolved: number;
    unresolved: number;
    /**
     * Record-to-record edges the pod holds after this import, counted over the
     * merged result rather than over this run's rewrites.
     *
     * `resolved`/`unresolved` are per-RUN deltas: they count placeholders this
     * invocation turned into edges. On a re-import of data the pod already has,
     * the reconciler recognizes those edges as already stated and there is
     * nothing left to resolve, so the deltas legitimately fall to zero — which
     * read as edge LOSS while being the opposite. This total is the
     * number a "K of N and J linked" surface wants: stable across re-imports.
     */
    totalInPod: number;
    byPredicate: Record<string, { resolved: number; unresolved: number; totalInPod: number }>;
  };
  /**
   * M1 trapped-literal lifting: relations that arrived as strings, turned into
   * real edges. Run ONCE over the merged result (every input plus the existing
   * pod) rather than per file, because the condition a literal names is
   * routinely in another file of the same import or already in the pod.
   */
  literalLifting: LiteralLiftSummary;
  /**
   * Per-section entries-read vs records-written, for sectioned source documents
   * (C-CDA). A section that offered structured entries and produced no records
   * appears here with `recordsOut: 0` and is also named in `warnings`. Without
   * it an import that dropped three whole clinical sections printed a record
   * count, omitted the empty buckets, and read as a success.
   */
  sectionCensus: SectionCensusEntry[];
  warnings: string[];
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Load existing pod data as ReconcilerInput records for cross-batch dedup
// ---------------------------------------------------------------------------

async function loadExistingPodData(
  podDir: string,
  dek?: Buffer,
): Promise<{ inputs: ReconcilerInput[]; unreadable: string[] }> {
  // Pod data directories that contain reconcilable records
  const DATA_DIRS = ['clinical', 'wellness'];
  const inputs: ReconcilerInput[] = [];
  const unreadable: string[] = [];

  for (const dir of DATA_DIRS) {
    const dirPath = path.join(podDir, dir);
    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch {
      continue; // Directory doesn't exist yet
    }

    for (const file of files) {
      if (!file.endsWith('.ttl')) continue;
      const filePath = path.join(dirPath, file);
      try {
        const content = readResource(filePath, dek);
        if (content.trim().length === 0) continue;
        // PARSE-CHECK here, not just read-check. The reconciler parses these
        // strings with no error handling of its own, so a bucket whose header
        // was damaged used to take the whole import down with an unhandled
        // rejection and a raw stack trace. Naming the file and carrying on is
        // safe because the write chokepoint independently refuses to overwrite
        // any bucket it cannot parse — the records in it are never lost, and
        // never silently replaced by a partial rewrite either.
        await parseTurtleToQuads(content);
        // `existingPod` is the marker the reconciler actually keys its
        // cross-batch path on. `systemName` cannot carry it: it is only the
        // DEFAULT source system for records that state none, and every record
        // the pod holds states one.
        inputs.push({ content, systemName: 'existing-pod', existingPod: true });
      } catch {
        unreadable.push(`${dir}/${file}`);
      }
    }
  }

  return { inputs, unreadable };
}

// ---------------------------------------------------------------------------
// Turtle parsing helper: returns map from subject URI -> Quad[]
// ---------------------------------------------------------------------------

async function parseTurtleToQuads(turtle: string): Promise<Map<string, Quad[]>> {
  return new Promise((resolve, reject) => {
    // The SENTINEL base, because this turtle can be a pod file's own content on
    // its way back to that same file. N3's default leaves _baseRoot undefined,
    // so </profile/card.ttl#me> resolves to "undefined/profile/card.ttl#me".
    // derelativizeQuads puts it back, so the subject keys
    // this map is dedup-ed by are the IRIs the file actually states.
    //
    // The base is chosen against THIS text and the strip below uses that same
    // base: third-party Turtle reaches this parser (`pod import` of a .ttl), and
    // an IRI the document merely wrote to LOOK like the sentinel must not be
    // rewritten into the different, real resource hiding behind it.
    const base = relBaseFor(turtle);
    const parser = new Parser({ format: 'Turtle', baseIRI: base });
    const collected: Quad[] = [];

    parser.parse(turtle, (error, quad) => {
      if (error) { reject(error); return; }
      if (!quad) {
        const bySubject = new Map<string, Quad[]>();
        for (const q of derelativizeQuads(collected, base)) {
          const subj = q.subject.value;
          if (!bySubject.has(subj)) bySubject.set(subj, []);
          bySubject.get(subj)!.push(q);
        }
        resolve(bySubject);
        return;
      }
      collected.push(quad);
    });
  });
}

// ---------------------------------------------------------------------------
// Route a subject's rdf:type to a DATA_TYPES key
// ---------------------------------------------------------------------------

function routeTypeKey(quads: Quad[]): string {
  const rdfTypeIri = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const typeQuad = quads.find(q => q.predicate.value === rdfTypeIri);
  const typeIri = typeQuad?.object.value ?? '';

  // Exact match first
  for (const [key, info] of Object.entries(DATA_TYPES)) {
    if (info.isFhirPassthroughBucket) continue;
    if (info.rdfTypes.includes(typeIri)) return key;
  }

  // FHIR passthrough: type starts with http://hl7.org/fhir/
  if (typeIri.startsWith('http://hl7.org/fhir/')) return 'fhir-passthrough';

  // Unknown type: fallback to fhir-passthrough
  return 'fhir-passthrough';
}

// ---------------------------------------------------------------------------
// Shorten a full IRI to a prefixed form for type registrations
// ---------------------------------------------------------------------------

const PREFIX_MAP: Record<string, string> = {
  'https://ns.cascadeprotocol.org/core/v1#': 'cascade',
  'https://ns.cascadeprotocol.org/health/v1#': 'health',
  'https://ns.cascadeprotocol.org/clinical/v1#': 'clinical',
  'https://ns.cascadeprotocol.org/coverage/v1#': 'coverage',
  'http://hl7.org/fhir/': 'fhir',
};

function shortenForTurtle(iri: string): string {
  for (const [ns, prefix] of Object.entries(PREFIX_MAP)) {
    if (iri.startsWith(ns)) return `${prefix}:${iri.slice(ns.length)}`;
  }
  return `<${iri}>`;
}

// ---------------------------------------------------------------------------
// Self-heal: declare any PREFIX_MAP prefix the appended block uses but the file
// lacks. A type registration's `solid:forClass` CURIE can name any PREFIX_MAP
// prefix (clinical:, health:, coverage:, cascade:, fhir:). Pods initialized
// before a given prefix was added to the index header would otherwise produce an
// unparseable index (e.g. "Undefined prefix coverage:" after a Claim import).
// Returns the "@prefix ..." lines to prepend (empty string when none needed).
// ---------------------------------------------------------------------------

export function missingPrefixHeader(block: string, existingContent: string): string {
  const lines: string[] = [];
  for (const [ns, prefix] of Object.entries(PREFIX_MAP)) {
    const usedInBlock = block.includes(`${prefix}:`);
    const alreadyDeclared = new RegExp(`@prefix\\s+${prefix}:`).test(existingContent);
    if (usedInBlock && !alreadyDeclared) {
      lines.push(`@prefix ${prefix}: <${ns}> .`);
    }
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

// ---------------------------------------------------------------------------
// Build a TypeRegistration block
// ---------------------------------------------------------------------------

function buildTypeRegistration(key: string, info: typeof DATA_TYPES[string]): string {
  const forClass = shortenForTurtle(info.rdfTypes[0]);
  const instance = `</${info.directory}/${info.filename}>`;
  return `\n<#${key}> a solid:TypeRegistration ;\n    solid:forClass ${forClass} ;\n    solid:instance ${instance} .\n`;
}

// ---------------------------------------------------------------------------
// Determine which type index a DATA_TYPE entry should register in
// ---------------------------------------------------------------------------

function typeIndexForInfo(info: typeof DATA_TYPES[string]): 'publicTypeIndex.ttl' | 'privateTypeIndex.ttl' {
  return info.directory === 'clinical' ? 'publicTypeIndex.ttl' : 'privateTypeIndex.ttl';
}

// ---------------------------------------------------------------------------
// Append to type index file (string manipulation to preserve comments)
// ---------------------------------------------------------------------------

export async function appendTypeRegistration(
  indexPath: string,
  key: string,
  info: typeof DATA_TYPES[string],
  dryRun: boolean,
  dek?: Buffer,
): Promise<boolean> {
  const content = readResource(indexPath, dek);

  // Check if already registered (by key name)
  if (content.includes(`<#${key}>`) || content.includes(`/${info.filename}`)) {
    return false; // already present
  }

  const block = buildTypeRegistration(key, info);

  // Declare any prefix the appended block uses that the file does not yet
  // declare (e.g. coverage: for a Claim/ExplanationOfBenefit registration, or
  // fhir: for the passthrough catch-all). Without this, a strict-Turtle consumer
  // of the type index breaks with "Undefined prefix ...".
  const header = missingPrefixHeader(block, content);

  if (!dryRun) {
    // Read-modify-write (encrypted resources cannot be appended to in place).
    writeResource(indexPath, header + content + block, dek);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Append ldp:contains reference to index.ttl
// ---------------------------------------------------------------------------

async function appendIndexContains(
  indexPath: string,
  relPath: string,
  dryRun: boolean,
  dek?: Buffer,
): Promise<boolean> {
  const content = readResource(indexPath, dek);

  if (content.includes(relPath)) {
    return false; // already present
  }

  // Append a simple ldp:contains statement
  const line = `\n<> <http://www.w3.org/ns/ldp#contains> <${relPath}> .\n`;
  if (!dryRun) {
    // Read-modify-write (encrypted resources cannot be appended to in place).
    writeResource(indexPath, content + line, dek);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerImportSubcommand(pod: Command, program: Command): void {
  pod
    .command('import')
    .description('Import FHIR JSON or Cascade Turtle files into a pod')
    .argument('<pod-dir>', 'Path to the Cascade Pod directory')
    .argument('<files...>', 'Files or folders to import (FHIR JSON, Cascade Turtle, C-CDA XML/zip, or a folder / Apple Health export)')
    .option('--source-system <name>', 'Tag all imported records with this system name')
    .option('--no-reconcile', 'Skip reconciliation even when importing multiple files')
    .option('--reconcile-existing', 'Include existing pod records in reconciliation pass (cross-batch dedup, on by default; disable with --no-reconcile-existing)', true)
    .option('--no-reconcile-existing', 'Skip loading existing pod records (additive import only)')
    .option('--trust <scores>', 'Trust scores e.g. hospital=0.95,clinic=0.85')
    .option('--dry-run', 'Preview the import without writing any files')
    .option('--report <file>', 'Write import report JSON to this file')
    .option('--passthrough <mode>', 'Passthrough mode: full or minimal (default: full)', 'full')
    .action(async (
      podDirArg: string,
      files: string[],
      options: {
        sourceSystem?: string;
        reconcile: boolean;
        reconcileExisting?: boolean;
        trust?: string;
        dryRun?: boolean;
        report?: string;
        passthrough: string;
      },
    ) => {
      const globalOpts = program.opts() as OutputOptions;
      const podDir = resolvePodDir(podDirArg);
      const dryRun = options.dryRun ?? false;
      const passthroughMinimal = options.passthrough === 'minimal';

      // --- Step 1: Validate pod dir ---
      const indexTtlPath = path.join(podDir, 'index.ttl');
      if (!(await fileExists(indexTtlPath))) {
        printError(`Pod not found at ${podDir} (no index.ttl). Run 'cascade pod init' first.`, globalOpts);
        process.exitCode = 1;
        return;
      }

      // If the pod is encrypted, resolve the DEK so every pod-resource read/write
      // below routes through readResource/writeResource. Input FILES being
      // imported are always plaintext on disk (they are external inputs).
      let dek: Buffer | undefined;
      if (isPodEncrypted(podDir)) {
        try {
          const passphrase = await obtainPassphrase();
          dek = resolveDek(podDir, passphrase);
          printVerbose('Pod is encrypted; routing resource I/O through DEK.', globalOpts);
        } catch (e: unknown) {
          const msg =
            e instanceof PodDecryptError ? e.message : e instanceof Error ? e.message : String(e);
          printError(`Cannot write to encrypted pod: ${msg}`, globalOpts);
          process.exitCode = 1;
          return;
        }
      }

      if (dryRun) {
        printVerbose('Dry-run mode: no files will be written.', globalOpts);
      }

      // Parse trust scores
      const trustScores: Record<string, number> = {};
      if (options.trust) {
        for (const pair of options.trust.split(',')) {
          const [sys, score] = pair.split('=');
          if (sys && score) trustScores[sys] = parseFloat(score);
        }
      }

      // --- Step 1.5: Expand container inputs (folders, vendor exports) ---
      // A directory argument is run through the source-adapter registry, which
      // expands it into concrete importable files and records what it skipped
      // (e.g. an Apple Health export -> its clinical-records FHIR, skipping the
      // multi-GB device XMLs). Plain file arguments pass through unchanged.
      // Each entry carries an optional `label`: a source adapter's `sourceLabel`
      // (e.g. "Apple Health export") becomes the per-file source-system, so all
      // records from one export share one honest source-batch name instead of
      // each file's basename ("MedicationRequest-<id>"), which was the Source
      // facet wall. A plain file argument has no label (falls back to basename).
      const expandedFiles: { path: string; label?: string; source?: FileSourceMeta }[] = [];
      const sourceSkips: string[] = [];
      const completeness: CompletenessCheck[] = [];
      for (const arg of files) {
        const absArg = path.resolve(process.cwd(), arg);
        let isDirectory = false;
        try {
          isDirectory = (await fs.stat(absArg)).isDirectory();
        } catch {
          // Not stat-able; leave it for the per-file read below to report.
          expandedFiles.push({ path: arg });
          continue;
        }
        if (!isDirectory) {
          expandedFiles.push({ path: arg });
          continue;
        }
        const adapter = detectSource(absArg);
        if (!adapter) {
          printError(`Don't know how to import the folder: ${arg}`, globalOpts);
          process.exitCode = 1;
          return;
        }
        const expanded = adapter.expand(absArg);
        for (const s of expanded.skipped) {
          sourceSkips.push(`Skipped ${path.basename(s.path)}: ${s.reason}`);
        }
        if (expanded.completeness) completeness.push(...expanded.completeness);
        if (expanded.files.length === 0) {
          const why = expanded.skipped.length
            ? ` ${expanded.skipped.map((s) => s.reason).join('; ')}`
            : '';
          printError(
            `No importable records found in ${arg} (${expanded.sourceLabel}).${why}`,
            globalOpts,
          );
          process.exitCode = 1;
          return;
        }
        printVerbose(
          `${expanded.sourceLabel}: importing ${expanded.files.length} file(s)` +
            (expanded.skipped.length ? `, skipping ${expanded.skipped.length}` : ''),
          globalOpts,
        );
        expandedFiles.push(
          ...expanded.files.map((f) => ({
            path: f,
            label: expanded.sourceLabel,
            source: expanded.fileSources?.[f],
          })),
        );
      }

      // --- Step 2: Convert / collect inputs ---
      const reconcilerInputs: ReconcilerInput[] = [];
      const sourceReport: ImportReport['sources'] = [];
      const allWarnings: string[] = [...sourceSkips];
      // Accumulate per-section entries-read vs records-written across every
      // sectioned input, so the summary can state what each section yielded
      // rather than silently omitting the sections that yielded nothing.
      const sectionCensus: SectionCensusEntry[] = [];
      // Accumulate cross-record edge resolution across every converted FHIR input.
      const edgeResolution: ImportReport['edgeResolution'] = {
        resolved: 0,
        unresolved: 0,
        totalInPod: 0,
        byPredicate: {},
      };

      for (const entry of expandedFiles) {
        const filePath = entry.path;
        try {
        const absPath = path.resolve(process.cwd(), filePath);
        // Guard the whole-file read limit: a file over ~2 GiB cannot be read
        // whole (Node's fs.readFile cap). Skip it with a clear reason instead of
        // aborting the entire import. Streaming import will lift this.
        try {
          const sizeBytes = (await fs.stat(absPath)).size;
          if (sizeBytes > 2_000_000_000) {
            allWarnings.push(
              `Skipped ${path.basename(filePath)}: ${(sizeBytes / 1e9).toFixed(1)} GB exceeds the whole-file import limit (streaming import not yet supported)`,
            );
            continue;
          }
        } catch {
          // stat failed; let the read below produce the precise error.
        }
        // Read the input. Almost every input is an EXTERNAL document (a C-CDA
        // the user picked out of Downloads) and is plaintext on disk. The one
        // exception is an input that resolves INSIDE the destination pod — an
        // app writing a bundle to `<pod>/analysis/<id>.ttl` and importing the
        // file it just wrote. That is a pod resource, so on an encrypted pod it
        // must be read through the DEK we already resolved above.
        // Containment is decided by the filesystem, not by a flag, because a
        // flag would eventually be passed for a genuinely external file.
        let rawBytes: Buffer;
        try {
          let decrypted: string | undefined;
          if (dek && isPathInsidePod(absPath, podDir)) {
            try {
              decrypted = readResource(absPath, dek);
              printVerbose(`Input is a pod resource; decrypted with the pod DEK: ${filePath}`, globalOpts);
            } catch (e) {
              if (!(e instanceof PodDecryptError)) throw e;
              // A pod-internal resource that does not authenticate under the pod
              // DEK is a plaintext leftover. `pod encrypt` now walks the whole
              // pod, so a pod sealed by THIS build has none, but
              // three sources still produce them: pods sealed by an older CLI,
              // the MCP surface's plaintext writes, and any file a
              // migration pass deliberately left alone. Read it as plaintext
              // rather than failing an import that would otherwise succeed.
              //
              // This announces itself as a WARNING, not a verbose line: "a file
              // in your encrypted pod was not encrypted" is a trust-relevant
              // fact, and a user who never passes --verbose is exactly the user
              // who needs to hear it. Delete the whole fallback once 3.36 lands
              // and no writer can leave plaintext in a sealed pod.
              printWarning(
                `${filePath} is inside an encrypted pod but was NOT encrypted; it was read as plaintext.`,
                globalOpts,
              );
            }
          }
          rawBytes =
            decrypted !== undefined ? Buffer.from(decrypted, 'utf-8') : await fs.readFile(absPath);
        } catch {
          printError(`Cannot read file: ${absPath}`, globalOpts);
          process.exitCode = 1;
          return;
        }

        const systemName =
          options.sourceSystem ?? entry.label ?? path.basename(filePath, path.extname(filePath));
        const warnings: string[] = [];

        let turtleContent: string;
        let resourceCount = 0;

        // Route C-CDA ZIP/XML vs FHIR JSON vs Turtle. A recognized extension is
        // the fast path; a missing or unrecognized extension is decided by
        // sniffing the bytes, because real portal downloads arrive
        // extension-less and an IHE XDM zip that reaches the Turtle parser dies
        // with `Unexpected "PK..."`.
        const inputKind = classifyImportInput(absPath, rawBytes);
        if (inputKind === 'ccda') {
          // C-CDA ZIP or XML — convert natively
          printVerbose(`Converting C-CDA: ${filePath}`, globalOpts);
          const result = await convert(rawBytes, 'c-cda', 'cascade', 'turtle', systemName, passthroughMinimal, undefined, true);
          if (!result.success) {
            // Skip an unconvertible file with a reason rather than aborting the
            // whole batch: in a folder import (e.g. an IHE XDM export's manifest,
            // or one malformed document among many) the other files must still
            // import. The outer catch turns this into a skip-with-reason warning.
            throw new Error(
              result.errors.join(', ') || 'conversion produced no output',
            );
          }
          turtleContent = result.output;
          resourceCount = result.resourceCount;
          warnings.push(...result.warnings);
          allWarnings.push(...result.warnings.map(w => `${filePath}: ${w}`));
          for (const s of result.sectionCensus ?? []) {
            const acc = sectionCensus.find((e) => e.label === s.label && e.loinc === s.loinc);
            if (acc) {
              acc.entriesIn += s.entriesIn;
              acc.recordsOut += s.recordsOut;
              acc.handled = acc.handled || s.handled;
            } else {
              sectionCensus.push({ ...s });
            }
          }
          // C-CDA lab panels write clinical:hasLabResult edges; fold their tally
          // into the same import-summary accounting as the FHIR path.
          if (result.edgeResolution) {
            edgeResolution.resolved += result.edgeResolution.resolved;
            edgeResolution.unresolved += result.edgeResolution.unresolved;
            for (const [pred, c] of Object.entries(result.edgeResolution.byPredicate)) {
              const acc = (edgeResolution.byPredicate[pred] ??= { resolved: 0, unresolved: 0, totalInPod: 0 });
              acc.resolved += c.resolved;
              acc.unresolved += c.unresolved;
            }
          }
        } else {
          const content = rawBytes.toString('utf-8');
        if (inputKind === 'fhir-json') {
          // FHIR JSON
          printVerbose(`Converting FHIR JSON: ${filePath}`, globalOpts);
          // deferLiteralLifting + deferReferenceResolution: the condition a
          // reason names, and the record a reference points at, are routinely in
          // another file of this import or already in the pod (an Apple Health
          // export is one resource per file), so BOTH the lift and the
          // cross-record reference resolution run once below over the merged
          // result instead of per file. Per-file resolution
          // would drop every cross-file edge as unresolved.
          const result = await convert(content, 'fhir', 'cascade', 'turtle', systemName, passthroughMinimal, entry.source?.sourceEhr, true, true);
          if (!result.success) {
            // Skip an unconvertible file with a reason rather than aborting the
            // whole batch: in a folder import (e.g. an IHE XDM export's manifest,
            // or one malformed document among many) the other files must still
            // import. The outer catch turns this into a skip-with-reason warning.
            throw new Error(
              result.errors.join(', ') || 'conversion produced no output',
            );
          }
          turtleContent = result.output;
          resourceCount = result.resourceCount;
          warnings.push(...result.warnings);
          allWarnings.push(...result.warnings.map(w => `${filePath}: ${w}`));
          if (result.edgeResolution) {
            edgeResolution.resolved += result.edgeResolution.resolved;
            edgeResolution.unresolved += result.edgeResolution.unresolved;
            for (const [pred, c] of Object.entries(result.edgeResolution.byPredicate)) {
              const acc = (edgeResolution.byPredicate[pred] ??= { resolved: 0, unresolved: 0, totalInPod: 0 });
              acc.resolved += c.resolved;
              acc.unresolved += c.unresolved;
            }
          }
        } else {
          // Assume Turtle
          printVerbose(`Reading Turtle: ${filePath}`, globalOpts);
          turtleContent = content;
          // Count subjects as rough resource count
          try {
            const quadsMap = await parseTurtleToQuads(turtleContent);
            resourceCount = quadsMap.size;
          } catch {
            resourceCount = 0;
          }
        }
        } // end non-ZIP branch

        reconcilerInputs.push({ content: turtleContent, systemName });
        sourceReport.push({ file: filePath, system: systemName, resourceCount, warnings });
        } catch (e) {
          // Resilience: a single malformed file becomes a skip-with-reason, not a
          // crashed import. Essential when a folder yields hundreds of files and
          // one carries a shape the converter cannot handle.
          allWarnings.push(
            `Skipped ${path.basename(filePath)}: conversion error (${e instanceof Error ? e.message : String(e)})`,
          );
          continue;
        }
      }

      // --- Step 3: Reconcile or concatenate ---
      let mergedTurtle: string;
      let reconciliationSummary: object | undefined;
      // Count of record-to-record edge objects the reconciler redirected from a
      // merged-away subject to its survivor.
      let reconciledEdgeRewrites = 0;

      // Load existing pod data as an implicit source 0 when --reconcile-existing is set
      let existingInputs: ReconcilerInput[] = [];
      if (options.reconcileExisting !== false) {
        const existing = await loadExistingPodData(podDir, dek);
        existingInputs = existing.inputs;
        for (const rel of existing.unreadable) {
          printWarning(
            `Existing pod file ${rel} could not be read as Turtle and was excluded from ` +
              `reconciliation. It will NOT be written to either.`,
            globalOpts,
          );
        }
        if (existingInputs.length > 0) {
          printVerbose(`Loaded ${existingInputs.length} existing pod file(s) for cross-batch reconciliation.`, globalOpts);
        }
      }

      const allInputs = [...existingInputs, ...reconcilerInputs];
      const shouldReconcile = options.reconcile !== false && allInputs.length > 1;

      if (shouldReconcile) {
        printVerbose(`Reconciling ${allInputs.length} inputs (${existingInputs.length} existing + ${reconcilerInputs.length} new)...`, globalOpts);
        const reconcileResult = await runReconciliation(allInputs, {
          trustScores,
          labTolerance: 0.05,
        });
        mergedTurtle = reconcileResult.turtle;
        reconciliationSummary = reconcileResult.report.summary;
        reconciledEdgeRewrites = reconcileResult.report.summary.edgeObjectsRewritten;
        printVerbose(`Reconciliation complete. Final records: ${reconcileResult.report.summary.finalRecordCount}`, globalOpts);

        // Not printVerbose: an identity collision means two records this import
        // treats as different were minted onto ONE IRI, so the identity key that
        // produced it is narrower than the records it is identifying. That is a
        // defect in the source data or in a converter, and a user who is never
        // told has no way to discover it — the records look reconciled.
        const collisionsSplit = reconcileResult.report.summary.identityCollisionsSplit;
        if (collisionsSplit > 0) {
          printWarning(
            `${collisionsSplit} identity collision(s): two or more records with DIFFERENT content were ` +
            `assigned the same IRI. They have been kept as separate records rather than one being ` +
            `dropped as a duplicate, and raised as unresolved conflicts — run \`cascade pod conflicts\` ` +
            `to review them.`,
            globalOpts,
          );
        }

        // Persist unresolved conflicts to settings/pending-conflicts.ttl
        if (!dryRun) {
          const pendingConflicts: PendingConflict[] = (reconcileResult.report.unresolvedConflicts as Array<{
            recordType: string;
            matchedOn: string;
            sources?: string[];
            candidateUris?: string[];
            label?: string;
          }>).map((c) => ({
            uri: `urn:uuid:conflict-${randomUUID()}`,
            conflictId: generateConflictId(c.recordType, c.matchedOn),
            recordType: c.recordType,
            detectedAt: new Date(),
            candidateRecordUris: c.candidateUris ?? [],
            label: c.label,
            sourceA: c.sources?.[0],
            sourceB: c.sources?.[1],
          }));
          // With the DEK: on a sealed pod this file holds record types, source
          // EHR names and candidate record IRIs, and it used to be written back
          // in the clear on every import.
          //
          // Zero conflicts and no existing file means there is nothing to say:
          // creating a prefixes-only pending-conflicts.ttl announced a conflict
          // queue that does not exist. An existing file is still
          // rewritten when the list is empty, because "no conflicts remain" has
          // to be able to CLEAR stale entries from an earlier import.
          const conflictsFile = path.join(podDir, 'settings', 'pending-conflicts.ttl');
          if (pendingConflicts.length > 0 || (await fileExists(conflictsFile))) {
            await writePendingConflicts(podDir, pendingConflicts, dek);
          }
          if (pendingConflicts.length > 0) {
            printVerbose(`  ${pendingConflicts.length} unresolved conflict(s) written to settings/pending-conflicts.ttl`, globalOpts);
          }

          // Tier-0 merges applied WITHOUT asking. Journaled with the discarded
          // records' full content, which is the condition on which the ruling
          // allows them to be silent at all. Not printVerbose for the same
          // reason the identity-collision warning is not: a user who is never
          // told cannot review a decision that was made for them.
          const tier0 = reconcileResult.report.tier0Merges;
          if (tier0.length > 0) {
            appendTier0Journal(podDir, tier0, 'pod import', dek);
            printWarning(
              `${tier0.length} cross-source exact lab duplicate(s) merged automatically. ` +
                `Identical result, same instant, different known sources, merged without raising a ` +
                `conflict. Every one is recorded with the discarded records in ` +
                `${TIER0_JOURNAL_RELATIVE_PATH}, and can be undone from it.`,
              globalOpts,
            );
          }
        }
      } else {
        mergedTurtle = allInputs.map(i => i.content).join('\n\n');
      }

      // When cross-batch reconciliation ran, the output already represents the
      // complete merged state — use replace mode in the write step below.
      const useCrossBatchReplace = existingInputs.length > 0 && shouldReconcile;

      // --- Step 4: Parse merged Turtle into quads grouped by subject ---
      let subjectQuads: Map<string, Quad[]>;
      try {
        subjectQuads = await parseTurtleToQuads(mergedTurtle);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        printError(`Failed to parse merged Turtle: ${msg}`, globalOpts);
        process.exitCode = 1;
        return;
      }

      // --- Step 4a2: Resolve cross-record reference edges ---
      // The FHIR converter deferred reference resolution (each file was
      // converted separately, and an Apple Health export is one resource per
      // file, so a reference's target was almost never in the same batch). Every
      // placeholder edge therefore survived into this merged, reconciled quad
      // set. Resolve them ONCE here, over the whole import: build the
      // (resourceType, id) -> subject index from the merged records' persisted
      // source ids and rewrite each placeholder to the referenced record's real
      // subject, or drop-and-count it when the target is genuinely absent (e.g.
      // an Apple Health `.encounter` reference when the export carries no
      // Encounter resource). Building the index from the merged quads keeps this
      // reconciliation-safe: a record merged away is not in the index, so no
      // edge can resolve to a discarded subject. Runs before the literal lift so
      // both placeholder families are cleared before anything is written; a
      // no-op for the C-CDA path, which already resolved its edges in-batch.
      {
        const flat = [...subjectQuads.values()].flat();
        const refs = buildResourceRefsFromQuads(flat);
        const { quads: resolvedQuads, stats: refStats } = resolveReferenceEdges(flat, refs);
        edgeResolution.resolved += refStats.resolved;
        edgeResolution.unresolved += refStats.unresolved;
        for (const [pred, c] of Object.entries(refStats.byPredicate)) {
          const acc = (edgeResolution.byPredicate[pred] ??= { resolved: 0, unresolved: 0, totalInPod: 0 });
          acc.resolved += c.resolved;
          acc.unresolved += c.unresolved;
        }
        const regrouped = new Map<string, Quad[]>();
        for (const q of resolvedQuads) {
          const subj = q.subject.value;
          let arr = regrouped.get(subj);
          if (!arr) regrouped.set(subj, (arr = []));
          arr.push(q);
        }
        subjectQuads = regrouped;
      }

      // --- Step 4b: Lift trapped literals into real edges (M1) ---
      // Runs on the merged, reconciled quad set so a literal can resolve against
      // a condition in ANY input file or already in the pod, and so every edge
      // points at a surviving subject by construction (the reconciler has
      // already collapsed merged-away records). Also the point where every
      // parsed-indication placeholder is resolved or dropped, so none is ever
      // written to disk.
      const literalLifting: LiteralLiftSummary = emptyLiftSummary();
      {
        const merged = liftTrappedLiterals([...subjectQuads.values()].flat());
        mergeLiftSummary(literalLifting, merged.stats);
        // Re-group: the pass appends new edge quads and rewrites placeholders.
        const regrouped = new Map<string, Quad[]>();
        for (const q of merged.quads) {
          const subj = q.subject.value;
          let arr = regrouped.get(subj);
          if (!arr) regrouped.set(subj, (arr = []));
          arr.push(q);
        }
        subjectQuads = regrouped;
      }

      // Record-to-record edges the merged result actually holds. Counted here,
      // over the final quad set, because the per-run `resolved`/`unresolved`
      // deltas fall to zero on a re-import whose edges the pod already states —
      // honest as a delta, but read as edge loss by any surface that shows the
      // linked-record count.
      for (const [, quads] of subjectQuads) {
        for (const q of quads) {
          if (!RECORD_EDGE_PREDICATES.has(q.predicate.value)) continue;
          if (q.object.termType !== 'NamedNode') continue;
          edgeResolution.totalInPod++;
          // Same `prefix:local` label the resolution pass reports under, so the
          // per-run deltas and this total share one key per predicate.
          const pred = shortenForTurtle(q.predicate.value);
          const acc = (edgeResolution.byPredicate[pred] ??= {
            resolved: 0,
            unresolved: 0,
            totalInPod: 0,
          });
          acc.totalInPod++;
        }
      }

      // Source breakdown by EHR of origin (clinical:sourceEHR), for the pre-import
      // plan: exactly what the source-organized Records view will show, computed
      // from the merged/deduped quads so a --dry-run preview matches the real run.
      //
      // A subject carrying no clinical:sourceEHR is accounted under the ratified
      // Data Absent Reason token "unknown", not omitted. Omitting it made the
      // breakdown silently disagree with the record count beside it: a FHIR
      // bundle whose references are all `urn:uuid:` gives the provenance pass no
      // host to read and no institution-looking display, so eight records
      // imported and the source axis accounted for none of them — which reads as
      // "this pod has no data" rather than "we could not tell where this came
      // from". The token is the same one the C-CDA path already writes
      // (`deriveSourceEhr`), and it is deliberately NOT the import-batch label,
      // which says how the data got in rather than where it came from.
      const sourceBreakdown: Record<string, number> = {};
      const SRC_EHR_IRI = 'https://ns.cascadeprotocol.org/clinical/v1#sourceEHR';
      for (const [, quads] of subjectQuads) {
        const ehr = quads.find((q) => q.predicate.value === SRC_EHR_IRI);
        const key = ehr ? ehr.object.value : SOURCE_EHR_UNKNOWN;
        sourceBreakdown[key] = (sourceBreakdown[key] ?? 0) + 1;
      }

      // --- Step 5: Route subjects to DATA_TYPES buckets ---
      const buckets = new Map<string, Quad[][]>(); // key -> list of subject quad arrays
      for (const [, quads] of subjectQuads) {
        const key = routeTypeKey(quads);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(quads);
      }

      // --- Step 6 & 7: For each bucket, serialize and merge into pod files ---
      const filesWritten: ImportReport['filesWritten'] = [];
      const typeCounts: Record<string, number> = {};
      const newFiles: string[] = []; // relative paths (for index.ttl updates)
      // Buckets this import refused to write because the existing file could
      // not be read. Named in the summary and fatal to the exit code.
      const bucketsRefused: string[] = [];

      for (const [typeKey, subjectQArrays] of buckets) {
        const info = DATA_TYPES[typeKey];
        if (!info) {
          allWarnings.push(`Unknown type key: ${typeKey} — skipping`);
          continue;
        }

        const targetFile = path.join(podDir, info.directory, info.filename);
        const relPath = `${info.directory}/${info.filename}`;

        const allNewQuads = subjectQArrays.flat();

        let recordsAdded = subjectQArrays.length;
        // Of those, the subjects this file did not already hold. Equal to
        // recordsAdded on a fresh file; zero on a fully duplicate re-import.
        let recordsNew = subjectQArrays.length;
        const isNewFile = !(await fileExists(targetFile));

        // Every write below goes through the ONE bucket chokepoint, so the
        // file's own prefix declarations survive, relative IRIs survive, and an
        // existing bucket that does not parse is a refusal rather than a
        // silently emptied Map.
        try {
          if (useCrossBatchReplace) {
            // Cross-batch reconciliation: the reconciler output already
            // represents the complete merged state (existing + new, deduped),
            // so the file's contents are REPLACED, not appended to.
            const priorSubjects = new Set<string>();
            await mergeIntoBucket(targetFile, allNewQuads, dek, {
              dryRun,
              combine: (existing, incoming) => {
                // Which subjects are genuinely new needs the pre-import file.
                // The replace path used to never read it, which is why a
                // re-import reported its whole merged output as fresh records.
                for (const q of existing) priorSubjects.add(q.subject.value);
                return incoming;
              },
            });
            recordsAdded = subjectQArrays.length;
            if (!isNewFile) {
              recordsNew = subjectQArrays.filter(
                (quads) => quads.length > 0 && !priorSubjects.has(quads[0].subject.value),
              ).length;
            }
          } else {
            // Additive merge: keep every subject the file already holds and add
            // only the ones it lacks (dedup by subject URI).
            let addedCount = 0;
            await mergeIntoBucket(targetFile, allNewQuads, dek, {
              dryRun,
              combine: (existing) => {
                const bySubject = new Map<string, Quad[]>();
                for (const q of existing) {
                  const bucketQuads = bySubject.get(q.subject.value);
                  if (bucketQuads) bucketQuads.push(q);
                  else bySubject.set(q.subject.value, [q]);
                }
                for (const [subjectUri, quads] of subjectQuads) {
                  if (routeTypeKey(quads) === typeKey && !bySubject.has(subjectUri)) {
                    bySubject.set(subjectUri, quads);
                    addedCount++;
                  }
                }
                return Array.from(bySubject.values()).flat();
              },
            });
            // The additive path only ever writes subjects the file lacked.
            recordsAdded = addedCount;
            recordsNew = addedCount;
          }
        } catch (e: unknown) {
          // An existing bucket this import cannot read is a bucket whose
          // contents are unknown, and unknown is not empty. Refuse to write
          // THIS file, name it, and fail the run — overwriting it would take an
          // already-corrupted pod from "one broken header" to "records gone".
          const detail = e instanceof Error ? e.message : String(e);
          printError(`Refusing to write ${relPath}: ${detail}`, globalOpts);
          bucketsRefused.push(relPath);
          continue;
        }

        typeCounts[typeKey] = (typeCounts[typeKey] ?? 0) + recordsAdded;
        filesWritten.push({ path: targetFile, recordsAdded, recordsNew, type: typeKey });

        if (isNewFile) {
          newFiles.push(relPath);
        }

        printVerbose(`  ${dryRun ? '[dry-run] ' : ''}${isNewFile ? 'Created' : 'Updated'} ${relPath} (+${recordsAdded} records)`, globalOpts);
      }

      // --- Step 8: Update type indexes ---
      const settingsDir = path.join(podDir, 'settings');
      const publicIndexPath = path.join(settingsDir, 'publicTypeIndex.ttl');
      const privateIndexPath = path.join(settingsDir, 'privateTypeIndex.ttl');

      for (const [typeKey] of buckets) {
        const info = DATA_TYPES[typeKey];
        if (!info) continue;

        const indexFile = typeIndexForInfo(info);
        const indexPath = indexFile === 'publicTypeIndex.ttl' ? publicIndexPath : privateIndexPath;

        if (await fileExists(indexPath)) {
          const appended = await appendTypeRegistration(indexPath, typeKey, info, dryRun, dek);
          if (appended) {
            printVerbose(`  ${dryRun ? '[dry-run] ' : ''}Added type registration for ${typeKey} to ${indexFile}`, globalOpts);
          }
        }
      }

      // --- Step 9: Update index.ttl for new files ---
      for (const relPath of newFiles) {
        if (await fileExists(indexTtlPath)) {
          const appended = await appendIndexContains(indexTtlPath, relPath, dryRun, dek);
          if (appended) {
            printVerbose(`  ${dryRun ? '[dry-run] ' : ''}Added ${relPath} to index.ttl`, globalOpts);
          }
        }
      }

      // --- Step 9b: Populate card.ttl (name only) and profile/extended.ttl (PHI) ---
      const cardPath = path.join(podDir, 'profile', 'card.ttl');
      const extendedPath = path.join(podDir, 'profile', 'extended.ttl');
      if (!dryRun && await fileExists(cardPath)) {
        const profileFile = path.join(podDir, 'clinical', 'patient-profile.ttl');
        if (await fileExists(profileFile)) {
          try {
            const profileTurtle = readResource(profileFile, dek);
            const profileQuads = await parseTurtleToQuads(profileTurtle);
            // Find the PatientProfile subject
            const NS_CASCADE = 'https://ns.cascadeprotocol.org/core/v1#';
            const NS_VCARD = 'http://www.w3.org/2006/vcard/ns#';
            let patientSubjectQuads: Quad[] | undefined;
            for (const [, quads] of profileQuads) {
              if (quads.some(q =>
                q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
                q.object.value === `${NS_CASCADE}PatientProfile`)) {
                patientSubjectQuads = quads;
                break;
              }
            }
            if (patientSubjectQuads) {
              const getCascade = (pred: string) =>
                patientSubjectQuads!.find(q => q.predicate.value === `${NS_CASCADE}${pred}`)?.object.value ?? '';
              const getVcard = (pred: string) =>
                patientSubjectQuads!.find(q => q.predicate.value === `${NS_VCARD}${pred}`)?.object.value ?? '';

              const givenName = getCascade('givenName');
              const familyName = getCascade('familyName');
              const dob = getCascade('dateOfBirth');
              const sex = getCascade('biologicalSex');
              const phone = getVcard('hasTelephone');
              const email = getVcard('hasEmail');

              // Flat address predicates (stored directly on the patient subject)
              const street = getCascade('addressLine');
              const city = getCascade('addressCity');
              const state = getCascade('addressState');
              const postalCode = getCascade('addressPostalCode');

              const fullName = [givenName, familyName].filter(Boolean).join(' ');

              // ── card.ttl: public-safe name fields only ──
              // Shared identity-block writer (also used by pod init --owner-name
              // and pod profile set-name) so all three stay byte-consistent.
              if (fullName || givenName || familyName) {
                const cardTurtle = readResource(cardPath, dek);
                const updated = applyCardIdentityName(cardTurtle, { fullName, givenName, familyName });
                writeResource(cardPath, updated, dek);
                printVerbose('  Populated profile/card.ttl with name from PatientProfile', globalOpts);
              }

              // ── extended.ttl: PHI (DOB, sex, address, phone, email) ──
              const hasPhiData = dob || sex || phone || email || street;
              if (hasPhiData && await fileExists(extendedPath)) {
                const phiFields: string[] = [];
                if (dob) phiFields.push(`    cascade:dateOfBirth "${dob}"^^xsd:date ;`);
                if (sex) phiFields.push(`    cascade:biologicalSex "${sex}" ;`);
                if (phone) phiFields.push(`    vcard:hasTelephone "${phone}" ;`);
                if (email) phiFields.push(`    vcard:hasEmail "${email}" ;`);
                if (street || city || state || postalCode) {
                  const addrLines: string[] = [];
                  if (street) addrLines.push(`        cascade:addressLine "${street}" ;`);
                  if (city) addrLines.push(`        cascade:addressCity "${city}" ;`);
                  if (state) addrLines.push(`        cascade:addressState "${state}" ;`);
                  if (postalCode) addrLines.push(`        cascade:addressPostalCode "${postalCode}" ;`);
                  phiFields.push(`    cascade:address [\n${addrLines.join('\n')}\n    ] ;`);
                }

                const extTurtle = readResource(extendedPath, dek);
                // Replace the commented-out PHI block (from # ── Demographics to the trailing dot)
                const updated = extTurtle.replace(
                  /    # ── Demographics ──\n[\s\S]*?\n    \./,
                  `    # ── Demographics ──\n${phiFields.join('\n')}\n    .`,
                );
                writeResource(extendedPath, updated, dek);
                printVerbose('  Populated profile/extended.ttl with PHI from PatientProfile', globalOpts);
              }
            }
          } catch {
            // Non-fatal: profile population is best-effort
          }
        }
      }

      // --- Step 10: Summary and report ---
      const totalRecordsImported = Object.values(typeCounts).reduce((a, b) => a + b, 0);
      const recordsNew = filesWritten.reduce((a, f) => a + f.recordsNew, 0);
      const recordsAlreadyPresent = totalRecordsImported - recordsNew;

      const importReport: ImportReport = {
        importedAt: new Date().toISOString(),
        podDir,
        sources: sourceReport,
        reconciliation: shouldReconcile
          ? {
              enabled: true,
              crossBatch: existingInputs.length > 0,
              existingRecordsLoaded: existingInputs.length,
              summary: reconciliationSummary,
            }
          : { enabled: false },
        filesWritten,
        typeCounts,
        bucketsRefused,
        sourceBreakdown,
        completeness,
        totalRecordsImported,
        recordsNew,
        recordsAlreadyPresent,
        edgeResolution,
        literalLifting,
        sectionCensus,
        warnings: allWarnings,
        dryRun,
      };

      // Written under --dry-run too. Dry-run is where a machine-readable report
      // matters MOST — a GUI preflight ("here is what importing this would do")
      // has no other way to get the numbers — and the report already carries
      // `dryRun: true` so a consumer can tell a preview from a completed import.
      // The report file is a user-named output path, not pod content, so writing
      // it does not break the dry-run promise of leaving the pod untouched.
      if (options.report) {
        await fs.writeFile(options.report, toJsonText(importReport), 'utf-8');
        printVerbose(
          `${dryRun ? '[dry-run] ' : ''}Import report written to: ${options.report}`,
          globalOpts,
        );
      }

      if (globalOpts.json) {
        printResult(importReport, globalOpts);
      } else {
        if (dryRun) {
          console.log(`\n[dry-run] Import preview for pod: ${podDir}`);
        } else {
          console.log(`\nImport complete: ${podDir}`);
        }
        console.log(`  Sources:          ${sourceReport.length} file(s)`);
        // "Records imported: 243" on a re-import of 243 records the pod already
        // held read as 243 fresh records. Name the duplicates.
        console.log(
          `  Records imported: ${totalRecordsImported}` +
            (recordsAlreadyPresent > 0
              ? ` (${recordsNew} new, ${recordsAlreadyPresent} already in pod)`
              : ''),
        );
        console.log(`  Files written:    ${filesWritten.length}`);
        const bySource = Object.entries(sourceBreakdown).sort((a, b) => b[1] - a[1]);
        if (bySource.length > 0) {
          console.log(`  By source (EHR of origin):`);
          for (const [src, count] of bySource) console.log(`    - ${src}: ${count}`);
        }
        if (completeness.length > 0) {
          console.log(`  Completeness:`);
          for (const c of completeness) {
            const ok = c.recovered >= c.total ? 'OK' : 'partial';
            console.log(`    - ${c.label}: ${c.recovered}/${c.total} (${ok})`);
            if (c.note) console.log(`        ${c.note}`);
          }
        }
        // Every structured section the source offered, including the ones that
        // produced nothing. The previous summary listed only non-empty record
        // buckets, so a section read in full and imported as zero was invisible.
        if (sectionCensus.length > 0) {
          console.log(`  Structured sections (entries read -> records imported):`);
          for (const s of [...sectionCensus].sort((a, b) => a.label.localeCompare(b.label))) {
            const flag =
              s.recordsOut === 0 && s.entriesIn > 0
                ? s.handled ? '  <-- NOTHING IMPORTED' : '  <-- NOTHING IMPORTED (section type not supported)'
                : '';
            console.log(`    - ${s.label}: ${s.entriesIn} -> ${s.recordsOut}${flag}`);
          }
        }
        const edgeTotal =
          edgeResolution.resolved + edgeResolution.unresolved + edgeResolution.totalInPod;
        if (edgeTotal > 0) {
          // Lead with the number the pod HOLDS. The per-run "resolved" count
          // legitimately falls to zero on a re-import whose edges are already
          // stated, and on its own that reads as edge loss.
          console.log(`  Record-to-record edges: ${edgeResolution.totalInPod} in pod` +
            ` (${edgeResolution.resolved} newly resolved this import` +
            (edgeResolution.unresolved > 0 ? `, ${edgeResolution.unresolved} dropped (reference target not in import)` : '') +
            `)`);
          for (const [pred, c] of Object.entries(edgeResolution.byPredicate)) {
            console.log(`    - ${pred}: ${c.totalInPod} in pod` +
              ` (${c.resolved} newly resolved` + (c.unresolved > 0 ? `, ${c.unresolved} dropped` : '') + `)`);
          }
        }
        if (liftSummaryTotal(literalLifting) > 0) {
          const lc = literalLifting.linkedCondition;
          const pi = literalLifting.parsedIndication;
          console.log(`  Edges lifted from record text: ${lc.lifted + pi.lifted}`);
          if (lc.lifted + lc.unresolved > 0) {
            console.log(`    - clinical:linkedCondition: ${lc.lifted} lifted` +
              (lc.unresolved > 0 ? `, ${lc.unresolved} unresolved (no such condition in pod)` : ''));
          }
          if (pi.lifted + pi.ambiguous + pi.unmatched + pi.redundant > 0) {
            const notes = [
              pi.ambiguous > 0 ? `${pi.ambiguous} ambiguous` : '',
              pi.unmatched > 0 ? `${pi.unmatched} unmatched` : '',
              pi.redundant > 0 ? `${pi.redundant} already stated` : '',
            ].filter(Boolean).join(', ');
            console.log(`    - clinical:parsedIndicationReference: ${pi.lifted} lifted` +
              (notes ? ` (${notes})` : ''));
          }
        }
        if (reconciledEdgeRewrites > 0) {
          console.log(`  Edges repaired on merge: ${reconciledEdgeRewrites} redirected to the surviving record`);
        }
        if (allWarnings.length > 0) {
          console.log(`  Warnings:         ${allWarnings.length}`);
          for (const w of allWarnings) {
            console.log(`    - ${w}`);
          }
        }
        for (const [type, count] of Object.entries(typeCounts)) {
          if (count > 0) console.log(`  ${type}: +${count}`);
        }

        // Nudge: check if any C-CDA narrative blocks need LLM extraction
        if (!dryRun) {
          try {
            const documentsPath = path.join(podDir, 'clinical', 'documents.ttl');
            if (await fileExists(documentsPath)) {
              const docContent = readResource(documentsPath, dek);
              const narrativeCount = (docContent.match(/cascade:requiresLLMExtraction/g) ?? []).length;
              if (narrativeCount > 0) {
                console.log('');
                console.log(`  ℹ  Found ${narrativeCount} section(s) with narrative text for AI extraction.`);
                console.log(`     Run: ${shellCommand('cascade', 'pod', 'extract', podDirArg)}`);
              }
            }
          } catch { /* non-fatal */ }
        }
      }

      // A refused bucket is not a warning. Its records were NOT imported and
      // the caller must be able to see that without parsing prose.
      if (bucketsRefused.length > 0) {
        printError(
          `${bucketsRefused.length} bucket(s) could not be read and were left untouched: ` +
            `${bucketsRefused.join(', ')}. The records routed to them were NOT imported. ` +
            `Repair or remove those files and re-run the import.`,
          globalOpts,
        );
        process.exitCode = 1;
      }
    });
}
