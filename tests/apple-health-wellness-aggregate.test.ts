/**
 * The wellness aggregation rules: closed days, the DST cut, the rules table,
 * one record per source, and the two naming tiers (D-WELLNESS-1 Q1).
 *
 * Every export here is synthetic, built by the helpers below from invented values.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stringChunks } from '../src/lib/apple-health-wellness/xml-scanner.js';
import { scanExport } from '../src/lib/apple-health-wellness/scan.js';
import { SampleSpill } from '../src/lib/apple-health-wellness/spill.js';
import { aggregate, majorityTimeZone, type AggregationResult, type SampleFile, type WellnessRecord } from '../src/lib/apple-health-wellness/aggregate.js';
import { recordQuads, sampleFileQuads } from '../src/lib/apple-health-wellness/quads.js';
import { wellnessRules } from '../src/lib/apple-health-wellness/rules.js';
import { dayIntervalUtc, isoUtc } from '../src/lib/apple-health-wellness/time.js';
import {
  wellnessSourceRecordSeed,
  wellnessDigestSeed,
  wellnessSampleDigest,
  wellnessDeviceIdentity,
  wellnessSupportSeed,
} from '../src/lib/identity.js';
import { deterministicUuid } from '../src/lib/fhir-converter/types.js';

const POD = '/profile/card.ttl#me';
const LA = 'America/Los_Angeles';
const FIXTURE = path.resolve(__dirname, '../test-fixtures/apple-health-wellness/export.xml');

const WATCH = (addr = '0x6000031a4f00', mfr = 'Apple Inc.', sw = '10.3'): string =>
  `&lt;&lt;HKDevice: ${addr}&gt;, name:Apple Watch, manufacturer:${mfr}, model:Watch, hardware:Watch6,1, software:${sw}&gt;`;
const PHONE = `&lt;&lt;HKDevice: 0x600002c8d680&gt;, name:iPhone, manufacturer:Apple Inc., model:iPhone, hardware:iPhone15,2, software:17.4&gt;`;

/** An Apple timestamp for a UTC instant, rendered at a fixed offset, the way the export renders every sample. */
function render(isoZ: string, offsetHours = -7): string {
  const ms = Date.parse(isoZ) + offsetHours * 3_600_000;
  const d = new Date(ms).toISOString();
  const sign = offsetHours < 0 ? '-' : '+';
  const h = String(Math.abs(offsetHours)).padStart(2, '0');
  return `${d.slice(0, 10)} ${d.slice(11, 19)} ${sign}${h}00`;
}

interface S {
  type: string;
  source?: string;
  device?: string;
  unit: string;
  start: string; // UTC ISO
  end?: string;
  value: string;
}

function record(s: S, offset = -7): string {
  const dev = s.device === undefined ? '' : ` device="${s.device}"`;
  return (
    `<Record type="HKQuantityTypeIdentifier${s.type}" sourceName="${s.source ?? 'Alex Watch'}" sourceVersion="10.3"${dev} ` +
    `unit="${s.unit}" creationDate="${render(s.end ?? s.start, offset)}" startDate="${render(s.start, offset)}" ` +
    `endDate="${render(s.end ?? s.start, offset)}" value="${s.value}"/>`
  );
}

function exportXml(exportDateZ: string, body: string, offset = -7): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE HealthData [\n<!ELEMENT HealthData ANY>\n]>\n` +
    `<HealthData locale="en_US">\n<ExportDate value="${render(exportDateZ, offset)}"/>\n${body}\n</HealthData>\n`
  );
}

/** Each run's sample packs, by digest, as the importer's writer would receive them. */
const packBytes = new WeakMap<AggregationResult, Map<string, Buffer>>();

async function run(xml: string, zone = LA): Promise<AggregationResult> {
  const spill = new SampleSpill(256); // a tiny budget forces many encrypted flushes
  try {
    const scan = await scanExport(stringChunks(xml, 997), spill);
    const bytes = new Map<string, Buffer>();
    const r = aggregate(scan, spill, { podSubject: POD, dayZone: zone, onSampleFile: (f, b) => bytes.set(f.digest, b) });
    packBytes.set(r, bytes);
    return r;
  } finally {
    spill.close();
  }
}

const urn = (seed: string): string => `urn:uuid:${deterministicUuid(seed)}`;
const of = <K extends WellnessRecord['kind']>(r: AggregationResult, kind: K): Extract<WellnessRecord, { kind: K }>[] =>
  r.records.filter((x) => x.kind === kind) as Extract<WellnessRecord, { kind: K }>[];

describe('closed days, cut in the pod zone across a DST change', () => {
  // 2026-03-08 is the spring-forward day in America/Los_Angeles: 23 hours long,
  // 08:00Z to 07:00Z. Every timestamp is rendered at -0700, as the measured
  // exports render them, including the PST ones before the change.
  const body = [
    { type: 'HeartRate', unit: 'count/min', start: '2026-03-08T07:30:00Z', value: '58', device: WATCH() }, // 23:30 PST, day 03-07
    { type: 'HeartRate', unit: 'count/min', start: '2026-03-08T09:30:00Z', value: '55', device: WATCH() }, // 01:30 PST, day 03-08
    { type: 'HeartRate', unit: 'count/min', start: '2026-03-09T06:59:59Z', value: '70', device: WATCH() }, // 23:59:59 PDT, day 03-08
    { type: 'HeartRate', unit: 'count/min', start: '2026-03-09T07:00:00Z', value: '60', device: WATCH() }, // 00:00 PDT, day 03-09
  ]
    .map((s) => record(s))
    .join('\n');

  it('cuts the 23-hour day at local midnights, expressed in UTC', () => {
    expect(dayIntervalUtc('2026-03-08', LA)).toEqual({
      start: Date.parse('2026-03-08T08:00:00Z'),
      end: Date.parse('2026-03-09T07:00:00Z'),
    });
    expect(dayIntervalUtc('2026-11-01', LA).end - dayIntervalUtc('2026-11-01', LA).start).toBe(25 * 3_600_000);
  });

  it('a day whose end equals the export coverage end is OPEN; one second later it is closed', async () => {
    const atEnd = await run(exportXml('2026-03-09T07:00:00Z', body));
    const days = (r: AggregationResult): string[] =>
      [...new Set(of(r, 'vitalReading').map((v) => `${v.periodStart}/${v.periodEnd}`))].sort();
    expect(days(atEnd)).toEqual(['2026-03-07T08:00:00Z/2026-03-08T08:00:00Z']);
    expect(atEnd.openDaysSkipped).toBe(2);

    const after = await run(exportXml('2026-03-09T07:00:01Z', body));
    expect(days(after)).toEqual([
      '2026-03-07T08:00:00Z/2026-03-08T08:00:00Z',
      '2026-03-08T08:00:00Z/2026-03-09T07:00:00Z',
    ]);
    const mar8 = of(after, 'vitalReading').filter((v) => v.periodStart === '2026-03-08T08:00:00Z');
    expect(mar8.every((v) => v.sampleCount === 2 && v.timeZone === LA)).toBe(true);
    expect(mar8.find((v) => v.statistic === 'maximum')!.value).toBe(70);
    expect(mar8.find((v) => v.statistic === 'minimum')!.value).toBe(55);
  });

  it('never trusts the rendered offset: the same instants rendered at -0800 give the same names', async () => {
    const at7 = await run(exportXml('2026-03-12T00:00:00Z', body));
    const body8 = [
      { type: 'HeartRate', unit: 'count/min', start: '2026-03-08T07:30:00Z', value: '58', device: WATCH() },
      { type: 'HeartRate', unit: 'count/min', start: '2026-03-08T09:30:00Z', value: '55', device: WATCH() },
      { type: 'HeartRate', unit: 'count/min', start: '2026-03-09T06:59:59Z', value: '70', device: WATCH() },
      { type: 'HeartRate', unit: 'count/min', start: '2026-03-09T07:00:00Z', value: '60', device: WATCH() },
    ]
      .map((s) => record(s, -8))
      .join('\n');
    const at8 = await run(exportXml('2026-03-12T00:00:00Z', body8, -8));
    expect(at8.records.map((r) => r.iri).sort()).toEqual(at7.records.map((r) => r.iri).sort());
    expect(at8.sampleFiles.map((f) => f.digest)).toEqual(at7.sampleFiles.map((f) => f.digest));
  });
});

describe('the rules table drives what is computed', () => {
  it('each aggregated type yields exactly the statistics its rule lists, and an unlisted type yields nothing', async () => {
    const r = await run(fs.readFileSync(FIXTURE, 'utf8'));
    const rules = wellnessRules();
    const seen = new Map<string, Set<string>>();
    for (const v of of(r, 'vitalReading')) {
      if (!seen.has(v.hkType)) seen.set(v.hkType, new Set());
      seen.get(v.hkType)!.add(v.statistic);
    }
    for (const m of rules.metrics.filter((x) => x.record === 'vitalReading')) {
      expect([...(seen.get(m.hkType) ?? [])].sort(), m.hkType).toEqual([...m.statistics].sort());
    }
    expect(seen.has('HKQuantityTypeIdentifierBasalEnergyBurned')).toBe(false);
    expect(seen.has('HKQuantityTypeIdentifierBloodPressureSystolic')).toBe(false);
    // Units and codes come from the table too.
    const spo2 = of(r, 'vitalReading').find((v) => v.hkType.endsWith('OxygenSaturation'))!;
    expect(spo2).toMatchObject({ unit: '%', loinc: '2708-6', value: 96, fileKey: 'body-measurements' });
    const mass = of(r, 'vitalReading').find((v) => v.hkType.endsWith('BodyMass'))!;
    expect(mass.value).toBeCloseTo(165.3 * 0.45359237, 3);
  });

  it('adding a statistic to a rule adds exactly that record, with no code change', async () => {
    const xml = fs.readFileSync(FIXTURE, 'utf8');
    const rule = wellnessRules().metrics.find((m) => m.hkType === 'HKQuantityTypeIdentifierRespiratoryRate')!;
    const saved = [...rule.statistics];
    const before = await run(xml);
    rule.statistics.push('maximum');
    try {
      const after = await run(xml);
      const added = of(after, 'vitalReading').filter((v) => !before.records.some((b) => b.iri === v.iri));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ hkType: rule.hkType, statistic: 'maximum', value: 15.5 });
    } finally {
      rule.statistics.splice(0, rule.statistics.length, ...saved);
    }
  });

  it('a sample in a unit the table does not accept is reported, never aggregated', async () => {
    const body = [
      record({ type: 'HeartRate', unit: 'count/min', start: '2026-03-08T12:00:00Z', value: '60', device: WATCH() }),
      record({ type: 'HeartRate', unit: 'count/s', start: '2026-03-08T13:00:00Z', value: '1', device: WATCH() }),
    ].join('\n');
    const r = await run(exportXml('2026-03-12T00:00:00Z', body));
    expect(r.unknownUnits).toEqual({ 'HKQuantityTypeIdentifierHeartRate count/s': 1 });
    expect(of(r, 'vitalReading').every((v) => v.sampleCount === 1 && v.value === 60)).toBe(true);
  });
});

describe('no merging across sources', () => {
  it('the watch and the phone counting steps on one day are two records, and neither wins', async () => {
    const r = await run(fs.readFileSync(FIXTURE, 'utf8'));
    const mar8 = of(r, 'stepSnapshot').filter((s) => s.periodStart === '2026-03-08T08:00:00Z');
    expect(mar8.map((s) => [s.sourceName, s.steps]).sort()).toEqual([
      ['Alex’s Apple Watch', 3600],
      ['Alex’s iPhone', 1950],
    ]);
    expect(new Set(mar8.map((s) => s.iri)).size).toBe(2);
    expect(new Set(mar8.map((s) => s.deviceIri)).size).toBe(2);
  });

  it('two sources on one device are still two records', async () => {
    const body = [
      record({ type: 'StepCount', source: 'Alex iPhone', device: PHONE, unit: 'count', start: '2026-03-08T17:00:00Z', value: '100' }),
      record({ type: 'StepCount', source: 'Pedometer App', device: PHONE, unit: 'count', start: '2026-03-08T17:00:00Z', value: '100' }),
    ].join('\n');
    const r = await run(exportXml('2026-03-12T00:00:00Z', body));
    const steps = of(r, 'stepSnapshot');
    expect(steps).toHaveLength(2);
    expect(steps[0].iri).not.toBe(steps[1].iri);
    expect(steps[0].deviceIri).toBe(steps[1].deviceIri);
  });
});

describe('naming: tier 1 when the source supplies an id, the digest tier otherwise', () => {
  const workout = (meta: string, duration = '55'): string =>
    `<Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="${duration}" durationUnit="min" sourceName="Strava" sourceVersion="3104" ` +
    `creationDate="${render('2026-03-10T00:40:00Z')}" startDate="${render('2026-03-09T23:30:00Z')}" endDate="${render('2026-03-10T00:25:00Z')}">${meta}</Workout>`;
  const ID = '8B6E1F2A-4C3D-4E5F-9A1B-2C3D4E5F6A7B';
  const withId = `<MetadataEntry key="HKExternalUUID" value="${ID}"/>`;

  it('a workout carrying HKExternalUUID is named from it, and keeps its name when its content changes', async () => {
    const a = of(await run(exportXml('2026-03-12T00:00:00Z', workout(withId))), 'workout')[0];
    expect(a.iri).toBe(urn(wellnessSourceRecordSeed({ podSubject: POD, idSpace: 'healthkit', sourceId: ID })));
    expect(a.sourceRecordId).toBe(ID);
    const b = of(await run(exportXml('2026-03-12T00:00:00Z', workout(withId, '56'))), 'workout')[0];
    expect(b.iri).toBe(a.iri);
  });

  it('a workout with no id is named by a digest of the element, which moves when its content does', async () => {
    const a = of(await run(exportXml('2026-03-12T00:00:00Z', workout(''))), 'workout')[0];
    expect(a.sourceRecordId).toBeUndefined();
    expect(a.iri).not.toBe(urn(wellnessSourceRecordSeed({ podSubject: POD, idSpace: 'healthkit', sourceId: ID })));
    const again = of(await run(exportXml('2026-03-12T00:00:00Z', workout(''))), 'workout')[0];
    expect(again.iri).toBe(a.iri);
    const changed = of(await run(exportXml('2026-03-12T00:00:00Z', workout('', '56'))), 'workout')[0];
    expect(changed.iri).not.toBe(a.iri);
  });

  it('an ActivitySummary is named by its date; the sentinel and open-day rows are not imported', async () => {
    const r = await run(fs.readFileSync(FIXTURE, 'utf8'));
    const sums = of(r, 'activitySummary');
    expect(sums.map((s) => s.date).sort()).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    for (const s of sums) {
      expect(s.iri).toBe(urn(wellnessSourceRecordSeed({ podSubject: POD, idSpace: 'healthkit', sourceId: s.date })));
    }
    expect(r.activitySummariesSkipped).toEqual({ sentinel: 1, openDay: 1, empty: 0 });
  });

  it('an aggregate is named by the digest seed over its constituent samples', async () => {
    const body = [
      record({ type: 'HeartRate', unit: 'count/min', start: '2026-03-08T12:00:00Z', value: '60', device: WATCH() }),
      record({ type: 'HeartRate', unit: 'count/min', start: '2026-03-08T13:00:00Z', value: '80', device: WATCH() }),
      record({ type: 'HeartRate', unit: 'count/min', start: '2026-03-09T13:00:00Z', value: '75', device: WATCH() }),
    ];
    const base = await run(exportXml('2026-03-12T00:00:00Z', body.join('\n')));
    const avg = of(base, 'vitalReading').find((v) => v.statistic === 'average' && v.periodStart === '2026-03-08T08:00:00Z')!;
    expect(avg.value).toBe(70);
    // Recompute the name independently: the measured field set per sample,
    // instants in UTC, the device string with its address stripped.
    const device = '<<HKDevice: >, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,1, software:10.3>';
    const fields = (iso: string, value: string): string[] => [
      'HKQuantityTypeIdentifierHeartRate', 'Alex Watch', 'count/min', iso, iso, value, '10.3', iso, device,
    ];
    const expected = urn(
      wellnessDigestSeed({
        podSubject: POD,
        idSpace: 'healthkit',
        device: wellnessDeviceIdentity('Apple Watch', 'Watch6,1'),
        metric: 'HKQuantityTypeIdentifierHeartRate',
        statistic: 'average',
        periodStart: '2026-03-08T08:00:00Z',
        periodEnd: '2026-03-09T07:00:00Z',
        // Order-independent: listed backwards on purpose.
        sampleDigest: wellnessSampleDigest([fields('2026-03-08T13:00:00Z', '80'), fields('2026-03-08T12:00:00Z', '60')]),
      }),
    );
    expect(avg.iri).toBe(expected);
    // One changed sample renames that day's aggregates and no other day's.
    const edited = await run(exportXml('2026-03-12T00:00:00Z', [body[0].replace('value="60"', 'value="61"'), body[1], body[2]].join('\n')));
    const names = (r: AggregationResult, day: string): string[] =>
      of(r, 'vitalReading').filter((v) => v.periodStart === day).map((v) => v.iri).sort();
    expect(names(edited, '2026-03-08T08:00:00Z')).not.toEqual(names(base, '2026-03-08T08:00:00Z'));
    expect(names(edited, '2026-03-09T07:00:00Z')).toEqual(names(base, '2026-03-09T07:00:00Z'));
    // A different memory address in the device string renames nothing.
    const readdressed = await run(exportXml('2026-03-12T00:00:00Z', body.map((b) => b.replace('0x6000031a4f00', '0x7000044b5e10')).join('\n')));
    expect(readdressed.records.map((x) => x.iri).sort()).toEqual(base.records.map((x) => x.iri).sort());
  });
});

describe('retained samples', () => {
  it('every aggregate points at its own sample group, listed by the pack of its day, which holds exactly its samples', async () => {
    const r = await run(fs.readFileSync(FIXTURE, 'utf8'));
    const bytes = packBytes.get(r)!;
    const packOf = new Map<string, SampleFile>();
    for (const f of r.sampleFiles) for (const g of f.groups) packOf.set(g.iri, f);
    for (const a of [...of(r, 'vitalReading'), ...of(r, 'stepSnapshot')]) {
      const f = packOf.get(a.derivedFrom);
      expect(f, a.iri).toBeDefined();
      const group = f!.groups.find((g) => g.iri === a.derivedFrom)!;
      // The group's name is its sample digest's, and nothing else's.
      expect(a.derivedFrom).toBe(urn(wellnessSupportSeed({ podSubject: POD, kind: 'sample-group', key: group.sampleDigest })));
      const doc = JSON.parse(bytes.get(f!.digest)!.toString('utf8'));
      expect(doc.periodStart).toBe(a.periodStart);
      expect(doc.periodEnd).toBe(a.periodEnd);
      const entry = (doc.groups as Array<{ sampleDigest: string; series: Array<{ value: string[] }> }>).find(
        (g) => g.sampleDigest === group.sampleDigest,
      );
      expect(entry, a.iri).toBeDefined();
      expect(entry!.series.reduce((n, se) => n + se.value.length, 0)).toBe(a.sampleCount);
      expect(JSON.stringify(doc)).not.toMatch(/0x[0-9a-f]{6,}/);
    }
    expect(r.samplesRetained).toBeGreaterThanOrEqual(r.samplesAggregated);
    expect(isoUtc(r.coverageEnd!)).toBe('2026-03-10T16:00:00Z');
  });

  it('a change to one series of a day leaves every other aggregate of that day with the same name AND the same triples', async () => {
    // One day, two sources and three metrics. The second export differs in ONE
    // sample of ONE series (the phone's steps), which makes a new pack for the
    // day. Every other aggregate of the day must be byte-for-byte what it was.
    const day = (phoneSteps: string): string =>
      [
        { type: 'HeartRate', unit: 'count/min', start: '2026-03-03T17:00:00Z', value: '61', device: WATCH() },
        { type: 'HeartRate', unit: 'count/min', start: '2026-03-03T18:00:00Z', value: '75', device: WATCH() },
        { type: 'RestingHeartRate', unit: 'count/min', start: '2026-03-03T19:00:00Z', value: '52', device: WATCH() },
        { type: 'StepCount', unit: 'count', start: '2026-03-03T20:00:00Z', value: '1200', device: WATCH() },
        { type: 'StepCount', unit: 'count', source: 'Alex iPhone', start: '2026-03-03T20:00:00Z', value: '900', device: PHONE },
        { type: 'StepCount', unit: 'count', source: 'Alex iPhone', start: '2026-03-03T21:00:00Z', value: phoneSteps, device: PHONE },
      ]
        .map((x) => record(x))
        .join('\n');
    const a = await run(exportXml('2026-03-06T00:00:00Z', day('300')));
    const b = await run(exportXml('2026-03-06T00:00:00Z', day('310')));
    // The day's pack did change.
    expect(a.sampleFiles.map((f) => f.digest)).not.toEqual(b.sampleFiles.map((f) => f.digest));

    const triples = (r: AggregationResult): Map<string, string> =>
      new Map(
        [...of(r, 'vitalReading'), ...of(r, 'stepSnapshot')].map((x) => [
          x.iri,
          recordQuads(x)
            .map((q) => `${q.predicate.value} ${q.object.termType === 'Literal' ? JSON.stringify(q.object.value) : q.object.value}`)
            .sort()
            .join('\n'),
        ]),
      );
    const ta = triples(a);
    const tb = triples(b);
    const phone = (r: AggregationResult): Set<string> =>
      new Set(of(r, 'stepSnapshot').filter((x) => x.sourceName === 'Alex iPhone').map((x) => x.iri));
    const untouchedA = [...ta.keys()].filter((k) => !phone(a).has(k));
    expect(untouchedA.length).toBe(ta.size - phone(a).size);
    expect(untouchedA.length).toBeGreaterThanOrEqual(4);
    for (const iri of untouchedA) expect(tb.get(iri), iri).toBe(ta.get(iri));
    // The changed series is a new record, under a new name.
    for (const iri of phone(b)) expect(ta.has(iri)).toBe(false);

    // And the group nodes those aggregates point at carry the same triples in
    // both descriptors, though each export lists them from a different pack.
    const groupTriples = (r: AggregationResult): Map<string, string> => {
      const m = new Map<string, string>();
      for (const f of r.sampleFiles) {
        const gs = new Set(f.groups.map((g) => g.iri));
        for (const q of sampleFileQuads(f)) {
          if (!gs.has(q.subject.value)) continue;
          m.set(q.subject.value, [m.get(q.subject.value) ?? '', `${q.predicate.value} ${q.object.value}`].sort().join('\n'));
        }
      }
      return m;
    };
    const ga = groupTriples(a);
    const gb = groupTriples(b);
    for (const iri of untouchedA) {
      const g = [...of(a, 'vitalReading'), ...of(a, 'stepSnapshot')].find((x) => x.iri === iri)!.derivedFrom;
      expect(gb.get(g), g).toBe(ga.get(g));
    }
  });
});

describe('the day-zone default', () => {
  it('counts an alias as the zone it names, and returns the canonical name', () => {
    const counts = new Map([
      ['US/Pacific', 2],
      ['America/Los_Angeles', 2],
      ['America/New_York', 3],
      ['Not/AZone', 9],
    ]);
    expect(majorityTimeZone(counts)).toBe('America/Los_Angeles');
    expect(majorityTimeZone(new Map([['US/Pacific', 1]]))).toBe('America/Los_Angeles');
  });
});
