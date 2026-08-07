/**
 * The pod read layer: ONE door every record read goes through.
 *
 * WHY this module exists
 * ----------------------
 * Encryption was retrofitted onto a CLI whose read verbs each walked the pod's
 * files and parsed them independently. Every verb then had to be taught about
 * the DEK one at a time, and every verb that had not yet been taught shipped
 * the same lie: it read ciphertext, parsed nothing out of it, and reported an
 * ENCRYPTED pod as an EMPTY one. `pod decrypt`, `pod conflicts`/`pod resolve`
 * and `pod query` were each fixed as separate incidents; `pod info`, the MCP
 * read tools, `pod erase` and `pod extract` were all still on the old path.
 *
 * A patch per verb does not end that class, because the defect is structural:
 * the DEK was an argument each caller had to remember rather than a property of
 * the open pod. So this module owns it. `openPod()` resolves the key ONCE per
 * invocation and hands back a {@link PodReader}; every subsequent read is a
 * method on that reader. A verb that forgets the key cannot be written, because
 * there is no read call that takes one.
 *
 * THE RULE, settled empirically and not renegotiable per-caller
 * ------------------------------------------------------------
 * Two failures, weighed differently, because "fail on anything" is its own
 * outage:
 *
 *   * DECRYPT failure is ALWAYS fatal. The pod's key is wrong for that file, so
 *     nothing about the pod's contents is known — including how much of it
 *     there is.
 *   * PARSE failure is fatal only for a REGISTERED record file (the
 *     {@link DATA_TYPES} files under `clinical/…` and `wellness/…`), which IS
 *     the record picture. For any other `.ttl` it is a loud WARNING: a pod
 *     legitimately holds app-shaped resources under `notes/`, `analysis/`,
 *     `literature/` and `profile/`, and one stray file must never blank a pod's
 *     whole record list.
 *   * IO failure is fatal. A file the walker just listed and then could not
 *     read leaves its contents unknown, and unknown is not zero.
 *
 * {@link PodReadLedger} applies that rule so no caller has to restate it.
 *
 * Exit-code contract for every verb built on this layer:
 *   0 — success
 *   1 — user / input error (bad flag, missing pod, a choice the user must make)
 *   2 — could not read what exists (the pod, or a file inside it)
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  parseTurtle,
  getProperties,
  shortenIRI,
  extractLabel,
  CASCADE_NAMESPACES,
  type ParseResult,
} from './turtle-parser.js';
import {
  readResource,
  resolveDek,
  isPodEncrypted,
  PodDecryptError,
} from './pod-encryption.js';
import { obtainPassphrase } from './passphrase.js';
import { looksLikePlaintext } from './pod-resources.js';
import { DATA_TYPES } from './pod-data-types.js';

// ─── Failure model ────────────────────────────────────────────────────────────

/**
 * WHY a read failed, which is not the same question as whether it failed.
 *
 *  - `decrypt` — the bytes would not open under this pod's DEK.
 *  - `parse`   — the bytes opened (or were plaintext) and are not valid Turtle.
 *  - `io`      — the file could not be read at all (gone, unreadable, a
 *                directory where a file was expected).
 */
export type PodReadFailureKind = 'decrypt' | 'parse' | 'io';

/** One pod file a read needed and could not use, with the reason. */
export interface PodReadFailure {
  /** Pod-relative path, forward slashes, so messages are stable across OSes. */
  file: string;
  kind: PodReadFailureKind;
  /** Tidied, printable reason (see {@link tidyReason}). */
  reason: string;
}

/** A read that either produced a value or a typed failure. Never both. */
export type PodReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: PodReadFailure };

/** Why a pod could not be OPENED at all (as opposed to one file inside it). */
export type PodOpenFailure =
  /** The pod is sealed and no passphrase was available (env unset, no TTY). */
  | 'passphrase-missing'
  /** A passphrase was supplied and did not unwrap the DEK. */
  | 'passphrase-incorrect';

/**
 * The pod is encrypted and this invocation does not hold its key.
 *
 * Carries a machine-readable {@link PodOpenFailure} so `--json` envelopes and
 * MCP errors can say WHICH state this is, and a `message` that already names
 * the state in prose — every caller prints the same sentence, and none of them
 * gets to soften it into "no records".
 */
export class PodUnreadableError extends Error {
  readonly podDir: string;
  readonly reason: PodOpenFailure;
  /** The underlying error text (wrong passphrase, no TTY, …). */
  readonly detail: string;

  constructor(podDir: string, reason: PodOpenFailure, detail: string) {
    super(
      `Could not open the pod at ${podDir}: ${describeOpenFailure(reason)} ` +
        `(${tidyReason(detail)}). This is NOT the same as the pod having no records.`,
    );
    this.name = 'PodUnreadableError';
    this.podDir = podDir;
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * WHY a decrypt failed, told apart rather than guessed at.
 *
 * A sealed pod containing one file that was never sealed — an interrupted
 * `pod encrypt`, a resource written by a tool that did not know the pod's state
 * — fails authentication exactly like a WRONG KEY does, and the raw error for
 * both is "incorrect passphrase or corrupt key". That sentence is a
 * misdiagnosis for the unsealed case: the passphrase was RIGHT, and it sends
 * the user to re-check the one thing that is not wrong. Naming the wrong cause
 * is the same defect as reporting an encrypted pod as an empty one, one level
 * down, so it is told apart here rather than at each call site.
 *
 * The discrimination is the one {@link looksLikePlaintext} already makes for
 * `pod encrypt` / `pod decrypt`: GCM authentication is authoritative and is
 * tried first, so a sealed resource is never mistaken for text; bytes that fail
 * it and still decode as UTF-8 are text that was never sealed. Ciphertext under
 * a DIFFERENT key is high-entropy and stays "wrong key".
 *
 * The file stays UNREADABLE either way, and callers keep treating it as fatal.
 * Bytes that did not authenticate under the pod's key have not been shown to
 * belong to this pod, and serving them as records would spend the guarantee
 * AES-GCM is here to provide: anyone who could drop a file into the directory
 * would otherwise have their records read back as the patient's own.
 */
export function decryptFailureReason(absPath: string, err: unknown): string {
  let blob: Buffer;
  try {
    blob = fs.readFileSync(absPath);
  } catch {
    return errText(err);
  }
  if (!looksLikePlaintext(blob)) return errText(err);
  // Kept under tidyReason's 120-character cap ON PURPOSE. That cap exists to
  // stop a parse error quoting a run of raw ciphertext, and it truncates from
  // the right — so a longer sentence here would lose its most useful half, the
  // remedy, and leave the user with a diagnosis and no next step.
  return 'NOT sealed: plaintext in an encrypted pod (passphrase is fine); re-run `cascade pod encrypt` to seal it';
}

/** The prose half of {@link PodUnreadableError}: name the state, plainly. */
export function describeOpenFailure(reason: PodOpenFailure): string {
  return reason === 'passphrase-missing'
    ? 'this pod is encrypted and the passphrase was not provided'
    : 'this pod is encrypted and the passphrase did not open it';
}

// ─── Opening a pod ────────────────────────────────────────────────────────────

/**
 * Open a pod for reading, resolving its DEK ONCE.
 *
 * A plaintext pod opens with no key. An encrypted pod takes the passphrase from
 * `CASCADE_POD_PASSPHRASE`, or a hidden TTY prompt when interactive, and throws
 * {@link PodUnreadableError} otherwise. It never returns a keyless reader for a
 * sealed pod: that combination is precisely what turns an encrypted pod into a
 * reported-empty one.
 *
 * @throws {PodUnreadableError} when the pod is encrypted and unopenable.
 */
export async function openPod(podDir: string): Promise<PodReader> {
  if (!isPodEncrypted(podDir)) return new PodReader(podDir, undefined);

  let passphrase: string;
  try {
    passphrase = await obtainPassphrase();
  } catch (e: unknown) {
    throw new PodUnreadableError(podDir, 'passphrase-missing', errText(e));
  }

  try {
    return new PodReader(podDir, resolveDek(podDir, passphrase));
  } catch (e: unknown) {
    throw new PodUnreadableError(podDir, 'passphrase-incorrect', errText(e));
  }
}

/** One record extracted from a pod resource. */
export interface PodRecord {
  id: string;
  type: string;
  label: string | undefined;
  properties: Record<string, string>;
}

/** What {@link PodReader.readPatientProfile} can recover about the pod owner. */
export interface PatientProfileSummary {
  name?: string;
  age?: string;
  schemaVersion?: string;
  dateOfBirth?: string;
}

/**
 * An open pod. Holds the resolved DEK (or `undefined` for a plaintext pod) and
 * serves every read through it.
 *
 * Reads return a {@link PodReadResult} rather than throwing, because the callers
 * that matter here sweep many files and must report ALL the ones they could not
 * read — a sealed pod read without the key fails on every file, and the useful
 * report is "the pod", not the first filename in sort order.
 */
export class PodReader {
  readonly podDir: string;
  readonly dek: Buffer | undefined;

  constructor(podDir: string, dek: Buffer | undefined) {
    this.podDir = podDir;
    this.dek = dek;
  }

  /** True when this pod carries an encryption manifest and a resolved key. */
  get encrypted(): boolean {
    return this.dek !== undefined;
  }

  /** Pod-relative path with forward slashes, for stable messages. */
  relativePath(absPath: string): string {
    return path.relative(this.podDir, absPath).split(path.sep).join('/');
  }

  /** Absolute path of a registered data file, by its {@link DATA_TYPES} key. */
  dataFilePath(typeKey: string): string | undefined {
    const info = DATA_TYPES[typeKey];
    return info ? path.join(this.podDir, info.directory, info.filename) : undefined;
  }

  /** Every `.ttl` in the pod, recursively, sorted. */
  listTtlFiles(): Promise<string[]> {
    return discoverTtlFiles(this.podDir);
  }

  /**
   * Read one resource as text, decrypting when this pod is sealed.
   *
   * A DEK-backed read distinguishes a key failure from an I/O failure: only the
   * former means "the pod's key is wrong for this file".
   */
  readText(absPath: string): PodReadResult<string> {
    try {
      return { ok: true, value: readResource(absPath, this.dek) };
    } catch (e: unknown) {
      if (this.dek && e instanceof PodDecryptError) {
        return { ok: false, failure: this.failure(absPath, 'decrypt', this.decryptReason(absPath, e)) };
      }
      return { ok: false, failure: this.failure(absPath, 'io', errText(e)) };
    }
  }

  private decryptReason(absPath: string, e: PodDecryptError): string {
    return decryptFailureReason(absPath, e);
  }

  /**
   * Read and parse one resource as Turtle.
   *
   * `baseIri` defaults to the file's own `file://` URL, which is what every
   * read-only caller wants. A caller that RE-SERIALIZES the file it read must
   * pass `''` instead: absolutizing IRIs that were relative on disk would
   * rewrite the document as a side effect of reading it.
   *
   * A FUNCTION may be passed instead, and is handed the decrypted text before
   * it is parsed. That is how the sentinel-base callers pick a base this
   * document provably does not already contain — a choice that cannot be made
   * from the outside, because only this method has the plaintext.
   */
  parseFile(
    absPath: string,
    opts?: { baseIri?: string | ((text: string) => string) },
  ): PodReadResult<ParseResult> {
    const text = this.readText(absPath);
    if (!text.ok) return text;
    const baseIri = typeof opts?.baseIri === 'function' ? opts.baseIri(text.value) : opts?.baseIri;
    const result = parseTurtle(text.value, baseIri ?? `file://${absPath}`);
    if (!result.success) {
      return { ok: false, failure: this.failure(absPath, 'parse', result.errors.join('; ')) };
    }
    return { ok: true, value: result };
  }

  /**
   * Read one resource and extract its typed records.
   *
   * Structural subjects (PROV activities, Solid type registrations, LDP
   * containers) are not records and are dropped; a subject with no meaningful
   * `rdf:type` left is skipped.
   */
  readRecords(absPath: string): PodReadResult<{ records: PodRecord[]; totalQuads: number }> {
    const parsed = this.parseFile(absPath);
    if (!parsed.ok) return parsed;
    return { ok: true, value: extractRecords(parsed.value) };
  }

  /**
   * Read the pod owner's name / age / schema version / date of birth.
   *
   * Tries `clinical/patient-profile.ttl` then `profile/card.ttl`, taking the
   * first value found for each field. A profile resource that will not read is
   * reported through `failures` rather than silently dropped: an encrypted pod
   * whose profile did not decrypt must not print as an anonymous one.
   */
  async readPatientProfile(): Promise<{
    profile: PatientProfileSummary;
    failures: PodReadFailure[];
  }> {
    const profilePaths = [
      path.join(this.podDir, 'clinical', 'patient-profile.ttl'),
      path.join(this.podDir, 'profile', 'card.ttl'),
    ];

    const profile: PatientProfileSummary = {};
    const failures: PodReadFailure[] = [];

    for (const profilePath of profilePaths) {
      if (!(await fileExists(profilePath))) continue;
      const parsed = this.parseFile(profilePath);
      if (!parsed.ok) {
        failures.push(parsed.failure);
        continue;
      }
      for (const subject of parsed.value.subjects) {
        const props = getProperties(parsed.value.store, subject.uri);
        profile.name ??= props['http://xmlns.com/foaf/0.1/name']?.[0];
        profile.age ??= props[CASCADE_NAMESPACES.cascade + 'computedAge']?.[0];
        profile.schemaVersion ??= props[CASCADE_NAMESPACES.cascade + 'schemaVersion']?.[0];
        profile.dateOfBirth ??= props[CASCADE_NAMESPACES.cascade + 'dateOfBirth']?.[0];
      }
    }

    return { profile, failures };
  }

  private failure(absPath: string, kind: PodReadFailureKind, reason: string): PodReadFailure {
    return { file: this.relativePath(absPath), kind, reason: tidyReason(reason) };
  }
}

/** Pull the display records out of an already-parsed resource. */
function extractRecords(result: ParseResult): { records: PodRecord[]; totalQuads: number } {
  const records: PodRecord[] = [];

  for (const subject of result.subjects) {
    // Skip blank nodes that are just structural (e.g., nested blank nodes for
    // provenance). Keep named subjects and typed blank nodes with real types.
    const meaningfulTypes = subject.types.filter(
      (t) =>
        !t.startsWith('http://www.w3.org/ns/prov#') &&
        t !== 'http://www.w3.org/ns/solid/terms#TypeRegistration' &&
        t !== 'http://www.w3.org/ns/solid/terms#TypeIndex' &&
        t !== 'http://www.w3.org/ns/solid/terms#ListedDocument' &&
        t !== 'http://www.w3.org/ns/solid/terms#UnlistedDocument' &&
        t !== 'http://www.w3.org/ns/ldp#BasicContainer',
    );
    if (meaningfulTypes.length === 0) continue;

    const props = getProperties(result.store, subject.uri);
    const label = extractLabel(props);

    // Flatten properties for display (join multi-values, shorten IRIs).
    const flatProps: Record<string, string> = {};
    for (const [pred, values] of Object.entries(props)) {
      if (pred === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') continue;
      flatProps[shortenIRI(pred)] = values.length === 1 ? values[0] : values.join(', ');
    }

    records.push({
      id: subject.uri,
      type: shortenIRI(meaningfulTypes[0]),
      label,
      properties: flatProps,
    });
  }

  return { records, totalQuads: result.quadCount };
}

// ─── The rule ─────────────────────────────────────────────────────────────────

/** Pod-relative paths (forward slashes) of every registered record file. */
const REGISTERED_RECORD_FILES: ReadonlySet<string> = new Set(
  Object.values(DATA_TYPES).map((dt) => `${dt.directory}/${dt.filename}`),
);

/**
 * Is this pod-relative path one of the registry's record files?
 *
 * Only these carry the record picture. Everything else a pod holds — notes,
 * analyses, literature, investigations, app bundles — is readable content the
 * record verbs do not count, so a parse failure there costs nothing they
 * report.
 */
export function isRegisteredRecordFile(podRelPath: string): boolean {
  return REGISTERED_RECORD_FILES.has(podRelPath.split(/[\\/]/).join('/'));
}

/**
 * Collects a sweep's read failures and sorts them by the rule above, so no
 * caller restates it and no caller quietly softens it.
 */
export class PodReadLedger {
  /** How many files the sweep tried to read (the denominator in messages). */
  attempted = 0;
  /** Failures that must fail the command. */
  readonly fatal: PodReadFailure[] = [];
  /** Failures that are warned about and stepped over. */
  readonly skipped: PodReadFailure[] = [];

  /** Count one file the sweep is about to read. */
  attempt(): void {
    this.attempted += 1;
  }

  /** File the failure under `fatal` or `skipped` per the rule. */
  record(failure: PodReadFailure): void {
    if (failure.kind === 'parse' && !isRegisteredRecordFile(failure.file)) {
      this.skipped.push(failure);
    } else {
      this.fatal.push(failure);
    }
  }

  get hasFatal(): boolean {
    return this.fatal.length > 0;
  }

  /**
   * Throw when any fatal failure was recorded.
   *
   * For callers that cannot return a partial answer with a warning attached —
   * an MCP tool result, say, where a successful response with zero records IS
   * the lie this whole module exists to prevent.
   *
   * @throws {PodFilesUnreadableError}
   */
  throwIfFatal(podDir: string): void {
    if (this.hasFatal) {
      throw new PodFilesUnreadableError(podDir, this.fatal, this.attempted);
    }
  }
}

/**
 * The pod opened, but files inside it could not be read.
 *
 * Distinct from {@link PodUnreadableError}, which is "the pod would not open at
 * all". Both mean the same thing to a consumer — the answer is unknown, not
 * empty — and both carry the files so the message can name them.
 */
export class PodFilesUnreadableError extends Error {
  readonly podDir: string;
  readonly failures: PodReadFailure[];
  readonly attempted: number;

  constructor(podDir: string, failures: PodReadFailure[], attempted: number) {
    super(unreadableFilesMessage(podDir, failures, attempted));
    this.name = 'PodFilesUnreadableError';
    this.podDir = podDir;
    this.failures = failures;
    this.attempted = attempted;
  }
}

// ─── Reporting ────────────────────────────────────────────────────────────────

/**
 * A failure reason, made fit to print.
 *
 * A Turtle parse failure quotes the offending token, and for a sealed file read
 * without the key that token is a run of raw ciphertext bytes. Keep the reason,
 * drop the noise: strip everything outside printable ASCII and cap the length.
 */
export function tidyReason(text: string): string {
  const flat = text.replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

/** How many files one message names before it says "and N more". */
const SHOWN = 5;

/** `a/b.ttl (reason); c/d.ttl (reason)`, capped at {@link SHOWN} entries. */
export function listFiles(files: PodReadFailure[]): string {
  const listed = files
    .slice(0, SHOWN)
    .map((u) => `${u.file} (${u.reason})`)
    .join('; ');
  return listed + (files.length > SHOWN ? `; and ${files.length - SHOWN} more` : '');
}

/**
 * The message for a command that could not read part of the pod.
 *
 * Names the files (capped, so a wholly-sealed pod does not print fifteen
 * identical lines) and ends by saying what this is NOT, because the whole class
 * of bug this guards against is a caller quietly turning it into "no records".
 */
export function unreadableFilesMessage(
  podDir: string,
  unreadable: PodReadFailure[],
  attempted: number,
): string {
  return (
    `Could not read ${unreadable.length} of ${attempted} file(s) in ${podDir}: ` +
    `${listFiles(unreadable)}. This is NOT the same as the pod having no records.`
  );
}

/**
 * The warning for unregistered files the sweep stepped over. Says what was
 * skipped and what that costs, so "not fatal" never becomes "not mentioned".
 */
export function skippedFilesMessage(skipped: PodReadFailure[]): string {
  return (
    `Skipped ${skipped.length} file(s) that are not valid Turtle: ${listFiles(skipped)}. ` +
    `They hold no records this command can count; everything else was read.`
  );
}

// ─── Pod file-system helpers ──────────────────────────────────────────────────
//
// These live here rather than in the pod command helpers because walking a
// pod's files is the read layer's business, and the layer must not import a
// command module to do it. `commands/pod/helpers.ts` re-exports them.

/** Resolve a pod directory argument to an absolute path. */
export function resolvePodDir(podDir: string): string {
  return path.resolve(process.cwd(), podDir);
}

/** Check if a path exists and is a directory. */
export async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/** Check if a file exists. */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Discover all TTL files in a pod directory recursively (sorted). */
export async function discoverTtlFiles(podDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.ttl')) {
        files.push(fullPath);
      }
    }
  }

  await walk(podDir);
  return files.sort();
}

/** Error text, whatever was thrown. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
