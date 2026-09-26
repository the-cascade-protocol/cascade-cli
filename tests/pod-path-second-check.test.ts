/**
 * The pod path chokepoint's SECOND check stands on its own.
 *
 * `resolveInPod` refuses a link it sees with `lstat`, and then, independently,
 * refuses any path whose resolved location is outside the pod root. The second
 * check is what still holds when the first is blind: a link swapped in between
 * the `lstat` and the use, or a platform whose `lstat` misreports. Here `lstat`
 * is made blind on purpose (it never reports a link), so the only thing left
 * between a linked folder and a read outside the pod is the second check.
 *
 * Its own file because `vi.mock` is module-scoped.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const blindLstat = ((p: string, opts?: unknown) => {
    const st = (actual.lstatSync as (p: string, o?: unknown) => import('node:fs').Stats)(p, opts);
    if (st && st.isSymbolicLink()) {
      const target = actual.statSync(p);
      return Object.assign(Object.create(Object.getPrototypeOf(target)), target, {
        isSymbolicLink: () => false,
      });
    }
    return st;
  }) as typeof actual.lstatSync;
  return { ...actual, lstatSync: blindLstat, default: { ...actual, lstatSync: blindLstat } };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PodPathError, resolveInPod } from '../src/lib/pod-path.js';

describe('resolveInPod second check: the resolved path must be inside the pod root', () => {
  it('refuses a folder link out of the pod even when lstat does not report it', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-second-check-')));
    try {
      const pod = path.join(root, 'pod');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(pod);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'medications.ttl'), '# elsewhere\n');
      fs.symlinkSync(outside, path.join(pod, 'clinical'), 'dir');

      // The blind lstat really is blind: the first check cannot see this link.
      expect(fs.lstatSync(path.join(pod, 'clinical')).isSymbolicLink()).toBe(false);

      let err: unknown;
      try {
        resolveInPod(pod, 'clinical/medications.ttl');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PodPathError);
      expect((err as PodPathError).reason).toBe('outside-pod');

      // Control: an ordinary path inside the pod still resolves.
      fs.mkdirSync(path.join(pod, 'notes'));
      expect(resolveInPod(pod, 'notes/a.ttl')).toBe(path.join(pod, 'notes', 'a.ttl'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
