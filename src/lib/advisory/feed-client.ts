/**
 * Cascade Advisory Patch (CAP) — Feed Client (TASK-4.6).
 *
 * Pulls an advisory feed (per `feed-format.md`) and caches new entries under
 * `<pod>/.advisory-cache/`. Already-processed entries (status applied or
 * declined) are skipped. HTTP and network errors are logged + returned as a
 * failed-for-this-pull result rather than thrown — pods must work offline.
 *
 * The client is HTTP-agnostic by default: it uses the global `fetch` if
 * available, or a caller-supplied fetcher for tests. This keeps the feed
 * implementation testable without spinning up an HTTP server.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Status of an advisory in the local cache. */
export type AdvisoryCacheStatus = 'pending' | 'applied' | 'declined';

/** A single feed entry as published by the issuer. */
export interface FeedEntry {
  id: string;
  advisoryClass: string;
  cadence: string;
  applicableUntil?: string;
  humanSummary: string;
  body: string;
  signature: string;
  issuer: string;
  issuedAt: string;
  /** Any unrecognized fields are preserved here for forward compatibility. */
  extra?: Record<string, unknown>;
}

/** A complete feed document. */
export interface FeedDocument {
  feedVersion: string;
  issuer: string;
  issuerName?: string;
  lastUpdated?: string;
  entries: FeedEntry[];
}

/** The cache record persisted at `<pod>/.advisory-cache/<id>.json`. */
export interface AdvisoryCacheRecord {
  status: AdvisoryCacheStatus;
  entry: FeedEntry;
  fetchedAt: string;
  appliedAt?: string;
  declinedAt?: string;
  declineReason?: string;
}

/** Result of a single feed pull. */
export interface PullResult {
  ok: boolean;
  feedUrl: string;
  /** Reason for failure (set when ok === false). */
  reason?: string;
  /** New entries that were cached on this pull. */
  newEntries: string[];
  /** Entries skipped because they were already in cache (applied/declined). */
  skippedEntries: string[];
  /** Entries fetched but with body/signature unavailable. */
  bodyFailures: { id: string; reason: string }[];
}

/** Minimal fetch interface so tests can inject a mock. */
export type FeedFetcher = (
  url: string,
) => Promise<{ ok: boolean; status: number; body: string }>;

export interface PullOptions {
  /** Fetcher to use; defaults to `globalThis.fetch` wrapped to return text. */
  fetcher?: FeedFetcher;
  /** Override the "now" timestamp used when stamping fetchedAt. */
  now?: Date;
}

const CACHE_DIR_NAME = '.advisory-cache';

/**
 * Pull a feed and cache new entries. Idempotent — repeated calls re-fetch
 * the feed but only add entries not already in cache.
 */
export async function pullFeed(
  feedUrl: string,
  podDir: string,
  options: PullOptions = {},
): Promise<PullResult> {
  const fetcher = options.fetcher ?? defaultFetcher;
  const now = (options.now ?? new Date()).toISOString();

  // 1. Fetch the feed index
  let feedRes: Awaited<ReturnType<FeedFetcher>>;
  try {
    feedRes = await fetcher(feedUrl);
  } catch (e) {
    return {
      ok: false,
      feedUrl,
      reason: `network error fetching feed: ${(e as Error).message}`,
      newEntries: [],
      skippedEntries: [],
      bodyFailures: [],
    };
  }
  if (!feedRes.ok) {
    return {
      ok: false,
      feedUrl,
      reason: `HTTP ${feedRes.status} fetching feed`,
      newEntries: [],
      skippedEntries: [],
      bodyFailures: [],
    };
  }

  // 2. Parse the feed JSON
  let feed: FeedDocument;
  try {
    feed = parseFeedDocument(feedRes.body);
  } catch (e) {
    return {
      ok: false,
      feedUrl,
      reason: `feed JSON malformed: ${(e as Error).message}`,
      newEntries: [],
      skippedEntries: [],
      bodyFailures: [],
    };
  }

  // 3. Ensure the cache directory exists
  const cacheDir = path.join(podDir, CACHE_DIR_NAME);
  fs.mkdirSync(cacheDir, { recursive: true });

  const newEntries: string[] = [];
  const skippedEntries: string[] = [];
  const bodyFailures: { id: string; reason: string }[] = [];

  // 4. Process each entry
  for (const entry of feed.entries) {
    const recPath = recordPath(cacheDir, entry.id);
    const existing = readCacheRecord(recPath);
    if (existing && (existing.status === 'applied' || existing.status === 'declined')) {
      skippedEntries.push(entry.id);
      continue;
    }
    if (existing && existing.status === 'pending') {
      // Already pending — leave the existing record in place (preserve fetchedAt
      // for audit; we don't want every pull to bump the timestamp).
      skippedEntries.push(entry.id);
      continue;
    }

    // Fetch body + signature
    let body: string;
    try {
      const r = await fetcher(entry.body);
      if (!r.ok) {
        bodyFailures.push({ id: entry.id, reason: `body HTTP ${r.status}` });
        continue;
      }
      body = r.body;
    } catch (e) {
      bodyFailures.push({ id: entry.id, reason: `body fetch: ${(e as Error).message}` });
      continue;
    }
    let sig: string;
    try {
      const r = await fetcher(entry.signature);
      if (!r.ok) {
        bodyFailures.push({ id: entry.id, reason: `signature HTTP ${r.status}` });
        continue;
      }
      sig = r.body;
    } catch (e) {
      bodyFailures.push({
        id: entry.id,
        reason: `signature fetch: ${(e as Error).message}`,
      });
      continue;
    }

    // Persist body + signature alongside the metadata
    fs.writeFileSync(bodyPath(cacheDir, entry.id), body, 'utf8');
    fs.writeFileSync(signaturePath(cacheDir, entry.id), sig, 'utf8');
    const rec: AdvisoryCacheRecord = {
      status: 'pending',
      entry,
      fetchedAt: now,
    };
    fs.writeFileSync(recPath, JSON.stringify(rec, null, 2), 'utf8');
    newEntries.push(entry.id);
  }

  return {
    ok: true,
    feedUrl,
    newEntries,
    skippedEntries,
    bodyFailures,
  };
}

/**
 * Read a single cache record by advisory ID. Returns null if absent.
 */
export function readCacheRecord(filePath: string): AdvisoryCacheRecord | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as AdvisoryCacheRecord;
  } catch {
    return null;
  }
}

/** List all cache records in a pod, optionally filtered by status. */
export function listCacheRecords(
  podDir: string,
  filter?: AdvisoryCacheStatus,
): AdvisoryCacheRecord[] {
  const cacheDir = path.join(podDir, CACHE_DIR_NAME);
  if (!fs.existsSync(cacheDir)) return [];
  const out: AdvisoryCacheRecord[] = [];
  for (const f of fs.readdirSync(cacheDir)) {
    if (!f.endsWith('.json')) continue;
    const rec = readCacheRecord(path.join(cacheDir, f));
    if (rec && (!filter || rec.status === filter)) out.push(rec);
  }
  return out;
}

/** Update a cache record's status (e.g., mark applied or declined). */
export function updateCacheStatus(
  podDir: string,
  advisoryId: string,
  patch: Partial<Pick<AdvisoryCacheRecord, 'status' | 'appliedAt' | 'declinedAt' | 'declineReason'>>,
): AdvisoryCacheRecord | null {
  const cacheDir = path.join(podDir, CACHE_DIR_NAME);
  const recPath = recordPath(cacheDir, advisoryId);
  const rec = readCacheRecord(recPath);
  if (!rec) return null;
  Object.assign(rec, patch);
  fs.writeFileSync(recPath, JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

/** Resolve the cached body file for an advisory. Returns null if missing. */
export function readCachedBody(podDir: string, advisoryId: string): string | null {
  const p = bodyPath(path.join(podDir, CACHE_DIR_NAME), advisoryId);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/** Resolve the cached signature file for an advisory. Returns null if missing. */
export function readCachedSignature(podDir: string, advisoryId: string): string | null {
  const p = signaturePath(path.join(podDir, CACHE_DIR_NAME), advisoryId);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Parsing                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Parse a feed JSON document. We accept either the JSON-LD form (with
 * @context) or a plain-JSON shorthand. We do NOT do JSON-LD expansion
 * here — that would require pulling in jsonld.js. Instead, we read the
 * required fields directly. If a future feed format demands richer
 * JSON-LD semantics, swap this function with a jsonld-aware loader.
 */
export function parseFeedDocument(json: string): FeedDocument {
  const raw = JSON.parse(json) as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('feed must be a JSON object');
  }
  const feedVersion = typeof raw.feedVersion === 'string' ? raw.feedVersion : '0.1';
  const issuer = typeof raw.issuer === 'string' ? raw.issuer : '';
  const issuerName = typeof raw.issuerName === 'string' ? raw.issuerName : undefined;
  const lastUpdated = typeof raw.lastUpdated === 'string' ? raw.lastUpdated : undefined;
  const entriesRaw = Array.isArray(raw.entries) ? raw.entries : [];
  const entries: FeedEntry[] = entriesRaw.map((e, i) => parseEntry(e, i));
  return { feedVersion, issuer, issuerName, lastUpdated, entries };
}

function parseEntry(raw: unknown, index: number): FeedEntry {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`feed entry ${index} is not an object`);
  }
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id : (typeof obj['@id'] === 'string' ? (obj['@id'] as string) : '');
  if (!id) throw new Error(`feed entry ${index} missing id`);
  const known = new Set([
    'id',
    '@id',
    'advisoryClass',
    'cadence',
    'applicableUntil',
    'humanSummary',
    'body',
    'signature',
    'issuer',
    'issuedAt',
  ]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!known.has(k)) extra[k] = v;
  }
  return {
    id,
    advisoryClass: (obj.advisoryClass as string) ?? '',
    cadence: (obj.cadence as string) ?? '',
    applicableUntil: typeof obj.applicableUntil === 'string' ? obj.applicableUntil : undefined,
    humanSummary: (obj.humanSummary as string) ?? '',
    body: (obj.body as string) ?? '',
    signature: (obj.signature as string) ?? '',
    issuer: (obj.issuer as string) ?? '',
    issuedAt: (obj.issuedAt as string) ?? '',
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Filesystem helpers                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/** Encode an advisory IRI to a filesystem-safe slug. */
export function slugForId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '-');
}

function recordPath(cacheDir: string, id: string): string {
  return path.join(cacheDir, `${slugForId(id)}.json`);
}

function bodyPath(cacheDir: string, id: string): string {
  return path.join(cacheDir, `${slugForId(id)}.body.ldpatch`);
}

function signaturePath(cacheDir: string, id: string): string {
  return path.join(cacheDir, `${slugForId(id)}.body.jws`);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Default fetcher                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

const defaultFetcher: FeedFetcher = async (url) => {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error(
      'global fetch unavailable; pass a fetcher in PullOptions or run on Node 18+',
    );
  }
  const res = await globalThis.fetch(url);
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
};
