/**
 * The read-honesty battery: ONE failure matrix, run over EVERY read verb.
 *
 * Every verb that reads a pod has, at some point, reported an ENCRYPTED pod as
 * an EMPTY one. `pod decrypt`, then `pod conflicts`/`pod resolve`, then
 * `pod query`, then `pod info` and the MCP read tools and `pod erase` and
 * `pod export` and `pod extract` — each found separately, each fixed
 * separately, each with its own regression test pinning its own bug.
 *
 * A per-verb test only ever protects the verb that already broke. This file is
 * verb-AGNOSTIC on purpose: it enumerates the commander registry and asserts
 * the classification table below covers it, so a NEW pod subcommand fails this
 * test until someone states, in the table, whether it reads pods and what it
 * must do when it cannot. Coverage is inherited by existing rather than by
 * remembering.
 *
 * The matrix, five ways a pod is not readable-as-usual:
 *   1. sealed + correct passphrase  → the control. Real data, success exit.
 *   2. passphrase unset             → nonzero, naming the state.
 *   3. wrong passphrase             → nonzero, naming the state.
 *   4. one plaintext stray among sealed files → nonzero (or, where the verb's
 *      job makes a partial answer correct, success WITH a warning naming it).
 *   5. `settings/encryption.json` missing → nonzero. The command does not even
 *      know to ask for a key, reads ciphertext, and parses nothing: this is the
 *      exact shape of the original report.
 *
 * And the rule underneath all of it: NEVER exit 0 with an empty answer over a
 * pod that has data.
 *
 * Exit codes are part of the contract and are pinned here:
 *   0 — success
 *   1 — user / input error (a choice the user must make, a bad flag)
 *   2 — could not read what exists
 *
 * Verbs run as real SUBPROCESSES (`node dist/index.js`). Some of them call
 * `process.exit` directly, which an in-process harness cannot survive, and the
 * exit code IS the thing under test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerPodCommand } from '../src/commands/pod/index.js';
import {
  resolveDek,
  writeResource,
  buildPassphraseManifest,
  writeEncryptionManifest,
} from '../src/lib/pod-encryption.js';
import { writePendingConflicts } from '../src/lib/user-resolutions.js';
import { podReadHandler, podQueryHandler } from '../src/lib/mcp/tools.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'dist', 'index.js');

const PASSPHRASE = 'read-conformance-passphrase';
const WRONG_PASSPHRASE = 'not-the-passphrase';

/** Argon2id runs on every invocation of every scenario; leave room. */
const TEST_TIMEOUT_MS = 120_000;

// ─── Harness ──────────────────────────────────────────────────────────────────

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run the built CLI as a child process with an explicit passphrase state. */
function runCli(args: string[], passphrase?: string): Run {
  const env = { ...process.env };
  delete env.CASCADE_POD_PASSPHRASE;
  if (passphrase !== undefined) env.CASCADE_POD_PASSPHRASE = passphrase;

  // spawnSync, not execFileSync: a warning printed alongside a SUCCESSFUL exit
  // is half of what this battery checks, and execFileSync only hands back
  // stderr when the process failed.
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    env,
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    exitCode: typeof res.status === 'number' ? res.status : 1,
  };
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

/** A ClinicalDocument carrying a narrative block, so `pod extract` has work. */
const DOCUMENTS_TTL = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .

<urn:uuid:doc-0001-aaaa-bbbb-ccccddddeeee> a clinical:ClinicalDocument ;
    cascade:requiresLLMExtraction "true" ;
    cascade:sectionCode "11450-4" ;
    cascade:narrativeText "Patient reports intermittent chest tightness on exertion." ;
    cascade:dataProvenance cascade:ClinicalGenerated .
`;

let root: string;
/** The reference encrypted pod, built ONCE (the KDF is the slow part). */
let sealedPod: string;
/** A record IRI that really exists in the fixture, for `pod erase`. */
let eraseTargetIri: string;

beforeAll(async () => {
  expect(
    fs.existsSync(CLI),
    'dist/index.js is missing — run `npm run build` before the test suite.',
  ).toBe(true);

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-read-conformance-'));
  sealedPod = path.join(root, 'sealed-pod');

  const init = runCli(['pod', 'init', sealedPod, '--encrypt'], PASSPHRASE);
  expect(init.exitCode, init.stderr).toBe(0);

  const bundle = path.join(root, 'bundle.json');
  fs.writeFileSync(bundle, syntheticBundle(), 'utf-8');
  const imported = runCli(['pod', 'import', sealedPod, bundle], PASSPHRASE);
  expect(imported.exitCode, imported.stderr).toBe(0);

  const dek = resolveDek(sealedPod, PASSPHRASE);

  // Re-wrap the SAME DEK under cheap Argon2id parameters. The matrix runs ~30
  // subprocesses and each one derives a KEK; the default cost (t=3, m=64 MiB)
  // is deliberately heavy and would dominate the suite. The wrapped key, the
  // sealed resources and every code path under test are unchanged — only the
  // KDF work factor differs, and it is the pod's own recorded parameter.
  writeEncryptionManifest(sealedPod, buildPassphraseManifest(dek, PASSPHRASE, { t: 1, m: 8192, p: 1 }));

  // A narrative document, so `pod extract --dry-run` has something to find.
  writeResource(path.join(sealedPod, 'clinical', 'documents.ttl'), DOCUMENTS_TTL, dek);

  // A pending conflict, so `pod conflicts` has something to report. Without it
  // the verb answers "none" in every scenario and proves nothing.
  await writePendingConflicts(
    sealedPod,
    [
      {
        uri: 'urn:uuid:conflict-0001-aaaa-bbbb-ccccddddeeee',
        conflictId: 'health:ConditionRecord::hypertension',
        recordType: 'health:ConditionRecord',
        detectedAt: new Date('2026-01-01T00:00:00.000Z'),
        candidateRecordUris: ['urn:uuid:cond-a', 'urn:uuid:cond-b'],
      },
    ],
    dek,
  );

  // The medications the fixture actually holds, for `pod erase`.
  const listed = runCli(['--json', 'pod', 'query', sealedPod, '--medications'], PASSPHRASE);
  expect(listed.exitCode, listed.stderr).toBe(0);
  const payload = JSON.parse(listed.stdout) as {
    dataTypes: Record<string, { count: number; records: Array<{ id: string }> }>;
  };
  expect(payload.dataTypes.medications.count).toBe(2);
  eraseTargetIri = payload.dataTypes.medications.records[0].id;
}, TEST_TIMEOUT_MS);

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** A throwaway copy of the sealed pod, so a scenario can damage it freely. */
let copyCounter = 0;
function copyOfSealedPod(tag: string): string {
  const dest = path.join(root, `${tag}-${copyCounter++}`);
  fs.cpSync(sealedPod, dest, { recursive: true });
  return dest;
}

// ─── The verb table ───────────────────────────────────────────────────────────

/**
 * What a subcommand does with a pod:
 *
 *  - `read`     — reads pod resources to answer a question. Runs the matrix.
 *  - `write`    — mutates the pod. It resolves the DEK through the same shared
 *                 path, but its failure semantics belong to its own tests.
 *  - `lifecycle`— creates a pod or re-keys one. There is no "read it as data"
 *                 question to ask, and the passphrase IS its subject.
 */
type Category = 'read' | 'write' | 'lifecycle';

interface VerbSpec {
  category: Category;
  /** Why a non-`read` verb is out of the matrix. Required for those. */
  why?: string;
  /** Build the argv for a pod at `pod`. */
  argv?: (pod: string) => string[];
  /** Exit code that means "it worked" (not always 0 — see `conflicts`). */
  successExit?: number;
  /** Proof the success case saw REAL data, not a hollow success. */
  successMustContain?: string;
  /** Pod-relative file to leave in the clear for the stray scenario. */
  strayTarget?: string;
  /** What the stray scenario must produce. */
  strayOutcome?: 'fatal' | 'warn';
  /** Each scenario gets a fresh copy (the verb mutates). */
  mutates?: boolean;
  /** Scenarios this verb answers before it ever reads (see `export`). */
  refusesEncrypted?: boolean;
}

const VERBS: Record<string, VerbSpec> = {
  query: {
    category: 'read',
    argv: (pod) => ['--json', 'pod', 'query', pod, '--all'],
    successExit: 0,
    successMustContain: '"count": 2',
    strayTarget: 'clinical/medications.ttl',
    strayOutcome: 'fatal',
  },
  info: {
    category: 'read',
    argv: (pod) => ['--json', 'pod', 'info', pod],
    successExit: 0,
    // The bug was `"patient": {}` and empty arrays at exit 0. Prove the name
    // decrypted and the record count is the pod's real one.
    successMustContain: '"records": 2',
    strayTarget: 'clinical/medications.ttl',
    strayOutcome: 'fatal',
  },
  conflicts: {
    category: 'read',
    argv: (pod) => ['pod', 'conflicts', pod],
    // Exit 1 IS this verb's success: it is CI-facing and reports "conflicts
    // exist" that way. Exit 0 would mean "none", which is the 1.9 bug.
    successExit: 1,
    successMustContain: 'health:ConditionRecord',
    strayTarget: 'settings/pending-conflicts.ttl',
    strayOutcome: 'fatal',
  },
  extract: {
    category: 'read',
    argv: (pod) => ['pod', 'extract', pod, '--dry-run'],
    successExit: 0,
    successMustContain: 'narrative block(s) found',
    strayTarget: 'clinical/documents.ttl',
    strayOutcome: 'fatal',
  },
  erase: {
    category: 'read',
    argv: (pod) => ['pod', 'erase', pod, '--record', eraseTargetIri, '--confirm'],
    successExit: 0,
    successMustContain: 'Record erased',
    // An UNREGISTERED stray: the record itself is still readable, so the
    // erasure is correct and the unread file is a warning, not a refusal. For
    // an erasure verb the direction of the error is what matters — never say
    // "not found" about a file you could not open — and that is the not-found
    // case, covered separately below.
    strayTarget: 'investigations/stray.ttl',
    strayOutcome: 'warn',
    mutates: true,
  },
  doctor: {
    category: 'read',
    // The DRY RUN, which is the default and reads every .ttl in the pod. Its
    // repair path has its own suites (pod-doctor.test.ts, and the sealed-pod
    // half in pod-doctor-encrypted.test.ts); what belongs here is the read.
    argv: (pod) => ['--json', 'pod', 'doctor', pod],
    successExit: 0,
    // `"unreadable": 0` is the honest-read assertion in this verb's own
    // vocabulary: with the key, nothing in the pod is unexaminable. A keyless
    // read makes it the file count instead, so it cannot pass hollow.
    successMustContain: '"unreadable": 0',
    strayTarget: 'clinical/medications.ttl',
    // Fatal, at exit 2, even though doctor's job is to report per-file damage.
    // A file it could not READ was never examined, and a verb whose whole
    // purpose is to tell you the state of your pod must not answer "here is the
    // state of your pod" about files it never opened.
    strayOutcome: 'fatal',
  },
  export: {
    category: 'read',
    // D-CLI-2: an encrypted pod is refused before any read, in EVERY scenario,
    // until the user says --allow-encrypted. Its own tests are below.
    refusesEncrypted: true,
    argv: (pod) => ['pod', 'export', pod, '--format', 'directory', '--output', `${pod}-out`],
    mutates: true,
  },

  // ── Not read verbs ────────────────────────────────────────────────────────
  init: { category: 'lifecycle', why: 'creates a pod; there is nothing to read yet' },
  encrypt: { category: 'lifecycle', why: 're-keys the pod; the passphrase is its subject, not its input' },
  decrypt: { category: 'lifecycle', why: 're-keys the pod; covered by the encrypt/decrypt round-trip tests' },
  import: { category: 'write', why: 'writes records; DEK-aware through the shared resolution' },
  profile: { category: 'write', why: 'writes profile/card.ttl; DEK-aware through the shared resolution' },
  resolve: { category: 'write', why: 'records a resolution decision; its conflict-store read is pinned by its own tests' },
  amend: { category: 'write', why: 'appends an overlay; DEK-aware through the shared resolution' },
  annotate: { category: 'write', why: 'appends an overlay; DEK-aware through the shared resolution' },
  'add-record': { category: 'write', why: 'appends a record; DEK-aware through the shared resolution' },
  retract: { category: 'write', why: 'appends an overlay; DEK-aware through the shared resolution' },
};

/** Every `pod` subcommand commander actually knows about. */
function registeredPodSubcommands(): string[] {
  const program = new Command();
  program.name('cascade').exitOverride();
  registerPodCommand(program);
  const pod = program.commands.find((c) => c.name() === 'pod');
  expect(pod, 'the pod command is not registered').toBeTruthy();
  return pod!.commands.map((c) => c.name()).sort();
}

// ─── The enumeration gate ─────────────────────────────────────────────────────

describe('read conformance: the verb table covers the registry', () => {
  it('classifies every registered pod subcommand', () => {
    const registered = registeredPodSubcommands();
    const classified = Object.keys(VERBS).sort();

    const unclassified = registered.filter((name) => !(name in VERBS));
    expect(
      unclassified,
      'A new pod subcommand exists that this battery does not classify. Add it to ' +
        'VERBS: if it reads pods, give it argv and let the matrix run; if it does ' +
        'not, say why. A read verb without coverage is how every one of these bugs ' +
        'shipped.',
    ).toEqual([]);

    const stale = classified.filter((name) => !registered.includes(name));
    expect(stale, 'VERBS lists subcommands that no longer exist').toEqual([]);
  });

  it('every non-read verb states why it is out of the matrix', () => {
    for (const [name, spec] of Object.entries(VERBS)) {
      if (spec.category === 'read') continue;
      expect(spec.why?.length ?? 0, `${name} is excluded with no stated reason`).toBeGreaterThan(10);
    }
  });
});

// ─── The matrix ───────────────────────────────────────────────────────────────

const READ_VERBS = Object.entries(VERBS).filter(
  ([, spec]) => spec.category === 'read' && !spec.refusesEncrypted,
);

describe.each(READ_VERBS)('read conformance: pod %s', (name, spec) => {
  const argv = spec.argv!;

  /** The pod this scenario runs against (a copy when the verb mutates). */
  const podFor = (tag: string): string => (spec.mutates ? copyOfSealedPod(`${name}-${tag}`) : sealedPod);

  it(
    'sealed + correct passphrase: succeeds with real data',
    () => {
      const res = runCli(argv(podFor('ok')), PASSPHRASE);
      expect(res.exitCode, `stderr: ${res.stderr}`).toBe(spec.successExit);
      expect(res.stdout).toContain(spec.successMustContain!);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'passphrase unset: exits 2 and names the state, never an empty answer',
    () => {
      const res = runCli(argv(podFor('unset')), undefined);
      expect(res.exitCode, `stdout: ${res.stdout}`).toBe(2);
      expect(res.stderr.toLowerCase()).toContain('encrypted');
      expect(res.stdout).not.toContain(spec.successMustContain!);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'wrong passphrase: exits 2 and names the state, never an empty answer',
    () => {
      const res = runCli(argv(podFor('wrong')), WRONG_PASSPHRASE);
      expect(res.exitCode, `stdout: ${res.stdout}`).toBe(2);
      expect(res.stderr.toLowerCase()).toContain('encrypted');
      expect(res.stdout).not.toContain(spec.successMustContain!);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'one plaintext stray among sealed files: reported, never silently dropped',
    () => {
      const pod = copyOfSealedPod(`${name}-stray`);
      const strayPath = path.join(pod, ...spec.strayTarget!.split('/'));
      fs.mkdirSync(path.dirname(strayPath), { recursive: true });
      fs.writeFileSync(
        strayPath,
        '@prefix ex: <http://example.org/> .\nex:s a ex:T .\n',
        'utf-8',
      );

      const res = runCli(argv(pod), PASSPHRASE);
      if (spec.strayOutcome === 'fatal') {
        expect(res.exitCode, `stdout: ${res.stdout}`).toBe(2);
        expect(res.stderr).toContain(spec.strayTarget!);
      } else {
        // Correct partial answer, plus a warning naming what was not read.
        expect(res.exitCode, `stderr: ${res.stderr}`).toBe(spec.successExit);
        expect(res.stderr).toContain(spec.strayTarget!);
      }

      // And it must name the RIGHT cause. An unsealed file fails GCM exactly
      // like a wrong key does, and the raw error for both is "incorrect
      // passphrase or corrupt key" — which is a lie here, because the
      // passphrase supplied was the correct one. Sending the user to re-check
      // the one thing that is not wrong is the same class of defect as
      // reporting an encrypted pod as an empty one.
      expect(res.stderr).toMatch(/NOT sealed/i);
      expect(res.stderr).not.toMatch(/incorrect passphrase/i);
      // The remedy has to SURVIVE the reason-length cap, which truncates from
      // the right. A diagnosis with its next step cut off is half a message.
      expect(res.stderr).toContain('cascade pod encrypt');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'encryption manifest missing: exits 2 rather than parsing ciphertext as nothing',
    () => {
      const pod = copyOfSealedPod(`${name}-manifestless`);
      fs.rmSync(path.join(pod, 'settings', 'encryption.json'));

      const res = runCli(argv(pod), PASSPHRASE);
      expect(res.exitCode, `stdout: ${res.stdout}`).toBe(2);
      expect(res.stdout).not.toContain(spec.successMustContain!);
    },
    TEST_TIMEOUT_MS,
  );
});

// ─── pod erase: "not found" must never mean "did not look" ────────────────────

describe('read conformance: pod erase distinguishes unreadable from absent', () => {
  it(
    'exits 2, not "not found", when a file it could not read might hold the record',
    () => {
      const pod = copyOfSealedPod('erase-unreadable');
      // Leave the bucket holding the record in the clear: the search cannot
      // open it, so the record is nowhere it CAN look.
      fs.writeFileSync(
        path.join(pod, 'clinical', 'medications.ttl'),
        '@prefix ex: <http://example.org/> .\nex:s a ex:T .\n',
        'utf-8',
      );

      const res = runCli(
        ['pod', 'erase', pod, '--record', eraseTargetIri, '--confirm'],
        PASSPHRASE,
      );
      expect(res.exitCode, `stdout: ${res.stdout}`).toBe(2);
      expect(res.stderr).toContain('clinical/medications.ttl');
      expect(res.stderr).toContain('not the same as the record not existing');
      expect(res.stderr).not.toMatch(/^ERROR: Record not found in any bucket file/m);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'still says "not found" plainly when everything was readable and it is not there',
    () => {
      const pod = copyOfSealedPod('erase-absent');
      const res = runCli(
        ['pod', 'erase', pod, '--record', 'urn:uuid:no-such-record', '--confirm'],
        PASSPHRASE,
      );
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain('Record not found');
    },
    TEST_TIMEOUT_MS,
  );
});

// ─── pod export: D-CLI-2 ──────────────────────────────────────────────────────

describe('read conformance: pod export refuses an encrypted pod by default', () => {
  it(
    'refuses with exit 1 and explains the choice, even with the correct passphrase',
    () => {
      const pod = copyOfSealedPod('export-refuse');
      const res = runCli(
        ['pod', 'export', pod, '--format', 'directory', '--output', `${pod}-out`],
        PASSPHRASE,
      );
      // Exit 1, not 2: nothing failed to be read. The user has a choice.
      expect(res.exitCode, `stdout: ${res.stdout}`).toBe(1);
      expect(res.stderr).toContain('--allow-encrypted');
      expect(fs.existsSync(`${pod}-out`)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses in every unreadable state too — the refusal does not need the key',
    () => {
      for (const passphrase of [undefined, WRONG_PASSPHRASE]) {
        const pod = copyOfSealedPod('export-refuse-state');
        const res = runCli(
          ['pod', 'export', pod, '--format', 'directory', '--output', `${pod}-out`],
          passphrase,
        );
        expect(res.exitCode, `stdout: ${res.stdout}`).toBe(1);
        expect(res.stderr).toContain('--allow-encrypted');
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'with --allow-encrypted, exports AND stamps the archive with an explanation',
    () => {
      const pod = copyOfSealedPod('export-allowed');
      const out = `${pod}-out`;
      const res = runCli(
        ['pod', 'export', pod, '--format', 'directory', '--output', out, '--allow-encrypted'],
        PASSPHRASE,
      );
      expect(res.exitCode, `stderr: ${res.stderr}`).toBe(0);

      const notice = path.join(out, 'ENCRYPTED-EXPORT-README.md');
      expect(fs.existsSync(notice), 'the export carries no explanation of its ciphertext').toBe(true);
      const text = fs.readFileSync(notice, 'utf-8');
      expect(text).toContain('encrypted');
      expect(text).toContain('cascade pod decrypt');
      // And the pod itself really is in there.
      expect(fs.existsSync(path.join(out, 'clinical', 'medications.ttl'))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stamps the zip form too',
    () => {
      const pod = copyOfSealedPod('export-zip');
      const zipPath = path.join(root, `${path.basename(pod)}.zip`);
      const res = runCli(
        ['pod', 'export', pod, '--format', 'zip', '--output', zipPath, '--allow-encrypted'],
        PASSPHRASE,
      );
      expect(res.exitCode, `stderr: ${res.stderr}`).toBe(0);
      expect(fs.existsSync(zipPath)).toBe(true);
      // adm-zip is already a dependency; read the entry names back.
      const raw = fs.readFileSync(zipPath, 'utf-8');
      expect(raw).toContain('ENCRYPTED-EXPORT-README.md');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a plaintext pod exports exactly as before, with no notice and no flag',
    () => {
      const plainPod = path.join(root, 'plain-pod');
      const init = runCli(['pod', 'init', plainPod]);
      expect(init.exitCode, init.stderr).toBe(0);

      const out = `${plainPod}-out`;
      const res = runCli(['pod', 'export', plainPod, '--format', 'directory', '--output', out]);
      expect(res.exitCode, res.stderr).toBe(0);
      expect(fs.existsSync(path.join(out, 'ENCRYPTED-EXPORT-README.md'))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

// ─── The MCP read tools ───────────────────────────────────────────────────────
//
// Not commander subcommands, and therefore not in the enumeration above, but
// the same door and the same matrix. An agent restates whatever it is handed,
// so a successful result with `totalRecords: 0` over a sealed pod is not a soft
// failure — it is a confident false statement about someone's health record.

type McpHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

const MCP_TOOLS: Array<[string, McpHandler, Record<string, unknown>]> = [
  ['cascade_pod_read', podReadHandler as McpHandler, {}],
  ['cascade_pod_query', podQueryHandler as McpHandler, { dataType: 'all' }],
];

/** Parse the single JSON payload an MCP tool result carries. */
function mcpPayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe.each(MCP_TOOLS)('read conformance: MCP %s', (name, handler, extraArgs) => {
  const call = async (pod: string, passphrase?: string): Promise<Record<string, unknown>> => {
    const previous = process.env.CASCADE_POD_PASSPHRASE;
    if (passphrase === undefined) delete process.env.CASCADE_POD_PASSPHRASE;
    else process.env.CASCADE_POD_PASSPHRASE = passphrase;
    try {
      return mcpPayload(await handler({ path: pod, ...extraArgs }));
    } finally {
      if (previous === undefined) delete process.env.CASCADE_POD_PASSPHRASE;
      else process.env.CASCADE_POD_PASSPHRASE = previous;
    }
  };

  it(
    'sealed + correct passphrase: returns the real records',
    async () => {
      const payload = await call(sealedPod, PASSPHRASE);
      expect(payload.error).toBeUndefined();
      expect(payload.totalRecords as number).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'passphrase unset: a typed error, never a successful empty result',
    async () => {
      const payload = await call(sealedPod, undefined);
      expect(payload.error, `${name} returned a successful empty result`).toBeTruthy();
      expect(payload.code).toBe('pod-unreadable');
      expect(payload.reason).toBe('passphrase-missing');
      expect(payload.readable).toBe(false);
      expect(payload.totalRecords).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'wrong passphrase: a typed error naming the state',
    async () => {
      const payload = await call(sealedPod, WRONG_PASSPHRASE);
      expect(payload.code).toBe('pod-unreadable');
      expect(payload.reason).toBe('passphrase-incorrect');
      expect(payload.totalRecords).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'one plaintext stray among sealed files: a typed error naming the file',
    async () => {
      const pod = copyOfSealedPod(`mcp-${name}-stray`);
      fs.writeFileSync(
        path.join(pod, 'clinical', 'medications.ttl'),
        '@prefix ex: <http://example.org/> .\nex:s a ex:T .\n',
        'utf-8',
      );
      const payload = await call(pod, PASSPHRASE);
      expect(payload.code).toBe('pod-files-unreadable');
      expect(payload.files as string[]).toContain('clinical/medications.ttl');
      expect(payload.totalRecords).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'encryption manifest missing: a typed error, not a pod full of nothing',
    async () => {
      const pod = copyOfSealedPod(`mcp-${name}-manifestless`);
      fs.rmSync(path.join(pod, 'settings', 'encryption.json'));
      const payload = await call(pod, PASSPHRASE);
      expect(payload.error).toBeTruthy();
      expect(payload.readable).toBe(false);
      expect(payload.totalRecords).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});
