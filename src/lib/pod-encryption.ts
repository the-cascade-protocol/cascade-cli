/**
 * Pod encryption at rest.
 *
 * Transparent encrypt-on-write / decrypt-on-read for Cascade Pod `.ttl`
 * resources. Uses envelope encryption:
 *
 *   - A random per-pod 256-bit Data Encryption Key (DEK) encrypts each resource.
 *   - The DEK is wrapped by a passphrase-derived Key Encryption Key (KEK).
 *   - The wrapped DEK + KDF parameters live in `settings/encryption.json`.
 *
 * Resource bytes on disk use the CryptoKit `.combined` layout so the bytes are
 * byte-for-byte interoperable with the Swift SDK's `PodEncryption`:
 *
 *   nonce(12) || ciphertext || tag(16)        (AES-256-GCM, 256-bit key)
 *
 * There is NO magic header on the resource blob.
 *
 * The passphrase KEK is derived with Argon2id via `@noble/hashes` (pure JS, no
 * native build). AES-256-GCM is performed with `node:crypto`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';

// ─── Layout constants ─────────────────────────────────────────────────────────

/** GCM nonce length in bytes (CryptoKit uses 12). */
export const NONCE_LEN = 12;
/** GCM authentication tag length in bytes. */
export const TAG_LEN = 16;
/** DEK / KEK length in bytes (256-bit). */
export const KEY_LEN = 32;

// ─── Manifest types ───────────────────────────────────────────────────────────

export interface KdfParams {
  /** Base64 Argon2id salt. */
  salt: string;
  /** Argon2id time cost (iterations). */
  t: number;
  /** Argon2id memory cost in KiB. */
  m: number;
  /** Argon2id parallelism. */
  p: number;
}

/**
 * A single wrap of the pod DEK. Multiple wraps of the SAME DEK may coexist so
 * the pod can be unlocked by different key holders.
 *
 * v1 implements only `passphrase`. A future `device-keychain` wrap is reserved
 * (see {@link EncryptionWrap.by}) but intentionally NOT implemented here.
 */
export interface EncryptionWrap {
  /**
   * The key-holder kind that can unwrap the DEK.
   *
   *  - `passphrase`      — DEK wrapped by an Argon2id passphrase KEK (implemented).
   *  - `device-keychain` — RESERVED. DEK wrapped by a device keychain / secure
   *                        enclave key. Not implemented in v1; the slot exists so
   *                        a future writer can add it without a schema bump.
   */
  by: 'passphrase' | 'device-keychain';
  /** Base64 combined (nonce||ct||tag) of the wrapped DEK. */
  wrappedDek: string;
}

export interface EncryptionManifest {
  version: string;
  algorithm: 'aes-256-gcm';
  kdf: 'argon2id';
  kdfParams: KdfParams;
  wraps: EncryptionWrap[];
}

/** Default Argon2id parameters (t=3, m=64 MiB, p=1). Recorded in the manifest. */
export const DEFAULT_KDF = { t: 3, m: 65536, p: 1 } as const;

export const MANIFEST_RELATIVE_PATH = path.join('settings', 'encryption.json');

/** Clean, user-facing error for any GCM authentication failure. */
export class PodDecryptError extends Error {
  constructor(message = 'incorrect passphrase or corrupt key') {
    super(message);
    this.name = 'PodDecryptError';
  }
}

// ─── Primitive crypto ─────────────────────────────────────────────────────────

/** Generate a fresh random 256-bit Data Encryption Key. */
export function generateDek(): Buffer {
  return randomBytes(KEY_LEN);
}

/**
 * AES-256-GCM encrypt with the supplied 32-byte key, returning the combined
 * `nonce(12) || ciphertext || tag(16)` blob (CryptoKit `.combined` layout).
 */
function sealCombined(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LEN) {
    throw new Error(`Key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}

/**
 * AES-256-GCM open a combined `nonce(12) || ciphertext || tag(16)` blob with the
 * supplied 32-byte key. Throws {@link PodDecryptError} on any auth failure.
 */
function openCombined(blob: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LEN) {
    throw new Error(`Key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
  if (blob.length < NONCE_LEN + TAG_LEN) {
    throw new PodDecryptError();
  }
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM auth failure (wrong key or tampered data).
    throw new PodDecryptError();
  }
}

/**
 * Encrypt a resource's UTF-8 text with the DEK.
 * @returns combined `nonce(12) || ciphertext || tag(16)` blob.
 */
export function encryptResource(plaintext: string, dek: Buffer): Buffer {
  return sealCombined(Buffer.from(plaintext, 'utf-8'), dek);
}

/**
 * Decrypt a combined resource blob with the DEK back to UTF-8 text.
 * @throws {PodDecryptError} on auth failure.
 */
export function decryptResource(blob: Buffer, dek: Buffer): string {
  return openCombined(blob, dek).toString('utf-8');
}

// ─── Key derivation & DEK wrapping ────────────────────────────────────────────

/**
 * Derive a 256-bit KEK from a passphrase using Argon2id.
 *
 * @param passphrase user passphrase
 * @param salt       Argon2id salt
 * @param params     Argon2id cost params (t, m in KiB, p)
 */
export function deriveKek(
  passphrase: string,
  salt: Buffer,
  params: { t: number; m: number; p: number },
): Buffer {
  const out = argon2id(
    new TextEncoder().encode(passphrase),
    new Uint8Array(salt),
    { t: params.t, m: params.m, p: params.p, dkLen: KEY_LEN },
  );
  return Buffer.from(out);
}

/** Wrap (encrypt) the DEK with the KEK. Returns base64 combined blob. */
export function wrapDek(dek: Buffer, kek: Buffer): string {
  return sealCombined(dek, kek).toString('base64');
}

/**
 * Unwrap (decrypt) a base64 combined wrapped-DEK blob with the KEK.
 * @throws {PodDecryptError} when the KEK is wrong or the blob is corrupt.
 */
export function unwrapDek(wrapped: string, kek: Buffer): Buffer {
  return openCombined(Buffer.from(wrapped, 'base64'), kek);
}

// ─── Manifest I/O ─────────────────────────────────────────────────────────────

function manifestPath(podDir: string): string {
  return path.join(podDir, MANIFEST_RELATIVE_PATH);
}

/** Read `settings/encryption.json`, or `null` if the pod is not encrypted. */
export function readEncryptionManifest(podDir: string): EncryptionManifest | null {
  const p = manifestPath(podDir);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf-8');
  return JSON.parse(raw) as EncryptionManifest;
}

/** Write `settings/encryption.json`. */
export function writeEncryptionManifest(podDir: string, manifest: EncryptionManifest): void {
  const p = manifestPath(podDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

/** A pod is encrypted iff it has an encryption manifest. */
export function isPodEncrypted(podDir: string): boolean {
  return fs.existsSync(manifestPath(podDir));
}

// ─── Manifest construction & DEK resolution ───────────────────────────────────

/**
 * Build a fresh encryption manifest for a new DEK protected by a passphrase.
 * Generates a random salt and wraps the DEK with a freshly derived KEK.
 */
export function buildPassphraseManifest(
  dek: Buffer,
  passphrase: string,
  params: { t: number; m: number; p: number } = DEFAULT_KDF,
): EncryptionManifest {
  const salt = randomBytes(16);
  const kek = deriveKek(passphrase, salt, params);
  const wrappedDek = wrapDek(dek, kek);
  return {
    version: '1.0',
    algorithm: 'aes-256-gcm',
    kdf: 'argon2id',
    kdfParams: { salt: salt.toString('base64'), t: params.t, m: params.m, p: params.p },
    wraps: [{ by: 'passphrase', wrappedDek }],
  };
}

/**
 * Resolve the pod DEK from its manifest using a passphrase:
 * read manifest -> deriveKek -> unwrapDek.
 *
 * @throws {Error} if the pod is not encrypted.
 * @throws {PodDecryptError} on an incorrect passphrase / corrupt key.
 */
export function resolveDek(podDir: string, passphrase: string): Buffer {
  const manifest = readEncryptionManifest(podDir);
  if (!manifest) {
    throw new Error(`Pod is not encrypted (no ${MANIFEST_RELATIVE_PATH}): ${podDir}`);
  }
  const wrap = manifest.wraps.find((w) => w.by === 'passphrase');
  if (!wrap) {
    throw new Error('No passphrase wrap found in encryption manifest.');
  }
  const salt = Buffer.from(manifest.kdfParams.salt, 'base64');
  const kek = deriveKek(passphrase, salt, manifest.kdfParams);
  return unwrapDek(wrap.wrappedDek, kek);
}

// ─── Transparent resource read/write ──────────────────────────────────────────

/**
 * Read a resource. If a DEK is supplied, the on-disk bytes are decrypted from
 * the combined layout; otherwise the file is read as plaintext UTF-8.
 *
 * @throws {PodDecryptError} on auth failure when a DEK is supplied.
 */
export function readResource(absPath: string, dek?: Buffer): string {
  if (dek) {
    const blob = fs.readFileSync(absPath);
    return decryptResource(blob, dek);
  }
  return fs.readFileSync(absPath, 'utf-8');
}

/**
 * Write a resource. If a DEK is supplied, the content is encrypted to the
 * combined layout; otherwise it is written as plaintext UTF-8.
 */
export function writeResource(absPath: string, content: string, dek?: Buffer): void {
  if (dek) {
    fs.writeFileSync(absPath, encryptResource(content, dek));
  } else {
    fs.writeFileSync(absPath, content, 'utf-8');
  }
}
