/**
 * `pod passphrase set --rotate-dek` killed at each step boundary.
 *
 * A child process runs the re-key engine from `dist/` and SIGKILLs itself when
 * it reaches a step, so no cleanup code runs: the folders are left exactly as
 * a crash leaves them (short of writes not yet fsynced, which the engine
 * fsyncs before each boundary). Then the next run, of the command itself or of
 * `pod doctor --write`, finishes or undoes it, in its own process. At every
 * point the pod opens with exactly one of the two passphrases, never neither.
 *
 * All data is synthetic. Passphrases here are test-only values.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PASS_A,
  PASS_B,
  TIMEOUT,
  REKEY_MODULE,
  cleanupRoots,
  assertDistBuilt,
  cli,
  lastStderrJson,
  rotate,
  importedPod,
  hashTree,
  leftovers,
  query,
  records,
  opens,
} from './helpers/rotate-dek.js';

afterEach(cleanupRoots);
beforeAll(assertDistBuilt);


/**
 * Run the re-key in a child process that SIGKILLs itself when it reaches
 * `step`: no cleanup code runs, exactly as if the machine had stopped there
 * (short of losing writes that were not yet fsynced).
 */
function crashAt(root: string, pod: string, step: string): void {
  const script = path.join(root, 'crash.mjs');
  fs.writeFileSync(
    script,
    `import { rotateDataKey } from ${JSON.stringify(pathToFileURL(REKEY_MODULE).href)};\n` +
      `const [pod, step] = process.argv.slice(2);\n` +
      `rotateDataKey(pod, process.env.CASCADE_POD_PASSPHRASE, process.env.CASCADE_POD_NEW_PASSPHRASE, {\n` +
      `  onStep: (s) => { if (s === step) process.kill(process.pid, 'SIGKILL'); },\n` +
      `});\n` +
      `process.exit(3);\n`,
  );
  const env = { ...process.env, CASCADE_POD_PASSPHRASE: PASS_A, CASCADE_POD_NEW_PASSPHRASE: PASS_B };
  const r = spawnSync(process.execPath, [script, pod, step], { env, encoding: 'utf-8', timeout: 120_000 });
  expect(r.signal, r.stderr).toBe('SIGKILL');
  fs.rmSync(script);
}

/** Exactly one of A and B opens the folder at `pod`. Returns which. */
function theKeyThatOpens(pod: string): 'A' | 'B' {
  const a = opens(pod, PASS_A);
  const b = opens(pod, PASS_B);
  expect(a !== b, `A opens: ${a}, B opens: ${b}`).toBe(true);
  return a ? 'A' : 'B';
}

describe('pod passphrase set --rotate-dek: a crash at each step boundary', () => {
  it('after staging (and after verifying): the pod is untouched and opens with A; the next run deletes the copy and re-keys', () => {
    for (const step of ['staged', 'verified']) {
      const { root, pod } = importedPod();
      const before = records(query(pod, PASS_A).stdout);
      crashAt(root, pod, step);
      const left = leftovers(root);
      expect(left).toHaveLength(1);
      expect(left[0]).toMatch(/^\.pod\.rekey-/);
      expect(theKeyThatOpens(pod)).toBe('A');

      // The next run of the command removes the copy, then re-keys from scratch.
      const r = rotate(pod, { cur: PASS_A, next: PASS_B });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/Removed an unfinished re-encrypted copy/);
      expect(leftovers(root)).toEqual([]);
      expect(theKeyThatOpens(pod)).toBe('B');
      expect(records(query(pod, PASS_B).stdout)).toEqual(before);
    }
  }, TIMEOUT * 2);

  it('between the two renames: nothing is lost; doctor reports it, then rolls back to A', () => {
    const { root, pod } = importedPod();
    const before = records(query(pod, PASS_A).stdout);
    crashAt(root, pod, 'moved-aside');

    // No pod; the moved-aside pod opens with A and the verified copy with B.
    expect(fs.existsSync(pod)).toBe(false);
    const left = leftovers(root).sort();
    expect(left).toHaveLength(2);
    const [oldDir, stagingDir] = [left.find((n) => n.includes('.old-'))!, left.find((n) => n.includes('.rekey-'))!];
    expect(oldDir.slice(-12)).toBe(stagingDir.slice(-12));
    expect(records(query(path.join(root, oldDir), PASS_A).stdout)).toEqual(before);
    expect(records(query(path.join(root, stagingDir), PASS_B).stdout)).toEqual(before);

    // Doctor, dry run: reports, touches nothing, exit 1.
    const treeBefore = hashTree(root);
    const dry = cli(['--json', 'pod', 'doctor', pod]);
    expect(dry.status, dry.stderr).toBe(1);
    expect(JSON.parse(dry.stdout).interruptedRekey).toEqual([
      { action: 'roll-back', status: 'repairable', staging: path.join(root, stagingDir), old: path.join(root, oldDir) },
    ]);
    expect(hashTree(root)).toEqual(treeBefore);

    // Doctor --write: the pod is back, unchanged, and opens with A.
    const fix = cli(['--json', 'pod', 'doctor', pod, '--write']);
    expect(fix.status, fix.stderr).toBe(0);
    expect(JSON.parse(fix.stdout).interruptedRekey[0]).toMatchObject({ action: 'roll-back', status: 'repaired' });
    expect(leftovers(root)).toEqual([]);
    expect(theKeyThatOpens(pod)).toBe('A');
    expect(records(query(pod, PASS_A).stdout)).toEqual(before);
  }, TIMEOUT);

  it('between the two renames: the next run of the command rolls back, then re-keys to B', () => {
    const { root, pod } = importedPod();
    const before = records(query(pod, PASS_A).stdout);
    crashAt(root, pod, 'moved-aside');
    expect(fs.existsSync(pod)).toBe(false);

    const r = rotate(pod, { cur: PASS_A, next: PASS_B });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/moved back unchanged/);
    expect(leftovers(root)).toEqual([]);
    expect(theKeyThatOpens(pod)).toBe('B');
    expect(records(query(pod, PASS_B).stdout)).toEqual(before);
  }, TIMEOUT);

  it('after the second rename (the commit point): the pod opens with B; the next run deletes the old copy', () => {
    const { root, pod } = importedPod();
    const before = records(query(pod, PASS_A).stdout);
    crashAt(root, pod, 'swapped');
    const left = leftovers(root);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^\.pod\.old-/);
    expect(theKeyThatOpens(pod)).toBe('B');

    // The command, run again with the same secrets, finishes the swap. The
    // current passphrase it was given (A) no longer opens the pod, so it then
    // refuses the re-key with the usual reason.
    const r = rotate(pod, { cur: PASS_A, next: PASS_B });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/already put the new key in place/);
    expect(lastStderrJson(r.stderr).reason).toBe('passphrase-incorrect');
    expect(leftovers(root)).toEqual([]);
    expect(theKeyThatOpens(pod)).toBe('B');
    expect(records(query(pod, PASS_B).stdout)).toEqual(before);
  }, TIMEOUT);

  it('after the second rename: doctor --write deletes the old copy too', () => {
    const { root, pod } = importedPod();
    crashAt(root, pod, 'swapped');
    const fix = cli(['pod', 'doctor', pod, '--write']);
    expect(fix.status, fix.stderr).toBe(0);
    expect(fix.stdout).toMatch(/the re-key finished; the new passphrase opens the pod/);
    expect(leftovers(root)).toEqual([]);
    expect(theKeyThatOpens(pod)).toBe('B');
  }, TIMEOUT);
});
