/**
 * Symbolic links are never followed inside a pod (pod encryption
 * specification, sections 4.1 and 8).
 *
 * A pod is a folder anyone can hand to a person, so its STRUCTURE is input too.
 * A record file or a container folder that is a link leads a plain
 * `path.join(pod, 'clinical', 'medications.ttl')` to anywhere on the disk while
 * every component still reads as an ordinary name. The rules pinned here:
 *
 *  - reads: a record file or container that is a link is refused, never read
 *    through, so another folder's records are never returned as the pod's;
 *  - writes: nothing is written, and no folder is created, through a link, so
 *    a write never lands outside the pod;
 *  - `settings` that is a link makes the pod encrypted, and its header is then
 *    refused, so such a pod reads as locked rather than as plaintext;
 *  - the pod ROOT, and anything above it, may be a link, and that keeps
 *    working (a pods folder moved to another disk; `/tmp` on macOS).
 *
 * All fixtures are synthetic and PHI-free.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';
import {
  PodPathError,
  mkdirInPod,
  readPodFile,
  resolveInPod,
  writePodFile,
  atomicWritePodFile,
} from '../src/lib/pod-path.js';
import {
  buildPassphraseManifest,
  generateDek,
  isPodEncrypted,
  readResource,
  writeEncryptionManifest,
  writeResource,
} from '../src/lib/pod-encryption.js';
import { mergeIntoBucket } from '../src/lib/bucket-write.js';

const TEST_TIMEOUT_MS = 60_000;
const PASSPHRASE = 'path-safety-passphrase';
const FAST_KDF = { t: 1, m: 64, p: 1 };

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

/** Run one CLI invocation in process, capturing stdout, stderr and the exit code. */
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
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    out.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  process.exitCode = 0;
  let thrown: unknown;
  try {
    await program.parseAsync(['node', 'cascade', ...args]);
  } catch (e) {
    thrown = e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
  }
  let exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  if (thrown !== undefined && exitCode === 0) {
    exitCode = 1;
    err.push(thrown instanceof Error ? thrown.message : String(thrown));
  }
  process.exitCode = 0;
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
}

/** A Patient and one MedicationStatement. */
function syntheticBundle(): string {
  return JSON.stringify({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'Patient',
          id: 'pat-1',
          name: [{ given: ['Linka'], family: 'Pathson' }],
          gender: 'female',
          birthDate: '1980-03-03',
        },
      },
      {
        resource: {
          resourceType: 'MedicationStatement',
          id: 'med-1',
          status: 'active',
          medicationCodeableConcept: {
            coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '197361', display: 'Lisinopril 10 MG' }],
            text: 'Lisinopril 10 MG',
          },
          subject: { reference: 'Patient/pat-1' },
        },
      },
    ],
  });
}

let root: string;
/** A plaintext pod holding one medication, built once. */
let plainPod: string;
let bundle: string;
let counter = 0;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-path-safety-')));
  plainPod = path.join(root, 'plain-pod');
  expect((await runCli(['pod', 'init', plainPod])).exitCode).toBe(0);
  bundle = path.join(root, 'bundle.json');
  fs.writeFileSync(bundle, syntheticBundle(), 'utf-8');
  const imported = await runCli(['pod', 'import', plainPod, bundle]);
  expect(imported.exitCode).toBe(0);
  expect(fs.readFileSync(path.join(plainPod, 'clinical', 'medications.ttl'), 'utf-8')).toContain('Lisinopril');
}, TEST_TIMEOUT_MS);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.CASCADE_POD_PASSPHRASE;
});

/** A fresh case folder holding a copy of the plaintext pod and an OUTSIDE copy. */
function caseDirs(): { pod: string; outside: string } {
  counter += 1;
  const dir = path.join(root, `case-${counter}`);
  const pod = path.join(dir, 'pod');
  const outside = path.join(dir, 'outside');
  fs.cpSync(plainPod, pod, { recursive: true });
  fs.cpSync(plainPod, outside, { recursive: true });
  return { pod, outside };
}

/** Every file below `dir` with its bytes, so "nothing outside changed" is checked, not assumed. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(path.relative(dir, full), fs.readFileSync(full).toString('base64'));
    }
  };
  walk(dir);
  return out;
}

// ─── The chokepoint itself ────────────────────────────────────────────────────

describe('resolveInPod', () => {
  it('resolves ordinary paths, pod-relative or absolute, to a path under the pod', () => {
    const { pod } = caseDirs();
    expect(resolveInPod(pod, 'clinical/medications.ttl')).toBe(path.join(pod, 'clinical', 'medications.ttl'));
    expect(resolveInPod(pod, path.join(pod, 'clinical', 'medications.ttl'))).toBe(
      path.join(pod, 'clinical', 'medications.ttl'),
    );
    // A path that does not exist yet resolves too: a write creates it.
    expect(resolveInPod(pod, 'notes/new/file.ttl')).toBe(path.join(pod, 'notes', 'new', 'file.ttl'));
  });

  it('refuses ".." and a path outside the pod', () => {
    const { pod } = caseDirs();
    expect(() => resolveInPod(pod, 'clinical/../../x')).toThrow(PodPathError);
    expect(() => resolveInPod(pod, '../x')).toThrow(/unsafe pod path/);
    expect(() => resolveInPod(pod, path.join(pod, '..', 'outside', 'x'))).toThrow(/outside the pod/);
  });

  it('refuses a record file, a container folder, and a dangling link', () => {
    const { pod, outside } = caseDirs();
    fs.rmSync(path.join(pod, 'clinical', 'medications.ttl'));
    fs.symlinkSync(path.join(outside, 'clinical', 'medications.ttl'), path.join(pod, 'clinical', 'medications.ttl'));
    fs.symlinkSync(path.join(outside, 'clinical'), path.join(pod, 'notes'), 'dir');
    fs.symlinkSync(path.join(outside, 'nothing-here'), path.join(pod, 'dangling.ttl'));

    for (const rel of ['clinical/medications.ttl', 'notes', 'notes/medications.ttl', 'notes/new.ttl', 'dangling.ttl']) {
      let err: unknown;
      try {
        resolveInPod(pod, rel);
      } catch (e) {
        err = e;
      }
      expect(err, rel).toBeInstanceOf(PodPathError);
      expect((err as PodPathError).reason, rel).toBe('symlink-in-pod');
    }
  });

  it('accepts a pod ROOT, and an ancestor of it, that is a link: reads and writes still work', () => {
    const { pod } = caseDirs();
    const viaRoot = path.join(path.dirname(pod), 'pod-link');
    fs.symlinkSync(pod, viaRoot, 'dir');
    const parentLink = path.join(root, `parent-link-${counter}`);
    fs.symlinkSync(path.dirname(pod), parentLink, 'dir');
    const viaParent = path.join(parentLink, 'pod');

    for (const podDir of [viaRoot, viaParent]) {
      expect(readPodFile(podDir, 'clinical/medications.ttl').toString('utf-8')).toContain('Lisinopril');
      writePodFile(podDir, 'notes-root-link.txt', 'hello');
      mkdirInPod(podDir, 'analysis/deep');
      atomicWritePodFile(podDir, 'analysis/deep/a.txt', Buffer.from('a'));
      expect(readResource(podDir, path.join(podDir, 'analysis', 'deep', 'a.txt'))).toBe('a');
    }
    expect(fs.readFileSync(path.join(pod, 'notes-root-link.txt'), 'utf-8')).toBe('hello');
  });

  it('refuses a FIFO as a file, without blocking', () => {
    const { pod } = caseDirs();
    const fifo = path.join(pod, 'clinical', 'fifo.ttl');
    const made = spawnSync('mkfifo', [fifo]);
    if (made.status !== 0) return; // no mkfifo on this platform
    expect(() => readPodFile(pod, 'clinical/fifo.ttl')).toThrow(/not a regular file/);
    expect(() => writePodFile(pod, 'clinical/fifo.ttl', 'x')).toThrow(/not a regular file/);
  });
});

// ─── Reads ────────────────────────────────────────────────────────────────────

describe('reads never follow a link inside the pod', () => {
  it('pod query refuses a record FILE that is a link out of the pod', async () => {
    const { pod, outside } = caseDirs();
    const meds = path.join(pod, 'clinical', 'medications.ttl');
    fs.rmSync(meds);
    fs.symlinkSync(path.join(outside, 'clinical', 'medications.ttl'), meds);

    const res = await runCli(['--json', 'pod', 'query', pod, '--medications']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).not.toContain('Lisinopril');
    expect(res.stderr).toContain('symbolic link');
    expect(res.stderr).toContain('clinical/medications.ttl');
  });

  it('pod query refuses a container FOLDER that is a link out of the pod', async () => {
    const { pod, outside } = caseDirs();
    fs.rmSync(path.join(pod, 'clinical'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'clinical'), path.join(pod, 'clinical'), 'dir');

    const res = await runCli(['--json', 'pod', 'query', pod, '--medications']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).not.toContain('Lisinopril');
  });

  it(
    'an ENCRYPTED pod refuses a linked record file too (the link target is a valid sealed copy)',
    async () => {
      counter += 1;
      const dir = path.join(root, `case-${counter}`);
      const pod = path.join(dir, 'pod');
      const outside = path.join(dir, 'outside');
      fs.mkdirSync(path.join(pod, 'clinical'), { recursive: true });
      fs.mkdirSync(path.join(outside, 'clinical'), { recursive: true });
      const dek = generateDek();
      writeEncryptionManifest(pod, buildPassphraseManifest(dek, PASSPHRASE, FAST_KDF));
      const text = fs.readFileSync(path.join(plainPod, 'clinical', 'medications.ttl'), 'utf-8');
      writeResource(pod, path.join(pod, 'index.ttl'), fs.readFileSync(path.join(plainPod, 'index.ttl'), 'utf-8'), dek);
      // The sealed copy outside opens under THIS pod's key: only the link stops it.
      writeResource(outside, path.join(outside, 'clinical', 'medications.ttl'), text, dek);
      fs.symlinkSync(path.join(outside, 'clinical', 'medications.ttl'), path.join(pod, 'clinical', 'medications.ttl'));

      process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;
      const res = await runCli(['--json', 'pod', 'query', pod, '--medications']);
      expect(res.exitCode).not.toBe(0);
      expect(res.stdout).not.toContain('Lisinopril');
    },
    TEST_TIMEOUT_MS,
  );
});

// ─── Writes ───────────────────────────────────────────────────────────────────

describe('writes never land outside the pod', () => {
  it('pod import refuses to write into a container folder that is a link, and nothing outside changes', async () => {
    const { pod, outside } = caseDirs();
    fs.rmSync(path.join(pod, 'clinical'), { recursive: true });
    const target = path.join(outside, 'elsewhere');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(pod, 'clinical'), 'dir');
    const before = snapshot(outside);

    const res = await runCli(['pod', 'import', pod, bundle]);
    expect(res.exitCode).not.toBe(0);
    expect(snapshot(outside)).toEqual(before);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('pod import refuses to write through a record file that is a link, and the target is unchanged', async () => {
    const { pod, outside } = caseDirs();
    const meds = path.join(pod, 'clinical', 'medications.ttl');
    fs.rmSync(meds);
    fs.symlinkSync(path.join(outside, 'clinical', 'medications.ttl'), meds);
    const before = snapshot(outside);

    const res = await runCli(['pod', 'import', pod, bundle]);
    expect(res.exitCode).not.toBe(0);
    expect(snapshot(outside)).toEqual(before);
    expect(fs.lstatSync(meds).isSymbolicLink()).toBe(true);
  });

  it('the bucket writer refuses a linked file, and a DANGLING link it would otherwise create through', async () => {
    const { pod, outside } = caseDirs();
    const dangling = path.join(pod, 'clinical', 'new-bucket.ttl');
    const wouldBe = path.join(outside, 'created-through-link.ttl');
    fs.symlinkSync(wouldBe, dangling);

    await expect(mergeIntoBucket(pod, dangling, [], undefined)).rejects.toThrow(PodPathError);
    expect(fs.existsSync(wouldBe)).toBe(false);
  });

  it('no folder is created through a link: mkdirInPod refuses before creating anything', () => {
    const { pod, outside } = caseDirs();
    const target = path.join(outside, 'empty');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(pod, 'wellness-link'), 'dir');

    expect(() => mkdirInPod(pod, 'wellness-link/a/b')).toThrow(PodPathError);
    expect(() => writePodFile(pod, 'wellness-link/x.ttl', 'x')).toThrow(PodPathError);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('pod export refuses a pod holding a link, and writes no export', async () => {
    const { pod, outside } = caseDirs();
    fs.symlinkSync(outside, path.join(pod, 'notes'), 'dir');
    const out = path.join(path.dirname(pod), 'export-out');

    const res = await runCli(['--json', 'pod', 'export', pod, '--format', 'directory', '--output', out]);
    expect(res.exitCode).toBe(2);
    expect(JSON.parse(res.stderr.trim().split('\n').pop() as string).reason).toBe('symlink-in-pod');
    expect(fs.existsSync(out)).toBe(false);
  });
});

// ─── The header: `settings` that is a link ────────────────────────────────────

describe('a settings folder that is a link makes the pod encrypted and locked', () => {
  it('with no header behind it: encrypted, and the header is refused as malformed', async () => {
    const { pod, outside } = caseDirs();
    fs.rmSync(path.join(pod, 'settings'), { recursive: true });
    const elsewhere = path.join(outside, 'settings-elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(pod, 'settings'), 'dir');

    expect(isPodEncrypted(pod)).toBe(true);

    process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;
    const info = await runCli(['--json', 'pod', 'info', pod]);
    expect(info.exitCode).toBe(2);
    expect(JSON.parse(info.stderr.trim().split('\n').pop() as string).reason).toBe('manifest-malformed');

    // And a writer does not treat it as a plaintext pod to store plaintext into.
    const before = snapshot(outside);
    const imported = await runCli(['pod', 'import', pod, bundle]);
    expect(imported.exitCode).not.toBe(0);
    expect(snapshot(outside)).toEqual(before);
  });
});
