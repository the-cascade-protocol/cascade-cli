/**
 * What `pod reconcile --apply` does to the queue of questions a person has not
 * answered yet.
 *
 * THE THING BEING PROTECTED
 * -------------------------
 * `settings/pending-conflicts.ttl` is not a cache. Each row is a decision the
 * tool refused to make on its own and handed to the user, and `pod resolve`
 * reads it by id. A verb that rewrites that file from its own run's conflicts
 * alone discards every row it did not itself raise, whether or not anything
 * about that row changed. Measured on a real pod: eight conflict subjects before
 * an --apply, zero after, and no mention of conflicts anywhere in the run
 * report.
 *
 * The benign reading of that measurement is that all eight were moot, their
 * candidates having merged. It is probably even true. What makes it unacceptable
 * anyway is that the code could not tell the difference: the SAME line dropped a
 * row whose records had merged and a row whose records are still sitting in the
 * pod, still different, still needing an answer.
 *
 * So both halves are tested here, and the second one is the dangerous half. A
 * cleared row is a question that got answered. A dropped-but-should-be-kept row
 * is a question that stopped being asked.
 *
 * All fixture data is synthetic and PHI-free.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';
import {
  writePendingConflicts,
  loadPendingConflicts,
  type PendingConflict,
} from '../src/lib/user-resolutions.js';

const INSTANT = '2031-05-20T09:14:00Z';

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const program = new Command();
  program
    .name('cascade')
    .exitOverride()
    .option('--verbose', 'Verbose output', false)
    .option('--json', 'Output JSON', false);
  registerPodCommand(program);

  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.map(String).join(' '));
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    out.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  process.exitCode = 0;
  try {
    await program.parseAsync(['node', 'cascade', ...args]);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function makePod(): Promise<string> {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-reconcile-queue-'));
  dirs.push(d);
  const podDir = path.join(d, 'pod');
  expect((await runCli(['pod', 'init', podDir])).exitCode).toBe(0);
  return podDir;
}

const PREFIXES = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
`;

function labRecord(o: {
  uri: string;
  batch: string;
  origin?: string;
  loinc?: string;
  name?: string;
  value?: string;
}): string {
  const origin = o.origin ? `  cascade:sourceIdentity "${o.origin}" ;\n` : '';
  return `<${o.uri}> a health:LabResultRecord ;
  cascade:sourceSystem "${o.batch}" ;
${origin}  health:testCode <http://loinc.org/rdf#${o.loinc ?? '2951-2'}> ;
  health:testName "${o.name ?? 'Sodium'}" ;
  health:performedDate "${INSTANT}" ;
  health:resultValue "${o.value ?? '141'}" .
`;
}

function writeLabs(podDir: string, records: string[]): void {
  fs.writeFileSync(
    path.join(podDir, 'clinical', 'lab-results.ttl'),
    PREFIXES + '\n' + records.join('\n'),
    'utf-8',
  );
}

function conflictRow(conflictId: string, candidates: string[]): PendingConflict {
  return {
    uri: `urn:uuid:conflict-${conflictId}`,
    conflictId,
    recordType: 'health:LabResultRecord',
    detectedAt: new Date('2031-01-01T00:00:00Z'),
    candidateRecordUris: candidates,
    label: 'Sodium',
    sourceA: 'org:stonebridge',
    sourceB: 'org:larkfield',
  };
}

interface Disposition {
  before: number;
  raised: number;
  kept: number;
  clearedByMerge: number;
  orphaned: number;
  after: number;
  clearedIds: string[];
  orphanedIds: string[];
}

/**
 * A pod whose review queue holds all three shapes at once.
 *
 * `merging`  two cross-source copies of one draw; --apply collapses them.
 * `standing` two copies under ONE origin, which the same-source guard refuses to
 *            compare, so both survive the apply untouched.
 * `vanished` two IRIs that are not in the pod at all.
 */
async function podWithQueue(): Promise<string> {
  const podDir = await makePod();
  writeLabs(podDir, [
    labRecord({ uri: 'urn:uuid:lab-a', batch: 'Stonebridge export', origin: 'org:stonebridge' }),
    labRecord({ uri: 'urn:uuid:lab-b', batch: 'Larkfield export', origin: 'org:larkfield' }),
    labRecord({
      uri: 'urn:uuid:lab-x',
      batch: 'Brightwater export',
      origin: 'org:brightwater',
      loinc: '2160-0',
      name: 'Creatinine',
      value: '1.1',
    }),
    labRecord({
      uri: 'urn:uuid:lab-y',
      batch: 'Brightwater export',
      origin: 'org:brightwater',
      loinc: '2160-0',
      name: 'Creatinine',
      value: '1.1',
    }),
  ]);
  await writePendingConflicts(podDir, [
    conflictRow('merging', ['urn:uuid:lab-a', 'urn:uuid:lab-b']),
    conflictRow('standing', ['urn:uuid:lab-x', 'urn:uuid:lab-y']),
    conflictRow('vanished', ['urn:uuid:lab-gone-1', 'urn:uuid:lab-gone-2']),
  ]);
  return podDir;
}

// ---------------------------------------------------------------------------

describe('pod reconcile: the review queue is disposed of, not overwritten', () => {
  it('KEEPS a conflict whose candidate records survive the apply', async () => {
    // THE DANGEROUS HALF. Both of this row's records are still in the pod and
    // still different after the merge, so the question it asks is still open.
    // Writing the queue from the run's own conflicts alone drops it.
    const podDir = await podWithQueue();
    const r = await runCli(['pod', 'reconcile', podDir, '--apply']);
    expect(r.exitCode).toBe(0);

    const after = await loadPendingConflicts(podDir);
    expect(after.map((c) => c.conflictId)).toContain('standing');

    // And it is the SAME row, not a re-raise: the id, the subject IRI and the
    // detection time a user may already have seen are all preserved.
    const kept = after.find((c) => c.conflictId === 'standing') as PendingConflict;
    expect(kept.uri).toBe('urn:uuid:conflict-standing');
    expect(kept.detectedAt.toISOString()).toBe('2031-01-01T00:00:00.000Z');
    expect(kept.candidateRecordUris.sort()).toEqual(['urn:uuid:lab-x', 'urn:uuid:lab-y']);

    // `pod resolve` finds it by id, which is the whole reason the row matters.
    const listed = await runCli(['pod', 'conflicts', podDir, '--format', 'json']);
    expect(listed.stdout).toContain('standing');
  });

  it('CLEARS a conflict whose candidate records became one record', async () => {
    const podDir = await podWithQueue();
    await runCli(['pod', 'reconcile', podDir, '--apply']);
    const after = await loadPendingConflicts(podDir);
    expect(after.map((c) => c.conflictId)).not.toContain('merging');
  });

  it('drops a conflict whose records are gone, and says that it did', async () => {
    // Nothing can act on it, so it does not survive. What must not happen is
    // that it leaves silently: "your queue shrank and no merge explains it" is
    // the sentence a wholesale rewrite swallowed.
    const podDir = await podWithQueue();
    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--apply']);
    const report = JSON.parse(r.stdout) as { pendingConflicts: Disposition };
    expect(report.pendingConflicts.orphaned).toBe(1);
    expect(report.pendingConflicts.orphanedIds).toEqual(['vanished']);

    const after = await loadPendingConflicts(podDir);
    expect(after.map((c) => c.conflictId)).not.toContain('vanished');
  });

  it('reports the whole disposition, and the arithmetic closes', async () => {
    const podDir = await podWithQueue();
    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--apply']);
    const d = (JSON.parse(r.stdout) as { pendingConflicts: Disposition }).pendingConflicts;
    expect(d.before).toBe(3);
    expect(d.kept).toBe(1);
    expect(d.clearedByMerge).toBe(1);
    expect(d.clearedIds).toEqual(['merging']);
    expect(d.orphaned).toBe(1);
    // Every row before this run is accounted for by exactly one outcome.
    expect(d.kept + d.clearedByMerge + d.orphaned).toBe(d.before);
    // And what is on disk afterwards is what the report said would be.
    expect((await loadPendingConflicts(podDir)).length).toBe(d.after);
  });

  it('says it in words, not only in JSON', async () => {
    // A user reading the terminal has to be told a decision queue changed.
    const podDir = await podWithQueue();
    const r = await runCli(['pod', 'reconcile', podDir, '--apply']);
    expect(r.stdout).toContain('Review queue');
    expect(r.stdout).toContain('cleared by merge');
    expect(r.stdout).toContain('orphaned');
    expect(r.stdout).toContain('vanished');
  });
});

describe('pod reconcile: the dry run answers the queue question too', () => {
  it('reports the disposition and changes nothing', async () => {
    const podDir = await podWithQueue();
    const file = path.join(podDir, 'settings', 'pending-conflicts.ttl');
    const before = fs.readFileSync(file, 'utf-8');

    const r = await runCli(['--json', 'pod', 'reconcile', podDir]);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as { applied: boolean; pendingConflicts: Disposition };
    expect(report.applied).toBe(false);
    expect(report.pendingConflicts.before).toBe(3);
    expect(report.pendingConflicts.kept).toBe(1);
    expect(report.pendingConflicts.clearedByMerge).toBe(1);
    expect(report.pendingConflicts.orphaned).toBe(1);

    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('reports a queue even on a pod where nothing would merge', async () => {
    // The case a reader is least likely to expect a queue change in, and the one
    // where the old code still rewrote the file.
    const podDir = await makePod();
    writeLabs(podDir, [
      labRecord({ uri: 'urn:uuid:lab-solo', batch: 'Stonebridge export', origin: 'org:stonebridge' }),
    ]);
    await writePendingConflicts(podDir, [conflictRow('standing', ['urn:uuid:lab-solo'])]);

    const r = await runCli(['pod', 'reconcile', podDir]);
    expect(r.stdout).toContain('Nothing to reconcile');
    expect(r.stdout).toContain('Review queue');
  });
});

describe('pod reconcile: a review queue it cannot read stops the run', () => {
  it('refuses rather than overwriting questions it never saw', async () => {
    const podDir = await podWithQueue();
    fs.writeFileSync(
      path.join(podDir, 'settings', 'pending-conflicts.ttl'),
      'this is not turtle {{{',
      'utf-8',
    );
    const before = fs.readFileSync(path.join(podDir, 'clinical', 'lab-results.ttl'), 'utf-8');

    const r = await runCli(['pod', 'reconcile', podDir, '--apply']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('pending-conflicts.ttl');
    // The pod is untouched, which is the point of refusing rather than guessing.
    expect(fs.readFileSync(path.join(podDir, 'clinical', 'lab-results.ttl'), 'utf-8')).toBe(before);
  });
});
