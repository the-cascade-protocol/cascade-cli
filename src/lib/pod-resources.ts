/**
 * What counts as an encryptable pod resource.
 *
 * ONE authority, used by both `pod encrypt` and `pod decrypt`, because the two
 * directions disagreeing is not a cosmetic bug: it destroys data. The previous
 * implementation enumerated an ALLOWLIST of four directories (`clinical`,
 * `wellness`, `profile`, `settings`) plus three named files. Both commands used
 * it, so both agreed on the wrong answer. Meanwhile DEK-aware writers grew up
 * outside that list: `src/lib/annotations.ts` seals `<pod>/annotations/*.ttl`,
 * and the Cascade Workbench's `migrate_pod` seals essentially the whole pod, so
 * `notes/`, `analysis/`, `literature/`, `reports/`, `sources/` and
 * `investigations/` are ciphertext on any pod the app has opened. `pod decrypt`
 * skipped every one of them, left them as ciphertext, and then deleted
 * `settings/encryption.json` (the only wrapped copy of the DEK), reporting
 * success with a count drawn from the same allowlist.
 *
 * So the rule here is inverted: a pod resource is EVERY file in the pod except
 * an explicitly named few. New containers are covered the day they are created,
 * by construction, rather than when someone remembers to extend a list.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { MIN_ENVELOPE_LEN, decryptBytes, MANIFEST_RELATIVE_PATH } from './pod-encryption.js';

/**
 * Pod-relative paths that stay PLAINTEXT by design. Three entries, and adding a
 * fourth is a decision rather than a convenience: each one is a file anybody
 * holding the disk can read.
 *
 *  - `settings/encryption.json` — holds the wrapped DEK. Sealing it with the key
 *    it protects is circular, and it is the file that must survive a failed
 *    decrypt so nothing becomes unrecoverable.
 *  - `README.md` — the human-facing note `pod init` writes. It describes the
 *    layout and contains no health data; a person who finds an encrypted
 *    directory needs to be able to read what it is.
 *  - `provenance/egress-log.jsonl` — append-only and written by more than one
 *    process (ratified as D-ARE-2). Sealing an append-only log written
 *    concurrently by two processes corrupts it.
 *
 * Must stay in step with `PLAINTEXT_BY_DESIGN` in the Workbench's `pod_io.rs`.
 */
export const PLAINTEXT_BY_DESIGN: readonly string[] = [
  MANIFEST_RELATIVE_PATH.split(path.sep).join('/'),
  'README.md',
  'provenance/egress-log.jsonl',
];

/**
 * Dotted entries are skipped as not-a-pod-resource (`.git`, `.DS_Store`, editor
 * scratch, our own `.tmp` write files) with ONE exception: `.well-known` is a
 * real pod container that `pod init` writes and `pod encrypt` has always sealed.
 */
const DOT_ENTRY_ALLOWLIST = new Set(['.well-known']);

/** Is this pod-relative path one of the by-design plaintext files? */
export function isPlaintextByDesign(relPath: string): boolean {
  return PLAINTEXT_BY_DESIGN.includes(relPath.split(path.sep).join('/'));
}

/** One file in the pod, with its pod-relative path for reporting. */
export interface PodResource {
  /** Absolute path on disk. */
  absPath: string;
  /** Pod-relative path with forward slashes, for messages and JSON output. */
  relPath: string;
}

/**
 * What one enumeration pass found.
 *
 * `plaintextByDesign` is counted rather than dropped so a command can report
 * "and N files are plaintext on purpose" instead of leaving the user to wonder
 * why the pod holds readable bytes.
 */
export interface PodResourceSet {
  resources: PodResource[];
  plaintextByDesign: number;
}

/**
 * Walk a pod and return every encryptable resource.
 *
 * Symlinks are NOT followed and NOT returned: `Dirent.isFile()` and
 * `isDirectory()` are both false for a symlink, so a link planted in a pod
 * cannot steer an encrypt pass at a file outside it.
 */
export async function enumeratePodResources(podDir: string): Promise<PodResourceSet> {
  const resources: PodResource[] = [];
  let plaintextByDesign = 0;

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Directory does not exist, or is not readable.
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith('.') && !DOT_ENTRY_ALLOWLIST.has(entry.name)) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const relPath = path.relative(podDir, full).split(path.sep).join('/');
        if (isPlaintextByDesign(relPath)) {
          plaintextByDesign += 1;
          continue;
        }
        resources.push({ absPath: full, relPath });
      }
    }
  }

  await walk(podDir);
  resources.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { resources, plaintextByDesign };
}

/**
 * The state of one file relative to the pod's key.
 *
 *  - `encrypted`  — authenticates under this pod's DEK.
 *  - `plaintext`  — already in the decrypted target state; leave it alone.
 *  - `unreadable` — neither. Either ciphertext under a DIFFERENT key or bytes
 *    that are not ours. Never rewritten, and never traded for the manifest.
 */
export type ResourceState = 'encrypted' | 'plaintext' | 'unreadable';

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/**
 * Could these bytes be plaintext that simply was never sealed?
 *
 * Two positive tests only: a blob shorter than a nonce plus a tag CANNOT be a
 * combined envelope, and a blob that fails GCM authentication but is valid UTF-8
 * is text. Anything else that fails authentication is left alone, because
 * "binary that is not ours" is indistinguishable from "ciphertext under another
 * key", and guessing wrong on the second one is unrecoverable.
 *
 * Mirrors `looks_like_plaintext` in the Workbench's `pod_io.rs`.
 */
export function looksLikePlaintext(blob: Buffer): boolean {
  if (blob.length < MIN_ENVELOPE_LEN) return true;
  try {
    utf8Strict.decode(blob);
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify a file against the pod DEK WITHOUT writing anything.
 *
 * GCM authentication is the authoritative test and is tried first, so a sealed
 * resource is never mistaken for text. The order matters: the reverse would let
 * a ciphertext blob that happens to decode as UTF-8 be called plaintext.
 */
export function classifyResource(absPath: string, dek: Buffer): ResourceState {
  const blob = fs.readFileSync(absPath);
  try {
    decryptBytes(blob, dek);
    return 'encrypted';
  } catch {
    return looksLikePlaintext(blob) ? 'plaintext' : 'unreadable';
  }
}

/**
 * Write a file so it is never observed half-written: a temp file in the SAME
 * directory (so the rename cannot cross a filesystem boundary) plus a rename.
 *
 * `pod encrypt` and `pod decrypt` rewrite every file in the pod in place, and a
 * crash mid-write on a plain `writeFileSync` leaves a truncated resource that
 * neither authenticates nor parses. With this, each file is either fully in the
 * old state or fully in the new one, which is exactly the state the other
 * direction is built to tolerate.
 */
export function atomicWriteBytes(absPath: string, bytes: Buffer): void {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.${path.basename(absPath)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, absPath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}
