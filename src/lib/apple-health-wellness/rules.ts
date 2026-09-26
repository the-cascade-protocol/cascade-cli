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
   * `health:DailyActivitySnapshot` carrying `property`.
   */
  record: 'vitalReading' | 'activitySnapshot';
  /** Only for `activitySnapshot`: the health: property the value is written to. */
  property?: 'steps';
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

export interface WellnessRules {
  rule: string;
  ruleVersion: string;
  idSpace: WellnessIdSpace;
  /** Decimal places a computed value is rounded to. */
  valueDecimals: number;
  metrics: WellnessMetricRule[];
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
    if (m.record === 'activitySnapshot' && m.property !== 'steps') {
      throw new Error(`wellness rules: ${m.hkType} is an activity snapshot without a known property`);
    }
    if (Object.keys(m.sourceUnits).length === 0) {
      throw new Error(`wellness rules: ${m.hkType} accepts no source unit`);
    }
  }
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
  return wellnessRules()
    .metrics.filter((m) => m.record === 'vitalReading' && m.file === fileKey && m.loinc)
    .map((m) => m.loinc as string);
}
