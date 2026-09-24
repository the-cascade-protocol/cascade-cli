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
  fs.writeFileSync(path.join(dir, 'settings', 'encryption.json'), serialized(h));
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

/** One passphrase wrap plus `n` wraps of a kind this tool does not implement. */
function withOtherWraps(n: number): Mutation {
  return (h) => {
    const wraps = h.wraps as Array<Record<string, unknown>>;
    for (let i = 0; i < n; i += 1) wraps.push({ by: 'device-keychain', label: null, createdAt: null });
  };
}

/**
 * Pad the header (serialized by {@link mkPod} and {@link serialized}) to exactly
 * `bytes` bytes with an ignored top-level key. The key is removed and re-added
 * so the padding is sized against the final serialization.
 */
function padToBytes(bytes: number): Mutation {
  return (h) => {
    h.padding = '';
    const base = Buffer.byteLength(serialized(h), 'utf-8');
    h.padding = 'x'.repeat(bytes - base);
  };
}

/** The exact text a header is written as. */
function serialized(h: unknown): string {
  return JSON.stringify(h, null, 2) + '\n';
}

interface Case {
  name: string;
  field: string;
  inside: Mutation;
  outside: Mutation;
}

const CASES: Case[] = [
  {
    name: 'kdfParams.m ceiling (131072 / 131073 KiB)',
    field: 'kdfParams.m',
    inside: (_h, p) => void (p.m = 131072),
    outside: (_h, p) => void (p.m = 131073),
  },
  {
    name: 'kdfParams.t (6 / 7)',
    field: 'kdfParams.t',
    inside: (_h, p) => void (p.t = 6),
    outside: (_h, p) => void (p.t = 7),
  },
  {
    name: 'kdfParams.p (4 / 5)',
    field: 'kdfParams.p',
    inside: (_h, p) => {
      p.p = 4;
      p.m = 128;
    },
    outside: (_h, p) => {
      p.p = 5;
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
    name: 'passphrase wraps per header (6 / 7)',
    field: 'wraps (passphrase)',
    inside: withPassphraseWraps(6),
    outside: withPassphraseWraps(7),
  },
  {
    name: 'wraps of any kind per header (16 / 17)',
    field: 'field: wraps)',
    inside: withOtherWraps(15),
    outside: withOtherWraps(16),
  },
  {
    name: 'header size (65536 / 65537 bytes)',
    field: 'header size',
    inside: padToBytes(65536),
    outside: padToBytes(65537),
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
      mMax: 131072,
      tMin: 1,
      tMax: 6,
      pMin: 1,
      pMax: 4,
      saltBytes: 16,
      wrappedDekBytes: 60,
      maxPassphraseWraps: 6,
      maxWraps: 16,
      maxHeaderBytes: 65536,
    });
  });
});

for (const version of ['1.0', '1.1'] as const) {
  describe(`manifest ${version}: every limit, just inside and just outside`, () => {
    for (const c of CASES) {
      it(`${c.name}: inside parses`, () => {
        expect(() => parseEncryptionManifest(serialized(header(version, c.inside)))).not.toThrow();
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
  it('1.1: wrap 0 opens, wrap 1 asks for t = 7: refused with no derivation', () => {
    // Sanity: wrap 0 alone does open, and the spy sees that derivation.
    expect(resolveDek(mkPod(header('1.1')), PASSPHRASE).equals(DEK)).toBe(true);
    expect(argonCalls.count).toBe(1);
    argonCalls.count = 0;

    const bad = JSON.parse(JSON.stringify(WRAP_TEMPLATE)) as Record<string, unknown>;
    (bad.kdfParams as Record<string, unknown>).salt = b64Bytes(16);
    (bad.kdfParams as Record<string, unknown>).t = 7;
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

describe('an oversized header is refused from its size, before it is read', () => {
  it('a 3 GiB (sparse) header is refused by size, not by an attempt to read it', () => {
    // Node refuses to read a file over 2 GiB into one buffer with its own
    // error, so seeing the size refusal here proves the file was never read.
    const pod = mkPod(header('1.1'));
    fs.truncateSync(path.join(pod, 'settings', 'encryption.json'), 3 * 1024 ** 3);
    try {
      expect(() => readEncryptionManifest(pod)).toThrow(/field: header size/);
      expect(() => resolveDek(pod, PASSPHRASE)).toThrow(/field: header size/);
      expect(argonCalls.count).toBe(0);
    } finally {
      fs.rmSync(pod, { recursive: true, force: true });
    }
  });
});

describe('the header size is also checked on the text, in bytes', () => {
  // parseEncryptionManifest takes text from any caller, not only from the
  // bounded file read, so it checks the size itself, and in UTF-8 bytes: a
  // header of multi-byte characters is longer in bytes than in characters.
  function withLabelOfBytes(targetBytes: number): string {
    const h = header('1.1');
    const w = (h.wraps as Array<Record<string, unknown>>)[0];
    w.label = '';
    const base = Buffer.byteLength(serialized(h));
    const euros = Math.floor((targetBytes - base) / 3);
    w.label = '\u20ac'.repeat(euros) + 'x'.repeat(targetBytes - base - euros * 3);
    const text = serialized(h);
    expect(Buffer.byteLength(text)).toBe(targetBytes);
    return text;
  }

  it('65536 bytes of text parses; 65537 is refused naming the header size, before derivation', () => {
    expect(() => parseEncryptionManifest(withLabelOfBytes(65536))).not.toThrow();
    const over = withLabelOfBytes(65537);
    expect(over.length).toBeLessThan(65536);
    expect(() => parseEncryptionManifest(over)).toThrow(/field: header size/);
    expect(argonCalls.count).toBe(0);
  });
});

describe('the 1.0 writer refuses parameters a reader would refuse', () => {
  for (const [name, params, field] of [
    ['m above the ceiling', { t: 1, m: 131073, p: 1 }, 'kdfParams.m'],
    ['t above the ceiling', { t: 7, m: 64, p: 1 }, 'kdfParams.t'],
    ['p above the ceiling', { t: 1, m: 64, p: 5 }, 'kdfParams.p'],
    ['m below 8 * p', { t: 1, m: 15, p: 2 }, 'kdfParams.m'],
  ] as const) {
    it(`buildPassphraseManifest: ${name}`, () => {
      expect(() => buildPassphraseManifest(DEK, PASSPHRASE, params)).toThrow(
        new RegExp(`field: ${field.replace('.', '\\.')}`),
      );
      expect(argonCalls.count).toBe(0);
    });
  }
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
