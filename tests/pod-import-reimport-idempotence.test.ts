/**
 * Re-import acceptance (integration): importing the SAME data twice must leave the
 * pod exactly as it was, and must say so honestly.
 *
 * Three defects, one path — the monthly re-sync:
 *
 *  - root 2.22: record-to-record edges were appended again on every re-import.
 *    The pod holds an edge RESOLVED; a fresh conversion emits it as a placeholder
 *    (reference resolution is deferred to once per import invocation, R5); quad
 *    identity could not see they were one statement, so the subject ended up
 *    stating it twice. Measured on this repo's fixtures before the fix: a single
 *    bundle's 11 stated edges became 17 statements and Turtle grew 19282 -> 20807
 *    bytes (+7.9%), while `cascade:reconciliationStatus` grew without bound
 *    (0 -> 5 -> 10 across three imports).
 *  - root 3.53: the summary reported a 100% duplicate import as if every record
 *    were new, and created a prefixes-only `settings/pending-conflicts.ttl`.
 *  - root 3.52: `--report` was silently ignored under `--dry-run`, which is the
 *    one place a machine-readable preflight matters most.
 *
 * All fixtures are synthetic and PHI-free.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolve } from 'path';
import { Parser } from 'n3';
import type { Quad } from 'n3';

const CLI_PATH = resolve(__dirname, '../dist/index.js');
/** Multi-file layout: reconciliation runs on EVERY import, including the first. */
const FOLDER_FIXTURE = resolve(__dirname, '../test-fixtures/apple-health-multifile');
/** Single search-set bundle carrying all four stated-edge families. */
const BUNDLE_FIXTURE = resolve(__dirname, '../test-fixtures/reimport-stated-edges-bundle.json');

const EDGE_PREDICATES = [
  'https://ns.cascadeprotocol.org/clinical/v1#hasEncounter',
  'https://ns.cascadeprotocol.org/clinical/v1#indicationReference',
  'https://ns.cascadeprotocol.org/clinical/v1#hasLabResult',
  'https://ns.cascadeprotocol.org/clinical/v1#linkedCondition',
  'https://ns.cascadeprotocol.org/coverage/v1#relatedClaim',
];

interface ImportReport {
  totalRecordsImported: number;
  recordsNew: number;
  recordsAlreadyPresent: number;
  dryRun: boolean;
  edgeResolution: {
    resolved: number;
    unresolved: number;
    totalInPod: number;
    byPredicate: Record<string, { resolved: number; unresolved: number; totalInPod: number }>;
  };
  reconciliation: { enabled: boolean; summary?: { duplicateSubjectsDropped?: number } };
}

function cli(args: string[]): string {
  return execFileSync('node', [CLI_PATH, ...args], { encoding: 'utf-8', timeout: 120000 });
}

function newPod(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const podDir = path.join(dir, 'pod');
  cli(['pod', 'init', podDir]);
  return podDir;
}

/** Import `fixture` into `podDir` and return the parsed report. */
function importOnce(podDir: string, fixture: string, extraArgs: string[] = []): ImportReport {
  // The report goes OUTSIDE the pod so pod-content assertions stay unambiguous.
  const reportPath = path.join(path.dirname(podDir), `report-${Math.random().toString(36).slice(2)}.json`);
  cli(['pod', 'import', podDir, fixture, '--report', reportPath, ...extraArgs]);
  return JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as ImportReport;
}

/** Every pod file's bytes, keyed by relative path: the byte-stability snapshot. */
function podSnapshot(podDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(path.relative(podDir, full), fs.readFileSync(full, 'utf-8'));
    }
  };
  walk(podDir);
  return out;
}

function podQuads(podDir: string): Quad[] {
  const quads: Quad[] = [];
  for (const dir of ['clinical', 'wellness']) {
    const dirPath = path.join(podDir, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const file of fs.readdirSync(dirPath).sort()) {
      if (!file.endsWith('.ttl')) continue;
      quads.push(
        ...new Parser({ format: 'Turtle' }).parse(fs.readFileSync(path.join(dirPath, file), 'utf-8')),
      );
    }
  }
  return quads;
}

/** Stated record-to-record edges, as `subject|predicate|object` statements. */
function edgeStatements(podDir: string): string[] {
  return podQuads(podDir)
    .filter((q) => EDGE_PREDICATES.includes(q.predicate.value) && q.object.termType === 'NamedNode')
    .map((q) => `${q.subject.value}|${q.predicate.value}|${q.object.value}`);
}

/** Any triple stated more than once, as a `subject|predicate|object` list. */
function duplicateTriples(podDir: string): string[] {
  const seen = new Map<string, number>();
  for (const q of podQuads(podDir)) {
    const key = `${q.subject.value}|${q.predicate.value}|${q.object.termType}:${q.object.value}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}

describe('pod import: an identical re-import leaves the pod unchanged (root 2.22)', () => {
  let podDir: string;
  let report1: ImportReport;
  let report2: ImportReport;
  let report3: ImportReport;
  let after1: Map<string, string>;
  let after2: Map<string, string>;
  let after3: Map<string, string>;

  beforeAll(() => {
    // The multi-file layout reconciles on the first import too, so the pod reaches
    // its steady state immediately and byte-identity must hold from import 1 on.
    podDir = newPod('cascade-reimport-folder-');
    report1 = importOnce(podDir, FOLDER_FIXTURE);
    after1 = podSnapshot(podDir);
    report2 = importOnce(podDir, FOLDER_FIXTURE);
    after2 = podSnapshot(podDir);
    report3 = importOnce(podDir, FOLDER_FIXTURE);
    after3 = podSnapshot(podDir);
  });

  it('leaves the pod byte-identical after the second import', () => {
    expect([...after2.keys()]).toEqual([...after1.keys()]);
    for (const [rel, content] of after1) {
      expect(after2.get(rel), `${rel} changed on the second import`).toBe(content);
    }
  });

  it('leaves the pod byte-identical after a third import too', () => {
    expect([...after3.keys()]).toEqual([...after1.keys()]);
    for (const [rel, content] of after1) {
      expect(after3.get(rel), `${rel} changed on the third import`).toBe(content);
    }
  });

  it('states every record-to-record edge exactly once at every step', () => {
    const statements = edgeStatements(podDir);
    expect(statements.length).toBeGreaterThan(0);
    expect(new Set(statements).size).toBe(statements.length);
  });

  it('leaves no duplicated triple of any predicate family after three imports', () => {
    // Before the fix this held the doubled edges AND the doubled
    // cascade:reconciliationStatus. `cascade:sourceSystem` is a known pre-existing
    // duplicate (one parsed value plus one the reconciler derives) that is stable
    // across re-imports; it is excluded rather than silently changing today's
    // single-import bytes.
    const dups = duplicateTriples(podDir).filter(
      (t) => !t.includes('https://ns.cascadeprotocol.org/core/v1#sourceSystem'),
    );
    expect(dups).toEqual([]);
  });

  it('keeps the edge count stable across all three imports', () => {
    expect(report1.edgeResolution.totalInPod).toBeGreaterThan(0);
    expect(report2.edgeResolution.totalInPod).toBe(report1.edgeResolution.totalInPod);
    expect(report3.edgeResolution.totalInPod).toBe(report1.edgeResolution.totalInPod);
  });

  it('reports the re-import honestly: nothing new, everything already present (root 3.53)', () => {
    // Import 1 into a fresh pod: all new.
    expect(report1.recordsNew).toBe(report1.totalRecordsImported);
    expect(report1.recordsAlreadyPresent).toBe(0);

    // Import 2 of the same data: nothing new, and the reconciler names the
    // duplicate subjects it dropped instead of reporting zero duplicates.
    expect(report2.totalRecordsImported).toBe(report1.totalRecordsImported);
    expect(report2.recordsNew).toBe(0);
    expect(report2.recordsAlreadyPresent).toBe(report2.totalRecordsImported);
    expect(report2.reconciliation.summary?.duplicateSubjectsDropped).toBeGreaterThan(0);
  });

  it('does not degrade the edge numbers into looking like edge loss (root 3.53)', () => {
    // The per-run delta legitimately falls to zero — there is nothing left to
    // resolve — but the number a "K of N linked" surface reads must not move.
    expect(report2.edgeResolution.resolved).toBe(0);
    expect(report2.edgeResolution.totalInPod).toBe(report1.edgeResolution.totalInPod);
    for (const [pred, counts] of Object.entries(report1.edgeResolution.byPredicate)) {
      expect(report2.edgeResolution.byPredicate[pred]?.totalInPod, pred).toBe(counts.totalInPod);
    }
  });

  it('does not create an empty pending-conflicts.ttl when nothing is pending (root 3.53)', () => {
    // This fixture produces no conflicts, so announcing a conflict queue that
    // holds nothing but @prefix lines is a lie a GUI has to special-case.
    expect(fs.existsSync(path.join(podDir, 'settings', 'pending-conflicts.ttl'))).toBe(false);
  });
});

describe('pod import: a single-bundle re-import settles and never duplicates an edge', () => {
  let podDir: string;
  let reports: ImportReport[];
  let snapshots: Map<string, string>[];

  beforeAll(() => {
    podDir = newPod('cascade-reimport-bundle-');
    reports = [];
    snapshots = [];
    for (let i = 0; i < 3; i++) {
      reports.push(importOnce(podDir, BUNDLE_FIXTURE));
      snapshots.push(podSnapshot(podDir));
    }
  });

  it('states all four edge families, each exactly once, after every import', () => {
    const statements = edgeStatements(podDir);
    expect(new Set(statements).size).toBe(statements.length);
    const predicates = new Set(statements.map((s) => s.split('|')[1]));
    expect(predicates).toContain('https://ns.cascadeprotocol.org/clinical/v1#hasEncounter');
    expect(predicates).toContain('https://ns.cascadeprotocol.org/clinical/v1#indicationReference');
    expect(predicates).toContain('https://ns.cascadeprotocol.org/clinical/v1#hasLabResult');
    expect(predicates).toContain('https://ns.cascadeprotocol.org/coverage/v1#relatedClaim');
  });

  it('holds the same edge count after all three imports', () => {
    expect(reports[1].edgeResolution.totalInPod).toBe(reports[0].edgeResolution.totalInPod);
    expect(reports[2].edgeResolution.totalInPod).toBe(reports[0].edgeResolution.totalInPod);
  });

  it('is byte-identical from the second import onward', () => {
    // A single-file first import does not reconcile at all (there is only one
    // input), so import 2 stamps the reconciler's own bookkeeping for the first
    // time. That is a ONE-TIME transition: every import after it is a no-op.
    for (const [rel, content] of snapshots[1]) {
      expect(snapshots[2].get(rel), `${rel} changed on the third import`).toBe(content);
    }
    expect([...snapshots[2].keys()]).toEqual([...snapshots[1].keys()]);
  });

  it('reports 0 new records on the re-import', () => {
    expect(reports[0].recordsNew).toBe(reports[0].totalRecordsImported);
    expect(reports[1].recordsNew).toBe(0);
    expect(reports[2].recordsNew).toBe(0);
  });
});

describe('pod import: --report under --dry-run (root 3.52)', () => {
  it('writes the report a dry run would produce, and still touches nothing in the pod', () => {
    const podDir = newPod('cascade-dryrun-report-');
    const before = podSnapshot(podDir);
    const reportPath = path.join(path.dirname(podDir), 'preflight.json');

    cli(['pod', 'import', podDir, BUNDLE_FIXTURE, '--dry-run', '--report', reportPath]);

    // The flag used to be silently ignored: no file, no warning.
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as ImportReport;
    expect(report.dryRun).toBe(true);
    // And it carries the numbers a GUI preflight needs.
    expect(report.totalRecordsImported).toBeGreaterThan(0);
    expect(report.recordsNew).toBe(report.totalRecordsImported);
    expect(report.edgeResolution.totalInPod).toBeGreaterThan(0);

    // --dry-run still writes NOTHING to the pod.
    const after = podSnapshot(podDir);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [rel, content] of before) expect(after.get(rel), rel).toBe(content);
    expect(fs.existsSync(path.join(podDir, 'clinical', 'lab-results.ttl'))).toBe(false);
  });

  it('produces the same preflight numbers the real import then delivers', () => {
    const podDir = newPod('cascade-dryrun-parity-');
    const preflightPath = path.join(path.dirname(podDir), 'preflight.json');
    cli(['pod', 'import', podDir, BUNDLE_FIXTURE, '--dry-run', '--report', preflightPath]);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf-8')) as ImportReport;

    const real = importOnce(podDir, BUNDLE_FIXTURE);

    expect(real.totalRecordsImported).toBe(preflight.totalRecordsImported);
    expect(real.recordsNew).toBe(preflight.recordsNew);
    expect(real.edgeResolution.totalInPod).toBe(preflight.edgeResolution.totalInPod);
  });
});
