/**
 * The one safety property of `pod doctor` that a healthy run never exercises:
 * READ THE REPAIR BACK, and put the original returned if it does not verify.
 *
 * Every other property is visible on the happy path. This one only fires when a
 * write goes wrong — a short write, a filesystem that lied about the rename, a
 * key that no longer opens what it just sealed — and code that only runs on a
 * bad day is code nobody has ever seen run. So the bad day is injected here:
 * `atomicWriteBytes` is stubbed to put DIFFERENT bytes on disk than doctor asked
 * it to, and the whole recovery is then real. Doctor's own read-back, its own
 * strict parse, its own restore-from-backup.
 *
 * The mock is why this lives in its own file: `vi.mock` is module-scoped, and
 * every other doctor test needs the real writer.
 *
 * All fixtures are synthetic and PHI-free.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { BACKUP_SUFFIX, type DoctorReport } from '../src/lib/pod-doctor.js';

/**
 * Corrupt exactly one write, on demand. Everything else in the module — the
 * plaintext/ciphertext classifier doctor uses to spot an unkeyed sealed pod
 * included — stays real.
 */
const corruptNextWrite = { armed: false };

vi.mock('../src/lib/pod-resources.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/pod-resources.js')>();
  return {
    ...actual,
    atomicWriteBytes: (absPath: string, bytes: Buffer): void => {
      actual.atomicWriteBytes(
        absPath,
        corruptNextWrite.armed ? Buffer.from('this is not Turtle at all ;;; }{\n', 'utf-8') : bytes,
      );
    },
  };
});

const TEST_TIMEOUT_MS = 60_000;

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
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    out.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  process.exitCode = 0;
  try {
    await program.parseAsync(['node', 'cascade', ...args]);
  } catch {
    /* exitOverride throws; exitCode carries the failure */
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-doctor-verify-'));
  tmpDirs.push(d);
  return d;
}

beforeEach(() => {
  tmpDirs = [];
  corruptNextWrite.armed = false;
});
afterEach(() => {
  corruptNextWrite.armed = false;
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs = [];
});

const RXNORM_BUNDLE = JSON.stringify({
  resourceType: 'Bundle',
  type: 'collection',
  entry: [
    {
      resource: {
        resourceType: 'MedicationStatement',
        id: 'm1',
        status: 'active',
        medicationCodeableConcept: {
          coding: [
            {
              system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
              code: '860975',
              display: 'Metformin 500 MG',
            },
          ],
        },
        subject: { reference: 'Patient/p1' },
      },
    },
  ],
});

/** An imported pod whose medications bucket has had its `@prefix` block deleted. */
async function damagedPod(): Promise<{ podDir: string; medsPath: string; damaged: Buffer }> {
  const base = mkTmpDir();
  const podDir = path.join(base, 'pod');
  const bundle = path.join(base, 'bundle.json');
  fs.writeFileSync(bundle, RXNORM_BUNDLE, 'utf-8');
  expect((await runCli(['pod', 'init', podDir])).exitCode).toBe(0);
  expect((await runCli(['pod', 'import', podDir, bundle])).exitCode).toBe(0);

  const medsPath = path.join(podDir, 'clinical', 'medications.ttl');
  const text = fs.readFileSync(medsPath, 'utf-8');
  expect(text).toContain('rxnorm:860975');
  fs.writeFileSync(
    medsPath,
    text.split('\n').filter((l) => !l.trimStart().startsWith('@prefix')).join('\n'),
    'utf-8',
  );
  return { podDir, medsPath, damaged: fs.readFileSync(medsPath) };
}

async function doctorJson(args: string[]): Promise<{ report: DoctorReport; exitCode: number }> {
  const r = await runCli(['--json', 'pod', 'doctor', ...args]);
  const start = r.stdout.indexOf('{');
  expect(start, `no JSON in doctor output: ${r.stdout}`).toBeGreaterThanOrEqual(0);
  return {
    report: JSON.parse(r.stdout.slice(start, r.stdout.lastIndexOf('}') + 1)) as DoctorReport,
    exitCode: r.exitCode,
  };
}

describe('a repair that does not read back is undone', () => {
  it(
    'restores the original from the backup and reports the failure',
    async () => {
      const { podDir, medsPath, damaged } = await damagedPod();

      corruptNextWrite.armed = true;
      const r = await doctorJson([podDir, '--write']);

      // The write happened and was rejected: not repaired, and said so.
      expect(r.report.repaired).toBe(0);
      expect(r.report.refused).toBe(1);
      expect(r.exitCode).toBe(1);
      const finding = r.report.findings[0];
      expect(finding.file).toBe('clinical/medications.ttl');
      expect(finding.damage).toBe('write-verify-failed');
      expect(finding.nextStep).toMatch(/restored/i);

      // THE POINT: the file on disk is the original, byte for byte. Not the
      // corrupt bytes, and not a half-repair.
      expect(
        fs.readFileSync(medsPath).equals(damaged),
        'the corrupt write was left on disk',
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the control: the same run with the write left alone repairs normally',
    async () => {
      // Without this the test above passes just as well against a doctor that
      // never writes anything at all.
      const { podDir, medsPath, damaged } = await damagedPod();

      corruptNextWrite.armed = false;
      const r = await doctorJson([podDir, '--write']);

      expect(r.report.repaired).toBe(1);
      expect(r.exitCode).toBe(0);
      const repaired = fs.readFileSync(medsPath, 'utf-8');
      expect(repaired.endsWith(damaged.toString('utf-8'))).toBe(true);
      expect(repaired.length).toBeGreaterThan(damaged.length);
      expect(fs.existsSync(medsPath + BACKUP_SUFFIX)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
