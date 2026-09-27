/**
 * A header in which any JSON object contains the same member name twice is
 * malformed; readers refuse it before deriving any key (pod encryption
 * specification, 4.1).
 *
 * `JSON.parse` keeps the last occurrence of a repeated member and says nothing,
 * and another reader's parser may keep the first, so the same bytes could open
 * one way here and another way elsewhere. The rule is judged on the header's
 * TEXT, in every object (top level, a wrap, `kdfParams`, an unknown member),
 * with names compared after their escapes are decoded.
 *
 * Only a repeat inside ONE object is a duplicate: the same name in two wraps,
 * or at two depths, is ordinary.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  generateDek,
  buildPassphraseManifestV10,
  buildPassphraseManifestV11,
  parseEncryptionManifest,
  readEncryptionManifest,
  serializeEncryptionManifestV11,
  unlockManifest,
  EncryptionManifestError,
} from '../src/lib/pod-encryption.js';

const FAST_KDF = { t: 1, m: 64, p: 1 };
const PASSPHRASE = 'header-duplicates-passphrase';
const DEK = generateDek();
const V11_TEXT = serializeEncryptionManifestV11(buildPassphraseManifestV11(DEK, PASSPHRASE, { kdf: FAST_KDF }));
const V10_TEXT = JSON.stringify(buildPassphraseManifestV10(DEK, PASSPHRASE, FAST_KDF), null, 2);

/** Insert `extra` right after the one occurrence of `anchor` in `text`. */
function after(text: string, anchor: string, extra: string): string {
  expect(text.split(anchor)).toHaveLength(2);
  return text.replace(anchor, anchor + extra);
}

function refusal(text: string): EncryptionManifestError {
  let caught: unknown;
  try {
    parseEncryptionManifest(text);
  } catch (e) {
    caught = e;
  }
  expect(caught, text).toBeInstanceOf(EncryptionManifestError);
  return caught as EncryptionManifestError;
}

function expectDuplicateRefused(text: string): void {
  const e = refusal(text);
  expect(e.kind).toBe('malformed');
  expect(e.message).toMatch(/same member name twice/);
}

describe('a repeated member name in any object refuses the header', () => {
  it('the header without a repeat opens (control)', () => {
    expect(unlockManifest(parseEncryptionManifest(V11_TEXT).normalized, PASSPHRASE).dek.equals(DEK)).toBe(true);
    expect(unlockManifest(parseEncryptionManifest(V10_TEXT).normalized, PASSPHRASE).dek.equals(DEK)).toBe(true);
  });

  it('top level: the same member with the same value twice', () => {
    expectDuplicateRefused(after(V11_TEXT, '"algorithm": "aes-256-gcm",', '\n  "algorithm": "aes-256-gcm",'));
    expectDuplicateRefused(after(V10_TEXT, '"algorithm": "aes-256-gcm",', '\n  "algorithm": "aes-256-gcm",'));
  });

  it('top level: a repeat whose last occurrence alone would be valid', () => {
    // JSON.parse keeps the last one, so without the rule this header opens.
    expectDuplicateRefused(V11_TEXT.replace('"version": "1.1",', '"version": "2.0",\n  "version": "1.1",'));
  });

  it('inside a wrap', () => {
    expectDuplicateRefused(after(V11_TEXT, '"label": "primary",', '\n      "label": "primary",'));
  });

  it('inside kdfParams', () => {
    expectDuplicateRefused(after(V11_TEXT, '"t": 1,', '\n        "t": 1,'));
    expectDuplicateRefused(after(V10_TEXT, '"t": 1,', '\n    "t": 1,'));
  });

  it('a member this reader does not know, at the top level and inside an unknown member', () => {
    expectDuplicateRefused(after(V11_TEXT, '"version": "1.1",', ' "x-note": 1, "x-note": 1,'));
    expectDuplicateRefused(after(V11_TEXT, '"version": "1.1",', ' "x-note": [{"a": {"b": 1, "b": 2}}],'));
  });

  it('inside a wrap of a kind this reader does not implement', () => {
    const text = after(
      V11_TEXT,
      '"wraps": [',
      '\n    {"by": "device-keychain", "label": null, "createdAt": null, "opaque": 1, "opaque": 1},',
    );
    expectDuplicateRefused(text);
  });

  it('names are compared after escapes are decoded', () => {
    expectDuplicateRefused(after(V11_TEXT, '"version": "1.1",', '\n  "vers\\u0069on": "1.1",'));
    expectDuplicateRefused(after(V11_TEXT, '"label": "primary",', '\n      "lab\\u0065l": "primary",'));
  });

  it('the refusal does not echo the name, which is attacker-chosen', () => {
    const name = 'x-attacker-chosen-' + 'n'.repeat(200);
    const e = refusal(after(V11_TEXT, '"version": "1.1",', ` "${name}": 1, "${name}": 1,`));
    expect(e.message).not.toContain('attacker-chosen');
  });

  it('is refused from the file too, before any key is derived', () => {
    const pod = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-header-dup-'));
    try {
      fs.mkdirSync(path.join(pod, 'settings'));
      fs.writeFileSync(
        path.join(pod, 'settings', 'encryption.json'),
        after(V11_TEXT, '"algorithm": "aes-256-gcm",', '\n  "algorithm": "aes-256-gcm",'),
      );
      // readEncryptionManifest derives nothing: a refusal here is a refusal
      // before derivation.
      let caught: unknown;
      try {
        readEncryptionManifest(pod);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EncryptionManifestError);
      expect((caught as EncryptionManifestError).kind).toBe('malformed');
    } finally {
      fs.rmSync(pod, { recursive: true, force: true });
    }
  });
});

describe('the same name in different objects is not a duplicate', () => {
  it('two wraps each with every member', () => {
    const header = JSON.parse(V11_TEXT) as { wraps: Array<Record<string, unknown>> };
    const second = buildPassphraseManifestV11(DEK, 'second-passphrase', { kdf: FAST_KDF }).wraps[0];
    header.wraps.push({ ...second, label: 'second' });
    const text = JSON.stringify(header, null, 2);
    expect(unlockManifest(parseEncryptionManifest(text).normalized, 'second-passphrase').dek.equals(DEK)).toBe(true);
  });

  it('one name at two depths, and a string value that equals a member name', () => {
    let text = after(V11_TEXT, '"version": "1.1",', ' "x-note": "label", "label": {"label": 1},');
    text = after(text, '"label": "primary",', ' "x-note": "version",');
    expect(unlockManifest(parseEncryptionManifest(text).normalized, PASSPHRASE).dek.equals(DEK)).toBe(true);
  });
});
