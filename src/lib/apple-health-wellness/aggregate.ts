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
 * one, by a digest of the element.
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
import { wellnessRules, metricRuleFor, type WellnessStatistic } from './rules.js';
import { canonicalZone, dayIntervalUtc, isKnownZone, isoUtc, localDateOf, parseAppleTimestamp, utcDayNumber } from './time.js';
import { deviceIdentityOf, stripDeviceAddress } from './device.js';
import { decodeSample, type ScanResult, type SeriesKey, type SpilledSample, type WorkoutElement } from './scan.js';
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

export interface StepSnapshotRecord extends AggregateBase {
  kind: 'stepSnapshot';
  steps: number;
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

export type WellnessRecord = VitalReadingRecord | StepSnapshotRecord | ActivitySummaryRecord | WorkoutRecord | DeviceRecord;

export interface AggregationResult {
  records: WellnessRecord[];
  sampleFiles: SampleFile[];
  activity: RuleActivity;
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
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function urn(seed: string): string {
  return `urn:uuid:${deterministicUuid(seed)}`;
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
    iri: urn(wellnessSupportSeed({ podSubject: opts.podSubject, kind: 'rule', key: `${rules.rule}/${rules.ruleVersion}` })),
    rule: rules.rule,
    ruleVersion: rules.ruleVersion,
  };
  const result: AggregationResult = {
    records: [],
    sampleFiles: [],
    activity,
    coverageEnd: scan.exportDate ?? scan.maxSampleEnd,
    closedDays: 0,
    openDaysSkipped: 0,
    samplesRetained: 0,
    samplesAggregated: 0,
    unknownUnits: {},
    nonNumericSamples: 0,
    activitySummariesSkipped: { sentinel: 0, openDay: 0, empty: 0 },
    warnings: [],
  };
  if (scan.exportDate === undefined && scan.maxSampleEnd !== undefined) {
    result.warnings.push(
      'export.xml states no <ExportDate>; its coverage is taken to end at its latest sample, so the day that sample falls in is treated as open.',
    );
  }
  const coverageEnd = result.coverageEnd;
  const isClosed = (dayEnd: number): boolean => coverageEnd !== undefined && coverageEnd > dayEnd;

  // --- Computed aggregates, one closed local day at a time ---------------
  const utcDays = spill.days();
  const localDates = new Set<string>();
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
    const samples: SpilledSample[] = [];
    for (let d = utcDayNumber(start); d <= utcDayNumber(end - 1); d++) {
      for (const s of partition(d)) if (s.start >= start && s.start < end) samples.push(s);
    }
    if (samples.length === 0) continue;
    if (!isClosed(end)) {
      result.openDaysSkipped++;
      continue;
    }
    result.closedDays++;
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
          dayRecords.push({ ...base, kind: 'stepSnapshot', steps: Math.round(value) });
        }
      }
    }

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

  appendAll(result.records, devices.records());
  return result;
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
    const fields: string[] = [];
    for (const k of Object.keys(a).sort(cmpStr)) {
      let v = a[k];
      if (k === 'device') v = stripDeviceAddress(v);
      else if (k === 'startDate' || k === 'endDate' || k === 'creationDate') {
        const ms = parseAppleTimestamp(v);
        if (ms !== undefined) v = isoUtc(ms);
      }
      fields.push(`${k}=${v}`);
    }
    for (const k of Object.keys(w.metadata).sort(cmpStr)) fields.push(`metadata:${k}=${w.metadata[k]}`);
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
