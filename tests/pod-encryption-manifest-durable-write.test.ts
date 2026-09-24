/**
 * Every write of `settings/encryption.json` is atomic and durable.
 *
 * `pod init --encrypt` and `pod encrypt` write the 1.0 manifest; a bare
 * `writeFileSync` there could leave a truncated manifest over a pod that is
 * still plaintext, which every command then refuses as malformed. The manifest
 * now goes through the same helper as `pod passphrase set` and the resource
 * rewrites. A missing fsync is invisible to an ordinary test (the page cache
 * always has the right answer), so the fs calls are recorded and their ORDER
 * is pinned:
 *
 *   open temp (create-new), write temp, fsync temp, close temp,
 *   rename temp over target, open dir, fsync dir, close dir
 *
 * A temporary manifest left by a killed earlier write is removed by the next
 * manifest write.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

interface FsEvent {
  op: string;
  fd?: number;
  path?: string;
  to?: string;
  flags?: unknown;
}

const rec = vi.hoisted(() => ({
  on: false,
  events: [] as Array<{ op: string; fd?: number; path?: string; to?: string; flags?: unknown }>,
  failRename: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const log = (e: FsEvent): void => {
    if (rec.on) rec.events.push(e);
  };
  const wrapped = {
    openSync: ((p: import('node:fs').PathLike, ...rest: unknown[]) => {
      const fd = (actual.openSync as (...a: unknown[]) => number)(p, ...rest);
      log({ op: 'open', fd, path: String(p), flags: rest[0] });
      return fd;
    }) as typeof actual.openSync,
    writeFileSync: ((target: unknown, ...rest: unknown[]) => {
      log(typeof target === 'number' ? { op: 'write', fd: target } : { op: 'writeFile', path: String(target) });
      return (actual.writeFileSync as (...a: unknown[]) => void)(target, ...rest);
    }) as typeof actual.writeFileSync,
    writeSync: ((fd: number, ...rest: unknown[]) => {
      log({ op: 'write', fd });
      return (actual.writeSync as (...a: unknown[]) => number)(fd, ...rest);
    }) as typeof actual.writeSync,
    fsyncSync: ((fd: number) => {
      log({ op: 'fsync', fd });
      return actual.fsyncSync(fd);
    }) as typeof actual.fsyncSync,
    closeSync: ((fd: number) => {
      log({ op: 'close', fd });
      return actual.closeSync(fd);
    }) as typeof actual.closeSync,
    renameSync: ((from: import('node:fs').PathLike, to: import('node:fs').PathLike) => {
      log({ op: 'rename', path: String(from), to: String(to) });
      if (rec.failRename) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      return actual.renameSync(from, to);
    }) as typeof actual.renameSync,
  };
  return { ...actual, ...wrapped, default: { ...actual, ...wrapped } };
});

import * as fs from 'node:fs';
import {
  generateDek,
  buildPassphraseManifest,
  writeEncryptionManifest,
  readEncryptionManifest,
  resolveDek,
  rewrapPassphrase,
} from '../src/lib/pod-encryption.js';

const FAST_KDF = { t: 1, m: 64, p: 1 };
const PASSPHRASE = 'durable-manifest-passphrase';
const DEK = generateDek();

let pod: string;
let settings: string;
let target: string;

beforeEach(() => {
  pod = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-manifest-write-'));
  settings = path.join(pod, 'settings');
  target = path.join(settings, 'encryption.json');
  rec.events.length = 0;
  rec.failRename = false;
});

afterEach(() => {
  rec.on = false;
  fs.rmSync(pod, { recursive: true, force: true });
});

/** Replace fds and temp names with roles, so the sequence reads as a contract. */
function symbolic(events: FsEvent[]): string[] {
  const fdRole = new Map<number, string>();
  const role = (p: string): string =>
    p === target ? 'target' : p === settings ? 'dir' : /\.tmp$/.test(p) ? 'temp' : `other:${p}`;
  return events.map((e) => {
    if (e.op === 'open') {
      fdRole.set(e.fd!, role(e.path!));
      return `open ${role(e.path!)}`;
    }
    if (e.op === 'rename') return `rename ${role(e.path!)} -> ${role(e.to!)}`;
    if (e.fd !== undefined) return `${e.op} ${fdRole.get(e.fd) ?? 'unknown-fd'}`;
    return `${e.op} ${role(e.path!)}`;
  });
}

const DURABLE_SEQUENCE = [
  'open temp',
  'write temp',
  'fsync temp',
  'close temp',
  'rename temp -> target',
  'open dir',
  'fsync dir',
  'close dir',
];

describe('writeEncryptionManifest: atomic and durable', () => {
  it('creates a new temp file, writes, fsyncs it, renames, then fsyncs the directory, in that order', () => {
    const manifest = buildPassphraseManifest(DEK, PASSPHRASE, FAST_KDF);
    rec.on = true;
    writeEncryptionManifest(pod, manifest);
    rec.on = false;

    expect(symbolic(rec.events)).toEqual(DURABLE_SEQUENCE);
    // create-new: the temp name is never opened if something is already there.
    expect(rec.events[0].flags).toBe('wx');
    expect(fs.readdirSync(settings)).toEqual(['encryption.json']);
    expect(resolveDek(pod, PASSPHRASE).equals(DEK)).toBe(true);
  });

  it('a write that fails before the rename leaves no manifest and no temp file', () => {
    rec.failRename = true;
    rec.on = true;
    expect(() => writeEncryptionManifest(pod, buildPassphraseManifest(DEK, PASSPHRASE, FAST_KDF))).toThrow(
      /injected rename failure/,
    );
    rec.on = false;

    expect(symbolic(rec.events)).not.toContain('fsync dir');
    expect(fs.readdirSync(settings)).toEqual([]);
    expect(readEncryptionManifest(pod)).toBeNull();
  });
});

describe('rewrapPassphrase: the same helper, with the read-back before the rename', () => {
  it('writes the temp durably, reads it back, then renames and fsyncs the directory', () => {
    writeEncryptionManifest(pod, buildPassphraseManifest(DEK, PASSPHRASE, FAST_KDF));
    rec.on = true;
    rewrapPassphrase(pod, PASSPHRASE, 'the-new-passphrase', { kdf: FAST_KDF });
    rec.on = false;

    const seq = symbolic(rec.events);
    const from = seq.indexOf('open temp');
    expect(seq.slice(from)).toEqual([
      'open temp',
      'write temp',
      'fsync temp',
      'close temp',
      // the read-back of what is on disk
      'open temp',
      'close temp',
      'rename temp -> target',
      'open dir',
      'fsync dir',
      'close dir',
    ]);
    expect(rec.events.find((e) => e.op === 'open' && /\.tmp$/.test(e.path!))?.flags).toBe('wx');
    expect(resolveDek(pod, 'the-new-passphrase').equals(DEK)).toBe(true);
  });
});

describe('a temporary manifest left by a killed write', () => {
  const STALE = '.encryption.json.0123456789ab.tmp';
  const UNRELATED = '.encryption.json.notes';

  it('is removed by the next writeEncryptionManifest; unrelated files stay', () => {
    fs.mkdirSync(settings, { recursive: true });
    fs.writeFileSync(path.join(settings, STALE), '{"half": ');
    fs.writeFileSync(path.join(settings, UNRELATED), 'kept');
    writeEncryptionManifest(pod, buildPassphraseManifest(DEK, PASSPHRASE, FAST_KDF));
    expect(fs.readdirSync(settings).sort()).toEqual([UNRELATED, 'encryption.json'].sort());
  });

  it('is removed by the next pod passphrase set', () => {
    writeEncryptionManifest(pod, buildPassphraseManifest(DEK, PASSPHRASE, FAST_KDF));
    fs.writeFileSync(path.join(settings, STALE), '{"half": ');
    rewrapPassphrase(pod, PASSPHRASE, 'the-new-passphrase', { kdf: FAST_KDF });
    expect(fs.readdirSync(settings)).toEqual(['encryption.json']);
  });
});
