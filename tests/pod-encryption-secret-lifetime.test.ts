/**
 * Secret material is zeroed as soon as it is no longer needed, where
 * JavaScript allows it.
 *
 * A passphrase string cannot be zeroed (strings are immutable), but its
 * encoded bytes can. A key is a Buffer, and every copy the tool makes of one
 * can be. These tests capture the buffers the crypto primitives see and hand
 * back, and check they are all zero once the operation is over, so a stray
 * copy shows up as a failure instead of as nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const seen = vi.hoisted(() => ({
  passwords: [] as Uint8Array[],
  outputs: [] as Uint8Array[],
  decipherChunks: [] as Buffer[],
}));

vi.mock('@noble/hashes/argon2.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/hashes/argon2.js')>();
  return {
    ...actual,
    argon2id: (...args: Parameters<typeof actual.argon2id>) => {
      seen.passwords.push(args[0] as Uint8Array);
      const out = actual.argon2id(...args);
      seen.outputs.push(out);
      return out;
    },
  };
});

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const createDecipheriv = ((...args: Parameters<typeof actual.createDecipheriv>) => {
    const d = actual.createDecipheriv(...args);
    const update = d.update.bind(d) as (data: Buffer) => Buffer;
    (d as unknown as { update: (data: Buffer) => Buffer }).update = (data: Buffer): Buffer => {
      const chunk = update(data);
      seen.decipherChunks.push(chunk);
      return chunk;
    };
    return d;
  }) as typeof actual.createDecipheriv;
  return { ...actual, createDecipheriv, default: { ...actual, createDecipheriv } };
});

import {
  generateDek,
  deriveKek,
  wrapDek,
  unwrapDek,
  buildPassphraseManifest,
  PodDecryptError,
} from '../src/lib/pod-encryption.js';
import { envWithoutPodSecrets } from '../src/lib/passphrase.js';

const FAST_KDF = { t: 1, m: 64, p: 1 };
const SALT = Buffer.alloc(16, 7);
const allZero = (b: Uint8Array): boolean => b.length > 0 && b.every((x) => x === 0);

beforeEach(() => {
  seen.passwords.length = 0;
  seen.outputs.length = 0;
  seen.decipherChunks.length = 0;
});

describe('deriveKek', () => {
  it('zeroes the encoded passphrase bytes once the key is derived', () => {
    const kek = deriveKek('a passphrase', SALT, FAST_KDF);
    expect(kek).toHaveLength(32);
    expect(seen.passwords).toHaveLength(1);
    expect(allZero(seen.passwords[0])).toBe(true);
  });

  it('returns the derivation output itself, so zeroing the KEK leaves no copy', () => {
    const kek = deriveKek('a passphrase', SALT, FAST_KDF);
    expect(allZero(seen.outputs[0])).toBe(false);
    kek.fill(0);
    expect(allZero(seen.outputs[0])).toBe(true);
  });
});

describe('buildPassphraseManifest', () => {
  it('zeroes its KEK after wrapping the data key', () => {
    buildPassphraseManifest(generateDek(), 'a passphrase', FAST_KDF);
    expect(seen.outputs).toHaveLength(1);
    expect(allZero(seen.outputs[0])).toBe(true);
  });
});

describe('unwrapping a key', () => {
  it('leaves no second copy of the key in the decipher output', () => {
    const dek = generateDek();
    const kek = Buffer.alloc(32, 1);
    const unwrapped = unwrapDek(wrapDek(dek, kek), kek);
    expect(unwrapped.equals(dek)).toBe(true);
    expect(seen.decipherChunks.length).toBeGreaterThan(0);
    for (const chunk of seen.decipherChunks) expect(allZero(chunk)).toBe(true);
  });

  it('zeroes the unauthenticated bytes when the tag does not verify', () => {
    const wrapped = wrapDek(generateDek(), Buffer.alloc(32, 1));
    expect(() => unwrapDek(wrapped, Buffer.alloc(32, 2))).toThrow(PodDecryptError);
    for (const chunk of seen.decipherChunks) expect(allZero(chunk)).toBe(true);
  });
});

describe('child processes do not inherit the pod passphrase', () => {
  it('envWithoutPodSecrets drops both passphrase variables and keeps the rest', () => {
    const env = {
      PATH: '/usr/bin',
      CASCADE_POD_PASSPHRASE: 'current',
      CASCADE_POD_NEW_PASSPHRASE: 'next',
      CASCADE_LLAMA_URL: 'http://127.0.0.1:1',
    };
    expect(envWithoutPodSecrets(env)).toEqual({ PATH: '/usr/bin', CASCADE_LLAMA_URL: 'http://127.0.0.1:1' });
    expect(env.CASCADE_POD_PASSPHRASE).toBe('current');
  });

  it('pod extract starts the model server with that environment', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, '..', 'src', 'commands', 'pod', 'extract.ts'), 'utf-8');
    const spawnCall = source.slice(source.indexOf("spawn('cascade'"));
    expect(spawnCall.slice(0, spawnCall.indexOf('});'))).toContain('env: envWithoutPodSecrets()');
  });
});
