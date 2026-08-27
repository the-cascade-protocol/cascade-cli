/**
 * cascade sources coverage <pod-dir>
 *
 * What a pod's retained raw sources say that the pod's records do not.
 *
 * This is the runtime twin of the conformance gate in
 * `tests/fhir-field-coverage.test.ts`: the same differential computation
 * (convert, convert again without one element, compare), pointed at a real
 * pod's `sources/` rather than at fixtures. Fixtures prove the converters
 * behave as the manifests say; this verb answers the question a person actually
 * has, which is "what did MY import leave behind".
 *
 * THE OUTPUT IS PHI-FREE BY CONSTRUCTION
 * --------------------------------------
 * Element paths and counts. `Encounter.reasonCode: 41` says forty-one
 * encounters stated a reason and none of them reached the pod; it does not say
 * what any reason was. Nothing read out of the sources is ever printed, which is
 * what makes the report shareable: a design partner can send the SHAPE of what
 * their EHR populates without sending a value out of their pod. That is the
 * corpus-growth path — a new path in someone's report becomes a synthetic
 * fixture here.
 *
 * NOTHING REPORTED HERE IS LOST
 * -----------------------------
 * The raw bundles are retained. Every field below is recoverable by re-import
 * once the converter emits it; no new pull from the EHR is needed. The summary
 * line says so, because a number without that sentence reads as data destroyed.
 *
 * Exit codes (docs/exit-codes.md):
 *   0 — the sources were read and the report below is of their actual contents
 *   1 — usage error (no such directory, or the pod retains no sources/)
 *   2 — the pod, or a file inside it, could NOT be read
 *
 * NOTE ON COVERAGE BY THE READ-HONESTY BATTERY: `tests/pod-read-conformance.test.ts`
 * enumerates the subcommands of `pod`, so this top-level verb inherits nothing
 * from it. The three exit codes are honoured here by hand, and the gap is worth
 * closing rather than working around.
 */

import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  printResult,
  printError,
  printErrorDetail,
  printVerbose,
  printWarning,
  type OutputOptions,
} from '../lib/output.js';
import {
  openPod,
  resolvePodDir,
  isDirectory,
  PodReadLedger,
  PodUnreadableError,
  unreadableFilesMessage,
  type PodReader,
} from '../lib/pod-read.js';
import {
  CoverageAccumulator,
  coverageDisclosure,
  type CoverageReport,
} from '../lib/fhir-converter/field-coverage/analyze.js';

/** The pod-relative directory a pod retains its raw imported sources in. */
const SOURCES_DIR = 'sources';

/** Extensions the scan attempts to parse as FHIR JSON. */
const JSON_EXTENSIONS = new Set(['.json', '.ndjson']);

async function listSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (JSON_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  };
  await walk(dir);
  out.sort();
  return out;
}

/**
 * Every FHIR resource one source document holds.
 *
 * Accepts a Bundle, a bare resource, or NDJSON (one resource per line), because
 * all three are shapes a retained pull actually takes.
 */
function resourcesIn(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const fromValue = (value: unknown): unknown[] => {
    const obj = value as { resourceType?: string; entry?: Array<{ resource?: unknown }> };
    if (obj?.resourceType === 'Bundle' && Array.isArray(obj.entry)) {
      return obj.entry.map((e) => e?.resource).filter((r): r is object => Boolean(r));
    }
    return obj?.resourceType ? [value] : [];
  };
  try {
    return fromValue(JSON.parse(trimmed));
  } catch {
    // NDJSON: one JSON document per line.
    const out: unknown[] = [];
    for (const line of trimmed.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try {
        out.push(...fromValue(JSON.parse(l)));
      } catch {
        return [];
      }
    }
    return out;
  }
}

/** A stable key for de-duplicating the same resource across overlapping pulls. */
function dedupeKey(resource: unknown, file: string, ordinal: number): string {
  const r = resource as { resourceType?: string; id?: string };
  // Without an id there is nothing to deduplicate ON, so the resource is kept as
  // its own: collapsing id-less resources by content would hide exactly the
  // repetition this report is meant to count.
  return r?.id ? `${r.resourceType}/${r.id}` : `${file}#${ordinal}`;
}

interface ScanResult {
  report: CoverageReport;
  filesRead: number;
  resourcesSeen: number;
  resourcesUnique: number;
  unparseableFiles: string[];
}

async function scanSources(reader: PodReader, sourcesDir: string, ledger: PodReadLedger): Promise<ScanResult> {
  const files = await listSourceFiles(sourcesDir);
  const accumulator = new CoverageAccumulator();
  const seen = new Set<string>();
  const unparseableFiles: string[] = [];
  let filesRead = 0;
  let resourcesSeen = 0;

  for (const file of files) {
    ledger.attempt();
    const text = reader.readText(file);
    if (!text.ok) {
      ledger.record(text.failure);
      continue;
    }
    filesRead++;
    const resources = resourcesIn(text.value);
    if (resources.length === 0) {
      // Not a fatal read failure: `sources/` legitimately holds JSON that is not
      // FHIR (a pull's own metadata, for one). Named, not silently skipped.
      unparseableFiles.push(reader.relativePath(file));
      continue;
    }
    for (let i = 0; i < resources.length; i++) {
      resourcesSeen++;
      const key = dedupeKey(resources[i], reader.relativePath(file), i);
      if (seen.has(key)) continue;
      seen.add(key);
      accumulator.add(resources[i]);
    }
  }

  return {
    report: accumulator.report(),
    filesRead,
    resourcesSeen,
    resourcesUnique: seen.size,
    unparseableFiles,
  };
}

function statusLabel(status: string, backlog: string | undefined): string {
  if (status === 'pending') return `pending ${backlog ?? ''}`.trim();
  return status;
}

function renderText(podDir: string, scan: ScanResult): string {
  const { report } = scan;
  const lines: string[] = [];
  lines.push(`Field coverage of retained sources: ${podDir}`);
  lines.push('');
  lines.push(
    `  Files read:        ${scan.filesRead}` +
      (scan.unparseableFiles.length ? ` (${scan.unparseableFiles.length} not FHIR JSON)` : ''),
  );
  lines.push(`  Resources:         ${scan.resourcesUnique} unique of ${scan.resourcesSeen} read`);
  lines.push(
    `  Populated fields:  ${report.totals.populatedFields} — ` +
      `imported ${report.totals.emittedFields}, not imported ${report.totals.droppedFields}`,
  );
  lines.push(
    `  Not imported:      ${report.totals.acknowledged} acknowledged, ` +
      `${report.totals.pending} pending a fix, ${report.totals.unaccounted} unaccounted`,
  );
  if (report.resourcesTypeExcluded > 0) {
    lines.push(`  Excluded types:    ${report.resourcesTypeExcluded} resources`);
  }
  lines.push('');
  lines.push(`  ${coverageDisclosure(report)}`);

  for (const [resourceType, summary] of Object.entries(report.byType)) {
    if (summary.droppedPaths.length === 0) continue;
    lines.push('');
    lines.push(`${resourceType} (${summary.resourcesScanned} resources)`);
    for (const tally of summary.droppedPaths) {
      lines.push(
        `  ${String(tally.count).padStart(6)}  ${tally.path.padEnd(52)}  ${statusLabel(tally.status, tally.backlog)}`,
      );
    }
    if (summary.untestablePaths.length > 0) {
      lines.push(`          not measurable: ${summary.untestablePaths.join(', ')}`);
    }
  }

  if (report.totals.unaccounted > 0) {
    lines.push('');
    lines.push(
      '  Paths marked "unaccounted" are populated, not imported, and on no converter\'s drop manifest.',
    );
    lines.push(
      '  They are the report worth sending back: each one becomes a fixture and a manifest entry.',
    );
  }

  return lines.join('\n');
}

export function registerSourcesCommand(program: Command): void {
  const sources = program
    .command('sources')
    .description('Inspect the raw source documents a pod retained at import');

  sources
    .command('coverage')
    .description('Report which populated source fields the import did not carry into the pod')
    .argument('<pod-dir>', 'Path to the Cascade Pod')
    .action(async (podDir: string) => {
      const globalOpts = program.opts() as OutputOptions;
      const absDir = resolvePodDir(podDir);

      if (!(await isDirectory(absDir))) {
        printError(`Pod directory not found: ${absDir}`, globalOpts);
        process.exitCode = 1;
        return;
      }

      const sourcesDir = path.join(absDir, SOURCES_DIR);
      if (!(await isDirectory(sourcesDir))) {
        printError(
          `This pod retains no ${SOURCES_DIR}/ directory, so there is nothing to compare its records against. ` +
            'Coverage is measured against the raw documents an import kept, not against the records it wrote.',
          globalOpts,
        );
        process.exitCode = 1;
        return;
      }

      printVerbose(`Scanning retained sources in: ${sourcesDir}`, globalOpts);

      // Open the pod ONCE. `sources/` is inside the encrypted set, so a sealed
      // pod this invocation cannot unlock stops here rather than reporting a
      // pod full of retained bundles as one holding none.
      let reader: PodReader;
      try {
        reader = await openPod(absDir);
      } catch (err: unknown) {
        if (err instanceof PodUnreadableError) {
          printErrorDetail(
            err.message,
            { pod: podDir, encrypted: true, readable: false, reason: err.reason },
            globalOpts,
          );
        } else {
          printError(err instanceof Error ? err.message : String(err), globalOpts);
        }
        process.exitCode = 2;
        return;
      }

      const ledger = new PodReadLedger();
      const scan = await scanSources(reader, sourcesDir, ledger);

      if (ledger.hasFatal) {
        printError(unreadableFilesMessage(absDir, ledger.fatal, ledger.attempted), globalOpts);
        process.exitCode = 2;
        return;
      }
      for (const file of scan.unparseableFiles) {
        printWarning(`Not FHIR JSON, so not measured: ${file}`, globalOpts);
      }

      if (globalOpts.json) {
        printResult(
          {
            pod: absDir,
            filesRead: scan.filesRead,
            resourcesRead: scan.resourcesSeen,
            resourcesUnique: scan.resourcesUnique,
            notFhirJson: scan.unparseableFiles,
            disclosure: coverageDisclosure(scan.report),
            ...scan.report,
          },
          globalOpts,
        );
      } else {
        printResult(renderText(absDir, scan), globalOpts);
      }
    });
}
