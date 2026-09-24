/**
 * `settings/encryption.json` must be a regular file, reached without a symbolic
 * link, and it is never read past the header size limit.
 *
 * A path's size is no guide to what reading it costs: a character device
 * reports size 0 and never ends, and a FIFO reports size 0 and blocks until a
 * writer appears. So the kind is judged on the open handle, the open itself
 * never blocks, and the read is bounded whatever the handle says. Each refusal
 * is the ordinary malformed-header refusal (reason `manifest-malformed`).
 *
 * The reads are counted through a wrapper on `node:fs`, so "bounded" is
 * observed, not assumed. The command-path cases run `node dist/index.js` in a
 * separate process with a timeout, so a hang fails the test instead of the run.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const reads = vi.hoisted(() => ({ bytes: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrapped = {
    readSync: ((...args: unknown[]) => {
      const n = (actual.readSync as (...a: unknown[]) => number)(...args);
      reads.bytes += n;
      return n;
    }) as typeof actual.readSync,
    readFileSync: ((...args: unknown[]) => {
      const out = (actual.readFileSync as (...a: unknown[]) => string | Buffer)(...args);
      reads.bytes += typeof out === 'string' ? Buffer.byteLength(out) : out.length;
      return out;
    }) as typeof actual.readFileSync,
  };
  return { ...actual, ...wrapped, default: { ...actual, ...wrapped } };
});

import * as fs from 'node:fs';
import {
  generateDek,
  buildPassphraseManifest,
  writeEncryptionManifest,
  readEncryptionManifest,
  isPodEncrypted,
  resolveDek,
  rewrapPassphrase,
  EncryptionManifestError,
  MANIFEST_LIMITS,
} from '../src/lib/pod-encryption.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'dist', 'index.js');

const PASSPHRASE = 'file-kind-passphrase';
const FAST_KDF = { t: 1, m: 64, p: 1 };
const NOT_REGULAR = /Malformed settings\/encryption\.json: not a regular file/;

let root: string;
let goodHeader: string;
let podCounter = 0;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-header-kind-'));
  const probe = path.join(root, 'probe');
  fs.mkdirSync(probe);
  writeEncryptionManifest(probe, buildPassphraseManifest(generateDek(), PASSPHRASE, FAST_KDF));
  goodHeader = fs.readFileSync(path.join(probe, 'settings', 'encryption.json'), 'utf-8');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A pod directory with an empty `settings/`, and the header path inside it. */
function emptyPod(): { pod: string; header: string } {
  podCounter += 1;
  const pod = path.join(root, `pod-${podCounter}`);
  fs.mkdirSync(path.join(pod, 'settings'), { recursive: true });
  return { pod, header: path.join(pod, 'settings', 'encryption.json') };
}

/** Expect the ordinary malformed-header refusal for "not a regular file". */
function expectNotRegular(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(EncryptionManifestError);
  expect((caught as EncryptionManifestError).kind).toBe('malformed');
  expect((caught as Error).message).toMatch(NOT_REGULAR);
}

describe('the header must be a regular file', () => {
  it('a symbolic link to /dev/zero is refused at once, reading nothing, with bounded memory', () => {
    const { pod, header } = emptyPod();
    fs.symlinkSync('/dev/zero', header);
    expect(isPodEncrypted(pod)).toBe(true);

    const rssBefore = process.memoryUsage().rss;
    const started = Date.now();
    reads.bytes = 0;
    expectNotRegular(() => readEncryptionManifest(pod));
    expectNotRegular(() => resolveDek(pod, PASSPHRASE));
    expect(Date.now() - started).toBeLessThan(2000);
    // Never more than the limit plus one byte, whatever the refusal path.
    expect(reads.bytes).toBeLessThanOrEqual(MANIFEST_LIMITS.maxHeaderBytes + 1);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(64 * 1024 * 1024);
  });

  it('a FIFO is refused and the reader does not block', () => {
    const { pod, header } = emptyPod();
    const mk = spawnSync('mkfifo', [header]);
    expect(mk.status, String(mk.stderr)).toBe(0);
    expect(fs.lstatSync(header).isFIFO()).toBe(true);

    const started = Date.now();
    expectNotRegular(() => readEncryptionManifest(pod));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a directory at the header path is refused', () => {
    const { pod, header } = emptyPod();
    fs.mkdirSync(header);
    expect(isPodEncrypted(pod)).toBe(true);
    expectNotRegular(() => readEncryptionManifest(pod));
  });

  it('a symbolic link to a valid header is refused, not followed', () => {
    const { pod, header } = emptyPod();
    const elsewhere = path.join(root, `real-header-${podCounter}.json`);
    fs.writeFileSync(elsewhere, goodHeader);
    fs.symlinkSync(elsewhere, header);
    expectNotRegular(() => readEncryptionManifest(pod));
    expectNotRegular(() => rewrapPassphrase(pod, PASSPHRASE, 'a-new-passphrase', { kdf: FAST_KDF }));
    expect(fs.readFileSync(elsewhere, 'utf-8')).toBe(goodHeader);
  });

  it('a dangling symbolic link still marks the pod encrypted, and is refused', () => {
    const { pod, header } = emptyPod();
    fs.symlinkSync(path.join(root, 'does-not-exist.json'), header);
    expect(isPodEncrypted(pod)).toBe(true);
    expectNotRegular(() => readEncryptionManifest(pod));
  });

  it('a settings directory that is a symbolic link is refused', () => {
    podCounter += 1;
    const pod = path.join(root, `pod-${podCounter}`);
    const outside = path.join(root, `outside-settings-${podCounter}`);
    fs.mkdirSync(pod);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'encryption.json'), goodHeader);
    fs.symlinkSync(outside, path.join(pod, 'settings'));
    expectNotRegular(() => readEncryptionManifest(pod));
  });
});

describe('a regular header at the size limit still opens', () => {
  it('a 65536-byte header parses; one byte more is refused by size', () => {
    const { pod, header } = emptyPod();
    const padded = goodHeader + ' '.repeat(MANIFEST_LIMITS.maxHeaderBytes - Buffer.byteLength(goodHeader));
    expect(Buffer.byteLength(padded)).toBe(65536);
    fs.writeFileSync(header, padded);
    expect(readEncryptionManifest(pod)?.version).toBe('1.0');
    expect(resolveDek(pod, PASSPHRASE)).toHaveLength(32);

    fs.writeFileSync(header, padded + ' ');
    expect(() => readEncryptionManifest(pod)).toThrow(/field: header size/);
  });
});

describe('through the command path, in a separate process', () => {
  function podInfo(pod: string): { exitCode: number | null; stderr: string; signal: NodeJS.Signals | null } {
    const env = { ...process.env, CASCADE_POD_PASSPHRASE: PASSPHRASE };
    const res = spawnSync(process.execPath, [CLI, '--json', 'pod', 'info', pod], {
      encoding: 'utf-8',
      env,
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: res.status, stderr: res.stderr ?? '', signal: res.signal };
  }

  function reason(stderr: string): unknown {
    const line = stderr
      .trim()
      .split('\n')
      .reverse()
      .find((l) => l.trim().startsWith('{'));
    return line ? (JSON.parse(line) as Record<string, unknown>).reason : undefined;
  }

  for (const [name, plant] of [
    ['a symbolic link to /dev/zero', (h: string) => fs.symlinkSync('/dev/zero', h)],
    ['a FIFO', (h: string) => expect(spawnSync('mkfifo', [h]).status).toBe(0)],
  ] as const) {
    it(`pod info refuses ${name} as a malformed header, and exits`, () => {
      const { pod, header } = emptyPod();
      plant(header);
      const run = podInfo(pod);
      expect(run.signal, 'the command was killed by the timeout').toBeNull();
      expect(run.exitCode, run.stderr).toBe(2);
      expect(reason(run.stderr)).toBe('manifest-malformed');
      expect(run.stderr).toMatch(/not a regular file/);
    }, 60_000);
  }
});
