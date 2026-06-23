/**
 * Integration tests for encrypted-pod command wiring.
 *
 * Drives the commander actions programmatically (init/import/query/validate)
 * against temp dirs, with the passphrase supplied via CASCADE_POD_PASSPHRASE.
 *
 * Verifies:
 *   - `pod init --encrypt` writes ciphertext resources (no @prefix on disk).
 *   - `pod query` decrypts and returns expected records.
 *   - `pod import` into an encrypted pod, then `pod query` returns them.
 *   - `validate` succeeds on an encrypted pod (decrypts first).
 *   - A plaintext pod (no manifest) still imports/queries unchanged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { registerValidateCommand } from '../src/commands/validate.js';

const PASSPHRASE = 'integration-test-passphrase';

// These tests exercise the REAL Argon2id KDF (t=3, m=64 MiB) on every
// init/encrypt/decrypt/query/validate, several times per test. The default
// 64 MiB memory cost is deliberately heavy, so allow a generous timeout.
const TEST_TIMEOUT_MS = 60_000;

/** Build a fresh CLI program with the pod + validate commands registered. */
function buildProgram(): Command {
  const program = new Command();
  program
    .name('cascade')
    .exitOverride() // throw instead of process.exit so tests can catch
    .option('--verbose', 'Verbose output', false)
    .option('--json', 'Output JSON', false);
  registerPodCommand(program);
  registerValidateCommand(program);
  return program;
}

/**
 * Run a CLI invocation, capturing stdout. Returns captured stdout lines joined.
 * `process.exitCode` is reset before each run and returned.
 */
async function runCli(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const program = buildProgram();
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    chunks.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // printResult() writes via process.stdout.write, not console.log — capture both.
  const writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
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
  return { stdout: chunks.join('\n'), exitCode };
}

/** Minimal synthetic FHIR bundle: a Patient + two MedicationStatements. */
function syntheticFhirBundle(): string {
  return JSON.stringify({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'Patient',
          id: 'pat-1',
          name: [{ given: ['Testy'], family: 'McTestface' }],
          gender: 'female',
          birthDate: '1985-04-12',
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
      {
        resource: {
          resourceType: 'MedicationStatement',
          id: 'med-2',
          status: 'active',
          medicationCodeableConcept: {
            coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '860975', display: 'Metformin 500 MG' }],
            text: 'Metformin 500 MG',
          },
          subject: { reference: 'Patient/pat-1' },
        },
      },
    ],
  });
}

let tmpDirs: string[] = [];
function mkTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-enc-it-'));
  tmpDirs.push(d);
  return d;
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

describe('encrypted pod end-to-end', () => {
  it('pod init --encrypt writes ciphertext resources and a manifest', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    const { exitCode } = await runCli(['pod', 'init', dir, '--encrypt']);
    expect(exitCode).toBe(0);

    // Manifest present.
    expect(fs.existsSync(path.join(dir, 'settings', 'encryption.json'))).toBe(true);

    // index.ttl and template TTLs are ciphertext (no readable @prefix).
    const indexBytes = fs.readFileSync(path.join(dir, 'index.ttl')).toString('utf-8');
    expect(indexBytes).not.toContain('@prefix');
    expect(indexBytes).not.toContain('ldp:BasicContainer');

    const cardBytes = fs.readFileSync(path.join(dir, 'profile', 'card.ttl')).toString('utf-8');
    expect(cardBytes).not.toContain('@prefix');

    // README stays plaintext docs.
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf-8')).toContain('Cascade Protocol Pod');
  }, TEST_TIMEOUT_MS);

  it('imports FHIR into an encrypted pod, leaves clinical data as ciphertext, and queries it back', async () => {
    const root = mkTmpDir();
    const dir = path.join(root, 'pod');
    await runCli(['pod', 'init', dir, '--encrypt']);

    const fhirPath = path.join(root, 'bundle.json');
    fs.writeFileSync(fhirPath, syntheticFhirBundle());

    const imp = await runCli(['pod', 'import', dir, fhirPath]);
    expect(imp.exitCode).toBe(0);

    // The imported medications file must be on disk as ciphertext.
    const medsPath = path.join(dir, 'clinical', 'medications.ttl');
    expect(fs.existsSync(medsPath)).toBe(true);
    const medsBytes = fs.readFileSync(medsPath).toString('utf-8');
    expect(medsBytes).not.toContain('@prefix');
    expect(medsBytes).not.toContain('Lisinopril');

    // Query decrypts and returns the medications.
    const q = await runCli(['--json', 'pod', 'query', dir, '--medications']);
    expect(q.exitCode).toBe(0);
    const parsed = JSON.parse(q.stdout);
    expect(parsed.dataTypes.medications.count).toBe(2);
  }, TEST_TIMEOUT_MS);

  it('query fails cleanly with the wrong passphrase', async () => {
    const root = mkTmpDir();
    const dir = path.join(root, 'pod');
    await runCli(['pod', 'init', dir, '--encrypt']);
    const fhirPath = path.join(root, 'bundle.json');
    fs.writeFileSync(fhirPath, syntheticFhirBundle());
    await runCli(['pod', 'import', dir, fhirPath]);

    process.env.CASCADE_POD_PASSPHRASE = 'definitely-wrong';
    const q = await runCli(['--json', 'pod', 'query', dir, '--medications']);
    expect(q.exitCode).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('validate succeeds on an encrypted pod (decrypts first)', async () => {
    const root = mkTmpDir();
    const dir = path.join(root, 'pod');
    await runCli(['pod', 'init', dir, '--encrypt']);
    const fhirPath = path.join(root, 'bundle.json');
    fs.writeFileSync(fhirPath, syntheticFhirBundle());
    await runCli(['pod', 'import', dir, fhirPath]);

    const v = await runCli(['validate', dir]);
    // Exit code 0 = all pass, 1 = SHACL violations. Either way it must NOT be 2
    // (which would mean a read/parse error, i.e. decryption failed).
    expect(v.exitCode).not.toBe(2);
  }, TEST_TIMEOUT_MS);
});

describe('pod encrypt migration', () => {
  it('migrates a plaintext pod to encrypted in place', async () => {
    const root = mkTmpDir();
    const dir = path.join(root, 'pod');
    // Init plaintext (no env passphrase needed for plaintext init).
    delete process.env.CASCADE_POD_PASSPHRASE;
    await runCli(['pod', 'init', dir]);
    expect(fs.readFileSync(path.join(dir, 'index.ttl'), 'utf-8')).toContain('@prefix');

    // Now encrypt.
    process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;
    const enc = await runCli(['pod', 'encrypt', dir]);
    expect(enc.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, 'settings', 'encryption.json'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'index.ttl')).toString('utf-8')).not.toContain('@prefix');

    // Guard: encrypting again must fail.
    const again = await runCli(['pod', 'encrypt', dir]);
    expect(again.exitCode).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('decrypts an encrypted pod back to plaintext and removes the manifest', async () => {
    const root = mkTmpDir();
    const dir = path.join(root, 'pod');
    await runCli(['pod', 'init', dir, '--encrypt']);

    const dec = await runCli(['pod', 'decrypt', dir]);
    expect(dec.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, 'settings', 'encryption.json'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'index.ttl'), 'utf-8')).toContain('@prefix');
  }, TEST_TIMEOUT_MS);
});

describe('plaintext pod still works (no manifest)', () => {
  it('imports and queries a plaintext pod unchanged', async () => {
    delete process.env.CASCADE_POD_PASSPHRASE;
    const root = mkTmpDir();
    const dir = path.join(root, 'pod');
    await runCli(['pod', 'init', dir]);

    const fhirPath = path.join(root, 'bundle.json');
    fs.writeFileSync(fhirPath, syntheticFhirBundle());
    const imp = await runCli(['pod', 'import', dir, fhirPath]);
    expect(imp.exitCode).toBe(0);

    // Plaintext on disk.
    const medsBytes = fs.readFileSync(path.join(dir, 'clinical', 'medications.ttl'), 'utf-8');
    expect(medsBytes).toContain('@prefix');

    const q = await runCli(['--json', 'pod', 'query', dir, '--medications']);
    expect(q.exitCode).toBe(0);
    const parsed = JSON.parse(q.stdout);
    expect(parsed.dataTypes.medications.count).toBe(2);
  }, TEST_TIMEOUT_MS);
});
