/**
 * THE PATH CHOKEPOINT: every read and write of a file or folder inside a pod
 * resolves its path here first.
 *
 * A pod is a folder anyone can hand to a person (a zip, a synced folder, a git
 * clone), so everything inside it is attacker-shaped input, including its
 * STRUCTURE. A record file or a container that is a symbolic link leads a
 * plain `path.join(pod, 'clinical', 'medications.ttl')` anywhere on the disk,
 * while every component still reads as an ordinary name: a read then returns
 * someone else's records as the patient's, and a write lands outside the pod.
 * Refusing `..` is not enough on its own.
 *
 * The rules (the pod encryption specification, section 8):
 *
 *  1. The pod ROOT is resolved once, following links. The root itself, and
 *     any of its ancestors, may be a link (a pods folder moved to another
 *     disk, `/tmp` on macOS); only what is INSIDE the pod is held to rule 2.
 *  2. Below the root, every existing component is checked with `lstat`, which
 *     does not follow links, and a link anywhere is refused.
 *  3. A pod-relative path must not be absolute and must not contain `..`.
 *  4. As a second, independent check, the deepest existing part of the path
 *     must resolve to somewhere under the root's resolved location.
 *
 * Files are then opened with `O_NOFOLLOW | O_NONBLOCK` and their kind checked
 * on the open handle, so a link or FIFO swapped in after the check is still
 * neither followed nor waited on, and only regular files are resources.
 *
 * Mirrors `resolve_in_pod` in the Workbench's `pod_io.rs`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Why a pod path was refused. Stable, machine-readable. */
export type PodPathRefusal =
  /** A component below the pod root is a symbolic link. */
  | 'symlink-in-pod'
  /** The path resolves outside the pod root. */
  | 'outside-pod'
  /** Absolute where a pod-relative path was expected, or contains `..`. */
  | 'unsafe-pod-path'
  /** A file operation met something that is not a regular file. */
  | 'not-regular-file';

/**
 * One sentence per refusal. None of them names where a link points: that is
 * the attacker's choice of words.
 */
const REFUSAL_TEXT: Record<PodPathRefusal, string> = {
  'symlink-in-pod': 'refused a symbolic link inside the pod (a pod never follows one)',
  'outside-pod': 'refused a path that resolves outside the pod',
  'unsafe-pod-path': 'refused an unsafe pod path (absolute, or containing "..")',
  'not-regular-file': 'refused a pod entry that is not a regular file',
};

/** A pod path this tool will not read or write. Never a statement about the key. */
export class PodPathError extends Error {
  readonly reason: PodPathRefusal;
  /** The pod-relative path, forward slashes (or the input, when it had none). */
  readonly relPath: string;

  constructor(reason: PodPathRefusal, relPath: string) {
    super(`${REFUSAL_TEXT[reason]}: ${relPath}`);
    this.name = 'PodPathError';
    this.reason = reason;
    this.relPath = relPath;
  }
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // ENOTDIR: a component above is a file, so nothing exists from here down.
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
}

/** `a` is `b` or lies under it. */
function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The pod-relative components of `target`.
 *
 * `target` may be pod-relative (`clinical/medications.ttl`) or an absolute
 * path a caller built by joining onto the pod (`path.join(pod, ...)`). An
 * absolute path is accepted only when it lies under the pod, compared both
 * as written and through the root's resolved location (so a caller holding
 * the `/private/tmp/...` spelling of a `/tmp/...` pod is still inside).
 */
function podComponents(root: string, rootReal: string | null, target: string): string[] {
  let rel: string;
  if (path.isAbsolute(target)) {
    const abs = path.resolve(target);
    if (isWithin(abs, root)) rel = path.relative(root, abs);
    else if (rootReal !== null && isWithin(abs, rootReal)) rel = path.relative(rootReal, abs);
    else throw new PodPathError('outside-pod', target);
  } else {
    // Judged BEFORE normalizing: `a/../../b` must not be tidied into a path
    // that looks safe.
    const raw = target.split(/[\\/]+/).filter((c) => c !== '' && c !== '.');
    if (raw.includes('..')) throw new PodPathError('unsafe-pod-path', target);
    rel = raw.join(path.sep);
  }
  const parts = rel === '' ? [] : rel.split(path.sep).filter((c) => c !== '' && c !== '.');
  if (parts.includes('..')) throw new PodPathError('unsafe-pod-path', target);
  return parts;
}

function rootRealpath(root: string): string | null {
  try {
    return fs.realpathSync(root);
  } catch {
    return null; // The pod does not exist (yet): nothing inside it can be a link.
  }
}

/**
 * Resolve a path inside a pod, refusing anything that could leave it.
 *
 * Returns the absolute path, spelled under the pod directory as given (never
 * the resolved spelling, so messages and relative paths stay the caller's).
 *
 * @param podDir the pod root; it and its ancestors may be symbolic links.
 * @param target a pod-relative path, or an absolute path under the pod.
 * @throws {PodPathError} on a link below the root, `..`, an absolute path
 *   outside the pod, or a path that resolves outside the pod.
 */
export function resolveInPod(podDir: string, target: string): string {
  const root = path.resolve(podDir);
  const rootReal = rootRealpath(root);
  const parts = podComponents(root, rootReal, target);
  const relPath = parts.join('/');

  let here = root;
  let deepest = root;
  for (const part of parts) {
    here = path.join(here, part);
    const st = lstatOrNull(here);
    if (st === null) break; // nothing exists from here down, so nothing below can be a link
    if (st.isSymbolicLink()) throw new PodPathError('symlink-in-pod', relPath);
    deepest = here;
  }
  if (rootReal !== null) {
    let resolved: string;
    try {
      resolved = fs.realpathSync(deepest);
    } catch {
      throw new PodPathError('outside-pod', relPath);
    }
    if (!isWithin(resolved, rootReal)) throw new PodPathError('outside-pod', relPath);
  }
  return parts.length === 0 ? root : path.join(root, ...parts);
}

/** The pod-relative spelling of a path inside the pod, forward slashes. */
export function podRelativePath(podDir: string, target: string): string {
  const root = path.resolve(podDir);
  return podComponents(root, rootRealpath(root), target).join('/');
}

/**
 * What is at a pod path, judged without following a link: `null` when nothing
 * is there. Refuses (throws) the same paths {@link resolveInPod} does, so a
 * link is never reported as "absent" and then written through.
 */
export function podEntryKind(podDir: string, target: string): 'file' | 'directory' | 'other' | null {
  const st = lstatOrNull(resolveInPod(podDir, target));
  if (st === null) return null;
  if (st.isFile()) return 'file';
  if (st.isDirectory()) return 'directory';
  return 'other';
}

/** Is anything at this pod path? A link below the root throws, never "no". */
export function podPathExists(podDir: string, target: string): boolean {
  return podEntryKind(podDir, target) !== null;
}

/**
 * For "skip it when it is absent" checks: true when anything is at the path,
 * AND when the path is refused. A refused path is then handed to the read or
 * write that follows, which reports the refusal, rather than being skipped as
 * if the pod simply did not have that file.
 */
export function podPathPresentOrRefused(podDir: string, target: string): boolean {
  try {
    return podPathExists(podDir, target);
  } catch (e) {
    if (e instanceof PodPathError) return true;
    throw e;
  }
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

/** Open a pod FILE: no link in any component, never blocking, regular files only. */
function openPodFile(podDir: string, target: string, flags: number, mode?: number): number {
  const abs = resolveInPod(podDir, target);
  const rel = podRelativePath(podDir, abs);
  const st = lstatOrNull(abs);
  if (st !== null && !st.isFile()) throw new PodPathError('not-regular-file', rel);
  let fd: number;
  try {
    fd = fs.openSync(abs, flags | NOFOLLOW | NONBLOCK, mode);
  } catch (e) {
    // ELOOP (EMLINK on some BSDs): a link was swapped in after the check.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') throw new PodPathError('symlink-in-pod', rel);
    if (code === 'EISDIR' || code === 'ENXIO') throw new PodPathError('not-regular-file', rel);
    throw e;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new PodPathError('not-regular-file', rel);
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  return fd;
}

/** Read a pod file's bytes. @throws {PodPathError} */
export function readPodFile(podDir: string, target: string): Buffer {
  const fd = openPodFile(podDir, target, fs.constants.O_RDONLY);
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write a pod file in place (create or truncate), never through a link. The
 * parent folder must exist; see {@link mkdirInPod}. An existing file keeps its
 * permission bits. @throws {PodPathError}
 */
export function writePodFile(podDir: string, target: string, bytes: Buffer | string, mode?: number): void {
  const fd = openPodFile(
    podDir,
    target,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    mode ?? 0o666,
  );
  try {
    fs.writeFileSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

/** Append to a pod file (creating it), never through a link. @throws {PodPathError} */
export function appendPodFile(podDir: string, target: string, bytes: Buffer | string): void {
  const fd = openPodFile(podDir, target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o666);
  try {
    fs.writeFileSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Create a folder inside a pod, and any missing folders above it, one
 * component at a time. `mkdir -p` follows links, so a pod carrying
 * `clinical -> /elsewhere` would otherwise grow folders outside itself before
 * the first write was refused. Returns the absolute path. @throws {PodPathError}
 */
export function mkdirInPod(podDir: string, target: string, mode?: number): string {
  const abs = resolveInPod(podDir, target);
  const root = path.resolve(podDir);
  const parts = podRelativePath(podDir, abs).split('/').filter((c) => c !== '');
  let here = root;
  for (const [i, part] of parts.entries()) {
    here = path.join(here, part);
    try {
      fs.mkdirSync(here, mode === undefined ? undefined : { mode });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const st = fs.lstatSync(here);
    const rel = parts.slice(0, i + 1).join('/');
    if (st.isSymbolicLink()) throw new PodPathError('symlink-in-pod', rel);
    if (!st.isDirectory()) {
      const err = new Error(`not a directory: ${rel}`) as NodeJS.ErrnoException;
      err.code = 'ENOTDIR';
      throw err;
    }
  }
  return abs;
}

/** List a pod folder's entries (links show as links; never followed). @throws {PodPathError} */
export function readPodDir(podDir: string, target: string): fs.Dirent[] {
  return fs.readdirSync(resolveInPod(podDir, target), { withFileTypes: true });
}

/** Remove a pod file (a no-op when absent). Refuses a path through a link. @throws {PodPathError} */
export function removePodFile(podDir: string, target: string): void {
  fs.rmSync(resolveInPod(podDir, target), { force: true });
}

/** Everything below a pod root, by kind, pod-relative with forward slashes, sorted. */
export interface PodTree {
  dirs: string[];
  files: string[];
  /** Symbolic links and anything else that is neither a regular file nor a folder. */
  refused: string[];
}

/**
 * Walk a whole pod, dotted entries included, judging every entry with `lstat`:
 * a link is listed under `refused` and never followed. For a caller that
 * copies the pod as a whole (export), where an entry silently left out would
 * be missing from the copy, and one followed would put another folder's files
 * into it.
 */
export function walkPodTree(podDir: string): PodTree {
  const root = path.resolve(podDir);
  const tree: PodTree = { dirs: [], files: [], refused: [] };
  const walk = (dirAbs: string, dirRel: string): void => {
    for (const name of fs.readdirSync(dirAbs).sort()) {
      const abs = path.join(dirAbs, name);
      const rel = dirRel === '' ? name : `${dirRel}/${name}`;
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) {
        tree.dirs.push(rel);
        walk(abs, rel);
      } else if (st.isFile()) {
        tree.files.push(rel);
      } else {
        tree.refused.push(rel);
      }
    }
  };
  walk(root, '');
  return tree;
}

// ─── Durable writes ───────────────────────────────────────────────────────────

/**
 * fsync a directory, so a rename inside it survives a power cut. The one
 * helper for this: {@link atomicWriteFile} uses it after every rename.
 */
export function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (e) {
    // Directories cannot be opened or fsynced on some platforms (Windows).
    // The rename has already happened; this only narrows the crash window.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EISDIR' && code !== 'EPERM' && code !== 'EINVAL' && code !== 'EBADF') throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Options for {@link atomicWriteFile}. */
export interface AtomicWriteOptions {
  /** Permission bits for the new file. Defaults to the process default. */
  mode?: number;
  /** Writes the bytes into the open temporary file. Defaults to a full write. */
  write?: (fd: number, bytes: Buffer) => void;
  /**
   * Runs after the temporary file is written, fsynced and closed, and before
   * the rename. Throwing abandons the write: the temporary file is removed and
   * the target is left as it was.
   */
  beforeRename?: (tempPath: string) => void;
}

/**
 * Write a file so it is never observed half-written, and so the new bytes
 * survive a power cut once this returns. The one helper for this: every
 * atomic write in the tool goes through it. It knows nothing about pods; a
 * pod file goes through {@link atomicWritePodFile}, which resolves the path
 * first.
 *
 * The steps, in this order: create a NEW temporary file in the target's
 * directory (create-new, so it never opens a file or link already at that
 * name, and the same directory, so the rename cannot cross a filesystem),
 * write it, fsync it, close it, rename it over the target, fsync the
 * directory. Without the first fsync the rename can reach the disk before the
 * data, and a power cut leaves the target empty or partial; without the second
 * the rename itself can be lost. Any failure before the rename removes the
 * temporary file.
 */
export function atomicWriteFile(absPath: string, bytes: Buffer, options: AtomicWriteOptions = {}): void {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.${path.basename(absPath)}.${randomBytes(6).toString('hex')}.tmp`);
  let renamed = false;
  try {
    const fd = options.mode === undefined ? fs.openSync(tmp, 'wx') : fs.openSync(tmp, 'wx', options.mode);
    try {
      (options.write ?? ((f: number, b: Buffer) => fs.writeFileSync(f, b)))(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    options.beforeRename?.(tmp);
    fs.renameSync(tmp, absPath);
    renamed = true;
    fsyncDirectory(dir);
  } finally {
    if (!renamed) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best effort: the error that got us here is the one to report */
      }
    }
  }
}

/**
 * {@link atomicWriteFile} for a pod file: the path is resolved through
 * {@link resolveInPod} first, so the temporary file and the rename both land
 * in a real folder inside the pod. The rename replaces whatever is at the
 * target name (a link there is replaced, never written through), but a link
 * there is refused anyway. @throws {PodPathError}
 */
export function atomicWritePodFile(
  podDir: string,
  target: string,
  bytes: Buffer,
  options: AtomicWriteOptions = {},
): void {
  const abs = resolveInPod(podDir, target);
  const st = lstatOrNull(abs);
  if (st !== null && !st.isFile()) throw new PodPathError('not-regular-file', podRelativePath(podDir, abs));
  atomicWriteFile(abs, bytes, options);
}
