/**
 * Regression tests for root BACKLOG 1.9: on an encrypted pod, reconciliation
 * conflicts silently reported as zero, and every import wrote conflict metadata
 * back in plaintext.
 *
 * `settings/` is inside the encrypted set, so `settings/pending-conflicts.ttl`
 * is ciphertext on a sealed pod. `src/lib/user-resolutions.ts` had no DEK
 * awareness in either direction, and both loaders sat behind bare catches, so:
 *
 *   - the Turtle parse failed on ciphertext and was swallowed into an empty
 *     list, and `pod conflicts` printed "No unresolved conflicts", exit 0,
 *     indistinguishable from a genuinely clean pod;
 *   - `writePendingConflicts` wrote plaintext back into a sealed pod on every
 *     import that reconciled.
 *
 * The tests below hold a real conflict on a real encrypted pod and assert it is
 * still reported as a conflict. Against the pre-fix module they report zero.
 *
 * Fixtures are synthetic. The "sources" are invented system names and the
 * record IRIs are minted here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';
import {
  writePendingConflicts,
  loadPendingConflicts,
  loadUserResolutions,
  saveUserResolution,
  ConflictStoreError,
  type PendingConflict,
} from '../src/lib/user-resolutions.js';
import { resolveDek, writeResource } from '../src/lib/pod-encryption.js';

const PASSPHRASE = 'conflict-store-test-passphrase';
const TEST_TIMEOUT_MS = 90_000;

/** A synthetic conflict. The marker proves whether the file is sealed. */
const CONFLICT_MARKER = 'Synthetic-Source-System-QQ';

function conflictFixture(): PendingConflict {
  return {
    uri: 'urn:uuid:99999999-8888-7777-6666-555555555555',
    conflictId: 'health:ConditionRecord::synthetic-match-key',
    recordType: 'health:ConditionRecord',
    detectedAt: new Date('2026-07-25T00:00:00.000Z'),
    candidateRecordUris: [
      'urn:uuid:aaaaaaaa-0000-0000-0000-000000000001',
      'urn:uuid:aaaaaaaa-0000-0000-0000-000000000002',
    ],
    sourceA: CONFLICT_MARKER,
    sourceB: `${CONFLICT_MARKER}-B`,
  };
}

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

/**
 * `pod conflicts` and `pod resolve` call `process.exit`, which vitest cannot
 * survive, so it is stubbed into a throw and the code is recovered from it.
 */
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

  class ProcessExit extends Error {
    constructor(readonly code: number) {
      super(`process.exit(${code})`);
    }
  }
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExit(code ?? 0);
  }) as never);

  process.exitCode = 0;
  let exitCode: number | undefined;
  try {
    await program.parseAsync(['node', 'cascade', ...args]);
  } catch (e) {
    if (e instanceof ProcessExit) {
      exitCode = e.code;
    } else {
      throw e;
    }
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  }
  const resolved = exitCode ?? (typeof process.exitCode === 'number' ? process.exitCode : 0);
  process.exitCode = 0;
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode: resolved };
}

let tmpDirs: string[] = [];
function mkTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-conflicts-'));
  tmpDirs.push(d);
  return d;
}

/** An encrypted pod with one pending conflict correctly sealed inside it. */
async function encryptedPodWithConflict(): Promise<{ dir: string; dek: Buffer }> {
  const dir = path.join(mkTmpDir(), 'pod');
  await runCli(['pod', 'init', dir, '--encrypt']);
  const dek = resolveDek(dir, PASSPHRASE);
  await writePendingConflicts(dir, [conflictFixture()], dek);
  return { dir, dek };
}

function conflictsPath(dir: string): string {
  return path.join(dir, 'settings', 'pending-conflicts.ttl');
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

describe('pod conflicts on an encrypted pod (root BACKLOG 1.9)', () => {
  it('a real conflict in a sealed pod is still reported as a conflict', async () => {
    const { dir } = await encryptedPodWithConflict();

    // The file really is sealed: the marker is not readable on disk.
    const onDisk = fs.readFileSync(conflictsPath(dir)).toString('utf-8');
    expect(onDisk).not.toContain(CONFLICT_MARKER);
    expect(onDisk).not.toContain('@prefix');

    // Text mode: 1 conflict, exit 1. Pre-fix this was "No unresolved
    // conflicts" and exit 0.
    const text = await runCli(['pod', 'conflicts', dir]);
    expect(text.exitCode).toBe(1);
    expect(text.stdout).toContain('1 unresolved conflict');
    expect(text.stdout).toContain('health:ConditionRecord');
    expect(text.stdout).not.toContain('No unresolved conflicts');

    // JSON mode carries the same answer.
    const json = await runCli(['pod', 'conflicts', dir, '--format', 'json']);
    const parsed = JSON.parse(json.stdout);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sourceA).toBe(CONFLICT_MARKER);
  }, TEST_TIMEOUT_MS);

  it('without a passphrase it says it could not read, rather than reporting zero', async () => {
    const { dir } = await encryptedPodWithConflict();
    delete process.env.CASCADE_POD_PASSPHRASE;

    const res = await runCli(['pod', 'conflicts', dir]);
    // Exit 2 is distinct from 0 (none) and 1 (conflicts present).
    expect(res.exitCode).toBe(2);
    expect(res.stdout).not.toContain('No unresolved conflicts');
    expect(res.stderr).toMatch(/encrypted|passphrase/i);
  }, TEST_TIMEOUT_MS);

  it('a wrong passphrase says it could not read, rather than reporting zero', async () => {
    const { dir } = await encryptedPodWithConflict();
    process.env.CASCADE_POD_PASSPHRASE = 'definitely-wrong';

    const res = await runCli(['pod', 'conflicts', dir]);
    expect(res.exitCode).toBe(2);
    expect(res.stdout).not.toContain('No unresolved conflicts');
  }, TEST_TIMEOUT_MS);

  it('a corrupt conflicts file on a PLAINTEXT pod is an error, not an empty list', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    delete process.env.CASCADE_POD_PASSPHRASE;
    await runCli(['pod', 'init', dir]);
    fs.writeFileSync(conflictsPath(dir), 'this is { not ] valid turtle @@@', 'utf-8');

    const res = await runCli(['pod', 'conflicts', dir]);
    expect(res.exitCode).toBe(2);
    expect(res.stdout).not.toContain('No unresolved conflicts');
    expect(res.stderr).toContain('NOT the same as having no conflicts');
  }, TEST_TIMEOUT_MS);

  it('an absent file is still a legitimate empty list', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    delete process.env.CASCADE_POD_PASSPHRASE;
    await runCli(['pod', 'init', dir]);
    expect(fs.existsSync(conflictsPath(dir))).toBe(false);

    const res = await runCli(['pod', 'conflicts', dir]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('No unresolved conflicts');
  }, TEST_TIMEOUT_MS);
});

describe('the conflict store writes into a sealed pod as ciphertext', () => {
  it('pod import into an encrypted pod does not drop a plaintext conflicts file', async () => {
    const root = mkTmpDir();
    const dir = path.join(root, 'pod');
    await runCli(['pod', 'init', dir, '--encrypt']);

    // Two bundles describing the same patient force reconciliation to run, which
    // is what calls writePendingConflicts unconditionally.
    const bundle = (id: string, given: string) => JSON.stringify({
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            id,
            name: [{ given: [given], family: 'Testcase' }],
            gender: 'female',
            birthDate: '1985-04-12',
          },
        },
      ],
    });
    const aPath = path.join(root, 'a.json');
    const bPath = path.join(root, 'b.json');
    fs.writeFileSync(aPath, bundle('p-1', 'Testy'));
    fs.writeFileSync(bPath, bundle('p-2', 'Testina'));

    const imp = await runCli(['pod', 'import', dir, aPath, bPath]);
    expect(imp.exitCode).toBe(0);

    // Whatever reconciliation decided, the file it wrote must be ciphertext.
    if (fs.existsSync(conflictsPath(dir))) {
      const raw = fs.readFileSync(conflictsPath(dir)).toString('utf-8');
      expect(raw).not.toContain('@prefix');
      expect(raw).not.toContain('PendingConflict');
      // And it reads back through the DEK.
      const dek = resolveDek(dir, PASSPHRASE);
      await expect(loadPendingConflicts(dir, dek)).resolves.toBeInstanceOf(Array);
    }
  }, TEST_TIMEOUT_MS);

  it('pod resolve round-trips on an encrypted pod and seals what it writes', async () => {
    const { dir, dek } = await encryptedPodWithConflict();

    const res = await runCli([
      '--json', 'pod', 'resolve', dir,
      '--conflict', 'health:ConditionRecord::synthetic-match-key',
      '--keep', 'source-a',
    ]);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).remainingConflicts).toBe(0);

    // The decision file is sealed, and reads back through the DEK.
    const resolutionsPath = path.join(dir, 'settings', 'user-resolutions.ttl');
    const raw = fs.readFileSync(resolutionsPath).toString('utf-8');
    expect(raw).not.toContain('@prefix');
    expect(raw).not.toContain('UserResolution');
    const stored = await loadUserResolutions(dir, dek);
    expect(stored.get('health:ConditionRecord::synthetic-match-key')?.resolution)
      .toBe('kept-source-a');

    // And the conflict is gone from the pending list, still sealed.
    const after = await runCli(['pod', 'conflicts', dir]);
    expect(after.exitCode).toBe(0);
    expect(after.stdout).toContain('No unresolved conflicts');
  }, TEST_TIMEOUT_MS);
});

describe('the loaders throw instead of swallowing', () => {
  it('loadPendingConflicts on a sealed file with no DEK throws ConflictStoreError', async () => {
    const { dir } = await encryptedPodWithConflict();
    await expect(loadPendingConflicts(dir)).rejects.toBeInstanceOf(ConflictStoreError);
  }, TEST_TIMEOUT_MS);

  it('loadUserResolutions on a sealed file with no DEK throws ConflictStoreError', async () => {
    const { dir, dek } = await encryptedPodWithConflict();
    await saveUserResolution(dir, {
      uri: 'urn:uuid:bbbbbbbb-0000-0000-0000-000000000001',
      conflictId: 'health:ConditionRecord::synthetic-match-key',
      resolvedAt: new Date('2026-07-25T00:00:00.000Z'),
      resolution: 'kept-source-a',
      keptRecordUri: 'urn:uuid:aaaaaaaa-0000-0000-0000-000000000001',
      discardedRecordUris: [],
    }, dek);

    await expect(loadUserResolutions(dir)).rejects.toBeInstanceOf(ConflictStoreError);
    // With the key, the decision is there. It was never lost, only unreadable.
    await expect(loadUserResolutions(dir, dek)).resolves.toHaveProperty('size', 1);
  }, TEST_TIMEOUT_MS);

  it('an unparseable decrypted body throws rather than forgetting the decisions', async () => {
    const { dir, dek } = await encryptedPodWithConflict();
    // Correctly sealed, but the plaintext inside is not Turtle.
    writeResource(conflictsPath(dir), 'not ] turtle @@@ {', dek);
    await expect(loadPendingConflicts(dir, dek)).rejects.toBeInstanceOf(ConflictStoreError);
  }, TEST_TIMEOUT_MS);
});
