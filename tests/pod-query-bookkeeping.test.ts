/**
 * `pod query` answers with the pod's RECORDS. The pod's paperwork about those
 * records is not one of them.
 *
 * WHAT WAS WRONG
 * --------------
 * `--all` sweeps every `.ttl` in the pod that is not on a short exclusion list of
 * plumbing files, and `settings/pending-conflicts.ttl` and
 * `settings/user-resolutions.ttl` were not on it. So every unresolved conflict
 * and every decision the user had already recorded came back as a record, in the
 * `other` bucket, with no date and no origin, alongside the medications. A
 * consumer that treats query output as health records renders paperwork as
 * mystery records, and acquires one more of them every time a conflict is
 * detected or resolved.
 *
 * WHAT IT DOES NOW
 * ----------------
 * Bookkeeping SUBJECTS are excluded from the record output by default and
 * returned by `--include-bookkeeping`, which is there because the queue is real
 * data that real tooling wants — a conflict UI has to be able to ask for it.
 *
 * The rule is stated over rdf:type, not over filenames: what makes a
 * cascade:PendingConflict not a record is that it is a note about records, and
 * that stays true wherever it is stored. `BOOKKEEPING_TYPE_IRIS` in
 * `lib/pod-read.ts` is the enumeration.
 *
 * Every fixture is synthetic and authored for this repository.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'dist', 'index.js');

function cli(args: string[]): { out: string; status: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', timeout: 120000 });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status ?? 1 };
}

/** One synthetic medication, parameterised on the axes a dose conflict needs. */
function medTtl(slug: string, drugName: string, rxnorm: string, dosage: string): string {
  return `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .

<urn:cascade:med:${slug}> a clinical:Medication ;
    clinical:drugName "${drugName}" ;
    clinical:rxNormCode <https://ns.cascadeprotocol.org/rxnorm/${rxnorm}> ;
    clinical:dosage "${dosage}" ;
    clinical:status "active" ;
    cascade:dataProvenance cascade:Imported ;
    cascade:schemaVersion "1.9" .
`;
}

interface QueryPayload {
  pod: string;
  dataTypes: Record<
    string,
    { count: number; file: string; records: Array<{ id: string; type: string }> }
  >;
}

function queryAll(podDir: string, extra: string[] = []): QueryPayload {
  const r = cli(['--json', 'pod', 'query', podDir, '--all', ...extra]);
  expect(r.status, `pod query failed:\n${r.out}`).toBe(0);
  return JSON.parse(r.out) as QueryPayload;
}

/** Every record type the query returned, across every bucket, sorted. */
function typesReturned(payload: QueryPayload): string[] {
  return Object.values(payload.dataTypes)
    .flatMap((b) => b.records.map((rec) => rec.type))
    .sort();
}

let root: string;
/** A pod holding three medications, ONE unresolved conflict and ONE resolution. */
let podDir: string;
/** The same pod's shape with no bookkeeping at all, for the byte-stability check. */
let cleanPodDir: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-query-bookkeeping-'));
  podDir = path.join(root, 'pod');
  cleanPodDir = path.join(root, 'clean-pod');

  if (!fs.existsSync(CLI)) {
    throw new Error('dist/index.js is missing — run `npm run build` before `npm test`.');
  }

  const write = (name: string, ttl: string): string => {
    const p = path.join(root, `${name}.ttl`);
    fs.writeFileSync(p, ttl, 'utf-8');
    return p;
  };

  const levoA = write('levo-a', medTtl('levo-a', 'Levothyroxine 50 mcg', '966224', '50 mcg'));
  const levoB = write('levo-b', medTtl('levo-b', 'Levothyroxine 75 mcg', '966224', '75 mcg'));
  const sertA = write('sert-a', medTtl('sert-a', 'Sertraline 50 mg', '312940', '50 mg'));
  const sertB = write('sert-b', medTtl('sert-b', 'Sertraline 100 mg', '312940', '100 mg'));
  const omepA = write('omep-a', medTtl('omep-a', 'Omeprazole 20 mg', '7646', '20 mg'));

  expect(cli(['pod', 'init', podDir]).status).toBe(0);
  // Two disagreeing doses of one drug raise a conflict; resolving it writes
  // settings/user-resolutions.ttl. A SECOND disagreement afterwards leaves
  // settings/pending-conflicts.ttl populated too, so both files carry a row.
  for (const f of [levoA, levoB]) {
    expect(cli(['pod', 'import', podDir, f, '--reconcile-existing']).status).toBe(0);
  }
  const conflicts = cli(['pod', 'conflicts', podDir, '--format', 'json']);
  const rows = JSON.parse(conflicts.out) as Array<{ conflictId: string }>;
  expect(rows.length, `expected one levothyroxine conflict:\n${conflicts.out}`).toBe(1);
  expect(
    cli(['pod', 'resolve', podDir, '--conflict', rows[0].conflictId, '--keep', 'source-a']).status,
  ).toBe(0);
  for (const f of [sertA, sertB]) {
    expect(cli(['pod', 'import', podDir, f, '--reconcile-existing']).status).toBe(0);
  }

  // The control pod: same command sequence, no disagreement, so no bookkeeping.
  expect(cli(['pod', 'init', cleanPodDir]).status).toBe(0);
  expect(cli(['pod', 'import', cleanPodDir, omepA, '--reconcile-existing']).status).toBe(0);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('pod query --all: the pod holds the bookkeeping this test is about', () => {
  it('wrote both settings files, so the assertions below are not vacuous', () => {
    // Without this, a change that stopped WRITING the conflict queue would make
    // every test in this file pass while destroying the feature they guard.
    const pending = fs.readFileSync(path.join(podDir, 'settings', 'pending-conflicts.ttl'), 'utf-8');
    const resolutions = fs.readFileSync(
      path.join(podDir, 'settings', 'user-resolutions.ttl'),
      'utf-8',
    );
    expect(pending).toContain('PendingConflict');
    expect(resolutions).toContain('UserResolution');
  });
});

describe('pod query --all: paperwork is not a record', () => {
  it('returns neither a pending conflict nor a resolution by default', () => {
    const types = typesReturned(queryAll(podDir));
    expect(types).not.toContain('core:PendingConflict');
    expect(types).not.toContain('core:UserResolution');
    // The medications are still all there: this excludes bookkeeping, not files.
    expect(types).toEqual(['clinical:Medication', 'clinical:Medication']);
  });

  it('leaves no empty bucket behind where the bookkeeping used to be counted', () => {
    // The `other` bucket existed ONLY because those two files landed in it. A
    // filter applied after the bucket was built would leave `other: {count: 0}`,
    // which is a different lie: a consumer renders an empty "Other" section that
    // a pod without conflicts never shows.
    const payload = queryAll(podDir);
    expect(Object.keys(payload.dataTypes).sort()).toEqual(['medications']);
    for (const [name, bucket] of Object.entries(payload.dataTypes)) {
      expect(bucket.count, name).toBe(bucket.records.length);
    }
  });

  it('returns both, with their properties, under --include-bookkeeping', () => {
    const payload = queryAll(podDir, ['--include-bookkeeping']);
    const types = typesReturned(payload);
    expect(types).toContain('core:PendingConflict');
    expect(types).toContain('core:UserResolution');

    // Opting in must return the paperwork USABLE, not merely present.
    const paperwork = Object.values(payload.dataTypes)
      .flatMap((b) => b.records)
      .filter((r) => r.type === 'core:PendingConflict' || r.type === 'core:UserResolution');
    expect(paperwork).toHaveLength(2);
    for (const rec of paperwork) {
      const props = (rec as unknown as { properties: Record<string, string> }).properties;
      expect(Object.keys(props), rec.type).toContain('core:conflictId');
    }
  });

  it('counts what it returns, in both modes', () => {
    for (const extra of [[], ['--include-bookkeeping']]) {
      const payload = queryAll(podDir, extra);
      for (const [name, bucket] of Object.entries(payload.dataTypes)) {
        expect(bucket.count, `${name} with ${JSON.stringify(extra)}`).toBe(bucket.records.length);
      }
    }
  });

  it('changes nothing at all about a pod that holds no bookkeeping', () => {
    // The byte-stability claim, stated as a claim rather than as a hope: for the
    // overwhelming majority of pods this flag must be invisible.
    const withoutFlag = JSON.stringify(queryAll(cleanPodDir));
    const withFlag = JSON.stringify(queryAll(cleanPodDir, ['--include-bookkeeping']));
    expect(withoutFlag).toBe(withFlag);
    expect(typesReturned(JSON.parse(withoutFlag) as QueryPayload)).toEqual(['clinical:Medication']);
  });

  it('documents the flag in --help', () => {
    const help = cli(['pod', 'query', '--help']).out;
    expect(help).toContain('--include-bookkeeping');
  });
});

describe('the verbs that read FILES are unaffected', () => {
  it('pod conflicts still returns the unresolved conflict', () => {
    // `pod query` is not how the conflict queue is read, and this is the check
    // that the exclusion did not reach the command whose entire job it is.
    const r = cli(['pod', 'conflicts', podDir, '--format', 'json']);
    expect(r.status, r.out).not.toBe(2);
    const rows = JSON.parse(r.out) as Array<{ conflictId: string; recordType: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].recordType).toBe('clinical:Medication');
  });

  it('validate still reads the settings files and reports on them', () => {
    const r = cli(['--json', 'validate', podDir]);
    const files = JSON.parse(r.out) as Array<{ file: string }>;
    const names = files.map((f) => path.basename(f.file));
    expect(names).toContain('pending-conflicts.ttl');
    expect(names).toContain('user-resolutions.ttl');
  });

  it('reconcile still reads the records AND the conflict queue', () => {
    // Dry run by default, so this reports without writing. Both numbers matter:
    // `recordsBefore` is the record file it reads, `pendingConflicts.before` is
    // the settings file — the one this change makes `pod query` stop returning.
    const r = cli(['--json', 'pod', 'reconcile', podDir]);
    expect(r.status, r.out).toBe(0);
    const report = JSON.parse(r.out) as {
      recordsBefore: number;
      pendingConflicts: { before: number };
    };
    expect(report.recordsBefore).toBeGreaterThan(0);
    expect(report.pendingConflicts.before).toBe(1);
  });
});
