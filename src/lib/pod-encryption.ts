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
import {
  atomicWriteFile,
  mkdirInPod,
  readPodDir,
  readPodFile,
  removePodFile,
  resolveInPod,
  writePodFile,
  PodPathError,
  type AtomicWriteOptions,
} from './pod-path.js';

// ─── Layout constants ─────────────────────────────────────────────────────────

/** GCM nonce length in bytes (CryptoKit uses 12). */
export const NONCE_LEN = 12;
/** GCM authentication tag length in bytes. */
export const TAG_LEN = 16;
/** DEK / KEK length in bytes (256-bit). */
export const KEY_LEN = 32;
/**
 * The smallest possible combined blob: an empty plaintext still costs a nonce
 * and a tag. Anything shorter CANNOT be ciphertext, which is one half of the
 * "is this file already in the target state?" test used by `pod decrypt`.
 * Must match `MIN_ENVELOPE_LEN` in the Workbench's `pod_io.rs`.
 */
export const MIN_ENVELOPE_LEN = NONCE_LEN + TAG_LEN;

// ─── Manifest types ───────────────────────────────────────────────────────────
//
// `settings/encryption.json` exists in two versions.
//
//   1.0  one top-level `kdf` + `kdfParams`, shared by every wrap:
//        { version, algorithm, kdf, kdfParams, wraps: [{ by, wrappedDek }] }
//
//   1.1  KDF parameters live INSIDE each passphrase wrap, because one salt
//        cannot serve two secrets. There is no top-level `kdf`/`kdfParams`:
//        { version, algorithm, wraps: [{ by, label, createdAt, kdf, kdfParams, wrappedDek }] }
//
// Both are read, and both are normalized into ONE shape
// ({@link NormalizedEncryptionManifest}) so no consumer has to know which
// version a pod carries. Only this module reads `kdfParams`; a source test
// enforces that.
//
// Which verbs write which version: every writer writes 1.1. `pod init
// --encrypt` and `pod encrypt` write one passphrase wrap
// ({@link buildPassphraseManifest}); `pod passphrase set` re-wraps
// ({@link rewrapPassphrase}), migrating a 1.0 manifest in memory first; and
// `pod passphrase set --rotate-dek` writes one wrap of a new data key. No
// command writes 1.0 any more; it is still read.

export interface KdfParams {
  /** Base64 Argon2id salt. In 1.1 it is also the wrap's public identifier. */
  salt: string;
  /** Argon2id time cost (iterations). */
  t: number;
  /** Argon2id memory cost in KiB. */
  m: number;
  /** Argon2id parallelism. */
  p: number;
}

/**
 * A single wrap of the pod DEK, as a 1.0 manifest stores it. Multiple wraps of
 * the SAME DEK may coexist so the pod can be unlocked by different key holders.
 *
 * Only `passphrase` is implemented. `device-keychain` is reserved: readers skip
 * a wrap they do not implement.
 */
export interface EncryptionWrap {
  /**
   * The key-holder kind that can unwrap the DEK.
   *
   *  - `passphrase`      DEK wrapped by an Argon2id passphrase KEK (implemented).
   *  - `device-keychain` RESERVED. Not implemented; the slot exists so a future
   *                      writer can add it without a schema bump.
   */
  by: 'passphrase' | 'device-keychain';
  /** Base64 combined (nonce||ct||tag) of the wrapped DEK. */
  wrappedDek: string;
}

/** A version 1.0 manifest, exactly as it sits on disk. */
export interface EncryptionManifestV10 {
  version: '1.0';
  algorithm: 'aes-256-gcm';
  kdf: 'argon2id';
  kdfParams: KdfParams;
  wraps: EncryptionWrap[];
}


/**
 * One wrap of a version 1.1 manifest, as it sits on disk.
 *
 * A `passphrase` wrap carries `kdf`, `kdfParams` and `wrappedDek`. A wrap of a
 * kind this tool does not implement is carried through verbatim, including any
 * keys this tool does not know, which is what the index signature is for.
 */
export interface EncryptionWrapV11 {
  by: string;
  /** Neutral words only (`"primary"`): the manifest is plaintext. */
  label: string | null;
  /** ISO 8601 UTC with milliseconds, or `null` for a wrap migrated from 1.0. */
  createdAt: string | null;
  kdf?: 'argon2id';
  kdfParams?: KdfParams;
  wrappedDek?: string;
  [key: string]: unknown;
}

/** A version 1.1 manifest, exactly as it sits on disk. */
export interface EncryptionManifestV11 {
  version: '1.1';
  algorithm: 'aes-256-gcm';
  wraps: EncryptionWrapV11[];
}

/** The manifest `pod init --encrypt` and `pod encrypt` write: version 1.1. */
export type EncryptionManifest = EncryptionManifestV11;

/** A wrap this tool can open: DEK wrapped by an Argon2id passphrase KEK. */
export interface NormalizedPassphraseWrap {
  kind: 'passphrase';
  by: 'passphrase';
  label: string | null;
  createdAt: string | null;
  kdf: 'argon2id';
  /** This wrap's OWN KDF parameters (a 1.0 manifest's top-level ones, copied). */
  kdfParams: KdfParams;
  wrappedDek: string;
}

/** A wrap of a kind this tool does not implement. It is skipped on open. */
export interface NormalizedUnimplementedWrap {
  kind: 'unimplemented';
  by: string;
  label: string | null;
  createdAt: string | null;
}

export type NormalizedWrap = NormalizedPassphraseWrap | NormalizedUnimplementedWrap;

/**
 * The ONE shape every consumer reads, whichever version is on disk: a list of
 * wraps in manifest order, each passphrase wrap carrying its own KDF params.
 */
export interface NormalizedEncryptionManifest {
  /** The version on disk. */
  version: '1.0' | '1.1';
  algorithm: 'aes-256-gcm';
  wraps: NormalizedWrap[];
}

/** Default Argon2id parameters (t=3, m=64 MiB, p=1). Recorded in the manifest. */
export const DEFAULT_KDF = { t: 3, m: 65536, p: 1 } as const;

/** Salt length in bytes for every new wrap. */
export const SALT_LEN = 16;

export const MANIFEST_RELATIVE_PATH = path.join('settings', 'encryption.json');

/** The manifest versions this tool reads. Anything else was written by a newer tool. */
export const READABLE_MANIFEST_VERSIONS = ['1.0', '1.1'] as const;

/**
 * Reader limits for `settings/encryption.json`, checked when the manifest is
 * PARSED, before any key derivation runs.
 *
 * The manifest is plaintext and anyone who can write to the pod directory can
 * edit it, so its KDF parameters are attacker-chosen input. Without a bound, one
 * edited number makes every open allocate gigabytes or spin for hours before
 * the passphrase is even checked. Every writer emits t=3, m=65536, p=1, a
 * 16-byte salt and a 60-byte wrap; the bounds leave headroom above that and
 * nothing more. Every reader of this manifest must enforce the same numbers.
 *
 * `m` is in KiB and must also be at least `8 * p` (the Argon2 minimum).
 */
export const MANIFEST_LIMITS = {
  /** Argon2id memory cost ceiling, KiB (128 MiB). */
  mMax: 131072,
  tMin: 1,
  tMax: 6,
  pMin: 1,
  pMax: 4,
  /** Exact decoded salt length, bytes. */
  saltBytes: 16,
  /** Exact decoded wrapped-DEK length, bytes: nonce(12) + key(32) + tag(16). */
  wrappedDekBytes: NONCE_LEN + KEY_LEN + TAG_LEN,
  /** Most passphrase wraps one manifest may hold (bounds try-each-wrap). */
  maxPassphraseWraps: 6,
  /** Most wraps of any kind one manifest may hold. */
  maxWraps: 16,
  /** Largest manifest file, bytes. Checked before the file is read or parsed. */
  maxHeaderBytes: 65536,
} as const;

/** The refusal sentence for a manifest outside {@link MANIFEST_LIMITS}. */
export const OUTSIDE_LIMITS_MESSAGE =
  "The pod's encryption header asks for settings outside this tool's limits.";

/** Clean, user-facing error for any GCM authentication failure. */
export class PodDecryptError extends Error {
  constructor(message = 'incorrect passphrase or corrupt key') {
    super(message);
    this.name = 'PodDecryptError';
  }
}

/**
 * Which way a manifest could not be used.
 *
 *  - `malformed`           not valid JSON, breaks a strictness rule, or asks for
 *                          settings outside {@link MANIFEST_LIMITS}.
 *  - `version-unsupported` a manifest version this tool does not read.
 *  - `no-usable-wrap`      parses, and holds no wrap of a kind this tool
 *                          implements, so there is nothing a passphrase can open.
 */
export type EncryptionManifestErrorKind = 'malformed' | 'version-unsupported' | 'no-usable-wrap';

/**
 * `settings/encryption.json` is malformed, or is a version this tool does not
 * read. Never a statement about the passphrase: nothing was tried.
 */
export class EncryptionManifestError extends Error {
  readonly kind: EncryptionManifestErrorKind;

  constructor(message: string, kind: EncryptionManifestErrorKind = 'malformed') {
    super(message);
    this.name = 'EncryptionManifestError';
    this.kind = kind;
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
  // `update` returns the plaintext before the tag is checked. It is copied
  // into the result and then zeroed, so an unwrapped key, or bytes that fail
  // authentication, leave no second copy behind.
  const head = decipher.update(ciphertext);
  try {
    return Buffer.concat([head, decipher.final()]);
  } catch {
    // GCM auth failure (wrong key or tampered data).
    throw new PodDecryptError();
  } finally {
    head.fill(0);
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
 * Encrypt arbitrary BYTES with the DEK, returning the combined blob.
 *
 * The text-flavoured {@link encryptResource} is the right call for `.ttl`
 * resources. This one exists because a pod also holds bytes that are not text
 * (retained source PDFs under `sources/`, for one), and round-tripping those
 * through a UTF-8 string silently replaces every invalid sequence with U+FFFD.
 */
export function encryptBytes(plaintext: Buffer, dek: Buffer): Buffer {
  return sealCombined(plaintext, dek);
}

/**
 * Decrypt a combined resource blob with the DEK back to BYTES.
 * @throws {PodDecryptError} on auth failure.
 */
export function decryptBytes(blob: Buffer, dek: Buffer): Buffer {
  return openCombined(blob, dek);
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
  // The passphrase string itself cannot be zeroed (JavaScript strings are
  // immutable), but its encoded bytes can, so they are. The KEK is returned
  // as a view of the derivation's output, not a copy, so the caller's
  // `fill(0)` zeroes the only copy.
  const secret = new TextEncoder().encode(passphrase);
  try {
    const out = argon2id(secret, new Uint8Array(salt), {
      t: params.t,
      m: params.m,
      p: params.p,
      dkLen: KEY_LEN,
    });
    return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  } finally {
    secret.fill(0);
  }
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

// ─── Manifest parsing (1.0 and 1.1) ───────────────────────────────────────────

function manifestPath(podDir: string): string {
  return path.join(podDir, MANIFEST_RELATIVE_PATH);
}

/** Both halves of a parse: the bytes as written, and the normalized reading. */
export interface ParsedEncryptionManifest {
  onDisk: EncryptionManifestV10 | EncryptionManifestV11;
  normalized: NormalizedEncryptionManifest;
}

function malformed(detail: string): EncryptionManifestError {
  return new EncryptionManifestError(`Malformed ${MANIFEST_RELATIVE_PATH.split(path.sep).join('/')}: ${detail}`);
}

/**
 * A manifest value outside {@link MANIFEST_LIMITS}. Names the field and never
 * the value: the value is attacker-chosen and can be arbitrarily long.
 */
function outsideLimits(field: string): EncryptionManifestError {
  return new EncryptionManifestError(`${OUTSIDE_LIMITS_MESSAGE.slice(0, -1)} (field: ${field}).`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Decoded length of canonical, padded, standard base64, or `null` when the
 * text is not that. `Buffer.from(s, 'base64')` skips characters it does not
 * know, so a length check alone would accept text no other reader decodes the
 * same way; the round-trip comparison rules that out.
 */
function canonicalBase64Length(s: string): number | null {
  const bytes = Buffer.from(s, 'base64');
  return bytes.toString('base64') === s ? bytes.length : null;
}

/** Where a header's `kdfParams` sits, and how each number in it was written. */
interface KdfLexemes {
  /** Every number in the header, keyed by {@link lexemeKey} of its path. */
  numbers: Map<string, string>;
  /** Path of this `kdfParams` object: `["kdfParams"]` or `["wraps", i, "kdfParams"]`. */
  at: Array<string | number>;
}

function checkKdf(kdf: unknown, kdfParams: unknown, where: string, lexemes?: KdfLexemes): KdfParams {
  if (kdf !== 'argon2id') throw outsideLimits(`${where}.kdf`);
  if (!isPlainObject(kdfParams)) throw malformed(`${where} kdfParams is missing`);
  const { salt, t, m, p } = kdfParams;
  if (typeof salt !== 'string') throw malformed(`${where} kdfParams.salt is not base64`);
  if (canonicalBase64Length(salt) !== MANIFEST_LIMITS.saltBytes) {
    throw outsideLimits(`${where}.kdfParams.salt`);
  }
  if (lexemes) {
    for (const [name, value] of [['t', t], ['m', m], ['p', p]] as const) {
      if (typeof value !== 'number') continue; // refused as not an integer below
      const written = lexemes.numbers.get(lexemeKey([...lexemes.at, name]));
      if (written === undefined || !PLAIN_DIGITS.test(written)) {
        throw malformed(`${where} kdfParams.${name} must be written as plain decimal digits`);
      }
    }
  }
  checkCosts(t, m, p, `${where}.kdfParams`);
  return { salt, t: t as number, m: m as number, p: p as number };
}

/**
 * The only way a header may write `t`, `m` and `p`: decimal digits, no sign,
 * fraction, exponent or leading zero (specification 4.5). `JSON.parse` reads
 * `3.0`, `3e0` and `30e-1` all as the integer 3, so the rule has to be checked
 * against the text.
 */
const PLAIN_DIGITS = /^(0|[1-9][0-9]*)$/;

/** An unambiguous key for a JSON path: member names may contain any character. */
function lexemeKey(p: Array<string | number>): string {
  return JSON.stringify(p);
}

/**
 * Walk a header's TEXT once, for the two rules a parsed value cannot show:
 *
 *  - Duplicate member names. A header in which any JSON object contains the
 *    same member name twice is malformed; readers refuse it before deriving
 *    any key (specification 4.1). `JSON.parse` keeps the last occurrence and
 *    another reader's parser may keep the first, so the same bytes would open
 *    differently. Names are compared after their escapes are decoded:
 *    `"label"` and `"lab\u0065l"` are the same name. The refusal does not echo
 *    the name, which is attacker-chosen.
 *  - How numbers are written. Returns every number token as WRITTEN, keyed by
 *    {@link lexemeKey} of its path, for the check in {@link checkKdf}.
 *
 * Called only on text `JSON.parse` has already accepted, so it can assume
 * valid JSON. Iterative, so nesting depth cannot exhaust the stack.
 *
 * @throws {EncryptionManifestError} (malformed) on a duplicate member name.
 */
function scanHeaderText(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const frames: Array<{ kind: 'object' | 'array'; key: string | number | null; names?: Set<string> }> = [];
  const scalar = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/y;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ':') {
      i += 1;
    } else if (c === '{') {
      frames.push({ kind: 'object', key: null, names: new Set() });
      i += 1;
    } else if (c === '[') {
      frames.push({ kind: 'array', key: 0 });
      i += 1;
    } else if (c === '}' || c === ']') {
      frames.pop();
      i += 1;
    } else if (c === ',') {
      const top = frames[frames.length - 1];
      top.key = top.kind === 'array' ? (top.key as number) + 1 : null;
      i += 1;
    } else if (c === '"') {
      const start = i;
      i += 1;
      while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i += 1;
      const top = frames[frames.length - 1];
      if (top !== undefined && top.kind === 'object' && top.key === null) {
        const name = JSON.parse(text.slice(start, i)) as string;
        if (top.names!.has(name)) throw malformed('an object has the same member name twice');
        top.names!.add(name);
        top.key = name;
      }
    } else {
      scalar.lastIndex = i;
      const m = scalar.exec(text);
      if (m === null) break; // unreachable for text JSON.parse accepted
      if (m[0] !== 'true' && m[0] !== 'false' && m[0] !== 'null') {
        out.set(lexemeKey(frames.map((f) => f.key as string | number)), m[0]);
      }
      i += m[0].length;
    }
  }
  return out;
}

/** Argon2id cost parameters inside {@link MANIFEST_LIMITS}, or a refusal naming the field. */
function checkCosts(t: unknown, m: unknown, p: unknown, where: string): void {
  if (!isPositiveInt(t) || !isPositiveInt(m) || !isPositiveInt(p)) {
    throw malformed(`${where} t, m and p must be positive integers`);
  }
  if (t < MANIFEST_LIMITS.tMin || t > MANIFEST_LIMITS.tMax) throw outsideLimits(`${where}.t`);
  if (p < MANIFEST_LIMITS.pMin || p > MANIFEST_LIMITS.pMax) throw outsideLimits(`${where}.p`);
  if (m < 8 * p || m > MANIFEST_LIMITS.mMax) throw outsideLimits(`${where}.m`);
}

/** The refusal for a header path that holds anything but a regular file. */
function notRegularFile(): EncryptionManifestError {
  return malformed('not a regular file');
}

/**
 * Open flags for the header: read-only, never blocking on open (a FIFO with no
 * writer would otherwise hang the reader at `open`), and never following a
 * symbolic link in the last component. Flags a platform lacks are simply left
 * out; the `fstat` check below still refuses what they would have.
 */
const HEADER_OPEN_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);

/**
 * Is anything at all at the header path, judged without following a link?
 *
 * A symbolic link at the header path, dangling or not, counts as present, and
 * so does a `settings` folder that is itself a link, whatever it points at: a
 * reader cannot look inside it without following it. Both are then refused as
 * a header, so such a pod reads as locked and never as a plaintext pod a
 * writer would store plaintext into (the pod encryption specification, 4.1).
 */
function manifestPresent(podDir: string): boolean {
  const settings = path.join(podDir, path.dirname(MANIFEST_RELATIVE_PATH));
  try {
    if (fs.lstatSync(settings).isSymbolicLink()) return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw e;
  }
  try {
    fs.lstatSync(manifestPath(podDir));
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // ENOTDIR: `settings` is a file, so nothing can be at the header path.
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw e;
  }
}

/** Header bytes decode as UTF-8 or not at all: no replacement characters. */
const HEADER_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Read the header's text from a file path. The header must be a REGULAR file
 * reached without a symbolic link in its last component, and at most
 * {@link MANIFEST_LIMITS.maxHeaderBytes} bytes are ever read from it. The path
 * above the last component is the caller's to have checked: a pod's header
 * comes through {@link readPodManifestText}.
 *
 * The kind is judged with `fstat` on the handle that is then read, not with a
 * `stat` of the path, because a path's size says nothing useful about a device
 * (size 0, endless bytes) or a FIFO (size 0, blocks until a writer appears).
 * The read is bounded whatever the handle reports, so even a file that grows
 * while it is read cannot make this allocate more than the limit plus one byte.
 *
 * The bytes must be valid UTF-8 with no byte order mark: a decoder that
 * repaired them would hand the parser a header no other reader sees.
 */
function readManifestText(file: string): string {
  // The containing directory must not be a link either: a link there would
  // lead the read out of the pod as surely as a link at the header itself.
  if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) throw notRegularFile();
  let fd: number;
  try {
    fd = fs.openSync(file, HEADER_OPEN_FLAGS);
  } catch (e) {
    // ELOOP (EMLINK on some BSDs): the last component is a symbolic link.
    // EISDIR: platforms that refuse to open a directory for reading.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK' || code === 'EISDIR') throw notRegularFile();
    throw e;
  }
  let buf: Buffer;
  let filled = 0;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw notRegularFile();
    if (st.size > MANIFEST_LIMITS.maxHeaderBytes) throw outsideLimits('header size');
    buf = Buffer.alloc(MANIFEST_LIMITS.maxHeaderBytes + 1);
    while (filled < buf.length) {
      const n = fs.readSync(fd, buf, filled, buf.length - filled, null);
      if (n === 0) break;
      filled += n;
    }
    if (filled > MANIFEST_LIMITS.maxHeaderBytes) throw outsideLimits('header size');
  } finally {
    fs.closeSync(fd);
  }
  const bytes = buf.subarray(0, filled);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw malformed('begins with a byte order mark');
  }
  try {
    return HEADER_UTF8.decode(bytes);
  } catch {
    throw malformed('not valid UTF-8');
  }
}

/**
 * Read a pod's header text. The path goes through the pod path chokepoint
 * first, so a `settings` folder or a header that is a symbolic link is refused
 * as a malformed header without anything being read through it.
 */
function readPodManifestText(podDir: string): string {
  let file: string;
  try {
    file = resolveInPod(podDir, MANIFEST_RELATIVE_PATH);
  } catch (e) {
    if (e instanceof PodPathError) throw notRegularFile();
    throw e;
  }
  return readManifestText(file);
}

function checkWrappedDek(wrappedDek: unknown, where: string): string {
  if (typeof wrappedDek !== 'string') throw malformed(`${where} has no wrappedDek`);
  if (canonicalBase64Length(wrappedDek) !== MANIFEST_LIMITS.wrappedDekBytes) {
    throw outsideLimits(`${where}.wrappedDek`);
  }
  return wrappedDek;
}

function checkNullableString(v: unknown, what: string): string | null {
  if (v === null || typeof v === 'string') return v;
  throw malformed(`${what} must be a string or null`);
}

/**
 * Parse the TEXT of `settings/encryption.json`, version 1.0 or 1.1, into the
 * on-disk shape and the normalized shape.
 *
 * Strict on purpose. A key file is not a place to guess:
 *  - any version other than 1.0 and 1.1 is refused as written by a newer tool;
 *  - a 1.1 manifest with a top-level `kdf` or `kdfParams` is refused;
 *  - an empty (or missing) `wraps` is refused;
 *  - an object with the same member name twice is refused.
 *
 * @throws {EncryptionManifestError} on any of the above, or invalid JSON.
 */
export function parseEncryptionManifest(text: string): ParsedEncryptionManifest {
  if (Buffer.byteLength(text, 'utf-8') > MANIFEST_LIMITS.maxHeaderBytes) {
    throw outsideLimits('header size');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw malformed('not valid JSON');
  }
  if (!isPlainObject(raw)) throw malformed('not a JSON object');
  const numbers = scanHeaderText(text);

  const version = raw.version;
  if (typeof version !== 'string') throw malformed('no version');
  if (!(READABLE_MANIFEST_VERSIONS as readonly string[]).includes(version)) {
    throw new EncryptionManifestError(
      `Unsupported encryption manifest version "${version}": this pod was written by a newer tool`,
      'version-unsupported',
    );
  }
  if (raw.algorithm !== 'aes-256-gcm') throw malformed('algorithm must be "aes-256-gcm"');
  if (!Array.isArray(raw.wraps) || raw.wraps.length === 0) {
    throw malformed('wraps must be a non-empty list');
  }
  if (raw.wraps.length > MANIFEST_LIMITS.maxWraps) throw outsideLimits('wraps');
  const rawWraps: unknown[] = raw.wraps;
  // Every wrap needs a non-empty string `by`: an empty one is malformed, not a
  // kind to skip. A non-empty kind this tool does not implement is skipped.
  for (const [i, w] of rawWraps.entries()) {
    if (!isPlainObject(w) || typeof w.by !== 'string' || w.by.length === 0) {
      throw malformed(`wrap ${i} has no "by"`);
    }
  }
  const objWraps = rawWraps as Array<Record<string, unknown> & { by: string }>;
  if (objWraps.filter((w) => w.by === 'passphrase').length > MANIFEST_LIMITS.maxPassphraseWraps) {
    throw outsideLimits('wraps (passphrase)');
  }

  if (version === '1.0') {
    const kdfParams = checkKdf(raw.kdf, raw.kdfParams, 'top-level', { numbers, at: ['kdfParams'] });
    // A 1.0 wrap has no label on disk. The first passphrase wrap reads as
    // "primary" and every other wrap as null: exactly the labels
    // {@link migrateManifest} writes, so a 1.0 header reads the same before
    // and after it is migrated.
    const firstPassphrase = objWraps.findIndex((w) => w.by === 'passphrase');
    const wraps: NormalizedWrap[] = objWraps.map((w, i) => {
      if (w.by !== 'passphrase') {
        return { kind: 'unimplemented', by: w.by, label: null, createdAt: null };
      }
      const wrappedDek = checkWrappedDek(w.wrappedDek, `wraps[${i}]`);
      return {
        kind: 'passphrase',
        by: 'passphrase',
        label: i === firstPassphrase ? 'primary' : null,
        createdAt: null,
        kdf: 'argon2id',
        kdfParams: { ...kdfParams },
        wrappedDek,
      };
    });
    return {
      onDisk: raw as unknown as EncryptionManifestV10,
      normalized: { version: '1.0', algorithm: 'aes-256-gcm', wraps },
    };
  }

  // 1.1
  if ('kdf' in raw || 'kdfParams' in raw) {
    throw malformed('a version 1.1 manifest must not carry a top-level kdf or kdfParams');
  }
  const wraps: NormalizedWrap[] = objWraps.map((w, i) => {
    const label = checkNullableString(w.label, `wrap ${i} label`);
    const createdAt = checkNullableString(w.createdAt, `wrap ${i} createdAt`);
    if (w.by !== 'passphrase') {
      return { kind: 'unimplemented', by: w.by, label, createdAt };
    }
    const kdfParams = checkKdf(w.kdf, w.kdfParams, `wraps[${i}]`, { numbers, at: ['wraps', i, 'kdfParams'] });
    const wrappedDek = checkWrappedDek(w.wrappedDek, `wraps[${i}]`);
    return {
      kind: 'passphrase',
      by: 'passphrase',
      label,
      createdAt,
      kdf: 'argon2id',
      kdfParams,
      wrappedDek,
    };
  });
  return {
    onDisk: raw as unknown as EncryptionManifestV11,
    normalized: { version: '1.1', algorithm: 'aes-256-gcm', wraps },
  };
}

/**
 * Read `settings/encryption.json` (1.0 or 1.1) in its normalized shape, or
 * `null` if the pod is not encrypted.
 *
 * @throws {EncryptionManifestError} when the manifest is malformed or newer.
 */
export function readEncryptionManifest(podDir: string): NormalizedEncryptionManifest | null {
  if (!manifestPresent(podDir)) return null;
  return parseEncryptionManifest(readPodManifestText(podDir)).normalized;
}

/**
 * Write `settings/encryption.json` atomically: a crash mid-write leaves either
 * no manifest or a whole one, never a truncated one over a pod that is still
 * plaintext. A 1.1 manifest goes through {@link serializeEncryptionManifestV11},
 * so it is refused rather than written when a reader would refuse it.
 * `mode` sets the file's permission bits (default: the process default).
 */
export function writeEncryptionManifest(
  podDir: string,
  manifest: EncryptionManifestV10 | EncryptionManifestV11,
  options: { mode?: number } = {},
): void {
  const text =
    manifest.version === '1.1'
      ? serializeEncryptionManifestV11(manifest)
      : JSON.stringify(manifest, null, 2) + '\n';
  mkdirInPod(podDir, path.dirname(MANIFEST_RELATIVE_PATH));
  writeManifestFile(podDir, Buffer.from(text, 'utf-8'), options.mode === undefined ? {} : { mode: options.mode });
}

/**
 * A pod is encrypted iff anything is at its manifest path, judged without
 * following a link. A symbolic link or other non-regular file there still
 * counts, and so does a `settings` folder that is a link; each is then refused
 * when read, so the pod reads as locked rather than as plaintext.
 */
export function isPodEncrypted(podDir: string): boolean {
  return manifestPresent(podDir);
}

// ─── Manifest construction & DEK resolution ───────────────────────────────────

/**
 * Build the encryption manifest for a NEW pod key protected by a passphrase:
 * version 1.1 with one passphrase wrap, `label: "primary"`, `createdAt` now,
 * a fresh random salt. What `pod init --encrypt` and `pod encrypt` write.
 *
 * @throws {EncryptionManifestError} if `params` is outside
 *   {@link MANIFEST_LIMITS}: it never writes a manifest a reader would refuse.
 */
export function buildPassphraseManifest(
  dek: Buffer,
  passphrase: string,
  params: { t: number; m: number; p: number } = DEFAULT_KDF,
  options: { now?: () => Date } = {},
): EncryptionManifest {
  return buildPassphraseManifestV11(dek, passphrase, {
    kdf: params,
    label: 'primary',
    ...(options.now ? { now: options.now } : {}),
  });
}

/**
 * Build a version 1.0 manifest: one top-level salt and KDF parameters, one
 * passphrase wrap. No command writes 1.0 any more. It is kept so the 1.0
 * reader, and the 1.0 to 1.1 migration, are tested against exactly the bytes
 * earlier versions of this tool wrote.
 *
 * @throws {EncryptionManifestError} if `params` is outside {@link MANIFEST_LIMITS}.
 */
export function buildPassphraseManifestV10(
  dek: Buffer,
  passphrase: string,
  params: { t: number; m: number; p: number } = DEFAULT_KDF,
): EncryptionManifestV10 {
  // Never write a manifest a reader would refuse.
  checkCosts(params.t, params.m, params.p, 'kdfParams');
  const salt = randomBytes(SALT_LEN);
  const kek = deriveKek(passphrase, salt, params);
  let wrappedDek: string;
  try {
    wrappedDek = wrapDek(dek, kek);
  } finally {
    kek.fill(0);
  }
  return {
    version: '1.0',
    algorithm: 'aes-256-gcm',
    kdf: 'argon2id',
    kdfParams: { salt: salt.toString('base64'), t: params.t, m: params.m, p: params.p },
    wraps: [{ by: 'passphrase', wrappedDek }],
  };
}

/** Options for {@link buildPassphraseManifestV11}. */
export interface BuildManifestV11Options {
  /** KDF parameters for the wrap. Defaults to {@link DEFAULT_KDF}. */
  kdf?: { t: number; m: number; p: number };
  /** The wrap's label. Defaults to `"primary"`. */
  label?: string;
  /** Clock for the wrap's `createdAt`. */
  now?: () => Date;
}

/**
 * Build a version 1.1 manifest holding exactly ONE passphrase wrap of `dek`:
 * fresh 16-byte salt, `createdAt` now, `label` as given or `"primary"`.
 *
 * @throws {EncryptionManifestError} if the KDF parameters are outside
 *   {@link MANIFEST_LIMITS}: it never builds a manifest a reader would refuse.
 */
export function buildPassphraseManifestV11(
  dek: Buffer,
  passphrase: string,
  options: BuildManifestV11Options = {},
): EncryptionManifestV11 {
  const params = options.kdf ?? DEFAULT_KDF;
  checkCosts(params.t, params.m, params.p, 'kdfParams');
  const salt = randomBytes(SALT_LEN);
  const kek = deriveKek(passphrase, salt, params);
  let wrappedDek: string;
  try {
    wrappedDek = wrapDek(dek, kek);
  } finally {
    kek.fill(0);
  }
  return {
    version: '1.1',
    algorithm: 'aes-256-gcm',
    wraps: [
      {
        by: 'passphrase',
        label: options.label ?? 'primary',
        createdAt: (options.now ?? (() => new Date()))().toISOString(),
        kdf: 'argon2id',
        kdfParams: { salt: salt.toString('base64'), t: params.t, m: params.m, p: params.p },
        wrappedDek,
      },
    ],
  };
}

/** The DEK, and the index (in manifest order) of the wrap that yielded it. */
export interface UnlockedManifest {
  dek: Buffer;
  wrapIndex: number;
}

/**
 * Open a normalized manifest with a passphrase: try each passphrase wrap in
 * manifest order, each with its OWN KDF parameters; the first whose GCM tag
 * verifies yields the DEK. Every wrap resolves the same DEK.
 *
 * @throws {EncryptionManifestError} when the manifest holds no wrap this tool implements.
 * @throws {PodDecryptError} when no passphrase wrap opens with this passphrase.
 */
export function unlockManifest(
  manifest: NormalizedEncryptionManifest,
  passphrase: string,
): UnlockedManifest {
  assertHasUsableWrap(manifest);
  for (const [wrapIndex, wrap] of manifest.wraps.entries()) {
    if (wrap.kind !== 'passphrase') continue;
    const kek = deriveKek(passphrase, Buffer.from(wrap.kdfParams.salt, 'base64'), wrap.kdfParams);
    try {
      return { dek: unwrapDek(wrap.wrappedDek, kek), wrapIndex };
    } catch (e) {
      if (!(e instanceof PodDecryptError)) throw e;
    } finally {
      kek.fill(0);
    }
  }
  throw new PodDecryptError();
}

/**
 * Refuse a manifest that holds no wrap a passphrase could open, so a caller can
 * say so BEFORE asking for a passphrase it would never use.
 *
 * @throws {EncryptionManifestError} with kind `no-usable-wrap`.
 */
export function assertHasUsableWrap(manifest: NormalizedEncryptionManifest): void {
  if (!manifest.wraps.some((w) => w.kind === 'passphrase')) {
    throw new EncryptionManifestError(
      'Cannot open this pod: its encryption manifest holds no wrap this tool implements',
      'no-usable-wrap',
    );
  }
}

/**
 * Resolve the pod DEK from its manifest (1.0 or 1.1) using a passphrase.
 *
 * @throws {Error} if the pod is not encrypted.
 * @throws {EncryptionManifestError} if the manifest is malformed or newer.
 * @throws {PodDecryptError} on an incorrect passphrase / corrupt key.
 */
export function resolveDek(podDir: string, passphrase: string): Buffer {
  const manifest = readEncryptionManifest(podDir);
  if (!manifest) {
    throw new Error(`Pod is not encrypted (no ${MANIFEST_RELATIVE_PATH}): ${podDir}`);
  }
  return unlockManifest(manifest, passphrase).dek;
}

// ─── Manifest 1.1: migration and serialization ────────────────────────────────

/**
 * Migrate a 1.0 manifest to 1.1, in memory. Pure: the input is not modified
 * and nothing is written.
 *
 * The top-level `kdf` and `kdfParams` move into the passphrase wrap, whose
 * `label` becomes `"primary"` and `createdAt` becomes `null` (its age is
 * unknown). Any other wrap is carried over with `label: null, createdAt: null`.
 *
 * @throws {EncryptionManifestError} if the 1.0 manifest has more than one
 *   passphrase wrap: they share one salt, which 1.1 does not allow.
 */
export function migrateManifest(v10: EncryptionManifestV10): EncryptionManifestV11 {
  const passphraseWraps = v10.wraps.filter((w) => w.by === 'passphrase').length;
  if (passphraseWraps > 1) {
    throw new EncryptionManifestError(
      `Cannot migrate a 1.0 manifest with ${passphraseWraps} passphrase wraps: they share one salt`,
    );
  }
  const wraps: EncryptionWrapV11[] = v10.wraps.map((w) => {
    const { by, ...rest } = w as unknown as Record<string, unknown> & { by: string };
    if (by === 'passphrase') {
      const { wrappedDek, ...extra } = rest;
      return {
        by,
        label: 'primary',
        createdAt: null,
        kdf: v10.kdf,
        kdfParams: { ...v10.kdfParams },
        wrappedDek: wrappedDek as string,
        ...extra,
      };
    }
    return { by, label: null, createdAt: null, ...rest };
  });
  return { version: '1.1', algorithm: v10.algorithm, wraps };
}

/**
 * Serialize a 1.1 manifest to the exact bytes written to disk: two-space
 * indent, trailing newline, and keys in the fixed order
 * `version, algorithm, wraps` and, per passphrase wrap,
 * `by, label, createdAt, kdf, kdfParams{salt, t, m, p}, wrappedDek`.
 * A wrap's keys this tool does not know follow its known ones, in their
 * original order, so a wrap it does not implement is carried through intact.
 *
 * Refuses (throws) rather than write a manifest a reader would refuse: no
 * top-level `kdf`/`kdfParams`, a non-empty `wraps`, every passphrase wrap
 * complete, and no two passphrase wraps sharing a salt.
 *
 * @throws {EncryptionManifestError}
 */
export function serializeEncryptionManifestV11(manifest: EncryptionManifestV11): string {
  const top = manifest as unknown as Record<string, unknown>;
  if (manifest.version !== '1.1') throw malformed('serializer only writes version 1.1');
  if ('kdf' in top || 'kdfParams' in top) {
    throw malformed('a version 1.1 manifest must not carry a top-level kdf or kdfParams');
  }
  if (!Array.isArray(manifest.wraps) || manifest.wraps.length === 0) {
    throw malformed('wraps must be a non-empty list');
  }
  const seenSalts = new Set<string>();
  const wraps = manifest.wraps.map((w, i) => {
    const { by, label, createdAt, kdf, kdfParams, wrappedDek, ...extra } = w;
    if (by !== 'passphrase') {
      // A kind this tool does not implement: carried through, known keys first.
      return {
        by,
        label,
        createdAt,
        ...(kdf === undefined ? {} : { kdf }),
        ...(kdfParams === undefined ? {} : { kdfParams }),
        ...(wrappedDek === undefined ? {} : { wrappedDek }),
        ...extra,
      };
    }
    const params = checkKdf(kdf, kdfParams, `wraps[${i}]`);
    checkWrappedDek(wrappedDek, `wraps[${i}]`);
    if (seenSalts.has(params.salt)) throw malformed(`wrap ${i} reuses another wrap's salt`);
    seenSalts.add(params.salt);
    return {
      by,
      label: checkNullableString(label, `wrap ${i} label`),
      createdAt: checkNullableString(createdAt, `wrap ${i} createdAt`),
      kdf,
      kdfParams: { salt: params.salt, t: params.t, m: params.m, p: params.p },
      wrappedDek,
      ...extra,
    };
  });
  return JSON.stringify({ version: '1.1', algorithm: manifest.algorithm, wraps }, null, 2) + '\n';
}

// ─── Re-wrap: `pod passphrase set` ────────────────────────────────────────────

/** Options for {@link rewrapPassphrase}. */
export interface RewrapOptions {
  /** KDF parameters for the new wrap. Defaults to {@link DEFAULT_KDF}. */
  kdf?: { t: number; m: number; p: number };
  /** Clock for the new wrap's `createdAt`. */
  now?: () => Date;
  /**
   * Writes the new manifest bytes into the already-open temporary file.
   * Defaults to a plain full write. Exists so a test can stand in a writer
   * that damages the bytes and prove the read-back check refuses them.
   */
  writeTemp?: (fd: number, bytes: Buffer) => void;
}

/** What a successful re-wrap changed. No secret, no salt. */
export interface RewrapResult {
  manifestVersion: '1.1';
  wrapCount: number;
  /** `createdAt` of the new wrap. */
  createdAt: string;
  /** Index of the wrap that the current passphrase opened and that was replaced. */
  replacedWrapIndex: number;
}

// `fsyncDirectory`, `atomicWriteFile` and `AtomicWriteOptions` live with the
// path chokepoint (`pod-path.ts`) and are re-exported here for their callers.
export { fsyncDirectory, atomicWriteFile, type AtomicWriteOptions } from './pod-path.js';

/**
 * The temporary names {@link atomicWriteFile} gives the manifest. Only ever
 * matched inside the manifest's own directory.
 */
const MANIFEST_TEMP_NAME = /^\.encryption\.json\.[0-9a-f]{12}\.tmp$/;

/**
 * Is `name` (a bare file name inside `settings/`) a temporary manifest that a
 * killed write left behind? Such a file never became the manifest.
 */
export function isManifestTempName(name: string): boolean {
  return MANIFEST_TEMP_NAME.test(name);
}

/**
 * Write the manifest atomically, first removing any temporary manifest a
 * killed earlier write left behind. Such a file never became the manifest,
 * but it can hold a wrap of the key, so it is deleted rather than left beside
 * the real one.
 */
function writeManifestFile(podDir: string, bytes: Buffer, options: AtomicWriteOptions = {}): void {
  const settings = path.dirname(MANIFEST_RELATIVE_PATH);
  for (const entry of readPodDir(podDir, settings)) {
    if (MANIFEST_TEMP_NAME.test(entry.name)) removePodFile(podDir, path.join(settings, entry.name));
  }
  const target = resolveInPod(podDir, MANIFEST_RELATIVE_PATH);
  // The rename replaces whatever is at the header's name; anything there but a
  // regular file is refused instead, as a read of it would be.
  const st = fs.lstatSync(target, { throwIfNoEntry: false });
  if (st !== undefined && !st.isFile()) throw notRegularFile();
  atomicWriteFile(target, bytes, options);
}

/**
 * Re-wrap the pod DEK under a new passphrase. Writes manifest 1.1.
 *
 * The current passphrase must open a wrap: that is the check that stops this
 * from replacing a key the caller cannot prove they hold. The wrap it opened is
 * replaced by a new passphrase wrap (fresh salt, given KDF parameters,
 * `createdAt` now, `label` kept or `"primary"`); every other wrap is kept as
 * it is. A 1.0 manifest is migrated to 1.1 in memory first.
 *
 * The write is atomic and verified: a temporary file in `settings/`, fsync,
 * the bytes READ BACK and opened with the new passphrase to the same DEK, then
 * a rename over the manifest and an fsync of the directory. Any failure before
 * the rename removes the temporary file and leaves the manifest byte-identical.
 * A temporary manifest left by an earlier write that was killed is removed
 * first. No copy of the old manifest is kept, since an old manifest inside the pod
 * would keep the old passphrase working.
 *
 * The DEK never touches disk and no resource file is read or written.
 *
 * @throws {Error} if the pod is not encrypted, or a passphrase is empty, or the
 *   new passphrase equals the current one.
 * @throws {EncryptionManifestError} if the manifest is malformed or newer.
 * @throws {PodDecryptError} if the current passphrase opens no wrap.
 */
export function rewrapPassphrase(
  podDir: string,
  currentPassphrase: string,
  newPassphrase: string,
  options: RewrapOptions = {},
): RewrapResult {
  if (!manifestPresent(podDir)) {
    throw new Error(`Pod is not encrypted (no ${MANIFEST_RELATIVE_PATH}): ${podDir}`);
  }
  if (newPassphrase.length === 0) throw new Error('The new passphrase cannot be empty.');
  if (newPassphrase === currentPassphrase) {
    throw new Error('The new passphrase is the same as the current one: nothing to change.');
  }

  const parsed = parseEncryptionManifest(readPodManifestText(podDir));
  const target = manifestPath(podDir);
  const { dek, wrapIndex } = unlockManifest(parsed.normalized, currentPassphrase);
  try {
    const next: EncryptionManifestV11 =
      parsed.onDisk.version === '1.0'
        ? migrateManifest(parsed.onDisk)
        : (JSON.parse(JSON.stringify(parsed.onDisk)) as EncryptionManifestV11);

    const otherSalts = new Set(
      next.wraps.filter((_, i) => i !== wrapIndex).map((w) => w.kdfParams?.salt),
    );
    let salt = randomBytes(SALT_LEN);
    while (otherSalts.has(salt.toString('base64'))) salt = randomBytes(SALT_LEN);

    const params = options.kdf ?? DEFAULT_KDF;
    const kek = deriveKek(newPassphrase, salt, params);
    const createdAt = (options.now ?? (() => new Date()))().toISOString();
    const replaced = next.wraps[wrapIndex];
    next.wraps[wrapIndex] = {
      by: 'passphrase',
      label: replaced.label ?? 'primary',
      createdAt,
      kdf: 'argon2id',
      kdfParams: { salt: salt.toString('base64'), t: params.t, m: params.m, p: params.p },
      wrappedDek: wrapDek(dek, kek),
    };
    kek.fill(0);

    const bytes = Buffer.from(serializeEncryptionManifestV11(next), 'utf-8');
    writeManifestFile(podDir, bytes, {
      mode: fs.statSync(target).mode & 0o777,
      write: options.writeTemp,
      // Read back what is ON DISK, not what was meant to be written, and prove
      // the new passphrase opens it to the same DEK. The rename that follows is
      // the point of no return for the old passphrase.
      beforeRename: (tmp) => {
        let same: boolean;
        try {
          const onDisk = parseEncryptionManifest(readManifestText(tmp));
          const check = unlockManifest(onDisk.normalized, newPassphrase);
          same = check.dek.equals(dek);
          check.dek.fill(0);
        } catch (e) {
          throw new Error(
            `The new manifest did not open with the new passphrase when read back ` +
              `(${e instanceof Error ? e.message : String(e)}). Nothing was changed.`,
          );
        }
        if (!same) {
          throw new Error('The new manifest opened to a different key when read back. Nothing was changed.');
        }
      },
    });

    return {
      manifestVersion: '1.1',
      wrapCount: next.wraps.length,
      createdAt,
      replacedWrapIndex: wrapIndex,
    };
  } finally {
    dek.fill(0);
  }
}

// ─── Transparent resource read/write ──────────────────────────────────────────
//
// Every one of these takes the pod root and resolves the path through the pod
// path chokepoint (`pod-path.ts`): a link anywhere below the root, a path that
// leaves the pod, or anything but a regular file is refused before a byte is
// read or written.

/**
 * Read a resource. If a DEK is supplied, the on-disk bytes are decrypted from
 * the combined layout; otherwise the file is read as plaintext UTF-8.
 *
 * @param podDir the pod root.
 * @param target the resource: pod-relative, or an absolute path under the pod.
 * @throws {PodDecryptError} on auth failure when a DEK is supplied.
 * @throws {PodPathError} when the path is refused.
 */
export function readResource(podDir: string, target: string, dek?: Buffer): string {
  const blob = readPodFile(podDir, target);
  return dek ? decryptResource(blob, dek) : blob.toString('utf-8');
}

/**
 * Write a resource. If a DEK is supplied, the content is encrypted to the
 * combined layout; otherwise it is written as plaintext UTF-8.
 *
 * @throws {PodPathError} when the path is refused.
 */
export function writeResource(podDir: string, target: string, content: string, dek?: Buffer): void {
  writePodFile(podDir, target, dek ? encryptResource(content, dek) : Buffer.from(content, 'utf-8'));
}

/**
 * Read a resource as BYTES. With a DEK the on-disk blob is opened from the
 * combined layout; without one the raw file bytes are returned.
 *
 * Byte-exact, so it is safe for the non-text resources a pod carries.
 *
 * @throws {PodDecryptError} on auth failure when a DEK is supplied.
 * @throws {PodPathError} when the path is refused.
 */
export function readResourceBytes(podDir: string, target: string, dek?: Buffer): Buffer {
  const blob = readPodFile(podDir, target);
  return dek ? decryptBytes(blob, dek) : blob;
}

/**
 * Write a resource from BYTES. With a DEK the content is sealed into the
 * combined layout; without one the bytes are written verbatim.
 *
 * @throws {PodPathError} when the path is refused.
 */
export function writeResourceBytes(podDir: string, target: string, content: Buffer, dek?: Buffer): void {
  writePodFile(podDir, target, dek ? encryptBytes(content, dek) : content);
}
