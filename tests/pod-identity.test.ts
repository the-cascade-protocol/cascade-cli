/**
 * Pod identity surface: `pod init --owner-name`, `pod profile set-name`,
 * the shared card.ttl identity-block helper, and the DEK-aware owner-name
 * resolution in `pod info` (root backlog 2.9).
 *
 * Drives the commander actions programmatically against temp dirs. Encrypted
 * cases supply the passphrase via CASCADE_POD_PASSPHRASE (the sidecar spawn has
 * no TTY, so env-only resolution is the contract under test).
 *
 * All names here are obviously invented (no PHI).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolve } from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';
import {
  deriveCardIdentityName,
  applyCardIdentityName,
  stripCardIdentityName,
} from '../src/commands/pod/helpers.js';

// C-CDA fixture whose recordTarget carries the invented name "Jane Doe".
// The FHIR converter omits the patient name from PatientProfile, so C-CDA is the
// import path that exercises Step 9b's card.ttl name population.
const CCDA_FIXTURE = resolve(__dirname, '../test-fixtures/ccda-lab-panel.xml');

const PASSPHRASE = 'identity-test-passphrase';

// Encrypted cases run the real Argon2id KDF (t=3, m=64 MiB) several times.
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

async function runCli(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const program = buildProgram();
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    chunks.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
  process.exitCode = 0;
  try {
    await program.parseAsync(['node', 'cascade', ...args]);
  } catch {
    /* exitOverride throws on commander errors; captured via exitCode below */
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return { stdout: chunks.join('\n'), exitCode };
}

/** Extract the identity block (header through the blank line before Discovery). */
function identityBlock(cardTurtle: string): string {
  const m = cardTurtle.match(
    /    # ── Identity \(safe to make public\) ──\n[\s\S]*?\n\n {4}# ── Discovery/,
  );
  return m ? m[0] : '';
}

let tmpDirs: string[] = [];
function mkTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-identity-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  delete process.env.CASCADE_POD_PASSPHRASE;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

// ─────────────────────────────────────────────────────────────────────────────
describe('identity helpers (pure)', () => {
  it('deriveCardIdentityName splits exactly two tokens into given/family', () => {
    expect(deriveCardIdentityName('Jane Doe')).toEqual({
      fullName: 'Jane Doe',
      givenName: 'Jane',
      familyName: 'Doe',
    });
  });

  it('deriveCardIdentityName records name only for one token', () => {
    expect(deriveCardIdentityName('Prince')).toEqual({ fullName: 'Prince' });
  });

  it('deriveCardIdentityName records name only for three or more tokens', () => {
    expect(deriveCardIdentityName('Mary Jane Watson')).toEqual({ fullName: 'Mary Jane Watson' });
  });

  it('deriveCardIdentityName collapses internal whitespace and trims', () => {
    expect(deriveCardIdentityName('  Jane   Doe  ')).toEqual({
      fullName: 'Jane Doe',
      givenName: 'Jane',
      familyName: 'Doe',
    });
  });

  it('deriveCardIdentityName yields no parts for empty/whitespace input', () => {
    expect(deriveCardIdentityName('   ')).toEqual({});
    expect(deriveCardIdentityName('')).toEqual({});
  });

  it('applyCardIdentityName is a no-op when no name parts are supplied', () => {
    const card = '    # ── Identity (safe to make public) ──\n    # foaf:name "First Last" ;\n';
    expect(applyCardIdentityName(card, {})).toBe(card);
  });

  it('applyCardIdentityName replaces the commented placeholder block', () => {
    const card =
      '<#me> a foaf:Person ;\n' +
      '    # ── Identity (safe to make public) ──\n' +
      '    # foaf:name "First Last" ;\n' +
      '    # foaf:givenName "First" ;\n' +
      '    # foaf:familyName "Last" ;\n' +
      '\n' +
      '    # ── Discovery links (do not remove) ──\n';
    const out = applyCardIdentityName(card, deriveCardIdentityName('Jane Doe'));
    expect(out).toContain('    foaf:name "Jane Doe" ;');
    expect(out).toContain('    foaf:givenName "Jane" ;');
    expect(out).toContain('    foaf:familyName "Doe" ;');
    expect(out).not.toContain('# foaf:name "First Last"');
  });

  it('stripCardIdentityName removes populated identity triples, leaving the header', () => {
    const named =
      '    # ── Identity (safe to make public) ──\n' +
      '    foaf:name "Jane Doe" ;\n' +
      '    foaf:givenName "Jane" ;\n' +
      '    foaf:familyName "Doe" ;\n' +
      '\n' +
      '    # ── Discovery links (do not remove) ──\n';
    const stripped = stripCardIdentityName(named);
    expect(stripped).not.toContain('foaf:name "Jane Doe"');
    expect(stripped).toContain('    # ── Identity (safe to make public) ──\n');
    expect(stripped).toContain('    # ── Discovery links (do not remove) ──\n');
  });

  it('stripCardIdentityName leaves a commented (unnamed) block untouched', () => {
    const commented =
      '    # ── Identity (safe to make public) ──\n' +
      '    # foaf:name "First Last" ;\n' +
      '\n' +
      '    # ── Discovery links (do not remove) ──\n';
    expect(stripCardIdentityName(commented)).toBe(commented);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('pod init --owner-name (plaintext)', () => {
  it('writes foaf name triples into card.ttl', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    const { exitCode } = await runCli(['pod', 'init', dir, '--owner-name', 'Jane Doe']);
    expect(exitCode).toBe(0);
    const card = fs.readFileSync(path.join(dir, 'profile', 'card.ttl'), 'utf-8');
    expect(card).toContain('    foaf:name "Jane Doe" ;');
    expect(card).toContain('    foaf:givenName "Jane" ;');
    expect(card).toContain('    foaf:familyName "Doe" ;');
    expect(card).not.toContain('# foaf:name "First Last"');
  });

  it('records name only for a single-token owner name', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    await runCli(['pod', 'init', dir, '--owner-name', 'Prince']);
    const card = fs.readFileSync(path.join(dir, 'profile', 'card.ttl'), 'utf-8');
    expect(card).toContain('    foaf:name "Prince" ;');
    expect(card).not.toContain('foaf:givenName');
    expect(card).not.toContain('foaf:familyName');
  });

  it('no --owner-name flag => byte-identical card.ttl to today (commented placeholders)', async () => {
    const a = path.join(mkTmpDir(), 'pod');
    const b = path.join(mkTmpDir(), 'pod');
    await runCli(['pod', 'init', a]);
    await runCli(['pod', 'init', b]);
    const cardA = fs.readFileSync(path.join(a, 'profile', 'card.ttl'), 'utf-8');
    const cardB = fs.readFileSync(path.join(b, 'profile', 'card.ttl'), 'utf-8');
    // Two nameless inits produce identical card.ttl, and the identity block is
    // still the commented placeholder (no regression from the shared helper).
    expect(cardA).toBe(cardB);
    expect(cardA).toContain('    # foaf:name "First Last" ;');
    expect(cardA).not.toContain('    foaf:name "');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('pod profile set-name (plaintext)', () => {
  it('round-trips: sets the name, pod info reads it back', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    await runCli(['pod', 'init', dir]);
    const set = await runCli(['pod', 'profile', 'set-name', dir, 'Jane Doe']);
    expect(set.exitCode).toBe(0);
    const info = await runCli(['--json', 'pod', 'info', dir]);
    expect(info.exitCode).toBe(0);
    expect(JSON.parse(info.stdout).patient.name).toBe('Jane Doe');
  });

  it('re-naming is idempotent (no duplicate foaf:name triples)', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    await runCli(['pod', 'init', dir, '--owner-name', 'Jane Doe']);
    await runCli(['pod', 'profile', 'set-name', dir, 'Prince']);
    await runCli(['pod', 'profile', 'set-name', dir, 'Mary Major']);
    const card = fs.readFileSync(path.join(dir, 'profile', 'card.ttl'), 'utf-8');
    expect((card.match(/foaf:name /g) ?? []).length).toBe(1);
    expect(card).toContain('    foaf:name "Mary Major" ;');
    expect(card).not.toContain('Jane Doe');
    expect(card).not.toContain('Prince');
  });

  it('rejects an empty name', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    await runCli(['pod', 'init', dir]);
    const set = await runCli(['pod', 'profile', 'set-name', dir, '   ']);
    expect(set.exitCode).toBe(1);
  });

  it('rejects a directory that is not a pod', async () => {
    const dir = path.join(mkTmpDir(), 'not-a-pod');
    fs.mkdirSync(dir, { recursive: true });
    const set = await runCli(['pod', 'profile', 'set-name', dir, 'Jane Doe']);
    expect(set.exitCode).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('byte-consistency across writers', () => {
  it('import Step 9b and pod init --owner-name emit the same identity block', async () => {
    // Import path: fresh pod, then import the C-CDA fixture (patient "Jane Doe").
    const importedPod = path.join(mkTmpDir(), 'imported');
    await runCli(['pod', 'init', importedPod]);
    const imp = await runCli(['pod', 'import', importedPod, CCDA_FIXTURE]);
    expect(imp.exitCode).toBe(0);

    // Init path: same name via the CLI flag.
    const initPod = path.join(mkTmpDir(), 'init');
    await runCli(['pod', 'init', initPod, '--owner-name', 'Jane Doe']);

    const importedBlock = identityBlock(
      fs.readFileSync(path.join(importedPod, 'profile', 'card.ttl'), 'utf-8'),
    );
    const initBlock = identityBlock(
      fs.readFileSync(path.join(initPod, 'profile', 'card.ttl'), 'utf-8'),
    );
    expect(importedBlock).not.toBe('');
    expect(importedBlock).toBe(initBlock);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('encrypted pods (V1 + V2)', () => {
  beforeEach(() => {
    process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;
  });

  it('init --encrypt --owner-name resolves the passphrase from env (no TTY) and encrypts the name', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    const { exitCode } = await runCli(['pod', 'init', dir, '--encrypt', '--owner-name', 'Alex Encrypted']);
    expect(exitCode).toBe(0);
    // card.ttl is ciphertext on disk (no readable @prefix or plaintext name).
    const cardBytes = fs.readFileSync(path.join(dir, 'profile', 'card.ttl')).toString('utf-8');
    expect(cardBytes).not.toContain('@prefix');
    expect(cardBytes).not.toContain('Alex Encrypted');
    // pod info decrypts the name via the env passphrase.
    const info = await runCli(['--json', 'pod', 'info', dir]);
    expect(JSON.parse(info.stdout).patient.name).toBe('Alex Encrypted');
  }, TEST_TIMEOUT_MS);

  it('set-name round-trips on an encrypted pod', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    await runCli(['pod', 'init', dir, '--encrypt']);
    const set = await runCli(['pod', 'profile', 'set-name', dir, 'Blair Encrypted']);
    expect(set.exitCode).toBe(0);
    const cardBytes = fs.readFileSync(path.join(dir, 'profile', 'card.ttl')).toString('utf-8');
    expect(cardBytes).not.toContain('Blair Encrypted'); // still ciphertext
    const info = await runCli(['--json', 'pod', 'info', dir]);
    expect(JSON.parse(info.stdout).patient.name).toBe('Blair Encrypted');
  }, TEST_TIMEOUT_MS);

  it('pod info omits the name (no crash) when the passphrase is unavailable', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    await runCli(['pod', 'init', dir, '--encrypt', '--owner-name', 'Alex Encrypted']);
    delete process.env.CASCADE_POD_PASSPHRASE;
    const info = await runCli(['--json', 'pod', 'info', dir]);
    expect(info.exitCode).toBe(0);
    expect(JSON.parse(info.stdout).patient.name).toBeUndefined();
  }, TEST_TIMEOUT_MS);
});
