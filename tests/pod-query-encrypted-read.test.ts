/**
 * `pod query` must never report an UNREADABLE pod as an EMPTY one.
 *
 * The failure this pins down: on an encrypted pod, every read in `pod query`
 * goes through `parseDataFile`, which returns `{ records: [], error }` when a
 * resource fails to decrypt or fails to parse. That error travelled in a
 * per-bucket `error` field on an otherwise successful payload — exit 0, fifteen
 * buckets, every count zero. A consumer reading `count` (which is what a record
 * count IS) saw an empty pod and said so, over a pod holding hundreds of
 * records. Same lesson as `pod conflicts` in PR #30: "none" and "could not tell"
 * must not share an answer.
 *
 * Three ways a pod becomes unreadable, all covered here:
 *   1. no passphrase at all,
 *   2. the wrong passphrase,
 *   3. the right passphrase but a file that does not open under the pod DEK
 *      (a mixed pod, and a pod whose `settings/encryption.json` is gone so the
 *      command does not even know to ask for a key).
 *
 * Every one of them must exit 2 and say so. The control case — correct
 * passphrase — must still exit 0 with real counts, because a guard that fails
 * closed on a healthy pod is its own outage.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { resolveDek, writeResource } from '../src/lib/pod-encryption.js';

const PASSPHRASE = 'query-read-honesty-passphrase';

// Argon2id (t=3, m=64 MiB) runs on every init and on every query of an
// encrypted pod. Deliberately heavy, so allow room.
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

/** Run one CLI invocation, capturing stdout, stderr, and the exit code. */
async function runCli(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
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

/** A Patient + two MedicationStatements, so the pod holds countable records. */
function syntheticBundle(): string {
  return JSON.stringify({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'Patient',
          id: 'pat-1',
          name: [{ given: ['Reada'], family: 'Bility' }],
          gender: 'female',
          birthDate: '1979-02-02',
        },
      },
      {
        resource: {
          resourceType: 'MedicationStatement',
          id: 'med-1',
          status: 'active',
          medicationCodeableConcept: {
            coding: [
              {
                system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
                code: '197361',
                display: 'Lisinopril 10 MG',
              },
            ],
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
            coding: [
              {
                system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
                code: '860975',
                display: 'Metformin 500 MG',
              },
            ],
            text: 'Metformin 500 MG',
          },
          subject: { reference: 'Patient/pat-1' },
        },
      },
    ],
  });
}

let root: string;
/** The reference encrypted pod, built ONCE (the KDF is the slow part). */
let sealedPod: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-query-read-'));
  process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;
  sealedPod = path.join(root, 'sealed-pod');
  const init = await runCli(['pod', 'init', sealedPod, '--encrypt']);
  expect(init.exitCode).toBe(0);
  const bundle = path.join(root, 'bundle.json');
  fs.writeFileSync(bundle, syntheticBundle(), 'utf-8');
  const imported = await runCli(['pod', 'import', sealedPod, bundle]);
  expect(imported.exitCode).toBe(0);
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

/** Parse the `{ "error": "…" }` the CLI prints on stderr in --json mode. */
function jsonError(stderr: string): string {
  const line = stderr.split('\n').find((l) => l.trim().startsWith('{'));
  expect(line, `expected a JSON error on stderr, got: ${stderr}`).toBeTruthy();
  return String((JSON.parse(line as string) as { error?: unknown }).error ?? '');
}

describe('pod query on an encrypted pod', () => {
  it(
    'reads the records with the correct passphrase (exit 0, real counts)',
    async () => {
      const res = await runCli(['--json', 'pod', 'query', sealedPod, '--all']);
      expect(res.exitCode).toBe(0);
      const payload = JSON.parse(res.stdout) as {
        dataTypes: Record<string, { count: number; error?: string }>;
      };
      expect(payload.dataTypes.medications.count).toBe(2);
      expect(payload.dataTypes.medications.error).toBeUndefined();
      // Nothing may be reported as unreadable on a healthy pod.
      for (const [type, bucket] of Object.entries(payload.dataTypes)) {
        expect(bucket.error, `${type} carried a read error`).toBeUndefined();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exits 2 with no passphrase — never an empty result',
    async () => {
      delete process.env.CASCADE_POD_PASSPHRASE;
      const res = await runCli(['--json', 'pod', 'query', sealedPod, '--all']);
      expect(res.exitCode).toBe(2);
      expect(res.stdout.trim()).toBe('');
      const message = jsonError(res.stderr);
      expect(message).toContain('Could not open the pod');
      expect(message).toContain('NOT the same as the pod having no records');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exits 2 with the wrong passphrase — never an empty result',
    async () => {
      process.env.CASCADE_POD_PASSPHRASE = 'not-the-passphrase';
      const res = await runCli(['--json', 'pod', 'query', sealedPod, '--all']);
      expect(res.exitCode).toBe(2);
      expect(res.stdout.trim()).toBe('');
      const message = jsonError(res.stderr);
      expect(message).toContain('Could not open the pod');
      expect(message).toContain('NOT the same as the pod having no records');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exits 2 and names the file when one resource does not open under the pod DEK',
    async () => {
      // A sealed pod holding one file a writer left in the clear: the DEK
      // resolves, so the command believes it can read the pod, and only this
      // one file fails. It used to become `medications: { count: 0 }`.
      const pod = copyOfSealedPod('mixed-pod');
      fs.writeFileSync(
        path.join(pod, 'clinical', 'medications.ttl'),
        '@prefix ex: <http://example.org/> .\nex:s a ex:T .\n',
        'utf-8',
      );
      const res = await runCli(['--json', 'pod', 'query', pod, '--all']);
      expect(res.exitCode).toBe(2);
      expect(res.stdout.trim()).toBe('');
      const message = jsonError(res.stderr);
      expect(message).toContain('clinical/medications.ttl');
      expect(message).toContain('NOT the same as the pod having no records');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exits 2 on ciphertext with no manifest, rather than parsing it as empty Turtle',
    async () => {
      // Without `settings/encryption.json` the command does not know the pod is
      // encrypted, reads ciphertext as text, and every Turtle parse fails. That
      // path produced the exact reported signature: exit 0, every bucket
      // present, every count 0.
      const pod = copyOfSealedPod('manifestless-pod');
      fs.rmSync(path.join(pod, 'settings', 'encryption.json'));
      const res = await runCli(['--json', 'pod', 'query', pod, '--all']);
      expect(res.exitCode).toBe(2);
      expect(res.stdout.trim()).toBe('');
      expect(jsonError(res.stderr)).toContain(
        'NOT the same as the pod having no records',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'still answers when an unregistered pod file is not valid Turtle',
    async () => {
      // A pod holds more than records: notes, investigations, reports, analysis
      // bundles. Some of those are not Turtle this command can parse, and one of
      // them must NOT cost the user the whole record list — the cure would be
      // worse than the disease it treats.
      const pod = copyOfSealedPod('stray-file-pod');
      const dek = resolveDek(pod, PASSPHRASE);
      fs.mkdirSync(path.join(pod, 'investigations'), { recursive: true });
      writeResource(
        path.join(pod, 'investigations', 'i1.ttl'),
        '<urn:i> oa:bodyValue "no prefix declared" .\n',
        dek,
      );
      const res = await runCli(['--json', 'pod', 'query', pod, '--all']);
      expect(res.exitCode).toBe(0);
      const payload = JSON.parse(res.stdout) as {
        dataTypes: Record<string, { count: number }>;
      };
      expect(payload.dataTypes.medications.count).toBe(2);
      // Not fatal is not the same as not mentioned.
      expect(res.stderr).toContain('investigations/i1.ttl');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is still fatal when an unregistered pod file will not DECRYPT',
    async () => {
      // The same file, left in the clear inside a sealed pod: this one is a KEY
      // problem, not a stray-file problem, and it does not get stepped over.
      const pod = copyOfSealedPod('stray-plaintext-pod');
      fs.mkdirSync(path.join(pod, 'investigations'), { recursive: true });
      fs.writeFileSync(
        path.join(pod, 'investigations', 'i2.ttl'),
        '@prefix oa: <http://www.w3.org/ns/oa#> .\n<urn:i> a oa:Annotation .\n',
        'utf-8',
      );
      const res = await runCli(['--json', 'pod', 'query', pod, '--all']);
      expect(res.exitCode).toBe(2);
      expect(jsonError(res.stderr)).toContain('investigations/i2.ttl');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the edge projection honest too (--all --edges)',
    async () => {
      const ok = await runCli(['--json', 'pod', 'query', sealedPod, '--all', '--edges']);
      expect(ok.exitCode).toBe(0);

      process.env.CASCADE_POD_PASSPHRASE = 'not-the-passphrase';
      const bad = await runCli(['--json', 'pod', 'query', sealedPod, '--all', '--edges']);
      expect(bad.exitCode).toBe(2);
      expect(bad.stdout.trim()).toBe('');
    },
    TEST_TIMEOUT_MS,
  );
});
