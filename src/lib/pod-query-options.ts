/**
 * The two read-cost options of `pod query`, shared by the CLI verb and the MCP
 * `cascade_pod_query` tool.
 *
 *   - exclusion: which data files a query must leave UNREAD, from the keys a
 *     caller names (`--exclude-data-type <key>` / `excludeDataTypes`);
 *   - the stored daily wellness series (`--wellness-series` / `wellnessSeries`),
 *     read, checked against the files it was built from, and shaped for output.
 *
 * One module, so an agent and a person asking the same question get the same
 * files skipped, the same errors and the same series payload. The two front
 * ends differ only in how they report: the CLI prints and sets an exit code,
 * the MCP tool returns a typed error.
 */

import * as path from 'path';
import {
  excludableDataFiles,
  wellnessGroupKeys,
  WELLNESS_GROUP_KEY,
} from './pod-data-types.js';
import type { PodReader, PodReadFailure } from './pod-read.js';
import {
  readStoredDailySeries,
  dailySeriesFreshness,
  type StoredDailySeries,
} from './apple-health-wellness/daily-series.js';

/** Every key the exclusion accepts: the data-file keys, then the group key. */
export function excludableKeys(): string[] {
  return [...excludableDataFiles().map((e) => e.key), WELLNESS_GROUP_KEY];
}

export interface ResolvedExclusion {
  /** Data-file keys left out, the group expanded. Sorted. */
  keys: string[];
  /** Absolute paths of the files left unread. */
  files: Set<string>;
  /** Keys that came in only through the group key (for error messages). */
  viaGroup: Set<string>;
}

/**
 * Resolve the keys a caller named into the files to leave unread.
 *
 * An unknown key is an error that lists the known ones, so a misspelling is
 * never a filter that silently does nothing. `optionName` is how the caller's
 * front end spells the option (`--exclude-data-type`, `excludeDataTypes`).
 */
export function resolveExclusion(
  absDir: string,
  requested: readonly string[],
  optionName: string,
): { ok: true; value: ResolvedExclusion } | { ok: false; message: string } {
  const excludable = excludableDataFiles();
  const known = new Set(excludable.map((e) => e.key));
  const unknown = requested.filter((k) => k !== WELLNESS_GROUP_KEY && !known.has(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      message:
        `Unknown data type${unknown.length > 1 ? 's' : ''} for ${optionName}: ${unknown.join(', ')}. ` +
        `Known: ${excludableKeys().join(', ')}.`,
    };
  }
  const keys = new Set<string>();
  const viaGroup = new Set<string>();
  for (const k of requested) {
    if (k === WELLNESS_GROUP_KEY) {
      for (const g of wellnessGroupKeys()) {
        if (!requested.includes(g)) viaGroup.add(g);
        keys.add(g);
      }
    } else {
      keys.add(k);
    }
  }
  const files = new Set(
    excludable.filter((e) => keys.has(e.key)).map((e) => path.join(absDir, ...e.file.split('/'))),
  );
  return { ok: true, value: { keys: [...keys].sort(), files, viaGroup } };
}

/**
 * A data type both asked for and excluded in one call is a contradiction, named
 * as one rather than reported as "no filter". Returns the message, or undefined.
 */
export function exclusionContradiction(
  requestedTypes: readonly string[],
  exclusion: ResolvedExclusion,
  optionName: string,
): string | undefined {
  const excluded = new Set(exclusion.keys);
  const contradicted = requestedTypes.filter((t) => excluded.has(t));
  if (contradicted.length === 0) return undefined;
  const named = contradicted.map((t) =>
    exclusion.viaGroup.has(t) ? `${t} (in the ${WELLNESS_GROUP_KEY} group)` : t,
  );
  return (
    `Asked for and excluded in the same call: ${named.join(', ')}. ` +
    `Drop the ${optionName}, or the filter it cancels.`
  );
}

// ─── The stored daily wellness series ─────────────────────────────────────────

/** A stored series as read, with whether it still matches the pod's records. */
export type SeriesRead = StoredDailySeries & { stale: boolean; staleReasons: string[] };

/**
 * Read the stored daily series and check its freshness.
 *
 * `value: null` only when the pod holds no view at all. A view that exists and
 * cannot be read (a descriptor that does not parse, bytes that do not match
 * their digest), or whose inputs cannot be hashed, is a failure: unknown is not
 * "none". Freshness is checked on every read, because a writer that did not
 * rebuild the view leaves it serving values the pod may no longer hold; a
 * stale view is returned, but never as current.
 */
export function readWellnessSeries(
  reader: PodReader,
): { ok: true; value: SeriesRead | null } | { ok: false; failure: PodReadFailure } {
  const read = readStoredDailySeries(reader);
  if (!read.ok) return read;
  if (read.value === null) return { ok: true, value: null };
  const fresh = dailySeriesFreshness(reader, read.value);
  if (!fresh.ok) return fresh;
  return { ok: true, value: { ...read.value, stale: fresh.value.stale, staleReasons: fresh.value.reasons } };
}

/** The warning a stale series carries, or undefined when it is current. */
export function staleSeriesWarning(series: SeriesRead | null): string | undefined {
  if (series === null || !series.stale) return undefined;
  return (
    `The stored daily wellness series is STALE: ${series.staleReasons.join('; ')}. ` +
    'It is returned with stale: true. Run `cascade pod reconcile <pod> --apply` to rebuild it.'
  );
}

/** The view as `pod query` returns it under `wellnessDailySeries`. */
export function wellnessSeriesPayload(series: SeriesRead | null): Record<string, unknown> | null {
  if (series === null) return null;
  return {
    stale: series.stale,
    staleReasons: series.staleReasons,
    descriptor: series.descriptor,
    attachment: series.attachment,
    contentHash: series.contentHash,
    byteSize: series.byteSize,
    generatedBy: series.generatedBy,
    ...series.view,
  };
}
