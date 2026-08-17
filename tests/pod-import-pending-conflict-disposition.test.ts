/**
 * `pod import` must not silently empty the review queue.
 *
 * THE SAME DEFECT THE RECONCILE VERB ALREADY FIXED, ONE VERB OVER
 * ---------------------------------------------------------------
 * `settings/pending-conflicts.ttl` is a user-decision queue: each row is a
 * question the tool declined to answer and handed to a person, and `pod resolve`
 * looks rows up in it by id. `writePendingConflicts` replaces that file
 * wholesale, and import called it with the run's OWN conflicts and nothing else.
 * So any import at all — including one that touched none of the records a
 * pending row is about — erased every question already in the queue.
 *
 * `pod reconcile` was given a disposition for exactly this: each pre-existing
 * row is KEPT (two or more of its candidates are still distinct records), or
 * CLEARED BY MERGE (its candidates became one record, so the merge answered it),
 * or ORPHANED (its candidates are not in the pod at all, so nothing can act on
 * it) — and the counts are reported rather than left to be discovered by
 * diffing a settings file. Import runs a reconciliation pass of its own and has
 * to go through the same door.
 *
 * The dangerous case is the first one, and it is what this file leads with: a
 * question about records that are still there, still different, and now silently
 * un-asked.
 *
 * All fixture data is synthetic.
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
  } catch {
    /* commander exitOverride: the exit code is read below */
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

const PREFIXES = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
`;

function labRecord(uri: string, value: string): string {
  // ONE origin for both, which is what makes them incomparable: the same-source
  // guard declines to merge two records one organization stated, so both survive
  // any reconciliation and the question about them stays open.
  return `<${uri}> a health:LabResultRecord ;
  cascade:sourceSystem "Brightwater export" ;
  cascade:sourceIdentity "org:brightwater" ;
  health:testCode <http://loinc.org/rdf#2160-0> ;
  health:testName "Creatinine" ;
  health:performedDate "${INSTANT}" ;
  health:resultValue "${value}" .
`;
}

/** A pod holding two un-mergeable labs and one open question about them. */
async function podWithStandingQuestion(): Promise<{ podDir: string; tempDir: string }> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-import-queue-'));
  dirs.push(tempDir);
  const podDir = path.join(tempDir, 'pod');
  expect((await runCli(['pod', 'init', podDir])).exitCode).toBe(0);

  fs.writeFileSync(
    path.join(podDir, 'clinical', 'lab-results.ttl'),
    PREFIXES + '\n' + labRecord('urn:uuid:lab-standing-a', '1.1') + '\n' + labRecord('urn:uuid:lab-standing-b', '1.4'),
    'utf-8',
  );

  const row: PendingConflict = {
    uri: 'urn:uuid:conflict-standing',
    conflictId: 'standing',
    recordType: 'health:LabResultRecord',
    detectedAt: new Date('2031-01-01T00:00:00Z'),
    candidateRecordUris: ['urn:uuid:lab-standing-a', 'urn:uuid:lab-standing-b'],
    label: 'Creatinine',
    sourceA: 'Brightwater',
    sourceB: 'Brightwater',
  };
  await writePendingConflicts(podDir, [row]);
  return { podDir, tempDir };
}

/** An import batch about something else entirely. */
function unrelatedBatch(tempDir: string): string {
  const file = path.join(tempDir, 'unrelated.ttl');
  fs.writeFileSync(
    file,
    PREFIXES +
      `
<urn:uuid:med-sertraline> a clinical:Medication ;
  cascade:sourceIdentity "org:larkfield" ;
  clinical:sourceEHR "Larkfield" ;
  clinical:drugName "Sertraline" ;
  clinical:dosage "50 mg" ;
  clinical:status "active" .
`,
    'utf-8',
  );
  return file;
}

// ---------------------------------------------------------------------------

describe('pod import: the review queue is disposed of, not overwritten', () => {
  it('KEEPS a pending conflict the imported batch never touched', async () => {
    const { podDir, tempDir } = await podWithStandingQuestion();
    const batch = unrelatedBatch(tempDir);

    const r = await runCli(['pod', 'import', podDir, batch, '--source-system', 'larkfield']);
    expect(r.exitCode).toBe(0);

    const after = await loadPendingConflicts(podDir);
    expect(after.map((c) => c.conflictId)).toContain('standing');

    // The SAME row, not a re-raise: the subject IRI and the detection time the
    // user may already have seen are preserved, and `pod resolve` finds it.
    const kept = after.find((c) => c.conflictId === 'standing') as PendingConflict;
    expect(kept.uri).toBe('urn:uuid:conflict-standing');
    expect(kept.detectedAt.toISOString()).toBe('2031-01-01T00:00:00.000Z');
  });

  it('reports the disposition in the import report, and the arithmetic closes', async () => {
    const { podDir, tempDir } = await podWithStandingQuestion();
    const batch = unrelatedBatch(tempDir);
    const reportPath = path.join(tempDir, 'report.json');

    await runCli(['pod', 'import', podDir, batch, '--source-system', 'larkfield', '--report', reportPath]);

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as {
      pendingConflicts: {
        before: number;
        raised: number;
        kept: number;
        clearedByMerge: number;
        orphaned: number;
        after: number;
        clearedIds: string[];
        orphanedIds: string[];
      };
    };
    const d = report.pendingConflicts;
    expect(d.before).toBe(1);
    expect(d.kept).toBe(1);
    expect(d.clearedByMerge).toBe(0);
    expect(d.orphaned).toBe(0);
    // Every row before this run is accounted for by exactly one outcome.
    expect(d.kept + d.clearedByMerge + d.orphaned).toBe(d.before);
    // And what is on disk afterwards is what the report said would be.
    expect((await loadPendingConflicts(podDir)).length).toBe(d.after);
  });

  it('ORPHANS a row whose candidate records are not in the pod, and names it', async () => {
    const { podDir, tempDir } = await podWithStandingQuestion();
    await writePendingConflicts(podDir, [
      {
        uri: 'urn:uuid:conflict-vanished',
        conflictId: 'vanished',
        recordType: 'health:LabResultRecord',
        detectedAt: new Date('2031-01-01T00:00:00Z'),
        candidateRecordUris: ['urn:uuid:lab-gone-1', 'urn:uuid:lab-gone-2'],
      },
    ]);
    const batch = unrelatedBatch(tempDir);
    const reportPath = path.join(tempDir, 'report.json');

    await runCli(['pod', 'import', podDir, batch, '--source-system', 'larkfield', '--report', reportPath]);

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as {
      pendingConflicts: { orphaned: number; orphanedIds: string[] };
    };
    expect(report.pendingConflicts.orphaned).toBe(1);
    expect(report.pendingConflicts.orphanedIds).toEqual(['vanished']);
    expect((await loadPendingConflicts(podDir)).map((c) => c.conflictId)).not.toContain('vanished');
  });
});
