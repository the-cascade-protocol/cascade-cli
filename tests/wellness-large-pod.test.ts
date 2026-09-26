/**
 * A pod holding a real-sized wellness bucket still imports and reconciles.
 *
 * One year of daily wellness aggregates puts hundreds of thousands of quads in
 * `wellness/heart-rate.ttl`. Two things went wrong with that the first time a
 * real export was imported:
 *
 *   1. `pod import` (even of one clinical file) and `pod reconcile` loaded every
 *      wellness bucket into the reconciler, whose `allInputQuads.push(...all)`
 *      passed each quad as a call argument and threw `RangeError: Maximum call
 *      stack size exceeded`. Every spread push in src/ is now a loop
 *      (tests/no-spread-push.test.ts keeps it that way).
 *   2. The reconciler has no matcher for wellness records, so loading them only
 *      cost time and put files that must not change up for rewrite. Wellness
 *      buckets are now kept out of the reconciler's reads, and a write that
 *      routes a record into one is additive.
 *
 * The bucket here is generated: invented values, no real export.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CLI = path.resolve(__dirname, '../dist/index.js');
const RECONCILER = pathToFileURL(path.resolve(__dirname, '../dist/lib/reconciler.js')).href;
const CLINICAL = path.resolve(__dirname, '../test-fixtures/apple-health-wellness/clinical-records');

/** Quads per generated record, and records, so the bucket holds more than 200,000 quads. */
const QUADS_PER_RECORD = 14;
const RECORDS = 16_000;

function cli(args: string[]): string {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf-8', timeout: 300_000, maxBuffer: 256 * 1024 * 1024 });
}

/** A heart-rate bucket of synthetic daily readings, in the shape the wellness import writes. */
function syntheticHeartRateBucket(records: number): string {
  const lines = [
    '@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .',
    '@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .',
    '@prefix prov: <http://www.w3.org/ns/prov#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
  ];
  const day0 = Date.UTC(2020, 0, 1);
  for (let i = 0; i < records; i++) {
    const start = new Date(day0 + Math.floor(i / 4) * 86_400_000).toISOString();
    const end = new Date(day0 + (Math.floor(i / 4) + 1) * 86_400_000).toISOString();
    const hex = i.toString(16).padStart(12, '0');
    lines.push(
      `<urn:uuid:00000000-0000-4000-8000-${hex}> a health:DailyVitalReading ;`,
      '  cascade:loincCode <http://loinc.org/rdf#8867-4> ;',
      `  health:value "${60 + (i % 40)}"^^xsd:double ;`,
      '  health:unit "count/min" ;',
      `  cascade:date "${start}"^^xsd:dateTime ;`,
      `  health:periodStart "${start}"^^xsd:dateTime ;`,
      `  health:periodEnd "${end}"^^xsd:dateTime ;`,
      '  health:timeZone "UTC" ;',
      `  cascade:statistic "${['minimum', 'average', 'maximum', 'sum'][i % 4]}" ;`,
      `  cascade:sampleCount "${1 + (i % 500)}"^^xsd:integer ;`,
      '  cascade:sourceDeviceName "Synthetic Watch" ;',
      '  cascade:sourceType "healthKit" ;',
      '  cascade:dataProvenance cascade:ConsumerWellness ;',
      `  prov:wasDerivedFrom <urn:uuid:10000000-0000-4000-8000-${hex}> .`,
    );
  }
  return lines.join('\n') + '\n';
}

function digest(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function wellnessDigests(podDir: string): Record<string, string> {
  const dir = path.join(podDir, 'wellness');
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) out[f] = digest(p);
  }
  return out;
}

describe('the reconciler takes an input of more than 200,000 quads', () => {
  // In a CHILD process on the built reconciler, not in the test runner: a
  // runner worker can have a larger stack than the CLI's main thread, and a
  // spread push that fits there overflows in the CLI.
  it('reconciles without overflowing the call stack', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-large-'));
    fs.writeFileSync(path.join(dir, 'big.ttl'), syntheticHeartRateBucket(RECORDS));
    fs.writeFileSync(path.join(dir, 'small.ttl'), syntheticHeartRateBucket(2));
    const script = `
      import fs from 'node:fs';
      import { runReconciliation } from ${JSON.stringify(RECONCILER)};
      const read = (f) => fs.readFileSync(${JSON.stringify(dir)} + '/' + f, 'utf8');
      const r = await runReconciliation([
        { content: read('big.ttl'), systemName: 'big', labelIsPlaceholder: true },
        { content: read('small.ttl'), systemName: 'small', labelIsPlaceholder: true },
      ]);
      process.stdout.write(String(r.turtle.length > 0));
    `;
    const out = execFileSync('node', ['--input-type=module', '-e', script], {
      encoding: 'utf-8',
      timeout: 300_000,
    });
    expect(out).toBe('true');
    fs.rmSync(dir, { recursive: true, force: true });
  }, 300_000);
});

describe('a pod holding a wellness bucket of more than 200,000 quads', () => {
  let podDir: string;
  let before: Record<string, string>;

  beforeAll(() => {
    podDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wellness-large-')), 'pod');
    cli(['pod', 'init', podDir]);
    // A clinical record already in the pod, so the next import has something
    // to reconcile against and takes the cross-batch path.
    cli(['pod', 'import', podDir, path.join(CLINICAL, 'Condition-cond-1.json')]);
    fs.writeFileSync(path.join(podDir, 'wellness', 'heart-rate.ttl'), syntheticHeartRateBucket(RECORDS));
    before = wellnessDigests(podDir);
  }, 300_000);

  it('holds the bucket this test means it to', () => {
    const text = fs.readFileSync(path.join(podDir, 'wellness', 'heart-rate.ttl'), 'utf8');
    // Every record line but the subject's ends in ";", the last in ".".
    const statements = (text.match(/ ;\n/g) ?? []).length + (text.match(/ \.\n/g) ?? []).length - 4;
    expect(statements).toBe(RECORDS * QUADS_PER_RECORD);
    expect(RECORDS * QUADS_PER_RECORD).toBeGreaterThan(200_000);
  });

  it('a one-file clinical import succeeds and leaves every wellness file byte-identical', () => {
    const reportPath = path.join(path.dirname(podDir), 'import.json');
    cli(['pod', 'import', podDir, path.join(CLINICAL, 'Observation-obs-1.json'), '--report', reportPath]);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as { filesWritten: Array<{ path: string }> };
    expect(report.filesWritten.some((f) => f.path.includes(`${path.sep}clinical${path.sep}`))).toBe(true);
    expect(report.filesWritten.some((f) => f.path.includes(`${path.sep}wellness${path.sep}`))).toBe(false);
    expect(wellnessDigests(podDir)).toEqual(before);
  }, 300_000);

  it('pod reconcile --apply succeeds, reads no wellness bucket, and leaves every wellness file byte-identical', () => {
    const out = JSON.parse(cli(['pod', 'reconcile', podDir, '--apply', '--json'])) as {
      filesRead: string[];
      filesWritten: string[];
    };
    expect(out.filesRead.length).toBeGreaterThan(0);
    expect(out.filesRead.filter((f) => f.startsWith('wellness/'))).toEqual([]);
    expect(out.filesWritten.filter((f) => f.startsWith('wellness/'))).toEqual([]);
    expect(wellnessDigests(podDir)).toEqual(before);
  }, 300_000);
});
