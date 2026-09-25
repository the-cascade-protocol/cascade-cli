/**
 * The re-key's swap when a filesystem call FAILS (as opposed to the process
 * dying, which `pod-passphrase-rotate-dek.test.ts` covers with SIGKILL):
 *
 *  - the second rename fails and the first is undone: the pod is back, opens
 *    with the current passphrase, and nothing is left beside it;
 *  - the second rename fails AND the undo fails: both folders are kept (nothing
 *    is lost), and recovery puts the pod back;
 *  - deleting the old pod fails after the commit point: the re-key is still
 *    reported as done (the new key IS the pod's key), the old copy is named,
 *    and recovery deletes it.
 *
 * `node:fs` is wrapped so individual calls can be made to fail on demand.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

const ctl = vi.hoisted(() => ({
  /** Fail a rename whose destination is this path, this many times. */
  failRenameTo: null as string | null,
  failRenameTimes: 0,
  /** Fail a recursive remove of any path containing this text. */
  failRmContaining: null as string | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrapped = {
    ...actual,
    renameSync: ((from: import('node:fs').PathLike, to: import('node:fs').PathLike) => {
      if (ctl.failRenameTo !== null && String(to) === ctl.failRenameTo && ctl.failRenameTimes > 0) {
        ctl.failRenameTimes -= 1;
        const e = new Error(`EIO: simulated failure, rename '${String(from)}' -> '${String(to)}'`) as NodeJS.ErrnoException;
        e.code = 'EIO';
        throw e;
      }
      return actual.renameSync(from, to);
    }) as typeof actual.renameSync,
    rmSync: ((p: import('node:fs').PathLike, opts?: import('node:fs').RmOptions) => {
      if (ctl.failRmContaining !== null && String(p).includes(ctl.failRmContaining)) {
        const e = new Error(`EACCES: simulated failure, rm '${String(p)}'`) as NodeJS.ErrnoException;
        e.code = 'EACCES';
        throw e;
      }
      return actual.rmSync(p, opts);
    }) as typeof actual.rmSync,
  };
  return { ...wrapped, default: wrapped };
});

import * as fs from 'node:fs';
import {
  generateDek,
  encryptBytes,
  buildPassphraseManifestV11,
  writeEncryptionManifest,
  resolveDek,
  PodDecryptError,
} from '../src/lib/pod-encryption.js';
import { atomicWriteBytes } from '../src/lib/pod-resources.js';
import { rotateDataKey, recoverInterruptedRekey, RotateDekError } from '../src/lib/pod-rekey.js';

const PASS_A = 'test-only passphrase alpha';
const PASS_B = 'test-only passphrase bravo';
const FAST_KDF = { t: 1, m: 64, p: 1 };

const dirs: string[] = [];
afterEach(() => {
  ctl.failRenameTo = null;
  ctl.failRenameTimes = 0;
  ctl.failRmContaining = null;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function libPod(): { root: string; pod: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-rekey-swap-'));
  dirs.push(root);
  const pod = path.join(root, 'pod');
  fs.mkdirSync(path.join(pod, 'clinical'), { recursive: true });
  const dek = generateDek();
  writeEncryptionManifest(pod, buildPassphraseManifestV11(dek, PASS_A, { kdf: FAST_KDF }));
  atomicWriteBytes(path.join(pod, 'index.ttl'), encryptBytes(Buffer.from('# synthetic index\n'), dek));
  atomicWriteBytes(path.join(pod, 'clinical', 'medications.ttl'), encryptBytes(Buffer.from('# synthetic\n'), dek));
  dek.fill(0);
  return { root, pod };
}

function siblings(root: string): string[] {
  return fs.readdirSync(root).filter((n) => /^\.pod\.(rekey|old)-[0-9a-f]{12}$/.test(n)).sort();
}

function catchError(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a throw');
}

describe('re-key swap failures', () => {
  it('the second rename fails: the first is undone and the pod opens with the current passphrase', () => {
    const { root, pod } = libPod();
    ctl.failRenameTo = pod;
    ctl.failRenameTimes = 1;
    const err = catchError(() => rotateDataKey(pod, PASS_A, PASS_B, { kdf: FAST_KDF }));
    expect(err).toBeInstanceOf(RotateDekError);
    expect(err.message).toMatch(/could not be moved into place.*The pod was put back unchanged/);
    expect(ctl.failRenameTimes).toBe(0);
    expect(siblings(root)).toEqual([]);
    expect(resolveDek(pod, PASS_A)).toBeInstanceOf(Buffer);
    expect(() => resolveDek(pod, PASS_B)).toThrow(PodDecryptError);
  });

  it('the second rename and its undo both fail: both folders are kept, and recovery puts the pod back', () => {
    const { root, pod } = libPod();
    ctl.failRenameTo = pod;
    ctl.failRenameTimes = 2;
    const err = catchError(() => rotateDataKey(pod, PASS_A, PASS_B, { kdf: FAST_KDF }));
    expect(err).toBeInstanceOf(RotateDekError);
    expect(err.message).toMatch(/Nothing is lost/);
    expect(fs.existsSync(pod)).toBe(false);
    const left = siblings(root);
    expect(left).toHaveLength(2);
    expect(resolveDek(path.join(root, left.find((n) => n.includes('.old-'))!), PASS_A)).toBeInstanceOf(Buffer);
    expect(resolveDek(path.join(root, left.find((n) => n.includes('.rekey-'))!), PASS_B)).toBeInstanceOf(Buffer);

    expect(recoverInterruptedRekey(pod).map((s) => s.action)).toEqual(['roll-back']);
    expect(siblings(root)).toEqual([]);
    expect(resolveDek(pod, PASS_A)).toBeInstanceOf(Buffer);
  });

  it('deleting the old pod fails after the commit point: reported as done, the old copy named, recovery deletes it', () => {
    const { root, pod } = libPod();
    ctl.failRmContaining = '.pod.old-';
    const result = rotateDataKey(pod, PASS_A, PASS_B, { kdf: FAST_KDF });
    expect(result.wrapCount).toBe(1);
    expect(result.oldCopyLeft).toMatch(/\.pod\.old-[0-9a-f]{12}$/);
    expect(siblings(root)).toEqual([path.basename(result.oldCopyLeft!)]);
    expect(resolveDek(pod, PASS_B)).toBeInstanceOf(Buffer);
    expect(() => resolveDek(pod, PASS_A)).toThrow(PodDecryptError);

    ctl.failRmContaining = null;
    expect(recoverInterruptedRekey(pod).map((s) => s.action)).toEqual(['complete']);
    expect(siblings(root)).toEqual([]);
    expect(resolveDek(pod, PASS_B)).toBeInstanceOf(Buffer);
  });
});
