/**
 * Unit tests for the pod-encryption core module.
 *
 * Covers the AES-256-GCM combined-layout round-trip, DEK wrapping with an
 * Argon2id passphrase KEK, manifest I/O, and the clean error on a wrong
 * passphrase. No CLI is driven here (see pod-encryption-integration.test.ts).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  generateDek,
  encryptResource,
  decryptResource,
  deriveKek,
  wrapDek,
  unwrapDek,
  buildPassphraseManifest,
  writeEncryptionManifest,
  readEncryptionManifest,
  isPodEncrypted,
  resolveDek,
  readResource,
  writeResource,
  PodDecryptError,
  NONCE_LEN,
  TAG_LEN,
  KEY_LEN,
  DEFAULT_KDF,
} from '../src/lib/pod-encryption.js';

// Use cheap Argon2id params in tests to keep them fast. (m is in KiB.)
const FAST_KDF = { t: 2, m: 256, p: 1 };

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-enc-'));
}

describe('encryptResource / decryptResource', () => {
  it('round-trips and produces the combined nonce||ct||tag layout', () => {
    const dek = generateDek();
    expect(dek.length).toBe(KEY_LEN);

    const plaintext = '@prefix ex: <http://example.org/> . ex:s ex:p "hello" .';
    const blob = encryptResource(plaintext, dek);

    const plaintextBytes = Buffer.from(plaintext, 'utf-8').length;
    expect(blob.length).toBe(NONCE_LEN + plaintextBytes + TAG_LEN);

    expect(decryptResource(blob, dek)).toBe(plaintext);
  });

  it('uses a fresh random nonce per call', () => {
    const dek = generateDek();
    const a = encryptResource('same plaintext', dek);
    const b = encryptResource('same plaintext', dek);
    // First NONCE_LEN bytes are the nonce; they must differ.
    expect(a.subarray(0, NONCE_LEN).equals(b.subarray(0, NONCE_LEN))).toBe(false);
    // And the whole ciphertext therefore differs.
    expect(a.equals(b)).toBe(false);
  });

  it('throws PodDecryptError when the DEK is wrong', () => {
    const blob = encryptResource('secret', generateDek());
    expect(() => decryptResource(blob, generateDek())).toThrow(PodDecryptError);
  });

  it('throws PodDecryptError on a truncated/corrupt blob', () => {
    const dek = generateDek();
    const blob = encryptResource('secret', dek);
    const corrupt = blob.subarray(0, 5); // too short
    expect(() => decryptResource(corrupt, dek)).toThrow(PodDecryptError);
  });
});

describe('deriveKek / wrapDek / unwrapDek', () => {
  it('derives a 32-byte KEK deterministically for the same salt', () => {
    const salt = Buffer.from('0123456789abcdef');
    const k1 = deriveKek('correct horse', salt, FAST_KDF);
    const k2 = deriveKek('correct horse', salt, FAST_KDF);
    expect(k1.length).toBe(KEY_LEN);
    expect(k1.equals(k2)).toBe(true);
  });

  it('round-trips a DEK wrapped with the KEK', () => {
    const dek = generateDek();
    const salt = Buffer.from('0123456789abcdef');
    const kek = deriveKek('passphrase', salt, FAST_KDF);

    const wrapped = wrapDek(dek, kek);
    expect(typeof wrapped).toBe('string'); // base64
    const unwrapped = unwrapDek(wrapped, kek);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it('throws the clean error when unwrapping with the wrong KEK', () => {
    const dek = generateDek();
    const salt = Buffer.from('0123456789abcdef');
    const goodKek = deriveKek('right', salt, FAST_KDF);
    const badKek = deriveKek('wrong', salt, FAST_KDF);

    const wrapped = wrapDek(dek, goodKek);
    expect(() => unwrapDek(wrapped, badKek)).toThrow(PodDecryptError);
    expect(() => unwrapDek(wrapped, badKek)).toThrow(/incorrect passphrase or corrupt key/);
  });
});

describe('manifest I/O and resolveDek', () => {
  it('writes and reads a manifest; isPodEncrypted reflects presence', () => {
    const dir = mkTmpDir();
    expect(isPodEncrypted(dir)).toBe(false);

    const dek = generateDek();
    const manifest = buildPassphraseManifest(dek, 'hunter2', FAST_KDF);
    writeEncryptionManifest(dir, manifest);

    expect(isPodEncrypted(dir)).toBe(true);
    const read = readEncryptionManifest(dir);
    expect(read).not.toBeNull();
    expect(read!.algorithm).toBe('aes-256-gcm');
    expect(read!.kdf).toBe('argon2id');
    expect(read!.wraps[0].by).toBe('passphrase');
    expect(read!.kdfParams.t).toBe(FAST_KDF.t);
  });

  it('resolveDek recovers the same DEK with the right passphrase', () => {
    const dir = mkTmpDir();
    const dek = generateDek();
    writeEncryptionManifest(dir, buildPassphraseManifest(dek, 'hunter2', FAST_KDF));

    const resolved = resolveDek(dir, 'hunter2');
    expect(resolved.equals(dek)).toBe(true);
  });

  it('resolveDek throws the clean error on a wrong passphrase', () => {
    const dir = mkTmpDir();
    const dek = generateDek();
    writeEncryptionManifest(dir, buildPassphraseManifest(dek, 'hunter2', FAST_KDF));

    expect(() => resolveDek(dir, 'wrong-pass')).toThrow(PodDecryptError);
  });

  it('records the default KDF params in a manifest built without overrides', () => {
    const dek = generateDek();
    const m = buildPassphraseManifest(dek, 'pw'); // default DEFAULT_KDF (slow; just inspect params)
    expect(m.kdfParams.t).toBe(DEFAULT_KDF.t);
    expect(m.kdfParams.m).toBe(DEFAULT_KDF.m);
    expect(m.kdfParams.p).toBe(DEFAULT_KDF.p);
  });
});

describe('readResource / writeResource passthrough', () => {
  it('writes ciphertext (not Turtle) with a DEK and reads it back', () => {
    const dir = mkTmpDir();
    const file = path.join(dir, 'r.ttl');
    const dek = generateDek();
    const ttl = '@prefix ex: <http://example.org/> . ex:s a ex:Thing .';

    writeResource(file, ttl, dek);
    const onDisk = fs.readFileSync(file);
    // On-disk bytes must not be readable Turtle.
    expect(onDisk.toString('utf-8')).not.toContain('@prefix');

    expect(readResource(file, dek)).toBe(ttl);
  });

  it('writes and reads plaintext when no DEK is supplied', () => {
    const dir = mkTmpDir();
    const file = path.join(dir, 'r.ttl');
    const ttl = '@prefix ex: <http://example.org/> .';
    writeResource(file, ttl);
    expect(fs.readFileSync(file, 'utf-8')).toBe(ttl);
    expect(readResource(file)).toBe(ttl);
  });
});
