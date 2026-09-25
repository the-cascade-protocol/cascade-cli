/**
 * An owner's recorded answer to a conflict is an INPUT to reconciliation.
 *
 * WHAT WAS WRONG
 * --------------
 * `pod resolve` wrote the owner's decision to `settings/user-resolutions.ttl`,
 * and nothing ever read it back except `pod conflicts --resolved`, for display.
 * `pod reconcile` and the reconciliation inside `pod import` re-derived the
 * same question from the same records every run, and the only way a "keep this
 * one" answer ever took effect was a second, hand-written
 * `pod retract --superseded-by` with no link to the decision that motivated it.
 * Worse, the run that RAISED the conflict had already absorbed the losing
 * record into the survivor, so an owner who chose the other side was choosing
 * a record the pod no longer held.
 *
 * WHAT IS PINNED HERE
 * -------------------
 * 1. A keep-one answer is carried out by the next reconciliation as the same
 *    `workbench:Retraction` + `workbench:supersededBy` overlay a hand-made merge
 *    writes, carrying `prov:wasDerivedFrom` the resolution record.
 * 2. An answered conflict never returns to `settings/pending-conflicts.ttl`.
 * 3. Running reconcile twice yields the same pod, byte for byte.
 * 4. THE VECTOR: these records plus this `user-resolutions.ttl`, rebuilt in a
 *    fresh pod, yield the same result as the pod the answer was given in.
 *
 * All fixture data is synthetic.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Parser } from 'n3';
import { registerPodCommand } from '../src/commands/pod/index.js';
import {
  loadPendingConflicts,
  loadUserResolutions,
  saveUserResolution,
  writePendingConflicts,
  type PendingConflict,
} from '../src/lib/user-resolutions.js';
import { runReconciliation } from '../src/lib/reconciler.js';

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

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-applies-resolutions-'));
  dirs.push(d);
  return d;
}

const KEPT = 'urn:cascade:med:lisinopril-pharmacy';
const OTHER = 'urn:cascade:med:lisinopril-clinic';
const THIRD = 'urn:cascade:med:lisinopril-hospital';

/** A third source under the SAME conflict key: same drug, same code, 30 mg. */
function writeThird(dir: string): string {
  const c = path.join(dir, 'hospital.ttl');
  fs.writeFileSync(c, medTtl(THIRD, 'Lisinopril 30 mg', '30 mg'), 'utf-8');
  return c;
}

function medTtl(uri: string, drugName: string, dosage: string): string {
  return `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .

<${uri}> a clinical:Medication ;
    clinical:drugName "${drugName}" ;
    clinical:rxNormCode <https://ns.cascadeprotocol.org/rxnorm/29046> ;
    clinical:dosage "${dosage}" ;
    clinical:status "active" ;
    cascade:dataProvenance cascade:Imported ;
    cascade:schemaVersion "1.9" .
`;
}

/** The two layer-1 inputs: one drug, two sources, two doses. */
function writeSources(dir: string): { a: string; b: string } {
  const a = path.join(dir, 'pharmacy.ttl');
  const b = path.join(dir, 'clinic.ttl');
  fs.writeFileSync(a, medTtl(KEPT, 'Lisinopril 10 mg', '10 mg'), 'utf-8');
  fs.writeFileSync(b, medTtl(OTHER, 'Lisinopril 20 mg', '20 mg'), 'utf-8');
  return { a, b };
}

/** Init a pod and import the two sources in order, as two separate imports. */
async function importBoth(podDir: string, src: { a: string; b: string }): Promise<void> {
  expect((await runCli(['pod', 'import', podDir, src.a, '--source-system', 'pharmacy'])).exitCode).toBe(0);
  expect((await runCli(['pod', 'import', podDir, src.b, '--source-system', 'clinic'])).exitCode).toBe(0);
}

async function initPod(dir: string, name: string): Promise<string> {
  const podDir = path.join(dir, name);
  expect((await runCli(['pod', 'init', podDir])).exitCode).toBe(0);
  return podDir;
}

/** The side (`source-a` / `source-b`) of the one pending row whose record is `uri`. */
function sideFor(row: PendingConflict, uri: string): 'source-a' | 'source-b' {
  const i = row.candidateRecordUris.indexOf(uri);
  expect(i, `row does not name ${uri}`).toBeGreaterThanOrEqual(0);
  return i === 0 ? 'source-a' : 'source-b';
}

/** A pod whose one dose conflict was raised and then answered with `keep`. */
async function answeredPod(
  dir: string,
  keep: 'kept' | 'both',
): Promise<{ podDir: string; src: { a: string; b: string }; conflictId: string }> {
  const src = writeSources(dir);
  const podDir = await initPod(dir, 'pod');
  await importBoth(podDir, src);

  const pending = await loadPendingConflicts(podDir);
  expect(pending, 'the two doses must raise exactly one conflict').toHaveLength(1);
  const row = pending[0];
  const choice = keep === 'both' ? 'both' : sideFor(row, KEPT);
  expect(
    (await runCli(['pod', 'resolve', podDir, '--conflict', row.conflictId, '--keep', choice])).exitCode,
  ).toBe(0);
  return { podDir, src, conflictId: row.conflictId };
}

/** The set of triples a Turtle file states, as sorted N-Triples-ish lines. */
function graphOf(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const lines = new Set<string>();
  for (const q of new Parser({ format: 'Turtle' }).parse(fs.readFileSync(file, 'utf-8'))) {
    const o =
      q.object.termType === 'Literal'
        ? `"${q.object.value}"^^${q.object.datatype.value}`
        : `<${q.object.value}>`;
    lines.add(`<${q.subject.value}> <${q.predicate.value}> ${o}`);
  }
  return [...lines].sort();
}

/** Every file under a directory, with its bytes. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(dir, p), fs.readFileSync(p, 'utf-8'));
    }
  };
  walk(dir);
  return out;
}

const RETRACTIONS = ['annotations', 'retractions.ttl'];
const MEDS = ['clinical', 'medications.ttl'];
const WB = 'https://ns.cascadeprotocol.org/workbench/v1#';
const PROV = 'http://www.w3.org/ns/prov#';
const CORE = 'https://ns.cascadeprotocol.org/core/v1#';

// ---------------------------------------------------------------------------

describe('pod reconcile carries out a recorded keep-one answer', () => {
  it('writes the supersession as a retraction linked to the resolution record', async () => {
    const dir = tempDir();
    const { podDir } = await answeredPod(dir, 'kept');
    const [resolution] = [...(await loadUserResolutions(podDir)).values()];
    expect(resolution.keptRecordUri).toBe(KEPT);

    // Before reconciliation the answer has not been carried out yet.
    expect(fs.existsSync(path.join(podDir, ...RETRACTIONS))).toBe(false);

    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--apply']);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as {
      userResolutions: { answered: unknown[]; supersessions: unknown[]; retractionsWritten: number };
      summary: { userResolutionsApplied: number; conflictsUnresolved: number };
    };
    expect(report.summary.conflictsUnresolved).toBe(0);
    expect(report.summary.userResolutionsApplied).toBe(1);
    expect(report.userResolutions.retractionsWritten).toBe(1);

    // The same overlay `pod retract --superseded-by` writes...
    const g = graphOf(path.join(podDir, ...RETRACTIONS));
    const subject = g.find((l) => l.endsWith(`<${WB}Retraction>`))?.split(' ')[0];
    expect(subject, g.join('\n')).toBeDefined();
    expect(g).toContain(`${subject} <${WB}retractsRecord> <${OTHER}>`);
    expect(g).toContain(`${subject} <${WB}supersededBy> <${KEPT}>`);
    // ...plus the link to the judgement that caused it.
    expect(g).toContain(`${subject} <${PROV}wasDerivedFrom> <${resolution.uri}>`);
    expect(g.some((l) => l.startsWith(`${subject} <${CORE}autoResolved> "true"`))).toBe(true);

    // Both records are still in the pod: the chosen-against one is superseded,
    // not destroyed.
    const meds = graphOf(path.join(podDir, ...MEDS));
    expect(meds.some((l) => l.startsWith(`<${KEPT}> `))).toBe(true);
    expect(meds.some((l) => l.startsWith(`<${OTHER}> `))).toBe(true);
  });

  it('never re-queues an answered conflict, on reconcile or on a re-import', async () => {
    const dir = tempDir();
    const { podDir, src } = await answeredPod(dir, 'kept');

    expect((await runCli(['pod', 'reconcile', podDir, '--apply'])).exitCode).toBe(0);
    expect(await loadPendingConflicts(podDir)).toEqual([]);

    // A re-import of both sources re-reads the very records the question was
    // about. It is still answered.
    await importBoth(podDir, src);
    expect(await loadPendingConflicts(podDir)).toEqual([]);
    expect((await runCli(['pod', 'reconcile', podDir, '--apply'])).exitCode).toBe(0);
    expect(await loadPendingConflicts(podDir)).toEqual([]);
  });

  it('is idempotent: a second reconcile leaves every file byte-identical', async () => {
    const dir = tempDir();
    const { podDir } = await answeredPod(dir, 'kept');
    expect((await runCli(['pod', 'reconcile', podDir, '--apply'])).exitCode).toBe(0);
    const first = snapshot(podDir);

    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--apply']);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as {
      userResolutions: { retractionsWritten: number; retractionsAlreadyPresent: number };
    };
    expect(report.userResolutions.retractionsWritten).toBe(0);
    expect(report.userResolutions.retractionsAlreadyPresent).toBe(1);
    expect(snapshot(podDir)).toEqual(first);
  });

  it('THE VECTOR: the same records plus the same answer, rebuilt from scratch, give the same result', async () => {
    const dir = tempDir();
    const { podDir, src } = await answeredPod(dir, 'kept');
    expect((await runCli(['pod', 'reconcile', podDir, '--apply'])).exitCode).toBe(0);

    // A fresh pod, holding nothing but the owner's answer, fed the same two
    // sources in the same order. Nobody resolves anything in it.
    const rebuilt = await initPod(dir, 'rebuilt');
    fs.copyFileSync(
      path.join(podDir, 'settings', 'user-resolutions.ttl'),
      path.join(rebuilt, 'settings', 'user-resolutions.ttl'),
    );
    await importBoth(rebuilt, src);

    expect(graphOf(path.join(rebuilt, ...MEDS))).toEqual(graphOf(path.join(podDir, ...MEDS)));
    // Byte-identical, not only graph-equal: the overlay is a function of the
    // judgement alone (its IRI and its timestamp both come from it).
    expect(fs.readFileSync(path.join(rebuilt, ...RETRACTIONS), 'utf-8')).toBe(
      fs.readFileSync(path.join(podDir, ...RETRACTIONS), 'utf-8'),
    );
    expect(await loadPendingConflicts(rebuilt)).toEqual([]);

    // And reconciling the rebuilt pod changes nothing about that outcome.
    expect((await runCli(['pod', 'reconcile', rebuilt, '--apply'])).exitCode).toBe(0);
    expect(graphOf(path.join(rebuilt, ...MEDS))).toEqual(graphOf(path.join(podDir, ...MEDS)));
    expect(graphOf(path.join(rebuilt, ...RETRACTIONS))).toEqual(graphOf(path.join(podDir, ...RETRACTIONS)));
  });

  it('a dry run reports the supersession and writes nothing', async () => {
    const dir = tempDir();
    const { podDir } = await answeredPod(dir, 'kept');
    const before = snapshot(podDir);
    const r = await runCli(['--json', 'pod', 'reconcile', podDir]);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as {
      applied: boolean;
      userResolutions: { supersessions: Array<{ supersededRecordUri: string; keptRecordUri: string }> };
    };
    expect(report.applied).toBe(false);
    expect(report.userResolutions.supersessions).toEqual([
      expect.objectContaining({ supersededRecordUri: OTHER, keptRecordUri: KEPT }),
    ]);
    expect(snapshot(podDir)).toEqual(before);
  });
});

describe('pod reconcile honours a recorded keep-both answer', () => {
  it('keeps both records, supersedes neither, and does not ask again', async () => {
    const dir = tempDir();
    const { podDir } = await answeredPod(dir, 'both');

    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--apply']);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as {
      summary: { userResolutionsApplied: number; conflictsUnresolved: number };
      userResolutions: { supersessions: unknown[] };
    };
    expect(report.summary.userResolutionsApplied).toBe(1);
    expect(report.summary.conflictsUnresolved).toBe(0);
    expect(report.userResolutions.supersessions).toEqual([]);

    expect(await loadPendingConflicts(podDir)).toEqual([]);
    expect(fs.existsSync(path.join(podDir, ...RETRACTIONS))).toBe(false);
    const meds = graphOf(path.join(podDir, ...MEDS));
    expect(meds.some((l) => l.startsWith(`<${KEPT}> `))).toBe(true);
    expect(meds.some((l) => l.startsWith(`<${OTHER}> `))).toBe(true);

    const first = snapshot(podDir);
    expect((await runCli(['pod', 'reconcile', podDir, '--apply'])).exitCode).toBe(0);
    expect(snapshot(podDir)).toEqual(first);
  });
});

describe('a queue row that was answered and re-raised anyway is cleared', () => {
  it('reports it as cleared by the recorded answer', async () => {
    // What an earlier CLI left behind: the answer is recorded, and a later run
    // put the same question back in the queue because nothing read the answer.
    const dir = tempDir();
    const { podDir, conflictId } = await answeredPod(dir, 'kept');
    await writePendingConflicts(podDir, [
      {
        uri: 'urn:uuid:conflict-reraised',
        conflictId,
        recordType: 'clinical:Medication',
        detectedAt: new Date('2031-01-01T00:00:00Z'),
        candidateRecordUris: [KEPT, OTHER],
      },
    ]);

    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--apply']);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as {
      pendingConflicts: { clearedByResolution: number; answeredIds: string[]; after: number };
    };
    expect(report.pendingConflicts.clearedByResolution).toBe(1);
    expect(report.pendingConflicts.answeredIds).toEqual([conflictId]);
    expect(report.pendingConflicts.after).toBe(0);
    expect(await loadPendingConflicts(podDir)).toEqual([]);
  });
});

describe('runReconciliation: a judgement is found by the records it names', () => {
  it('applies a keep-one answer whose conflict id no longer matches the group', async () => {
    // The id is derived from the match key, and the key can move between runs
    // for the same pair. The records the owner named do not.
    const inputs = [
      { content: medTtl(KEPT, 'Lisinopril 10 mg', '10 mg'), systemName: 'pharmacy' },
      { content: medTtl(OTHER, 'Lisinopril 20 mg', '20 mg'), systemName: 'clinic' },
    ];
    const without = await runReconciliation(inputs);
    expect(without.report.summary.conflictsUnresolved).toBe(1);

    const judgement = {
      uri: 'urn:uuid:resolution-by-records',
      conflictId: 'clinical:Medication::an-earlier-key',
      resolvedAt: new Date('2031-02-03T04:05:06Z'),
      resolution: 'kept-source-a' as const,
      keptRecordUri: KEPT,
      discardedRecordUris: [OTHER],
    };
    const withJudgement = await runReconciliation(inputs, {
      userResolutions: new Map([[judgement.conflictId, judgement]]),
    });
    expect(withJudgement.report.summary.conflictsUnresolved).toBe(0);
    expect(withJudgement.report.unresolvedConflicts).toEqual([]);
    expect(withJudgement.report.userResolutions.answered).toHaveLength(1);
    expect(withJudgement.report.userResolutions.supersessions).toEqual([
      {
        resolutionUri: judgement.uri,
        conflictId: judgement.conflictId,
        supersededRecordUri: OTHER,
        keptRecordUri: KEPT,
        resolvedAt: '2031-02-03T04:05:06.000Z',
      },
    ]);
  });
});

describe('an answer covers the records it names, not every later record under its key', () => {
  it('a third source joining an answered pair raises ONE new conflict naming only the new pairing', async () => {
    const dir = tempDir();
    const { podDir, conflictId } = await answeredPod(dir, 'kept');
    expect((await runCli(['pod', 'reconcile', podDir, '--apply'])).exitCode).toBe(0);

    const third = writeThird(dir);
    expect((await runCli(['pod', 'import', podDir, third, '--source-system', 'hospital'])).exitCode).toBe(0);

    const pending = await loadPendingConflicts(podDir);
    expect(pending, 'the 30 mg record is a question nobody has answered').toHaveLength(1);
    const [row] = pending;
    // The new record against the one the owner kept. The record the owner
    // already chose against is not dragged back into the question.
    expect([...row.candidateRecordUris].sort()).toEqual([KEPT, THIRD].sort());
    // Its own id, so answering it records a second decision instead of
    // overwriting the first.
    expect(row.conflictId).not.toBe(conflictId);
    expect(row.conflictId.startsWith(conflictId)).toBe(true);

    // Answer it, and both answers stand together.
    const side = row.candidateRecordUris[0] === THIRD ? 'source-a' : 'source-b';
    expect(
      (await runCli(['pod', 'resolve', podDir, '--conflict', row.conflictId, '--keep', side])).exitCode,
    ).toBe(0);
    expect((await loadUserResolutions(podDir)).size).toBe(2);
    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--apply']);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as {
      summary: { conflictsUnresolved: number };
      userResolutions: { answered: Array<{ conflictId: string }>; supersessions: unknown[] };
    };
    expect(report.summary.conflictsUnresolved).toBe(0);
    expect(report.userResolutions.answered.map((a) => a.conflictId).sort()).toEqual(
      [conflictId, row.conflictId].sort(),
    );
    expect(report.userResolutions.supersessions).toHaveLength(2);
    expect(await loadPendingConflicts(podDir)).toEqual([]);
  });

  it('a keep-both answer does not silence a third source under the same key', async () => {
    const dir = tempDir();
    const { podDir, conflictId } = await answeredPod(dir, 'both');
    expect((await runCli(['pod', 'reconcile', podDir, '--apply'])).exitCode).toBe(0);

    const third = writeThird(dir);
    expect((await runCli(['pod', 'import', podDir, third, '--source-system', 'hospital'])).exitCode).toBe(0);

    const pending = await loadPendingConflicts(podDir);
    expect(pending).toHaveLength(1);
    // Both earlier records stand (the owner kept both), so the new record is
    // asked about against both.
    expect([...pending[0].candidateRecordUris].sort()).toEqual([KEPT, OTHER, THIRD].sort());
    expect(pending[0].conflictId).not.toBe(conflictId);
  });

  it('an answer whose discarded record is not in the pod does not settle the pair', async () => {
    // The answer names the kept record and a record that does not exist. It is
    // not an answer about the pair the pod holds.
    const dir = tempDir();
    const src = writeSources(dir);
    const podDir = await initPod(dir, 'pod');
    await importBoth(podDir, src);
    const [row] = await loadPendingConflicts(podDir);
    await saveUserResolution(podDir, {
      uri: 'urn:uuid:resolution-stale',
      conflictId: row.conflictId,
      resolvedAt: new Date('2031-01-01T00:00:00Z'),
      resolution: 'kept-source-a',
      keptRecordUri: KEPT,
      discardedRecordUris: ['urn:cascade:med:not-in-this-pod'],
      candidateRecordUris: [KEPT, 'urn:cascade:med:not-in-this-pod'],
    });

    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--apply']);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as {
      summary: { conflictsUnresolved: number; userResolutionsApplied: number };
    };
    expect(report.summary.conflictsUnresolved).toBe(1);
    expect(report.summary.userResolutionsApplied).toBe(0);
    const pending = await loadPendingConflicts(podDir);
    expect(pending.map((c) => c.conflictId)).toEqual([row.conflictId]);
    expect(fs.existsSync(path.join(podDir, ...RETRACTIONS))).toBe(false);
  });

  it('a keep-both answer written before candidate records were recorded is asked again', async () => {
    // Such an answer names no record at all, so there is no telling which
    // pairing it was about. Asking again is the safe direction.
    const dir = tempDir();
    const src = writeSources(dir);
    const podDir = await initPod(dir, 'pod');
    await importBoth(podDir, src);
    const [row] = await loadPendingConflicts(podDir);
    await saveUserResolution(podDir, {
      uri: 'urn:uuid:resolution-legacy-both',
      conflictId: row.conflictId,
      resolvedAt: new Date('2031-01-01T00:00:00Z'),
      resolution: 'kept-both',
      keptRecordUri: '',
      discardedRecordUris: [],
    });
    await writePendingConflicts(podDir, []);

    expect((await runCli(['pod', 'reconcile', podDir, '--apply'])).exitCode).toBe(0);
    expect((await loadPendingConflicts(podDir)).map((c) => c.conflictId)).toEqual([row.conflictId]);
  });

  it('pod resolve records the candidate records for every choice, both included', async () => {
    const dir = tempDir();
    const { podDir } = await answeredPod(dir, 'both');
    const [resolution] = [...(await loadUserResolutions(podDir)).values()];
    expect([...(resolution.candidateRecordUris ?? [])].sort()).toEqual([KEPT, OTHER].sort());
  });
});

describe('the ingestion label is provenance, never a placeholder', () => {
  const SOURCE_SYSTEM = `${CORE}sourceSystem`;

  it('a single-file import states its --source-system, and the next import keeps it', async () => {
    const dir = tempDir();
    const src = writeSources(dir);
    const podDir = await initPod(dir, 'pod');
    expect((await runCli(['pod', 'import', podDir, src.a, '--source-system', 'pharmacy'])).exitCode).toBe(0);
    expect(graphOf(path.join(podDir, ...MEDS))).toContain(`<${KEPT}> <${SOURCE_SYSTEM}> "pharmacy"^^http://www.w3.org/2001/XMLSchema#string`);

    expect((await runCli(['pod', 'import', podDir, src.b, '--source-system', 'clinic'])).exitCode).toBe(0);
    const meds = graphOf(path.join(podDir, ...MEDS));
    expect(meds.filter((l) => l.includes(SOURCE_SYSTEM)).sort()).toEqual(
      [
        `<${KEPT}> <${SOURCE_SYSTEM}> "pharmacy"^^http://www.w3.org/2001/XMLSchema#string`,
        `<${OTHER}> <${SOURCE_SYSTEM}> "clinic"^^http://www.w3.org/2001/XMLSchema#string`,
      ].sort(),
    );
    expect(meds.join('\n')).not.toContain('existing-pod');
  });

  it('pod reconcile never writes the bucket path it read a record from as its source', async () => {
    const dir = tempDir();
    const podDir = await initPod(dir, 'pod');
    // Two records stating no source at all, the shape an older import left.
    fs.writeFileSync(
      path.join(podDir, ...MEDS),
      medTtl(KEPT, 'Lisinopril 10 mg', '10 mg') + '\n' +
        medTtl(OTHER, 'Lisinopril 20 mg', '20 mg').replace(/^@prefix.*\n/gm, ''),
      'utf-8',
    );
    expect((await runCli(['pod', 'reconcile', podDir, '--apply'])).exitCode).toBe(0);
    const meds = graphOf(path.join(podDir, ...MEDS));
    expect(meds.some((l) => l.startsWith(`<${KEPT}> `))).toBe(true);
    expect(meds.filter((l) => l.includes(SOURCE_SYSTEM))).toEqual([]);
  });
});
