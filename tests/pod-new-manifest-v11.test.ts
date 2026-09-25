/**
 * New encrypted pods get a version 1.1 header.
 *
 * `pod init --encrypt` and `pod encrypt` write `settings/encryption.json` as
 * version 1.1 with exactly one passphrase wrap: `label: "primary"`,
 * `createdAt` set when the pod key was created, its own KDF parameters, and no
 * top-level `kdf` or `kdfParams`. Run through `dist/index.js` in separate
 * processes, then opened by another process with the same passphrase.
 *
 * Version 1.0 is still read: those tests live beside the reader
 * (`pod-encryption-manifest-v11.test.ts`, `pod-encryption-limits.test.ts`,
 * `pod-encryption-reader-agreements.test.ts`, `pod-open-reasons.test.ts`).
 *
 * All data is synthetic. The passphrase is a test-only value.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI = path.resolve(__dirname, '..', 'dist', 'index.js');
const PASSPHRASE = 'test-only passphrase for new pods';
const TIMEOUT = 120_000;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error('dist/index.js is missing. Run `npm run build` before `npm test`.');
});

function cli(args: string[], passphrase?: string): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CASCADE_POD_PASSPHRASE;
  delete env.CASCADE_POD_NEW_PASSPHRASE;
  if (passphrase !== undefined) env.CASCADE_POD_PASSPHRASE = passphrase;
  const r = spawnSync(process.execPath, [CLI, ...args], { env, input: '', encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** The header on disk, checked for the exact 1.1 single-wrap shape. */
function expectSingleWrapV11(pod: string, from: Date, to: Date): void {
  const raw = JSON.parse(fs.readFileSync(path.join(pod, 'settings', 'encryption.json'), 'utf-8')) as Record<string, unknown>;
  expect(Object.keys(raw)).toEqual(['version', 'algorithm', 'wraps']);
  expect(raw.version).toBe('1.1');
  expect(raw.algorithm).toBe('aes-256-gcm');
  const wraps = raw.wraps as Array<Record<string, unknown>>;
  expect(wraps).toHaveLength(1);
  const w = wraps[0];
  expect(Object.keys(w)).toEqual(['by', 'label', 'createdAt', 'kdf', 'kdfParams', 'wrappedDek']);
  expect(w).toMatchObject({ by: 'passphrase', label: 'primary', kdf: 'argon2id' });
  expect(w.kdfParams).toMatchObject({ t: 3, m: 65536, p: 1 });
  expect(w.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const created = new Date(w.createdAt as string).getTime();
  expect(created).toBeGreaterThanOrEqual(from.getTime());
  expect(created).toBeLessThanOrEqual(to.getTime());
}

function mkRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-new-manifest-'));
  dirs.push(d);
  return d;
}

describe('new pods write manifest 1.1 with one passphrase wrap', () => {
  it('pod init --encrypt', () => {
    const pod = path.join(mkRoot(), 'pod');
    const from = new Date();
    const r = cli(['pod', 'init', pod, '--encrypt'], PASSPHRASE);
    const to = new Date();
    expect(r.status, r.stderr).toBe(0);
    expectSingleWrapV11(pod, from, to);

    const info = cli(['--json', 'pod', 'info', pod], PASSPHRASE);
    expect(info.status, info.stderr).toBe(0);
    expect(JSON.parse(info.stdout)).toMatchObject({ encrypted: true, readable: true });
    expect(cli(['--json', 'pod', 'info', pod], 'not the passphrase').status).toBe(2);
  }, TIMEOUT);

  it('pod encrypt', () => {
    const pod = path.join(mkRoot(), 'pod');
    expect(cli(['pod', 'init', pod]).status).toBe(0);
    const from = new Date();
    const r = cli(['pod', 'encrypt', pod], PASSPHRASE);
    const to = new Date();
    expect(r.status, r.stderr).toBe(0);
    expectSingleWrapV11(pod, from, to);

    const info = cli(['--json', 'pod', 'info', pod], PASSPHRASE);
    expect(info.status, info.stderr).toBe(0);
    expect(JSON.parse(info.stdout)).toMatchObject({ encrypted: true, readable: true });
  }, TIMEOUT);

  it('a new pod re-wraps (1.1 to 1.1) and decrypts back to plaintext', () => {
    const pod = path.join(mkRoot(), 'pod');
    expect(cli(['pod', 'init', pod, '--encrypt'], PASSPHRASE).status).toBe(0);
    const env = { ...process.env, CASCADE_POD_PASSPHRASE: PASSPHRASE, CASCADE_POD_NEW_PASSPHRASE: 'test-only second' };
    const set = spawnSync(process.execPath, [CLI, '--json', 'pod', 'passphrase', 'set', pod], { env, input: '', encoding: 'utf-8' });
    expect(set.status, set.stderr).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({ manifestVersion: '1.1', wrapCount: 1 });
    const dec = cli(['pod', 'decrypt', pod], 'test-only second');
    expect(dec.status, dec.stderr).toBe(0);
    expect(fs.existsSync(path.join(pod, 'settings', 'encryption.json'))).toBe(false);
  }, TIMEOUT);
});
