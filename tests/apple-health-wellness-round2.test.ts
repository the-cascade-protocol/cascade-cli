/**
 * The wellness types added after the daily aggregates: Apple sleep sessions,
 * paired blood pressure readings, VO2 max estimates, and basal and active
 * energy on the per-device activity snapshot.
 *
 * Every export here is synthetic, built by the helpers below from invented values.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Parser } from 'n3';
import { stringChunks } from '../src/lib/apple-health-wellness/xml-scanner.js';
import { scanExport } from '../src/lib/apple-health-wellness/scan.js';
import { SampleSpill } from '../src/lib/apple-health-wellness/spill.js';
import { aggregate, type AggregationResult, type WellnessRecord } from '../src/lib/apple-health-wellness/aggregate.js';
import { bpPairingActivityQuads, recordQuads, sampleFileQuads, sleepActivityQuads } from '../src/lib/apple-health-wellness/quads.js';
import { wellnessRules } from '../src/lib/apple-health-wellness/rules.js';
import { importAppleHealthWellness } from '../src/lib/apple-health-wellness/import-export.js';
import { dataTypeKeyForSubject } from '../src/lib/pod-data-types.js';
import { wellnessSourceRecordSeed, wellnessSupportSeed } from '../src/lib/identity.js';
import { deterministicUuid } from '../src/lib/fhir-converter/types.js';

const POD = 'urn:uuid:5b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8';
const LA = 'America/Los_Angeles';
const CLI = path.resolve(__dirname, '../dist/index.js');
const H = 'https://ns.cascadeprotocol.org/health/v1#';
const C = 'https://ns.cascadeprotocol.org/core/v1#';
const CLIN = 'https://ns.cascadeprotocol.org/clinical/v1#';
const PROV = 'http://www.w3.org/ns/prov#';

const WATCH = `&lt;&lt;HKDevice: 0x6000031a4f00&gt;, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,1, software:10.3&gt;`;
const PHONE = `&lt;&lt;HKDevice: 0x600002c8d680&gt;, name:iPhone, manufacturer:Apple Inc., model:iPhone, hardware:iPhone15,2, software:17.4&gt;`;

/** An Apple timestamp for a UTC instant, rendered at a fixed offset, the way the export renders every sample. */
function render(isoZ: string, offsetHours = -7): string {
  const ms = Date.parse(isoZ) + offsetHours * 3_600_000;
  const d = new Date(ms).toISOString();
  const sign = offsetHours < 0 ? '-' : '+';
  const h = String(Math.abs(offsetHours)).padStart(2, '0');
  return `${d.slice(0, 10)} ${d.slice(11, 19)} ${sign}${h}00`;
}

const plus = (isoZ: string, minutes: number): string => new Date(Date.parse(isoZ) + minutes * 60_000).toISOString().replace(/\.000Z$/, 'Z');

function exportXml(exportDateZ: string, body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n` +
    `<ExportDate value="${render(exportDateZ)}"/>\n${body}\n</HealthData>\n`
  );
}

function segment(start: string, end: string, stage: string, opts: { source?: string; zone?: string | null } = {}): string {
  const zone = opts.zone === undefined ? LA : opts.zone;
  return (
    `<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="${opts.source ?? 'Alex Watch'}" sourceVersion="10.3" ` +
    `creationDate="${render(end)}" startDate="${render(start)}" endDate="${render(end)}" value="HKCategoryValueSleepAnalysis${stage}">` +
    (zone ? `\n  <MetadataEntry key="HKTimeZone" value="${zone}"/>\n` : '') +
    `</Record>`
  );
}

function bpComponent(kind: 'Systolic' | 'Diastolic', at: string, value: string): string {
  return (
    `<Record type="HKQuantityTypeIdentifierBloodPressure${kind}" sourceName="Cuff App" sourceVersion="7.1" unit="mmHg" ` +
    `creationDate="${render(at)}" startDate="${render(at)}" endDate="${render(at)}" value="${value}"/>`
  );
}

function bpCorrelation(at: string, sys: string | null, dia: string | null, meta = ''): string {
  return (
    `<Correlation type="HKCorrelationTypeIdentifierBloodPressure" sourceName="Cuff App" sourceVersion="7.1" ` +
    `creationDate="${render(at)}" startDate="${render(at)}" endDate="${render(at)}">\n${meta}` +
    (sys === null ? '' : bpComponent('Systolic', at, sys) + '\n') +
    (dia === null ? '' : bpComponent('Diastolic', at, dia) + '\n') +
    `</Correlation>`
  );
}

function vo2(at: string, value: string, testType: string | null, meta = ''): string {
  return (
    `<Record type="HKQuantityTypeIdentifierVO2Max" sourceName="Alex Watch" sourceVersion="10.3" device="${WATCH}" unit="mL/min·kg" ` +
    `creationDate="${render(at)}" startDate="${render(at)}" endDate="${render(at)}" value="${value}">\n` +
    (testType === null ? '' : `  <MetadataEntry key="HKVO2MaxTestType" value="${testType}"/>\n`) +
    meta +
    `</Record>`
  );
}

function energy(kind: 'Active' | 'Basal', start: string, value: string, device = WATCH): string {
  return (
    `<Record type="HKQuantityTypeIdentifier${kind}EnergyBurned" sourceName="Alex Watch" sourceVersion="10.3" device="${device}" unit="kcal" ` +
    `creationDate="${render(plus(start, 30))}" startDate="${render(start)}" endDate="${render(plus(start, 29))}" value="${value}"/>`
  );
}

async function run(xml: string, zone = LA): Promise<AggregationResult> {
  const spill = new SampleSpill(256);
  try {
    const scan = await scanExport(stringChunks(xml, 997), spill);
    return aggregate(scan, spill, { podSubject: POD, dayZone: zone });
  } finally {
    spill.close();
  }
}

const urn = (seed: string): string => `urn:uuid:${deterministicUuid(seed)}`;
const of = <K extends WellnessRecord['kind']>(r: AggregationResult, kind: K): Extract<WellnessRecord, { kind: K }>[] =>
  r.records.filter((x) => x.kind === kind) as Extract<WellnessRecord, { kind: K }>[];
const predicates = (r: WellnessRecord): string[] => recordQuads(r).map((q) => q.predicate.value);

// A night in Los Angeles: 2026-03-10 23:00 PDT to 2026-03-11 06:30 PDT.
const NIGHT_START = '2026-03-11T06:00:00Z';
const LATE_EXPORT = '2026-03-20T00:00:00Z';

describe('sleep sessions: the one-hour grouping rule', () => {
  const twoSegments = (gapMinutes: number): string =>
    [
      segment(NIGHT_START, plus(NIGHT_START, 120), 'AsleepCore'),
      segment(plus(NIGHT_START, 120 + gapMinutes), plus(NIGHT_START, 240 + gapMinutes), 'AsleepDeep'),
    ].join('\n');

  it('a 59-minute gap is one session; 61 minutes is two; exactly 60 is two ("one hour or more")', async () => {
    expect(of(await run(exportXml(LATE_EXPORT, twoSegments(59))), 'sleepSession')).toHaveLength(1);
    expect(of(await run(exportXml(LATE_EXPORT, twoSegments(61))), 'sleepSession')).toHaveLength(2);
    expect(of(await run(exportXml(LATE_EXPORT, twoSegments(60))), 'sleepSession')).toHaveLength(2);
  });

  it('a run of awake segments lasting an hour or more is a gap; a shorter run stays in the session', async () => {
    const withAwake = (awakeMinutes: number): string =>
      [
        segment(NIGHT_START, plus(NIGHT_START, 120), 'AsleepCore'),
        segment(plus(NIGHT_START, 120), plus(NIGHT_START, 120 + awakeMinutes), 'Awake'),
        segment(plus(NIGHT_START, 120 + awakeMinutes), plus(NIGHT_START, 240 + awakeMinutes), 'AsleepREM'),
      ].join('\n');
    const short = await run(exportXml(LATE_EXPORT, withAwake(45)));
    expect(of(short, 'sleepSession')).toHaveLength(1);
    expect(of(short, 'sleepSession')[0].stages.awakeMinutes).toBe(45);
    const long = await run(exportXml(LATE_EXPORT, withAwake(60)));
    const sessions = of(long, 'sleepSession');
    expect(sessions).toHaveLength(2);
    for (const s of sessions) expect(s.stages.awakeMinutes).toBeUndefined();
    // The awake run is retained, but in neither session.
    expect(long.sleep.unassignedSegments).toBe(1);
  });

  it('sums each stage into its AASM-named total, and keeps in bed out of the stages', async () => {
    const body = [
      segment(plus(NIGHT_START, -10), plus(NIGHT_START, 460), 'InBed'),
      segment(NIGHT_START, plus(NIGHT_START, 100), 'AsleepCore'),
      segment(plus(NIGHT_START, 100), plus(NIGHT_START, 160), 'AsleepDeep'),
      segment(plus(NIGHT_START, 160), plus(NIGHT_START, 250), 'AsleepREM'),
      segment(plus(NIGHT_START, 250), plus(NIGHT_START, 270), 'Awake'),
      segment(plus(NIGHT_START, 270), plus(NIGHT_START, 300), 'AsleepCore'),
      segment(plus(NIGHT_START, 300), plus(NIGHT_START, 330), 'AsleepUnspecified'),
    ].join('\n');
    const [s] = of(await run(exportXml(LATE_EXPORT, body)), 'sleepSession');
    expect(s.stages).toEqual({
      inBedMinutes: 470,
      lightSleepMinutes: 130,
      deepSleepMinutes: 60,
      remSleepMinutes: 90,
      awakeMinutes: 20,
      asleepUnspecifiedMinutes: 30,
    });
    expect(s.periodStart).toBe(plus(NIGHT_START, -10));
    expect(s.periodEnd).toBe(plus(NIGHT_START, 460));
  });

  it('a session crossing midnight is dated by the day of waking', async () => {
    const r = await run(exportXml(LATE_EXPORT, segment(NIGHT_START, plus(NIGHT_START, 450), 'AsleepCore')));
    const [s] = of(r, 'sleepSession');
    // Started 2026-03-10 23:00 PDT, ended 2026-03-11 06:30 PDT: dated 2026-03-11 (PDT midnight is 07:00Z).
    expect(s.date).toBe('2026-03-11T07:00:00Z');
    expect(recordQuads(s).find((q) => q.predicate.value === C + 'date')!.object.value).toBe('2026-03-11T07:00:00Z');
  });

  it('is dated in its recorded zone when that differs from the pod zone, and in the pod zone when the source recorded none', async () => {
    // Ends 2026-03-11 20:00Z: 13:00 on the 11th in Los Angeles, 05:00 on the 12th in Tokyo.
    const start = '2026-03-11T13:00:00Z';
    const tokyo = of(await run(exportXml(LATE_EXPORT, segment(start, plus(start, 420), 'AsleepCore', { zone: 'Asia/Tokyo' })), LA), 'sleepSession')[0];
    expect(tokyo.recordedZone).toBe('Asia/Tokyo');
    expect(tokyo.date).toBe('2026-03-11T15:00:00Z'); // Tokyo midnight starting the 12th
    const tz = recordQuads(tokyo).filter((q) => q.predicate.value === H + 'timeZone').map((q) => q.object.value);
    expect(tz).toEqual(['Asia/Tokyo']);

    const none = of(await run(exportXml(LATE_EXPORT, segment(start, plus(start, 420), 'AsleepCore', { zone: null })), LA), 'sleepSession')[0];
    expect(none.recordedZone).toBeUndefined();
    expect(none.date).toBe('2026-03-11T07:00:00Z'); // Los Angeles midnight starting the 11th
    // The pod zone dates it, but is not written as the zone the source recorded.
    expect(predicates(none)).not.toContain(H + 'timeZone');
  });

  it('a nap is its own session, and no Apple session carries health:isMainSleep', async () => {
    const napStart = plus(NIGHT_START, 450 + 6 * 60);
    const body = [
      segment(NIGHT_START, plus(NIGHT_START, 450), 'AsleepCore'),
      segment(napStart, plus(napStart, 40), 'AsleepCore'),
    ].join('\n');
    const sessions = of(await run(exportXml(LATE_EXPORT, body)), 'sleepSession');
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((s) => s.iri)).size).toBe(2);
    for (const s of sessions) expect(predicates(s)).not.toContain(H + 'isMainSleep');
  });

  it('never groups across sources', async () => {
    const body = [
      segment(NIGHT_START, plus(NIGHT_START, 450), 'AsleepUnspecified', { source: 'Alex iPhone' }),
      segment(plus(NIGHT_START, 10), plus(NIGHT_START, 440), 'AsleepCore'),
    ].join('\n');
    const sessions = of(await run(exportXml(LATE_EXPORT, body)), 'sleepSession');
    expect(sessions.map((s) => s.sourceName).sort()).toEqual(['Alex Watch', 'Alex iPhone']);
  });

  it('a group with no asleep segment (only in bed, or in bed and awake) is not a session, and its segments are retained', async () => {
    const napStart = plus(NIGHT_START, 450 + 6 * 60);
    const body = [
      segment(NIGHT_START, plus(NIGHT_START, 450), 'InBed', { source: 'Alex iPhone' }),
      segment(napStart, plus(napStart, 30), 'InBed'),
      segment(plus(napStart, 30), plus(napStart, 40), 'Awake'),
    ].join('\n');
    const r = await run(exportXml(LATE_EXPORT, body));
    expect(of(r, 'sleepSession')).toHaveLength(0);
    expect(r.sleep.unassignedSegments).toBe(3);
    // Retained all the same, in a pack, as unassigned samples.
    expect(r.samplesRetained).toBe(3);
    // In bed beside real sleep still counts toward that session's in-bed total.
    const withSleep = await run(
      exportXml(LATE_EXPORT, [segment(NIGHT_START, plus(NIGHT_START, 450), 'InBed'), segment(plus(NIGHT_START, 20), plus(NIGHT_START, 400), 'AsleepCore')].join('\n')),
    );
    expect(of(withSleep, 'sleepSession').map((x) => x.stages)).toEqual([{ inBedMinutes: 450, lightSleepMinutes: 380 }]);
  });

  it('writes only closed sessions: the export must cover at least one grouping gap past the session end', async () => {
    const end = plus(NIGHT_START, 450);
    const body = segment(NIGHT_START, end, 'AsleepCore');
    const open = await run(exportXml(plus(end, 59), body));
    expect(of(open, 'sleepSession')).toHaveLength(0);
    expect(open.sleep.openSkipped).toBe(1);
    const closed = await run(exportXml(plus(end, 60), body));
    expect(of(closed, 'sleepSession')).toHaveLength(1);
    expect(closed.sleep.openSkipped).toBe(0);
  });

  it('retains the segments as the session sample group, and names the grouping rule and version on its activity', async () => {
    const r = await run(exportXml(LATE_EXPORT, segment(NIGHT_START, plus(NIGHT_START, 450), 'AsleepCore')));
    const [s] = of(r, 'sleepSession');
    const packs = r.sampleFiles.filter((f) => f.groups.some((g) => g.iri === s.derivedFrom));
    expect(packs).toHaveLength(1);
    const group = packs[0].groups.find((g) => g.iri === s.derivedFrom)!;
    expect(group.derived).toBe('sleep-session');
    expect(s.derivedFrom).toBe(urn(wellnessSupportSeed({ podSubject: POD, kind: 'sample-group', key: group.sampleDigest })));
    const label = sampleFileQuads(packs[0]).find((q) => q.subject.value === group.iri && q.predicate.value === PROV + 'label')!;
    expect(label.object.value).toMatch(/sleep session/);

    expect(s.generatedBy).toBe(r.sleepActivity.iri);
    const versions = sleepActivityQuads(r.sleepActivity, wellnessRules().sleep.gapMinutes)
      .filter((q) => q.predicate.value === C + 'version')
      .map((q) => q.object.value);
    expect(versions).toEqual([`${wellnessRules().sleep.rule}/${wellnessRules().sleep.ruleVersion}`]);
    expect(versions[0]).toBe('apple-health-sleep-session/1');
  });

  it('files sessions in sleep.ttl through the shared router', async () => {
    const [s] = of(await run(exportXml(LATE_EXPORT, segment(NIGHT_START, plus(NIGHT_START, 450), 'AsleepCore'))), 'sleepSession');
    expect(dataTypeKeyForSubject(recordQuads(s))).toBe('sleep');
  });
});

describe('blood pressure: one record per paired reading', () => {
  const MORNING = '2026-03-11T14:30:00Z';
  const EVENING = '2026-03-12T02:45:00Z';

  it('pairs from the correlation, not from the top-level copies, and never averages a day', async () => {
    const body = [
      // Top-level copies with values the correlation does not hold: were they read, the pairing would show it.
      bpComponent('Systolic', MORNING, '999'),
      bpComponent('Diastolic', MORNING, '998'),
      bpCorrelation(MORNING, '124', '79'),
      bpCorrelation(EVENING, '131', '84'),
    ].join('\n');
    const r = await run(exportXml(LATE_EXPORT, body));
    const readings = of(r, 'bloodPressure').sort((a, b) => a.date.localeCompare(b.date));
    expect(readings.map((x) => [x.date, x.systolic, x.diastolic])).toEqual([
      [MORNING, 124, 79],
      [EVENING, 131, 84],
    ]);
    // No daily record of any kind for blood pressure.
    expect(of(r, 'vitalReading').filter((x) => x.hkType.includes('BloodPressure'))).toHaveLength(0);
    // The top-level values at the morning instant repeat the correlated reading: counted, never a second reading.
    expect(r.bloodPressure).toEqual({
      readings: 2,
      unpaired: 0,
      componentCopies: 0,
      componentRepeats: 2,
      uncorrelatedComponents: 0,
      pairedFromComponents: 0,
      uncorrelatedDropped: { lone: 0, ambiguous: 0, invalid: 0 },
    });
    // Flat form: one systolic and one diastolic on the one record.
    const q = recordQuads(readings[0]);
    expect(q.filter((x) => x.predicate.value === H + 'systolic').map((x) => x.object.value)).toEqual(['124']);
    expect(q.filter((x) => x.predicate.value === H + 'diastolic').map((x) => x.object.value)).toEqual(['79']);
    expect(dataTypeKeyForSubject(q)).toBe('blood-pressure');
  });

  it('pairs top-level components no correlation covers, stamps the pairing rule, and skips a redundant repeat', async () => {
    const LONE = '2026-03-13T15:00:00Z';
    const body = [
      // A correlated reading, its exact copies, and a repeat created earlier.
      bpCorrelation(MORNING, '124', '79'),
      bpComponent('Systolic', MORNING, '124'),
      bpComponent('Diastolic', MORNING, '79'),
      bpComponent('Systolic', MORNING, '124').replace(/creationDate="[^"]*"/, `creationDate="${render(plus(MORNING, -5))}"`),
      bpComponent('Diastolic', MORNING, '79').replace(/creationDate="[^"]*"/, `creationDate="${render(plus(MORNING, -5))}"`),
      // A real reading written with no correlation.
      bpComponent('Systolic', EVENING, '131'),
      bpComponent('Diastolic', EVENING, '84'),
      // A lone half.
      bpComponent('Systolic', LONE, '140'),
    ].join('\n');
    const r = await run(exportXml(LATE_EXPORT, body));
    const readings = of(r, 'bloodPressure').sort((a, b) => a.date.localeCompare(b.date));
    expect(readings.map((x) => [x.date, x.systolic, x.diastolic, x.generatedBy === undefined])).toEqual([
      [MORNING, 124, 79, true],
      [EVENING, 131, 84, false],
    ]);
    expect(readings[1].generatedBy).toBe(r.bpPairingActivity.iri);
    expect(r.bloodPressure).toEqual({
      readings: 2,
      unpaired: 0,
      componentCopies: 2,
      componentRepeats: 2,
      uncorrelatedComponents: 3,
      pairedFromComponents: 1,
      uncorrelatedDropped: { lone: 1, ambiguous: 0, invalid: 0 },
    });
    const versions = bpPairingActivityQuads(r.bpPairingActivity).filter((q) => q.predicate.value === C + 'version').map((q) => q.object.value);
    expect(versions).toEqual(['apple-health-bp-pairing/1']);
    expect(recordQuads(readings[1]).find((q) => q.predicate.value === PROV + 'wasGeneratedBy')!.object.value).toBe(r.bpPairingActivity.iri);
    expect(predicates(readings[0])).not.toContain(PROV + 'wasGeneratedBy');
    // The same pair in a later export has the same name.
    const again = of(await run(exportXml('2026-04-01T00:00:00Z', body)), 'bloodPressure').find((x) => x.date === EVENING)!;
    expect(again.iri).toBe(readings[1].iri);
  });

  it('a correlation without both components is not a reading', async () => {
    const r = await run(exportXml(LATE_EXPORT, bpCorrelation(MORNING, '124', null)));
    expect(of(r, 'bloodPressure')).toHaveLength(0);
    expect(r.bloodPressure.unpaired).toBe(1);
  });

  it('is named by the source identifier when the correlation has one, else by the digest of its own fields', async () => {
    const tagged = await run(
      exportXml(LATE_EXPORT, bpCorrelation(MORNING, '124', '79', `<MetadataEntry key="HKMetadataKeySyncIdentifier" value="cuff-0001"/>\n`)),
    );
    expect(of(tagged, 'bloodPressure')[0].iri).toBe(urn(wellnessSourceRecordSeed({ podSubject: POD, idSpace: 'healthkit', sourceId: 'cuff-0001' })));
    const a = of(await run(exportXml(LATE_EXPORT, bpCorrelation(MORNING, '124', '79'))), 'bloodPressure')[0];
    const b = of(await run(exportXml(LATE_EXPORT, bpCorrelation(MORNING, '125', '79'))), 'bloodPressure')[0];
    const again = of(await run(exportXml('2026-04-01T00:00:00Z', bpCorrelation(MORNING, '124', '79'))), 'bloodPressure')[0];
    expect(a.iri).not.toBe(b.iri);
    expect(again.iri).toBe(a.iri);
  });
});

describe('VO2 max: individual estimates with their method', () => {
  const T1 = '2026-03-11T01:12:00Z';
  const T2 = '2026-03-11T19:40:00Z';

  it('writes one reading per estimate, never a daily series, with the method HealthKit recorded', async () => {
    const r = await run(exportXml(LATE_EXPORT, [vo2(T1, '41.7', '2'), vo2(T2, '43.2', '1'), vo2(plus(T2, 60), '40.0', '9'), vo2(plus(T2, 120), '40.5', null)].join('\n')));
    const readings = of(r, 'vitalSignReading').sort((a, b) => a.date.localeCompare(b.date));
    expect(readings.map((x) => [x.value, x.method])).toEqual([
      [41.7, 'healthkit:predictionSubMaxExercise'],
      [43.2, 'healthkit:maxExercise'],
      [40, undefined],
      [40.5, undefined],
    ]);
    expect(r.readings.HKQuantityTypeIdentifierVO2Max).toEqual({ written: 4, skipped: 0, unknownMethods: 1 });
    expect(of(r, 'vitalReading')).toHaveLength(0);
    for (const x of readings) {
      expect(x.unit).toBe('mL/kg/min');
      expect(predicates(x)).not.toContain(C + 'loincCode');
    }
    expect(recordQuads(readings[0]).find((q) => q.predicate.value === CLIN + 'measurementMethod')!.object.value).toBe(
      'healthkit:predictionSubMaxExercise',
    );
  });

  it('maps only to method values the v2.12 shape allows', () => {
    const shapes = fs.readFileSync(path.resolve(__dirname, '../src/shapes/health.shapes.ttl'), 'utf8');
    const block = shapes.slice(shapes.indexOf('health:MeasurementMethodShape a sh:NodeShape'));
    const allowed = new Set([...block.slice(0, block.indexOf('sh:message')).matchAll(/"([a-z-]+:[A-Za-z_0-9]+)"/g)].map((m) => m[1]));
    expect(allowed.size).toBeGreaterThanOrEqual(12);
    for (const x of wellnessRules().readings) {
      for (const v of Object.values(x.method?.values ?? {})) expect(allowed.has(v), v).toBe(true);
    }
  });

  it('a VitalSignReading carrying a wellness LOINC code is filed in that code\'s wellness file', () => {
    const reading = (loinc: string) => [
      { predicate: { value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' }, object: { value: H + 'VitalSignReading' } },
      { predicate: { value: C + 'loincCode' }, object: { value: `http://loinc.org/rdf#${loinc}` } },
    ];
    expect(dataTypeKeyForSubject(reading('8867-4'))).toBe('heart-rate');
    expect(dataTypeKeyForSubject(reading('80404-7'))).toBe('hrv');
    expect(dataTypeKeyForSubject(reading('2708-6'))).toBe('body-measurements');
  });

  it('a reading without a LOINC code is filed by its SNOMED code in the shared router', async () => {
    const [x] = of(await run(exportXml(LATE_EXPORT, vo2(T1, '41.7', '2'))), 'vitalSignReading');
    expect(dataTypeKeyForSubject(recordQuads(x))).toBe('body-measurements');
    // A reading whose code no rule claims still falls through, as before.
    const other = recordQuads(x).map((q) => ({
      predicate: { value: q.predicate.value },
      object: { value: q.predicate.value === 'http://hl7.org/fhir/code' ? 'http://snomed.info/sct/1' : q.object.value },
    }));
    expect(dataTypeKeyForSubject(other)).toBe('fhir-passthrough');
  });
});

describe('energy on the per-device activity snapshot', () => {
  const DAY = '2026-03-11T16:00:00Z';

  it('basal and active energy are daily sums per device, each on its own snapshot', async () => {
    const body = [
      energy('Basal', DAY, '33.1'),
      energy('Basal', plus(DAY, 60), '30.4'),
      energy('Active', DAY, '120.5'),
      energy('Active', plus(DAY, 60), '80.25'),
      energy('Active', DAY, '15', PHONE),
    ].join('\n');
    const r = await run(exportXml(LATE_EXPORT, body));
    const snaps = of(r, 'activitySnapshot').map((s) => [s.property, s.value, s.sourceName, s.deviceIri !== undefined]);
    expect(snaps.sort()).toEqual([
      ['activeEnergyKcal', 15, 'Alex Watch', true],
      ['activeEnergyKcal', 200.75, 'Alex Watch', true],
      ['basalEnergyKcal', 63.5, 'Alex Watch', true],
    ]);
    const basal = of(r, 'activitySnapshot').find((s) => s.property === 'basalEnergyKcal')!;
    const q = recordQuads(basal);
    expect(q.find((x) => x.predicate.value === H + 'basalEnergyKcal')!.object.value).toBe('63.5');
    expect(q.find((x) => x.predicate.value === C + 'statistic')!.object.value).toBe('sum');
    expect(dataTypeKeyForSubject(q)).toBe('activity');
  });

  it('no longer writes active energy as a daily vital reading coded LOINC 41981-2', async () => {
    const r = await run(exportXml(LATE_EXPORT, energy('Active', DAY, '120.5')));
    expect(of(r, 'vitalReading')).toHaveLength(0);
    const all = r.records.flatMap((x) => recordQuads(x)).map((q) => q.object.value);
    expect(all).not.toContain('http://loinc.org/rdf#41981-2');
    expect(all).not.toContain(H + 'DailyVitalReading');
  });

  it('a reading written that way before keeps its file', () => {
    const legacy = [
      { predicate: { value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' }, object: { value: H + 'DailyVitalReading' } },
      { predicate: { value: C + 'loincCode' }, object: { value: 'http://loinc.org/rdf#41981-2' } },
    ];
    expect(dataTypeKeyForSubject(legacy)).toBe('activity');
  });
});

describe('cascade validate on a synthetic export of every new type', () => {
  it('reports zero violations and zero warnings', async () => {
    const podDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wellness-round2-')), 'pod');
    execFileSync('node', [CLI, 'pod', 'init', podDir], { encoding: 'utf-8' });
    const napStart = plus(NIGHT_START, 450 + 6 * 60);
    const body = [
      segment(plus(NIGHT_START, -10), plus(NIGHT_START, 460), 'InBed'),
      segment(NIGHT_START, plus(NIGHT_START, 200), 'AsleepCore'),
      segment(plus(NIGHT_START, 200), plus(NIGHT_START, 260), 'AsleepDeep'),
      segment(plus(NIGHT_START, 260), plus(NIGHT_START, 280), 'Awake'),
      segment(plus(NIGHT_START, 280), plus(NIGHT_START, 450), 'AsleepREM'),
      segment(napStart, plus(napStart, 40), 'AsleepUnspecified', { zone: null }),
      bpComponent('Systolic', '2026-03-11T14:30:00Z', '124'),
      bpComponent('Diastolic', '2026-03-11T14:30:00Z', '79'),
      bpCorrelation('2026-03-11T14:30:00Z', '124', '79'),
      bpCorrelation('2026-03-12T02:45:00Z', '131', '84'),
      bpComponent('Systolic', '2026-03-13T02:45:00Z', '129'),
      bpComponent('Diastolic', '2026-03-13T02:45:00Z', '83'),
      vo2('2026-03-11T01:12:00Z', '41.7', '2'),
      vo2('2026-03-11T19:40:00Z', '43.2', '9'),
      energy('Basal', '2026-03-11T16:00:00Z', '33.1'),
      energy('Active', '2026-03-11T16:00:00Z', '120.5'),
    ].join('\n');
    const report = await importAppleHealthWellness({
      podDir,
      exportXmlPath: 'export.xml',
      chunks: stringChunks(exportXml(LATE_EXPORT, body), 211),
      machineZoneOverride: LA,
    });
    expect(report.sleep.sessions).toBe(2);
    expect(report.bloodPressure).toMatchObject({ readings: 3, unpaired: 0, componentCopies: 2, uncorrelatedComponents: 2, pairedFromComponents: 1 });
    const out = JSON.parse(execFileSync('node', [CLI, 'validate', podDir, '--json'], { encoding: 'utf-8' })) as Array<{
      file: string;
      valid: boolean;
      results: unknown[];
    }>;
    const files = out.map((o) => path.relative(podDir, o.file));
    for (const f of ['wellness/sleep.ttl', 'wellness/blood-pressure.ttl', 'wellness/body-measurements.ttl', 'wellness/activity.ttl']) {
      expect(files, f).toContain(f);
    }
    for (const o of out) {
      expect(o.valid, o.file).toBe(true);
      expect(o.results, o.file).toEqual([]);
    }
    // Every file parses, and the samples descriptor names both rules.
    const desc = new Parser({ format: 'Turtle', baseIRI: 'https://pod.invalid/x' }).parse(
      fs.readFileSync(path.join(podDir, 'wellness', 'samples', 'samples.ttl'), 'utf8'),
    );
    expect(desc.filter((q) => q.predicate.value === C + 'version').map((q) => q.object.value).sort()).toEqual([
      'apple-health-bp-pairing/1',
      'apple-health-daily-aggregate/2',
      'apple-health-sleep-session/1',
    ]);
  }, 120_000);
});

describe('a computed aggregate from a superseded rule version is replaced in place, never kept beside', () => {
  const FIXTURE_XML = fs.readFileSync(path.resolve(__dirname, '../test-fixtures/apple-health-wellness/export.xml'), 'utf8');
  const RECORD_FILES = ['heart-rate.ttl', 'hrv.ttl', 'body-measurements.ttl', 'activity.ttl'];
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const XSD = 'http://www.w3.org/2001/XMLSchema#';

  function newPod(): string {
    const podDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wellness-migrate-'));
    fs.mkdirSync(path.join(podDir, 'profile'));
    fs.writeFileSync(
      path.join(podDir, 'profile', 'extended.ttl'),
      `<#me> <${C}podIdentifier> "${POD}"^^<${XSD}anyURI> .\n<#me> <${C}dayZone> "${LA}" .\n`,
    );
    return podDir;
  }
  const importFixture = (podDir: string) =>
    importAppleHealthWellness({ podDir, exportXmlPath: 'export.xml', chunks: stringChunks(FIXTURE_XML, 4093), machineZoneOverride: LA });
  const read = (podDir: string, f: string): string => fs.readFileSync(path.join(podDir, 'wellness', f), 'utf8');

  /**
   * Rewrite a pod as the previous release left it: every computed aggregate
   * stamped with rule version 1, per-device active energy as a daily vital
   * reading coded only LOINC 41981-2, and no basal energy.
   */
  async function asPreviousRelease(podDir: string, v1: string, v2: string): Promise<number> {
    const { DataFactory, Writer } = await import('n3');
    const { namedNode, literal, quad } = DataFactory;
    let stamped = 0;
    for (const f of RECORD_FILES) {
      const quads = new Parser({ format: 'Turtle', baseIRI: 'https://pod.invalid/x' }).parse(read(podDir, f));
      const bySubject = new Map<string, typeof quads>();
      for (const q of quads) {
        const a = bySubject.get(q.subject.value) ?? [];
        a.push(q);
        bySubject.set(q.subject.value, a);
      }
      const out: typeof quads = [];
      for (const [subject, qs] of bySubject) {
        const has = (p: string): boolean => qs.some((q) => q.predicate.value === p);
        if (has(H + 'basalEnergyKcal')) continue;
        const aggregate = qs.some((q) => q.predicate.value === PROV + 'wasGeneratedBy' && q.object.value === v2);
        if (aggregate) stamped++;
        // A computed per-device snapshot (a workout also carries active energy and a device, and is a source record).
        const activeOnDevice = aggregate && has(H + 'activeEnergyKcal') && has(H + 'device');
        for (const q of qs) {
          if (q.predicate.value === PROV + 'wasGeneratedBy' && q.object.value === v2) {
            out.push(quad(q.subject, q.predicate, namedNode(v1)));
          } else if (activeOnDevice && q.predicate.value === RDF) {
            out.push(quad(q.subject, q.predicate, namedNode(H + 'DailyVitalReading')));
          } else if (activeOnDevice && q.predicate.value === H + 'activeEnergyKcal') {
            const s = namedNode(subject);
            out.push(quad(s, namedNode('http://hl7.org/fhir/code'), namedNode('http://snomed.info/sct/251833007')));
            out.push(quad(s, namedNode(C + 'loincCode'), namedNode('http://loinc.org/rdf#41981-2')));
            out.push(quad(s, namedNode(H + 'value'), literal(q.object.value, namedNode(XSD + 'double'))));
            out.push(quad(s, namedNode(H + 'unit'), literal('kcal')));
          } else {
            out.push(q);
          }
        }
      }
      const text = await new Promise<string>((resolve, reject) => {
        const w = new Writer();
        w.addQuads(out);
        w.end((e, r) => (e ? reject(e) : resolve(r)));
      });
      fs.writeFileSync(path.join(podDir, 'wellness', f), text);
    }
    return stamped;
  }

  it('re-importing leaves only the new shape, with no collision, and a further import changes nothing', async () => {
    const rules = wellnessRules();
    const fresh = newPod();
    await importFixture(fresh);
    const expected = new Map(RECORD_FILES.map((f) => [f, read(fresh, f)]));

    const pod = newPod();
    await importFixture(pod);
    const v1 = urn(wellnessSupportSeed({ podSubject: POD, kind: 'rule', key: `${rules.rule}/1` }));
    const v2 = urn(wellnessSupportSeed({ podSubject: POD, kind: 'rule', key: `${rules.rule}/${rules.ruleVersion}` }));
    expect(rules.ruleVersion).not.toBe('1');
    const stamped = await asPreviousRelease(pod, v1, v2);
    expect(read(pod, 'activity.ttl')).toContain('41981-2');

    const migrated = await importFixture(pod);
    expect(migrated.collisions, JSON.stringify(migrated.collisions)).toEqual([]);
    // Every aggregate the previous rule wrote except the dropped basal ones was replaced.
    expect(migrated.migratedAggregates).toBe(stamped);
    expect(stamped).toBeGreaterThan(20);
    for (const f of RECORD_FILES) {
      expect(read(pod, f), f).toBe(expected.get(f));
      expect(read(pod, f)).not.toContain('41981-2');
    }

    const again = await importFixture(pod);
    expect(again.collisions).toEqual([]);
    expect(again.migratedAggregates).toBe(0);
    for (const f of RECORD_FILES) expect(read(pod, f), f).toBe(expected.get(f));
  });

  it('never replaces a record a source supplied, or one no superseded rule version stamped', async () => {
    const pod = newPod();
    await importFixture(pod);
    // Alter an ActivitySummary day (a source record) and an aggregate still stamped with the current version.
    const text = read(pod, 'activity.ttl').replace('health:exerciseMinutes 41', 'health:exerciseMinutes 40');
    expect(text).not.toBe(read(pod, 'activity.ttl'));
    fs.writeFileSync(path.join(pod, 'wellness', 'activity.ttl'), text);
    const hr = read(pod, 'heart-rate.ttl').replace(/cascade:sampleCount (\d+)/, (_m, n) => `cascade:sampleCount ${Number(n) + 1}`);
    fs.writeFileSync(path.join(pod, 'wellness', 'heart-rate.ttl'), hr);
    const r = await importFixture(pod);
    expect(r.migratedAggregates).toBe(0);
    expect(r.collisions).toHaveLength(2);
    expect(read(pod, 'activity.ttl')).toContain('health:exerciseMinutes 40');
  });
});
