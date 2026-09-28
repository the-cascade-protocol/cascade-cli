/**
 * Reading a pod with wellness data should cost what the reader needs, not what
 * the pod holds.
 *
 * WHAT WAS WRONG. `pod query --all` read, decrypted and parsed every wellness
 * record and every retained-sample descriptor on every call, and `--edges` did
 * it twice. A reader that shows clinical records and a daily wellness series
 * paid for tens of thousands of daily aggregates it then threw away.
 *
 * WHAT THIS PINS.
 *   1. `--exclude-data-type <key>` leaves a file UNREAD: asserted on the read
 *      layer (`PodReader.readText`, which every record read, decrypt and parse
 *      goes through), never on the output, because filtering a parse would
 *      produce the same output and save nothing. The record sweep, `--edges`
 *      and `--neighbors` all honour it; the default is unchanged.
 *   2. The stored daily series applies the source-priority rule in the three
 *      cases a name-based rule gets wrong: a third-party app called "Sleep
 *      Watch", an Apple Watch renamed to something with no "Watch" in it, and a
 *      non-Apple device whose hardware model is "Watch4,1".
 *   3. The series is a derived view: rebuilding it gives the same bytes, it is
 *      rebuilt when the records change (an erased record's value leaves it),
 *      and every record it cites resolves in the pod.
 *
 * Every fixture is synthetic: invented values and names, no real export.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Parser } from 'n3';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { PodReader } from '../src/lib/pod-read.js';
import { DailySeriesBuilder, dailySeriesBytes, type DailySeriesView } from '../src/lib/apple-health-wellness/daily-series.js';

const CLI = path.resolve(__dirname, '../dist/index.js');
const FIXTURE = path.resolve(__dirname, '../test-fixtures/apple-health-wellness');
const PASSPHRASE = 'wellness-read-cost-test-passphrase';

function cli(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf-8', timeout: 180_000, env: { ...process.env, ...env } });
}

/** Run the pod commands in this process, so the read layer can be observed. */
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const program = new Command();
  program.name('cascade').exitOverride().option('--verbose', 'Verbose output', false).option('--json', 'Output JSON', false);
  registerPodCommand(program);
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')));
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(' ')));
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

/** Pod-relative paths of every file the read layer opened during `fn`. */
async function filesRead(podDir: string, fn: () => Promise<unknown>): Promise<Set<string>> {
  const read = new Set<string>();
  const original = PodReader.prototype.readText;
  const spy = vi.spyOn(PodReader.prototype, 'readText').mockImplementation(function (this: PodReader, abs: string) {
    read.add(path.relative(podDir, abs).split(path.sep).join('/'));
    return original.call(this, abs);
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return read;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function importedPod(encrypt = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wellness-read-cost-'));
  const podDir = path.join(root, 'pod');
  const env = encrypt ? { CASCADE_POD_PASSPHRASE: PASSPHRASE } : {};
  cli(['pod', 'init', podDir, ...(encrypt ? ['--encrypt'] : [])], env);
  cli(['pod', 'import', podDir, FIXTURE], env);
  return podDir;
}

const WELLNESS_FILES = [
  'wellness/heart-rate.ttl',
  'wellness/hrv.ttl',
  'wellness/activity.ttl',
  'wellness/sleep.ttl',
  'wellness/devices.ttl',
  'wellness/samples/samples.ttl',
];
const EXCLUDE = [
  '--exclude-data-type', 'heart-rate',
  '--exclude-data-type', 'hrv',
  '--exclude-data-type', 'activity',
  '--exclude-data-type', 'sleep',
  '--exclude-data-type', 'wellness-devices',
  '--exclude-data-type', 'wellness-samples',
];

interface QueryPayload {
  dataTypes: Record<string, { count: number; records: Array<{ id: string; type: string }> }>;
  edges?: Array<{ subject: string; object: string }>;
  wellnessDailySeries?: (DailySeriesView & { attachment: string; generatedBy: string }) | null;
}

// ---------------------------------------------------------------------------
// 1. The data-type filter
// ---------------------------------------------------------------------------

describe('pod query --exclude-data-type', () => {
  let podDir: string;
  beforeAll(() => {
    podDir = importedPod();
  }, 180_000);
  afterAll(() => fs.rmSync(path.dirname(podDir), { recursive: true, force: true }));

  it('never reads an excluded file (asserted on the read layer), and still reads the rest', async () => {
    let payload: QueryPayload | undefined;
    const read = await filesRead(podDir, async () => {
      const r = await runCli(['--json', 'pod', 'query', podDir, '--all', ...EXCLUDE]);
      expect(r.exitCode, r.stderr).toBe(0);
      payload = JSON.parse(r.stdout) as QueryPayload;
    });
    for (const f of WELLNESS_FILES) expect(read.has(f), `${f} was read`).toBe(false);
    // Not excluded: still read, still returned.
    expect(read.has('clinical/conditions.ttl')).toBe(true);
    expect(read.has('wellness/blood-pressure.ttl')).toBe(true);
    expect(Object.keys(payload!.dataTypes)).toContain('conditions');
    for (const key of ['heart-rate', 'hrv', 'activity', 'sleep', 'wellness-devices']) {
      expect(payload!.dataTypes[key]).toBeUndefined();
    }
    // The descriptors were the `other` bucket's only records on this pod.
    const types = Object.values(payload!.dataTypes).flatMap((b) => b.records.map((x) => x.type));
    expect(types).not.toContain('core:Attachment');
  });

  it('changes nothing by default: every wellness file and the descriptors are read and returned', async () => {
    let payload: QueryPayload | undefined;
    const read = await filesRead(podDir, async () => {
      const r = await runCli(['--json', 'pod', 'query', podDir, '--all']);
      expect(r.exitCode, r.stderr).toBe(0);
      payload = JSON.parse(r.stdout) as QueryPayload;
    });
    for (const f of WELLNESS_FILES) expect(read.has(f), `${f} was not read`).toBe(true);
    expect(payload!.dataTypes['heart-rate'].count).toBe(13);
    const types = Object.values(payload!.dataTypes).flatMap((b) => b.records.map((x) => x.type));
    expect(types).toContain('core:Attachment');
    // The series descriptor is pod plumbing, never a record.
    expect(read.has('wellness/series/daily-series.ttl')).toBe(false);
  });

  it('--edges honours it: the graph never opens an excluded file', async () => {
    let payload: QueryPayload | undefined;
    const read = await filesRead(podDir, async () => {
      const r = await runCli(['--json', 'pod', 'query', podDir, '--all', '--edges', ...EXCLUDE]);
      expect(r.exitCode, r.stderr).toBe(0);
      payload = JSON.parse(r.stdout) as QueryPayload;
    });
    for (const f of WELLNESS_FILES) expect(read.has(f), `${f} was read`).toBe(false);
    expect(Array.isArray(payload!.edges)).toBe(true);

    // Control: without the filter, --edges reads them.
    const all = await filesRead(podDir, async () => {
      const r = await runCli(['--json', 'pod', 'query', podDir, '--all', '--edges']);
      expect(r.exitCode, r.stderr).toBe(0);
    });
    for (const f of WELLNESS_FILES) expect(all.has(f), `${f} was not read`).toBe(true);
  });

  it('--neighbors honours it too', async () => {
    const conditions = JSON.parse((await runCli(['--json', 'pod', 'query', podDir, '--conditions'])).stdout) as QueryPayload;
    const seed = conditions.dataTypes.conditions.records[0].id;
    const read = await filesRead(podDir, async () => {
      const r = await runCli(['--json', 'pod', 'query', podDir, '--neighbors', seed, ...EXCLUDE]);
      expect(r.exitCode, r.stderr).toBe(0);
    });
    for (const f of WELLNESS_FILES) expect(read.has(f), `${f} was read`).toBe(false);
    expect(read.has('clinical/conditions.ttl')).toBe(true);
  });

  it('refuses an unknown key (exit 1) and names the known ones', async () => {
    const r = await runCli(['--json', 'pod', 'query', podDir, '--all', '--exclude-data-type', 'wellness']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('wellness-samples');
    expect(r.stderr).toContain('heart-rate');
  });

  it('--wellness-series alone reads the descriptor and the view, and no record file', async () => {
    let payload: QueryPayload | undefined;
    const read = await filesRead(podDir, async () => {
      const r = await runCli(['--json', 'pod', 'query', podDir, '--wellness-series']);
      expect(r.exitCode, r.stderr).toBe(0);
      payload = JSON.parse(r.stdout) as QueryPayload;
    });
    const series = payload!.wellnessDailySeries!;
    expect([...read].sort()).toEqual([series.attachment, 'wellness/series/daily-series.ttl'].sort());
    expect(series.generatedBy).toBe('wellness-daily-series/1');
    expect(series.ruleVersion).toBe('1');
    const rhr = series.series.find((s) => s.key === '40443-4' && s.statistic === 'average')!;
    expect(rhr.date.length).toBe(3);
    // The shelf summary: sources, their devices and per reading type the days.
    const watch = series.sources.find((s) => series.tiers[s.tier] === 'watch')!;
    expect(watch.devices.length).toBe(1);
    expect(watch.readingTypes.find((t) => t.key === '40443-4')?.days).toBe(3);
    // Each input file's record count, as --all would report its bucket.
    expect(series.recordCounts['heart-rate']).toBe(13);
    expect(series.recordCounts['wellness-devices']).toBe(2);
  });

  it('--wellness-series rides beside --all in one call', async () => {
    const r = await runCli(['--json', 'pod', 'query', podDir, '--all', ...EXCLUDE, '--wellness-series']);
    expect(r.exitCode, r.stderr).toBe(0);
    const payload = JSON.parse(r.stdout) as QueryPayload;
    expect(payload.dataTypes.conditions).toBeDefined();
    expect(payload.wellnessDailySeries?.format).toBe('cascade-wellness-daily-series');
  });
});

// ---------------------------------------------------------------------------
// 2. The source-priority rule, in the three hard cases
// ---------------------------------------------------------------------------

const TTL_PREFIXES = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix loinc: <http://loinc.org/rdf#> .
`;

const DEVICES = `${TTL_PREFIXES}
<urn:uuid:00000000-0000-4000-8000-00000000d001> a health:Device ;
  health:deviceName "Apple Watch" ; health:deviceModel "Watch" ; health:hardwareVersion "Watch6,1" ;
  health:deviceManufacturer "Apple Inc." .
<urn:uuid:00000000-0000-4000-8000-00000000d002> a health:Device ;
  health:deviceName "iPhone" ; health:deviceModel "iPhone" ; health:hardwareVersion "iPhone15,2" ;
  health:deviceManufacturer "Apple Inc." .
<urn:uuid:00000000-0000-4000-8000-00000000d003> a health:Device ;
  health:deviceName "Galaxy Watch4" ; health:deviceModel "SM-R860" ; health:hardwareVersion "Watch4,1" ;
  health:deviceManufacturer "Samsung" .
`;

/** One daily reading, in the shape the wellness import writes. */
function reading(n: number, opts: { code: string; stat: string; value: number; day: string; source: string; device?: string; samples: number }): string {
  const start = `${opts.day}T05:00:00Z`;
  return `<urn:uuid:00000000-0000-4000-8000-${String(n).padStart(12, '0')}> a health:DailyVitalReading ;
  cascade:loincCode loinc:${opts.code} ; health:value "${opts.value}"^^xsd:double ; health:unit "bpm" ;
  cascade:date "${start}"^^xsd:dateTime ; health:periodStart "${start}"^^xsd:dateTime ;
  health:timeZone "America/New_York" ; cascade:statistic "${opts.stat}" ; cascade:sampleCount "${opts.samples}"^^xsd:integer ;
  cascade:sourceDeviceName "${opts.source}"${opts.device ? ` ;\n  health:device <urn:uuid:00000000-0000-4000-8000-00000000${opts.device}>` : ''} .
`;
}

const WATCH = 'd001';
const PHONE = 'd002';
const GALAXY = 'd003';
const RENAMED = 'Kitchen Timer'; // an Apple Watch its owner renamed

const HEART_RATE = [
  TTL_PREFIXES,
  // Day A: an app named "Sleep Watch" (no device at all) against the phone.
  // More samples, and a name containing "Watch": a name rule would pick it.
  reading(1, { code: '40443-4', stat: 'average', value: 50, day: '2026-03-01', source: 'Sleep Watch', samples: 99 }),
  reading(2, { code: '40443-4', stat: 'average', value: 60, day: '2026-03-01', source: "Jo's iPhone", device: PHONE, samples: 1 }),
  // Day B: resting heart rate, which Apple writes with NO device, from a renamed
  // watch, against the phone. The source is a watch because its device-bearing
  // records (the heart rate averages below) predominantly name the watch.
  reading(3, { code: '40443-4', stat: 'average', value: 55, day: '2026-03-02', source: RENAMED, samples: 1 }),
  reading(4, { code: '40443-4', stat: 'average', value: 65, day: '2026-03-02', source: "Jo's iPhone", device: PHONE, samples: 10 }),
  reading(5, { code: '8867-4', stat: 'average', value: 71, day: '2026-03-02', source: RENAMED, device: WATCH, samples: 300 }),
  reading(6, { code: '8867-4', stat: 'average', value: 72, day: '2026-03-03', source: RENAMED, device: WATCH, samples: 300 }),
  // Day C: a non-Apple watch whose hardware model is "Watch4,1", against the phone.
  reading(7, { code: '40443-4', stat: 'average', value: 70, day: '2026-03-03', source: 'Galaxy Watch', device: GALAXY, samples: 50 }),
  reading(8, { code: '40443-4', stat: 'average', value: 62, day: '2026-03-03', source: "Jo's iPhone", device: PHONE, samples: 2 }),
].join('\n');

function buildFrom(ttls: string[]): DailySeriesView {
  const b = new DailySeriesBuilder();
  for (const ttl of ttls) b.addQuads(new Parser({ baseIRI: 'https://pod.invalid/x' }).parse(ttl));
  return b.finish({ dayZone: 'America/New_York', inputs: [] });
}

describe('the stored daily series applies the source-priority rule', () => {
  const view = buildFrom([DEVICES, HEART_RATE]);
  const rhr = view.series.find((s) => s.key === '40443-4' && s.statistic === 'average')!;
  const on = (day: string): { value: number; source: string; tier: string; record: string; alternatives: number } => {
    const i = rhr.date.indexOf(day);
    return {
      value: rhr.value[i],
      source: view.sources[rhr.source[i]].name,
      tier: view.tiers[rhr.tier[i]],
      record: rhr.record[i],
      alternatives: rhr.alternatives[i],
    };
  };

  it('"Sleep Watch", a third-party app, loses to the phone despite its name and its sample count', () => {
    expect(on('2026-03-01')).toMatchObject({ value: 60, source: "Jo's iPhone", tier: 'phone', alternatives: 1 });
    expect(view.sources.find((s) => s.name === 'Sleep Watch')?.tier).toBe(view.tiers.indexOf('third-party'));
  });

  it('a renamed Apple Watch source is still a watch, so its device-less reading wins', () => {
    expect(on('2026-03-02')).toMatchObject({ value: 55, source: RENAMED, tier: 'watch' });
    expect(view.sources.find((s) => s.name === RENAMED)?.tier).toBe(view.tiers.indexOf('watch'));
  });

  it('a non-Apple "Watch4,1" is third-party and loses to the phone', () => {
    expect(on('2026-03-03')).toMatchObject({ value: 62, source: "Jo's iPhone", tier: 'phone' });
    const galaxy = view.devices.find((d) => d.hardware === 'Watch4,1')!;
    expect(view.tiers[galaxy.tier]).toBe('third-party');
  });

  it('carries, per day, the zone it was cut in and the record it came from', () => {
    expect(view.zones).toEqual(['America/New_York']);
    expect(on('2026-03-02').record).toBe('urn:uuid:00000000-0000-4000-8000-000000000003');
  });

  it('the summary lists every source, its devices and its days per reading type', () => {
    const renamed = view.sources.find((s) => s.name === RENAMED)!;
    expect(renamed.devices.map((i) => view.devices[i].hardware)).toEqual(['Watch6,1']);
    expect(renamed.readingTypes).toEqual([
      { key: '40443-4', days: 1, first: '2026-03-02', last: '2026-03-02' },
      { key: '8867-4', days: 2, first: '2026-03-02', last: '2026-03-03' },
    ]);
    // Watch first, then phone, then third-party.
    expect(view.sources.map((s) => view.tiers[s.tier])).toEqual(['watch', 'phone', 'third-party', 'third-party']);
  });

  it('does not depend on the order the records were listed in', () => {
    const lines = HEART_RATE.split('\n<').map((l, i) => (i === 0 ? l : `<${l}`));
    const reversed = [lines[0], ...lines.slice(1).reverse()].join('\n');
    expect(dailySeriesBytes(buildFrom([reversed, DEVICES])).equals(dailySeriesBytes(view))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. A derived view: rebuildable, rebuilt, and citing real records
// ---------------------------------------------------------------------------

function sha(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function seriesOf(podDir: string, env: Record<string, string> = {}): NonNullable<QueryPayload['wellnessDailySeries']> {
  return (JSON.parse(cli(['--json', 'pod', 'query', podDir, '--wellness-series'], env)) as QueryPayload).wellnessDailySeries!;
}

describe('the stored daily series is a derived view', () => {
  it('is written at import; deleting it and rebuilding (reconcile) or re-importing gives the same bytes', () => {
    const podDir = importedPod();
    dirs.push(path.dirname(podDir));
    const first = seriesOf(podDir);
    const att = path.join(podDir, first.attachment);
    const desc = path.join(podDir, 'wellness', 'series', 'daily-series.ttl');
    const attSha = sha(att);
    const descSha = sha(desc);

    // The same export again: nothing changed, so nothing is rewritten.
    const report = path.join(path.dirname(podDir), 'r.json');
    cli(['pod', 'import', podDir, FIXTURE, '--report', report]);
    expect((JSON.parse(fs.readFileSync(report, 'utf8')) as { wellnessDailySeries: { status: string } }).wellnessDailySeries.status).toBe('current');
    expect(sha(att)).toBe(attSha);
    expect(sha(desc)).toBe(descSha);

    // Deleted, then rebuilt by reconcile: byte for byte.
    fs.rmSync(att);
    fs.rmSync(desc);
    cli(['pod', 'reconcile', podDir, '--apply']);
    expect(sha(att)).toBe(attSha);
    expect(sha(desc)).toBe(descSha);

    // And by a fresh import into the same pod.
    fs.rmSync(att);
    fs.rmSync(desc);
    cli(['pod', 'import', podDir, FIXTURE]);
    expect(sha(att)).toBe(attSha);
    expect(sha(desc)).toBe(descSha);
  }, 240_000);

  it('every record it cites resolves in the pod', async () => {
    const podDir = importedPod();
    dirs.push(path.dirname(podDir));
    const view = seriesOf(podDir);
    const cited = [...new Set(view.series.flatMap((s) => s.record))];
    expect(cited.length).toBeGreaterThan(10);
    for (const iri of cited) {
      const r = await runCli(['--json', 'pod', 'query', podDir, '--neighbors', iri]);
      expect(r.exitCode, `${iri}: ${r.stderr}`).toBe(0);
      expect((JSON.parse(r.stdout) as { seed: { iri: string } }).seed.iri).toBe(iri);
    }
  }, 240_000);

  it('is rebuilt when a record changes: an erased reading leaves the series, and the old bytes leave the pod', () => {
    const podDir = importedPod();
    dirs.push(path.dirname(podDir));
    const before = seriesOf(podDir);
    const rhr = before.series.find((s) => s.key === '40443-4')!;
    const erased = rhr.record[0];
    cli(['pod', 'erase', podDir, '--record', erased, '--confirm']);
    const after = seriesOf(podDir);
    expect(after.attachment).not.toBe(before.attachment);
    expect(fs.existsSync(path.join(podDir, before.attachment))).toBe(false);
    expect(after.series.flatMap((s) => s.record)).not.toContain(erased);
  }, 240_000);

  it('is sealed on an encrypted pod, and read back through the key', () => {
    const podDir = importedPod(true);
    dirs.push(path.dirname(podDir));
    const view = seriesOf(podDir, { CASCADE_POD_PASSPHRASE: PASSPHRASE });
    expect(view.series.length).toBeGreaterThan(0);
    const onDisk = fs.readFileSync(path.join(podDir, view.attachment));
    expect(onDisk.includes(Buffer.from('cascade-wellness-daily-series'))).toBe(false);
  }, 240_000);

  it('a pod with no wellness records has no series, and says so (null, exit 0)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wellness-read-cost-'));
    dirs.push(root);
    const podDir = path.join(root, 'pod');
    cli(['pod', 'init', podDir]);
    const r = await runCli(['--json', 'pod', 'query', podDir, '--wellness-series']);
    expect(r.exitCode, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as QueryPayload).wellnessDailySeries).toBeNull();
  });

  it('a view whose bytes do not match their digest is unreadable (exit 2), never "none"', async () => {
    const podDir = importedPod();
    dirs.push(path.dirname(podDir));
    const view = seriesOf(podDir);
    fs.appendFileSync(path.join(podDir, view.attachment), ' ');
    const r = await runCli(['--json', 'pod', 'query', podDir, '--wellness-series']);
    expect(r.exitCode).toBe(2);
  }, 180_000);
});
