/**
 * `cascade pod passphrase set <pod-dir> --rotate-dek`: a new data key, every
 * sealed file re-encrypted under it, one wrap in the header.
 *
 * Two halves here (crashes are in `pod-passphrase-rotate-dek-crash.test.ts`):
 *
 *  - Across SEPARATE PROCESSES through `dist/index.js`: re-key a pod with a
 *    synthetic import, then read it in other processes. Every read returns the
 *    same records with the new passphrase; the old one is refused; the old data
 *    key opens nothing; a copy made before still opens with the old passphrase.
 *    Refusals (a missing secret, a wrong current key, links and special files)
 *    leave the whole parent directory byte-identical.
 *  - In process, on the engine: a damaged staged file fails verification with
 *    the pod untouched; a pod that changes mid re-key is not swapped; wraps for
 *    other holders are dropped.
 *
 * All data is synthetic. Passphrases here are test-only values.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  resolveDek,
  decryptBytes,
  encryptBytes,
  generateDek,
  buildPassphraseManifestV11,
  writeEncryptionManifest,
  readEncryptionManifest,
  PodDecryptError,
  type EncryptionManifestV11,
} from '../src/lib/pod-encryption.js';
import { atomicWriteBytes } from '../src/lib/pod-resources.js';
import { rotateDataKey, RotateDekError, recoverInterruptedRekey } from '../src/lib/pod-rekey.js';
import {
  PASS_A,
  PASS_B,
  PASS_C,
  FAST_KDF,
  TIMEOUT,
  cleanupRoots,
  assertDistBuilt,
  mkRoot,
  cli,
  lastStderrJson,
  rotate,
  importedPod,
  hashTree,
  leftovers,
  query,
  records,
  opens,
  sealedFiles,
} from './helpers/rotate-dek.js';

afterEach(cleanupRoots);
beforeAll(assertDistBuilt);

// ── across processes ──────────────────────────────────────────────────────────

describe('pod passphrase set --rotate-dek (separate processes, dist/index.js)', () => {
  it('re-keys: same records with the new key, old key refused, old data key opens nothing, earlier copy still opens with the old key', () => {
    const { root, pod } = importedPod();
    const copy = path.join(root, 'copy-before');
    fs.cpSync(pod, copy, { recursive: true });

    const allBefore = query(pod, PASS_A);
    expect(allBefore.status, allBefore.stderr).toBe(0);
    const infoBefore = cli(['--json', 'pod', 'info', pod], { cur: PASS_A });
    expect(infoBefore.status, infoBefore.stderr).toBe(0);
    const oldDek = resolveDek(copy, PASS_A);
    const sealedBefore = sealedFiles(copy, oldDek);
    expect(sealedBefore.length).toBeGreaterThan(5);

    const r = rotate(pod, { cur: PASS_A, next: PASS_B });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['podDir', 'manifestVersion', 'wrapCount', 'createdAt', 'dataKeyRotated', 'resources']);
    expect(out).toMatchObject({ podDir: pod, manifestVersion: '1.1', wrapCount: 1, dataKeyRotated: true });
    expect(out.resources).toBe(sealedBefore.length);
    expect(out.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(r.stderr).toBe('');

    // No secret, salt or key in anything printed.
    const header = JSON.parse(fs.readFileSync(path.join(pod, 'settings', 'encryption.json'), 'utf-8')) as EncryptionManifestV11;
    for (const secret of [PASS_A, PASS_B, header.wraps[0].kdfParams!.salt, oldDek.toString('base64')]) {
      expect(r.stdout + r.stderr).not.toContain(secret);
    }

    // The staging and .old folders are gone.
    expect(leftovers(root)).toEqual([]);

    // The header: 1.1, ONE wrap, label kept, createdAt as reported.
    expect(header.version).toBe('1.1');
    expect(header.wraps).toHaveLength(1);
    expect(header.wraps[0]).toMatchObject({ by: 'passphrase', label: 'primary', createdAt: out.createdAt });

    // Every read, in its own process, returns the same records with B.
    const allAfter = query(pod, PASS_B);
    expect(allAfter.status, allAfter.stderr).toBe(0);
    expect(records(allAfter.stdout)).toEqual(records(allBefore.stdout));
    const infoAfter = cli(['--json', 'pod', 'info', pod], { cur: PASS_B });
    expect(infoAfter.status, infoAfter.stderr).toBe(0);
    // Everything but the modification time, which the re-write moved on.
    const { lastModified: _was, ...infoWas } = JSON.parse(infoBefore.stdout) as Record<string, unknown>;
    const { lastModified: _now, ...infoNow } = JSON.parse(infoAfter.stdout) as Record<string, unknown>;
    expect(infoNow).toEqual(infoWas);
    expect(infoNow.encrypted).toBe(true);
    const meds = JSON.parse(allAfter.stdout).dataTypes.medications;
    expect(meds.count).toBe(2);

    // A is refused.
    const withA = query(pod, PASS_A);
    expect(withA.status).toBe(2);
    expect(withA.stderr).toMatch(/passphrase did not open it/);

    // A different data key: the same files are sealed, their bytes differ, and
    // the old data key opens none of them.
    const newDek = resolveDek(pod, PASS_B);
    expect(newDek.equals(oldDek)).toBe(false);
    expect(sealedFiles(pod, newDek)).toEqual(sealedBefore);
    expect(sealedFiles(pod, oldDek)).toEqual([]);
    for (const rel of sealedBefore) {
      const was = fs.readFileSync(path.join(copy, rel));
      const now = fs.readFileSync(path.join(pod, rel));
      expect(now.equals(was)).toBe(false);
      expect(() => decryptBytes(now, oldDek)).toThrow(PodDecryptError);
      expect(decryptBytes(now, newDek).equals(decryptBytes(was, oldDek))).toBe(true);
    }
    // Plaintext by design is byte-identical.
    expect(fs.readFileSync(path.join(pod, 'README.md')).equals(fs.readFileSync(path.join(copy, 'README.md')))).toBe(true);

    // The honesty line: a copy made before still opens with A, and not with B.
    const copyWithA = query(copy, PASS_A);
    expect(copyWithA.status, copyWithA.stderr).toBe(0);
    expect(records(copyWithA.stdout)).toEqual(records(allBefore.stdout));
    expect(opens(copy, PASS_B)).toBe(false);
  }, TIMEOUT);

  it('prints the human result without --json', () => {
    const { pod } = importedPod();
    const r = cli(['pod', 'passphrase', 'set', pod, '--rotate-dek'], { cur: PASS_A, next: PASS_B });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^Re-keyed\. Every file is now sealed under a new data key/);
    expect(r.stdout).toMatch(/copy of this pod made before now still opens with the old passphrase/);
    expect(r.stdout).toMatch(/Re-encrypted: \d+/);
  }, TIMEOUT);

  it('help names the flag, the new data key, the environment-only secrets and the earlier-copy caveat', () => {
    const r = cli(['pod', 'passphrase', 'set', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--rotate-dek/);
    expect(r.stdout).toMatch(/With --rotate-dek the pod gets a NEW data key/);
    expect(r.stdout).toMatch(/Both passphrases must be set in the environment/);
    expect(r.stdout).toMatch(/A copy of the pod made before the change still\s+opens with the old passphrase/);
  });

  describe('refusals touch nothing and leave no staging folder', () => {
    function refused(
      pod: string,
      env: { cur?: string; next?: string },
      exitCode: number,
      reason: string | undefined,
      message: RegExp,
    ): void {
      const root = path.dirname(pod);
      const before = hashTree(root);
      const r = rotate(pod, env);
      expect(r.status, r.stderr).toBe(exitCode);
      expect(r.stdout).toBe('');
      const err = lastStderrJson(r.stderr);
      expect(err.error).toMatch(message);
      expect(err.reason).toBe(reason);
      for (const secret of [env.cur, env.next]) if (secret) expect(r.stderr).not.toContain(secret);
      expect(hashTree(root)).toEqual(before);
      expect(leftovers(root)).toEqual([]);
    }

    it('a missing CASCADE_POD_NEW_PASSPHRASE or CASCADE_POD_PASSPHRASE: exit 1, passphrase-missing, no prompt', () => {
      const { pod } = importedPod();
      refused(pod, { cur: PASS_A }, 1, 'passphrase-missing', /CASCADE_POD_NEW_PASSPHRASE/);
      refused(pod, { cur: PASS_A, next: '' }, 1, 'passphrase-missing', /CASCADE_POD_NEW_PASSPHRASE/);
      refused(pod, { next: PASS_B }, 1, 'passphrase-missing', /CASCADE_POD_PASSPHRASE/);
      refused(pod, {}, 1, 'passphrase-missing', /CASCADE_POD_PASSPHRASE and CASCADE_POD_NEW_PASSPHRASE/);
      expect(opens(pod, PASS_A)).toBe(true);
    }, TIMEOUT);

    it('a wrong current key: exit 2, passphrase-incorrect', () => {
      const { pod } = importedPod();
      refused(pod, { cur: 'not the passphrase', next: PASS_B }, 2, 'passphrase-incorrect', /current passphrase does not open this pod/);
      expect(opens(pod, PASS_A)).toBe(true);
      expect(opens(pod, PASS_B)).toBe(false);
    }, TIMEOUT);

    it('the same passphrase twice, a pod that is not encrypted, a pod that does not exist: exit 1', () => {
      const { pod } = importedPod();
      refused(pod, { cur: PASS_A, next: PASS_A }, 1, undefined, /same as the current one/);

      const root = mkRoot();
      const plain = path.join(root, 'pod');
      expect(cli(['pod', 'init', plain]).status).toBe(0);
      refused(plain, { cur: PASS_A, next: PASS_B }, 1, undefined, /not encrypted/);

      const r = rotate(path.join(root, 'nope'), { cur: PASS_A, next: PASS_B });
      expect(r.status).toBe(1);
      expect(lastStderrJson(r.stderr).error).toMatch(/Pod not found/);
    }, TIMEOUT);

    it('a malformed header: exit 2, manifest-malformed', () => {
      const { pod } = importedPod();
      fs.writeFileSync(path.join(pod, 'settings', 'encryption.json'), '{ "version": ');
      refused(pod, { cur: PASS_A, next: PASS_B }, 2, 'manifest-malformed', /Malformed/);
    }, TIMEOUT);

    it('a symbolic link or a FIFO inside the pod is refused, not followed or copied', () => {
      const { root, pod } = importedPod();
      const outside = path.join(root, 'outside.txt');
      fs.writeFileSync(outside, 'outside the pod');
      fs.symlinkSync(outside, path.join(pod, 'clinical', 'link.ttl'));
      refused(pod, { cur: PASS_A, next: PASS_B }, 1, undefined, /symbolic link\(s\) or special file\(s\)[\s\S]*clinical\/link\.ttl/);
      fs.rmSync(path.join(pod, 'clinical', 'link.ttl'));

      const fifo = path.join(pod, 'notes-fifo');
      expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
      refused(pod, { cur: PASS_A, next: PASS_B }, 1, undefined, /notes-fifo/);
      fs.rmSync(fifo);

      expect(rotate(pod, { cur: PASS_A, next: PASS_B }).status).toBe(0);
    }, TIMEOUT);

    it('a pod path that is itself a symbolic link is refused', () => {
      const { root, pod } = importedPod();
      const link = path.join(root, 'pod-link');
      fs.symlinkSync(pod, link);
      const before = hashTree(root);
      const r = rotate(link, { cur: PASS_A, next: PASS_B });
      expect(r.status).toBe(1);
      expect(lastStderrJson(r.stderr).error).toMatch(/symbolic link/);
      expect(hashTree(root)).toEqual(before);
    }, TIMEOUT);

    it('a file the command cannot read: exit 2, files-unreadable, naming it', () => {
      if (process.getuid?.() === 0) return; // root reads everything
      const { root, pod } = importedPod();
      const before = hashTree(root);
      const locked = path.join(pod, 'clinical', 'locked.ttl');
      fs.writeFileSync(locked, 'x');
      fs.chmodSync(locked, 0o000);
      const r = rotate(pod, { cur: PASS_A, next: PASS_B });
      expect(r.status, r.stderr).toBe(2);
      const err = lastStderrJson(r.stderr);
      expect(err.reason).toBe('files-unreadable');
      expect(err.files).toEqual(['clinical/locked.ttl']);
      expect(leftovers(root)).toEqual([]);
      fs.rmSync(locked);
      expect(hashTree(root)).toEqual(before);
      expect(opens(pod, PASS_A)).toBe(true);
    }, TIMEOUT);
  });
});

// ── in process, on the engine ─────────────────────────────────────────────────

/** A small sealed pod made directly with the library, with fast KDF settings. */
function libPod(pass = PASS_A): { root: string; pod: string; dek: Buffer } {
  const root = mkRoot();
  const pod = path.join(root, 'pod');
  fs.mkdirSync(path.join(pod, 'clinical'), { recursive: true });
  fs.mkdirSync(path.join(pod, 'notes', 'deep', 'empty'), { recursive: true });
  fs.mkdirSync(path.join(pod, '.well-known'));
  const dek = generateDek();
  writeEncryptionManifest(pod, buildPassphraseManifestV11(dek, pass, { kdf: FAST_KDF }));
  const seal = (rel: string, text: string): void =>
    atomicWriteBytes(path.join(pod, rel), encryptBytes(Buffer.from(text, 'utf-8'), dek));
  seal('index.ttl', '@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .\n');
  seal('clinical/medications.ttl', '# synthetic medications\n');
  seal('notes/deep/note.ttl', '# a synthetic note\n');
  seal('.well-known/solid', '{"version":"1.0"}'.padEnd(10));
  fs.writeFileSync(path.join(pod, 'README.md'), 'A synthetic pod.\n');
  fs.writeFileSync(path.join(pod, '.DS_Store'), Buffer.from([0, 1, 2, 3, 250, 251]));
  return { root, pod, dek };
}

describe('rotateDataKey (in process)', () => {
  it('re-seals what opened with the old key, copies the rest byte for byte, keeps empty folders', () => {
    const { root, pod, dek } = libPod();
    const result = rotateDataKey(pod, PASS_A, PASS_B, { kdf: FAST_KDF });
    expect(result).toMatchObject({ manifestVersion: '1.1', wrapCount: 1, resealed: 4, copied: 2, plaintextByDesign: 1, oldCopyLeft: null });
    expect(leftovers(root)).toEqual([]);
    const newDek = resolveDek(pod, PASS_B);
    expect(sealedFiles(pod, newDek)).toEqual(['.well-known/solid', 'clinical/medications.ttl', 'index.ttl', 'notes/deep/note.ttl']);
    expect(sealedFiles(pod, dek)).toEqual([]);
    expect(fs.readFileSync(path.join(pod, '.DS_Store'))).toEqual(Buffer.from([0, 1, 2, 3, 250, 251]));
    expect(fs.statSync(path.join(pod, 'notes', 'deep', 'empty')).isDirectory()).toBe(true);
  });

  it('a staged file damaged on write fails verification: the copy is deleted and the pod is byte-identical', () => {
    for (const victim of ['clinical/medications.ttl', 'README.md']) {
      const { root, pod } = libPod();
      const before = hashTree(root);
      let err: unknown;
      try {
        rotateDataKey(pod, PASS_A, PASS_B, {
          kdf: FAST_KDF,
          writeStaged: (abs, bytes, mode) => {
            const out = Buffer.from(bytes);
            if (abs.split(path.sep).join('/').endsWith(`/${victim}`)) out[out.length - 1] ^= 0x01;
            atomicWriteBytes(abs, out, mode);
          },
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RotateDekError);
      expect((err as Error).message).toMatch(/did not verify/);
      expect((err as Error).message).toContain(victim);
      expect(hashTree(root)).toEqual(before);
      expect(leftovers(root)).toEqual([]);
      expect(resolveDek(pod, PASS_A)).toBeInstanceOf(Buffer);
    }
  });

  it('a staged file validly sealed under the NEW key but holding another file\'s plaintext fails verification', () => {
    // GCM alone cannot catch this: the bytes authenticate under the new key.
    // Only the per-file plaintext hash comparison does.
    const { root, pod } = libPod();
    const before = hashTree(root);
    let medications: Buffer | undefined;
    let swapped = false;
    let err: unknown;
    try {
      rotateDataKey(pod, PASS_A, PASS_B, {
        kdf: FAST_KDF,
        writeStaged: (abs, bytes, mode) => {
          const rel = abs.split(path.sep).join('/');
          if (rel.endsWith('/clinical/medications.ttl')) medications = bytes;
          // index.ttl is written after clinical/medications.ttl (sorted walk):
          // put the medications file's new-key ciphertext at index.ttl's path.
          if (rel.endsWith('/index.ttl') && medications) {
            swapped = true;
            atomicWriteBytes(abs, medications, mode);
          } else {
            atomicWriteBytes(abs, bytes, mode);
          }
        },
      });
    } catch (e) {
      err = e;
    }
    expect(swapped).toBe(true);
    expect(err).toBeInstanceOf(RotateDekError);
    expect((err as Error).message).toMatch(/index\.ttl does not decrypt to the original/);
    expect(hashTree(root)).toEqual(before);
    expect(leftovers(root)).toEqual([]);
    expect(resolveDek(pod, PASS_A)).toBeInstanceOf(Buffer);
  });

  it('a pod written to while the copy was built is not swapped', () => {
    const { root, pod } = libPod();
    let err: unknown;
    try {
      rotateDataKey(pod, PASS_A, PASS_B, {
        kdf: FAST_KDF,
        onStep: (s) => {
          if (s === 'staged') fs.writeFileSync(path.join(pod, 'notes', 'late.txt'), 'written mid re-key');
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RotateDekError);
    expect((err as Error).message).toMatch(/the pod changed while it was being re-encrypted \(notes\/late\.txt\)/);
    expect(leftovers(root)).toEqual([]);
    expect(fs.readFileSync(path.join(pod, 'notes', 'late.txt'), 'utf-8')).toBe('written mid re-key');
    expect(resolveDek(pod, PASS_A)).toBeInstanceOf(Buffer);
  });

  it('keeps only the wrap that opened: other holders are dropped, and its label is kept', () => {
    const { pod, dek } = libPod();
    const first = buildPassphraseManifestV11(dek, PASS_A, { kdf: FAST_KDF, label: 'primary' });
    const second = buildPassphraseManifestV11(dek, PASS_C, { kdf: FAST_KDF, label: 'second holder' });
    writeEncryptionManifest(pod, { ...first, wraps: [first.wraps[0], second.wraps[0]] });
    expect(readEncryptionManifest(pod)!.wraps).toHaveLength(2);

    const result = rotateDataKey(pod, PASS_C, PASS_B, { kdf: FAST_KDF });
    expect(result.wrapCount).toBe(1);
    const header = readEncryptionManifest(pod)!;
    expect(header.version).toBe('1.1');
    expect(header.wraps).toHaveLength(1);
    expect(header.wraps[0].label).toBe('second holder');
    expect(() => resolveDek(pod, PASS_A)).toThrow(PodDecryptError);
    expect(() => resolveDek(pod, PASS_C)).toThrow(PodDecryptError);
    expect(resolveDek(pod, PASS_B).equals(dek)).toBe(false);
  });

  it('refuses to start while an interrupted re-key is unfinished, and recovery resolves it', () => {
    const { root, pod } = libPod();
    fs.mkdirSync(path.join(root, '.pod.rekey-0123456789ab'));
    expect(() => rotateDataKey(pod, PASS_A, PASS_B, { kdf: FAST_KDF })).toThrow(/interrupted re-key/);
    expect(recoverInterruptedRekey(pod).map((s) => s.action)).toEqual(['delete-staging']);
    expect(leftovers(root)).toEqual([]);
    expect(rotateDataKey(pod, PASS_A, PASS_B, { kdf: FAST_KDF }).wrapCount).toBe(1);
  });

  it('will not guess: a copy with no pod and no moved-aside pod is left alone', () => {
    const root = mkRoot();
    const pod = path.join(root, 'pod');
    fs.mkdirSync(path.join(root, '.pod.rekey-0123456789ab'));
    expect(() => recoverInterruptedRekey(pod)).toThrow(/will not resolve on its own/);
    expect(leftovers(root)).toEqual(['.pod.rekey-0123456789ab']);
  });
});
