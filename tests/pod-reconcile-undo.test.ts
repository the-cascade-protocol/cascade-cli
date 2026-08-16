/**
 * `cascade pod reconcile --undo` — the way back out of a silent merge.
 *
 * WHY THIS VERB IS PART OF THE TIER-0 RULING AND NOT AN EXTRA
 * ----------------------------------------------------------
 * Tier 0 lets one narrow class of duplicate merge without asking anyone. The
 * argument for that is not that the rule is always right; it is that the merge
 * stays a fact the pod holds, with the discarded record's FULL content in
 * `settings/tier0-merge-journal.json`, so anyone who disagrees can get it back.
 * Until this verb existed, "can get it back" meant "can read a JSON file and
 * hand-write Turtle", which is reversibility as a claim rather than as a
 * feature.
 *
 * WHAT THESE TESTS HOLD
 * ---------------------
 *   - the same gate as the forward verb: reporting is the default, --apply
 *     writes, and a report-only run leaves the pod byte-identical;
 *   - restoring puts the record back in the bucket it came out of, and withdraws
 *     the `cascade:mergedFrom` edge that said it had been absorbed;
 *   - running it twice is safe, because the undo is journalled and the second
 *     run can see that;
 *   - a journal entry the pod has moved on from is refused ON ITS OWN, loudly,
 *     while the rest of the journal is replayed.
 *
 * All fixture data is synthetic and PHI-free.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Parser } from 'n3';
import { registerPodCommand } from '../src/commands/pod/index.js';
import {
  readTier0Journal,
  isMergeEntry,
  TIER0_JOURNAL_RELATIVE_PATH,
} from '../src/lib/tier0-journal.js';

const INSTANT = '2031-05-20T09:14:00Z';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const MERGED_FROM = 'https://ns.cascadeprotocol.org/core/v1#mergedFrom';

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

const PREFIXES = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
`;

function labRecord(o: {
  uri: string;
  batch: string;
  origin: string;
  loinc?: string;
  name?: string;
  value?: string;
}): string {
  return `<${o.uri}> a health:LabResultRecord ;
  cascade:sourceSystem "${o.batch}" ;
  cascade:sourceIdentity "${o.origin}" ;
  health:testCode <http://loinc.org/rdf#${o.loinc ?? '2951-2'}> ;
  health:testName "${o.name ?? 'Sodium'}" ;
  health:performedDate "${INSTANT}" ;
  health:resultValue "${o.value ?? '141'}" .
`;
}

const LAB_BUCKET = path.join('clinical', 'lab-results.ttl');

function bucketPath(podDir: string): string {
  return path.join(podDir, LAB_BUCKET);
}

function parseBucket(podDir: string) {
  return new Parser({ format: 'Turtle' }).parse(fs.readFileSync(bucketPath(podDir), 'utf-8'));
}

function recordSubjects(podDir: string): string[] {
  return [
    ...new Set(
      parseBucket(podDir)
        .filter((q) => q.predicate.value === RDF_TYPE)
        .map((q) => q.subject.value),
    ),
  ].sort();
}

function mergedFromEdges(podDir: string): string[] {
  return parseBucket(podDir)
    .filter((q) => q.predicate.value === MERGED_FROM)
    .map((q) => q.object.value)
    .sort();
}

/** A pod that has ALREADY had a tier-0 merge applied, so a journal exists. */
async function podWithAppliedMerge(extra: string[] = []): Promise<string> {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-reconcile-undo-'));
  dirs.push(d);
  const podDir = path.join(d, 'pod');
  expect((await runCli(['pod', 'init', podDir])).exitCode).toBe(0);
  fs.writeFileSync(
    bucketPath(podDir),
    PREFIXES +
      '\n' +
      [
        labRecord({ uri: 'urn:uuid:lab-a', batch: 'Stonebridge export', origin: 'org:stonebridge' }),
        labRecord({ uri: 'urn:uuid:lab-b', batch: 'Larkfield export', origin: 'org:larkfield' }),
        ...extra,
      ].join('\n'),
    'utf-8',
  );
  const applied = await runCli(['pod', 'reconcile', podDir, '--apply']);
  expect(applied.exitCode).toBe(0);
  expect(fs.existsSync(path.join(podDir, TIER0_JOURNAL_RELATIVE_PATH))).toBe(true);
  return podDir;
}

interface UndoReport {
  applied: boolean;
  journal: string;
  merges: Array<{
    canonicalUri: string;
    restores: string[];
    status: string;
    reason?: string;
    bucket?: string;
    canonicalPresent: boolean;
  }>;
  recordsRestored: number;
  mergesUndone: number;
  alreadyUndone: number;
  blocked: number;
  lineageEdgesRemoved: number;
  filesWritten: string[];
}

// ---------------------------------------------------------------------------

describe('pod reconcile --undo: report first, exactly like the forward verb', () => {
  it('says what it would restore and writes nothing', async () => {
    const podDir = await podWithAppliedMerge();
    const bucketBefore = fs.readFileSync(bucketPath(podDir), 'utf-8');
    const journalBefore = fs.readFileSync(path.join(podDir, TIER0_JOURNAL_RELATIVE_PATH), 'utf-8');

    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--undo']);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as UndoReport;
    expect(report.applied).toBe(false);
    expect(report.journal).toBe(TIER0_JOURNAL_RELATIVE_PATH);
    expect(report.mergesUndone).toBe(1);
    expect(report.recordsRestored).toBe(1);
    expect(report.filesWritten).toEqual([]);
    expect(report.merges[0].status).toBe('restorable');
    expect(report.merges[0].bucket).toBe('clinical/lab-results.ttl');
    expect(report.merges[0].canonicalPresent).toBe(true);

    // THE GATE. A verb that restores records the first time someone runs it to
    // see what it does is the same defect the forward verb refuses to have.
    expect(fs.readFileSync(bucketPath(podDir), 'utf-8')).toBe(bucketBefore);
    expect(fs.readFileSync(path.join(podDir, TIER0_JOURNAL_RELATIVE_PATH), 'utf-8')).toBe(
      journalBefore,
    );
  });

  it('says so in words, and says how to apply', async () => {
    const podDir = await podWithAppliedMerge();
    const r = await runCli(['pod', 'reconcile', podDir, '--undo']);
    expect(r.stdout).toContain('DRY RUN');
    expect(r.stdout).toContain('Would restore');
    expect(r.stdout).toContain('--undo --apply');
  });

  it('has nothing to say about a pod that never had a tier-0 merge', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-reconcile-undo-'));
    dirs.push(d);
    const podDir = path.join(d, 'pod');
    await runCli(['pod', 'init', podDir]);
    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--undo']);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as UndoReport;
    expect(report.merges).toEqual([]);
    expect(report.recordsRestored).toBe(0);
  });
});

describe('pod reconcile --undo --apply: the record comes back', () => {
  it('restores the discarded record into its bucket', async () => {
    const podDir = await podWithAppliedMerge();
    expect(recordSubjects(podDir)).toHaveLength(1);

    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--undo', '--apply']);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as UndoReport;
    expect(report.applied).toBe(true);
    expect(report.recordsRestored).toBe(1);
    expect(report.filesWritten).toEqual(['clinical/lab-results.ttl']);

    const subjects = recordSubjects(podDir);
    expect(subjects).toHaveLength(2);
    expect(subjects).toEqual(['urn:uuid:lab-a', 'urn:uuid:lab-b']);
  });

  it('restores the record with its content, not a stub', async () => {
    // The journal keeps every property verbatim, and this is what that is for:
    // a restored record a person cannot tell apart from the one they lost.
    const podDir = await podWithAppliedMerge();
    const journal = readTier0Journal(podDir);
    const merge = journal.entries.filter(isMergeEntry)[0].merges[0];
    const discarded = merge.discarded[0];

    await runCli(['pod', 'reconcile', podDir, '--undo', '--apply']);

    const restored = parseBucket(podDir).filter((q) => q.subject.value === discarded.uri);
    for (const [predicate, values] of Object.entries(discarded.properties)) {
      const got = restored.filter((q) => q.predicate.value === predicate).map((q) => q.object.value);
      for (const v of values) expect(got).toContain(v.value);
    }
  });

  it('withdraws the lineage edge that said the record had been absorbed', async () => {
    // A survivor still claiming `mergedFrom` a record now sitting beside it
    // states a merge the pod no longer contains, and the restored record would
    // read as both live and absorbed at once.
    const podDir = await podWithAppliedMerge();
    expect(mergedFromEdges(podDir)).toContain('urn:uuid:lab-b');

    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--undo', '--apply']);
    const report = JSON.parse(r.stdout) as UndoReport;
    expect(report.lineageEdgesRemoved).toBeGreaterThan(0);
    expect(mergedFromEdges(podDir)).not.toContain('urn:uuid:lab-b');
  });

  it('journals the undo by APPENDING, so the merge is still on the record', async () => {
    const podDir = await podWithAppliedMerge();
    await runCli(['pod', 'reconcile', podDir, '--undo', '--apply']);

    const journal = readTier0Journal(podDir);
    expect(journal.entries).toHaveLength(2);
    // The merge entry is untouched. "this was merged and then put back" and
    // "this was never merged" are different facts, and only the first survives
    // an append-only journal.
    expect(isMergeEntry(journal.entries[0])).toBe(true);
    const undo = journal.entries[1];
    expect(isMergeEntry(undo)).toBe(false);
    expect(undo.rule).toBe('tier-0-merge-undo');
    expect(undo.appliedBy).toBe('pod reconcile --undo --apply');
    expect((undo as { undone: Array<{ restoredUris: string[] }> }).undone[0].restoredUris).toEqual([
      'urn:uuid:lab-b',
    ]);
  });
});

describe('pod reconcile --undo: running it twice is safe', () => {
  it('restores nothing the second time and writes nothing', async () => {
    // Without a memory of the undo this would restore a SECOND copy of every
    // record on every run, which is a worse outcome than the merge it reverses.
    const podDir = await podWithAppliedMerge();
    await runCli(['pod', 'reconcile', podDir, '--undo', '--apply']);
    const afterFirst = fs.readFileSync(bucketPath(podDir), 'utf-8');
    const journalAfterFirst = fs.readFileSync(path.join(podDir, TIER0_JOURNAL_RELATIVE_PATH), 'utf-8');

    const second = await runCli(['--json', 'pod', 'reconcile', podDir, '--undo', '--apply']);
    expect(second.exitCode).toBe(0);
    const report = JSON.parse(second.stdout) as UndoReport;
    expect(report.recordsRestored).toBe(0);
    expect(report.alreadyUndone).toBe(1);
    expect(report.mergesUndone).toBe(0);
    expect(report.filesWritten).toEqual([]);

    expect(recordSubjects(podDir)).toEqual(['urn:uuid:lab-a', 'urn:uuid:lab-b']);
    expect(fs.readFileSync(bucketPath(podDir), 'utf-8')).toBe(afterFirst);
    // And the journal does not grow an entry that says nothing happened.
    expect(fs.readFileSync(path.join(podDir, TIER0_JOURNAL_RELATIVE_PATH), 'utf-8')).toBe(
      journalAfterFirst,
    );
  });

  it('says which merges it left alone rather than reporting an empty run', async () => {
    const podDir = await podWithAppliedMerge();
    await runCli(['pod', 'reconcile', podDir, '--undo', '--apply']);
    const second = await runCli(['pod', 'reconcile', podDir, '--undo']);
    expect(second.stdout).toContain('already undone');
    expect(second.stdout).toContain('Nothing to restore');
  });
});

describe('pod reconcile --undo: a pod that has moved on is refused, per entry', () => {
  it('refuses when a live record already holds the IRI being restored', async () => {
    const podDir = await podWithAppliedMerge();
    // Somebody re-imported the record the merge discarded. Restoring the
    // journalled copy on top of it would put two records under one IRI.
    fs.appendFileSync(
      bucketPath(podDir),
      '\n' + labRecord({ uri: 'urn:uuid:lab-b', batch: 'Later import', origin: 'org:larkfield' }),
      'utf-8',
    );
    const before = fs.readFileSync(bucketPath(podDir), 'utf-8');

    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--undo', '--apply']);
    expect(r.exitCode).toBe(1);
    const report = JSON.parse(r.stdout) as UndoReport;
    expect(report.blocked).toBe(1);
    expect(report.merges[0].status).toBe('blocked');
    expect(report.merges[0].reason).toContain('a live record already holds');
    expect(report.recordsRestored).toBe(0);
    expect(fs.readFileSync(bucketPath(podDir), 'utf-8')).toBe(before);
  });

  it('refuses when the bucket the record belongs in is gone', async () => {
    const podDir = await podWithAppliedMerge();
    fs.rmSync(bucketPath(podDir));

    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--undo', '--apply']);
    expect(r.exitCode).toBe(1);
    const report = JSON.parse(r.stdout) as UndoReport;
    expect(report.blocked).toBe(1);
    expect(report.merges[0].reason).toContain('no longer exists in this pod');
    expect(fs.existsSync(bucketPath(podDir))).toBe(false);
  });

  it('replays the rest of the journal around a refused entry', async () => {
    // PER ENTRY, not per run. Abandoning the whole replay over one unrestorable
    // merge would make an unrelated recoverable record unrecoverable.
    const podDir = await podWithAppliedMerge([
      labRecord({
        uri: 'urn:uuid:lab-c',
        batch: 'Stonebridge export',
        origin: 'org:stonebridge',
        loinc: '2160-0',
        name: 'Creatinine',
        value: '1.1',
      }),
      labRecord({
        uri: 'urn:uuid:lab-d',
        batch: 'Larkfield export',
        origin: 'org:larkfield',
        loinc: '2160-0',
        name: 'Creatinine',
        value: '1.1',
      }),
    ]);
    // Two merges were journalled; block exactly one of them.
    const journal = readTier0Journal(podDir);
    const merges = journal.entries.filter(isMergeEntry).flatMap((e) => e.merges);
    expect(merges).toHaveLength(2);
    const blockedUri = merges[0].discarded[0].uri;
    const freeUri = merges[1].discarded[0].uri;
    fs.appendFileSync(
      bucketPath(podDir),
      '\n' + labRecord({ uri: blockedUri, batch: 'Later import', origin: 'org:larkfield' }),
      'utf-8',
    );

    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--undo', '--apply']);
    expect(r.exitCode).toBe(1);
    const report = JSON.parse(r.stdout) as UndoReport;
    expect(report.blocked).toBe(1);
    expect(report.mergesUndone).toBe(1);
    expect(recordSubjects(podDir)).toContain(freeUri);
    expect(r.stdout).toContain(blockedUri);
  });

  it('restores even when the record the merge KEPT has since been deleted', async () => {
    // The asymmetry the report field records. The journal exists so a discarded
    // record can always be recovered; refusing because the survivor is gone
    // would fail exactly when recovery matters most.
    const podDir = await podWithAppliedMerge();
    const journal = readTier0Journal(podDir);
    const merge = journal.entries.filter(isMergeEntry)[0].merges[0];
    // Drop the survivor, keeping a syntactically valid but empty bucket.
    fs.writeFileSync(bucketPath(podDir), PREFIXES, 'utf-8');

    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--undo', '--apply']);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as UndoReport;
    expect(report.merges[0].canonicalPresent).toBe(false);
    expect(report.merges[0].status).toBe('restorable');
    expect(recordSubjects(podDir)).toEqual([merge.discarded[0].uri]);
  });
});
