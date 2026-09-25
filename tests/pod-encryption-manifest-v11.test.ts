/**
 * Encryption manifest versions 1.0 and 1.1: the normalized reader, DEK
 * resolution across several wraps, the in-memory 1.0 to 1.1 migration, the 1.1
 * serializer, and the verified atomic re-wrap that is the only 1.1 writer.
 *
 * Cheap Argon2id parameters throughout; the KDF itself is covered in
 * pod-encryption.test.ts.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  generateDek,
  deriveKek,
  wrapDek,
  buildPassphraseManifest,
  buildPassphraseManifestV10,
  writeEncryptionManifest,
  readEncryptionManifest,
  parseEncryptionManifest,
  resolveDek,
  unlockManifest,
  migrateManifest,
  serializeEncryptionManifestV11,
  rewrapPassphrase,
  PodDecryptError,
  EncryptionManifestError,
  type EncryptionManifestV10,
  type EncryptionManifestV11,
  type EncryptionWrapV11,
} from '../src/lib/pod-encryption.js';

const FAST_KDF = { t: 1, m: 64, p: 1 };
const FIXED_NOW = new Date('2026-01-02T03:04:05.678Z');

function mkPod(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-manifest-'));
  fs.mkdirSync(path.join(dir, 'settings'));
  return dir;
}

function manifestFile(pod: string): string {
  return path.join(pod, 'settings', 'encryption.json');
}

/** A passphrase wrap in 1.1 form with its own fresh salt. */
function passphraseWrap(dek: Buffer, passphrase: string, label: string | null = 'primary'): EncryptionWrapV11 {
  const salt = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)));
  return {
    by: 'passphrase',
    label,
    createdAt: '2026-01-01T00:00:00.000Z',
    kdf: 'argon2id',
    kdfParams: { salt: salt.toString('base64'), ...FAST_KDF },
    wrappedDek: wrapDek(dek, deriveKek(passphrase, salt, FAST_KDF)),
  };
}

function writeRaw(pod: string, value: unknown): void {
  fs.writeFileSync(manifestFile(pod), JSON.stringify(value, null, 2) + '\n');
}

function tempLeftovers(pod: string): string[] {
  return fs.readdirSync(path.join(pod, 'settings')).filter((f) => f.endsWith('.tmp'));
}

describe('readEncryptionManifest: 1.0 normalizes to per-wrap KDF params', () => {
  it('copies the top-level params into the passphrase wrap, label "primary" and createdAt null', () => {
    const pod = mkPod();
    const v10 = buildPassphraseManifestV10(generateDek(), 'pw-a', FAST_KDF);
    writeEncryptionManifest(pod, v10);
    const n = readEncryptionManifest(pod)!;
    expect(n.version).toBe('1.0');
    expect(n.wraps).toHaveLength(1);
    const w = n.wraps[0];
    if (w.kind !== 'passphrase') throw new Error('expected passphrase wrap');
    expect(w.kdfParams).toEqual(v10.kdfParams);
    expect(w.label).toBe('primary');
    expect(w.createdAt).toBeNull();
    // The wrap's public identifier is the salt, unchanged by reading.
    expect(w.kdfParams.salt).toBe(v10.kdfParams.salt);
  });

  it('buildPassphraseManifestV10 still produces the 1.0 layout the reader is tested against', () => {
    const m = buildPassphraseManifestV10(generateDek(), 'pw', FAST_KDF);
    expect(m.version).toBe('1.0');
    expect(Object.keys(m)).toEqual(['version', 'algorithm', 'kdf', 'kdfParams', 'wraps']);
  });

  it('buildPassphraseManifest (what new pods get) writes 1.1: one passphrase wrap, "primary", createdAt now', () => {
    const dek = generateDek();
    const m = buildPassphraseManifest(dek, 'pw', FAST_KDF, { now: () => FIXED_NOW });
    expect(m.version).toBe('1.1');
    expect(Object.keys(m)).toEqual(['version', 'algorithm', 'wraps']);
    expect(m.wraps).toHaveLength(1);
    expect(Object.keys(m.wraps[0])).toEqual(['by', 'label', 'createdAt', 'kdf', 'kdfParams', 'wrappedDek']);
    expect(m.wraps[0]).toMatchObject({ by: 'passphrase', label: 'primary', createdAt: FIXED_NOW.toISOString(), kdf: 'argon2id' });
    // Serializable as written, and it opens to the same key.
    const n = parseEncryptionManifest(serializeEncryptionManifestV11(m)).normalized;
    expect(unlockManifest(n, 'pw').dek.equals(dek)).toBe(true);
  });
});

describe('parseEncryptionManifest: strictness', () => {
  const dek = generateDek();
  const good11: EncryptionManifestV11 = {
    version: '1.1',
    algorithm: 'aes-256-gcm',
    wraps: [passphraseWrap(dek, 'pw-a')],
  };

  it('reads a well-formed 1.1 manifest', () => {
    const p = parseEncryptionManifest(JSON.stringify(good11));
    expect(p.normalized.version).toBe('1.1');
    expect(p.normalized.wraps[0]).toMatchObject({ kind: 'passphrase', label: 'primary' });
  });

  it('refuses a 1.1 manifest with a top-level kdfParams', () => {
    const bad = { ...good11, kdfParams: good11.wraps[0].kdfParams };
    expect(() => parseEncryptionManifest(JSON.stringify(bad))).toThrow(EncryptionManifestError);
    expect(() => parseEncryptionManifest(JSON.stringify(bad))).toThrow(/top-level kdf or kdfParams/);
  });

  it('refuses a 1.1 manifest with a top-level kdf', () => {
    const bad = { ...good11, kdf: 'argon2id' };
    expect(() => parseEncryptionManifest(JSON.stringify(bad))).toThrow(/top-level kdf or kdfParams/);
  });

  it('refuses empty wraps in both versions', () => {
    expect(() => parseEncryptionManifest(JSON.stringify({ ...good11, wraps: [] }))).toThrow(
      /non-empty/,
    );
    const v10 = buildPassphraseManifestV10(dek, 'pw', FAST_KDF);
    expect(() => parseEncryptionManifest(JSON.stringify({ ...v10, wraps: [] }))).toThrow(/non-empty/);
  });

  it('refuses an unknown version as written by a newer tool', () => {
    expect(() => parseEncryptionManifest(JSON.stringify({ ...good11, version: '1.2' }))).toThrow(
      /version "1\.2": this pod was written by a newer tool/,
    );
    expect(() => parseEncryptionManifest(JSON.stringify({ ...good11, version: '2.0' }))).toThrow(
      EncryptionManifestError,
    );
  });

  it('refuses invalid JSON and a passphrase wrap without its own params', () => {
    expect(() => parseEncryptionManifest('{ not json')).toThrow(/not valid JSON/);
    const { kdfParams: _drop, ...noParams } = good11.wraps[0];
    expect(() =>
      parseEncryptionManifest(JSON.stringify({ ...good11, wraps: [noParams] })),
    ).toThrow(/kdfParams is missing/);
  });

  it('refuses a 1.1 wrap whose label is neither string nor null', () => {
    const w = { ...good11.wraps[0], label: 7 };
    expect(() => parseEncryptionManifest(JSON.stringify({ ...good11, wraps: [w] }))).toThrow(
      /label must be a string or null/,
    );
  });
});

describe('unlockManifest / resolveDek across several wraps', () => {
  it('opens with either passphrase, each wrap with its own params, first verified wins', () => {
    const pod = mkPod();
    const dek = generateDek();
    writeRaw(pod, {
      version: '1.1',
      algorithm: 'aes-256-gcm',
      wraps: [passphraseWrap(dek, 'pw-a'), passphraseWrap(dek, 'pw-b', null)],
    });
    expect(resolveDek(pod, 'pw-a').equals(dek)).toBe(true);
    expect(resolveDek(pod, 'pw-b').equals(dek)).toBe(true);
    const n = readEncryptionManifest(pod)!;
    expect(unlockManifest(n, 'pw-a').wrapIndex).toBe(0);
    expect(unlockManifest(n, 'pw-b').wrapIndex).toBe(1);
    expect(() => resolveDek(pod, 'pw-c')).toThrow(PodDecryptError);
  });

  it('skips a wrap kind it does not implement', () => {
    const dek = generateDek();
    const m = {
      version: '1.1',
      algorithm: 'aes-256-gcm',
      wraps: [
        { by: 'device-keychain', label: null, createdAt: null, keyRef: 'opaque' },
        passphraseWrap(dek, 'pw-a'),
      ],
    };
    const n = parseEncryptionManifest(JSON.stringify(m)).normalized;
    expect(n.wraps[0].kind).toBe('unimplemented');
    const u = unlockManifest(n, 'pw-a');
    expect(u.wrapIndex).toBe(1);
    expect(u.dek.equals(dek)).toBe(true);
  });

  it('reports "cannot open" when no wrap is one it implements', () => {
    const n = parseEncryptionManifest(
      JSON.stringify({
        version: '1.1',
        algorithm: 'aes-256-gcm',
        wraps: [{ by: 'device-keychain', label: null, createdAt: null }],
      }),
    ).normalized;
    expect(() => unlockManifest(n, 'anything')).toThrow(EncryptionManifestError);
    expect(() => unlockManifest(n, 'anything')).toThrow(/no wrap this tool implements/);
  });
});

describe('migrateManifest (1.0 to 1.1, in memory)', () => {
  it('moves the KDF into the passphrase wrap, labels it primary, createdAt null', () => {
    const v10 = buildPassphraseManifestV10(generateDek(), 'pw', FAST_KDF);
    const before = JSON.stringify(v10);
    const v11 = migrateManifest(v10);
    expect(JSON.stringify(v10)).toBe(before); // pure
    expect(Object.keys(v11)).toEqual(['version', 'algorithm', 'wraps']);
    expect(v11.version).toBe('1.1');
    expect(v11.wraps[0]).toEqual({
      by: 'passphrase',
      label: 'primary',
      createdAt: null,
      kdf: 'argon2id',
      kdfParams: v10.kdfParams,
      wrappedDek: v10.wraps[0].wrappedDek,
    });
  });

  it('carries any other wrap over with label null and createdAt null', () => {
    const v10 = buildPassphraseManifestV10(generateDek(), 'pw', FAST_KDF);
    const withOther = {
      ...v10,
      wraps: [...v10.wraps, { by: 'device-keychain', wrappedDek: 'AAAA' }],
    } as EncryptionManifestV10;
    const v11 = migrateManifest(withOther);
    expect(v11.wraps[1]).toEqual({
      by: 'device-keychain',
      label: null,
      createdAt: null,
      wrappedDek: 'AAAA',
    });
  });

  it('refuses a 1.0 manifest whose passphrase wraps share its one salt', () => {
    const v10 = buildPassphraseManifestV10(generateDek(), 'pw', FAST_KDF);
    const two = { ...v10, wraps: [v10.wraps[0], v10.wraps[0]] };
    expect(() => migrateManifest(two)).toThrow(/2 passphrase wraps/);
  });
});

describe('serializeEncryptionManifestV11', () => {
  it('emits the fixed key order and no top-level kdf or kdfParams', () => {
    const dek = generateDek();
    const w = passphraseWrap(dek, 'pw');
    // Deliberately scrambled input key order.
    const scrambled = {
      wrappedDek: w.wrappedDek,
      kdfParams: { p: 1, m: FAST_KDF.m, t: FAST_KDF.t, salt: w.kdfParams!.salt },
      kdf: 'argon2id' as const,
      createdAt: w.createdAt,
      label: w.label,
      by: 'passphrase',
    };
    const text = serializeEncryptionManifestV11({
      wraps: [scrambled],
      algorithm: 'aes-256-gcm',
      version: '1.1',
    } as EncryptionManifestV11);
    const parsed = JSON.parse(text);
    expect(text.endsWith('}\n')).toBe(true);
    expect(Object.keys(parsed)).toEqual(['version', 'algorithm', 'wraps']);
    expect(Object.keys(parsed.wraps[0])).toEqual([
      'by',
      'label',
      'createdAt',
      'kdf',
      'kdfParams',
      'wrappedDek',
    ]);
    expect(Object.keys(parsed.wraps[0].kdfParams)).toEqual(['salt', 't', 'm', 'p']);
  });

  it('refuses to write a top-level kdfParams, an empty wraps, or a shared salt', () => {
    const dek = generateDek();
    const w = passphraseWrap(dek, 'pw');
    const base: EncryptionManifestV11 = { version: '1.1', algorithm: 'aes-256-gcm', wraps: [w] };
    expect(() =>
      serializeEncryptionManifestV11({ ...base, kdfParams: w.kdfParams } as unknown as EncryptionManifestV11),
    ).toThrow(/top-level/);
    expect(() => serializeEncryptionManifestV11({ ...base, wraps: [] })).toThrow(/non-empty/);
    expect(() => serializeEncryptionManifestV11({ ...base, wraps: [w, { ...w }] })).toThrow(
      /reuses another wrap's salt/,
    );
  });
});

describe('rewrapPassphrase', () => {
  function encryptedPod(passphrase = 'pw-old'): { pod: string; dek: Buffer } {
    const pod = mkPod();
    const dek = generateDek();
    writeEncryptionManifest(pod, buildPassphraseManifestV10(dek, passphrase, FAST_KDF));
    return { pod, dek };
  }

  it('migrates 1.0 to 1.1; the new passphrase opens the same DEK and the old does not', () => {
    const { pod, dek } = encryptedPod();
    const oldSalt = (JSON.parse(fs.readFileSync(manifestFile(pod), 'utf-8')) as EncryptionManifestV10)
      .kdfParams.salt;
    const r = rewrapPassphrase(pod, 'pw-old', 'pw-new', { kdf: FAST_KDF, now: () => FIXED_NOW });
    expect(r).toEqual({
      manifestVersion: '1.1',
      wrapCount: 1,
      createdAt: '2026-01-02T03:04:05.678Z',
      replacedWrapIndex: 0,
    });
    expect(resolveDek(pod, 'pw-new').equals(dek)).toBe(true);
    expect(() => resolveDek(pod, 'pw-old')).toThrow(PodDecryptError);

    const onDisk = JSON.parse(fs.readFileSync(manifestFile(pod), 'utf-8'));
    expect(Object.keys(onDisk)).toEqual(['version', 'algorithm', 'wraps']);
    expect(onDisk.wraps[0].label).toBe('primary');
    expect(onDisk.wraps[0].createdAt).toBe('2026-01-02T03:04:05.678Z');
    expect(Buffer.from(onDisk.wraps[0].kdfParams.salt, 'base64')).toHaveLength(16);
    expect(onDisk.wraps[0].kdfParams.salt).not.toBe(oldSalt);
    expect(tempLeftovers(pod)).toEqual([]);
  });

  it('writes the default KDF parameters when none are given', () => {
    const { pod } = encryptedPod();
    rewrapPassphrase(pod, 'pw-old', 'pw-new');
    const onDisk = JSON.parse(fs.readFileSync(manifestFile(pod), 'utf-8'));
    expect(onDisk.wraps[0].kdfParams).toMatchObject({ t: 3, m: 65536, p: 1 });
  }, 60_000);

  it('replaces only the wrap that opened, keeping its label, and leaves the others intact', () => {
    const pod = mkPod();
    const dek = generateDek();
    const other = { by: 'device-keychain', label: null, createdAt: null, keyRef: 'opaque' };
    const b = passphraseWrap(dek, 'pw-b', 'spare');
    writeRaw(pod, {
      version: '1.1',
      algorithm: 'aes-256-gcm',
      wraps: [passphraseWrap(dek, 'pw-a'), other, b],
    });
    const r = rewrapPassphrase(pod, 'pw-b', 'pw-c', { kdf: FAST_KDF, now: () => FIXED_NOW });
    expect(r.replacedWrapIndex).toBe(2);
    expect(r.wrapCount).toBe(3);
    const onDisk = JSON.parse(fs.readFileSync(manifestFile(pod), 'utf-8'));
    expect(onDisk.wraps[1]).toEqual(other);
    expect(onDisk.wraps[2].label).toBe('spare');
    expect(resolveDek(pod, 'pw-a').equals(dek)).toBe(true);
    expect(resolveDek(pod, 'pw-c').equals(dek)).toBe(true);
    expect(() => resolveDek(pod, 'pw-b')).toThrow(PodDecryptError);
  });

  it('a second re-wrap keeps the label and moves createdAt', () => {
    const { pod, dek } = encryptedPod();
    rewrapPassphrase(pod, 'pw-old', 'pw-new', { kdf: FAST_KDF, now: () => FIXED_NOW });
    const later = new Date('2026-02-03T04:05:06.789Z');
    rewrapPassphrase(pod, 'pw-new', 'pw-old', { kdf: FAST_KDF, now: () => later });
    const onDisk = JSON.parse(fs.readFileSync(manifestFile(pod), 'utf-8'));
    expect(onDisk.wraps).toHaveLength(1);
    expect(onDisk.wraps[0].label).toBe('primary');
    expect(onDisk.wraps[0].createdAt).toBe(later.toISOString());
    expect(resolveDek(pod, 'pw-old').equals(dek)).toBe(true);
  });

  describe('refusals leave the manifest byte-identical', () => {
    function expectRefused(pod: string, fn: () => unknown, pattern: RegExp | typeof PodDecryptError): void {
      const before = fs.readFileSync(manifestFile(pod));
      expect(fn).toThrow(pattern);
      expect(fs.readFileSync(manifestFile(pod)).equals(before)).toBe(true);
      expect(tempLeftovers(pod)).toEqual([]);
    }

    it('the current passphrase opens no wrap', () => {
      const { pod } = encryptedPod();
      expectRefused(pod, () => rewrapPassphrase(pod, 'wrong', 'pw-new', { kdf: FAST_KDF }), PodDecryptError);
    });

    it('the new passphrase is empty, or the same as the current one', () => {
      const { pod } = encryptedPod();
      expectRefused(pod, () => rewrapPassphrase(pod, 'pw-old', '', { kdf: FAST_KDF }), /empty/);
      expectRefused(pod, () => rewrapPassphrase(pod, 'pw-old', 'pw-old', { kdf: FAST_KDF }), /nothing to change/);
    });

    it('the manifest is malformed, or a newer version', () => {
      const pod = mkPod();
      fs.writeFileSync(manifestFile(pod), '{ not json');
      expectRefused(pod, () => rewrapPassphrase(pod, 'a', 'b', { kdf: FAST_KDF }), /not valid JSON/);
      writeRaw(pod, { version: '1.2', algorithm: 'aes-256-gcm', wraps: [] });
      expectRefused(pod, () => rewrapPassphrase(pod, 'a', 'b', { kdf: FAST_KDF }), /newer tool/);
    });

    it('the pod is not encrypted', () => {
      const pod = mkPod();
      expect(() => rewrapPassphrase(pod, 'a', 'b', { kdf: FAST_KDF })).toThrow(/not encrypted/);
      expect(fs.existsSync(manifestFile(pod))).toBe(false);
    });

    it('the bytes read back from the temporary file do not open with the new passphrase', () => {
      const { pod, dek } = encryptedPod();
      // A writer that damages one byte inside the new wrappedDek: still valid
      // JSON and valid base64, so only the read-back unwrap can catch it.
      const corrupting = (fd: number, bytes: Buffer): void => {
        const text = bytes.toString('utf-8');
        const at = text.indexOf('"wrappedDek": "') + '"wrappedDek": "'.length + 20;
        const damaged = Buffer.from(text);
        damaged[at] = damaged[at] === 0x41 ? 0x42 : 0x41; // 'A' <-> 'B'
        fs.writeSync(fd, damaged, 0, damaged.length, 0);
      };
      expectRefused(
        pod,
        () => rewrapPassphrase(pod, 'pw-old', 'pw-new', { kdf: FAST_KDF, writeTemp: corrupting }),
        /did not open with the new passphrase when read back/,
      );
      expect(resolveDek(pod, 'pw-old').equals(dek)).toBe(true);
    });

    it('the bytes read back open with the new passphrase, but to a DIFFERENT key', () => {
      const { pod, dek } = encryptedPod();
      // A writer that re-wraps a different key under the new passphrase's own
      // KEK: the read-back unwrap succeeds, so only the key comparison can
      // catch it. Renaming this over the manifest would lose the pod's key.
      const otherKey = generateDek();
      const substituting = (fd: number, bytes: Buffer): void => {
        const m = JSON.parse(bytes.toString('utf-8')) as EncryptionManifestV11;
        const w = m.wraps[0];
        const kek = deriveKek('pw-new', Buffer.from(w.kdfParams!.salt, 'base64'), w.kdfParams!);
        w.wrappedDek = wrapDek(otherKey, kek);
        const out = Buffer.from(serializeEncryptionManifestV11(m));
        fs.writeSync(fd, out, 0, out.length, 0);
      };
      expectRefused(
        pod,
        () => rewrapPassphrase(pod, 'pw-old', 'pw-new', { kdf: FAST_KDF, writeTemp: substituting }),
        /opened to a different key when read back/,
      );
      expect(resolveDek(pod, 'pw-old').equals(dek)).toBe(true);
    });
  });
});
