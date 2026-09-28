/**
 * Pass 2: closed days, their retained samples, and the records derived from them.
 *
 * THE RULES (rule version in the rules table; every aggregate names it):
 *
 *   1. A sample belongs to the local day, in the pod's day zone, that its START
 *      instant falls in. Days are half-open UTC intervals [start, end).
 *   2. A day is aggregated only when it is CLOSED: the export's coverage (its
 *      `<ExportDate>`, else its latest sample end) ends strictly after the day
 *      ends. A partial day is never written, so re-importing a closed day
 *      produces the same records from the same samples, byte for byte
 *      (D-WELLNESS-1 Q3). Measured on two real exports: 99.95% of closed
 *      (type, source, day) buckets are byte-identical three months later.
 *   3. One record per (source, device, metric, statistic, closed day). Sources
 *      are never merged and no winner is picked: a day on which the watch and
 *      the phone both counted steps yields two step records. Source priority is
 *      a READ rule, applied by a reader or by the canonical layer, never here.
 *   4. A computed aggregate is a DERIVED VIEW (the D-WELLNESS-1 amendment of
 *      2026-09-25), so its samples are retained BEFORE it is written: one
 *      compact sample pack per closed day, content-addressed under
 *      `attachments/sha-256/`. Inside the pack the samples are grouped the way
 *      the aggregates are (type, source, device), each group keyed by its own
 *      sample digest, and an aggregate points with `prov:wasDerivedFrom` at its
 *      GROUP, a node named from that same digest, never at the day's pack. So
 *      the same aggregate name always carries the same triples: a change to one
 *      series makes a new pack for the day, and every other aggregate of the
 *      day keeps both its name and its link. The pack lists its groups
 *      (`dct:hasPart`), which is how a reader goes from a group to its bytes.
 *   5. An aggregate is named from its inputs: the digest-tier seed over the pod
 *      subject, id space, device, metric, statistic, UTC interval and a digest
 *      of the samples that fed it (`identity.ts`).
 *
 * Source records need none of this: an `<ActivitySummary>` is Apple's own daily
 * rollup, named by its date (tier 1); a `<Workout>` is a session the source
 * recorded, named by its HKExternalUUID or sync identifier (tier 1) or, lacking
 * one, by a digest of the element. A blood pressure reading (one per
 * correlation) and a VO2 max estimate (one per sample) are named the same way.
 *
 * An Apple sleep session is derived, like an aggregate, but not per day: its
 * segments are grouped over the whole export by the sleep rule
 * ({@link groupSleepSegments}), retained as a sample group in the pack of the
 * day it ends in, and the session is written only once its group is closed.
 */

import { createHash } from 'node:crypto';
import { deterministicUuid } from '../fhir-converter/types.js';
import {
  wellnessDigestSeed,
  wellnessSampleDigest,
  wellnessSourceRecordSeed,
  wellnessDeviceSeed,
  wellnessSupportSeed,
  type WellnessIdSpace,
} from '../identity.js';
import {
  wellnessRules,
  metricRuleFor,
  readingRuleFor,
  type ActivitySnapshotProperty,
  type SleepStageProperty,
  type WellnessSleepRule,
  type WellnessStatistic,
} from './rules.js';
import { canonicalZone, dayIntervalUtc, isKnownZone, isoUtc, localDateOf, parseAppleTimestamp, utcDayNumber } from './time.js';
import { deviceIdentityOf, stripDeviceAddress } from './device.js';
import { decodeSample, type RecordElement, type ScanResult, type SeriesKey, type SpilledSample, type WorkoutElement } from './scan.js';
import type { SampleSpill } from './spill.js';
import { appendAll } from '../append-all.js';

// ---------------------------------------------------------------------------
// Output model (plain data; `quads.ts` turns it into triples)
// ---------------------------------------------------------------------------

interface AggregateBase {
  iri: string;
  /** Pod data-type key of the file that holds it. */
  fileKey: string;
  periodStart: string;
  periodEnd: string;
  timeZone: string;
  statistic: WellnessStatistic;
  sampleCount: number;
  /** The source's own name for itself (`sourceName`), as the export states it. */
  sourceName: string;
  deviceIri?: string;
  /** IRI of the retained sample group this aggregate was computed from (see {@link SampleGroup}). */
  derivedFrom: string;
  /** IRI of the activity naming the rule and its version. */
  generatedBy: string;
}

export interface VitalReadingRecord extends AggregateBase {
  kind: 'vitalReading';
  hkType: string;
  snomed: string;
  loinc: string;
  value: number;
  unit: string;
}

/**
 * A per-device `health:DailyActivitySnapshot` carrying ONE metric: steps, active
 * energy or basal energy. One snapshot per (source, device, metric, day), each
 * derived from its own sample group, as every computed aggregate is.
 */
export interface ActivitySnapshotRecord extends AggregateBase {
  kind: 'activitySnapshot';
  property: ActivitySnapshotProperty;
  /** An integer for steps; kilocalories, rounded to the table's decimals, for energy. */
  value: number;
}

/**
 * An Apple sleep session: stage segments from one source grouped by the sleep
 * rule (see {@link groupSleepSegments}). Named by the digest tier over its
 * segments, derived from them (retained as its sample group) and generated by
 * the activity that names the grouping rule and its version.
 */
export interface SleepSessionRecord {
  kind: 'sleepSession';
  iri: string;
  fileKey: string;
  periodStart: string;
  periodEnd: string;
  /** Local midnight, as a UTC instant, of the day the session ends (the day of waking), in {@link datedInZone}. */
  date: string;
  /** The zone the date was read in: the session's recorded zone, else the pod's day zone. */
  datedInZone: string;
  /** The zone the SOURCE recorded (`HKTimeZone`), when it did. Only this is written as health:timeZone. */
  recordedZone?: string;
  stages: Partial<Record<SleepStageProperty, number>>;
  segmentCount: number;
  sourceName: string;
  deviceIri?: string;
  derivedFrom: string;
  generatedBy: string;
}

/** One paired blood pressure reading, from one HealthKit blood pressure correlation. Never a daily average. */
export interface BloodPressureRecord {
  kind: 'bloodPressure';
  iri: string;
  fileKey: string;
  /** The reading's instant (the correlation's start), UTC. */
  date: string;
  systolic: number;
  diastolic: number;
  snomed: string;
  loinc: string;
  sourceRecordId?: string;
  sourceName: string;
  deviceIri?: string;
  /** Set only on a reading this importer paired (no correlation): the pairing rule's activity. */
  generatedBy?: string;
}

/** One reading of a type written one record per sample (a VO2 max estimate), never a daily series. */
export interface VitalSignReadingRecord {
  kind: 'vitalSignReading';
  iri: string;
  fileKey: string;
  hkType: string;
  date: string;
  value: number;
  unit: string;
  snomed: string;
  loinc?: string;
  /** `clinical:measurementMethod`, mapped from the source's metadata by the rules table. */
  method?: string;
  sourceName: string;
  deviceIri?: string;
}

export interface ActivitySummaryRecord {
  kind: 'activitySummary';
  iri: string;
  fileKey: string;
  date: string;
  periodStart: string;
  periodEnd: string;
  timeZone: string;
  sourceName: string;
  activeEnergyKcal?: number;
  exerciseMinutes?: number;
  standHours?: number;
}

export interface WorkoutRecord {
  kind: 'workout';
  iri: string;
  fileKey: string;
  activityType: string;
  periodStart: string;
  periodEnd: string;
  timeZone?: string;
  durationMinutes?: number;
  distanceMeters?: number;
  activeEnergyKcal?: number;
  averageHeartRate?: number;
  maximumHeartRate?: number;
  indoor?: boolean;
  sourceRecordId?: string;
  sourceName: string;
  deviceIri?: string;
}

export interface DeviceRecord {
  kind: 'device';
  iri: string;
  fileKey: string;
  name: string;
  model?: string;
  hardware?: string;
  manufacturers: string[];
  softwareVersions: string[];
}

/**
 * The samples one aggregate group (day, type, source, device) was computed
 * from. Named from their sample digest alone, the same digest that is an input
 * to every aggregate's name, so an aggregate's name fixes its group's name and
 * a group's triples depend on nothing but that digest.
 */
export interface SampleGroup {
  iri: string;
  /** What was derived from the group: a set of daily aggregates, or one sleep session. */
  derived: 'aggregates' | 'sleep-session';
  /** {@link wellnessSampleDigest} of the samples the group's aggregates were computed from. */
  sampleDigest: string;
}

/** A retained sample pack: one closed day's samples, grouped. Its bytes go to the caller's writer. */
export interface SampleFile {
  iri: string;
  /** Lowercase hex SHA-256 of the pack's bytes: the file's name under attachments/sha-256/. */
  digest: string;
  byteSize: number;
  localDate: string;
  timeZone: string;
  /** The groups the pack holds, sorted by sample digest. */
  groups: SampleGroup[];
}

export interface RuleActivity {
  iri: string;
  rule: string;
  ruleVersion: string;
}

export type WellnessRecord =
  | VitalReadingRecord
  | ActivitySnapshotRecord
  | ActivitySummaryRecord
  | WorkoutRecord
  | DeviceRecord
  | SleepSessionRecord
  | BloodPressureRecord
  | VitalSignReadingRecord;

export interface AggregationResult {
  records: WellnessRecord[];
  sampleFiles: SampleFile[];
  /** The activity every computed daily aggregate names. */
  activity: RuleActivity;
  /** The activity every Apple sleep session names: the grouping rule and its version. */
  sleepActivity: RuleActivity;
  /** The activity every blood pressure reading this importer paired (no correlation) names. */
  bpPairingActivity: RuleActivity;
  coverageEnd?: number;
  closedDays: number;
  openDaysSkipped: number;
  /** Samples written to a retained sample file (every sample of a closed day). */
  samplesRetained: number;
  samplesAggregated: number;
  /** `type unit` -> samples skipped because the rules table does not accept the unit. */
  unknownUnits: Record<string, number>;
  /** Samples skipped because their value is not a number. */
  nonNumericSamples: number;
  activitySummariesSkipped: { sentinel: number; openDay: number; empty: number };
  sleep: {
    /** Sessions written, from closed groups of segments. */
    sessions: number;
    /** Groups of segments still open at the export's coverage end (a later export completes them). */
    openSkipped: number;
    /** Segments read. */
    segments: number;
    /** Closed segments in no session (an awake run counted as a gap, a group with no sleep, an unknown value), retained unassigned. */
    unassignedSegments: number;
    /** Sleep values the rules table does not map, and how many segments carry each. */
    unknownValues: Record<string, number>;
  };
  bloodPressure: {
    /** Readings written: from correlations, plus `pairedFromComponents`. */
    readings: number;
    /** Correlations without exactly one systolic and one diastolic value in an accepted unit. */
    unpaired: number;
    /** Top-level components identical to a correlation's component, skipped. */
    componentCopies: number;
    /** Top-level components at a correlated instant that repeat that reading with another creation time or value, skipped. */
    componentRepeats: number;
    /** Top-level components at an instant no correlation from their source covers. */
    uncorrelatedComponents: number;
    /** Readings the pairing rule made from those. */
    pairedFromComponents: number;
    /** Uncorrelated components not paired, by reason (components, not readings). */
    uncorrelatedDropped: { lone: number; ambiguous: number; invalid: number };
  };
  readings: {
    /** Per reading type: records written, and how many carried a method value the rules table does not map. */
    [hkType: string]: { written: number; skipped: number; unknownMethods: number };
  };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function urn(seed: string): string {
  return `urn:uuid:${deterministicUuid(seed)}`;
}

/** The IRI of the activity naming a derivation rule at one version, in one pod. */
export function ruleActivityIri(podSubject: string, rule: string, ruleVersion: string): string {
  return urn(wellnessSupportSeed({ podSubject, kind: 'rule', key: `${rule}/${ruleVersion}` }));
}

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/** The measured D-WELLNESS-1 digest field set for one sample, instants normalized to UTC. */
function sampleFields(s: SpilledSample, k: SeriesKey): string[] {
  return [
    k.type,
    k.sourceName,
    k.unit,
    isoUtc(s.start),
    isoUtc(s.end),
    s.value,
    k.sourceVersion,
    s.creation === null ? '' : isoUtc(s.creation),
    k.device,
  ];
}

function compareSamples(a: SpilledSample, b: SpilledSample): number {
  return (
    a.start - b.start ||
    a.end - b.end ||
    (a.creation ?? -Infinity) - (b.creation ?? -Infinity) ||
    cmpStr(a.value, b.value) ||
    cmpStr(a.syncIdentifier ?? '', b.syncIdentifier ?? '') ||
    cmpStr(a.syncVersion ?? '', b.syncVersion ?? '') ||
    cmpStr(a.externalUuid ?? '', b.externalUuid ?? '')
  );
}

function seriesSortKey(k: SeriesKey): Buffer {
  return Buffer.from(JSON.stringify([k.type, k.sourceName, k.sourceVersion, k.unit, k.device]), 'utf8');
}

/** One series of samples as packed columns. */
function packSeries(k: SeriesKey, list: SpilledSample[], dayStart: number): Record<string, unknown> {
  list.sort(compareSamples);
  const col: Record<string, unknown> = {
    type: k.type,
    sourceName: k.sourceName,
    sourceVersion: k.sourceVersion,
    unit: k.unit,
    device: k.device,
    start: list.map((s) => Math.round((s.start - dayStart) / 1000)),
    duration: list.map((s) => Math.round((s.end - s.start) / 1000)),
    creation: list.map((s) => (s.creation === null ? null : Math.round(s.creation / 1000))),
    value: list.map((s) => s.value),
  };
  if (list.some((s) => s.syncIdentifier !== null)) col.syncIdentifier = list.map((s) => s.syncIdentifier);
  if (list.some((s) => s.syncVersion !== null)) col.syncVersion = list.map((s) => s.syncVersion);
  if (list.some((s) => s.externalUuid !== null)) col.externalUuid = list.map((s) => s.externalUuid);
  // Sleep segments only: the zone the source recorded on each.
  if (list.some((s) => (s.timeZone ?? null) !== null)) col.timeZone = list.map((s) => s.timeZone ?? null);
  return col;
}

/** Samples split by series, in canonical series order, each series packed. */
function packAll(samples: SpilledSample[], series: SeriesKey[], dayStart: number): Record<string, unknown>[] {
  const bySeries = new Map<number, SpilledSample[]>();
  for (const s of samples) {
    let a = bySeries.get(s.series);
    if (!a) bySeries.set(s.series, (a = []));
    a.push(s);
  }
  return [...bySeries.entries()]
    .sort((x, y) => Buffer.compare(seriesSortKey(series[x[0]]), seriesSortKey(series[y[0]])))
    .map(([idx, list]) => packSeries(series[idx], list, dayStart));
}

/**
 * The compact, canonical sample pack for one closed day: packed columns per
 * series, never one node per sample. The samples an aggregate group used are
 * filed under that group's sample digest; samples no aggregate used (a unit
 * the rules do not accept, a value that is not a number) are kept too, under
 * `unaggregated`. Groups, series and samples are sorted, so the same samples
 * always produce the same bytes and therefore the same digest, whatever order
 * the export listed them in.
 */
function buildSampleFile(
  localDate: string,
  zone: string,
  start: number,
  end: number,
  groups: Array<{ sampleDigest: string; samples: SpilledSample[] }>,
  unaggregated: SpilledSample[],
  series: SeriesKey[],
): Buffer {
  const out = {
    format: 'cascade-wellness-samples',
    formatVersion: 2,
    source: 'apple-health-export',
    idSpace: 'healthkit',
    localDate,
    timeZone: zone,
    periodStart: isoUtc(start),
    periodEnd: isoUtc(end),
    columns: {
      start: 'seconds after periodStart',
      duration: 'seconds from start to end',
      creation: 'creationDate as seconds since the Unix epoch, or null',
      value: 'the value exactly as the export wrote it',
    },
    groups: [...groups]
      .sort((a, b) => cmpStr(a.sampleDigest, b.sampleDigest))
      .map((g) => ({ sampleDigest: g.sampleDigest, series: packAll(g.samples, series, start) })),
    unaggregated: packAll(unaggregated, series, start),
  };
  return Buffer.from(JSON.stringify(out) + '\n', 'utf8');
}

function statisticOf(stat: WellnessStatistic, sortedValues: number[]): number {
  switch (stat) {
    case 'minimum':
      return sortedValues[0];
    case 'maximum':
      return sortedValues[sortedValues.length - 1];
    case 'sum':
      return sortedValues.reduce((a, b) => a + b, 0);
    case 'average':
      return sortedValues.reduce((a, b) => a + b, 0) / sortedValues.length;
  }
}

/** Collects the devices the written records reference, with every attribute spelling seen. */
class DeviceRegistry {
  private readonly byIdentity = new Map<string, DeviceRecord>();

  constructor(
    private readonly podSubject: string,
    private readonly fileKey: string,
  ) {}

  /** Register the device a raw device string names; its IRI, or undefined when it names none. */
  note(rawDevice: string | undefined): string | undefined {
    const id = deviceIdentityOf(rawDevice);
    if (!id) return undefined;
    let rec = this.byIdentity.get(id.identity);
    if (!rec) {
      rec = {
        kind: 'device',
        iri: urn(wellnessDeviceSeed({ podSubject: this.podSubject, deviceIdentity: id.identity })),
        fileKey: this.fileKey,
        name: id.name,
        model: id.device.model,
        hardware: id.device.hardware,
        manufacturers: [],
        softwareVersions: [],
      };
      this.byIdentity.set(id.identity, rec);
    }
    if (id.device.model && !rec.model) rec.model = id.device.model;
    if (id.device.manufacturer && !rec.manufacturers.includes(id.device.manufacturer)) rec.manufacturers.push(id.device.manufacturer);
    if (id.device.software && !rec.softwareVersions.includes(id.device.software)) rec.softwareVersions.push(id.device.software);
    return rec.iri;
  }

  records(): DeviceRecord[] {
    return [...this.byIdentity.values()].map((d) => ({
      ...d,
      manufacturers: [...d.manufacturers].sort(cmpStr),
      softwareVersions: [...d.softwareVersions].sort(cmpStr),
    }));
  }
}

// ---------------------------------------------------------------------------
// The aggregation
// ---------------------------------------------------------------------------

export interface AggregateOptions {
  podSubject: string;
  dayZone: string;
  /**
   * Receives each closed day's sample pack as soon as it is built, BEFORE any
   * aggregate derived from it is returned, so the caller can write it and the
   * bytes need not be held until the end. Omitted, the bytes are dropped.
   */
  onSampleFile?: (file: SampleFile, bytes: Buffer) => void;
}

export function aggregate(scan: ScanResult, spill: SampleSpill, opts: AggregateOptions): AggregationResult {
  const rules = wellnessRules();
  const idSpace: WellnessIdSpace = rules.idSpace;
  const zone = opts.dayZone;
  const devices = new DeviceRegistry(opts.podSubject, rules.devices.file);
  const activity: RuleActivity = {
    iri: ruleActivityIri(opts.podSubject, rules.rule, rules.ruleVersion),
    rule: rules.rule,
    ruleVersion: rules.ruleVersion,
  };
  const bpPairingActivity: RuleActivity = {
    iri: urn(
      wellnessSupportSeed({
        podSubject: opts.podSubject,
        kind: 'rule',
        key: `${rules.bloodPressure.pairing.rule}/${rules.bloodPressure.pairing.ruleVersion}`,
      }),
    ),
    rule: rules.bloodPressure.pairing.rule,
    ruleVersion: rules.bloodPressure.pairing.ruleVersion,
  };
  const sleepActivity: RuleActivity = {
    iri: urn(wellnessSupportSeed({ podSubject: opts.podSubject, kind: 'rule', key: `${rules.sleep.rule}/${rules.sleep.ruleVersion}` })),
    rule: rules.sleep.rule,
    ruleVersion: rules.sleep.ruleVersion,
  };
  const result: AggregationResult = {
    records: [],
    sampleFiles: [],
    activity,
    sleepActivity,
    bpPairingActivity,
    coverageEnd: scan.exportDate ?? scan.maxSampleEnd,
    closedDays: 0,
    openDaysSkipped: 0,
    samplesRetained: 0,
    samplesAggregated: 0,
    unknownUnits: {},
    nonNumericSamples: 0,
    activitySummariesSkipped: { sentinel: 0, openDay: 0, empty: 0 },
    sleep: { sessions: 0, openSkipped: 0, segments: scan.sleepSegments.length, unassignedSegments: 0, unknownValues: {} },
    bloodPressure: {
      readings: 0,
      unpaired: 0,
      componentCopies: 0,
      componentRepeats: 0,
      uncorrelatedComponents: 0,
      pairedFromComponents: 0,
      uncorrelatedDropped: { lone: 0, ambiguous: 0, invalid: 0 },
    },
    readings: {},
    warnings: [],
  };
  if (scan.exportDate === undefined && scan.maxSampleEnd !== undefined) {
    result.warnings.push(
      'export.xml states no <ExportDate>; its coverage is taken to end at its latest sample, so the day that sample falls in is treated as open.',
    );
  }
  const coverageEnd = result.coverageEnd;
  const isClosed = (dayEnd: number): boolean => coverageEnd !== undefined && coverageEnd > dayEnd;

  // --- Sleep sessions, grouped over the whole export -----------------------
  // Each closed session's segments are retained as a sample group in the pack
  // of the pod-zone day the session ends in, and unassigned closed segments go
  // to that pack's `unaggregated` list, so a pack is built for such a day even
  // when the day itself is still open (its aggregates then wait for a later
  // export, which gives the day a new pack listing the same session group).
  const sleep = sleepSessionsOf(scan, opts.podSubject, zone, coverageEnd, sleepActivity, devices, result);
  const sleepByDay = new Map<string, { groups: Array<{ group: SampleGroup; samples: SpilledSample[] }>; unassigned: SpilledSample[]; records: SleepSessionRecord[] }>();
  const sleepDay = (localDate: string) => {
    let e = sleepByDay.get(localDate);
    if (!e) sleepByDay.set(localDate, (e = { groups: [], unassigned: [], records: [] }));
    return e;
  };
  for (const x of sleep.sessions) {
    const e = sleepDay(localDateOf(Date.parse(x.record.periodEnd), zone));
    e.groups.push({ group: x.group, samples: x.segments });
    e.records.push(x.record);
  }
  for (const x of sleep.unassigned) sleepDay(localDateOf(x.end, zone)).unassigned.push(x);

  // --- Computed aggregates, one closed local day at a time ---------------
  const utcDays = spill.days();
  const localDates = new Set<string>(sleepByDay.keys());
  for (const d of utcDays) {
    localDates.add(localDateOf(d * 86_400_000, zone));
    localDates.add(localDateOf((d + 1) * 86_400_000 - 1, zone));
  }
  const cache = new Map<number, SpilledSample[]>();
  const partition = (d: number): SpilledSample[] => {
    let p = cache.get(d);
    if (!p) {
      p = spill.read(d).map(decodeSample);
      cache.set(d, p);
      // Days are visited in ascending order, so only the last few partitions can be needed again.
      for (const k of cache.keys()) if (k < d - 2) cache.delete(k);
    }
    return p;
  };

  for (const localDate of [...localDates].sort(cmpStr)) {
    const { start, end } = dayIntervalUtc(localDate, zone);
    const daySleep = sleepByDay.get(localDate);
    const samples: SpilledSample[] = [];
    if (utcDays.length > 0) {
      for (let d = utcDayNumber(start); d <= utcDayNumber(end - 1); d++) {
        for (const s of partition(d)) if (s.start >= start && s.start < end) samples.push(s);
      }
    }
    if (samples.length === 0 && !daySleep) continue;
    const closed = isClosed(end);
    if (samples.length > 0 && !closed) result.openDaysSkipped++;
    if (!closed) samples.length = 0;
    if (samples.length > 0) result.closedDays++;
    result.samplesRetained += samples.length;
    const periodStart = isoUtc(start);
    const periodEnd = isoUtc(end);

    // Group by (type, source name, device identity). Never across sources.
    const groups = new Map<string, { type: string; sourceName: string; deviceRaw: string; samples: SpilledSample[] }>();
    for (const s of samples) {
      const k = scan.series[s.series];
      const deviceKey = deviceIdentityOf(k.device)?.identity ?? '';
      const gk = JSON.stringify([k.type, k.sourceName, deviceKey]);
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = { type: k.type, sourceName: k.sourceName, deviceRaw: k.device, samples: [] }));
      g.samples.push(s);
    }

    const packGroups: Array<{ sampleDigest: string; samples: SpilledSample[] }> = [];
    const unaggregated: SpilledSample[] = [];
    const dayGroups: SampleGroup[] = [];
    const dayRecords: WellnessRecord[] = [];
    for (const gk of [...groups.keys()].sort(cmpStr)) {
      const g = groups.get(gk)!;
      const rule = metricRuleFor(g.type);
      if (!rule) {
        appendAll(unaggregated, g.samples);
        continue;
      }
      const used: SpilledSample[] = [];
      const values: number[] = [];
      for (const s of g.samples) {
        const k = scan.series[s.series];
        const factor = rule.sourceUnits[k.unit];
        if (factor === undefined) {
          const key = `${k.type} ${k.unit || '(no unit)'}`;
          result.unknownUnits[key] = (result.unknownUnits[key] ?? 0) + 1;
          unaggregated.push(s);
          continue;
        }
        const v = Number(s.value);
        if (s.value.trim() === '' || !Number.isFinite(v)) {
          result.nonNumericSamples++;
          unaggregated.push(s);
          continue;
        }
        used.push(s);
        values.push(v * factor);
      }
      if (used.length === 0) continue;
      values.sort((a, b) => a - b);
      result.samplesAggregated += used.length;

      const sampleDigest = wellnessSampleDigest(used.map((s) => sampleFields(s, scan.series[s.series])));
      const group: SampleGroup = {
        iri: urn(wellnessSupportSeed({ podSubject: opts.podSubject, kind: 'sample-group', key: sampleDigest })),
        derived: 'aggregates',
        sampleDigest,
      };
      dayGroups.push(group);
      packGroups.push({ sampleDigest, samples: used });
      // Every series in a group shares one device identity; any of its raw strings names it.
      const deviceIri = devices.note(g.deviceRaw || undefined);
      for (const idx of new Set(used.map((u) => u.series))) devices.note(scan.series[idx].device || undefined);
      const deviceIdentity = deviceIdentityOf(g.deviceRaw)?.identity ?? '';

      for (const statistic of rule.statistics) {
        const iri = urn(
          wellnessDigestSeed({
            podSubject: opts.podSubject,
            idSpace,
            device: deviceIdentity,
            metric: g.type,
            statistic,
            periodStart,
            periodEnd,
            sampleDigest,
          }),
        );
        const base: AggregateBase = {
          iri,
          fileKey: rule.file,
          periodStart,
          periodEnd,
          timeZone: zone,
          statistic,
          sampleCount: used.length,
          sourceName: g.sourceName,
          deviceIri,
          derivedFrom: group.iri,
          generatedBy: activity.iri,
        };
        const value = statisticOf(statistic, values);
        if (rule.record === 'vitalReading') {
          dayRecords.push({
            ...base,
            kind: 'vitalReading',
            hkType: g.type,
            snomed: rule.snomed!,
            loinc: rule.loinc!,
            value: round(value, rules.valueDecimals),
            unit: rule.unit,
          });
        } else {
          const property = rule.property!;
          dayRecords.push({
            ...base,
            kind: 'activitySnapshot',
            property,
            value: property === 'steps' ? Math.round(value) : round(value, rules.valueDecimals),
          });
        }
      }
    }

    if (daySleep) {
      for (const g of daySleep.groups) {
        dayGroups.push(g.group);
        packGroups.push({ sampleDigest: g.group.sampleDigest, samples: g.samples });
        result.samplesRetained += g.samples.length;
      }
      appendAll(unaggregated, daySleep.unassigned);
      result.samplesRetained += daySleep.unassigned.length;
      appendAll(dayRecords, daySleep.records);
    }
    if (packGroups.length === 0 && unaggregated.length === 0) continue;

    // The pack is built and handed over BEFORE the day's aggregates join the
    // result: a derived view never exists without the samples it came from.
    const bytes = buildSampleFile(localDate, zone, start, end, packGroups, unaggregated, scan.series);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const file: SampleFile = {
      iri: urn(wellnessSupportSeed({ podSubject: opts.podSubject, kind: 'attachment', key: `sha-256/${digest}` })),
      digest,
      byteSize: bytes.length,
      localDate,
      timeZone: zone,
      groups: dayGroups.sort((a, b) => cmpStr(a.sampleDigest, b.sampleDigest)),
    };
    opts.onSampleFile?.(file, bytes);
    result.sampleFiles.push(file);
    appendAll(result.records, dayRecords);
  }

  // --- Apple's own daily rollups: source records, named by date ----------
  const summaryRule = rules.activitySummary;
  for (const a of scan.activitySummaries) {
    const date = a.dateComponents ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < summaryRule.earliestDate) {
      result.activitySummariesSkipped.sentinel++;
      continue;
    }
    const { start, end } = dayIntervalUtc(date, zone);
    if (!isClosed(end)) {
      result.activitySummariesSkipped.openDay++;
      continue;
    }
    const rec: ActivitySummaryRecord = {
      kind: 'activitySummary',
      iri: urn(wellnessSourceRecordSeed({ podSubject: opts.podSubject, idSpace, sourceId: date })),
      fileKey: summaryRule.file,
      date,
      periodStart: isoUtc(start),
      periodEnd: isoUtc(end),
      timeZone: zone,
      sourceName: summaryRule.sourceName,
    };
    const energy = Number(a.activeEnergyBurned);
    const energyUnit = a.activeEnergyBurnedUnit ?? 'kcal';
    const energyFactor = summaryRule.energyUnits[energyUnit];
    if (a.activeEnergyBurned !== undefined && Number.isFinite(energy)) {
      if (energyFactor === undefined) {
        const key = `ActivitySummary ${energyUnit}`;
        result.unknownUnits[key] = (result.unknownUnits[key] ?? 0) + 1;
      } else {
        rec.activeEnergyKcal = round(energy * energyFactor, rules.valueDecimals);
      }
    }
    const exercise = Number(a.appleExerciseTime);
    if (a.appleExerciseTime !== undefined && Number.isFinite(exercise)) rec.exerciseMinutes = Math.round(exercise);
    const stand = Number(a.appleStandHours);
    if (a.appleStandHours !== undefined && Number.isFinite(stand)) rec.standHours = Math.round(stand);
    if (rec.activeEnergyKcal === undefined && rec.exerciseMinutes === undefined && rec.standHours === undefined) {
      result.activitySummariesSkipped.empty++;
      continue;
    }
    result.records.push(rec);
  }

  // --- Workouts: source records --------------------------------------------
  for (const w of scan.workouts) {
    const rec = workoutRecord(w, opts.podSubject, idSpace, devices, result.warnings);
    if (rec) result.records.push(rec);
  }

  // --- Blood pressure: one record per paired reading, never a daily average --
  for (const c of scan.bloodPressureCorrelations) {
    const rec = bloodPressureRecord(c, opts.podSubject, idSpace, devices, result);
    if (rec) {
      result.records.push(rec);
      result.bloodPressure.readings++;
    } else {
      result.bloodPressure.unpaired++;
    }
  }
  for (const rec of uncorrelatedBloodPressure(scan, opts.podSubject, idSpace, devices, result, bpPairingActivity)) {
    result.records.push(rec);
    result.bloodPressure.readings++;
  }
  const dropped = result.bloodPressure.uncorrelatedDropped;
  const droppedTotal = dropped.lone + dropped.ambiguous + dropped.invalid;
  if (droppedTotal > 0) {
    result.warnings.push(
      `${droppedTotal} top-level blood pressure component(s) with no correlation could not be paired ` +
        `(${dropped.lone} with no other half, ${dropped.ambiguous} with more than one of a half, ${dropped.invalid} not a number in an accepted unit) and were not imported.`,
    );
  }
  if (result.bloodPressure.unpaired > 0) {
    result.warnings.push(
      `${result.bloodPressure.unpaired} blood pressure correlation(s) did not hold exactly one systolic and one diastolic value ` +
        'in an accepted unit, with a parseable time, and were not imported.',
    );
  }

  // --- Individual readings (VO2 max): one record per sample ------------------
  for (const r of scan.readings) {
    const type = r.attrs.type ?? '';
    const tally = (result.readings[type] ??= { written: 0, skipped: 0, unknownMethods: 0 });
    const rec = vitalSignReadingRecord(r, opts.podSubject, idSpace, devices, result, tally);
    if (rec) {
      result.records.push(rec);
      tally.written++;
    } else {
      tally.skipped++;
    }
  }

  appendAll(result.records, devices.records());
  return result;
}

// ---------------------------------------------------------------------------
// Source elements named by the digest tier
// ---------------------------------------------------------------------------

/**
 * The digest-tier fields of an export element that carries no identifier:
 * its attributes sorted by name (device address stripped, instants in UTC),
 * then its metadata sorted by key.
 */
function elementFields(attrs: Record<string, string>, metadata: Record<string, string>): string[] {
  const fields: string[] = [];
  for (const k of Object.keys(attrs).sort(cmpStr)) {
    let v = attrs[k];
    if (k === 'device') v = stripDeviceAddress(v);
    else if (k === 'startDate' || k === 'endDate' || k === 'creationDate') {
      const ms = parseAppleTimestamp(v);
      if (ms !== undefined) v = isoUtc(ms);
    }
    fields.push(`${k}=${v}`);
  }
  for (const k of Object.keys(metadata).sort(cmpStr)) fields.push(`metadata:${k}=${metadata[k]}`);
  return fields;
}

/** The source's own identifier on an element, when it supplies one (tier 1). */
function sourceIdOf(metadata: Record<string, string>): string | undefined {
  return metadata.HKExternalUUID || metadata.HKMetadataKeySyncIdentifier || undefined;
}

// ---------------------------------------------------------------------------
// Blood pressure
// ---------------------------------------------------------------------------

/**
 * One reading from one HealthKit blood pressure correlation: its nested
 * systolic and diastolic records, exactly one of each, paired by the source.
 * Never paired by guessing from the top-level copies (the scan skips those),
 * and never averaged. Named by the source's identifier on the correlation
 * (tier 1), else by the digest tier over the correlation's own fields: its
 * attributes, its metadata and its nested records.
 */
function bloodPressureRecord(
  c: { attrs: Record<string, string>; metadata: Record<string, string>; records: RecordElement[] },
  podSubject: string,
  idSpace: WellnessIdSpace,
  devices: DeviceRegistry,
  result: AggregationResult,
  pairedBy?: RuleActivity,
): BloodPressureRecord | undefined {
  const rules = wellnessRules();
  const bp = rules.bloodPressure;
  const sys = c.records.filter((r) => r.attrs.type === bp.systolicType);
  const dia = c.records.filter((r) => r.attrs.type === bp.diastolicType);
  if (sys.length !== 1 || dia.length !== 1) return undefined;
  const valueOf = (r: RecordElement): number | undefined => {
    const unit = r.attrs.unit ?? '';
    const factor = bp.sourceUnits[unit];
    if (factor === undefined) {
      const key = `${r.attrs.type ?? ''} ${unit || '(no unit)'}`;
      result.unknownUnits[key] = (result.unknownUnits[key] ?? 0) + 1;
      return undefined;
    }
    const raw = r.attrs.value ?? '';
    const v = Number(raw);
    return raw.trim() === '' || !Number.isFinite(v) ? undefined : round(v * factor, rules.valueDecimals);
  };
  const systolic = valueOf(sys[0]);
  const diastolic = valueOf(dia[0]);
  const start = parseAppleTimestamp(c.attrs.startDate);
  const end = parseAppleTimestamp(c.attrs.endDate);
  if (systolic === undefined || diastolic === undefined || start === undefined || end === undefined) return undefined;

  // A pair this importer made has no identifier of its own: its two records are its fields.
  const sourceId = pairedBy ? undefined : sourceIdOf(c.metadata);
  let iri: string;
  if (sourceId) {
    iri = urn(wellnessSourceRecordSeed({ podSubject, idSpace, sourceId }));
  } else {
    const fields = pairedBy ? [] : elementFields(c.attrs, c.metadata);
    const nested = c.records.map((r) => elementFields(r.attrs, r.metadata).join('\u0000')).sort(cmpStr);
    for (const n of nested) fields.push(`records:${n}`);
    iri = urn(
      wellnessDigestSeed({
        podSubject,
        idSpace,
        device: deviceIdentityOf(c.attrs.device)?.identity ?? '',
        metric: bp.correlationType,
        statistic: '',
        periodStart: isoUtc(start),
        periodEnd: isoUtc(end),
        sampleDigest: wellnessSampleDigest([fields]),
      }),
    );
  }
  const rec: BloodPressureRecord = {
    kind: 'bloodPressure',
    iri,
    fileKey: bp.file,
    date: isoUtc(start),
    systolic,
    diastolic,
    snomed: bp.snomed,
    loinc: bp.loinc,
    sourceName: c.attrs.sourceName ?? '',
    deviceIri: devices.note(c.attrs.device),
  };
  if (sourceId) rec.sourceRecordId = sourceId;
  if (pairedBy) rec.generatedBy = pairedBy.iri;
  return rec;
}

/**
 * THE UNCORRELATED BLOOD PRESSURE PAIRING RULE (`bloodPressure.pairing` in the
 * rules table, stamped on every reading it makes through its generating
 * activity). The export repeats each correlation's components as top-level
 * records, and a source can also write a systolic and a diastolic record with
 * no correlation at all. Top-level components are grouped by (source, start,
 * end):
 *
 *   - At an instant where a correlation component from that source sits, they
 *     are a copy of it (identical type, value, times) or a repeat of the same
 *     reading, and are counted and skipped: the correlation is the reading.
 *   - Elsewhere, exactly one systolic and one diastolic is one reading (FHIR
 *     panel 85354-9, Open mHealth blood-pressure: one paired measurement).
 *     A lone half, or more than one of either, is not paired, and is counted.
 */
function uncorrelatedBloodPressure(
  scan: ScanResult,
  podSubject: string,
  idSpace: WellnessIdSpace,
  devices: DeviceRegistry,
  result: AggregationResult,
  activity: RuleActivity,
): BloodPressureRecord[] {
  const bp = wellnessRules().bloodPressure;
  const t = (v: string | undefined): string => {
    const ms = parseAppleTimestamp(v);
    return ms === undefined ? `raw:${v ?? ''}` : isoUtc(ms);
  };
  const instant = (a: Record<string, string>): string => JSON.stringify([a.sourceName ?? '', t(a.startDate), t(a.endDate)]);
  const identical = (a: Record<string, string>): string =>
    JSON.stringify([instant(a), a.type ?? '', a.value ?? '', a.unit ?? '', t(a.creationDate)]);
  const covered = new Set<string>();
  const copies = new Set<string>();
  for (const c of scan.bloodPressureCorrelations) {
    for (const r of c.records) {
      covered.add(instant(r.attrs));
      copies.add(identical(r.attrs));
    }
  }
  const groups = new Map<string, RecordElement[]>();
  for (const r of scan.bloodPressureComponents) {
    const k = instant(r.attrs);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(r);
  }
  const out: BloodPressureRecord[] = [];
  const tally = result.bloodPressure;
  for (const k of [...groups.keys()].sort(cmpStr)) {
    const g = groups.get(k)!;
    if (covered.has(k)) {
      for (const r of g) {
        if (copies.has(identical(r.attrs))) tally.componentCopies++;
        else tally.componentRepeats++;
      }
      continue;
    }
    tally.uncorrelatedComponents += g.length;
    const sys = g.filter((r) => r.attrs.type === bp.systolicType);
    const dia = g.filter((r) => r.attrs.type === bp.diastolicType);
    if (sys.length !== 1 || dia.length !== 1) {
      if (sys.length === 0 || dia.length === 0) tally.uncorrelatedDropped.lone += g.length;
      else tally.uncorrelatedDropped.ambiguous += g.length;
      continue;
    }
    const a = sys[0].attrs;
    const pair = {
      attrs: { sourceName: a.sourceName ?? '', startDate: a.startDate ?? '', endDate: a.endDate ?? '', ...(a.device ? { device: a.device } : {}) },
      metadata: {},
      records: [sys[0], dia[0]],
    };
    const rec = bloodPressureRecord(pair, podSubject, idSpace, devices, result, activity);
    if (rec) {
      out.push(rec);
      tally.pairedFromComponents++;
    } else {
      tally.uncorrelatedDropped.invalid += g.length;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Individual readings (VO2 max)
// ---------------------------------------------------------------------------

/**
 * One record per sample of a reading type: an estimate at its own instant,
 * never folded into a daily series. Named by the source's identifier (tier 1),
 * else by the digest tier over the sample's measured field set. The method is
 * mapped from the source's metadata by the rules table; an unmapped value
 * writes no method and is counted.
 */
function vitalSignReadingRecord(
  r: RecordElement,
  podSubject: string,
  idSpace: WellnessIdSpace,
  devices: DeviceRegistry,
  result: AggregationResult,
  tally: { unknownMethods: number },
): VitalSignReadingRecord | undefined {
  const rules = wellnessRules();
  const a = r.attrs;
  const type = a.type ?? '';
  const rule = readingRuleFor(type);
  if (!rule) return undefined;
  const start = parseAppleTimestamp(a.startDate);
  const end = parseAppleTimestamp(a.endDate);
  if (start === undefined || end === undefined || a.value === undefined) return undefined;
  const unit = a.unit ?? '';
  const factor = rule.sourceUnits[unit];
  if (factor === undefined) {
    const key = `${type} ${unit || '(no unit)'}`;
    result.unknownUnits[key] = (result.unknownUnits[key] ?? 0) + 1;
    return undefined;
  }
  const v = Number(a.value);
  if (a.value.trim() === '' || !Number.isFinite(v)) {
    result.nonNumericSamples++;
    return undefined;
  }
  const device = a.device ? stripDeviceAddress(a.device) : '';
  const sourceId = sourceIdOf(r.metadata);
  const iri = sourceId
    ? urn(wellnessSourceRecordSeed({ podSubject, idSpace, sourceId }))
    : urn(
        wellnessDigestSeed({
          podSubject,
          idSpace,
          device: deviceIdentityOf(a.device)?.identity ?? '',
          metric: type,
          statistic: '',
          periodStart: isoUtc(start),
          periodEnd: isoUtc(end),
          sampleDigest: wellnessSampleDigest([
            sampleFields(
              {
                series: 0,
                start,
                end,
                creation: parseAppleTimestamp(a.creationDate) ?? null,
                value: a.value,
                syncIdentifier: null,
                syncVersion: null,
                externalUuid: null,
              },
              { type, sourceName: a.sourceName ?? '', sourceVersion: a.sourceVersion ?? '', unit, device },
            ),
          ]),
        }),
      );
  const rec: VitalSignReadingRecord = {
    kind: 'vitalSignReading',
    iri,
    fileKey: rule.file,
    hkType: type,
    date: isoUtc(start),
    value: round(v * factor, rules.valueDecimals),
    unit: rule.unit,
    snomed: rule.snomed,
    sourceName: a.sourceName ?? '',
    deviceIri: devices.note(a.device),
  };
  if (rule.loinc) rec.loinc = rule.loinc;
  if (rule.method) {
    const raw = r.metadata[rule.method.metadataKey];
    if (raw !== undefined) {
      const mapped = rule.method.values[raw];
      if (mapped) rec.method = mapped;
      else tally.unknownMethods++;
    }
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Sleep sessions
// ---------------------------------------------------------------------------

/**
 * THE APPLE SLEEP GROUPING RULE (the `sleep` block of the rules table; its
 * `rule`/`ruleVersion` is stamped on every session through its generating
 * activity). Input: one source's segments with a mapped sleep value.
 *
 *   1. Segments sorted by start are one group until the next segment starts a
 *      gap of `gapMinutes` or more after the latest end so far: 59 minutes
 *      apart is one group, 60 or more is two.
 *   2. Within a group, a run of consecutive awake segments (in start order,
 *      no other segment between them) spanning `awakeRunMinutes` or more
 *      counts as such a gap: the segments before it are one session, the
 *      segments after it the next, and the run itself belongs to neither.
 *   3. A piece holding no asleep segment (only awake, only in bed, or both) is
 *      not a session: a sleep episode runs from sleep onset to final waking
 *      (IEEE 1752.1), and such a piece holds neither.
 *
 * Naps are therefore separate sessions whenever an hour separates them from
 * the night. Returns the sessions and the segments no session holds.
 */
export function groupSleepSegments(
  segments: SpilledSample[],
  isAwake: (s: SpilledSample) => boolean,
  isAsleep: (s: SpilledSample) => boolean,
  rule: Pick<WellnessSleepRule, 'gapMinutes' | 'awakeRunMinutes'>,
): { groups: SpilledSample[][]; sessions: SpilledSample[][]; unassigned: SpilledSample[] } {
  const gapMs = rule.gapMinutes * 60_000;
  const awakeRunMs = rule.awakeRunMinutes * 60_000;
  const sorted = [...segments].sort(compareSamples);
  const groups: SpilledSample[][] = [];
  let cur: SpilledSample[] = [];
  let maxEnd = -Infinity;
  for (const seg of sorted) {
    if (cur.length > 0 && seg.start - maxEnd >= gapMs) {
      groups.push(cur);
      cur = [];
      maxEnd = -Infinity;
    }
    cur.push(seg);
    if (seg.end > maxEnd) maxEnd = seg.end;
  }
  if (cur.length > 0) groups.push(cur);

  const sessions: SpilledSample[][] = [];
  const unassigned: SpilledSample[] = [];
  for (const g of groups) {
    const pieces: SpilledSample[][] = [];
    let piece: SpilledSample[] = [];
    let i = 0;
    while (i < g.length) {
      if (!isAwake(g[i])) {
        piece.push(g[i++]);
        continue;
      }
      let j = i;
      let runEnd = -Infinity;
      while (j < g.length && isAwake(g[j])) runEnd = Math.max(runEnd, g[j++].end);
      const run = g.slice(i, j);
      if (runEnd - g[i].start >= awakeRunMs) {
        pieces.push(piece);
        piece = [];
        appendAll(unassigned, run);
      } else {
        appendAll(piece, run);
      }
      i = j;
    }
    pieces.push(piece);
    for (const p of pieces) {
      if (p.length === 0) continue;
      if (!p.some(isAsleep)) appendAll(unassigned, p);
      else sessions.push(p);
    }
  }
  return { groups, sessions, unassigned };
}

/**
 * Every CLOSED Apple sleep session in the export, as a record plus the sample
 * group it derives from. A group of segments is closed when the export's
 * coverage ends at least one grouping gap after it: a segment the export could
 * not yet hold could otherwise still join it. An open group is left for a
 * later export, whole.
 *
 * A session is dated by the day it ENDS (the day of waking), read in its
 * recorded zone (the `HKTimeZone` of its latest-ending segment that has one),
 * else in the pod's day zone.
 */
function sleepSessionsOf(
  scan: ScanResult,
  podSubject: string,
  podZone: string,
  coverageEnd: number | undefined,
  activity: RuleActivity,
  devices: DeviceRegistry,
  result: AggregationResult,
): {
  sessions: Array<{ record: SleepSessionRecord; group: SampleGroup; segments: SpilledSample[] }>;
  unassigned: SpilledSample[];
} {
  const rules = wellnessRules();
  const rule = rules.sleep;
  const gapMs = rule.gapMinutes * 60_000;
  const isClosedAfter = (end: number): boolean => coverageEnd !== undefined && coverageEnd >= end + gapMs;
  const out: Array<{ record: SleepSessionRecord; group: SampleGroup; segments: SpilledSample[] }> = [];
  const unassigned: SpilledSample[] = [];

  // Per source: the source's name and its device identity. Never across sources.
  const bySource = new Map<string, SpilledSample[]>();
  for (const seg of scan.sleepSegments) {
    const k = scan.series[seg.series];
    if (rule.stages[seg.value] === undefined) {
      result.sleep.unknownValues[seg.value] = (result.sleep.unknownValues[seg.value] ?? 0) + 1;
      if (isClosedAfter(seg.end)) unassigned.push(seg);
      continue;
    }
    const key = JSON.stringify([k.sourceName, deviceIdentityOf(k.device)?.identity ?? '']);
    let a = bySource.get(key);
    if (!a) bySource.set(key, (a = []));
    a.push(seg);
  }
  const isAwake = (seg: SpilledSample): boolean => rule.stages[seg.value] === 'awakeMinutes';
  const isAsleep = (seg: SpilledSample): boolean => {
    const stage = rule.stages[seg.value];
    return stage !== 'awakeMinutes' && stage !== 'inBedMinutes';
  };

  for (const key of [...bySource.keys()].sort(cmpStr)) {
    const grouped = groupSleepSegments(bySource.get(key)!, isAwake, isAsleep, rule);
    const closedGroup = new Set<SpilledSample>();
    for (const g of grouped.groups) {
      const end = Math.max(...g.map((x) => x.end));
      if (isClosedAfter(end)) for (const x of g) closedGroup.add(x);
      else result.sleep.openSkipped++;
    }
    for (const x of grouped.unassigned) if (closedGroup.has(x)) unassigned.push(x);
    for (const segs of grouped.sessions) {
      if (!closedGroup.has(segs[0])) continue;
      const start = Math.min(...segs.map((x) => x.start));
      const end = Math.max(...segs.map((x) => x.end));
      const series = scan.series[segs[0].series];
      // The zone the source recorded: that of the latest-ending segment carrying a known one.
      let recordedZone: string | undefined;
      let zoneEnd = -Infinity;
      for (const x of segs) {
        const z = x.timeZone ? canonicalZone(x.timeZone) : undefined;
        // Segments are in canonical order, so a tie on the end goes to the later one in that order.
        if (z !== undefined && x.end >= zoneEnd) {
          recordedZone = z;
          zoneEnd = x.end;
        }
      }
      const datedInZone = recordedZone ?? podZone;
      const wakeDay = localDateOf(end, datedInZone);
      const stages: Partial<Record<SleepStageProperty, number>> = {};
      for (const x of segs) {
        const p = rule.stages[x.value];
        stages[p] = (stages[p] ?? 0) + (x.end - x.start) / 60_000;
      }
      for (const p of Object.keys(stages) as SleepStageProperty[]) stages[p] = round(stages[p]!, rules.valueDecimals);
      const sampleDigest = wellnessSampleDigest(segs.map((x) => sampleFields(x, scan.series[x.series])));
      const group: SampleGroup = {
        iri: urn(wellnessSupportSeed({ podSubject, kind: 'sample-group', key: sampleDigest })),
        derived: 'sleep-session',
        sampleDigest,
      };
      const deviceIdentity = deviceIdentityOf(series.device)?.identity ?? '';
      const record: SleepSessionRecord = {
        kind: 'sleepSession',
        iri: urn(
          wellnessDigestSeed({
            podSubject,
            idSpace: rules.idSpace,
            device: deviceIdentity,
            metric: rule.hkType,
            statistic: '',
            periodStart: isoUtc(start),
            periodEnd: isoUtc(end),
            sampleDigest,
          }),
        ),
        fileKey: rule.file,
        periodStart: isoUtc(start),
        periodEnd: isoUtc(end),
        date: isoUtc(dayIntervalUtc(wakeDay, datedInZone).start),
        datedInZone,
        recordedZone,
        stages,
        segmentCount: segs.length,
        sourceName: series.sourceName,
        deviceIri: devices.note(series.device || undefined),
        derivedFrom: group.iri,
        generatedBy: activity.iri,
      };
      out.push({ record, group, segments: segs });
    }
  }
  result.sleep.sessions = out.length;
  result.sleep.unassignedSegments = unassigned.length;
  return { sessions: out, unassigned };
}

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

function convert(value: string | undefined, unit: string | undefined, table: Record<string, number>): number | undefined {
  if (value === undefined) return undefined;
  const v = Number(value);
  if (value.trim() === '' || !Number.isFinite(v)) return undefined;
  const f = table[unit ?? ''];
  return f === undefined ? undefined : v * f;
}

function workoutRecord(
  w: WorkoutElement,
  podSubject: string,
  idSpace: WellnessIdSpace,
  devices: DeviceRegistry,
  warnings: string[],
): WorkoutRecord | undefined {
  const rules = wellnessRules();
  const u = rules.workouts;
  const a = w.attrs;
  const start = parseAppleTimestamp(a.startDate);
  const end = parseAppleTimestamp(a.endDate);
  const type = a.workoutActivityType;
  if (start === undefined || end === undefined || !type) {
    warnings.push('A <Workout> without a parseable start, end or activity type was not imported.');
    return undefined;
  }
  const periodStart = isoUtc(start);
  const periodEnd = isoUtc(end);
  const deviceIri = devices.note(a.device);

  const sourceId = w.metadata.HKExternalUUID || w.metadata.HKMetadataKeySyncIdentifier || undefined;
  let iri: string;
  if (sourceId) {
    iri = urn(wellnessSourceRecordSeed({ podSubject, idSpace, sourceId }));
  } else {
    // No identifier from the source: the digest tier over the element itself,
    // attributes and children sorted, instants in UTC, device address stripped.
    const fields = elementFields(a, w.metadata);
    const stats = w.statistics
      .map((s) => Object.keys(s).sort(cmpStr).map((k) => `${k}=${s[k]}`).join('\u0000'))
      .sort(cmpStr);
    for (const s of stats) fields.push(`statistics:${s}`);
    const deviceIdentity = deviceIdentityOf(a.device)?.identity ?? '';
    iri = urn(
      wellnessDigestSeed({
        podSubject,
        idSpace,
        device: deviceIdentity,
        metric: type,
        statistic: '',
        periodStart,
        periodEnd,
        sampleDigest: wellnessSampleDigest([fields]),
      }),
    );
  }

  const rec: WorkoutRecord = {
    kind: 'workout',
    iri,
    fileKey: u.file,
    activityType: `${idSpace}:${type}`,
    periodStart,
    periodEnd,
    sourceName: a.sourceName ?? '',
    deviceIri,
  };
  if (sourceId) rec.sourceRecordId = sourceId;
  const tz = w.metadata.HKTimeZone;
  if (tz && isKnownZone(tz)) rec.timeZone = tz;

  const decimals = rules.valueDecimals;
  const duration = convert(a.duration, a.durationUnit, u.durationUnits);
  if (duration !== undefined) rec.durationMinutes = round(duration, decimals);

  const stat = (suffix: string): Record<string, string> | undefined =>
    w.statistics.find((s) => s.type === `HKQuantityTypeIdentifier${suffix}`);
  let distance = convert(a.totalDistance, a.totalDistanceUnit, u.distanceUnits);
  if (distance === undefined) {
    const d = w.statistics.find((s) => (s.type ?? '').startsWith('HKQuantityTypeIdentifierDistance'));
    if (d) distance = convert(d.sum, d.unit, u.distanceUnits);
  }
  if (distance !== undefined) rec.distanceMeters = round(distance, decimals);
  let energy = convert(a.totalEnergyBurned, a.totalEnergyBurnedUnit, u.energyUnits);
  if (energy === undefined) {
    const e = stat('ActiveEnergyBurned');
    if (e) energy = convert(e.sum, e.unit, u.energyUnits);
  }
  if (energy !== undefined) rec.activeEnergyKcal = round(energy, decimals);
  const hr = stat('HeartRate');
  if (hr && hr.unit === 'count/min') {
    const avg = convert(hr.average, 'x', { x: 1 });
    const max = convert(hr.maximum, 'x', { x: 1 });
    if (avg !== undefined) rec.averageHeartRate = round(avg, decimals);
    if (max !== undefined) rec.maximumHeartRate = round(max, decimals);
  }
  const indoor = w.metadata.HKIndoorWorkout;
  if (indoor === '1' || indoor === '0') rec.indoor = indoor === '1';
  return rec;
}

/**
 * The pod's day-zone default from an export: the most frequent `HKTimeZone`,
 * ties broken by name. Aliases are counted as the one zone they name, and the
 * zone returned is its canonical name, never an alias the export happened to use.
 */
export function majorityTimeZone(counts: Map<string, number>): string | undefined {
  const canonical = new Map<string, number>();
  for (const [zone, n] of counts) {
    const c = canonicalZone(zone);
    if (c !== undefined) canonical.set(c, (canonical.get(c) ?? 0) + n);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [zone, n] of [...canonical.entries()].sort((x, y) => cmpStr(x[0], y[0]))) {
    if (n > bestCount) {
      best = zone;
      bestCount = n;
    }
  }
  return best;
}
