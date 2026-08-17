/**
 * Who answered a conflict, and how anyone finds out afterwards.
 *
 * `settings/user-resolutions.ttl` is the decision log: the record that a person
 * looked at two disagreeing copies of a fact and said which one stands. It
 * carried WHEN (`cascade:resolvedAt`) and never WHO, and no verb listed it at
 * all — so a decision was write-only, and on a pod several people touch there
 * was no way to ask "who decided this, and when". `pod annotate` already takes
 * `--by <actorIri>` and writes `prov:wasAttributedTo`; a decision is at least as
 * attributable as a note, so it takes the same flag and writes the same
 * predicate.
 *
 * The flag is OPTIONAL and its absence is exactly today's behaviour: no actor
 * triple, nothing else moved. An unattributed decision is honest, and inventing
 * an actor for one would be worse than leaving the axis empty.
 *
 * The read path is `pod conflicts --resolved`, which is argued for in the PR:
 * one verb over the conflict store, one pod argument, one DEK resolution, one
 * set of "could not read" wording. The queue and the log are the two halves of
 * the same file pair and the flag is what says which half.
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
  loadUserResolutions,
  type PendingConflict,
} from '../src/lib/user-resolutions.js';

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
  // `pod resolve` and `pod conflicts` end a failed run with `process.exit(n)`,
  // which vitest replaces with a throw. Swallowing that throw would report every
  // refusal as a success, so the code is read back out of it.
  let thrownExit: number | undefined;
  try {
    await program.parseAsync(['node', 'cascade', ...args]);
  } catch (e: unknown) {
    const m = /process\.exit unexpectedly called with "(\d+)"/.exec(
      e instanceof Error ? e.message : String(e),
    );
    if (m) thrownExit = Number(m[1]);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
  }
  const exitCode = thrownExit ?? (typeof process.exitCode === 'number' ? process.exitCode : 0);
  process.exitCode = 0;
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function row(conflictId: string): PendingConflict {
  return {
    uri: `urn:uuid:conflict-${conflictId}`,
    conflictId,
    recordType: 'clinical:Medication',
    detectedAt: new Date('2031-01-01T00:00:00Z'),
    candidateRecordUris: [`urn:uuid:med-${conflictId}-a`, `urn:uuid:med-${conflictId}-b`],
    label: 'Levothyroxine',
    sourceA: 'Meridian',
    sourceB: 'Stonebridge',
  };
}

async function podWithQueue(ids: string[] = ['dose-disagreement']): Promise<string> {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-resolve-actor-'));
  dirs.push(d);
  const podDir = path.join(d, 'pod');
  expect((await runCli(['pod', 'init', podDir])).exitCode).toBe(0);
  await writePendingConflicts(podDir, ids.map(row));
  return podDir;
}

const ACTOR = 'https://example.org/people/care-coordinator';

// ---------------------------------------------------------------------------

describe('pod resolve --by: a decision carries its author', () => {
  it('writes prov:wasAttributedTo when --by is given', async () => {
    const podDir = await podWithQueue();
    const r = await runCli([
      'pod', 'resolve', podDir,
      '--conflict', 'dose-disagreement',
      '--keep', 'source-a',
      '--by', ACTOR,
    ]);
    expect(r.exitCode).toBe(0);

    const log = fs.readFileSync(path.join(podDir, 'settings', 'user-resolutions.ttl'), 'utf-8');
    expect(log).toContain('wasAttributedTo');
    expect(log).toContain(ACTOR);

    const decisions = await loadUserResolutions(podDir);
    expect(decisions.get('dose-disagreement')?.actorIri).toBe(ACTOR);
  });

  it('writes no actor triple when --by is omitted', async () => {
    // The absence is the point: an unattributed decision stays unattributed
    // rather than acquiring a fabricated author.
    const podDir = await podWithQueue();
    expect(
      (await runCli(['pod', 'resolve', podDir, '--conflict', 'dose-disagreement', '--keep', 'source-b']))
        .exitCode,
    ).toBe(0);

    const log = fs.readFileSync(path.join(podDir, 'settings', 'user-resolutions.ttl'), 'utf-8');
    expect(log).not.toContain('wasAttributedTo');
    const decisions = await loadUserResolutions(podDir);
    expect(decisions.get('dose-disagreement')?.actorIri).toBeUndefined();
  });

  it('refuses an actor IRI that could not be written back', async () => {
    // A space inside <...> produces a file the next read cannot parse, which
    // would take the decision log out of service permanently.
    const podDir = await podWithQueue();
    const r = await runCli([
      'pod', 'resolve', podDir,
      '--conflict', 'dose-disagreement',
      '--keep', 'source-a',
      '--by', 'https://example.org/care coordinator',
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Invalid IRI for --by');
    expect(fs.existsSync(path.join(podDir, 'settings', 'user-resolutions.ttl'))).toBe(false);
  });
});

describe('pod conflicts --resolved: the decision log can be read back', () => {
  it('emits the answered conflicts as JSON, actor included', async () => {
    const podDir = await podWithQueue(['dose-disagreement', 'status-disagreement']);
    await runCli([
      'pod', 'resolve', podDir,
      '--conflict', 'dose-disagreement',
      '--keep', 'source-a',
      '--by', ACTOR,
      '--note', 'Pharmacy confirmed the current dose.',
    ]);

    const r = await runCli(['pod', 'conflicts', podDir, '--resolved', '--format', 'json']);
    expect(r.exitCode).toBe(0);
    const log = JSON.parse(r.stdout) as Array<{
      conflictId: string;
      resolvedAt: string;
      resolution: string;
      keptRecordUri: string;
      discardedRecordUris: string[];
      userNote?: string;
      actorIri?: string;
    }>;
    expect(log).toHaveLength(1);
    expect(log[0].conflictId).toBe('dose-disagreement');
    expect(log[0].resolution).toBe('kept-source-a');
    expect(log[0].keptRecordUri).toBe('urn:uuid:med-dose-disagreement-a');
    expect(log[0].discardedRecordUris).toEqual(['urn:uuid:med-dose-disagreement-b']);
    expect(log[0].userNote).toBe('Pharmacy confirmed the current dose.');
    expect(log[0].actorIri).toBe(ACTOR);
    expect(typeof log[0].resolvedAt).toBe('string');
  });

  it('exits 0 on an empty log, and does not borrow the queue exit code', async () => {
    // Plain `pod conflicts` exits 1 when rows are pending, which is a CI signal
    // about UNANSWERED questions. A decision log carries no such signal, so
    // reading it is always a plain success.
    const podDir = await podWithQueue();
    const r = await runCli(['pod', 'conflicts', podDir, '--resolved', '--format', 'json']);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  it('lists the decision in text mode too', async () => {
    const podDir = await podWithQueue();
    await runCli([
      'pod', 'resolve', podDir, '--conflict', 'dose-disagreement', '--keep', 'both', '--by', ACTOR,
    ]);
    const r = await runCli(['pod', 'conflicts', podDir, '--resolved']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('dose-disagreement');
    expect(r.stdout).toContain('kept-both');
    expect(r.stdout).toContain(ACTOR);
  });
});
