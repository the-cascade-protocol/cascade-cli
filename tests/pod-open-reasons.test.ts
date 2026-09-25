/**
 * Why an encrypted pod did not open, told apart, through the real command path.
 *
 * A header the tool cannot use is not a wrong passphrase. Reporting it as one
 * sends the user to re-type the one thing that may well be right, and hides a
 * damaged or tampered header behind a message about their memory. So:
 *
 *   - `manifest-malformed`           bad JSON, a strictness rule, a limit
 *   - `manifest-version-unsupported` a version (or only wrap kinds) this tool
 *                                    does not read
 *   - `passphrase-incorrect`         the header parsed; no wrap opened
 *
 * All three are exit 2 ("could not read what exists"). The header is judged
 * before a passphrase is asked for, so a bad header with NO passphrase set is
 * still reported as the header, not as `passphrase-missing`.
 *
 * Each verb runs as a separate process (`node dist/index.js`), because the exit
 * code and the `--json` envelope on stderr are the contract under test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveDek,
  buildPassphraseManifestV10,
  writeEncryptionManifest,
} from '../src/lib/pod-encryption.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'dist', 'index.js');

const PASSPHRASE = 'open-reasons-passphrase';
const WRONG = 'not-the-passphrase';
const TIMEOUT_MS = 120_000;

interface Run {
  stderr: string;
  exitCode: number;
}

function runCli(args: string[], passphrase?: string): Run {
  const env = { ...process.env };
  delete env.CASCADE_POD_PASSPHRASE;
  if (passphrase !== undefined) env.CASCADE_POD_PASSPHRASE = passphrase;
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    env,
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stderr: res.stderr ?? '', exitCode: typeof res.status === 'number' ? res.status : 1 };
}

/** The `--json` error envelope: the last JSON object on stderr. */
function envelope(stderr: string): Record<string, unknown> {
  const line = stderr
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  expect(line, `no JSON envelope on stderr: ${stderr}`).toBeTruthy();
  return JSON.parse(line!) as Record<string, unknown>;
}

let root: string;
let sealedPod: string;
let goodManifest: Record<string, unknown>;

function podWithManifest(name: string, manifestText: string): string {
  const pod = path.join(root, name);
  fs.cpSync(sealedPod, pod, { recursive: true });
  fs.writeFileSync(path.join(pod, 'settings', 'encryption.json'), manifestText, 'utf-8');
  return pod;
}

function mutated(mutate: (m: Record<string, unknown>) => void): string {
  const m = JSON.parse(JSON.stringify(goodManifest)) as Record<string, unknown>;
  mutate(m);
  return JSON.stringify(m, null, 2) + '\n';
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-open-reasons-'));
  sealedPod = path.join(root, 'sealed');
  const init = runCli(['pod', 'init', sealedPod, '--encrypt'], PASSPHRASE);
  expect(init.exitCode, init.stderr).toBe(0);
  // Same key, cheap KDF parameters: every scenario below derives at most once.
  const dek = resolveDek(sealedPod, PASSPHRASE);
  writeEncryptionManifest(sealedPod, buildPassphraseManifestV10(dek, PASSPHRASE, { t: 1, m: 64, p: 1 }));
  goodManifest = JSON.parse(fs.readFileSync(path.join(sealedPod, 'settings', 'encryption.json'), 'utf-8'));
}, TIMEOUT_MS);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * `pod info` carries the machine-readable `reason` in its envelope. `pod query`
 * carries only the `error` sentence, so for it the sentence is what is pinned:
 * it must name the same state in prose.
 */
const VERBS: Array<{ name: string; argv: (pod: string) => string[]; carriesReason: boolean }> = [
  { name: 'pod info', argv: (pod) => ['--json', 'pod', 'info', pod], carriesReason: true },
  { name: 'pod query', argv: (pod) => ['--json', 'pod', 'query', pod, '--all'], carriesReason: false },
];

interface Scenario {
  name: string;
  manifest: () => string;
  passphrase: string | undefined;
  reason: string;
  /** A fragment the envelope's `error` sentence must carry. */
  says: RegExp;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'a header that is not JSON',
    manifest: () => '{ "version": "1.0", ',
    passphrase: PASSPHRASE,
    reason: 'manifest-malformed',
    says: /encryption header is malformed/,
  },
  {
    name: 'a header that is not JSON, with no passphrase set',
    manifest: () => '{ "version": "1.0", ',
    passphrase: undefined,
    reason: 'manifest-malformed',
    says: /no passphrase was tried/,
  },
  {
    name: 'a header outside the limits (m above the ceiling)',
    manifest: () => mutated((m) => void ((m.kdfParams as Record<string, unknown>).m = 131073)),
    passphrase: PASSPHRASE,
    reason: 'manifest-malformed',
    says: /outside this tool's limits \(field: top-level\.kdfParams\.m\)/,
  },
  {
    name: 'a header that breaks a strictness rule (empty wraps)',
    manifest: () => mutated((m) => void (m.wraps = [])),
    passphrase: PASSPHRASE,
    reason: 'manifest-malformed',
    says: /non-empty/,
  },
  {
    name: 'a header version this tool does not read',
    manifest: () => mutated((m) => void (m.version = '1.2')),
    passphrase: PASSPHRASE,
    reason: 'manifest-version-unsupported',
    says: /written by a newer tool/,
  },
  {
    name: 'a header with no wrap kind this tool implements',
    manifest: () => mutated((m) => void (m.wraps = [{ by: 'device-keychain', wrappedDek: 'AAAA' }])),
    passphrase: PASSPHRASE,
    reason: 'manifest-version-unsupported',
    says: /no wrap this tool implements/,
  },
  {
    name: 'a header that parses, and a passphrase that opens no wrap',
    manifest: () => JSON.stringify(goodManifest, null, 2) + '\n',
    passphrase: WRONG,
    reason: 'passphrase-incorrect',
    says: /the passphrase did not open it/,
  },
];

describe('the control: the untouched pod opens', () => {
  for (const verb of VERBS) {
    it(`${verb.name} exits 0 with the right passphrase`, () => {
      const run = runCli(verb.argv(sealedPod), PASSPHRASE);
      expect(run.exitCode, run.stderr).toBe(0);
    }, TIMEOUT_MS);
  }
});

describe('open-failure reasons, each through a separate process', () => {
  for (const [i, s] of SCENARIOS.entries()) {
    for (const verb of VERBS) {
      it(`${verb.name}: ${s.name} -> ${s.reason}, exit 2`, () => {
        const pod = podWithManifest(`s${i}-${verb.name.replace(/\W+/g, '-')}`, s.manifest());
        const run = runCli(verb.argv(pod), s.passphrase);
        expect(run.exitCode, run.stderr).toBe(2);
        const env = envelope(run.stderr);
        if (verb.carriesReason) {
          expect(env.reason).toBe(s.reason);
          expect(env.readable).toBe(false);
        }
        expect(env.error as string).toMatch(s.says);
        if (s.reason !== 'passphrase-incorrect') {
          expect(env.error as string).not.toMatch(/passphrase did not open/);
        }
      }, TIMEOUT_MS);
    }
  }
});
