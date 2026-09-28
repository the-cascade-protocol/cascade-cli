/**
 * The stored daily wellness series, second round: it must never be served as
 * current when it is not, and a source's own versions of a day are settled by
 * the most recent import.
 *
 *   1. FRESHNESS ON READ. The view records a digest of every file it was built
 *      from. A writer that does not rebuild it (an older release, another tool,
 *      an import stopped between its writes and the rebuild) used to leave it
 *      serving an erased record's value as current, exit 0. The read now hashes
 *      the inputs and says `stale: true`, with the reasons.
 *   2. RULE VERSION 2: MOST RECENT IMPORT WINS WITHIN A SOURCE. D-WELLNESS-1's
 *      amendment of 2026-09-25 (item 4) makes "most recent import" a rule of the
 *      view. Version 1 kept the aggregate with more samples, so a re-import after
 *      a sample was deleted kept the pre-deletion aggregate, and counted the
 *      source's own older version as a competing "alternative". Imports are
 *      dated by the export's own ExportDate, never by a clock.
 *   3. Smaller things: a type both asked for and excluded is named as a
 *      contradiction; --neighbors refuses --wellness-series; one `pod erase` of
 *      several records rebuilds the view once.
 *
 * Every fixture is synthetic: invented values and names, no real export.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Parser, type Quad } from 'n3';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { PodReader } from '../src/lib/pod-read.js';
import { mergeIntoBucket } from '../src/lib/bucket-write.js';
import { DailySeriesBuilder, type DailySeriesView } from '../src/lib/apple-health-wellness/daily-series.js';

const CLI = path.resolve(__dirname, '../dist/index.js');
const FIXTURE = path.resolve(__dirname, '../test-fixtures/apple-health-wellness');

function cli(args: string[]): string {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf-8', timeout: 180_000 });
}

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

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wellness-series-v2-'));
  dirs.push(d);
  return d;
}

function newPod(): string {
  const podDir = path.join(tmp(), 'pod');
  cli(['pod', 'init', podDir]);
  return podDir;
}

type Series = DailySeriesView & { attachment: string; generatedBy: string; stale: boolean; staleReasons: string[] };

async function readSeries(podDir: string): Promise<{ series: Series; stderr: string; exitCode: number }> {
  const r = await runCli(['--json', 'pod', 'query', podDir, '--wellness-series']);
  return { series: (JSON.parse(r.stdout) as { wellnessDailySeries: Series }).wellnessDailySeries, stderr: r.stderr, exitCode: r.exitCode };
}

function quadsOf(file: string): Quad[] {
  return new Parser({ baseIRI: 'https://pod.invalid/x' }).parse(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// 1. Freshness on read
// ---------------------------------------------------------------------------

describe('a stored series the records no longer match is returned as stale, never as current', () => {
  it('a writer that skips the rebuild erases the record that won a day: the read says stale, and reconcile rebuilds it', async () => {
    const podDir = newPod();
    cli(['pod', 'import', podDir, FIXTURE]);
    const before = (await readSeries(podDir)).series;
    expect(before.stale).toBe(false);
    const rhr = before.series.find((s) => s.key === '40443-4')!;
    const winner = rhr.record[0];

    // What an older release's `pod erase` does: the bucket write, and no rebuild.
    const file = path.join(podDir, 'wellness', 'heart-rate.ttl');
    await mergeIntoBucket(podDir, file, [], undefined, {
      combine: (existing) => existing.filter((q) => q.subject.value !== winner),
    });

    const read = await readSeries(podDir);
    expect(read.exitCode).toBe(0);
    expect(read.series.stale).toBe(true);
    expect(read.series.staleReasons.join(' ')).toContain('wellness/heart-rate.ttl');
    expect(read.stderr).toContain('STALE');

    cli(['pod', 'reconcile', podDir, '--apply']);
    const after = (await readSeries(podDir)).series;
    expect(after.stale).toBe(false);
    expect(after.series.flatMap((s) => s.record)).not.toContain(winner);
  }, 180_000);

  it('a view stamped by an older rule version is stale on read and rebuilt through its stamp', async () => {
    const podDir = newPod();
    cli(['pod', 'import', podDir, FIXTURE]);
    const desc = path.join(podDir, 'wellness', 'series', 'daily-series.ttl');
    fs.writeFileSync(desc, fs.readFileSync(desc, 'utf8').replace('"wellness-daily-series/2"', '"wellness-daily-series/1"'));
    const read = await readSeries(podDir);
    expect(read.series.stale).toBe(true);
    expect(read.series.staleReasons.join(' ')).toContain('wellness-daily-series/1');
    const report = JSON.parse(cli(['--json', 'pod', 'reconcile', podDir, '--apply'])) as { wellnessDailySeries: { status: string } };
    expect(report.wellnessDailySeries.status).toBe('built');
    expect((await readSeries(podDir)).series.stale).toBe(false);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 2. Rule version 2: the most recent import wins within a source
// ---------------------------------------------------------------------------

/** The fixture as a later export would give it: a later ExportDate, one heart-rate sample deleted. */
function laterExportWithADeletedSample(): string {
  const dir = path.join(tmp(), 'later-export');
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const xml = path.join(dir, 'export.xml');
  const lines = fs.readFileSync(xml, 'utf8').split('\n');
  const i = lines.findIndex(
    (l) => l.includes('type="HKQuantityTypeIdentifierHeartRate"') && l.includes('startDate="2026-03-08 11:00:00 -0700"') && l.includes('Apple Watch'),
  );
  expect(i).toBeGreaterThan(0);
  lines.splice(i, 1);
  const text = lines.join('\n').replace('<ExportDate value="2026-03-10 09:00:00 -0700"/>', '<ExportDate value="2026-03-11 09:00:00 -0700"/>');
  expect(text).toContain('2026-03-11 09:00:00');
  fs.writeFileSync(xml, text);
  return dir;
}

const H = 'https://ns.cascadeprotocol.org/health/v1#';
const C = 'https://ns.cascadeprotocol.org/core/v1#';

/** The pod's 8867-4 average records for a local day's UTC start, with their source, device and sample count. */
function heartRateAverages(podDir: string, periodStart: string): Array<{ iri: string; source: string; device: string; samples: number }> {
  const quads = quadsOf(path.join(podDir, 'wellness', 'heart-rate.ttl'));
  const by = new Map<string, Map<string, string>>();
  for (const q of quads) {
    let m = by.get(q.subject.value);
    if (!m) by.set(q.subject.value, (m = new Map()));
    m.set(q.predicate.value, q.object.value);
  }
  return [...by.entries()]
    .filter(([, m]) => m.get(C + 'loincCode')?.endsWith('8867-4') && m.get(C + 'statistic') === 'average' && m.get(H + 'periodStart') === periodStart)
    .map(([iri, m]) => ({ iri, source: m.get(C + 'sourceDeviceName')!, device: m.get(H + 'device') ?? '', samples: Number(m.get(C + 'sampleCount')) }));
}

describe('rule version 2: within one source, the most recent import wins', () => {
  for (const order of ['older export first', 'newer export first'] as const) {
    it(`a re-import after a deleted sample shows the newer aggregate (${order}), and the older one is no alternative`, async () => {
      const podDir = newPod();
      const later = laterExportWithADeletedSample();
      const imports = order === 'older export first' ? [FIXTURE, later] : [later, FIXTURE];
      for (const e of imports) cli(['pod', 'import', podDir, e]);

      const { series } = await readSeries(podDir);
      expect(series.generatedBy).toBe('wellness-daily-series/2');
      const avg = series.series.find((s) => s.key === '8867-4' && s.statistic === 'average')!;
      const day = avg.date.indexOf('2026-03-08');
      expect(day).toBeGreaterThanOrEqual(0);

      // Two versions of the watch's day are in the pod; the newer export holds one sample fewer.
      const periodStart = heartRateAverages(podDir, '2026-03-08T08:00:00Z').length > 0 ? '2026-03-08T08:00:00Z' : '2026-03-08T07:00:00Z';
      const candidates = heartRateAverages(podDir, periodStart);
      const watch = candidates.filter((c) => c.source.includes('Apple Watch'));
      expect(watch.length).toBe(2);
      const newer = watch.reduce((a, b) => (a.samples < b.samples ? a : b));
      expect(avg.record[day]).toBe(newer.iri);

      // Alternatives count other SOURCES, not the watch's own older version.
      const sources = new Set(candidates.map((c) => `${c.source}\u0000${c.device}`));
      expect(avg.alternatives[day]).toBe(sources.size - 1);
    }, 240_000);
  }

  // The same rule on synthetic triples, including a source no dated export reaches.
  const TTL = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix loinc: <http://loinc.org/rdf#> .
<urn:x:dev> a health:Device ; health:deviceName "Apple Watch" ; health:hardwareVersion "Watch6,1" ; health:deviceManufacturer "Apple Inc." .
`;
  const rec = (id: string, samples: number, group: string, value: number): string => `
<urn:x:${id}> a health:DailyVitalReading ; cascade:loincCode loinc:40443-4 ; health:value "${value}"^^xsd:double ; health:unit "bpm" ;
  health:periodStart "2026-03-02T05:00:00Z"^^xsd:dateTime ; health:timeZone "America/New_York" ; cascade:statistic "average" ;
  cascade:sampleCount "${samples}"^^xsd:integer ; cascade:sourceDeviceName "Watch" ; health:device <urn:x:dev> ; prov:wasDerivedFrom <urn:x:${group}> .`;
  const exp = (id: string, when: string, pack: string): string =>
    `\n<urn:x:${id}> a prov:Entity ; prov:generatedAtTime "${when}"^^xsd:dateTime ; dct:hasPart <urn:x:${pack}> .`;
  const pack = (id: string, group: string): string => `\n<urn:x:${id}> a cascade:Attachment ; dct:hasPart <urn:x:${group}> .`;
  const build = (ttl: string): DailySeriesView => {
    const b = new DailySeriesBuilder();
    b.addQuads(new Parser({ baseIRI: 'https://pod.invalid/x' }).parse(ttl));
    return b.finish({ dayZone: 'America/New_York', inputs: [] });
  };
  const chosen = (v: DailySeriesView): { record: string; alternatives: number } => {
    const s = v.series.find((x) => x.key === '40443-4')!;
    return { record: s.record[0], alternatives: s.alternatives[0] };
  };

  it('the aggregate the newest export reaches wins, whatever its sample count', () => {
    const base = TTL + rec('old', 10, 'g1', 60) + rec('new', 9, 'g2', 61) + pack('p1', 'g1') + pack('p2', 'g2');
    expect(chosen(build(base + exp('e1', '2026-06-01T00:00:00Z', 'p1') + exp('e2', '2026-09-01T00:00:00Z', 'p2')))).toEqual({ record: 'urn:x:new', alternatives: 0 });
    expect(chosen(build(base + exp('e1', '2026-09-01T00:00:00Z', 'p1') + exp('e2', '2026-06-01T00:00:00Z', 'p2')))).toEqual({ record: 'urn:x:old', alternatives: 0 });
    // A dated version outranks one no dated export reaches (a pod imported before exports were recorded).
    expect(chosen(build(base + exp('e2', '2026-06-01T00:00:00Z', 'p2'))).record).toBe('urn:x:new');
    // Neither dated: more samples, as before.
    expect(chosen(build(base)).record).toBe('urn:x:old');
  });
});

// ---------------------------------------------------------------------------
// 3. Smaller fixes
// ---------------------------------------------------------------------------

describe('query flag combinations, and erase rebuilding once', () => {
  it('names a type both asked for and excluded, and refuses --neighbors with --wellness-series', async () => {
    const podDir = newPod();
    cli(['pod', 'import', podDir, FIXTURE]);
    const both = await runCli(['--json', 'pod', 'query', podDir, '--conditions', '--exclude-data-type', 'conditions']);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain('Asked for and excluded in the same call: conditions');
    expect(both.stderr).not.toContain('No query filter specified');

    const seed = (await readSeries(podDir)).series.series[0].record[0];
    const nb = await runCli(['--json', 'pod', 'query', podDir, '--neighbors', seed, '--wellness-series']);
    expect(nb.exitCode).toBe(1);
    expect(nb.stderr).toContain('--wellness-series cannot be combined with --neighbors');
  }, 180_000);

  it('one `pod erase` of several wellness records rebuilds the series once, and none of them survives in it', async () => {
    const podDir = newPod();
    cli(['pod', 'import', podDir, FIXTURE]);
    const { series } = await readSeries(podDir);
    const erased = [series.series.find((s) => s.key === '40443-4')!.record[0], series.series.find((s) => s.key === 'steps')!.record[0]];

    let streamed = 0;
    const original = PodReader.prototype.streamFile;
    const spy = vi.spyOn(PodReader.prototype, 'streamFile').mockImplementation(function (this: PodReader, abs, onQuad, opts) {
      streamed++;
      return original.call(this, abs, onQuad, opts);
    });
    let r: Awaited<ReturnType<typeof runCli>>;
    try {
      r = await runCli(['--json', 'pod', 'erase', podDir, '--confirm', '--record', erased[0], '--record', erased[1]]);
    } finally {
      spy.mockRestore();
    }
    expect(r.exitCode, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { erased: boolean; records: Array<{ recordUri: string }> };
    expect(out.erased).toBe(true);
    expect(out.records.map((x) => x.recordUri)).toEqual(erased);
    // One rebuild streams each input file once: seven files, not fourteen.
    expect(streamed).toBe(series.inputs.length);

    const after = await readSeries(podDir);
    expect(after.series.stale).toBe(false);
    for (const iri of erased) expect(after.series.series.flatMap((s) => s.record)).not.toContain(iri);
  }, 180_000);

  it('a single --record keeps the single-record output', async () => {
    const podDir = newPod();
    cli(['pod', 'import', podDir, FIXTURE]);
    const iri = (await readSeries(podDir)).series.series[0].record[0];
    const r = await runCli(['--json', 'pod', 'erase', podDir, '--confirm', '--record', iri]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(Object.keys(JSON.parse(r.stdout) as object).sort()).toEqual(['action', 'erased', 'recordUri', 'tombstoneUri']);
  }, 180_000);
});
