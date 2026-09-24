/**
 * Reader limits for `settings/encryption.json`.
 *
 * The manifest is plaintext, so its KDF parameters are whatever the last person
 * with write access to the pod directory put there. Every bound is checked when
 * the manifest is PARSED: a header outside the limits is refused whole, before
 * a single key derivation runs. The Argon2id primitive is wrapped in a spy so
 * "before derivation" is observed, not assumed.
 *
 * Each bound is pinned just inside and just outside, for 1.0 and 1.1.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const argonCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('@noble/hashes/argon2.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/hashes/argon2.js')>();
  return {
    ...actual,
    argon2id: (...args: Parameters<typeof actual.argon2id>) => {
      argonCalls.count += 1;
      return actual.argon2id(...args);
    },
  };
});

import {
  generateDek,
  deriveKek,
  wrapDek,
  buildPassphraseManifest,
  parseEncryptionManifest,
  readEncryptionManifest,
  resolveDek,
  rewrapPassphrase,
  writeEncryptionManifest,
  EncryptionManifestError,
  MANIFEST_LIMITS,
  OUTSIDE_LIMITS_MESSAGE,
  DEFAULT_KDF,
  type EncryptionWrapV11,
} from '../src/lib/pod-encryption.js';

const FAST_KDF = { t: 1, m: 64, p: 1 };
const PASSPHRASE = 'limits-test-passphrase';

const DEK = generateDek();
let saltCounter = 0;

/** A distinct 16-byte salt per call. */
function freshSalt(): Buffer {
  saltCounter += 1;
  const s = Buffer.alloc(16);
  s.writeUInt32BE(saltCounter, 0);
  return s;
}

function b64Bytes(n: number): string {
  return Buffer.alloc(n, 7).toString('base64');
}

/** A 1.1 passphrase wrap that really opens with {@link PASSPHRASE}. */
function openableWrap(): EncryptionWrapV11 {
  const salt = freshSalt();
  return {
    by: 'passphrase',
    label: 'primary',
    createdAt: null,
    kdf: 'argon2id',
    kdfParams: { salt: salt.toString('base64'), ...FAST_KDF },
    wrappedDek: wrapDek(DEK, deriveKek(PASSPHRASE, salt, FAST_KDF)),
  };
}

// Wrap values are computed once, at module load, so building a header in a test
// never calls Argon2id and the spy counts only what the code under test does.
const WRAP_TEMPLATE = openableWrap();
const V10_TEMPLATE = buildPassphraseManifest(DEK, PASSPHRASE, FAST_KDF);

type Mutation = (header: Record<string, unknown>, params: Record<string, unknown>, wrap: Record<string, unknown>) => void;

/**
 * Build a header of either version and apply a mutation to its (first
 * passphrase wrap's) KDF parameters, wrap, or top level.
 */
function header(version: '1.0' | '1.1', mutate: Mutation = () => {}): Record<string, unknown> {
  if (version === '1.0') {
    const h = JSON.parse(JSON.stringify(V10_TEMPLATE)) as Record<string, unknown>;
    const wraps = h.wraps as Array<Record<string, unknown>>;
    mutate(h, h.kdfParams as Record<string, unknown>, wraps[0]);
    return h;
  }
  const w = JSON.parse(JSON.stringify(WRAP_TEMPLATE)) as Record<string, unknown>;
  const h: Record<string, unknown> = { version: '1.1', algorithm: 'aes-256-gcm', wraps: [w] };
  mutate(h, w.kdfParams as Record<string, unknown>, w);
  return h;
}

function mkPod(h: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-limits-'));
  fs.mkdirSync(path.join(dir, 'settings'));
  fs.writeFileSync(path.join(dir, 'settings', 'encryption.json'), JSON.stringify(h, null, 2) + '\n');
  return dir;
}

/** `n` passphrase wraps with distinct salts (1.1) or `n` wraps sharing the top-level salt (1.0). */
function withPassphraseWraps(n: number): Mutation {
  return (h, _params, wrap) => {
    const wraps = h.wraps as Array<Record<string, unknown>>;
    wraps.length = 0;
    for (let i = 0; i < n; i += 1) {
      const copy = JSON.parse(JSON.stringify(wrap)) as Record<string, unknown>;
      if (h.version === '1.1') {
        (copy.kdfParams as Record<string, unknown>).salt = Buffer.alloc(16, i + 1).toString('base64');
      }
      wraps.push(copy);
    }
  };
}

interface Case {
  name: string;
  field: string;
  inside: Mutation;
  outside: Mutation;
}

const CASES: Case[] = [
  {
    name: 'kdfParams.m ceiling (262144 / 262145 KiB)',
    field: 'kdfParams.m',
    inside: (_h, p) => void (p.m = 262144),
    outside: (_h, p) => void (p.m = 262145),
  },
  {
    name: 'kdfParams.t (10 / 11)',
    field: 'kdfParams.t',
    inside: (_h, p) => void (p.t = 10),
    outside: (_h, p) => void (p.t = 11),
  },
  {
    name: 'kdfParams.p (8 / 9)',
    field: 'kdfParams.p',
    inside: (_h, p) => {
      p.p = 8;
      p.m = 128;
    },
    outside: (_h, p) => {
      p.p = 9;
      p.m = 128;
    },
  },
  {
    name: 'kdfParams.m floor of 8 * p (16 / 15 at p = 2)',
    field: 'kdfParams.m',
    inside: (_h, p) => {
      p.p = 2;
      p.m = 16;
    },
    outside: (_h, p) => {
      p.p = 2;
      p.m = 15;
    },
  },
  {
    name: 'kdfParams.salt shorter than 16 bytes (16 / 15)',
    field: 'kdfParams.salt',
    inside: (_h, p) => void (p.salt = b64Bytes(16)),
    outside: (_h, p) => void (p.salt = b64Bytes(15)),
  },
  {
    name: 'kdfParams.salt longer than 16 bytes (16 / 17)',
    field: 'kdfParams.salt',
    inside: (_h, p) => void (p.salt = b64Bytes(16)),
    outside: (_h, p) => void (p.salt = b64Bytes(17)),
  },
  {
    name: 'wrappedDek shorter than 60 bytes (60 / 59)',
    field: 'wrappedDek',
    inside: (_h, _p, w) => void (w.wrappedDek = b64Bytes(60)),
    outside: (_h, _p, w) => void (w.wrappedDek = b64Bytes(59)),
  },
  {
    name: 'wrappedDek longer than 60 bytes (60 / 61)',
    field: 'wrappedDek',
    inside: (_h, _p, w) => void (w.wrappedDek = b64Bytes(60)),
    outside: (_h, _p, w) => void (w.wrappedDek = b64Bytes(61)),
  },
  {
    name: 'passphrase wraps per header (8 / 9)',
    field: 'wraps',
    inside: withPassphraseWraps(8),
    outside: withPassphraseWraps(9),
  },
  {
    name: 'kdf other than argon2id',
    field: 'kdf',
    inside: () => {},
    outside: (h, _p, w) => {
      if (h.version === '1.0') h.kdf = 'scrypt';
      else w.kdf = 'scrypt';
    },
  },
];

beforeEach(() => {
  argonCalls.count = 0;
});

describe('MANIFEST_LIMITS', () => {
  it('holds the pinned numbers', () => {
    expect(MANIFEST_LIMITS).toEqual({
      mMax: 262144,
      tMin: 1,
      tMax: 10,
      pMin: 1,
      pMax: 8,
      saltBytes: 16,
      wrappedDekBytes: 60,
      maxPassphraseWraps: 8,
    });
  });
});

for (const version of ['1.0', '1.1'] as const) {
  describe(`manifest ${version}: every limit, just inside and just outside`, () => {
    for (const c of CASES) {
      it(`${c.name}: inside parses`, () => {
        expect(() => parseEncryptionManifest(JSON.stringify(header(version, c.inside)))).not.toThrow();
      });

      it(`${c.name}: outside is refused at parse, naming the field, before any derivation`, () => {
        const pod = mkPod(header(version, c.outside));
        let caught: unknown;
        try {
          resolveDek(pod, PASSPHRASE);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(EncryptionManifestError);
        const message = (caught as Error).message;
        expect(message).toContain(OUTSIDE_LIMITS_MESSAGE.slice(0, -1));
        expect(message).toContain(c.field);
        expect(argonCalls.count).toBe(0);
      });
    }
  });
}

describe('the whole header is refused, even when an earlier wrap would open', () => {
  it('1.1: wrap 0 opens, wrap 1 asks for t = 11: refused with no derivation', () => {
    // Sanity: wrap 0 alone does open, and the spy sees that derivation.
    expect(resolveDek(mkPod(header('1.1')), PASSPHRASE).equals(DEK)).toBe(true);
    expect(argonCalls.count).toBe(1);
    argonCalls.count = 0;

    const bad = JSON.parse(JSON.stringify(WRAP_TEMPLATE)) as Record<string, unknown>;
    (bad.kdfParams as Record<string, unknown>).salt = b64Bytes(16);
    (bad.kdfParams as Record<string, unknown>).t = 11;
    const pod = mkPod({ version: '1.1', algorithm: 'aes-256-gcm', wraps: [WRAP_TEMPLATE, bad] });
    expect(() => resolveDek(pod, PASSPHRASE)).toThrow(/field: wraps\[1\]\.kdfParams\.t/);
    expect(argonCalls.count).toBe(0);
  });
});

describe('the refusal names the field and not the value', () => {
  it('does not echo an attacker-chosen number', () => {
    const huge = 987654321987;
    const h = header('1.1', (_h, p) => void (p.m = huge));
    expect(() => parseEncryptionManifest(JSON.stringify(h))).toThrow(EncryptionManifestError);
    try {
      parseEncryptionManifest(JSON.stringify(h));
    } catch (e) {
      expect((e as Error).message).not.toContain(String(huge));
      expect((e as Error).message.length).toBeLessThan(120);
    }
  });

  it('refuses base64 that only a lenient decoder reads as 16 bytes', () => {
    const unpadded = b64Bytes(16).replace(/=+$/, '');
    const h = header('1.1', (_h, p) => void (p.salt = unpadded));
    expect(() => parseEncryptionManifest(JSON.stringify(h))).toThrow(/field: wraps\[0\]\.kdfParams\.salt/);
    const junk = header('1.1', (_h, p) => void (p.salt = `${b64Bytes(16)}!!`));
    expect(() => parseEncryptionManifest(JSON.stringify(junk))).toThrow(/kdfParams\.salt/);
  });
});

describe('everything the writers produce passes the reader limits', () => {
  it('buildPassphraseManifest at the default parameters (pod init --encrypt, pod encrypt)', () => {
    const m = buildPassphraseManifest(generateDek(), PASSPHRASE, DEFAULT_KDF);
    expect(() => parseEncryptionManifest(JSON.stringify(m))).not.toThrow();
  }, 30_000);

  it('rewrapPassphrase at the default parameters (pod passphrase set), from 1.0 and again from 1.1', () => {
    const pod = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-limits-writer-'));
    fs.mkdirSync(path.join(pod, 'settings'));
    writeEncryptionManifest(pod, buildPassphraseManifest(DEK, 'first passphrase', FAST_KDF));
    rewrapPassphrase(pod, 'first passphrase', 'second passphrase');
    expect(readEncryptionManifest(pod)!.version).toBe('1.1');
    rewrapPassphrase(pod, 'second passphrase', 'third passphrase');
    const text = fs.readFileSync(path.join(pod, 'settings', 'encryption.json'), 'utf-8');
    expect(() => parseEncryptionManifest(text)).not.toThrow();
    expect(resolveDek(pod, 'third passphrase').equals(DEK)).toBe(true);
  }, 60_000);

  it('the committed 1.1 fixture still parses and opens', () => {
    const pod = path.resolve(__dirname, 'fixtures', 'pod-encryption-v1.1', 'pod');
    expect(readEncryptionManifest(pod)!.version).toBe('1.1');
    expect(resolveDek(pod, 'birch meadow anchor violet copper lantern')).toHaveLength(32);
  }, 30_000);
});
