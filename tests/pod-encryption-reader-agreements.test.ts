/**
 * Two reading rules every reader of `settings/encryption.json` applies the
 * same way, so no header opens in one reader and is refused by another:
 *
 *  1. A wrap's `by` must be a non-empty string. `"by": ""` makes the whole
 *     header malformed; a non-empty kind the reader does not implement is
 *     skipped, and the other wraps still open.
 *  2. A 1.0 header has no labels on disk. It reads with its first passphrase
 *     wrap labelled `"primary"` and every other wrap `null`, which is exactly
 *     what migrating it to 1.1 writes.
 */

import { describe, it, expect } from 'vitest';
import {
  generateDek,
  buildPassphraseManifest,
  parseEncryptionManifest,
  unlockManifest,
  migrateManifest,
  serializeEncryptionManifestV11,
  EncryptionManifestError,
  type EncryptionManifestV10,
} from '../src/lib/pod-encryption.js';

const FAST_KDF = { t: 1, m: 64, p: 1 };
const PASSPHRASE = 'reader-agreements-passphrase';
const DEK = generateDek();
const V10 = buildPassphraseManifest(DEK, PASSPHRASE, FAST_KDF);
const V11 = migrateManifest(V10);

function v10With(wraps: Array<Record<string, unknown>>): string {
  return JSON.stringify({ ...V10, wraps });
}

function v11With(wraps: Array<Record<string, unknown>>): string {
  return JSON.stringify({ ...V11, wraps });
}

function expectMalformed(text: string, pattern: RegExp): void {
  let caught: unknown;
  try {
    parseEncryptionManifest(text);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(EncryptionManifestError);
  expect((caught as EncryptionManifestError).kind).toBe('malformed');
  expect((caught as Error).message).toMatch(pattern);
}

describe('"by": "" is malformed; a non-empty unknown "by" is skipped', () => {
  it('1.0: an empty "by" refuses the whole header, even after a wrap that would open', () => {
    expectMalformed(v10With([V10.wraps[0], { by: '', wrappedDek: V10.wraps[0].wrappedDek }]), /wrap 1 has no "by"/);
  });

  it('1.1: an empty "by" refuses the whole header, even after a wrap that would open', () => {
    expectMalformed(v11With([V11.wraps[0], { by: '', label: null, createdAt: null }]), /wrap 1 has no "by"/);
  });

  it('1.0 and 1.1: a non-empty unknown "by" is skipped and the passphrase wrap still opens', () => {
    for (const text of [
      v10With([{ by: 'a-future-kind', opaque: 'x' }, V10.wraps[0]]),
      v11With([{ by: 'a-future-kind', label: null, createdAt: null, opaque: 'x' }, V11.wraps[0]]),
    ]) {
      const { normalized } = parseEncryptionManifest(text);
      expect(normalized.wraps.map((w) => w.kind)).toEqual(['unimplemented', 'passphrase']);
      const opened = unlockManifest(normalized, PASSPHRASE);
      expect(opened.wrapIndex).toBe(1);
      expect(opened.dek.equals(DEK)).toBe(true);
    }
  });
});

describe('a 1.0 header reads with the labels its migration writes', () => {
  it('the first passphrase wrap is "primary", every other wrap null', () => {
    const text = v10With([
      { by: 'device-keychain' },
      V10.wraps[0],
      { by: 'passphrase', wrappedDek: V10.wraps[0].wrappedDek },
    ]);
    const { normalized } = parseEncryptionManifest(text);
    expect(normalized.wraps.map((w) => w.label)).toEqual([null, 'primary', null]);
    expect(normalized.wraps.every((w) => w.createdAt === null)).toBe(true);
  });

  it('reading 1.0 and reading its 1.1 migration give the same labels', () => {
    const v10 = JSON.parse(v10With([{ by: 'device-keychain' }, V10.wraps[0]])) as EncryptionManifestV10;
    const before = parseEncryptionManifest(JSON.stringify(v10)).normalized;
    const after = parseEncryptionManifest(serializeEncryptionManifestV11(migrateManifest(v10))).normalized;
    expect(before.wraps.map((w) => [w.by, w.label, w.createdAt])).toEqual(
      after.wraps.map((w) => [w.by, w.label, w.createdAt]),
    );
  });
});
