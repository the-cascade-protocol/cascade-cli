/**
 * Re-key an encrypted pod: a NEW data key, every sealed file re-encrypted under
 * it, and a header with exactly one passphrase wrap. `pod passphrase set
 * --rotate-dek` is the command; this module is the engine.
 *
 * WHY a re-key and not a re-wrap
 * ------------------------------
 * A re-wrap (`pod passphrase set` without the flag) changes which passphrase
 * opens the data key, and nothing else. Anyone who once opened the pod could
 * have kept the data key itself, and that key still opens every file. Cutting
 * such a holder off needs a new data key, which means every sealed file is
 * decrypted and sealed again. Wraps other than the one the current passphrase
 * opened are NOT carried over: their holders' secrets are not available here,
 * and dropping them is the revocation.
 *
 * HOW it stays recoverable
 * ------------------------
 * The pod is never rewritten in place. A complete re-encrypted COPY is built in
 * a sibling folder, verified, and only then swapped in with two renames in the
 * pod's parent directory:
 *
 *   1. Build `.<name>.rekey-<hex>` beside the pod: every file that opens with
 *      the current data key is sealed under the new one; every other file is
 *      copied byte for byte; the header is written last. Every file and
 *      directory is fsynced.
 *   2. Verify the copy: the new passphrase opens its header to the new key; it
 *      holds exactly the expected files; every sealed file decrypts to the same
 *      plaintext hash as the original, and every copied file has the same hash.
 *      Then confirm the pod did not change while the copy was being built.
 *   3. Rename the pod to `.<name>.old-<hex>`, rename the copy to `<name>`,
 *      fsync the parent directory. The second rename is the commit point.
 *   4. Delete the `.old` folder.
 *
 * Any failure before step 3 deletes the copy and leaves the pod untouched. A
 * failure of the second rename renames the pod back. A process that dies
 * outright leaves one of the states {@link planRekeyRecovery} knows, and the
 * next run of the command (or `pod doctor --write`) finishes the job:
 *
 *   - copy only, pod present (died in steps 1 or 2): the copy is deleted. The
 *     CURRENT passphrase opens the pod.
 *   - copy and `.old`, no pod (died between the two renames): the `.old`
 *     folder is renamed back to the pod and the copy is deleted. The CURRENT
 *     passphrase opens the pod.
 *   - `.old` only, pod present (died after the commit point): the `.old`
 *     folder is deleted. The NEW passphrase opens the pod.
 *
 * Symbolic links and anything that is not a regular file or a directory are
 * refused, anywhere in the pod, before anything is written: a link is never
 * followed inside a pod, and a file the copy would silently leave out would be
 * lost when the `.old` folder is deleted.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  readEncryptionManifest,
  unlockManifest,
  generateDek,
  encryptBytes,
  decryptBytes,
  buildPassphraseManifestV11,
  writeEncryptionManifest,
  fsyncDirectory,
  isManifestTempName,
  isPodEncrypted,
  MANIFEST_RELATIVE_PATH,
  EncryptionManifestError,
  PodDecryptError,
} from './pod-encryption.js';
import { atomicWriteBytes, isPlaintextByDesign } from './pod-resources.js';

const MANIFEST_REL = MANIFEST_RELATIVE_PATH.split(path.sep).join('/');

/** The step boundaries {@link RotateDekOptions.onStep} is called at, in order. */
export type RotateStep =
  /** The copy is complete and durable; nothing has been verified or moved. */
  | 'staged'
  /** The copy verified; the pod has not moved. */
  | 'verified'
  /** The pod was renamed to `.old`; the copy has not been renamed yet. */
  | 'moved-aside'
  /** The copy is now the pod (the commit point); `.old` still exists. */
  | 'swapped';

/** Options for {@link rotateDataKey}. */
export interface RotateDekOptions {
  /** KDF parameters for the new wrap. Defaults to the tool's defaults. */
  kdf?: { t: number; m: number; p: number };
  /** Clock for the new wrap's `createdAt`. */
  now?: () => Date;
  /**
   * Writes one file of the copy. Defaults to the atomic, fsynced write every
   * pod write uses. Exists so a test can stand in a writer that damages one
   * file and prove verification refuses the copy.
   */
  writeStaged?: (absPath: string, bytes: Buffer, mode: number) => void;
  /**
   * Called at each step boundary, in order. Exists so a test can stop the
   * process at a boundary and prove the next run recovers.
   */
  onStep?: (step: RotateStep) => void;
}

/** What a successful re-key did. No secret, no salt. */
export interface RotateDekResult {
  manifestVersion: '1.1';
  wrapCount: 1;
  /** `createdAt` of the one wrap in the new header. */
  createdAt: string;
  /** Files that opened with the old data key and were sealed under the new one. */
  resealed: number;
  /** Files that did not open with the old data key, copied byte for byte. */
  copied: number;
  /** Of `copied`, the files that are plaintext by design (the header aside). */
  plaintextByDesign: number;
  /**
   * Set when the re-key committed but the moved-aside old pod could not be
   * deleted: its path. It still opens with the OLD passphrase. The next run of
   * {@link recoverInterruptedRekey} deletes it.
   */
  oldCopyLeft: string | null;
}

/**
 * A re-key refused or failed. `exitCode` follows docs/exit-codes.md; `reason`
 * and `files` are set only where the documented reason vocabulary applies.
 */
export class RotateDekError extends Error {
  readonly exitCode: 1 | 2;
  readonly reason?: 'files-unreadable';
  readonly files?: string[];

  constructor(message: string, exitCode: 1 | 2 = 1, detail: { reason?: 'files-unreadable'; files?: string[] } = {}) {
    super(message);
    this.name = 'RotateDekError';
    this.exitCode = exitCode;
    if (detail.reason) this.reason = detail.reason;
    if (detail.files) this.files = detail.files;
  }
}

// ─── Sibling folder names ─────────────────────────────────────────────────────

const HEX12 = /^[0-9a-f]{12}$/;

function stagingName(podName: string, hex: string): string {
  return `.${podName}.rekey-${hex}`;
}

function oldName(podName: string, hex: string): string {
  return `.${podName}.old-${hex}`;
}

/** The pod's parent directory and its own folder name. */
function podLocation(podDir: string): { parent: string; name: string } {
  const abs = path.resolve(podDir);
  const name = path.basename(abs);
  if (name === '' || abs === path.dirname(abs)) {
    throw new RotateDekError(`Cannot re-key a pod at a filesystem root: ${abs}.`);
  }
  return { parent: path.dirname(abs), name };
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function isRealDirectory(p: string): boolean {
  const st = lstatOrNull(p);
  return st !== null && st.isDirectory();
}

// ─── Walking the pod ──────────────────────────────────────────────────────────

interface WalkedFile {
  rel: string;
  mode: number;
  size: bigint;
  mtimeNs: bigint;
  ino: bigint;
}

interface WalkedDir {
  rel: string;
  mode: number;
}

interface PodTree {
  dirs: WalkedDir[];
  files: WalkedFile[];
  /** Symbolic links and other non-regular entries, pod-relative. */
  refused: string[];
}

/**
 * Every entry in the pod, dotted ones included: the copy replaces the pod, so
 * anything left out of it is lost. `lstat`, never `stat`, so a symbolic link is
 * seen as one and never followed.
 */
function walkPod(root: string): PodTree {
  const tree: PodTree = { dirs: [], files: [], refused: [] };
  const walk = (dirAbs: string, dirRel: string): void => {
    const names = fs.readdirSync(dirAbs).sort();
    for (const name of names) {
      const abs = path.join(dirAbs, name);
      const rel = dirRel === '' ? name : `${dirRel}/${name}`;
      const st = fs.lstatSync(abs, { bigint: true });
      if (st.isDirectory()) {
        tree.dirs.push({ rel, mode: Number(st.mode & 0o7777n) });
        walk(abs, rel);
      } else if (st.isFile()) {
        tree.files.push({ rel, mode: Number(st.mode & 0o7777n), size: st.size, mtimeNs: st.mtimeNs, ino: st.ino });
      } else {
        tree.refused.push(rel);
      }
    }
  };
  walk(root, '');
  return tree;
}

/** Nothing about any file or directory changed between two walks. */
function sameTree(a: PodTree, b: PodTree): string | null {
  const key = (f: WalkedFile): string => `${f.size}:${f.mtimeNs}:${f.ino}`;
  const before = new Map(a.files.map((f) => [f.rel, key(f)]));
  const after = new Map(b.files.map((f) => [f.rel, key(f)]));
  for (const [rel, k] of before) {
    if (after.get(rel) !== k) return rel;
  }
  for (const rel of after.keys()) if (!before.has(rel)) return rel;
  const dirsA = a.dirs.map((d) => d.rel).join('\n');
  const dirsB = b.dirs.map((d) => d.rel).join('\n');
  if (dirsA !== dirsB) return '(a folder)';
  if (b.refused.length > 0) return b.refused[0];
  return null;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const MAX_LISTED = 10;

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED).map((p) => `  - ${p}`);
  if (paths.length > MAX_LISTED) shown.push(`  ... and ${paths.length - MAX_LISTED} more`);
  return shown.join('\n');
}

// ─── Recovery from an interrupted re-key ──────────────────────────────────────

/** One interrupted re-key found beside a pod, and what finishing it does. */
export interface RekeyRecoveryStep {
  hex: string;
  /**
   *  - `delete-staging` the copy was never swapped in; the pod is as it was.
   *  - `roll-back`      the pod was moved aside and the copy not yet swapped
   *                     in: the pod is moved back and the copy deleted.
   *  - `complete`       the copy is the pod; the old pod is deleted.
   */
  action: 'delete-staging' | 'roll-back' | 'complete';
  /** Absolute paths of the folders involved. */
  staging: string | null;
  old: string | null;
}

/**
 * The interrupted re-keys beside `podDir`, and what finishing each one does.
 * Reads only. Leftovers are matched by name: `.<name>.rekey-<hex>` and
 * `.<name>.old-<hex>` with the same 12 hex digits, and only real directories.
 *
 * @throws {RotateDekError} when the folders are in a state no run of this tool
 *   leaves (a copy with no pod and no `.old`, a pod AND `.old` AND a copy, or
 *   more than one `.old`). Nothing is touched then: the only safe move is a
 *   person's.
 */
export function planRekeyRecovery(podDir: string): RekeyRecoveryStep[] {
  const { parent, name } = podLocation(podDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(parent);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const stagingPrefix = `.${name}.rekey-`;
  const oldPrefix = `.${name}.old-`;
  const groups = new Map<string, { staging: string | null; old: string | null }>();
  for (const entry of entries) {
    let hex: string | null = null;
    let kind: 'staging' | 'old' | null = null;
    if (entry.startsWith(stagingPrefix)) {
      hex = entry.slice(stagingPrefix.length);
      kind = 'staging';
    } else if (entry.startsWith(oldPrefix)) {
      hex = entry.slice(oldPrefix.length);
      kind = 'old';
    }
    if (!hex || !kind || !HEX12.test(hex)) continue;
    const abs = path.join(parent, entry);
    if (!isRealDirectory(abs)) continue;
    const g = groups.get(hex) ?? { staging: null, old: null };
    g[kind] = abs;
    groups.set(hex, g);
  }
  if (groups.size === 0) return [];

  const podPresent = isRealDirectory(path.join(parent, name));
  const podPath = path.join(parent, name);
  const steps: RekeyRecoveryStep[] = [];
  const unclear = (why: string): RotateDekError =>
    new RotateDekError(
      `Found folders from an interrupted re-key beside ${podPath} that this tool will not resolve on its own: ${why}. ` +
        `Nothing was changed. Check them by hand:\n` +
        listPaths([...groups.values()].flatMap((g) => [g.staging, g.old]).filter((p): p is string => p !== null)),
    );

  const withOld = [...groups.values()].filter((g) => g.old !== null).length;
  if (withOld > 1) throw unclear('more than one moved-aside pod');

  for (const [hex, g] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (g.old === null) {
      // A copy that was never swapped in. Deleting it is safe only while the
      // pod it was copied from is still there.
      if (!podPresent) throw unclear('a re-encrypted copy with no pod beside it');
      steps.push({ hex, action: 'delete-staging', staging: g.staging, old: null });
    } else if (podPresent) {
      // The copy was swapped in (the commit point) and the old pod not yet
      // deleted. A copy of the same run can no longer exist: the swap renamed it.
      if (g.staging !== null) throw unclear('a pod, a moved-aside pod and a copy all at once');
      if (!isPodEncrypted(podPath)) throw unclear('the pod beside a moved-aside pod is not encrypted');
      steps.push({ hex, action: 'complete', staging: null, old: g.old });
    } else {
      steps.push({ hex, action: 'roll-back', staging: g.staging, old: g.old });
    }
  }
  return steps;
}

/**
 * Finish every interrupted re-key beside `podDir`, as {@link planRekeyRecovery}
 * plans it, and return what was done. Nothing needs a passphrase: rolling back
 * restores the pod that was there before, and completing only deletes the old
 * copy of a swap that already committed.
 *
 * @throws {RotateDekError} as {@link planRekeyRecovery}, touching nothing.
 */
export function recoverInterruptedRekey(podDir: string): RekeyRecoveryStep[] {
  const steps = planRekeyRecovery(podDir);
  const { parent, name } = podLocation(podDir);
  const podPath = path.join(parent, name);
  for (const step of steps) {
    if (step.action === 'roll-back') {
      // Restore the pod first, then drop the copy: a crash in between leaves
      // "copy only, pod present", which the next run deletes.
      fs.renameSync(step.old as string, podPath);
      fsyncDirectory(parent);
      if (step.staging) fs.rmSync(step.staging, { recursive: true, force: true });
    } else if (step.action === 'delete-staging') {
      fs.rmSync(step.staging as string, { recursive: true, force: true });
    } else {
      fs.rmSync(step.old as string, { recursive: true, force: true });
    }
  }
  if (steps.length > 0) fsyncDirectory(parent);
  return steps;
}

// ─── The re-key ───────────────────────────────────────────────────────────────

interface PlannedFile extends WalkedFile {
  /** `reseal`: opened with the old key. `copy`: did not; copied byte for byte. */
  how: 'reseal' | 'copy';
  /** sha256 of the plaintext (reseal) or of the bytes (copy). */
  hash: string;
}

/**
 * Re-key the pod at `podDir`: see the module comment for the steps and the
 * recovery behaviour. Call {@link recoverInterruptedRekey} first; this refuses
 * to start while folders from an interrupted re-key are still beside the pod.
 *
 * @throws {EncryptionManifestError} the header is malformed or from a newer tool.
 * @throws {PodDecryptError} the current passphrase opens no wrap.
 * @throws {RotateDekError} every other refusal or failure; the pod is untouched.
 */
export function rotateDataKey(
  podDir: string,
  currentPassphrase: string,
  newPassphrase: string,
  options: RotateDekOptions = {},
): RotateDekResult {
  if (newPassphrase.length === 0) throw new RotateDekError('The new passphrase cannot be empty.');
  if (newPassphrase === currentPassphrase) {
    throw new RotateDekError('The new passphrase is the same as the current one.');
  }
  const { parent, name } = podLocation(podDir);
  const podPath = path.join(parent, name);
  const podStat = lstatOrNull(podPath);
  if (podStat === null) throw new RotateDekError(`Pod not found at ${podPath}.`);
  if (podStat.isSymbolicLink()) {
    throw new RotateDekError(`The pod path is a symbolic link: ${podPath}. Re-key the folder it points to by its own path.`);
  }
  if (!podStat.isDirectory()) throw new RotateDekError(`Pod not found at ${podPath} (not a directory).`);
  if (planRekeyRecovery(podPath).length > 0) {
    throw new RotateDekError(`An interrupted re-key of ${podPath} has not been finished yet.`);
  }

  const manifest = readEncryptionManifest(podPath);
  if (!manifest) throw new RotateDekError(`Pod is not encrypted: ${podPath}.`);
  const opened = unlockManifest(manifest, currentPassphrase);
  const oldDek = opened.dek;
  const label = manifest.wraps[opened.wrapIndex].label ?? 'primary';
  const manifestMode = fs.statSync(path.join(podPath, MANIFEST_RELATIVE_PATH)).mode & 0o777;

  let newDek: Buffer | undefined;
  let staging: string | undefined;
  let swapped = false;
  try {
    // ── Walk. Refuse links and special files before anything is written. ──
    const before = walkPod(podPath);
    if (before.refused.length > 0) {
      throw new RotateDekError(
        `Cannot re-key: the pod holds ${before.refused.length} symbolic link(s) or special file(s), ` +
          `which are never followed or copied. Nothing was changed.\n${listPaths(before.refused)}`,
      );
    }

    // ── Step 1: build the copy. ──
    const hex = randomBytes(6).toString('hex');
    const stagingPath = path.join(parent, stagingName(name, hex));
    // Create-new: a folder already at this name is never adopted, and never
    // deleted by the cleanup below, which only runs once this call made it.
    fs.mkdirSync(stagingPath, { mode: (podStat.mode & 0o7777) | 0o700 });
    staging = stagingPath;
    fsyncDirectory(parent);
    for (const d of before.dirs) fs.mkdirSync(path.join(staging, d.rel), { mode: d.mode | 0o700 });

    newDek = generateDek();
    const write = options.writeStaged ?? ((abs: string, bytes: Buffer, mode: number) => atomicWriteBytes(abs, bytes, mode));
    const planned: PlannedFile[] = [];
    const unreadable: string[] = [];
    for (const f of before.files) {
      // The header is replaced, and a temporary header a killed write left
      // behind holds a wrap of the OLD key: neither is carried over.
      if (f.rel === MANIFEST_REL) continue;
      if (path.posix.dirname(f.rel) === 'settings' && isManifestTempName(path.posix.basename(f.rel))) continue;
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(path.join(podPath, f.rel));
      } catch {
        unreadable.push(f.rel);
        continue;
      }
      let plain: Buffer | null = null;
      try {
        plain = decryptBytes(bytes, oldDek);
      } catch (e) {
        if (!(e instanceof PodDecryptError)) throw e;
      }
      const target = path.join(staging, f.rel);
      if (plain) {
        planned.push({ ...f, how: 'reseal', hash: sha256(plain) });
        write(target, encryptBytes(plain, newDek), f.mode);
        plain.fill(0);
      } else {
        planned.push({ ...f, how: 'copy', hash: sha256(bytes) });
        write(target, bytes, f.mode);
      }
    }
    if (unreadable.length > 0) {
      throw new RotateDekError(
        `Cannot re-key: ${unreadable.length} file(s) in the pod could not be read. Nothing was changed.\n${listPaths(unreadable)}`,
        2,
        { reason: 'files-unreadable', files: unreadable },
      );
    }

    // The header last, so a copy is never a complete pod before its files are.
    const next = buildPassphraseManifestV11(newDek, newPassphrase, {
      label,
      ...(options.kdf ? { kdf: options.kdf } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    const createdAt = next.wraps[0].createdAt as string;
    writeEncryptionManifest(staging, next, { mode: manifestMode });

    // Every file was fsynced as it was written; now every directory, deepest
    // first, with its own permission bits back, and the parent.
    for (const d of [...before.dirs].reverse()) {
      const abs = path.join(staging, d.rel);
      fs.chmodSync(abs, d.mode);
      fsyncDirectory(abs);
    }
    fs.chmodSync(staging, podStat.mode & 0o7777);
    fsyncDirectory(staging);
    fsyncDirectory(parent);
    options.onStep?.('staged');

    // ── Step 2: verify the copy before anything moves. ──
    verifyCopy(
      staging,
      newPassphrase,
      newDek,
      planned,
      before.dirs.map((d) => d.rel),
    );
    const now = walkPod(podPath);
    const changed = sameTree(before, now);
    if (changed !== null) {
      throw new RotateDekError(
        `Cannot re-key: the pod changed while it was being re-encrypted (${changed}). ` +
          `Nothing was changed; run it again when nothing else is writing to the pod.`,
      );
    }
    options.onStep?.('verified');

    // ── Step 3: swap. The second rename is the commit point. ──
    const old = path.join(parent, oldName(name, hex));
    fs.renameSync(podPath, old);
    fsyncDirectory(parent);
    options.onStep?.('moved-aside');
    try {
      fs.renameSync(staging, podPath);
    } catch (e) {
      try {
        fs.renameSync(old, podPath);
        fsyncDirectory(parent);
      } catch {
        throw new RotateDekError(
          `The re-key stopped between its two renames and could not undo the first ` +
            `(${e instanceof Error ? e.message : String(e)}). Nothing is lost: the pod is at ${old} ` +
            `and its re-encrypted copy at ${staging}. Run the command again, or \`cascade pod doctor --write\`, to put the pod back.`,
        );
      }
      throw new RotateDekError(
        `Cannot re-key: the re-encrypted copy could not be moved into place ` +
          `(${e instanceof Error ? e.message : String(e)}). The pod was put back unchanged.`,
      );
    }
    swapped = true;

    // Past the commit point the new key IS the pod's key, so nothing from here
    // on may turn into a failure: a caller told "failed" would keep believing
    // the old passphrase opens the pod, and could discard the only one that
    // does. A step that goes wrong here is reported alongside the success.
    let oldCopyLeft: string | null = null;
    try {
      fsyncDirectory(parent);
      options.onStep?.('swapped');
      // ── Step 4: the old pod, the last place the old key opened anything. ──
      fs.rmSync(old, { recursive: true, force: true });
      fsyncDirectory(parent);
    } catch {
      if (fs.existsSync(old)) oldCopyLeft = old;
    }

    const resealed = planned.filter((f) => f.how === 'reseal').length;
    const copied = planned.filter((f) => f.how === 'copy');
    return {
      manifestVersion: '1.1',
      wrapCount: 1,
      createdAt,
      resealed,
      copied: copied.length,
      plaintextByDesign: copied.filter((f) => isPlaintextByDesign(f.rel)).length,
      oldCopyLeft,
    };
  } finally {
    oldDek.fill(0);
    newDek?.fill(0);
    if (!swapped && staging !== undefined && fs.existsSync(staging)) {
      // Never leave a copy behind a refusal, unless the pod itself is missing
      // (the undo of the first rename failed): then the copy may be needed.
      if (isRealDirectory(podPath)) fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

/**
 * Prove the copy is the pod under the new key, reading only what is ON DISK.
 *
 * @throws {RotateDekError} naming the first thing that does not match.
 */
function verifyCopy(
  staging: string,
  newPassphrase: string,
  newDek: Buffer,
  planned: PlannedFile[],
  dirs: string[],
): void {
  const fail = (what: string): RotateDekError =>
    new RotateDekError(`The re-encrypted copy did not verify (${what}). The pod was not changed.`);

  let checkDek: Buffer;
  try {
    const header = readEncryptionManifest(staging);
    if (!header) throw fail('it has no encryption header');
    if (header.version !== '1.1' || header.wraps.length !== 1 || header.wraps[0].kind !== 'passphrase') {
      throw fail('its header is not version 1.1 with exactly one passphrase wrap');
    }
    checkDek = unlockManifest(header, newPassphrase).dek;
  } catch (e) {
    if (e instanceof RotateDekError) throw e;
    if (e instanceof EncryptionManifestError || e instanceof PodDecryptError) {
      throw fail(`its header did not open with the new passphrase: ${e.message}`);
    }
    throw e;
  }
  try {
    if (!checkDek.equals(newDek)) throw fail('its header opened to a different key');

    const tree = walkPod(staging);
    if (tree.refused.length > 0) throw fail(`unexpected entry ${tree.refused[0]}`);
    if (tree.dirs.map((d) => d.rel).join('\n') !== dirs.join('\n')) throw fail('its folders differ from the pod');
    const expected = new Set([...planned.map((f) => f.rel), MANIFEST_REL]);
    const found = new Set(tree.files.map((f) => f.rel));
    for (const rel of expected) if (!found.has(rel)) throw fail(`${rel} is missing`);
    for (const rel of found) if (!expected.has(rel)) throw fail(`${rel} is unexpected`);

    for (const f of planned) {
      const bytes = fs.readFileSync(path.join(staging, f.rel));
      if (f.how === 'reseal') {
        let plain: Buffer;
        try {
          plain = decryptBytes(bytes, checkDek);
        } catch {
          throw fail(`${f.rel} does not open with the new key`);
        }
        const same = sha256(plain) === f.hash;
        plain.fill(0);
        if (!same) throw fail(`${f.rel} does not decrypt to the original`);
      } else if (sha256(bytes) !== f.hash) {
        throw fail(`${f.rel} is not a byte-for-byte copy`);
      }
    }
  } finally {
    checkDek.fill(0);
  }
}
