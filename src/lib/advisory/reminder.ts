/**
 * Cascade Advisory Patch (CAP) — Reminder State Manager (TASK-4.7).
 *
 * Tracks the last-checked time per advisory tier and reports which tiers are
 * due for a refresh. Tier intervals come from the REPORT §1.2 tiered cadence:
 *
 *   SafetyCritical              → every-app-open (always due)
 *   VariantReclassification     → monthly
 *   DrugInteraction             → monthly
 *   SurveillanceGuidelineUpdate → quarterly
 *   ScreeningRecommendationUpdate → quarterly
 *   GeneralKnowledgeUpdate      → annual
 *
 * A pod stores `<pod>/.advisory-state/last-checked.json` of shape
 * `{ "<tier>": "<ISO8601>", ... }`. Missing entries are treated as
 * never-checked (always due).
 *
 * Tier names match the v0.1 advisory:AdvisoryClass individuals. For ergonomics
 * the API accepts the local name (e.g., "VariantReclassification") OR a full
 * IRI (e.g., "https://ns.cascadeprotocol.org/advisory/v1#VariantReclassification");
 * both forms canonicalize to the local name when persisted.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type TierName =
  | 'SafetyCritical'
  | 'VariantReclassification'
  | 'DrugInteraction'
  | 'SurveillanceGuidelineUpdate'
  | 'ScreeningRecommendationUpdate'
  | 'GeneralKnowledgeUpdate';

export const ALL_TIERS: ReadonlyArray<TierName> = [
  'SafetyCritical',
  'VariantReclassification',
  'DrugInteraction',
  'SurveillanceGuidelineUpdate',
  'ScreeningRecommendationUpdate',
  'GeneralKnowledgeUpdate',
];

/** Interval in milliseconds between checks per tier. */
export const TIER_INTERVAL_MS: Readonly<Record<TierName, number>> = {
  SafetyCritical: 0, // always due
  VariantReclassification: 30 * 24 * 60 * 60 * 1000, // ~monthly
  DrugInteraction: 30 * 24 * 60 * 60 * 1000,
  SurveillanceGuidelineUpdate: 91 * 24 * 60 * 60 * 1000, // ~quarterly
  ScreeningRecommendationUpdate: 91 * 24 * 60 * 60 * 1000,
  GeneralKnowledgeUpdate: 365 * 24 * 60 * 60 * 1000, // annual
};

const STATE_DIR_NAME = '.advisory-state';
const STATE_FILE_NAME = 'last-checked.json';

/** Internal state shape (tier → ISO8601). */
type StateMap = Record<string, string>;

/**
 * Get the list of tiers that are due for a check, given the pod's recorded
 * last-checked timestamps and the current time.
 *
 * Tiers never checked appear in the result. SafetyCritical always appears
 * (interval 0).
 */
export function getDueChecks(podDir: string, now: Date = new Date()): TierName[] {
  const state = readState(podDir);
  const due: TierName[] = [];
  for (const tier of ALL_TIERS) {
    const interval = TIER_INTERVAL_MS[tier];
    if (interval === 0) {
      due.push(tier);
      continue;
    }
    const last = state[tier];
    if (!last) {
      due.push(tier);
      continue;
    }
    const lastTime = Date.parse(last);
    if (Number.isNaN(lastTime)) {
      // Corrupted entry — treat as never-checked.
      due.push(tier);
      continue;
    }
    if (now.getTime() - lastTime >= interval) {
      due.push(tier);
    }
  }
  return due;
}

/** Mark a tier as checked at `now` (defaults to current time). */
export function markChecked(
  podDir: string,
  tier: TierName,
  now: Date = new Date(),
): void {
  const state = readState(podDir);
  state[tier] = now.toISOString();
  writeState(podDir, state);
}

/** Return the recorded last-checked timestamp for a tier (ISO8601), or null. */
export function getLastChecked(podDir: string, tier: TierName): string | null {
  const state = readState(podDir);
  return state[tier] ?? null;
}

/** Read all recorded last-checked entries (tier → ISO8601 string). */
export function readAllChecked(podDir: string): Readonly<StateMap> {
  return readState(podDir);
}

/**
 * Normalize an advisory class IRI or local name to a TierName, or null if
 * unrecognized. Useful when the caller has only an `advisory:advisoryClass`
 * value from a CAP envelope.
 */
export function tierFromAdvisoryClass(value: string): TierName | null {
  if (!value) return null;
  const local = value.includes('#') ? value.split('#').pop()! : value;
  if ((ALL_TIERS as ReadonlyArray<string>).includes(local)) {
    return local as TierName;
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Storage helpers                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

function statePath(podDir: string): string {
  return path.join(podDir, STATE_DIR_NAME, STATE_FILE_NAME);
}

function readState(podDir: string): StateMap {
  const p = statePath(podDir);
  if (!fs.existsSync(p)) return {};
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      // Filter to string values only.
      const out: StateMap = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function writeState(podDir: string, state: StateMap): void {
  const dir = path.join(podDir, STATE_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath(podDir), JSON.stringify(state, null, 2), 'utf8');
}
