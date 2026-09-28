/**
 * The Apple Health wellness rules, as DATA.
 *
 * Which HealthKit sample type becomes which record, in which unit, with which
 * statistics, filed where: all of it lives in `src/data/apple-health-wellness-rules.json`
 * and is read through {@link wellnessRules}, the one function that reads it.
 * The aggregator, the pod router (`pod-data-types.ts`) and the tests all ask
 * this module, so the table cannot say one thing while a code path says
 * another. Changing what a rule computes means changing `ruleVersion` in the
 * same edit: the version is stamped on every aggregate it produced
 * (`prov:wasGeneratedBy`), which is how a later reader tells two rule
 * generations apart.
 */

import rulesAsset from '../../data/apple-health-wellness-rules.json' with { type: 'json' };
import type { WellnessIdSpace } from '../identity.js';

/** The descriptive statistics a metric can be aggregated by (cascade:statistic values). */
export type WellnessStatistic = 'sum' | 'average' | 'minimum' | 'maximum';

export interface WellnessMetricRule {
  /** Apple's own type identifier, the `type` attribute of a `<Record>`. The metric axis of identity. */
  hkType: string;
  /**
   * `vitalReading` writes a `health:DailyVitalReading` (health:value + health:unit,
   * coded with fhir:code and cascade:loincCode); `activitySnapshot` writes a
   * `health:DailyActivitySnapshot` carrying `property`, one snapshot per metric.
   */
  record: 'vitalReading' | 'activitySnapshot';
  /** Only for `activitySnapshot`: the health: property the value is written to. */
  property?: ActivitySnapshotProperty;
  /** SNOMED CT concept id, for `vitalReading`. */
  snomed?: string;
  /** LOINC code, for `vitalReading`. Also routes the reading to its pod file. */
  loinc?: string;
  /** Unit the value is written in (health:unit). */
  unit: string;
  /** Source units accepted, each with the factor that converts it to `unit`. Any other unit is skipped and reported. */
  sourceUnits: Record<string, number>;
  /** One record per statistic, per (source, device, closed day). */
  statistics: WellnessStatistic[];
  /** The pod data-type key (`DATA_TYPES` in pod-data-types.ts) whose file holds the record. */
  file: string;
}

/** The health: properties a per-device `health:DailyActivitySnapshot` carries, one per snapshot. */
export type ActivitySnapshotProperty = 'steps' | 'activeEnergyKcal' | 'basalEnergyKcal';
const SNAPSHOT_PROPERTIES: ReadonlySet<string> = new Set(['steps', 'activeEnergyKcal', 'basalEnergyKcal']);

/**
 * A HealthKit type whose samples are individual readings, one record each, never
 * a daily series (VO2 max). Written as a `health:VitalSignReading` coded with
 * `fhir:code` (SNOMED CT) and, where the rule has one, `cascade:loincCode`.
 */
export interface WellnessReadingRule {
  hkType: string;
  record: 'vitalSignReading';
  snomed: string;
  /** LOINC code, when one exists. VO2 max has none (health v2.12 removed a wrong one). */
  loinc?: string;
  unit: string;
  sourceUnits: Record<string, number>;
  file: string;
  /**
   * How the source says the value was obtained: the metadata key it is read
   * from, and each source value's `clinical:measurementMethod` value. A source
   * value not listed writes no method (and is counted), since a reading with no
   * method says nothing about how it was obtained.
   */
  method?: { metadataKey: string; values: Record<string, string> };
}

/** A blood pressure reading, paired from HealthKit's blood pressure correlation. */
export interface WellnessBloodPressureRule {
  correlationType: string;
  systolicType: string;
  diastolicType: string;
  snomed: string;
  loinc: string;
  unit: string;
  sourceUnits: Record<string, number>;
  file: string;
  /**
   * The rule that pairs top-level systolic and diastolic records no
   * correlation covers: one of each from one source with the same start and
   * end is one reading. Stamped on each reading it makes, through its
   * generating activity. A reading paired by the source (a correlation) is
   * not derived and carries no such stamp.
   */
  pairing: { rule: string; ruleVersion: string };
}

/** The health:SleepSession stage totals an Apple sleep value is summed into. */
export type SleepStageProperty =
  | 'inBedMinutes'
  | 'awakeMinutes'
  | 'lightSleepMinutes'
  | 'deepSleepMinutes'
  | 'remSleepMinutes'
  | 'asleepUnspecifiedMinutes';
const SLEEP_STAGE_PROPERTIES: ReadonlySet<string> = new Set([
  'inBedMinutes',
  'awakeMinutes',
  'lightSleepMinutes',
  'deepSleepMinutes',
  'remSleepMinutes',
  'asleepUnspecifiedMinutes',
]);

/**
 * The rule that assembles Apple sleep stage segments into sessions. Apple
 * records no session, so the grouping is a derivation, stamped with `rule` and
 * `ruleVersion` on the activity every session names. Changing a parameter here
 * changes what the rule computes and needs a new `ruleVersion` in the same edit.
 */
export interface WellnessSleepRule {
  hkType: string;
  rule: string;
  ruleVersion: string;
  /** A gap between segments of at least this many minutes starts a new session. */
  gapMinutes: number;
  /** A run of consecutive awake segments spanning at least this many minutes counts as such a gap. */
  awakeRunMinutes: number;
  file: string;
  /** Apple's sleep value -> the stage total it is summed into. A value not listed is retained but never totalled. */
  stages: Record<string, SleepStageProperty>;
}

export interface WellnessRules {
  rule: string;
  ruleVersion: string;
  /**
   * Earlier versions of the daily aggregation rule. A computed aggregate is a
   * rebuildable cache stamped with the rule version that produced it, so an
   * aggregate a superseded version wrote is REPLACED in place when this
   * version computes the same name (and counted as migrated), never kept
   * beside it as a collision. Version 1 wrote per-device active energy as a
   * daily vital reading coded LOINC 41981-2; version 2 writes it on a
   * per-device activity snapshot.
   */
  supersededRuleVersions: string[];
  idSpace: WellnessIdSpace;
  /** Decimal places a computed value is rounded to. */
  valueDecimals: number;
  metrics: WellnessMetricRule[];
  readings: WellnessReadingRule[];
  bloodPressure: WellnessBloodPressureRule;
  sleep: WellnessSleepRule;
  activitySummary: {
    file: string;
    sourceName: string;
    energyUnits: Record<string, number>;
    /** Summaries dated before this are Apple's all-zero sentinel rows and are not imported. */
    earliestDate: string;
  };
  workouts: {
    file: string;
    durationUnits: Record<string, number>;
    distanceUnits: Record<string, number>;
    energyUnits: Record<string, number>;
  };
  devices: { file: string };
  /**
   * LOINC codes no rule writes any more, with the file readings carrying them
   * were written to. The pod router keeps filing such a reading there, so a
   * later rewrite never moves it.
   */
  retiredReadingCodes: Array<{ loinc: string; file: string; why: string }>;
}

const STATISTICS: ReadonlySet<string> = new Set(['sum', 'average', 'minimum', 'maximum']);

let cached: WellnessRules | undefined;

/**
 * THE reader of the rules table. Validates the shape once, so a malformed edit
 * fails loudly at first use rather than producing records with a missing unit.
 */
export function wellnessRules(): WellnessRules {
  if (cached) return cached;
  const r = rulesAsset as unknown as WellnessRules;
  const seen = new Set<string>();
  for (const m of r.metrics) {
    if (seen.has(m.hkType)) throw new Error(`wellness rules: ${m.hkType} is listed twice`);
    seen.add(m.hkType);
    if (m.statistics.length === 0 || m.statistics.some((s) => !STATISTICS.has(s))) {
      throw new Error(`wellness rules: ${m.hkType} has an unknown or empty statistic list`);
    }
    if (m.record === 'vitalReading' && (!m.snomed || !m.loinc)) {
      throw new Error(`wellness rules: ${m.hkType} is a vital reading without a SNOMED and LOINC code`);
    }
    if (m.record === 'activitySnapshot' && !SNAPSHOT_PROPERTIES.has(m.property ?? '')) {
      throw new Error(`wellness rules: ${m.hkType} is an activity snapshot without a known property`);
    }
    if (Object.keys(m.sourceUnits).length === 0) {
      throw new Error(`wellness rules: ${m.hkType} accepts no source unit`);
    }
  }
  for (const x of r.readings) {
    if (seen.has(x.hkType)) throw new Error(`wellness rules: ${x.hkType} is listed twice`);
    seen.add(x.hkType);
    if (!x.snomed) throw new Error(`wellness rules: reading ${x.hkType} has no SNOMED code`);
    if (Object.keys(x.sourceUnits).length === 0) throw new Error(`wellness rules: ${x.hkType} accepts no source unit`);
  }
  if (r.supersededRuleVersions.includes(r.ruleVersion)) {
    throw new Error(`wellness rules: rule version ${r.ruleVersion} is listed as superseded`);
  }
  if (seen.has(r.sleep.hkType)) throw new Error(`wellness rules: ${r.sleep.hkType} is listed twice`);
  if (!(r.sleep.gapMinutes > 0) || !(r.sleep.awakeRunMinutes > 0)) {
    throw new Error('wellness rules: the sleep grouping gap and awake run must be positive minutes');
  }
  for (const [value, prop] of Object.entries(r.sleep.stages)) {
    if (!SLEEP_STAGE_PROPERTIES.has(prop)) throw new Error(`wellness rules: sleep value ${value} maps to unknown stage ${prop}`);
  }
  if (!Object.values(r.sleep.stages).includes('awakeMinutes')) {
    throw new Error('wellness rules: no sleep value maps to awakeMinutes, so the awake-run rule cannot apply');
  }
  // A code routes a reading to exactly one file, whichever rule states it.
  const fileOfCode = new Map<string, string>();
  const claim = (code: string, file: string, who: string): void => {
    const prior = fileOfCode.get(code);
    if (prior !== undefined && prior !== file) throw new Error(`wellness rules: code ${code} (${who}) is filed in both ${prior} and ${file}`);
    fileOfCode.set(code, file);
  };
  for (const m of r.metrics) if (m.record === 'vitalReading') claim(`loinc:${m.loinc}`, m.file, m.hkType);
  for (const x of r.readings) {
    if (x.loinc) claim(`loinc:${x.loinc}`, x.file, x.hkType);
    claim(`snomed:${x.snomed}`, x.file, x.hkType);
  }
  for (const c of r.retiredReadingCodes) claim(`loinc:${c.loinc}`, c.file, 'retired');
  cached = r;
  return r;
}

/** The rule for one HealthKit type, or undefined when the type is not aggregated. */
export function metricRuleFor(hkType: string): WellnessMetricRule | undefined {
  return wellnessRules().metrics.find((m) => m.hkType === hkType);
}

/**
 * LOINC codes of the `health:DailyVitalReading` records that belong in the pod
 * file of `fileKey`. The pod router uses this to send a reading to the file the
 * table put it in, so a later import or `pod reconcile` rewrites it in place
 * instead of moving it.
 */
export function readingLoincCodesForFile(fileKey: string): string[] {
  const r = wellnessRules();
  return [
    ...r.metrics.filter((m) => m.record === 'vitalReading' && m.file === fileKey && m.loinc).map((m) => m.loinc as string),
    ...r.readings.filter((x) => x.file === fileKey && x.loinc).map((x) => x.loinc as string),
    ...r.retiredReadingCodes.filter((c) => c.file === fileKey).map((c) => c.loinc),
  ];
}

/**
 * SNOMED CT codes (`fhir:code`) of readings that carry NO LOINC code and
 * belong in the pod file of `fileKey` (a VO2 max estimate, whose wrong LOINC
 * code health v2.12 removed). The router files a reading by its LOINC code
 * where it has one a file claims, and by this code otherwise.
 */
export function readingSnomedCodesForFile(fileKey: string): string[] {
  return wellnessRules()
    .readings.filter((x) => x.file === fileKey && !x.loinc)
    .map((x) => x.snomed);
}

/** The rule for one HealthKit reading type (a type written one record per sample), or undefined. */
export function readingRuleFor(hkType: string): WellnessReadingRule | undefined {
  return wellnessRules().readings.find((x) => x.hkType === hkType);
}
