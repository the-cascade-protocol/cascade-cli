/**
 * Pass 1 over `export.xml`: one streaming read, bounded memory.
 *
 * What it keeps, and where:
 *   - every sample of an aggregated type (the rules table decides which), as a
 *     compact line in the encrypted spill, partitioned by the UTC day of its
 *     start instant; the series fields shared by many samples (type, source,
 *     version, unit, device) are kept once, in a series table;
 *   - every top-level `<Workout>` and every `<ActivitySummary>`, in memory
 *     (thousands, not millions);
 *   - the `<ExportDate>`, which is the export's coverage end, and a count of
 *     each `HKTimeZone` value, the default for the pod's day zone.
 *
 * THE CORRELATION RULE. The export's own DTD says: "Any Records that appear as
 * children of a correlation also appear as top-level records in this
 * document." A reader that takes both double counts (the measured case: 251
 * blood-pressure readings reported as 473). So only TOP-LEVEL records are
 * read, and a `<Record>` anywhere inside a `<Correlation>` is skipped and
 * counted.
 */

import { scanXml, type XmlEvent } from './xml-scanner.js';
import { parseAppleTimestamp, utcDayNumber } from './time.js';
import { metricRuleFor } from './rules.js';
import { stripDeviceAddress } from './device.js';
import type { SampleSpill } from './spill.js';

/** The fields a run of samples shares. `device` has its per-export address stripped. */
export interface SeriesKey {
  type: string;
  sourceName: string;
  sourceVersion: string;
  unit: string;
  device: string;
}

/** One spilled sample. Instants are epoch milliseconds. */
export interface SpilledSample {
  series: number;
  start: number;
  end: number;
  creation: number | null;
  value: string;
  syncIdentifier: string | null;
  syncVersion: string | null;
  externalUuid: string | null;
}

export interface WorkoutElement {
  attrs: Record<string, string>;
  metadata: Record<string, string>;
  statistics: Array<Record<string, string>>;
}

export interface ScanResult {
  series: SeriesKey[];
  /** The `<ExportDate>` instant, when the file states one. */
  exportDate?: number;
  /** The latest sample end seen, the coverage end when there is no `<ExportDate>`. */
  maxSampleEnd?: number;
  workouts: WorkoutElement[];
  activitySummaries: Array<Record<string, string>>;
  /** `HKTimeZone` metadata values and how often each appears. */
  timeZoneCounts: Map<string, number>;
  /** Top-level `<Record>` elements read, of any type. */
  recordsRead: number;
  /** Of those, samples of an aggregated type written to the spill. */
  samplesSpilled: number;
  /** `<Record>` elements skipped because they sit inside a `<Correlation>`. */
  correlationRecordsSkipped: number;
  /** Aggregated-type samples dropped because a timestamp would not parse. */
  invalidSamples: number;
}

/** Serialize a spilled sample as one spill line. */
export function encodeSample(s: SpilledSample): string {
  return JSON.stringify([s.series, s.start, s.end, s.creation, s.value, s.syncIdentifier, s.syncVersion, s.externalUuid]);
}

/** Parse one spill line. */
export function decodeSample(line: string): SpilledSample {
  const a = JSON.parse(line) as [number, number, number, number | null, string, string | null, string | null, string | null];
  return {
    series: a[0],
    start: a[1],
    end: a[2],
    creation: a[3],
    value: a[4],
    syncIdentifier: a[5],
    syncVersion: a[6],
    externalUuid: a[7],
  };
}

interface OpenRecord {
  attrs: Record<string, string>;
  metadata: Record<string, string>;
}

/** Read `export.xml` once, from a stream of text chunks, spilling samples into `spill`. */
export async function scanExport(chunks: AsyncIterable<string>, spill: SampleSpill): Promise<ScanResult> {
  const series: SeriesKey[] = [];
  const seriesIndex = new Map<string, number>();
  const result: ScanResult = {
    series,
    workouts: [],
    activitySummaries: [],
    timeZoneCounts: new Map(),
    recordsRead: 0,
    samplesSpilled: 0,
    correlationRecordsSkipped: 0,
    invalidSamples: 0,
  };

  const stack: string[] = [];
  let correlationDepth = 0;
  let record: OpenRecord | undefined;
  let workout: WorkoutElement | undefined;

  const countZone = (meta: Record<string, string>): void => {
    const z = meta.HKTimeZone;
    if (z) result.timeZoneCounts.set(z, (result.timeZoneCounts.get(z) ?? 0) + 1);
  };

  const finishRecord = (r: OpenRecord): void => {
    result.recordsRead++;
    countZone(r.metadata);
    const a = r.attrs;
    const type = a.type ?? '';
    if (!metricRuleFor(type)) return;
    const start = parseAppleTimestamp(a.startDate);
    const end = parseAppleTimestamp(a.endDate);
    if (start === undefined || end === undefined || a.value === undefined) {
      result.invalidSamples++;
      return;
    }
    const key: SeriesKey = {
      type,
      sourceName: a.sourceName ?? '',
      sourceVersion: a.sourceVersion ?? '',
      unit: a.unit ?? '',
      device: a.device ? stripDeviceAddress(a.device) : '',
    };
    const k = JSON.stringify([key.type, key.sourceName, key.sourceVersion, key.unit, key.device]);
    let idx = seriesIndex.get(k);
    if (idx === undefined) {
      idx = series.length;
      series.push(key);
      seriesIndex.set(k, idx);
    }
    const creation = parseAppleTimestamp(a.creationDate);
    spill.add(
      utcDayNumber(start),
      encodeSample({
        series: idx,
        start,
        end,
        creation: creation ?? null,
        value: a.value,
        syncIdentifier: r.metadata.HKMetadataKeySyncIdentifier ?? null,
        syncVersion: r.metadata.HKMetadataKeySyncVersion ?? null,
        externalUuid: r.metadata.HKExternalUUID ?? null,
      }),
    );
    result.samplesSpilled++;
    if (result.maxSampleEnd === undefined || end > result.maxSampleEnd) result.maxSampleEnd = end;
  };

  const onEvent = (e: XmlEvent): void => {
    if (e.kind === 'open') {
      const parent = stack[stack.length - 1];
      stack.push(e.name);
      switch (e.name) {
        case 'Correlation':
          correlationDepth++;
          return;
        case 'ExportDate':
          result.exportDate = parseAppleTimestamp(e.attrs.value);
          return;
        case 'Record':
          // The DTD admits a <Record> in exactly two places: at top level, and
          // inside a <Correlation>, where it is a copy of a top-level one.
          if (correlationDepth > 0) {
            result.correlationRecordsSkipped++;
            return;
          }
          record = { attrs: e.attrs, metadata: {} };
          return;
        case 'Workout':
          if (parent === 'HealthData') workout = { attrs: e.attrs, metadata: {}, statistics: [] };
          return;
        case 'WorkoutStatistics':
          if (workout && parent === 'Workout') workout.statistics.push(e.attrs);
          return;
        case 'MetadataEntry':
          if (e.attrs.key === undefined || e.attrs.value === undefined) return;
          if (record && parent === 'Record') record.metadata[e.attrs.key] = e.attrs.value;
          else if (workout && parent === 'Workout') workout.metadata[e.attrs.key] = e.attrs.value;
          return;
        case 'ActivitySummary':
          if (parent === 'HealthData') result.activitySummaries.push(e.attrs);
          return;
        default:
          return;
      }
    }
    // close
    stack.pop();
    if (e.name === 'Correlation') {
      correlationDepth = Math.max(0, correlationDepth - 1);
    } else if (e.name === 'Record' && record) {
      finishRecord(record);
      record = undefined;
    } else if (e.name === 'Workout' && workout && stack[stack.length - 1] === 'HealthData') {
      countZone(workout.metadata);
      result.workouts.push(workout);
      workout = undefined;
    }
  };

  await scanXml(chunks, onEvent);
  spill.flush();
  return result;
}
