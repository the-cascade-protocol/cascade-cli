/**
 * The header is judged by its TEXT, not by what a JSON parser makes of it
 * (pod encryption specification, sections 4.5 and 5.1).
 *
 *  - `t`, `m` and `p` are plain decimal digits: `0|[1-9][0-9]*`. `JSON.parse`
 *    reads `3.0`, `3e0` and `30e-1` all as the integer 3, and another reader's
 *    parser may not, so a header that opens here and is refused elsewhere is a
 *    disagreement the text alone can settle. Each of them is refused, as are
 *    `-0` and `"3"`.
 *  - The bytes are UTF-8 or the header is refused. A decoder that swaps an
 *    invalid sequence for U+FFFD hands the parser a header no other reader
 *    sees; a byte order mark is refused too.
 *
 * Unimplemented wraps are not read (4.3), so their members are not held to
 * the number rule.
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
const PASSPHRASE = 'header-lexical-passphrase';
const DEK = generateDek();
const V11_TEXT = serializeEncryptionManifestV11(buildPassphraseManifestV11(DEK, PASSPHRASE, { kdf: FAST_KDF }));
const V10_TEXT = JSON.stringify(buildPassphraseManifestV10(DEK, PASSPHRASE, FAST_KDF), null, 2);

function expectMalformed(text: string, pattern: RegExp): void {
  let caught: unknown;
  try {
    parseEncryptionManifest(text);
  } catch (e) {
    caught = e;
  }
  expect(caught, text).toBeInstanceOf(EncryptionManifestError);
  expect((caught as EncryptionManifestError).kind).toBe('malformed');
  expect((caught as Error).message).toMatch(pattern);
}

/** Replace the one `"<name>": <digits>` in a header's text with another spelling. */
function respell(text: string, name: 't' | 'm' | 'p', written: string): string {
  const re = new RegExp(`"${name}": [0-9]+`);
  expect(text).toMatch(re);
  return text.replace(re, `"${name}": ${written}`);
}

describe('t, m and p must be written as plain decimal digits', () => {
  it('the plain spellings open (control)', () => {
    expect(unlockManifest(parseEncryptionManifest(V11_TEXT).normalized, PASSPHRASE).dek.equals(DEK)).toBe(true);
    expect(unlockManifest(parseEncryptionManifest(V10_TEXT).normalized, PASSPHRASE).dek.equals(DEK)).toBe(true);
    // Whitespace around a number is JSON's, not the number's.
    expect(() => parseEncryptionManifest(V11_TEXT.replace('"t": 1', '"t":\n   1'))).not.toThrow();
  });

  const spellings: Array<[string, 't' | 'm' | 'p', string]> = [
    ['t as 1.0', 't', '1.0'],
    ['t as 1e0', 't', '1e0'],
    ['t as 10e-1', 't', '10e-1'],
    ['t as 1E0', 't', '1E0'],
    ['m as 6.4e1', 'm', '6.4e1'],
    ['m as 64.0', 'm', '64.0'],
    ['p as 1e0', 'p', '1e0'],
    ['p as 1.00', 'p', '1.00'],
  ];

  for (const [label, name, written] of spellings) {
    it(`1.1: ${label} is refused, although it denotes an integer in range`, () => {
      expectMalformed(respell(V11_TEXT, name, written), new RegExp(`kdfParams\\.${name} must be written as plain decimal digits`));
    });
    it(`1.0: ${label} is refused, although it denotes an integer in range`, () => {
      expectMalformed(respell(V10_TEXT, name, written), new RegExp(`kdfParams\\.${name} must be written as plain decimal digits`));
    });
  }

  it('-0 and a string "1" are refused', () => {
    expectMalformed(respell(V11_TEXT, 't', '-0'), /t, m and p must be positive integers|plain decimal digits/);
    expectMalformed(respell(V11_TEXT, 't', '"1"'), /t, m and p must be positive integers/);
  });

  it('the rule reads the number of the wrap that is used, in every passphrase wrap', () => {
    const two = JSON.parse(V11_TEXT) as { wraps: Array<Record<string, unknown>> };
    const second = buildPassphraseManifestV11(DEK, 'second-passphrase', { kdf: FAST_KDF }).wraps[0];
    two.wraps.push({ ...second, label: 'second' });
    const text = JSON.stringify(two, null, 2);
    expect(() => parseEncryptionManifest(text)).not.toThrow();
    // Only the SECOND wrap's p is respelled: the first wrap being fine does not excuse it.
    const idx = text.lastIndexOf('"p": 1');
    expectMalformed(text.slice(0, idx) + '"p": 1.0' + text.slice(idx + '"p": 1'.length), /wraps\[1\] kdfParams\.p/);
  });

  it('a member elsewhere that merely LOOKS like the path cannot vouch for the real one', () => {
    // `{"kdfParams/t": 1}` or `{"wraps.0.kdfParams.t": 1}` must not be mistaken for kdfParams.t.
    const withDecoy = respell(V11_TEXT, 't', '1.0').replace(
      '"version": "1.1",',
      '"version": "1.1", "kdfParams/t": 1, "[\\"wraps\\",0,\\"kdfParams\\",\\"t\\"]": 1,',
    );
    expectMalformed(withDecoy, /kdfParams\.t must be written as plain decimal digits/);
  });

  it('an unimplemented wrap is not read, so its numbers are not held to the rule', () => {
    const header = JSON.parse(V11_TEXT) as { wraps: Array<Record<string, unknown>> };
    header.wraps.push({ by: 'device-keychain', label: null, createdAt: null, kdfParams: { t: 1 } });
    const text = JSON.stringify(header, null, 2).replace(/"t": 1\n(\s*)}\n(\s*)}\n(\s*)]/, '"t": 1.0\n$1}\n$2}\n$3]');
    expect(text).toContain('"t": 1.0');
    expect(() => parseEncryptionManifest(text)).not.toThrow();
  });

  it('deep nesting in an unknown member does not break the check', () => {
    const header = JSON.parse(V11_TEXT) as Record<string, unknown>;
    let deep: unknown = 1.5;
    for (let i = 0; i < 5000; i++) deep = [deep];
    header.extra = deep;
    expect(() => parseEncryptionManifest(JSON.stringify(header))).not.toThrow();
  });
});

describe('the header bytes must be valid UTF-8 without a byte order mark', () => {
  function podWithHeaderBytes(bytes: Buffer): string {
    const pod = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-header-utf8-'));
    fs.mkdirSync(path.join(pod, 'settings'));
    fs.writeFileSync(path.join(pod, 'settings', 'encryption.json'), bytes);
    return pod;
  }

  function expectFileMalformed(bytes: Buffer, pattern: RegExp): void {
    const pod = podWithHeaderBytes(bytes);
    try {
      let caught: unknown;
      try {
        readEncryptionManifest(pod);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EncryptionManifestError);
      expect((caught as EncryptionManifestError).kind).toBe('malformed');
      expect((caught as Error).message).toMatch(pattern);
    } finally {
      fs.rmSync(pod, { recursive: true, force: true });
    }
  }

  it('the valid header reads (control)', () => {
    const pod = podWithHeaderBytes(Buffer.from(V11_TEXT, 'utf-8'));
    try {
      expect(readEncryptionManifest(pod)?.version).toBe('1.1');
    } finally {
      fs.rmSync(pod, { recursive: true, force: true });
    }
  });

  it('an invalid UTF-8 byte inside a string (a label) is refused, not replaced', () => {
    const text = V11_TEXT.replace('"label": "primary"', '"label": "prim\u0001ry"');
    const bytes = Buffer.from(text, 'utf-8');
    bytes[bytes.indexOf(0x01)] = 0xff;
    expectFileMalformed(bytes, /not valid UTF-8/);
  });

  it('an overlong encoding and a lone continuation byte are refused', () => {
    for (const bad of [[0xc0, 0xaf], [0x80]]) {
      const text = V11_TEXT.replace('"label": "primary"', '"label": "pri@@ary"');
      const bytes = Buffer.from(text, 'utf-8');
      const at = bytes.indexOf('@@');
      const out = Buffer.concat([bytes.subarray(0, at), Buffer.from(bad), bytes.subarray(at + 2)]);
      expectFileMalformed(out, /not valid UTF-8/);
    }
  });

  it('a byte order mark is refused', () => {
    expectFileMalformed(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(V11_TEXT, 'utf-8')]), /byte order mark/);
  });
});
