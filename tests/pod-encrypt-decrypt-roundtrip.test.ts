/**
 * Regression tests for root BACKLOG 1.8 and 4.25: `pod encrypt` / `pod decrypt`
 * used a four-directory ALLOWLIST (clinical, wellness, profile, settings, plus
 * index.ttl and two named files) to decide what a pod resource is.
 *
 * Both directions used it, so both agreed on the wrong answer. DEK-aware
 * writers live outside that list: `src/lib/annotations.ts` seals
 * `<pod>/annotations/*.ttl`, and the Cascade Workbench seals every container it
 * owns (notes/, analysis/, literature/, reports/, sources/, investigations/).
 * `pod decrypt` skipped all of them, left them as ciphertext, and then deleted
 * settings/encryption.json, the only wrapped copy of the DEK.
 *
 * THE CANARY TEST is the first one below. It writes a marker string into a
 * sealed resource that the old allowlist could not see, runs the round trip, and
 * asserts the marker comes back readable. Against the pre-fix command that file
 * stays ciphertext and the key is gone, so the marker is unrecoverable and the
 * assertion fails.
 *
 * No real patient data appears here: every fixture is a synthetic marker string
 * or a hand-built byte sequence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';
import {
  resolveDek,
  writeResource,
  readResource,
  encryptBytes,
  generateDek,
  isPodEncrypted,
} from '../src/lib/pod-encryption.js';
import { enumeratePodResources, PLAINTEXT_BY_DESIGN } from '../src/lib/pod-resources.js';

const PASSPHRASE = 'roundtrip-test-passphrase';

/** Real Argon2id (t=3, m=64 MiB) runs on every init/encrypt/decrypt. */
const TEST_TIMEOUT_MS = 90_000;

/** The marker that must survive the round trip. Synthetic, not health data. */
const CANARY = 'CANARY-a1b2c3d4-must-survive-the-round-trip';

function buildProgram(): Command {
  const program = new Command();
  program
    .name('cascade')
    .exitOverride()
    .option('--verbose', 'Verbose output', false)
    .option('--json', 'Output JSON', false);
  registerPodCommand(program);
  return program;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const program = buildProgram();
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.map(String).join(' '));
  });
  const writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown): boolean => {
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

let tmpDirs: string[] = [];
function mkTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-roundtrip-'));
  tmpDirs.push(d);
  return d;
}

/** Read a file's raw bytes without any decryption. */
function rawBytes(p: string): Buffer {
  return fs.readFileSync(p);
}

/** Is the file on disk readable text containing this marker? */
function plainTextContains(p: string, needle: string): boolean {
  return rawBytes(p).toString('utf-8').includes(needle);
}

beforeEach(() => {
  process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;
});

afterEach(() => {
  delete process.env.CASCADE_POD_PASSPHRASE;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

describe('pod decrypt: the canary round trip (root BACKLOG 1.8)', () => {
  it('a resource sealed OUTSIDE the old allowlist survives encrypt -> decrypt', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    await runCli(['pod', 'init', dir, '--encrypt']);
    const dek = resolveDek(dir, PASSPHRASE);

    // 1. The real annotations writer, driven through its own command.
    //    `annotations/` is outside the old allowlist and `pod annotate`
    //    correctly seals what it writes, which is exactly the combination that
    //    made the data unrecoverable.
    const ann = await runCli([
      'pod', 'annotate', dir,
      '--record', 'urn:uuid:11111111-2222-3333-4444-555555555555',
      '--text', CANARY,
    ]);
    expect(ann.exitCode).toBe(0);

    // 2. What the desktop app's migrate_pod does to every container it owns.
    for (const rel of [
      'notes/manifest.json',
      'analysis/run-0001.ttl',
      'literature/cache.json',
      'reports/report-1.md',
      'investigations/index.json',
    ]) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      writeResource(p, `${CANARY} ${rel}`, dek);
    }

    // Precondition: sealed. The canary is NOT readable on disk anywhere.
    const annotationsFile = path.join(dir, 'annotations', 'annotations.ttl');
    expect(plainTextContains(annotationsFile, CANARY)).toBe(false);
    expect(plainTextContains(path.join(dir, 'notes', 'manifest.json'), CANARY)).toBe(false);

    // Round trip.
    const dec = await runCli(['pod', 'decrypt', dir]);
    expect(dec.exitCode).toBe(0);

    // The manifest is gone, so this is the only chance to read these files.
    expect(fs.existsSync(path.join(dir, 'settings', 'encryption.json'))).toBe(false);

    // THE CANARY. Pre-fix, every one of these is still ciphertext.
    expect(plainTextContains(annotationsFile, CANARY)).toBe(true);
    for (const rel of [
      'notes/manifest.json',
      'analysis/run-0001.ttl',
      'literature/cache.json',
      'reports/report-1.md',
      'investigations/index.json',
    ]) {
      expect(plainTextContains(path.join(dir, rel), CANARY)).toBe(true);
    }

    // And the count is not a lie: it covers the files outside the old allowlist.
    expect(dec.stdout).toMatch(/Resources decrypted: (1[0-9]|[2-9][0-9])/);
  }, TEST_TIMEOUT_MS);

  it('reports a resource count that matches the files it actually rewrote', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    await runCli(['pod', 'init', dir, '--encrypt']);
    const dek = resolveDek(dir, PASSPHRASE);
    writeResource(path.join(dir, 'index.ttl'), readResource(path.join(dir, 'index.ttl'), dek), dek);

    const { resources } = await enumeratePodResources(dir);
    const dec = await runCli(['--json', 'pod', 'decrypt', dir]);
    expect(dec.exitCode).toBe(0);
    const parsed = JSON.parse(dec.stdout);
    expect(parsed.resourcesDecrypted).toBe(resources.length);
    expect(parsed.plaintextByDesign).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);
});

describe('pod encrypt: walks the pod, not an allowlist (root BACKLOG 4.25)', () => {
  it('seals every container and leaves exactly the by-design plaintext files', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    delete process.env.CASCADE_POD_PASSPHRASE;
    await runCli(['pod', 'init', dir]);
    process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;

    for (const rel of [
      'notes/manifest.json',
      'analysis/run-0001.ttl',
      'sources/retained.txt',
      'reports/report-1.md',
      'provenance/audit-log.ttl',
      'annotations/amendments.ttl',
    ]) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, `${CANARY} ${rel}`, 'utf-8');
    }
    // Plaintext by design, and written by another process.
    const egress = path.join(dir, 'provenance', 'egress-log.jsonl');
    fs.writeFileSync(egress, '{"outcome":"sent"}\n', 'utf-8');
    // Not a pod resource: a dotfile and a VCS directory.
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk', 'utf-8');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');

    const enc = await runCli(['pod', 'encrypt', dir]);
    expect(enc.exitCode).toBe(0);

    for (const rel of [
      'notes/manifest.json',
      'analysis/run-0001.ttl',
      'sources/retained.txt',
      'reports/report-1.md',
      'provenance/audit-log.ttl',
      'annotations/amendments.ttl',
      '.well-known/solid',
      'index.ttl',
    ]) {
      expect(plainTextContains(path.join(dir, rel), CANARY)).toBe(false);
      expect(plainTextContains(path.join(dir, rel), '@prefix')).toBe(false);
    }

    // The three by-design plaintext files, untouched.
    expect(PLAINTEXT_BY_DESIGN).toEqual([
      'settings/encryption.json',
      'README.md',
      'provenance/egress-log.jsonl',
    ]);
    expect(rawBytes(egress).toString('utf-8')).toBe('{"outcome":"sent"}\n');
    expect(plainTextContains(path.join(dir, 'README.md'), 'Cascade Protocol Pod')).toBe(true);
    expect(JSON.parse(rawBytes(path.join(dir, 'settings', 'encryption.json')).toString('utf-8')).kdf)
      .toBe('argon2id');

    // Not-a-pod-resource entries are untouched.
    expect(rawBytes(path.join(dir, '.DS_Store')).toString('utf-8')).toBe('junk');
    expect(rawBytes(path.join(dir, '.git', 'HEAD')).toString('utf-8')).toBe('ref: refs/heads/main\n');
  }, TEST_TIMEOUT_MS);

  it('round-trips non-text bytes exactly (retained source documents)', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    delete process.env.CASCADE_POD_PASSPHRASE;
    await runCli(['pod', 'init', dir]);
    process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;

    // A byte sequence that is NOT valid UTF-8 and is longer than an envelope, so
    // a string round trip would replace bytes with U+FFFD and destroy it.
    const binary = Buffer.concat([
      Buffer.from('%PDF-1.4\n', 'ascii'),
      Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81, 0xc0, 0xc1, 0xf5, 0xf6, 0xf7, 0xf8]),
      Buffer.from(CANARY, 'ascii'),
      Buffer.from([0x00, 0xff, 0x00, 0xff]),
    ]);
    const binPath = path.join(dir, 'sources', 'retained.pdf');
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, binary);

    expect((await runCli(['pod', 'encrypt', dir])).exitCode).toBe(0);
    expect(rawBytes(binPath).equals(binary)).toBe(false);

    expect((await runCli(['pod', 'decrypt', dir])).exitCode).toBe(0);
    expect(rawBytes(binPath).equals(binary)).toBe(true);
  }, TEST_TIMEOUT_MS);
});

describe('pod decrypt: order of operations and idempotency', () => {
  it('refuses, keeps the manifest, and writes NOTHING when a file will not open', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    await runCli(['pod', 'init', dir, '--encrypt']);
    const dek = resolveDek(dir, PASSPHRASE);
    fs.mkdirSync(path.join(dir, 'analysis'), { recursive: true });
    writeResource(path.join(dir, 'analysis', 'run-0001.ttl'), CANARY, dek);

    // Sealed under a DIFFERENT key: neither this pod's ciphertext nor text.
    const foreignPath = path.join(dir, 'analysis', 'foreign.bin');
    fs.writeFileSync(foreignPath, encryptBytes(Buffer.from('other-pod-secret'), generateDek()));
    const foreignBefore = rawBytes(foreignPath);
    const indexBefore = rawBytes(path.join(dir, 'index.ttl'));

    const dec = await runCli(['pod', 'decrypt', dir]);
    expect(dec.exitCode).toBe(1);
    expect(dec.stderr).toContain('analysis/foreign.bin');

    // The wrapped DEK is still there, so nothing is lost.
    expect(isPodEncrypted(dir)).toBe(true);
    // And not one file was rewritten: the refusal happens before any write.
    expect(rawBytes(path.join(dir, 'index.ttl')).equals(indexBefore)).toBe(true);
    expect(rawBytes(foreignPath).equals(foreignBefore)).toBe(true);
    expect(plainTextContains(path.join(dir, 'analysis', 'run-0001.ttl'), CANARY)).toBe(false);

    // The pod is still fully usable, which is the point of keeping the manifest.
    expect(readResource(path.join(dir, 'analysis', 'run-0001.ttl'), dek)).toBe(CANARY);
  }, TEST_TIMEOUT_MS);

  it('--force decrypts the rest, leaves the unopenable file alone, and warns', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    await runCli(['pod', 'init', dir, '--encrypt']);
    const dek = resolveDek(dir, PASSPHRASE);
    fs.mkdirSync(path.join(dir, 'analysis'), { recursive: true });
    writeResource(path.join(dir, 'analysis', 'run-0001.ttl'), CANARY, dek);
    const foreignPath = path.join(dir, 'analysis', 'foreign.bin');
    fs.writeFileSync(foreignPath, encryptBytes(Buffer.from('other-pod-secret'), generateDek()));
    const foreignBefore = rawBytes(foreignPath);

    const dec = await runCli(['--json', 'pod', 'decrypt', dir, '--force']);
    expect(dec.exitCode).toBe(0);
    expect(dec.stderr).toContain('analysis/foreign.bin');
    expect(plainTextContains(path.join(dir, 'analysis', 'run-0001.ttl'), CANARY)).toBe(true);
    expect(rawBytes(foreignPath).equals(foreignBefore)).toBe(true);
    expect(JSON.parse(dec.stdout).leftEncrypted).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('is idempotent: residual plaintext is left alone and counted, not double-handled', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    await runCli(['pod', 'init', dir, '--encrypt']);
    // The 4.25 shape: a pod that reports itself encrypted while a container the
    // old allowlist never saw still holds plaintext.
    const residual = path.join(dir, 'reports', 'report-1.md');
    fs.mkdirSync(path.dirname(residual), { recursive: true });
    fs.writeFileSync(residual, `# Report\n\n${CANARY}\n`, 'utf-8');

    const dec = await runCli(['--json', 'pod', 'decrypt', dir]);
    expect(dec.exitCode).toBe(0);
    const parsed = JSON.parse(dec.stdout);
    expect(parsed.alreadyPlaintext).toBe(1);
    expect(fs.readFileSync(residual, 'utf-8')).toBe(`# Report\n\n${CANARY}\n`);

    // Re-running on a now-plaintext pod is a clean refusal, not a second pass.
    const again = await runCli(['pod', 'decrypt', dir]);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain('not encrypted');
  }, TEST_TIMEOUT_MS);

  it('a wrong passphrase never reaches the manifest', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    await runCli(['pod', 'init', dir, '--encrypt']);
    process.env.CASCADE_POD_PASSPHRASE = 'definitely-wrong';
    const dec = await runCli(['pod', 'decrypt', dir]);
    expect(dec.exitCode).toBe(1);
    expect(isPodEncrypted(dir)).toBe(true);
  }, TEST_TIMEOUT_MS);
});
