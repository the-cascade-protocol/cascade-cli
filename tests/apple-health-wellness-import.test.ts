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
import { wellnessSourceRecordSeed } from '../src/lib/identity.js';
import { deterministicUuid } from '../src/lib/fhir-converter/types.js';

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
const DCT = 'http://purl.org/dc/terms/';

interface Report {
  wellness?: Array<{
    dayZone: { zone: string; rule: string; written: boolean };
    podIdentifierMinted: boolean;
    closedDays: number;
    correlationRecordsSkipped: number;
  }>;
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
    // Per-device active energy is a snapshot beside basal energy, never a reading coded 41981-2.
    expect(count('wellness/activity.ttl', 'DailyVitalReading')).toBe(0);
    expect(count('wellness/activity.ttl', 'DailyActivitySnapshot')).toBe(8);
    expect(count('wellness/body-measurements.ttl', 'VitalSignReading')).toBe(1);
    expect(count('wellness/blood-pressure.ttl', 'BloodPressureReading')).toBe(1);
    expect(count('wellness/sleep.ttl', 'SleepSession')).toBe(2);
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
    // The daily aggregation rule, and the sleep grouping rule.
    expect(activities.size).toBe(2);
    // group -> the pack that lists it, and the group's sample digest
    const packOfGroup = new Map(
      descriptors.filter((q) => q.predicate.value === DCT + 'hasPart').map((q) => [q.object.value, q.subject.value]),
    );
    const digestOfGroup = new Map(
      descriptors.filter((q) => q.predicate.value === DCT + 'identifier').map((q) => [q.subject.value, q.object.value]),
    );
    let aggregates = 0;
    for (const rel of ['heart-rate.ttl', 'hrv.ttl', 'body-measurements.ttl', 'activity.ttl', 'sleep.ttl']) {
      const qs = quadsOf(path.join(podDir, 'wellness', rel));
      for (const q of qs.filter((x) => x.predicate.value === PROV + 'wasDerivedFrom')) {
        aggregates++;
        const pack = packOfGroup.get(q.object.value);
        expect(pack, q.subject.value).toBeDefined();
        const p = attachmentPath.get(pack!);
        expect(p, q.subject.value).toBeDefined();
        const bytes = fs.readFileSync(path.join(podDir, p!));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(path.basename(p!));
        const doc = JSON.parse(bytes.toString('utf8')) as { groups: Array<{ sampleDigest: string }> };
        expect(doc.groups.map((g) => g.sampleDigest)).toContain(digestOfGroup.get(q.object.value));
        const generatedBy = qs.find((x) => x.subject.value === q.subject.value && x.predicate.value === PROV + 'wasGeneratedBy');
        expect(activities.has(generatedBy!.object.value)).toBe(true);
      }
    }
    // 21 daily aggregates, the basal energy snapshot, and two sleep sessions.
    expect(aggregates).toBe(24);
  });

  it('registers every class each wellness file holds in the private type index, and lists each file in index.ttl', () => {
    const base = 'https://pod.invalid/';
    const parse = (rel: string): Quad[] =>
      new Parser({ format: 'Turtle', baseIRI: base + rel }).parse(fs.readFileSync(path.join(podDir, rel), 'utf8'));
    const SOLID = 'http://www.w3.org/ns/solid/terms#';
    // A type-index lookup: the instances registered for a class.
    const index = parse('settings/privateTypeIndex.ttl');
    const lookup = (cls: string): string[] => {
      const regs = index.filter((q) => q.predicate.value === SOLID + 'forClass' && q.object.value === cls).map((q) => q.subject.value);
      return index.filter((q) => q.predicate.value === SOLID + 'instance' && regs.includes(q.subject.value)).map((q) => q.object.value);
    };
    const contained = new Set(
      parse('index.ttl').filter((q) => q.predicate.value === 'http://www.w3.org/ns/ldp#contains').map((q) => q.object.value),
    );
    const held: Array<[string, string]> = [];
    for (const f of ['heart-rate.ttl', 'hrv.ttl', 'body-measurements.ttl', 'activity.ttl', 'devices.ttl', 'blood-pressure.ttl', 'sleep.ttl']) {
      const rel = `wellness/${f}`;
      expect(contained.has(base + rel), rel).toBe(true);
      const classes = new Set(parse(rel).filter((q) => q.predicate.value === RDF_TYPE).map((q) => q.object.value));
      for (const c of classes) held.push([c, rel]);
    }
    // Every class the files hold, including the four the brief names.
    expect(new Set(held.map(([c]) => c))).toEqual(
      new Set([
        H + 'DailyVitalReading',
        H + 'DailyActivitySnapshot',
        H + 'Workout',
        H + 'Device',
        H + 'VitalSignReading',
        H + 'BloodPressureReading',
        H + 'SleepSession',
      ]),
    );
    for (const [cls, rel] of held) expect(lookup(cls), `${cls} -> ${rel}`).toContain(base + rel);
  });

  it('validates with zero violations and zero warnings', () => {
    const out = JSON.parse(cli(['validate', podDir, '--json'])) as Array<{ file: string; valid: boolean; results: unknown[] }>;
    const wellnessFiles = out.filter((r) => r.file.includes(`${path.sep}wellness${path.sep}`));
    expect(wellnessFiles.length).toBe(8);
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

// ---------------------------------------------------------------------------
// The pod subject: the pod's own identifier
// ---------------------------------------------------------------------------

const WELLNESS_FILES = [
  'wellness/heart-rate.ttl',
  'wellness/hrv.ttl',
  'wellness/body-measurements.ttl',
  'wellness/activity.ttl',
  'wellness/devices.ttl',
  'wellness/samples/samples.ttl',
];
const POD_ID = C + 'podIdentifier';

/** The pod's identifier as extended.ttl states it (plaintext pods only). */
function podIdentifierOf(podDir: string): string[] {
  const text = fs.readFileSync(path.join(podDir, 'profile', 'extended.ttl'), 'utf8');
  return new Parser({ format: 'Turtle', baseIRI: 'https://pod.invalid/profile/extended.ttl' })
    .parse(text)
    .filter((q) => q.predicate.value === POD_ID)
    .map((q) => q.object.value);
}

/** Every named subject the wellness files hold, grouped by what kind of record it is. */
function namesByKind(podDir: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (kind: string, iri: string): void => {
    let set = out.get(kind);
    if (!set) out.set(kind, (set = new Set()));
    set.add(iri);
  };
  for (const rel of WELLNESS_FILES) {
    const qs = quadsOf(path.join(podDir, rel));
    const typeOf = new Map<string, string[]>();
    for (const q of qs) {
      if (q.subject.termType !== 'NamedNode') continue;
      if (!typeOf.has(q.subject.value)) typeOf.set(q.subject.value, []);
      if (q.predicate.value === RDF_TYPE) typeOf.get(q.subject.value)!.push(q.object.value);
    }
    const derived = new Set(qs.filter((q) => q.predicate.value === PROV + 'wasDerivedFrom').map((q) => q.subject.value));
    for (const [iri, types] of typeOf) {
      if (types.includes(H + 'Workout')) add('workout', iri);
      else if (types.includes(H + 'Device')) add('device', iri);
      else if (derived.has(iri)) add('aggregate', iri);
      // Apple's own day rollup: a snapshot no aggregate rule derived.
      else if (types.includes(H + 'DailyActivitySnapshot')) add('activity summary', iri);
      else if (rel.endsWith('samples.ttl') && types.includes(PROV + 'Activity')) add('rule activity', iri);
      else if (rel.endsWith('samples.ttl') && types.includes(PROV + 'Entity')) add('sample group', iri);
      else add(`other ${rel}`, iri);
    }
  }
  return out;
}

describe('the pod subject in every wellness name is the pod identifier', () => {
  it('the same export into two pods gives disjoint names for every seeded record', () => {
    const a = newPod();
    const b = newPod();
    cli(['pod', 'import', a, FIXTURE]);
    cli(['pod', 'import', b, FIXTURE]);
    expect(podIdentifierOf(a)).toHaveLength(1);
    expect(podIdentifierOf(b)).toHaveLength(1);
    expect(podIdentifierOf(a)[0]).not.toBe(podIdentifierOf(b)[0]);

    const na = namesByKind(a);
    const nb = namesByKind(b);
    // Every kind the brief names is present, in both pods, in the same numbers.
    for (const kind of ['workout', 'activity summary', 'device', 'sample group', 'aggregate']) {
      expect(na.get(kind)?.size ?? 0, kind).toBeGreaterThan(0);
      expect(nb.get(kind)?.size, kind).toBe(na.get(kind)!.size);
    }
    const all = (m: Map<string, Set<string>>): string[] => [...m.values()].flatMap((s) => [...s]);
    const shared = all(na).filter((iri) => new Set(all(nb)).has(iri));
    expect(all(na).length).toBeGreaterThan(20);
    expect(shared).toEqual([]);
    // The identifier itself never appears in a record file or on the card.
    for (const pod of [a, b]) {
      const id = podIdentifierOf(pod)[0];
      for (const rel of [...WELLNESS_FILES, 'profile/card.ttl']) {
        expect(fs.readFileSync(path.join(pod, rel), 'utf8'), rel).not.toContain(id);
      }
    }
  }, 180_000);

  it('a pod created without an identifier gets one before its first wellness record, and the names use it', () => {
    const podDir = newPod();
    // Turn the pod into one created before the identifier existed.
    const extPath = path.join(podDir, 'profile', 'extended.ttl');
    const text = fs.readFileSync(extPath, 'utf8');
    const legacy = text.slice(0, text.indexOf("\n# The pod's identifier"));
    fs.writeFileSync(extPath, legacy);
    expect(podIdentifierOf(podDir)).toEqual([]);

    // A dry run writes nothing, not even the identifier.
    const dryBefore = snapshot(podDir);
    cli(['pod', 'import', podDir, FIXTURE, '--dry-run']);
    expect(snapshot(podDir)).toEqual(dryBefore);

    const reportPath = path.join(path.dirname(podDir), 'report-legacy.json');
    cli(['pod', 'import', podDir, FIXTURE, '--report', reportPath]);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Report;
    expect(report.wellness?.[0].podIdentifierMinted).toBe(true);
    expect(JSON.stringify(report)).not.toContain('urn:uuid:' + '0000');

    const ids = podIdentifierOf(podDir);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Every byte of the old profile is kept; the identifier comes before the day zone.
    const after = fs.readFileSync(extPath, 'utf8');
    expect(after.startsWith(legacy)).toBe(true);
    expect(after.indexOf('podIdentifier')).toBeLessThan(after.indexOf('dayZone'));

    // The names were computed from the identifier now on disk.
    const summaries = namesByKind(podDir).get('activity summary')!;
    const expected = `urn:uuid:${deterministicUuid(wellnessSourceRecordSeed({ podSubject: ids[0], idSpace: 'healthkit', sourceId: '2026-03-07' }))}`;
    expect([...summaries]).toContain(expected);

    // From then on it is only read: a second import is byte-identical and mints nothing.
    const first = snapshot(podDir);
    const reportPath2 = path.join(path.dirname(podDir), 'report-legacy-2.json');
    cli(['pod', 'import', podDir, FIXTURE, '--report', reportPath2]);
    expect((JSON.parse(fs.readFileSync(reportPath2, 'utf8')) as Report).wellness?.[0].podIdentifierMinted).toBe(false);
    expect(snapshot(podDir)).toEqual(first);
  }, 180_000);

  it('a profile with two identifiers stops the import before anything is named', () => {
    const podDir = newPod();
    const extPath = path.join(podDir, 'profile', 'extended.ttl');
    fs.appendFileSync(
      extPath,
      `<#me> <${POD_ID}> "urn:uuid:1c7b5d2f-3e4a-4b6c-9d8e-0f1a2b3c4d5e"^^<http://www.w3.org/2001/XMLSchema#anyURI> .\n`,
    );
    let failed = false;
    try {
      cli(['pod', 'import', podDir, FIXTURE]);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(fs.existsSync(path.join(podDir, 'wellness', 'heart-rate.ttl'))).toBe(false);
    expect(fs.existsSync(path.join(podDir, 'wellness', 'samples', 'samples.ttl'))).toBe(false);
  }, 180_000);
});
