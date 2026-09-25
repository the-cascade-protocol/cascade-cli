/**
 * `cascade pod import <Apple Health export folder>` end to end, against the
 * built CLI: export.xml becomes wellness records, retained samples, devices and
 * a day zone; the output validates; the same export imported twice leaves every
 * file byte-identical; and the verbs that re-file records leave them in place.
 *
 * The fixture (test-fixtures/apple-health-wellness) is synthetic: invented
 * values, no real export.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Parser, type Quad } from 'n3';

const CLI = path.resolve(__dirname, '../dist/index.js');
const FIXTURE = path.resolve(__dirname, '../test-fixtures/apple-health-wellness');
const PASSPHRASE = 'wellness-import-test-passphrase';

function cli(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    timeout: 180_000,
    env: { ...process.env, ...env },
  });
}

function newPod(encrypt = false): string {
  const podDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wellness-import-')), 'pod');
  cli(['pod', 'init', podDir, ...(encrypt ? ['--encrypt'] : [])], encrypt ? { CASCADE_POD_PASSPHRASE: PASSPHRASE } : {});
  return podDir;
}

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(dir, p), createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

function quadsOf(file: string): Quad[] {
  return new Parser({ format: 'Turtle', baseIRI: 'https://pod.invalid/x' }).parse(fs.readFileSync(file, 'utf8'));
}

const H = 'https://ns.cascadeprotocol.org/health/v1#';
const C = 'https://ns.cascadeprotocol.org/core/v1#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PROV = 'http://www.w3.org/ns/prov#';

interface Report {
  wellness?: Array<{ dayZone: { zone: string; rule: string; written: boolean }; closedDays: number; correlationRecordsSkipped: number }>;
}

describe('pod import of an Apple Health export folder: wellness', () => {
  let podDir: string;
  let first: Map<string, string>;
  let report: Report;

  beforeAll(() => {
    podDir = newPod();
    const reportPath = path.join(path.dirname(podDir), 'report.json');
    cli(['pod', 'import', podDir, FIXTURE, '--report', reportPath]);
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Report;
    first = snapshot(podDir);
  }, 180_000);

  it('files each record where pod-structure.md section 4.2 puts it', () => {
    const count = (rel: string, cls: string): number =>
      quadsOf(path.join(podDir, rel)).filter((q) => q.predicate.value === RDF_TYPE && q.object.value === H + cls).length;
    expect(count('wellness/heart-rate.ttl', 'DailyVitalReading')).toBe(13);
    expect(count('wellness/hrv.ttl', 'DailyVitalReading')).toBe(1);
    expect(count('wellness/body-measurements.ttl', 'DailyVitalReading')).toBe(3);
    expect(count('wellness/activity.ttl', 'DailyVitalReading')).toBe(1);
    expect(count('wellness/activity.ttl', 'DailyActivitySnapshot')).toBe(6);
    expect(count('wellness/activity.ttl', 'Workout')).toBe(2);
    expect(count('wellness/devices.ttl', 'Device')).toBe(2);
    // The clinical half of the export is imported as before.
    expect(fs.existsSync(path.join(podDir, 'clinical', 'conditions.ttl'))).toBe(true);
    expect(fs.existsSync(path.join(podDir, 'clinical', 'fhir-passthrough.ttl'))).toBe(false);
  });

  it('records the day zone it used, and the rule that chose it', () => {
    expect(report.wellness?.[0].dayZone).toEqual({ zone: 'America/Los_Angeles', rule: 'HKTimeZone majority', written: true });
    const ext = quadsOf(path.join(podDir, 'profile', 'extended.ttl'));
    expect(ext.filter((q) => q.predicate.value === C + 'dayZone').map((q) => q.object.value)).toEqual(['America/Los_Angeles']);
    expect(report.wellness?.[0].correlationRecordsSkipped).toBe(2);
  });

  it('retains the samples before deriving from them: every aggregate points at a stored, content-addressed sample file', () => {
    const descriptors = quadsOf(path.join(podDir, 'wellness', 'samples', 'samples.ttl'));
    const attachmentPath = new Map(
      descriptors.filter((q) => q.predicate.value === C + 'attachmentPath').map((q) => [q.subject.value, q.object.value]),
    );
    const activities = new Set(
      descriptors.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === PROV + 'Activity').map((q) => q.subject.value),
    );
    expect(activities.size).toBe(1);
    let aggregates = 0;
    for (const rel of ['heart-rate.ttl', 'hrv.ttl', 'body-measurements.ttl', 'activity.ttl']) {
      const qs = quadsOf(path.join(podDir, 'wellness', rel));
      for (const q of qs.filter((x) => x.predicate.value === PROV + 'wasDerivedFrom')) {
        aggregates++;
        const p = attachmentPath.get(q.object.value);
        expect(p, q.subject.value).toBeDefined();
        const bytes = fs.readFileSync(path.join(podDir, p!));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(path.basename(p!));
        const generatedBy = qs.find((x) => x.subject.value === q.subject.value && x.predicate.value === PROV + 'wasGeneratedBy');
        expect(activities.has(generatedBy!.object.value)).toBe(true);
      }
    }
    expect(aggregates).toBe(21);
  });

  it('validates with zero violations and zero warnings', () => {
    const out = JSON.parse(cli(['validate', podDir, '--json'])) as Array<{ file: string; valid: boolean; results: unknown[] }>;
    const wellnessFiles = out.filter((r) => r.file.includes(`${path.sep}wellness${path.sep}`));
    expect(wellnessFiles.length).toBe(6);
    for (const r of out) {
      expect(r.valid, r.file).toBe(true);
      expect(r.results, r.file).toEqual([]);
    }
  });

  it('importing the same export again leaves every file byte-identical', () => {
    cli(['pod', 'import', podDir, FIXTURE]);
    expect(snapshot(podDir)).toEqual(first);
  }, 180_000);

  it('pod reconcile --apply rewrites the wellness files in place, unchanged', () => {
    const wellness = (m: Map<string, string>): string[] =>
      [...m.entries()].filter(([k]) => k.startsWith('wellness')).map(([k, v]) => `${k} ${v}`).sort();
    cli(['pod', 'reconcile', podDir, '--apply']);
    const after = snapshot(podDir);
    expect(wellness(after)).toEqual(wellness(first));
    expect([...after.keys()].some((k) => k.endsWith('fhir-passthrough.ttl'))).toBe(false);
  }, 180_000);

  it('--dry-run writes nothing', () => {
    const fresh = newPod();
    const before = snapshot(fresh);
    cli(['pod', 'import', fresh, FIXTURE, '--dry-run']);
    expect(snapshot(fresh)).toEqual(before);
  }, 180_000);
});

describe('pod import of an Apple Health export into an ENCRYPTED pod', () => {
  it('seals the retained samples and the records, and the pod still validates', () => {
    const podDir = newPod(true);
    cli(['pod', 'import', podDir, FIXTURE], { CASCADE_POD_PASSPHRASE: PASSPHRASE });
    const dir = path.join(podDir, 'attachments', 'sha-256');
    const names = fs.readdirSync(dir);
    expect(names.length).toBe(3);
    for (const n of names) {
      // The name is the digest of the PLAINTEXT; the bytes on disk are sealed.
      expect(fs.readFileSync(path.join(dir, n)).toString('utf8')).not.toContain('cascade-wellness-samples');
    }
    expect(fs.readFileSync(path.join(podDir, 'wellness', 'heart-rate.ttl')).toString('utf8')).not.toContain('DailyVitalReading');
    const out = JSON.parse(cli(['validate', podDir, '--json'], { CASCADE_POD_PASSPHRASE: PASSPHRASE })) as Array<{
      valid: boolean;
      results: unknown[];
    }>;
    expect(out.every((r) => r.valid && r.results.length === 0)).toBe(true);
  }, 180_000);
});
