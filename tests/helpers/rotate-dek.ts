/**
 * Shared helpers for the `pod passphrase set --rotate-dek` tests: pods made
 * through the real CLI in separate processes, tree hashes, and the folders a
 * re-key leaves beside a pod. All data is synthetic.
 */

import { expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { decryptBytes } from '../../src/lib/pod-encryption.js';

export const DIST = path.resolve(__dirname, '..', '..', 'dist');
export const CLI = path.join(DIST, 'index.js');
export const REKEY_MODULE = path.join(DIST, 'lib', 'pod-rekey.js');
export const PASS_A = 'test-only passphrase alpha';
export const PASS_B = 'test-only passphrase bravo';
export const PASS_C = 'test-only passphrase charlie';
export const FAST_KDF = { t: 1, m: 64, p: 1 };
export const TIMEOUT = 180_000;

const dirs: string[] = [];

/** Remove every folder {@link mkRoot} made. Register with `afterEach`. */
export function cleanupRoots(): void {
  for (const d of dirs.splice(0)) {
    // A test may leave read-only folders behind on purpose; make them removable.
    spawnSync('chmod', ['-R', 'u+rwx', d]);
    fs.rmSync(d, { recursive: true, force: true });
  }
}

export function mkRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-rotate-dek-'));
  dirs.push(d);
  return d;
}

export function cli(
  args: string[],
  env: { cur?: string; next?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.CASCADE_POD_PASSPHRASE;
  delete childEnv.CASCADE_POD_NEW_PASSPHRASE;
  if (env.cur !== undefined) childEnv.CASCADE_POD_PASSPHRASE = env.cur;
  if (env.next !== undefined) childEnv.CASCADE_POD_NEW_PASSPHRASE = env.next;
  const r = spawnSync(process.execPath, [CLI, ...args], { env: childEnv, input: '', encoding: 'utf-8', timeout: 120_000 });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** The last JSON object a command wrote to stderr. */
export function lastStderrJson(stderr: string): Record<string, unknown> {
  const lines = stderr.trim().split('\n').filter((l) => l.startsWith('{'));
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

export function rotate(pod: string, env: { cur?: string; next?: string }): ReturnType<typeof cli> {
  return cli(['--json', 'pod', 'passphrase', 'set', pod, '--rotate-dek'], env);
}

/** A tiny synthetic FHIR bundle: two medication statements, one condition. */
export function syntheticBundle(): string {
  const med = (id: string, code: string, text: string): object => ({
    fullUrl: `urn:uuid:${id}`,
    resource: {
      resourceType: 'MedicationStatement',
      id,
      status: 'active',
      medicationCodeableConcept: {
        coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code, display: text }],
        text,
      },
    },
  });
  return JSON.stringify({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      med('6f1c1e0a-4d0b-4c1e-9b8a-000000000011', '197361', 'Lisinopril 10 MG'),
      med('6f1c1e0a-4d0b-4c1e-9b8a-000000000012', '860975', 'Metformin 500 MG'),
      {
        fullUrl: 'urn:uuid:6f1c1e0a-4d0b-4c1e-9b8a-000000000013',
        resource: {
          resourceType: 'Condition',
          id: '6f1c1e0a-4d0b-4c1e-9b8a-000000000013',
          code: { coding: [{ system: 'http://snomed.info/sct', code: '38341003', display: 'Hypertension' }], text: 'Hypertension' },
        },
      },
    ],
  });
}

/** An encrypted pod with records, made through the real CLI with passphrase A. */
export function importedPod(): { root: string; pod: string } {
  const root = mkRoot();
  const pod = path.join(root, 'pod');
  const init = cli(['pod', 'init', pod, '--encrypt'], { cur: PASS_A });
  expect(init.status, init.stderr).toBe(0);
  const bundle = path.join(root, 'bundle.json');
  fs.writeFileSync(bundle, syntheticBundle());
  const imp = cli(['pod', 'import', pod, bundle], { cur: PASS_A });
  expect(imp.status, imp.stderr).toBe(0);
  fs.rmSync(bundle);
  return { root, pod };
}

/** sha256 of every file under `dir`, keyed by relative path; directories listed too. */
export function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        out[`${rel}/`] = 'dir';
        walk(full);
      } else if (e.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(full)}`;
      else if (e.isFile()) out[rel] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      else out[rel] = 'special';
    }
  };
  walk(dir);
  return out;
}

/** Sibling folders a re-key leaves, if any. */
export function leftovers(root: string): string[] {
  return fs.readdirSync(root).filter((n) => /^\.pod\.(rekey|old)-[0-9a-f]{12}$/.test(n));
}

export function query(pod: string, pass: string): ReturnType<typeof cli> {
  return cli(['--json', 'pod', 'query', pod, '--all'], { cur: pass });
}

/** The records a `pod query --all` printed, without the pod path it was run on. */
export function records(stdout: string): unknown {
  const out = JSON.parse(stdout) as Record<string, unknown>;
  expect(out.dataTypes).toBeDefined();
  return out.dataTypes;
}

export function opens(pod: string, pass: string): boolean {
  const q = cli(['--json', 'pod', 'query', pod, '--medications'], { cur: pass });
  return q.status === 0;
}

/** Relative paths of every file that opens with `dek`. */
export function sealedFiles(pod: string, dek: Buffer): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          decryptBytes(fs.readFileSync(full), dek);
          out.push(path.relative(pod, full).split(path.sep).join('/'));
        } catch {
          /* not sealed under this key */
        }
      }
    }
  };
  walk(pod);
  return out.sort();
}

/** Fail loudly when `dist/` was not built: several tests run it in a child process. */
export function assertDistBuilt(): void {
  if (!fs.existsSync(CLI) || !fs.existsSync(REKEY_MODULE)) {
    throw new Error('dist/ is missing or stale. Run `npm run build` before `npm test`.');
  }
}
