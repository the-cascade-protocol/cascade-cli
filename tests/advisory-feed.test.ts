/**
 * Tests for the CAP feed client + format (TASK-4.6).
 *
 * Acceptance:
 *   - `pullFeed(url, podDir)` fetches a feed index and per-entry body+sig.
 *   - Per-advisory cache: don't re-process applied/declined entries.
 *   - HTTP errors / network failures handled gracefully.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  pullFeed,
  parseFeedDocument,
  listCacheRecords,
  readCachedBody,
  readCachedSignature,
  updateCacheStatus,
  slugForId,
  type FeedFetcher,
  type FeedDocument,
} from '../src/lib/advisory/feed-client.js';

let podDir: string;
beforeEach(() => {
  podDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-feed-test-'));
});
afterEach(() => {
  fs.rmSync(podDir, { recursive: true, force: true });
});

const SAMPLE_FEED: FeedDocument = {
  feedVersion: '0.1',
  issuer: 'https://clingen.org/affiliation/40016',
  issuerName: 'ClinGen HBOP-VCEP',
  lastUpdated: '2026-05-04T00:00:00Z',
  entries: [
    {
      id: 'urn:advisory:test:1',
      advisoryClass: 'VariantReclassification',
      cadence: 'monthly',
      applicableUntil: '2031-05-04T00:00:00Z',
      humanSummary: 'Sample reclassification.',
      body: 'https://example.org/advisories/1.ldpatch',
      signature: 'https://example.org/advisories/1.jws',
      issuer: 'https://clingen.org/affiliation/40016',
      issuedAt: '2026-05-04T00:00:00Z',
    },
    {
      id: 'urn:advisory:test:2',
      advisoryClass: 'DrugInteraction',
      cadence: 'quarterly',
      humanSummary: 'Sample drug interaction guidance.',
      body: 'https://example.org/advisories/2.ldpatch',
      signature: 'https://example.org/advisories/2.jws',
      issuer: 'https://clingen.org/affiliation/40016',
      issuedAt: '2026-05-04T00:00:00Z',
    },
  ],
};

/** Fetcher that returns the SAMPLE_FEED for any URL containing 'feed'. */
function fakeFetcher(extra?: Record<string, string>): FeedFetcher {
  return async (url: string) => {
    if (url.includes('feed')) {
      return { ok: true, status: 200, body: JSON.stringify(SAMPLE_FEED) };
    }
    if (url.endsWith('.ldpatch')) {
      return { ok: true, status: 200, body: `# body for ${url}` };
    }
    if (url.endsWith('.jws')) {
      return { ok: true, status: 200, body: 'header..signature' };
    }
    if (extra && extra[url]) return { ok: true, status: 200, body: extra[url] };
    return { ok: false, status: 404, body: '' };
  };
}

describe('parseFeedDocument', () => {
  it('parses a minimal feed', () => {
    const json = JSON.stringify(SAMPLE_FEED);
    const feed = parseFeedDocument(json);
    expect(feed.feedVersion).toBe('0.1');
    expect(feed.entries.length).toBe(2);
    expect(feed.entries[0]!.id).toBe('urn:advisory:test:1');
  });

  it('preserves unknown fields in entry.extra', () => {
    const json = JSON.stringify({
      feedVersion: '0.1',
      issuer: 'x',
      entries: [
        {
          id: 'urn:test:1',
          advisoryClass: 'VariantReclassification',
          cadence: 'monthly',
          humanSummary: '',
          body: 'b',
          signature: 's',
          issuer: 'x',
          issuedAt: '2026-01-01T00:00:00Z',
          customField: 'preserved',
        },
      ],
    });
    const feed = parseFeedDocument(json);
    expect(feed.entries[0]!.extra).toEqual({ customField: 'preserved' });
  });

  it('throws on an entry without id', () => {
    const json = JSON.stringify({
      feedVersion: '0.1',
      issuer: 'x',
      entries: [{ humanSummary: 'no id' }],
    });
    expect(() => parseFeedDocument(json)).toThrow(/missing id/);
  });
});

describe('slugForId', () => {
  it('keeps alnum + dash + dot', () => {
    expect(slugForId('urn:advisory:test:1')).toBe('urn-advisory-test-1');
    expect(slugForId('https://example.org/a/b')).toBe('https---example.org-a-b');
  });
});

describe('pullFeed — happy path', () => {
  it('fetches a feed and caches both entries', async () => {
    const result = await pullFeed('https://example.org/feed.jsonld', podDir, {
      fetcher: fakeFetcher(),
    });
    expect(result.ok).toBe(true);
    expect(result.newEntries).toEqual(['urn:advisory:test:1', 'urn:advisory:test:2']);
    expect(result.skippedEntries).toEqual([]);
    expect(result.bodyFailures).toEqual([]);

    // Cache files exist
    const records = listCacheRecords(podDir);
    expect(records.length).toBe(2);
    expect(records.every((r) => r.status === 'pending')).toBe(true);
    expect(readCachedBody(podDir, 'urn:advisory:test:1')).toContain('body for');
    expect(readCachedSignature(podDir, 'urn:advisory:test:1')).toBe('header..signature');
  });

  it('skips already-applied entries on a second pull', async () => {
    await pullFeed('https://example.org/feed.jsonld', podDir, { fetcher: fakeFetcher() });
    updateCacheStatus(podDir, 'urn:advisory:test:1', {
      status: 'applied',
      appliedAt: new Date().toISOString(),
    });

    // Second pull
    const result = await pullFeed('https://example.org/feed.jsonld', podDir, {
      fetcher: fakeFetcher(),
    });
    expect(result.ok).toBe(true);
    expect(result.newEntries).toEqual([]); // both are now in cache
    expect(result.skippedEntries.sort()).toEqual([
      'urn:advisory:test:1',
      'urn:advisory:test:2',
    ]);
  });

  it('skips already-declined entries on a second pull', async () => {
    await pullFeed('https://example.org/feed.jsonld', podDir, { fetcher: fakeFetcher() });
    updateCacheStatus(podDir, 'urn:advisory:test:2', {
      status: 'declined',
      declinedAt: new Date().toISOString(),
      declineReason: 'not relevant',
    });
    const result = await pullFeed('https://example.org/feed.jsonld', podDir, {
      fetcher: fakeFetcher(),
    });
    expect(result.ok).toBe(true);
    expect(result.skippedEntries).toContain('urn:advisory:test:2');
  });
});

describe('pullFeed — error handling', () => {
  it('returns ok=false on network error fetching the feed', async () => {
    const fetcher: FeedFetcher = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await pullFeed('https://example.org/feed.jsonld', podDir, { fetcher });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ECONNREFUSED');
  });

  it('returns ok=false on HTTP non-2xx fetching the feed', async () => {
    const fetcher: FeedFetcher = async () => ({ ok: false, status: 503, body: '' });
    const result = await pullFeed('https://example.org/feed.jsonld', podDir, { fetcher });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('503');
  });

  it('returns ok=false on malformed JSON', async () => {
    const fetcher: FeedFetcher = async () => ({
      ok: true,
      status: 200,
      body: '{not valid json',
    });
    const result = await pullFeed('https://example.org/feed.jsonld', podDir, { fetcher });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('malformed');
  });

  it('records bodyFailures when an entry body or signature is unreachable', async () => {
    const fetcher: FeedFetcher = async (url: string) => {
      if (url.includes('feed')) {
        return { ok: true, status: 200, body: JSON.stringify(SAMPLE_FEED) };
      }
      if (url.endsWith('1.jws')) {
        return { ok: false, status: 404, body: '' };
      }
      return { ok: true, status: 200, body: 'something' };
    };
    const result = await pullFeed('https://example.org/feed.jsonld', podDir, { fetcher });
    expect(result.ok).toBe(true);
    expect(result.bodyFailures.some((f) => f.id === 'urn:advisory:test:1')).toBe(true);
    expect(result.newEntries).toContain('urn:advisory:test:2');
    expect(result.newEntries).not.toContain('urn:advisory:test:1');
  });

  it('does not throw when the cache directory does not yet exist', async () => {
    const nestedPod = path.join(podDir, 'fresh', 'pod');
    fs.mkdirSync(nestedPod, { recursive: true });
    const result = await pullFeed('https://example.org/feed.jsonld', nestedPod, {
      fetcher: fakeFetcher(),
    });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(nestedPod, '.advisory-cache'))).toBe(true);
  });
});
