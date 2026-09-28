/**
 * CONTROL: a C-CDA record named from its own unique source id keeps its name.
 *
 * Two naming rules changed together: the section narrative key (document set
 * instead of document instance, and a canonical digest of the narrative) and
 * the content the id-reuse disambiguator hashes (stable clinical fields only).
 * Both move names ON PURPOSE, for narratives and for records whose id is
 * claimed by more than one statement in a document. Neither may move the name
 * of a record whose id is unique in its document: that is the tier every
 * existing pod depends on, and a layer 1 name is never rewritten.
 *
 * So this file names every such record in every committed C-CDA fixture and
 * compares the names with a snapshot taken from the build BEFORE the change
 * (`tests/fixtures/ccda-tier1-names.json`). The snapshot records, per fixture,
 * the fixture's SHA-256 and each unique-id record as `type|sourceId -> IRI`.
 *
 * How a record is classified, independently of the code under test: the door
 * (`ccdaRecordUri`, `ccdaMedicationRecordUri`) is wrapped so every mint is seen
 * with its type and source id, and a mint is tier 1 when its IRI equals the
 * plain template `urn:uuid:` + uuid5(`{type}:{sourceId}`). That template is a
 * published formula, not a value this change computes.
 *
 * This is a control, so it passes both before and after the change by design.
 * It is not vacuous: making the disambiguator fire for every id (the obvious
 * over-correction) turns it red, which was run, not assumed.
 *
 * To regenerate the snapshot (only ever from a build whose tier-1 naming is the
 * one to pin): `CCDA_TIER1_SNAPSHOT_WRITE=1 npx vitest run tests/ccda-tier1-names-unmoved.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { conformancePath } from './helpers/conformance.js';
import { SYNTHETIC_EPIC_CCDA, SYNTHETIC_UNKNOWN_VENDOR_CCDA } from './ccda-synthetic-documents.js';

interface Mint {
  type: string;
  sourceId?: string;
  uri: string;
}

const mints: Mint[] = [];

vi.mock('../src/lib/ccda-converter/record-identity.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/ccda-converter/record-identity.js')>();
  return {
    ...real,
    ccdaRecordUri: (opts: Parameters<typeof real.ccdaRecordUri>[0]) => {
      const uri = real.ccdaRecordUri(opts);
      mints.push({ type: opts.type, sourceId: opts.sourceId, uri });
      return uri;
    },
    ccdaMedicationRecordUri: (opts: Parameters<typeof real.ccdaMedicationRecordUri>[0]) => {
      const uri = real.ccdaMedicationRecordUri(opts);
      mints.push({ type: 'MedicationRequest', sourceId: opts.sourceId, uri });
      return uri;
    },
  };
});

const { convertCcda } = await import('../src/lib/ccda-converter/index.js');
const { deterministicUuid } = await import('../src/lib/fhir-converter/types.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SNAPSHOT = path.join(HERE, 'fixtures', 'ccda-tier1-names.json');

/** Every committed C-CDA input, as `label -> xml`. */
function fixtures(): Map<string, string> {
  const out = new Map<string, string>();
  const local = path.join(REPO, 'test-fixtures');
  for (const f of fs.readdirSync(local).filter((n) => n.endsWith('.xml')).sort()) {
    out.set(`test-fixtures/${f}`, fs.readFileSync(path.join(local, f), 'utf8'));
  }
  const pathology = path.join(local, 'pathology');
  for (const f of fs.readdirSync(pathology).filter((n) => n.endsWith('-ccda.xml')).sort()) {
    out.set(`test-fixtures/pathology/${f}`, fs.readFileSync(path.join(pathology, f), 'utf8'));
  }
  const conf = conformancePath('fixtures', 'ccda');
  for (const f of fs.readdirSync(conf).filter((n) => n.endsWith('.xml')).sort()) {
    out.set(`conformance/fixtures/ccda/${f}`, fs.readFileSync(path.join(conf, f), 'utf8'));
  }
  out.set('tests/ccda-synthetic-documents.ts#SYNTHETIC_EPIC_CCDA', SYNTHETIC_EPIC_CCDA);
  out.set('tests/ccda-synthetic-documents.ts#SYNTHETIC_UNKNOWN_VENDOR_CCDA', SYNTHETIC_UNKNOWN_VENDOR_CCDA);
  return out;
}

interface Census {
  sha256: string;
  /** `type|sourceId` -> IRI, for every mint that took the plain tier-1 template. */
  tier1: Record<string, string>;
}

async function census(xml: string): Promise<Census> {
  mints.length = 0;
  await convertCcda(xml, { sourceSystem: 'tier1-census', importedAt: '2026-01-01T00:00:00Z' });
  const tier1: Record<string, string> = {};
  for (const m of mints) {
    if (typeof m.sourceId !== 'string' || m.sourceId.trim().length === 0) continue;
    if (m.uri !== `urn:uuid:${deterministicUuid(`${m.type}:${m.sourceId}`)}`) continue;
    tier1[`${m.type}|${m.sourceId}`] = m.uri;
  }
  return { sha256: createHash('sha256').update(xml, 'utf8').digest('hex'), tier1 };
}

describe('CONTROL: no C-CDA record named from a unique source id changes its name', async () => {
  const inputs = fixtures();
  const now = new Map<string, Census>();
  for (const [label, xml] of inputs) now.set(label, await census(xml));

  if (process.env.CCDA_TIER1_SNAPSHOT_WRITE === '1') {
    const out: Record<string, Census> = {};
    for (const [label, c] of [...now].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) out[label] = c;
    fs.writeFileSync(SNAPSHOT, `${JSON.stringify(out, null, 2)}\n`);
  }

  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) as Record<string, Census>;

  it('covers every committed C-CDA fixture, and the snapshot is not hollow', () => {
    expect(Object.keys(snapshot).sort()).toEqual([...inputs.keys()].sort());
    const total = Object.values(snapshot).reduce((n, c) => n + Object.keys(c.tier1).length, 0);
    // A snapshot of nothing would pass every comparison below.
    expect(total).toBeGreaterThan(100);
  });

  for (const [label, before] of Object.entries(snapshot)) {
    it(`${label}: every tier-1 name is where it was`, () => {
      const after = now.get(label);
      expect(after, `${label} is no longer converted`).toBeDefined();
      // A changed fixture cannot be compared with names taken from its old bytes.
      expect(after!.sha256, `${label} changed; its tier-1 names must be re-pinned deliberately`).toBe(before.sha256);
      expect(after!.tier1).toEqual(before.tier1);
    });
  }
});
