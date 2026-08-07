/**
 * `cascade pod doctor` on an ENCRYPTED pod.
 *
 * Split from `pod-doctor.test.ts` because the Argon2id KDF is deliberately
 * expensive (t=3, m=64 MiB) and runs on every open.
 *
 * Three things are under test here and nowhere else:
 *
 *   1. ENCRYPTION TRANSPARENCY. The repair must go through the pod's DEK in both
 *      directions, and the file must still be ciphertext afterwards. A repair
 *      tool that "fixed" a bucket by leaving the patient's medication list in
 *      plaintext on disk would be a far worse bug than the one it repaired.
 *   2. A pod that will NOT OPEN is exit 2, not a clean bill of health. "This pod
 *      is fine" and "I could not look at this pod" must never share an answer —
 *      the mistake this whole area of the CLI keeps re-making.
 *   3. ONE resource that does not decrypt is reported as that, not as a wrong
 *      passphrase. The passphrase demonstrably worked: every other file in the
 *      pod opened with it. Blaming it sends the user to re-check the one thing
 *      that is not wrong.
 *
 * All fixtures are synthetic and PHI-free.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Parser } from 'n3';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { resolveDek, readResource, writeResource } from '../src/lib/pod-encryption.js';
import { BACKUP_SUFFIX, type DoctorReport } from '../src/lib/pod-doctor.js';

const PASSPHRASE = 'doctor-encrypted-pod-passphrase';
const TEST_TIMEOUT_MS = 120_000;

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

/** Streams kept APART: the report is stdout, the unreadable-file shout is stderr. */
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

async function doctorJson(
  args: string[],
): Promise<{ report: DoctorReport; stderr: string; exitCode: number }> {
  const r = await runCli(['--json', 'pod', 'doctor', ...args]);
  const start = r.stdout.indexOf('{');
  expect(start, `no JSON in doctor output: ${r.stdout}`).toBeGreaterThanOrEqual(0);
  return {
    report: JSON.parse(r.stdout.slice(start, r.stdout.lastIndexOf('}') + 1)) as DoctorReport,
    stderr: r.stderr,
    exitCode: r.exitCode,
  };
}

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

let root: string;
/** Built ONCE: the KDF is the slow part, and every test wants the same pod. */
let sealedPod: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-doctor-enc-'));
  process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;
  sealedPod = path.join(root, 'sealed-pod');
  expect((await runCli(['pod', 'init', sealedPod, '--encrypt'])).exitCode).toBe(0);
  const bundle = path.join(root, 'bundle.json');
  fs.writeFileSync(bundle, RXNORM_BUNDLE, 'utf-8');
  expect((await runCli(['pod', 'import', sealedPod, bundle])).exitCode).toBe(0);
  delete process.env.CASCADE_POD_PASSPHRASE;
}, TEST_TIMEOUT_MS);

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;
});
afterEach(() => {
  delete process.env.CASCADE_POD_PASSPHRASE;
});

/** A throwaway copy of the sealed pod, so a test can damage it freely. */
function copyOfSealedPod(name: string): string {
  const dest = path.join(root, name);
  fs.cpSync(sealedPod, dest, { recursive: true });
  return dest;
}

/** Bytes on disk that are NOT the plaintext Turtle: the ciphertext check. */
function isCiphertext(file: string): boolean {
  const blob = fs.readFileSync(file);
  return !blob.toString('utf-8').includes('@prefix');
}

/**
 * Damage the bucket INSIDE the envelope, the way the shipped defect did: strip
 * the `@prefix` block from the plaintext and re-seal it. The file stays
 * ciphertext; what is wrong is only visible with the key.
 */
function stripPrefixHeaderSealed(podDir: string, relFile: string): string {
  const dek = resolveDek(podDir, PASSPHRASE);
  const abs = path.join(podDir, relFile);
  const plaintext = readResource(abs, dek);
  expect(plaintext, 'the fixture does not carry the prefix header').toContain('@prefix rxnorm:');
  const damaged = plaintext
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('@prefix'))
    .join('\n');
  writeResource(abs, damaged, dek);
  expect(isCiphertext(abs), 'the fixture stopped being ciphertext').toBe(true);
  return damaged;
}

function plaintextOf(podDir: string, relFile: string): string {
  return readResource(path.join(podDir, relFile), resolveDek(podDir, PASSPHRASE));
}

function parsesStrictly(ttl: string): boolean {
  try {
    new Parser({ format: 'Turtle' }).parse(ttl);
    return true;
  } catch {
    return false;
  }
}

function snapshot(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.set(path.relative(dir, full), fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

function expectUnchanged(before: Map<string, Buffer>, dir: string): void {
  const after = snapshot(dir);
  expect([...after.keys()].sort(), 'files appeared or vanished').toEqual([...before.keys()].sort());
  for (const [rel, bytes] of before) {
    expect(after.get(rel)!.equals(bytes), `${rel} was modified`).toBe(true);
  }
}

const MEDS = 'clinical/medications.ttl';

describe('doctor on an encrypted pod', () => {
  it(
    'repairs through the DEK, leaves the file ciphertext, and the pod reads back',
    async () => {
      const pod = copyOfSealedPod('repairs-through-dek');
      const damaged = stripPrefixHeaderSealed(pod, MEDS);
      expect(parsesStrictly(damaged)).toBe(false);

      // The pod really is unreadable first.
      expect((await runCli(['--json', 'pod', 'query', pod, '--medications'])).exitCode).not.toBe(0);

      const r = await doctorJson([pod, '--write']);
      expect(r.exitCode).toBe(0);
      expect(r.report.encrypted).toBe(true);
      expect(r.report.repaired).toBe(1);
      expect(r.report.findings[0].file).toBe(MEDS);
      expect(r.report.findings[0].missingPrefixes).toContain('rxnorm');

      // Still ciphertext. This is the assertion that a "repair" which quietly
      // wrote plaintext would fail.
      expect(isCiphertext(path.join(pod, MEDS)), 'the repair wrote plaintext').toBe(true);
      // The backup is ciphertext too — it is a byte copy of a sealed file.
      expect(isCiphertext(path.join(pod, MEDS + BACKUP_SUFFIX)), 'the backup is plaintext').toBe(true);

      // Prepend-only holds through the envelope.
      const repaired = plaintextOf(pod, MEDS);
      expect(parsesStrictly(repaired)).toBe(true);
      expect(repaired.endsWith(damaged)).toBe(true);

      const q = await runCli(['--json', 'pod', 'query', pod, '--medications']);
      expect(q.exitCode).toBe(0);
      expect(q.stdout).toContain('Metformin 500 MG');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is idempotent on a sealed pod, and re-sealing does not churn the healthy files',
    async () => {
      const pod = copyOfSealedPod('idempotent-sealed');
      stripPrefixHeaderSealed(pod, MEDS);
      expect((await doctorJson([pod, '--write'])).report.repaired).toBe(1);

      const after = snapshot(pod);
      const second = await doctorJson([pod, '--write']);
      expect(second.exitCode).toBe(0);
      expect(second.report.findings).toEqual([]);
      expectUnchanged(after, pod);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a WRONG passphrase exits 2 and modifies nothing',
    async () => {
      const pod = copyOfSealedPod('wrong-passphrase');
      stripPrefixHeaderSealed(pod, MEDS);
      const before = snapshot(pod);

      process.env.CASCADE_POD_PASSPHRASE = 'not-the-passphrase';
      const r = await runCli(['pod', 'doctor', pod, '--write']);
      expect(r.exitCode, 'a locked pod must not read as a clean pod').toBe(2);
      expect(r.stderr).toMatch(/passphrase did not open it/);
      expectUnchanged(before, pod);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'NO passphrase at all exits 2 and modifies nothing',
    async () => {
      const pod = copyOfSealedPod('no-passphrase');
      stripPrefixHeaderSealed(pod, MEDS);
      const before = snapshot(pod);

      delete process.env.CASCADE_POD_PASSPHRASE;
      const r = await runCli(['pod', 'doctor', pod, '--write']);
      expect(r.exitCode).toBe(2);
      expectUnchanged(before, pod);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports ONE undecryptable resource without blaming the passphrase',
    async () => {
      // Root 3.160(b): the shipped message misattributes "this one resource
      // failed authentication" to "your passphrase is wrong". The passphrase
      // demonstrably works — every other file in this pod opened with it.
      const pod = copyOfSealedPod('unsealed-resource');
      const stray = path.join(pod, 'clinical', 'conditions.ttl');
      fs.writeFileSync(stray, '@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .\n', 'utf-8');
      const before = snapshot(pod);

      const r = await doctorJson([pod, '--write']);
      // 2, not 1: this file was never examined, and "I could not look" must not
      // be reported as "I looked and here is what is wrong".
      expect(r.exitCode).toBe(2);
      expect(r.report.unreadable).toBe(1);
      const finding = r.report.findings.find((f) => f.file === 'clinical/conditions.ttl');
      expect(finding).toBeTruthy();
      expect(finding!.status).toBe('unreadable');
      expect(finding!.damage).toBe('undecryptable');
      expect(finding!.reason).toMatch(/NOT sealed/);
      expect(finding!.reason).not.toMatch(/incorrect passphrase/);
      expect(finding!.nextStep).toMatch(/passphrase is not the problem/);
      // Said out loud on stderr, with the right cause, not only in the report.
      expect(r.stderr).toContain('clinical/conditions.ttl');
      expect(r.stderr).toMatch(/NOT sealed/);
      expect(r.stderr).not.toMatch(/incorrect passphrase/);

      // And an unreadable file is never rewritten on a guess.
      expectUnchanged(before, pod);
    },
    TEST_TIMEOUT_MS,
  );
});
