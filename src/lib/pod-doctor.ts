/**
 * The diagnosis-and-repair engine behind `cascade pod doctor`.
 *
 * WHY this exists
 * ---------------
 * Every record-data writer now REFUSES a bucket that will not parse rather than
 * appending into it or silently overwriting it. That is the right behaviour —
 * the old one is what turned a broken header into lost records — but it leaves a
 * user whose pod is ALREADY damaged with no way forward inside the CLI at all:
 * `add-record`, `erase` and `import` all decline, and the whole-pod read fails.
 * This module is the way forward. It ships in the same release as the refusal so
 * the two reach users together.
 *
 * WHAT IT REPAIRS, and nothing else
 * ---------------------------------
 * Exactly one damage shape: a file whose ONLY defect is that its header lacks
 * `@prefix` declarations its body uses. That is the shape the shipped defect
 * produced, and it is the only one whose correct repair is knowable without
 * asking a human. Every other shape is reported with a next step
 * ({@link DoctorDamage}).
 *
 * THE SAFETY PROPERTIES, in order of how much they matter
 * ------------------------------------------------------
 *  1. DRY RUN BY DEFAULT. Writing requires an explicit `--write`.
 *  2. ONLY EVER PREPENDS. {@link assertPrependOnly} refuses unless the original
 *     content is a strict suffix of the repaired content. This is what makes the
 *     verb safe on human-curated scaffolding as well as on record buckets — see
 *     "SCAFFOLDING" below.
 *  3. The repaired text must pass a STRICT parse BEFORE anything is written.
 *  4. The original bytes are BACKED UP before the write, and restored from that
 *     backup if the post-write read-back does not verify.
 *  5. NEVER invents a namespace. A prefix outside {@link DOCTOR_PREFIXES} is a
 *     refusal naming the prefix, not a guess.
 *  6. IDEMPOTENT. A file that parses is never touched, so a second run reports
 *     nothing to do.
 *  7. Encrypted-pod transparent: reads and writes go through the pod's DEK.
 *
 * SCAFFOLDING: why this module must NOT use `mergeIntoBucket`
 * ----------------------------------------------------------
 * Doctor scans `settings/publicTypeIndex.ttl`, `index.ttl`, `profile/card.ttl`
 * and `profile/extended.ttl` too, because damaged scaffolding exists in the
 * field. Those files are authored with LOAD-BEARING comments — `extended.ttl`
 * regex-anchors PHI population on a literal comment line, and is 100% comments,
 * so a re-serialization would not merely reformat it, it would empty it. That is
 * exactly why the bucket chokepoint excludes them. Prepending a declaration
 * preserves every existing byte, which is what makes scanning them safe, and it
 * is the whole reason property 2 is an assertion in code rather than a habit.
 *
 * DISCOVERY: from the parser, never from a regex
 * ----------------------------------------------
 * Which prefixes are missing is read out of the PARSER'S OWN ERROR — heal one,
 * re-parse, repeat, bounded. A regex over the text finds false positives inside
 * comments, inside string literals, and inside absolute IRIs that contain a
 * colon, and each of those would make doctor author a declaration the document
 * never needed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Parser } from 'n3';
import type { Quad } from 'n3';
import { KNOWN_PREFIXES, findIllegalIriChar } from './bucket-write.js';
import { encryptResource, readResource } from './pod-encryption.js';
import { atomicWriteBytes, looksLikePlaintext } from './pod-resources.js';
import { tidyReason, type PodReader, type PodReadFailure } from './pod-read.js';

// ─── The registry ─────────────────────────────────────────────────────────────

/**
 * Namespaces doctor may author that the record writers never emit.
 *
 * Every entry needs a reason, because each one widens the set of files this tool
 * will rewrite. DERIVED, not retyped: see {@link DOCTOR_PREFIXES}.
 */
export const REPAIR_ONLY_PREFIXES: Record<string, string> = {
  /**
   * The pre-fix `pod add-record` accepted `core:` as an input CURIE while never
   * declaring it, so real damaged pods in the field contain `core:` CURIEs.
   * Same namespace as `cascade:` — this is an alias, not a second vocabulary.
   */
  core: 'https://ns.cascadeprotocol.org/core/v1#',

  // The rest are the pod SCAFFOLDING templates' namespaces (`profile/card.ttl`,
  // `profile/extended.ttl`, `index.ttl`, both type indexes,
  // `settings/preferences.ttl`) plus `pod extract`'s output. The record writers
  // never emit them, so `KNOWN_PREFIXES` has no reason to carry them — but the
  // files that use them are files doctor scans.
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  foaf: 'http://xmlns.com/foaf/0.1/',
  solid: 'http://www.w3.org/ns/solid/terms#',
  ldp: 'http://www.w3.org/ns/ldp#',
  /** `index.ttl` declares dc terms under this name; `dct:` is the same namespace. */
  dcterms: 'http://purl.org/dc/terms/',
  /** `profile/card.ttl` and `settings/preferences.ttl` declare it. */
  pim: 'http://www.w3.org/ns/pim/space#',
  /** Not in any template, but `rdf:type` is spellable in any hand-edited file. */
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
};

/**
 * The complete set of declarations doctor is willing to author.
 *
 * DERIVED from {@link KNOWN_PREFIXES} rather than retyped. This defect class
 * recurred in the first place because a correct prefix table was COPIED instead
 * of shared, so a second hand-maintained copy of those fifteen entries is the
 * one thing this verb must not introduce. A prefix added to `KNOWN_PREFIXES`
 * tomorrow is repairable by doctor the same day, with no second edit.
 *
 * The spread order lets a repair-only entry SHADOW a known one, which is the
 * only remaining way the two could disagree — the drift test in
 * `tests/pod-doctor.test.ts` is what makes that impossible in practice.
 */
export const DOCTOR_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  ...KNOWN_PREFIXES,
  ...REPAIR_ONLY_PREFIXES,
});

// ─── Parsing ──────────────────────────────────────────────────────────────────

/** A strict Turtle parse: the same one the whole-pod read performs, and fails. */
export type StrictParse =
  | { ok: true; quads: Quad[] }
  | { ok: false; error: string };

/**
 * Parse `ttl` exactly as strictly as the read path does.
 *
 * No `baseIRI`: doctor never re-serializes, so how a relative IRI RESOLVES is
 * none of its business — only whether the document parses at all. Passing a base
 * here would change nothing about that answer and would invite the impression
 * that this function's output is safe to write back. It is not; nothing but the
 * prepended header is ever written.
 */
export function strictParseTurtle(ttl: string): StrictParse {
  try {
    return { ok: true, quads: new Parser({ format: 'Turtle' }).parse(ttl) };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Prefix names the document already binds, in either Turtle spelling.
 *
 * Used ONLY as the no-progress guard in {@link planPrefixRepair}, never to
 * decide what to add. A file that binds `foo:` on line 50 and uses it on line 10
 * really does fail with `Undefined prefix "foo:"`, and prepending a SECOND
 * binding for it would silently re-point every CURIE between those two lines at
 * a different namespace. This is what turns that into a refusal.
 */
export function declaredPrefixes(ttl: string): Set<string> {
  return new Set(
    [...ttl.matchAll(/(?:@prefix|PREFIX)\s+([A-Za-z][\w.-]*):/gi)].map((m) => m[1]),
  );
}

/** How many heal-and-re-parse rounds before doctor concludes it is not converging. */
const MAX_HEALING_PASSES = 64;

/** N3's message for the one defect this tool repairs. */
const UNDEFINED_PREFIX = /Undefined prefix "([^":]+):"/;

// ─── Damage shapes ────────────────────────────────────────────────────────────

/**
 * What is wrong with a file. Exactly one shape is repairable; the rest are
 * reported with a next step, because their correct repair is a human decision
 * and a tool that guessed would be writing the user's health record for them.
 */
export type DoctorDamage =
  /** REPAIRABLE. The header lacks `@prefix` declarations the body uses. */
  | 'missing-prefix'
  /** A used prefix is not in {@link DOCTOR_PREFIXES}. Doctor will not invent one. */
  | 'unknown-prefix'
  /** The prefix is already bound, later in the file, so prepending would re-point it. */
  | 'prefix-bound-late'
  /** The file holds no bytes (or only whitespace). An interrupted write looks like this. */
  | 'empty'
  /** The file stops mid-statement. An interrupted write looks like this too. */
  | 'truncated'
  /** An IRI contains a character Turtle forbids inside `<...>`. */
  | 'illegal-iri'
  /** Not valid Turtle, and not any shape named above. */
  | 'unparseable'
  /** The bytes did not decrypt under this pod's key. */
  | 'undecryptable'
  /** The bytes are not text at all, in a pod with no encryption manifest. */
  | 'not-text'
  /** The file could not be read at all. */
  | 'unreadable'
  /** The repair was written and did not read back correctly; the original was restored. */
  | 'write-verify-failed';

/** What doctor did, or would do, about one file. */
export type DoctorStatus = 'repairable' | 'repaired' | 'refused' | 'unreadable';

/** One file doctor has something to say about. Healthy files produce none. */
export interface DoctorFinding {
  /** Pod-relative path, forward slashes, so output is stable across OSes. */
  file: string;
  status: DoctorStatus;
  damage: DoctorDamage;
  /** What is wrong, in one sentence. */
  reason: string;
  /** What the user should do about it. Absent when doctor already did it. */
  nextStep?: string;
  /** The declarations doctor added, or would add, in the order it found them. */
  missingPrefixes?: string[];
  /** Triples the repaired document parses to. Only on a repair. */
  triples?: number;
  /** Bytes of the original content preserved verbatim. Only on a repair. */
  preservedBytes?: number;
  /** Pod-relative path of the backup taken before the write. Only on `repaired`. */
  backup?: string;
}

/** The whole run. `--json` prints this verbatim. */
export interface DoctorReport {
  pod: string;
  encrypted: boolean;
  mode: 'dry-run' | 'write';
  /** `.ttl` files examined. */
  scanned: number;
  /** Files that parsed and were not touched. */
  healthy: number;
  repaired: number;
  repairable: number;
  refused: number;
  unreadable: number;
  findings: DoctorFinding[];
}

// ─── Planning a repair ────────────────────────────────────────────────────────

/** A repair doctor is prepared to make, or the reason it is not. */
export type PrefixRepairPlan =
  | { ok: true; header: string; added: string[]; triples: number }
  | { ok: false; damage: DoctorDamage; reason: string; nextStep: string };

/**
 * The one comment doctor writes. Explains an otherwise mysterious header to
 * whoever opens the file next, and is itself a prepend like any other.
 */
export const REPAIR_BANNER =
  '# Declarations restored by `cascade pod doctor`: used by this file, missing from its header.\n';

/**
 * Work out the header that makes `original` parse, WITHOUT modifying anything.
 *
 * Heals one prefix, re-parses, repeats. The parser is the only thing that gets
 * to say which prefixes the document uses; see the module header for why a regex
 * cannot do this job.
 *
 * @param registry the namespaces doctor may author. Injected so a test can
 *        exercise the refusal path without depending on which prefixes happen to
 *        be in the real registry today.
 */
export function planPrefixRepair(
  original: string,
  registry: Readonly<Record<string, string>> = DOCTOR_PREFIXES,
): PrefixRepairPlan {
  const bound = declaredPrefixes(original);
  const added: string[] = [];
  let declarations = '';

  for (let pass = 0; pass < MAX_HEALING_PASSES; pass++) {
    const parsed = strictParseTurtle(declarations + original);
    if (parsed.ok) {
      if (declarations === '') return { ok: true, header: '', added, triples: parsed.quads.length };
      // Verify the text that will ACTUALLY be written, banner and all — not the
      // declarations-only text the loop happened to converge on. Property 3 is
      // "the repaired text parses", and the repaired text is this one.
      const header = REPAIR_BANNER + declarations + '\n';
      const verified = strictParseTurtle(header + original);
      if (!verified.ok) {
        return {
          ok: false,
          damage: 'unparseable',
          reason: `The repaired text did not parse: ${tidyReason(verified.error)}`,
          nextStep: 'Nothing was written. This is a doctor bug, not a problem with your pod.',
        };
      }
      return { ok: true, header, added, triples: verified.quads.length };
    }

    const missing = UNDEFINED_PREFIX.exec(parsed.error);
    // The text the PARSER saw, not the original: once declarations have been
    // prepended the error's line number counts from the top of the combined
    // text, and handing `classifyParseFailure` a different string would make it
    // compare that line number against the wrong document.
    if (!missing) return classifyParseFailure(declarations + original, parsed.error);
    const prefix = missing[1];

    if (bound.has(prefix) || added.includes(prefix)) {
      return {
        ok: false,
        damage: 'prefix-bound-late',
        reason:
          `"${prefix}:" is used before the line that binds it (${tidyReason(parsed.error)}).`,
        nextStep:
          `Move the \`@prefix ${prefix}:\` declaration above its first use. Doctor will not ` +
          `prepend a second binding: that would re-point every "${prefix}:" CURIE above the ` +
          `existing declaration at a possibly different namespace.`,
      };
    }

    const namespace = registry[prefix];
    if (namespace === undefined) {
      return {
        ok: false,
        damage: 'unknown-prefix',
        reason: `"${prefix}:" is used but never declared, and it is not a prefix doctor knows.`,
        nextStep:
          `Add \`@prefix ${prefix}: <the namespace it means> .\` to the top of the file by hand. ` +
          `Doctor refuses to guess a namespace: writing the wrong one would leave the file ` +
          `parseable while saying something else.`,
      };
    }

    declarations += `@prefix ${prefix}: <${namespace}> .\n`;
    added.push(prefix);
  }

  return {
    ok: false,
    damage: 'unparseable',
    reason: `Still not parseable after ${MAX_HEALING_PASSES} prefix repairs; giving up.`,
    nextStep: 'This file needs a human. Nothing was written.',
  };
}

/**
 * Name a parse failure that is NOT a missing prefix, so the user gets a next
 * step instead of a raw parser message.
 *
 * These heuristics only ever REFINE the report on a file that has already failed
 * a strict parse. Nothing is repaired on their say-so, so a false positive costs
 * a slightly wrong sentence and never a byte.
 */
export function classifyParseFailure(
  text: string,
  error: string,
): { ok: false; damage: DoctorDamage; reason: string; nextStep: string } {
  const illegal = firstIllegalIri(text);
  if (illegal) {
    const codePoint = `U+${(illegal.offending.codePointAt(0) ?? 0)
      .toString(16)
      .toUpperCase()
      .padStart(4, '0')}`;
    return {
      ok: false,
      damage: 'illegal-iri',
      reason:
        `An IRI contains ${codePoint}, which Turtle forbids inside <...>: <${tidyReason(illegal.iri)}>.`,
      nextStep:
        `Correct that IRI by hand, or delete the statement that carries it. It was almost ` +
        `certainly written by an older \`pod add-record\` that did not validate its input; ` +
        `doctor cannot know what the value was meant to be.`,
    };
  }

  if (/but got eof|Unexpected end/i.test(error) || breaksAtLastLine(text, error)) {
    return {
      ok: false,
      damage: 'truncated',
      reason: `The file breaks at its final line: ${tidyReason(error)}`,
      nextStep:
        `A file that stops mid-statement is what an interrupted write leaves behind — ` +
        `\`writeResource\` is not atomic. Restore it from a backup or from a \`pod export\`; ` +
        `doctor will not guess the missing text.`,
    };
  }

  return {
    ok: false,
    damage: 'unparseable',
    reason: tidyReason(error),
    nextStep:
      'Open the file at the point named above and correct it by hand. Doctor repairs missing ' +
      '`@prefix` declarations only.',
  };
}

/** N3 ends every message with the line it gave up on. */
const ERROR_LINE = /on line (\d+)\.?\s*$/;

/**
 * Does the document break on its LAST line?
 *
 * The definitive truncation signal is the parser saying `eof`, but it only says
 * that when the cut lands between tokens. A cut through the MIDDLE of a token —
 * an IRI, a quoted literal — leaves a fragment the parser rejects by name
 * instead, with no mention of eof, and that is the same damage from the same
 * cause. What both have in common is that the failure is at the end of the file
 * rather than somewhere inside it.
 *
 * Multi-line only: on a one-line document "the last line" is every line, and
 * calling every one-line syntax error a truncation would be a guess.
 */
function breaksAtLastLine(text: string, error: string): boolean {
  const at = ERROR_LINE.exec(error.trim());
  if (!at) return false;
  const lastContentLine = text.replace(/\s+$/, '').split('\n').length;
  return lastContentLine > 1 && Number(at[1]) >= lastContentLine;
}

/**
 * The first `<...>` in `text` holding a character Turtle forbids, if any.
 *
 * Reuses {@link findIllegalIriChar}, which encodes the W3C IRIREF production, so
 * there is no second opinion about which characters are legal. The scan stays on
 * one line so an unterminated `<` cannot swallow the rest of the document.
 */
function firstIllegalIri(text: string): { iri: string; offending: string } | undefined {
  for (const m of text.matchAll(/<([^<>\n]*)>/g)) {
    const offending = findIllegalIriChar(m[1]);
    if (offending !== undefined) return { iri: m[1], offending };
  }
  return undefined;
}

// ─── Applying a repair ────────────────────────────────────────────────────────

/** Suffix of the backup doctor takes before it writes. Never a `.ttl`, so it is never rescanned. */
export const BACKUP_SUFFIX = '.doctor-backup';

/**
 * THE INVARIANT: a repair only ever prepends.
 *
 * Asserted rather than assumed, because it is the single property that makes
 * this verb safe to point at comment-anchored scaffolding. If a future change
 * ever makes doctor re-serialize, reformat or normalise anything, this throws
 * instead of quietly destroying a load-bearing comment.
 */
export function assertPrependOnly(original: string, repaired: string, header: string): void {
  if (repaired.length !== header.length + original.length || !repaired.endsWith(original)) {
    throw new Error(
      'Internal error: a pod doctor repair was not a pure prepend. Nothing was written. ' +
        'This tool may only ever add lines above the existing content.',
    );
  }
}

/**
 * Write a resource the way `writeResource` does, but atomically.
 *
 * Same transparency (`dek` present means the bytes on disk are ciphertext), via
 * a temp file plus a rename. `writeResource` is a bare `writeFileSync`, so a
 * crash mid-write leaves a truncated resource — and "truncated file" is one of
 * the damage shapes this very command exists to report. A repair tool that can
 * create the damage it diagnoses is not one to ship.
 */
function writeResourceAtomic(absPath: string, content: string, dek: Buffer | undefined): void {
  atomicWriteBytes(absPath, dek ? encryptResource(content, dek) : Buffer.from(content, 'utf-8'));
}

/** What {@link applyRepair} did. */
type RepairOutcome =
  | { ok: true; backup: string }
  | { ok: false; reason: string; nextStep: string };

/**
 * Write the repair, then prove it. Restores the original if the proof fails.
 *
 * Order is the point: verify the repaired TEXT parses (already done by
 * {@link planPrefixRepair}), assert the prepend invariant, back up, write, read
 * BACK through the same door a later command will, and only then call it done.
 */
function applyRepair(
  absPath: string,
  original: string,
  header: string,
  dek: Buffer | undefined,
): RepairOutcome {
  const repaired = header + original;
  assertPrependOnly(original, repaired, header);

  // Property 3, restated at the door that actually writes. The planner already
  // proved this, but the proof must sit between the last chance to change the
  // text and the write, not somewhere upstream where a later refactor could
  // slip past it.
  const proof = strictParseTurtle(repaired);
  if (!proof.ok) {
    return {
      ok: false,
      reason: `The repaired text does not parse (${tidyReason(proof.error)}).`,
      nextStep: 'Nothing was written and no backup was taken. The file is untouched.',
    };
  }

  // Always a FRESH backup of the bytes about to be replaced. Keeping an older
  // one would break the restore below: it would put back a file that is not what
  // this write replaced.
  const backup = absPath + BACKUP_SUFFIX;
  fs.copyFileSync(absPath, backup);

  writeResourceAtomic(absPath, repaired, dek);

  let readBack: string;
  try {
    readBack = readResource(absPath, dek);
  } catch (e: unknown) {
    fs.copyFileSync(backup, absPath);
    return {
      ok: false,
      reason: `The repaired file could not be read back (${tidyReason(errText(e))}).`,
      nextStep: `The original was restored from ${path.basename(backup)}. Nothing was lost.`,
    };
  }

  if (!strictParseTurtle(readBack).ok || !readBack.endsWith(original)) {
    fs.copyFileSync(backup, absPath);
    return {
      ok: false,
      reason: 'The repaired file did not verify after being written.',
      nextStep: `The original was restored from ${path.basename(backup)}. Nothing was lost.`,
    };
  }

  return { ok: true, backup };
}

// ─── The scan ─────────────────────────────────────────────────────────────────

/**
 * Diagnose one file's TEXT. No I/O, no decisions about writing.
 *
 * Split out from the sweep so the whole decision table is reachable from a unit
 * test with a string.
 */
export type TextDiagnosis =
  | { kind: 'healthy' }
  | { kind: 'repairable'; header: string; added: string[]; triples: number }
  | { kind: 'refused'; damage: DoctorDamage; reason: string; nextStep: string };

export function diagnoseText(text: string): TextDiagnosis {
  // An empty file PARSES — as zero triples — so this cannot be left to the
  // parser. `writeResource` is not atomic, and an interrupted write is exactly
  // how a bucket ends up holding nothing. "Zero records" and "the records are
  // gone" must not share an answer.
  if (text.trim() === '') {
    return {
      kind: 'refused',
      damage: 'empty',
      reason: 'The file is empty. It parses as zero triples, which is not the same as being healthy.',
      nextStep:
        'An interrupted write leaves a file like this. If this bucket should hold records, ' +
        'restore it from a backup or a `pod export`. Doctor will not invent contents.',
    };
  }

  if (strictParseTurtle(text).ok) return { kind: 'healthy' };

  const plan = planPrefixRepair(text);
  if (!plan.ok) {
    return { kind: 'refused', damage: plan.damage, reason: plan.reason, nextStep: plan.nextStep };
  }
  return { kind: 'repairable', header: plan.header, added: plan.added, triples: plan.triples };
}

/**
 * Scan every `.ttl` in the pod and, under `write`, repair the ones whose only
 * defect is a missing declaration.
 *
 * Reads go through the {@link PodReader}, so an encrypted pod is handled with no
 * special case here and a per-file decrypt failure is told apart from the pod's
 * key being wrong (which never reaches this function — `openPod` has already
 * failed by then).
 */
export async function runPodDoctor(
  reader: PodReader,
  options: { write: boolean },
): Promise<DoctorReport> {
  const files = await reader.listTtlFiles();
  const findings: DoctorFinding[] = [];
  let healthy = 0;

  for (const absPath of files) {
    const file = reader.relativePath(absPath);

    // On a pod with NO manifest there is no key and no decrypt step, so
    // `readResource` hands back whatever the bytes decode to — and Node's UTF-8
    // read never fails, it substitutes U+FFFD. Ciphertext therefore arrives as a
    // string of replacement characters and reports as "this file is corrupt
    // Turtle", which is a misdiagnosis of the one situation where the user still
    // has something to save. Ask the bytes first.
    if (reader.dek === undefined && looksLikeSealedBytes(absPath)) {
      findings.push(notTextFinding(file));
      continue;
    }

    const text = reader.readText(absPath);
    if (!text.ok) {
      findings.push(unreadableFinding(file, text.failure));
      continue;
    }

    const diagnosis = diagnoseText(text.value);
    if (diagnosis.kind === 'healthy') {
      healthy += 1;
      continue;
    }
    if (diagnosis.kind === 'refused') {
      findings.push({
        file,
        status: 'refused',
        damage: diagnosis.damage,
        reason: diagnosis.reason,
        nextStep: diagnosis.nextStep,
      });
      continue;
    }

    const shared = {
      file,
      damage: 'missing-prefix' as const,
      missingPrefixes: diagnosis.added,
      triples: diagnosis.triples,
      preservedBytes: text.value.length,
    };

    if (!options.write) {
      findings.push({
        ...shared,
        status: 'repairable',
        reason: `Missing declarations: ${diagnosis.added.map((p) => `${p}:`).join(' ')}.`,
        nextStep: 'Re-run with --write to prepend them. Nothing has been changed.',
      });
      continue;
    }

    const outcome = applyRepair(absPath, text.value, diagnosis.header, reader.dek);
    if (!outcome.ok) {
      findings.push({
        ...shared,
        status: 'refused',
        damage: 'write-verify-failed',
        reason: outcome.reason,
        nextStep: outcome.nextStep,
      });
      continue;
    }
    findings.push({
      ...shared,
      status: 'repaired',
      reason: `Prepended: ${diagnosis.added.map((p) => `${p}:`).join(' ')}.`,
      backup: reader.relativePath(absPath + BACKUP_SUFFIX),
    });
  }

  const count = (status: DoctorStatus) => findings.filter((f) => f.status === status).length;
  return {
    pod: reader.podDir,
    encrypted: reader.encrypted,
    mode: options.write ? 'write' : 'dry-run',
    scanned: files.length,
    healthy,
    repaired: count('repaired'),
    repairable: count('repairable'),
    refused: count('refused'),
    unreadable: count('unreadable'),
    findings,
  };
}

/**
 * Are these bytes something other than text?
 *
 * {@link looksLikePlaintext} is the same authority `pod encrypt`/`pod decrypt`
 * use, so there is no second opinion here about what "text" means. Only asked of
 * pods with no manifest: when a DEK exists, GCM authentication has already
 * answered the question properly.
 */
function looksLikeSealedBytes(absPath: string): boolean {
  try {
    return !looksLikePlaintext(fs.readFileSync(absPath));
  } catch {
    // Unreadable for some other reason; let the normal read report it.
    return false;
  }
}

/** A pod resource that is not text, in a pod that claims not to be encrypted. */
function notTextFinding(file: string): DoctorFinding {
  return {
    file,
    status: 'unreadable',
    damage: 'not-text',
    reason:
      'These bytes are not valid UTF-8, so they are not Turtle. They look like an encrypted ' +
      'pod resource in a pod that has no settings/encryption.json.',
    nextStep:
      'Restore settings/encryption.json from a backup: it holds the only wrapped copy of this ' +
      "pod's key, and without it these resources cannot be decrypted by anyone. Doctor did not " +
      'change the file.',
  };
}

/**
 * Turn a read-layer failure into a finding.
 *
 * The decrypt reason arrives already discriminated by the read layer: a file
 * that was never sealed says so, rather than blaming a passphrase that is
 * perfectly correct. Repeating that misattribution here is the error this
 * function exists to not make.
 */
function unreadableFinding(file: string, failure: PodReadFailure): DoctorFinding {
  const decrypt = failure.kind === 'decrypt';
  return {
    file,
    status: 'unreadable',
    damage: decrypt ? 'undecryptable' : 'unreadable',
    reason: failure.reason,
    nextStep: decrypt
      ? 'This one resource did not authenticate under the pod key. The rest of the pod was ' +
        'read with that same key, so the passphrase is not the problem: these bytes are. ' +
        'Restore the file from a backup, or re-seal it if it was written unencrypted.'
      : 'The file could not be read at all. Check its permissions and that it still exists.',
  };
}

/**
 * The exit code for a finished run, on the read layer's contract:
 *
 *   0 — nothing is wrong, or everything found was repaired.
 *   1 — damage remains: doctor could READ the file and will not repair it.
 *   2 — something could not be read at all (a resource that did not decrypt, a
 *       file that is not text, an I/O failure).
 *
 * 2 outranks 1 deliberately. "I could not look at part of this pod" is a weaker
 * claim than "I looked and here is what is wrong", and reporting the weaker one
 * as the stronger is the exact defect this area of the CLI keeps re-shipping.
 * The pod failing to OPEN at all is also 2, decided by the command.
 */
export function doctorExitCode(report: DoctorReport): 0 | 1 | 2 {
  if (report.unreadable > 0) return 2;
  return report.repairable + report.refused > 0 ? 1 : 0;
}

/** Error text, whatever was thrown. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
