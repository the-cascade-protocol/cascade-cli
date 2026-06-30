/**
 * Parity contract for the Cascade terminology resolver (S2).
 *
 * Canonical definition: sdk-typescript/src/utils/terminology.ts + its
 * src/data/cascade-terminology.json. cascade-cli holds a byte-identical copy.
 * These vectors mirror sdk-typescript/tests/terminology.test.ts; if they drift,
 * the reconciler's brand/generic dedup and the grounder's lay-synonym retrieval
 * stop agreeing. The asset JSON is also byte-identical (diff-checked in CI by
 * regeneration; here we pin the entries the matcher depends on).
 */

import { describe, it, expect } from 'vitest';
import {
  cascadeTerminologyResolver,
  identityTerminologyResolver,
  createTerminologyResolver,
} from '../src/lib/terminology.js';

describe('cascadeTerminologyResolver (parity with sdk-typescript)', () => {
  const r = cascadeTerminologyResolver();

  it('resolves brand to generic, case-insensitively', () => {
    expect(r.toGeneric('Zyrtec')).toBe('cetirizine');
    expect(r.toGeneric('  LIPITOR  ')).toBe('atorvastatin');
    expect(r.toGeneric('cetirizine')).toBeUndefined();
  });

  it('resolves a lay synonym to a ratified code', () => {
    expect(r.toCodes('sugar')).toEqual([{ system: 'loinc', value: '2339-0' }]);
    expect(r.toCodes('heart attack')).toEqual([{ system: 'snomed', value: '22298006' }]);
    expect(r.toCodes('weekend hiking')).toEqual([]);
  });
});

describe('identityTerminologyResolver (degrades to no-op)', () => {
  it('misses every lookup', () => {
    expect(identityTerminologyResolver.toGeneric('Zyrtec')).toBeUndefined();
    expect(identityTerminologyResolver.toCodes('sugar')).toEqual([]);
  });
});

describe('createTerminologyResolver', () => {
  it('builds over a custom asset', () => {
    const r = createTerminologyResolver({
      version: 't',
      brandToGeneric: { tylenol: 'acetaminophen' },
      concepts: {},
    });
    expect(r.toGeneric('Tylenol')).toBe('acetaminophen');
  });
});
