/**
 * VRS hash-validation tests (TASK-3B.3 negative path).
 *
 * The implementation plan requires that an Allele whose declared id
 * does not match the deterministic hash of its canonical form be
 * REJECTED. Because the corpus fixture was produced by vrs-python's
 * recursive-digest canonicalization (which cascade-cli does not
 * reproduce), the "matching" case is exercised by constructing a
 * synthetic Allele whose declared id WAS produced by the cli's
 * simple-canonical hash, then mutating `state.sequence` and confirming
 * the importer rejects.
 *
 * The default mismatch path is also exercised: corpus + no flag →
 * REJECT; corpus + --allow-vrs-hash-mismatch → accept with info gap.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ingestVrsAllele,
  computeSimpleVrsDigest,
  hasValidVrsForm,
  looksLikeVrsAllele,
} from '../src/lib/vrs-converter/allele.js';
import type { ImportContext } from '../src/lib/import-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VRS_FIXTURE = path.resolve(
  __dirname,
  '../../conformance/fixtures/genomics/vrs/example-allele-BRCA2-deletion.input.json',
);

const STRICT_CTX: ImportContext = {
  inputPath: '<test>',
  outputSerialization: 'turtle',
  importedAt: '2026-05-05T00:00:00Z',
  options: {},
};

const PERMISSIVE_CTX: ImportContext = {
  ...STRICT_CTX,
  options: { allowVrsHashMismatch: true },
};

/** Build a synthetic Allele whose declared id is its simple canonical hash. */
function buildSelfConsistentAllele(sequenceState: string) {
  const payload = {
    type: 'Allele' as const,
    location: {
      type: 'SequenceLocation',
      sequence_id: 'ga4gh:SQ.test',
      interval: {
        type: 'SequenceInterval',
        start: { type: 'Number', value: 100 },
        end: { type: 'Number', value: 101 },
      },
    },
    state: { type: 'LiteralSequenceExpression', sequence: sequenceState },
  };
  // computeSimpleVrsDigest drops `id` itself, so we can pass payload directly
  // without an id field, then attach the digest as the declared id.
  const digest = computeSimpleVrsDigest(payload);
  return { ...payload, id: digest };
}

describe('hasValidVrsForm', () => {
  it('accepts ga4gh:VA. + 32 base64url chars', () => {
    expect(hasValidVrsForm('ga4gh:VA.S3LWLZ-vfWfvxtOdT_BcsoMaP1mLfuNS')).toBe(true);
  });

  it('rejects wrong prefix', () => {
    expect(hasValidVrsForm('ga4gh:SL.S3LWLZ-vfWfvxtOdT_BcsoMaP1mLfuNS')).toBe(false);
  });

  it('rejects wrong payload length', () => {
    expect(hasValidVrsForm('ga4gh:VA.tooShort')).toBe(false);
    expect(hasValidVrsForm('ga4gh:VA.' + 'x'.repeat(40))).toBe(false);
  });

  it('rejects non-base64url chars in payload', () => {
    expect(hasValidVrsForm('ga4gh:VA.' + '!'.repeat(32))).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(hasValidVrsForm(undefined)).toBe(false);
    expect(hasValidVrsForm(123)).toBe(false);
  });
});

describe('looksLikeVrsAllele', () => {
  it('accepts a canonical Allele', () => {
    expect(
      looksLikeVrsAllele({
        type: 'Allele',
        id: 'ga4gh:VA.x',
        location: {},
        state: {},
      }),
    ).toBe(true);
  });

  it('rejects when type is missing or wrong', () => {
    expect(looksLikeVrsAllele({ id: 'x', location: {}, state: {} })).toBe(false);
    expect(
      looksLikeVrsAllele({ type: 'CopyNumber', id: 'x', location: {}, state: {} }),
    ).toBe(false);
  });

  it('rejects when location or state is absent', () => {
    expect(looksLikeVrsAllele({ type: 'Allele', id: 'x', state: {} })).toBe(false);
    expect(looksLikeVrsAllele({ type: 'Allele', id: 'x', location: {} })).toBe(false);
  });
});

describe('ingestVrsAllele — REJECT paths', () => {
  it('rejects non-VRS-Allele input with a clear error', () => {
    const out = ingestVrsAllele({ resourceType: 'Bundle' }, STRICT_CTX);
    expect(out.error).toBeDefined();
    expect(out.error).toMatch(/not a VRS Allele/);
    expect(out.record).toBeUndefined();
  });

  it('rejects an Allele with malformed declared id', () => {
    const allele = buildSelfConsistentAllele('A');
    const broken = { ...allele, id: 'not-a-vrs-id' };
    const out = ingestVrsAllele(broken, STRICT_CTX);
    expect(out.error).toMatch(/invalid form/);
  });

  it('rejects an Allele whose declared id does not simple-hash to its content (default strict)', () => {
    const allele = buildSelfConsistentAllele('A');
    // Mutate state.sequence after the id was computed → simple hash now differs.
    const mutated = {
      ...allele,
      state: { ...allele.state, sequence: 'TTT' },
    };
    const out = ingestVrsAllele(mutated, STRICT_CTX);
    expect(out.error).toMatch(/hash mismatch/);
    expect(out.record).toBeUndefined();
  });

  it('also rejects the corpus BRCA2 fixture in strict mode', () => {
    const text = fs.readFileSync(VRS_FIXTURE, 'utf-8');
    const cleaned = text
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    const out = ingestVrsAllele(JSON.parse(cleaned), STRICT_CTX);
    expect(out.error).toMatch(/hash mismatch/);
  });
});

describe('ingestVrsAllele — ACCEPT paths', () => {
  it('accepts a self-consistent Allele in strict mode', () => {
    const allele = buildSelfConsistentAllele('A');
    const out = ingestVrsAllele(allele, STRICT_CTX);
    expect(out.error).toBeUndefined();
    expect(out.record).toBeDefined();
    expect(out.record!.cascadeType).toBe('genomics:Variant');
  });

  it('accepts the corpus BRCA2 fixture in permissive mode (info gap)', () => {
    const text = fs.readFileSync(VRS_FIXTURE, 'utf-8');
    const cleaned = text
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    const out = ingestVrsAllele(JSON.parse(cleaned), PERMISSIVE_CTX);
    expect(out.error).toBeUndefined();
    expect(out.record).toBeDefined();
    const mismatchGap = out.gaps.find((g) => g.sourceField === 'VRS.Allele.id');
    expect(mismatchGap).toBeDefined();
    expect(mismatchGap?.severity).toBe('info');
  });

  it('does NOT emit a hash-mismatch gap on a self-consistent Allele', () => {
    const allele = buildSelfConsistentAllele('A');
    const out = ingestVrsAllele(allele, STRICT_CTX);
    const mismatchGap = out.gaps.find((g) => g.sourceField === 'VRS.Allele.id');
    expect(mismatchGap).toBeUndefined();
  });
});

describe('computeSimpleVrsDigest', () => {
  it('produces a stable hash for the same payload', () => {
    const payload = { type: 'Allele', location: {}, state: { sequence: 'A' } };
    const a = computeSimpleVrsDigest(payload);
    const b = computeSimpleVrsDigest(payload);
    expect(a).toBe(b);
  });

  it('ignores top-level id when computing the digest', () => {
    const a = computeSimpleVrsDigest({ type: 'Allele', state: { x: 1 } });
    const b = computeSimpleVrsDigest({ type: 'Allele', id: 'ga4gh:VA.X', state: { x: 1 } });
    expect(a).toBe(b);
  });

  it('changes when payload content changes', () => {
    const a = computeSimpleVrsDigest({ type: 'Allele', state: { sequence: 'A' } });
    const b = computeSimpleVrsDigest({ type: 'Allele', state: { sequence: 'TTT' } });
    expect(a).not.toBe(b);
  });

  it('produces a ga4gh:VA.<32-char base64url> result', () => {
    const id = computeSimpleVrsDigest({ foo: 'bar' });
    expect(/^ga4gh:VA\.[A-Za-z0-9_-]{32}$/.test(id)).toBe(true);
  });
});
