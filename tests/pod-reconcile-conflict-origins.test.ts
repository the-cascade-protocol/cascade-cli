/**
 * What a raised conflict row SAYS, and whether it is still answerable later.
 *
 * TWO DEFECTS, ONE ROW
 * --------------------
 * A pod-internal `pod reconcile` reads its records back out of the pod, so every
 * record's INGESTION label is whatever the pod restated (or, for a record that
 * states none, the bucket path the reader defaulted to). Both sides of a
 * conflict therefore arrived under one string, and the row said so twice:
 *
 *     Source A: clinical/medications.ttl
 *     Source B: clinical/medications.ttl
 *
 * which names nothing a person can act on. The second defect is the one that
 * loses data rather than merely failing to show it: the reconciler's map of the
 * two sides' VALUES was keyed by that same string, so the two entries collapsed
 * into one and whichever side was written second was the only value that
 * survived into `cascade:conflictValues`. A dose disagreement between "50 mcg"
 * and "75 mcg" reached the pod as the single clause `batch: "75 mcg"`.
 *
 * The axis that actually distinguishes the two sides is the ORIGIN
 * (`cascade:sourceIdentity`, rendered through `sourceLabel`), which is exactly
 * the axis the same-source guard already uses to decide the two are comparable
 * at all. So the row is keyed and labelled by origin, and both values survive.
 *
 * AND THE ROW HAS TO OUTLIVE THE MERGE
 * ------------------------------------
 * A conflict row keeps both candidate IRIs, but a value conflict that resolves
 * absorbs the losing record: a consumer that follows the two IRIs to show the
 * user "this side says X, that side says Y" finds one of them gone. So the
 * substance of the disagreement is written ONTO the row at raise time, and this
 * file asserts it is there after the apply that removed one of the candidates.
 *
 * All fixture data is synthetic.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { loadPendingConflicts, type PendingConflict } from '../src/lib/user-resolutions.js';

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

async function makePod(): Promise<string> {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-conflict-origins-'));
  dirs.push(d);
  const podDir = path.join(d, 'pod');
  expect((await runCli(['pod', 'init', podDir])).exitCode).toBe(0);
  return podDir;
}

const PREFIXES = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
`;

/**
 * Two organizations' copies of one drug, disagreeing on dose, under ONE batch
 * label. The shared batch label is the point: it is what a pod-internal read
 * produces, and it is what used to be printed as both sides of the row.
 */
function medsPod(podDir: string): void {
  fs.writeFileSync(
    path.join(podDir, 'clinical', 'medications.ttl'),
    PREFIXES +
      `
<urn:uuid:med-meridian> a clinical:Medication ;
  cascade:sourceSystem "one-batch" ;
  cascade:sourceIdentity "org:meridian" ;
  clinical:sourceEHR "Meridian" ;
  clinical:drugName "Levothyroxine" ;
  clinical:dosage "50 mcg" ;
  clinical:status "active" .

<urn:uuid:med-stonebridge> a clinical:Medication ;
  cascade:sourceSystem "one-batch" ;
  cascade:sourceIdentity "org:stonebridge" ;
  clinical:sourceEHR "Stonebridge" ;
  clinical:drugName "Levothyroxine" ;
  clinical:dosage "75 mcg" ;
  clinical:status "active" .
`,
    'utf-8',
  );
}

// ---------------------------------------------------------------------------

describe('a raised conflict names the two ORIGINS, not the batch they share', () => {
  it('gives sourceA and sourceB the two distinct origin labels', async () => {
    const podDir = await makePod();
    medsPod(podDir);
    expect((await runCli(['pod', 'reconcile', podDir, '--apply'])).exitCode).toBe(0);

    const [row] = await loadPendingConflicts(podDir);
    expect(row).toBeDefined();
    // Not "one-batch" twice. These are `sourceLabel(org:meridian)` and
    // `sourceLabel(org:stonebridge)`, the same derivation every source-scoped
    // surface in the pod already renders.
    expect([row.sourceA, row.sourceB].sort()).toEqual(['Meridian', 'Stonebridge']);
  });

  it('carries BOTH sides values into the reconciled record, not one', async () => {
    // The collapse: a map keyed by the shared batch label holds one entry, and
    // the losing side's value is the one that is silently dropped.
    const podDir = await makePod();
    medsPod(podDir);
    await runCli(['pod', 'reconcile', podDir, '--apply']);

    const meds = fs.readFileSync(path.join(podDir, 'clinical', 'medications.ttl'), 'utf-8');
    expect(meds).toContain('conflictValues');
    expect(meds).toContain('50 mcg');
    expect(meds).toContain('75 mcg');
    expect(meds).not.toContain('one-batch: ');
  });

  it('reports the origin axis alongside the ingestion axis', async () => {
    const podDir = await makePod();
    medsPod(podDir);
    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--apply']);
    const report = JSON.parse(r.stdout) as {
      groups: Array<{ type: string; sources: string[]; origins: string[] }>;
    };
    const g = report.groups.find((x) => x.type === 'value_conflict');
    expect(g).toBeDefined();
    // `sources` is unchanged: it is the INGESTION axis and it really is one
    // batch. `origins` is the new, different fact.
    expect(g!.sources).toEqual(['one-batch', 'one-batch']);
    expect([...g!.origins].sort()).toEqual(['Meridian', 'Stonebridge']);
  });

  it('falls back to the record IRI when a record states no origin at all', async () => {
    // A pod written before origins existed. Two indistinguishable labels would
    // put the collapse straight back, so the row falls back to something that
    // is unique by construction.
    const podDir = await makePod();
    fs.writeFileSync(
      path.join(podDir, 'clinical', 'medications.ttl'),
      PREFIXES +
        `
<urn:uuid:med-old-a> a clinical:Medication ;
  clinical:drugName "Omeprazole" ;
  clinical:dosage "20 mg" ;
  clinical:status "active" .

<urn:uuid:med-old-b> a clinical:Medication ;
  cascade:sourceSystem "second-batch" ;
  clinical:drugName "Omeprazole" ;
  clinical:dosage "40 mg" ;
  clinical:status "active" .
`,
      'utf-8',
    );
    await runCli(['pod', 'reconcile', podDir, '--apply']);

    const [row] = await loadPendingConflicts(podDir);
    expect(row).toBeDefined();
    expect(row.sourceA).not.toBe(row.sourceB);
    expect([row.sourceA, row.sourceB].sort()).toEqual([
      'urn:uuid:med-old-a',
      'urn:uuid:med-old-b',
    ]);
  });
});

describe('a raised conflict row stays reviewable after its candidates merge', () => {
  it('records the field, both values, both origins and the survivor ON the row', async () => {
    const podDir = await makePod();
    medsPod(podDir);
    await runCli(['pod', 'reconcile', podDir, '--apply']);

    const [row] = await loadPendingConflicts(podDir);
    expect(row.conflictField).toBe('clinical:dosage');
    expect([row.valueA, row.valueB].sort()).toEqual(['50 mcg', '75 mcg']);
    // Whichever candidate the reconciler kept: the consumer needs to know which
    // of the two IRIs it can still dereference.
    expect(row.candidateRecordUris).toContain(row.survivingRecordUri as string);
  });

  it('survives the round trip through the file, so `pod conflicts` can show it', async () => {
    const podDir = await makePod();
    medsPod(podDir);
    await runCli(['pod', 'reconcile', podDir, '--apply']);

    const r = await runCli(['pod', 'conflicts', podDir, '--format', 'json']);
    const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].conflictField).toBe('clinical:dosage');
    expect([rows[0].valueA, rows[0].valueB].sort()).toEqual(['50 mcg', '75 mcg']);
    expect(rows[0].survivingRecordUri).toBeTruthy();
    expect([rows[0].sourceA, rows[0].sourceB].sort()).toEqual(['Meridian', 'Stonebridge']);
  });

  it('reads a row written before these predicates existed', async () => {
    // Backward compatibility is not optional: a pod carrying rows from an
    // earlier CLI must still parse, with the new fields simply absent.
    const podDir = await makePod();
    fs.writeFileSync(
      path.join(podDir, 'settings', 'pending-conflicts.ttl'),
      `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<urn:uuid:conflict-legacy> a cascade:PendingConflict ;
  cascade:conflictId "legacy-row" ;
  cascade:recordType "clinical:Medication" ;
  cascade:detectedAt "2031-01-01T00:00:00.000Z"^^xsd:dateTime ;
  cascade:candidateRecords <urn:uuid:legacy-a>, <urn:uuid:legacy-b> ;
  cascade:sourceA "Meridian" ;
  cascade:sourceB "Stonebridge" .
`,
      'utf-8',
    );

    const rows = await loadPendingConflicts(podDir);
    expect(rows).toHaveLength(1);
    const row = rows[0] as PendingConflict;
    expect(row.conflictId).toBe('legacy-row');
    expect(row.sourceA).toBe('Meridian');
    expect(row.conflictField).toBeUndefined();
    expect(row.valueA).toBeUndefined();
    expect(row.survivingRecordUri).toBeUndefined();
  });
});
