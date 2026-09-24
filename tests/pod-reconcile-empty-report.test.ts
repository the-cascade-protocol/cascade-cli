/**
 * `pod reconcile --report <file>` writes the report file on a pod that holds no
 * reconcilable records, plain and encrypted, with the same JSON the `--json`
 * run prints.
 *
 * The empty-pod branch used to print its report and return before the
 * `--report` write further down, so the file was never created and a caller
 * could not tell an empty pod from a failed run.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';

const PASSPHRASE = 'reconcile-empty-report-test';

async function runCli(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const program = new Command();
  program
    .name('cascade')
    .exitOverride()
    .option('--verbose', 'Verbose output', false)
    .option('--json', 'Output JSON', false);
  registerPodCommand(program);

  const out: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
  return { stdout: out.join('\n'), exitCode };
}

const dirs: string[] = [];
const savedEnv = process.env.CASCADE_POD_PASSPHRASE;
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.CASCADE_POD_PASSPHRASE;
  else process.env.CASCADE_POD_PASSPHRASE = savedEnv;
});

async function emptyPod(encrypted: boolean): Promise<{ podDir: string; reportFile: string }> {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-reconcile-empty-'));
  dirs.push(d);
  const podDir = path.join(d, 'pod');
  if (encrypted) process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;
  const init = await runCli(['pod', 'init', ...(encrypted ? ['--encrypt'] : []), podDir]);
  expect(init.exitCode).toBe(0);
  return { podDir, reportFile: path.join(d, 'report.json') };
}

describe('pod reconcile --report on a pod with no reconcilable records', () => {
  for (const encrypted of [false, true]) {
    const kind = encrypted ? 'encrypted' : 'plain';

    it(`writes the report file with the same JSON as stdout (${kind})`, async () => {
      const { podDir, reportFile } = await emptyPod(encrypted);
      if (encrypted) expect(fs.existsSync(path.join(podDir, 'settings', 'encryption.json'))).toBe(true);

      const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--report', reportFile]);
      expect(r.exitCode).toBe(0);
      const printed = JSON.parse(r.stdout) as { recordsBefore: number; applied: boolean };
      // The empty-pod branch, not the general one.
      expect(printed.recordsBefore).toBe(0);
      expect(printed.applied).toBe(false);

      expect(fs.existsSync(reportFile)).toBe(true);
      expect(JSON.parse(fs.readFileSync(reportFile, 'utf-8'))).toEqual(printed);
    }, 60_000);

    it(`writes the report file in text mode too (${kind})`, async () => {
      const { podDir, reportFile } = await emptyPod(encrypted);
      const r = await runCli(['pod', 'reconcile', podDir, '--report', reportFile]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/No reconcilable records found/);
      const written = JSON.parse(fs.readFileSync(reportFile, 'utf-8')) as {
        podDir: string;
        recordsBefore: number;
      };
      expect(written.podDir).toBe(podDir);
      expect(written.recordsBefore).toBe(0);
    }, 60_000);
  }
});
