/**
 * Instants, zones and days for the wellness aggregator.
 *
 * MEASURED, AND THE REASON THIS MODULE EXISTS. The Apple Health export renders
 * every timestamp in the exporting device's CURRENT zone and carries no
 * per-sample offset: two real exports three months apart put all 10.2 million
 * samples at `-0700`, across years of travel. So the offset printed in the file
 * says where the phone was on export day, not where the person was. Identity is
 * therefore built from UTC instants only, and a day is cut in the pod's
 * declared zone (`cascade:dayZone`), never in the export's rendered offset.
 *
 * Days are half-open UTC intervals [start, end): a sample belongs to the day
 * its START instant falls in. A day in a zone with daylight saving is 23 or 25
 * hours long on the transition days, which is why a day is computed from the
 * zone rather than assumed to be 24 hours.
 */

const APPLE_TS = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;

/**
 * Parse an Apple Health timestamp (`2026-01-20 07:30:00 -0700`) to epoch
 * milliseconds. Undefined for anything else; the caller counts and reports it.
 */
export function parseAppleTimestamp(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = APPLE_TS.exec(s);
  if (!m) return undefined;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const offsetMin = (+m[8] * 60 + +m[9]) * (m[7] === '-' ? -1 : 1);
  const ms = utc - offsetMin * 60_000;
  return Number.isFinite(ms) ? ms : undefined;
}

/** `2026-01-20T08:00:00Z`: a UTC instant with whole seconds, the form every interval is written in. */
export function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    // Throws RangeError for a zone the runtime does not know.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

/** True when the runtime knows `zone` as an IANA time zone name. */
export function isKnownZone(zone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(zone)) return false;
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The runtime's canonical name for a known zone: `US/Pacific` and
 * `America/Los_Angeles` are one zone, and must be counted as one and written
 * one way. Undefined for a zone the runtime does not know.
 */
export function canonicalZone(zone: string): string | undefined {
  if (!isKnownZone(zone)) return undefined;
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wallClock(ms: number, zone: string): WallClock {
  const parts = formatterFor(zone).formatToParts(new Date(ms));
  const get = (t: string): number => +(parts.find((p) => p.type === t)?.value ?? '0');
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** The zone's offset from UTC at instant `ms`, in milliseconds (local = UTC + offset). */
function offsetAt(ms: number, zone: string): number {
  const w = wallClock(ms, zone);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The local calendar date (`YYYY-MM-DD`) of instant `ms` in `zone`. */
export function localDateOf(ms: number, zone: string): string {
  const w = wallClock(ms, zone);
  return `${String(w.y).padStart(4, '0')}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

/** The UTC instant of local midnight at the start of `localDate` in `zone`. */
function localMidnightUtc(localDate: string, zone: string): number {
  const [y, mo, d] = localDate.split('-').map(Number);
  const naive = Date.UTC(y, mo - 1, d);
  // Two refinements settle the offset on either side of a DST transition.
  let guess = naive - offsetAt(naive, zone);
  guess = naive - offsetAt(guess, zone);
  // A zone whose clocks skip midnight itself (a DST change AT 00:00) has no
  // 00:00 that day; the day then starts at the first instant whose local date
  // is `localDate`, found by stepping forward by the size of the gap.
  for (let step = 0; step < 12 && localDateOf(guess, zone) !== localDate; step++) {
    guess += 15 * 60_000;
  }
  return guess;
}

/** The half-open UTC interval [start, end) of the local day `localDate` in `zone`. */
export function dayIntervalUtc(localDate: string, zone: string): { start: number; end: number } {
  const [y, mo, d] = localDate.split('-').map(Number);
  const next = new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
  return { start: localMidnightUtc(localDate, zone), end: localMidnightUtc(next, zone) };
}

/** The UTC day number (days since the epoch) of instant `ms`: the spill partition key. */
export function utcDayNumber(ms: number): number {
  return Math.floor(ms / 86_400_000);
}

/** The zone the importing machine runs in, when the runtime can say. */
export function machineZone(): string | undefined {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return z && isKnownZone(z) ? z : undefined;
  } catch {
    return undefined;
  }
}
