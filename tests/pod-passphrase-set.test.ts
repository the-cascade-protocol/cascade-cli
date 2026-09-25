/**
 * `cascade pod passphrase set <pod-dir>`: change an encrypted pod's passphrase
 * by re-wrapping its data key.
 *
 * Two halves:
 *
 *  - In process: output shapes, every refusal (each must leave
 *    `settings/encryption.json` byte-identical), and that no file in the pod
 *    other than the manifest changes.
 *  - Across SEPARATE PROCESSES through `dist/index.js`: state that lives only in
 *    one process (a cached key, a module-level variable) cannot make a re-wrap
 *    look like it worked. Init with A, import, re-wrap to B in its own process,
 *    then read with B, fail with A, prove a copy made before the change still
 *    opens with A, and re-wrap back to A.
 *
 * All data is synthetic. Passphrases here are test-only values.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { REWRAP_DONE_MESSAGE } from '../src/commands/pod/passphrase.js';
import { resolveDek, writeEncryptionManifest, buildPassphraseManifestV10 } from '../src/lib/pod-encryption.js';

const CLI = path.resolve(__dirname, '..', 'dist', 'index.js');
const PASS_A = 'test-only passphrase alpha';
const PASS_B = 'test-only passphrase bravo';
const TIMEOUT = 120_000;

// ── helpers ───────────────────────────────────────────────────────────────────

const savedEnv = {
  cur: process.env.CASCADE_POD_PASSPHRASE,
  next: process.env.CASCADE_POD_NEW_PASSPHRASE,
};
function setEnv(cur: string | undefined, next: string | undefined): void {
  if (cur === undefined) delete process.env.CASCADE_POD_PASSPHRASE;
  else process.env.CASCADE_POD_PASSPHRASE = cur;
  if (next === undefined) delete process.env.CASCADE_POD_NEW_PASSPHRASE;
  else process.env.CASCADE_POD_NEW_PASSPHRASE = next;
}

const dirs: string[] = [];
afterEach(() => {
  setEnv(savedEnv.cur, savedEnv.next);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function mkRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-passphrase-set-'));
  dirs.push(d);
  return d;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const program = new Command();
  program
    .name('cascade')
    .exitOverride()
    .option('--verbose', 'Verbose output', false)
    .option('--json', 'Output JSON', false);
  registerPodCommand(program);

  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.map(String).join(' '));
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    out.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  process.exitCode = 0;
  try {
    await program.parseAsync(['node', 'cascade', ...args]);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
}

function cli(
  args: string[],
  env: { cur?: string; next?: string },
): { status: number; stdout: string; stderr: string } {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.CASCADE_POD_PASSPHRASE;
  delete childEnv.CASCADE_POD_NEW_PASSPHRASE;
  if (env.cur !== undefined) childEnv.CASCADE_POD_PASSPHRASE = env.cur;
  if (env.next !== undefined) childEnv.CASCADE_POD_NEW_PASSPHRASE = env.next;
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: childEnv,
    input: '',
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** A tiny synthetic FHIR bundle: two medication statements, urn:uuid ids. */
function syntheticBundle(): string {
  const med = (id: string, code: string, text: string): object => ({
    fullUrl: `urn:uuid:${id}`,
    resource: {
      resourceType: 'MedicationStatement',
      id,
      status: 'active',
      medicationCodeableConcept: {
        coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code, display: text }],
        text,
      },
    },
  });
  return JSON.stringify({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      med('6f1c1e0a-4d0b-4c1e-9b8a-000000000001', '197361', 'Lisinopril 10 MG'),
      med('6f1c1e0a-4d0b-4c1e-9b8a-000000000002', '860975', 'Metformin 500 MG'),
    ],
  });
}

function manifestPath(pod: string): string {
  return path.join(pod, 'settings', 'encryption.json');
}

/** sha256 of every file in the pod, keyed by relative path. */
function hashTree(root: string, except: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (!except.includes(rel)) out[rel] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(root);
  return out;
}

/** An encrypted pod with records, made in process with passphrase A. */
async function podWithRecords(): Promise<{ root: string; pod: string }> {
  const root = mkRoot();
  const pod = path.join(root, 'pod');
  setEnv(PASS_A, undefined);
  expect((await runCli(['pod', 'init', pod, '--encrypt'])).exitCode).toBe(0);
  const bundle = path.join(root, 'bundle.json');
  fs.writeFileSync(bundle, syntheticBundle());
  expect((await runCli(['pod', 'import', pod, bundle])).exitCode).toBe(0);
  return { root, pod };
}

/**
 * The same pod with its header rewritten as version 1.0 (same key, cheap KDF
 * settings). New pods are written as 1.1; pods made by earlier versions of this
 * tool carry 1.0, and the re-wrap must keep migrating them.
 */
async function podWithRecordsV10(): Promise<{ root: string; pod: string }> {
  const made = await podWithRecords();
  const dek = resolveDek(made.pod, PASS_A);
  writeEncryptionManifest(made.pod, buildPassphraseManifestV10(dek, PASS_A, { t: 1, m: 64, p: 1 }));
  dek.fill(0);
  return made;
}

// ── in process ────────────────────────────────────────────────────────────────

describe('pod passphrase set (in process)', () => {
  it('re-wraps a 1.0 pod to 1.1; only the manifest changes; --json has exactly four keys', async () => {
    const { pod } = await podWithRecordsV10();
    const before = hashTree(pod, ['settings/encryption.json']);
    const oldManifest = fs.readFileSync(manifestPath(pod), 'utf-8');
    expect(JSON.parse(oldManifest).version).toBe('1.0');

    setEnv(PASS_A, PASS_B);
    const r = await runCli(['--json', 'pod', 'passphrase', 'set', pod]);
    expect(r.exitCode, r.stderr).toBe(0);

    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['podDir', 'manifestVersion', 'wrapCount', 'createdAt']);
    expect(out.manifestVersion).toBe('1.1');
    expect(out.wrapCount).toBe(1);
    expect(out.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // Nothing else moved: every other file is byte-identical, none added or removed.
    expect(hashTree(pod, ['settings/encryption.json'])).toEqual(before);

    const manifest = JSON.parse(fs.readFileSync(manifestPath(pod), 'utf-8'));
    expect(manifest.version).toBe('1.1');
    expect(manifest.wraps[0].createdAt).toBe(out.createdAt);

    // No secret and no salt in anything printed.
    const printed = r.stdout + r.stderr;
    for (const secret of [PASS_A, PASS_B, manifest.wraps[0].kdfParams.salt, JSON.parse(oldManifest).kdfParams.salt]) {
      expect(printed).not.toContain(secret);
    }

    // The records read back with B.
    setEnv(PASS_B, undefined);
    const q = await runCli(['--json', 'pod', 'query', pod, '--medications']);
    expect(q.exitCode).toBe(0);
    expect(JSON.parse(q.stdout).dataTypes.medications.count).toBe(2);
  }, TIMEOUT);

  it('prints the one-line human result', async () => {
    const { pod } = await podWithRecords();
    setEnv(PASS_A, PASS_B);
    const r = await runCli(['pod', 'passphrase', 'set', pod]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(REWRAP_DONE_MESSAGE);
    expect(REWRAP_DONE_MESSAGE).toBe(
      'Re-wrapped. The new passphrase opens this pod; the old one no longer does. ' +
        'A copy of this pod made before now still opens with the old passphrase.',
    );
  }, TIMEOUT);

  it('help says what it does and that an earlier copy still opens with the old passphrase', async () => {
    const program = new Command();
    program.exitOverride().option('--json', '', false).option('--verbose', '', false);
    registerPodCommand(program);
    const set = program.commands
      .find((c) => c.name() === 'pod')!
      .commands.find((c) => c.name() === 'passphrase')!
      .commands.find((c) => c.name() === 'set')!;
    expect(set.description()).toMatch(/re-wrapping its key/);
    expect(set.description()).toMatch(/copy of the pod made before the change still opens with the old passphrase/);
  });

  describe('refusals leave the manifest byte-identical', () => {
    async function refused(
      pod: string,
      env: { cur?: string; next?: string },
      exitCode: number,
      message: RegExp,
    ): Promise<void> {
      const before = fs.existsSync(manifestPath(pod)) ? fs.readFileSync(manifestPath(pod)) : null;
      const tree = hashTree(pod);
      setEnv(env.cur, env.next);
      const r = await runCli(['pod', 'passphrase', 'set', pod]);
      expect(r.exitCode).toBe(exitCode);
      expect(r.stderr).toMatch(message);
      for (const secret of [env.cur, env.next]) if (secret) expect(r.stderr + r.stdout).not.toContain(secret);
      if (before) expect(fs.readFileSync(manifestPath(pod)).equals(before)).toBe(true);
      expect(hashTree(pod)).toEqual(tree);
    }

    it('the current passphrase opens no wrap, refused before a new one is asked for', async () => {
      const { pod } = await podWithRecords();
      // No new passphrase is available at all: the refusal must be about the
      // current one, which is checked first.
      await refused(pod, { cur: 'not the passphrase' }, 2, /current passphrase does not open this pod/);
      await refused(pod, { cur: 'not the passphrase', next: PASS_B }, 2, /does not open this pod/);
    }, TIMEOUT);

    it('the new passphrase is the same as the current one', async () => {
      const { pod } = await podWithRecords();
      await refused(pod, { cur: PASS_A, next: PASS_A }, 1, /nothing to change/);
    }, TIMEOUT);

    it('no new passphrase is available (non-interactive, env unset or empty)', async () => {
      const { pod } = await podWithRecords();
      await refused(pod, { cur: PASS_A }, 1, /CASCADE_POD_NEW_PASSPHRASE/);
      await refused(pod, { cur: PASS_A, next: '' }, 1, /CASCADE_POD_NEW_PASSPHRASE/);
    }, TIMEOUT);

    it('the pod is not encrypted', async () => {
      const root = mkRoot();
      const pod = path.join(root, 'pod');
      setEnv(undefined, undefined);
      expect((await runCli(['pod', 'init', pod])).exitCode).toBe(0);
      await refused(pod, { cur: PASS_A, next: PASS_B }, 1, /not encrypted/);
      expect(fs.existsSync(manifestPath(pod))).toBe(false);
    }, TIMEOUT);

    it('the manifest is malformed, or from a newer tool', async () => {
      const { pod } = await podWithRecordsV10();
      const good = fs.readFileSync(manifestPath(pod), 'utf-8');

      fs.writeFileSync(manifestPath(pod), good.slice(0, 40));
      await refused(pod, { cur: PASS_A, next: PASS_B }, 2, /Malformed settings\/encryption\.json/);

      fs.writeFileSync(manifestPath(pod), good.replace('"version": "1.0"', '"version": "1.2"'));
      await refused(pod, { cur: PASS_A, next: PASS_B }, 2, /written by a newer tool/);

      const v11WithTopLevel = {
        version: '1.1',
        algorithm: 'aes-256-gcm',
        kdf: 'argon2id',
        wraps: [{ by: 'passphrase', label: 'primary', createdAt: null, ...JSON.parse(good).wraps[0] }],
      };
      fs.writeFileSync(manifestPath(pod), JSON.stringify(v11WithTopLevel, null, 2));
      await refused(pod, { cur: PASS_A, next: PASS_B }, 2, /top-level kdf or kdfParams/);
    }, TIMEOUT);

    it('the pod directory does not exist', async () => {
      const root = mkRoot();
      setEnv(PASS_A, PASS_B);
      const r = await runCli(['pod', 'passphrase', 'set', path.join(root, 'nope')]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/Pod not found/);
      expect(fs.existsSync(path.join(root, 'nope'))).toBe(false);
    });
  });
});

// ── across processes ──────────────────────────────────────────────────────────

describe('pod passphrase set (separate processes, dist/index.js)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error('dist/index.js is missing. Run `npm run build` before `npm test`.');
    }
  });

  it('A to B: B reads the same records, A fails, a copy made before still opens with A, and B back to A works', () => {
    const root = mkRoot();
    const pod = path.join(root, 'pod');
    const bundle = path.join(root, 'bundle.json');
    fs.writeFileSync(bundle, syntheticBundle());

    expect(cli(['pod', 'init', pod, '--encrypt'], { cur: PASS_A }).status).toBe(0);
    const imp = cli(['pod', 'import', pod, bundle], { cur: PASS_A });
    expect(imp.status, imp.stderr).toBe(0);

    const read = (dir: string, pass: string): ReturnType<typeof cli> =>
      cli(['--json', 'pod', 'query', dir, '--medications'], { cur: pass });

    const withA = read(pod, PASS_A);
    expect(withA.status, withA.stderr).toBe(0);
    const recordsBefore = JSON.parse(withA.stdout).dataTypes;
    expect(recordsBefore.medications.count).toBe(2);

    // A copy of the whole folder made BEFORE the change.
    const copy = path.join(root, 'copy-before');
    fs.cpSync(pod, copy, { recursive: true });

    const set = cli(['--json', 'pod', 'passphrase', 'set', pod], { cur: PASS_A, next: PASS_B });
    expect(set.status, set.stderr).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({ manifestVersion: '1.1', wrapCount: 1 });
    expect(set.stdout + set.stderr).not.toContain(PASS_A);
    expect(set.stdout + set.stderr).not.toContain(PASS_B);

    const withB = read(pod, PASS_B);
    expect(withB.status, withB.stderr).toBe(0);
    expect(JSON.parse(withB.stdout).dataTypes).toEqual(recordsBefore);

    const oldFails = read(pod, PASS_A);
    expect(oldFails.status).toBe(2);
    expect(oldFails.stderr).toMatch(/passphrase did not open it/);
    expect(oldFails.stderr).toMatch(/incorrect passphrase or corrupt key/);

    // The honesty claim in the output line: the earlier copy still opens with A.
    const copyWithA = read(copy, PASS_A);
    expect(copyWithA.status, copyWithA.stderr).toBe(0);
    expect(JSON.parse(copyWithA.stdout).dataTypes).toEqual(recordsBefore);
    expect(read(copy, PASS_B).status).toBe(2);

    // And back again.
    const back = cli(['pod', 'passphrase', 'set', pod], { cur: PASS_B, next: PASS_A });
    expect(back.status, back.stderr).toBe(0);
    expect(back.stdout.trim()).toBe(REWRAP_DONE_MESSAGE);
    const again = read(pod, PASS_A);
    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout).dataTypes).toEqual(recordsBefore);
    expect(read(pod, PASS_B).status).toBe(2);

    const manifest = JSON.parse(fs.readFileSync(manifestPath(pod), 'utf-8'));
    expect(manifest.version).toBe('1.1');
    expect(manifest.wraps).toHaveLength(1);
    expect(manifest.wraps[0].label).toBe('primary');
  }, TIMEOUT);
});
