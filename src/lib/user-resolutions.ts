/**
 * Persistence layer for user conflict resolutions and pending conflicts.
 *
 * Files written to the pod:
 *   settings/user-resolutions.ttl — User's stored resolution decisions
 *   settings/pending-conflicts.ttl — Unresolved conflicts from most recent import
 *
 * Both files live under `settings/`, which `pod encrypt` covers, so on an
 * encrypted pod they are ciphertext. Every read and write here therefore takes
 * the pod DEK. It used to take none, in either direction, which had two
 * consequences: a sealed conflicts file failed to parse and was swallowed into
 * an empty list, so `pod conflicts` printed "No unresolved conflicts" and
 * exited 0 with the conflict sitting right there; and every import into a
 * sealed pod dropped a PLAINTEXT file back into it holding record types, source
 * EHR names and candidate record IRIs.
 *
 * The soft-failure catches are gone with it. An absent file is an empty list;
 * anything else throws {@link ConflictStoreError}, so a caller can always tell
 * "no conflicts" from "could not read the conflicts".
 */

import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Parser, Writer, DataFactory } from 'n3';
import { NS, TURTLE_PREFIXES } from './fhir-converter/types.js';
import { randomUUID } from 'node:crypto';
import { readResource, writeResource, PodDecryptError } from './pod-encryption.js';
import { decryptFailureReason } from './pod-read.js';

export { randomUUID };

const { namedNode, literal, quad: makeQuad } = DataFactory;

/**
 * A conflict-store file exists but could not be read.
 *
 * Distinct from "the file is not there", which is a legitimate empty state and
 * the ONLY absence this module tolerates. Carries the offending path and the
 * underlying cause so a command can say which of the two happened.
 */
export class ConflictStoreError extends Error {
  constructor(
    message: string,
    readonly filePath: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ConflictStoreError';
  }
}

/** Is this a "file does not exist" error, as opposed to a real read failure? */
function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Read one conflict-store file, decrypting when a DEK is supplied.
 *
 * @returns the Turtle text, or `null` when the file simply does not exist.
 * @throws {ConflictStoreError} on any other read or decrypt failure.
 */
async function readStoreFile(filePath: string, dek?: Buffer): Promise<string | null> {
  if (dek) {
    try {
      return readResource(filePath, dek);
    } catch (err) {
      if (isNotFound(err)) return null;
      if (err instanceof PodDecryptError) {
        // Through the read layer's shared explanation, so the conflicts store
        // tells a plaintext-in-a-sealed-pod file apart from a wrong key in the
        // same words every other read does. Both raise the same GCM failure,
        // and only one of them is about the passphrase.
        throw new ConflictStoreError(
          `Could not decrypt ${filePath}: ${decryptFailureReason(filePath, err)}`,
          filePath,
          err,
        );
      }
      throw new ConflictStoreError(
        `Could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        filePath,
        err,
      );
    }
  }
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new ConflictStoreError(
      `Could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      filePath,
      err,
    );
  }
}

export type ResolutionChoice = 'kept-source-a' | 'kept-source-b' | 'kept-both' | 'manual-edit';

export interface UserResolution {
  uri: string;             // urn:uuid:resolution-{id}
  conflictId: string;      // Deterministic ID: recordType::identityFields
  resolvedAt: Date;
  resolution: ResolutionChoice;
  keptRecordUri: string;
  discardedRecordUris: string[];
  userNote?: string;
  /**
   * WHO made this decision (`prov:wasAttributedTo`), when they said so.
   *
   * Optional, and its absence is not a gap to be filled in later by guessing.
   * The log recorded WHEN a conflict was answered and never by whom, which on a
   * pod more than one person touches makes a decision unattributable after the
   * fact. `pod annotate --by` already writes this predicate for a note; a
   * decision about which of two clinical facts stands is at least as
   * attributable, so it takes the same flag and writes the same triple.
   */
  actorIri?: string;
}

/**
 * One unanswered question in `settings/pending-conflicts.ttl`.
 *
 * WHY THE ROW CARRIES THE DISAGREEMENT AND NOT ONLY POINTERS TO IT
 * ---------------------------------------------------------------
 * The row used to be a pair of candidate record IRIs and little else, on the
 * assumption that a consumer wanting to show the two sides would dereference
 * them. That assumption does not survive the run that raises the row: a value or
 * status conflict that the reconciler settles ABSORBS the losing record into the
 * survivor, so one of the two IRIs points at a record that is no longer in the
 * pod. Measured at full scale: a re-import raised seven medication
 * disagreements, and every one of them was un-reviewable for exactly this
 * reason.
 *
 * So the substance is written onto the row at raise time — the field in dispute,
 * each side's value, each side's origin, and which candidate survived. These are
 * APP BOOKKEEPING in the same namespace and style the file already uses, not
 * protocol vocabulary: they describe the state of a review queue, not a clinical
 * fact about the patient, and nothing outside this tool reads them.
 *
 * Every one of them is OPTIONAL, and reads tolerate their absence: a pod holding
 * rows written by an earlier CLI still parses, with the new fields undefined.
 */
export interface PendingConflict {
  uri: string;             // urn:uuid:conflict-{conflictId}
  conflictId: string;
  recordType: string;      // e.g. "health:ConditionRecord"
  detectedAt: Date;
  candidateRecordUris: string[];
  // Human-readable summary fields (for display)
  label?: string;          // e.g. "Hypertension"
  /**
   * The two sides' ORIGIN labels: which organization each came from, rendered
   * through the shared source-identity derivation.
   *
   * These used to be the INGESTION label (the import batch), which on a
   * pod-internal reconcile is one string for every record read out of the pod —
   * so both sides of the row said the same thing and named nothing a person
   * could act on.
   */
  sourceA?: string;
  sourceB?: string;
  /** The predicate the two sides disagree on, e.g. `clinical:dosage`. */
  conflictField?: string;
  /** What the `sourceA` side says. */
  valueA?: string;
  /** What the `sourceB` side says. */
  valueB?: string;
  /**
   * Which candidate record is still in the pod under its own IRI after the run
   * that raised this row. The other candidate may have been absorbed by a merge,
   * which is the whole reason the values above are on the row at all.
   */
  survivingRecordUri?: string;
}

/**
 * A conflict as the RECONCILER describes it, before it becomes a queue row.
 *
 * Structural on purpose: it names the fields of the reconciler's own
 * `unresolvedConflicts` entries without importing its types, so the queue store
 * does not depend on the reconciler. Every field is optional except the two the
 * conflict id is computed from, because an identity collision and a value
 * conflict are both raised through here and they carry different things.
 */
export interface RaisedConflict {
  recordType: string;
  matchedOn: string;
  /** The record that survives the run, when one of the candidates does. */
  canonicalUri?: string;
  candidateUris?: string[];
  label?: string;
  /** ORIGIN labels, one per record, in record order. */
  origins?: string[];
  /** INGESTION labels, one per record. The fallback when no origin is stated. */
  sources?: string[];
  conflictField?: string;
  conflictSides?: Array<{ origin: string; value: string; recordUri: string }>;
}

/**
 * Turn one raised conflict into the queue row that records it.
 *
 * ONE function because there are two callers — `pod reconcile` and the
 * reconciliation pass inside `pod import` — and they were two copies of the same
 * mapping. A row that carries the disagreement is only useful if EVERY verb that
 * raises one writes it the same way, and a second copy is how one of them
 * silently stops.
 */
export function pendingConflictFromRaised(
  c: RaisedConflict,
  detectedAt: Date = new Date(),
): PendingConflict {
  const sides = c.conflictSides ?? [];
  return {
    uri: `urn:uuid:conflict-${randomUUID()}`,
    conflictId: generateConflictId(c.recordType, c.matchedOn),
    recordType: c.recordType,
    detectedAt,
    candidateRecordUris: c.candidateUris ?? [],
    label: c.label,
    // Taken from the SIDES when there are sides, so `sourceA` and `valueA` are
    // guaranteed to describe the same record rather than two lists that happen
    // to be ordered alike. Origin next, and the ingestion label only as a last
    // resort: a run whose records state no origin still names its sides with
    // something, and a pod written before origins existed reads as it did.
    sourceA: sides[0]?.origin ?? c.origins?.[0] ?? c.sources?.[0],
    sourceB: sides[1]?.origin ?? c.origins?.[1] ?? c.sources?.[1],
    conflictField: c.conflictField,
    valueA: sides[0]?.value,
    valueB: sides[1]?.value,
    survivingRecordUri: c.canonicalUri,
  };
}

/**
 * Generate a deterministic conflict ID from record type and identity fields.
 * Same inputs always produce the same conflict ID (stable across re-imports).
 *
 * The FORMULA is unchanged and deliberately so; what changed is the `matchedOn`
 * strings the reconciler feeds it. See {@link legacyConflictIds}.
 */
export function generateConflictId(recordType: string, matchedOn: string): string {
  // Simple deterministic ID — use the matchedOn string from the reconciler
  const safe = `${recordType}::${matchedOn}`.replace(/[^a-zA-Z0-9:+./-]/g, '_');
  return safe.slice(0, 80);  // Truncate to avoid overly long IDs
}

/**
 * The conflict ids an EARLIER version of this CLI would have written for the same
 * conflict, for reading a pod it wrote. Never for writing.
 *
 * Two reconciler defects put ids on disk that this version no longer produces,
 * and both were in `matchedOn` rather than in the formula above:
 *
 *   1. A code URI was reduced by `uri.split('/').pop() ?? uri.split('#').pop()`,
 *      whose second operand is unreachable, so every LOINC code reached the id as
 *      `rdf#3094-0` instead of `3094-0`.
 *   2. A medication matched on partial name reported the bare constant
 *      `partial-name`, so EVERY partial-name medication conflict in a pod shared
 *      one id — which is why this matters beyond cosmetics:
 *      `settings/user-resolutions.ttl` is keyed by conflict id and cannot hold
 *      two rows under one key.
 *
 * `settings/pending-conflicts.ttl` does NOT need anything from here either, but
 * for a different reason than this comment used to give. It said the file
 * re-keys itself "because every import rewrites it wholesale from the run's own
 * conflicts" — which described the wholesale rewrite as the intended design when
 * it was the defect: an import that touched none of a row's records dropped that
 * row anyway. Both `pod reconcile` and `pod import` now put every pre-existing
 * row through a disposition (kept / cleared by merge / orphaned), so a row can
 * SURVIVE a run under the id it was written with. It still needs no legacy
 * lookup, because `pod resolve` matches the id the user pasted against whatever
 * that file literally holds. What does NOT re-key itself is the decision log:
 * `settings/user-resolutions.ttl` is keyed by conflict id, and a row recorded
 * before the id formula changed carries
 * the id from the old formula forever, and a lookup by the new id would miss it.
 * This function is how such a row is still found.
 *
 * Returns only ids that DIFFER from the current one, so a caller can treat a
 * non-empty result as "there is an older spelling to look for".
 */
export function legacyConflictIds(recordType: string, matchedOn: string): string[] {
  const current = generateConflictId(recordType, matchedOn);
  const candidates = new Set<string>();

  // (2) `partial-name:"lisinopril"` -> `partial-name`
  const bareName = matchedOn.replace(/^partial-name:".*"$/, 'partial-name');
  if (bareName !== matchedOn) candidates.add(generateConflictId(recordType, bareName));

  // (1) `loinc:3094-0+…` -> `loinc:rdf#3094-0+…`. Only LOINC is affected: it is
  // the one system whose URI carries a fragment (`http://loinc.org/rdf#3094-0`).
  const mangledLoinc = matchedOn.replace(/\b(loinc|loinc-approx):(?!rdf#)/g, '$1:rdf#');
  if (mangledLoinc !== matchedOn) candidates.add(generateConflictId(recordType, mangledLoinc));

  candidates.delete(current);
  return [...candidates].sort();
}

/**
 * The stored decision for a conflict, looked up under the id this version
 * generates and then under any id an earlier version would have written.
 *
 * Read-old, write-new: `saveUserResolution` always records under the current id,
 * so a pod converges on the new spelling as its conflicts are answered, while an
 * answer given before this change is still found.
 */
export function findUserResolution(
  resolutions: Map<string, UserResolution>,
  recordType: string,
  matchedOn: string,
): UserResolution | undefined {
  const current = resolutions.get(generateConflictId(recordType, matchedOn));
  if (current) return current;
  for (const id of legacyConflictIds(recordType, matchedOn)) {
    const found = resolutions.get(id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Load user resolutions from settings/user-resolutions.ttl.
 * Returns a Map from conflictId -> UserResolution.
 *
 * @param dek pod DEK when the pod is encrypted; omit for a plaintext pod.
 * @throws {ConflictStoreError} when the file exists but cannot be read, decrypted
 *   or parsed. An absent file is an empty map; a corrupt one is NOT.
 */
export async function loadUserResolutions(
  podDir: string,
  dek?: Buffer,
): Promise<Map<string, UserResolution>> {
  const filePath = join(podDir, 'settings', 'user-resolutions.ttl');
  const map = new Map<string, UserResolution>();

  const content = await readStoreFile(filePath, dek);
  if (content === null) return map; // File doesn't exist yet

  return new Promise((resolve, reject) => {
    const parser = new Parser({ format: 'Turtle' });
    const bySubject = new Map<string, Map<string, string>>();
    const discardedBySubject = new Map<string, string[]>();

    parser.parse(content, (error, quad) => {
      if (error) {
        // Used to resolve an empty map under "soft failure", which silently
        // forgot every recorded decision the user had made.
        reject(new ConflictStoreError(
          `Could not parse ${filePath}: ${error.message}`,
          filePath,
          error,
        ));
        return;
      }
      if (!quad) {
        for (const [uri, props] of bySubject) {
          const type = props.get(NS.rdf + 'type');
          if (type !== NS.cascade + 'UserResolution') continue;

          const conflictId = props.get(NS.cascade + 'conflictId');
          if (!conflictId) continue;

          const resolution = props.get(NS.cascade + 'resolution') as ResolutionChoice;
          const keptRecordUri = props.get(NS.cascade + 'keptRecord') ?? '';
          const resolvedAtStr = props.get(NS.cascade + 'resolvedAt');

          map.set(conflictId, {
            uri,
            conflictId,
            resolvedAt: resolvedAtStr ? new Date(resolvedAtStr) : new Date(),
            resolution: resolution ?? 'kept-source-a',
            keptRecordUri,
            discardedRecordUris: discardedBySubject.get(uri) ?? [],
            userNote: props.get(NS.cascade + 'userNote'),
            actorIri: props.get(NS.prov + 'wasAttributedTo'),
          });
        }
        resolve(map);
        return;
      }

      if (quad.predicate.value === NS.cascade + 'discardedRecords') {
        const arr = discardedBySubject.get(quad.subject.value) ?? [];
        arr.push(quad.object.value);
        discardedBySubject.set(quad.subject.value, arr);
      }

      if (!bySubject.has(quad.subject.value)) bySubject.set(quad.subject.value, new Map());
      bySubject.get(quad.subject.value)!.set(quad.predicate.value, quad.object.value);
    });
  });
}

/**
 * Save a user resolution to settings/user-resolutions.ttl.
 * Appends to existing file or creates it.
 *
 * @param dek pod DEK when the pod is encrypted; omit for a plaintext pod.
 * @throws {ConflictStoreError} when an existing file cannot be read. Writing a
 *   fresh file over decisions we failed to read would lose them.
 */
export async function saveUserResolution(
  podDir: string,
  resolution: UserResolution,
  dek?: Buffer,
): Promise<void> {
  const settingsDir = join(podDir, 'settings');
  await mkdir(settingsDir, { recursive: true });
  const filePath = join(settingsDir, 'user-resolutions.ttl');

  // Load existing resolutions
  const existing = await loadUserResolutions(podDir, dek);
  existing.set(resolution.conflictId, resolution);

  // Write all resolutions to file
  await writeUserResolutions(filePath, Array.from(existing.values()), dek);
}

async function writeUserResolutions(
  filePath: string,
  resolutions: UserResolution[],
  dek?: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const writer = new Writer({ prefixes: TURTLE_PREFIXES });

    for (const res of resolutions) {
      const subj = namedNode(res.uri);
      writer.addQuad(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.cascade + 'UserResolution')));
      writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'conflictId'), literal(res.conflictId)));
      writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'resolvedAt'),
        literal(res.resolvedAt.toISOString(), namedNode(NS.xsd + 'dateTime'))));
      writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'resolution'), literal(res.resolution)));
      if (res.keptRecordUri) {
        writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'keptRecord'), namedNode(res.keptRecordUri)));
      }
      for (const discarded of res.discardedRecordUris) {
        writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'discardedRecords'), namedNode(discarded)));
      }
      if (res.userNote) {
        writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'userNote'), literal(res.userNote)));
      }
      if (res.actorIri) {
        writer.addQuad(makeQuad(subj, namedNode(NS.prov + 'wasAttributedTo'), namedNode(res.actorIri)));
      }
    }

    writer.end((err, result) => {
      if (err) { reject(err); return; }
      try {
        writeResource(filePath, result, dek);
        resolve();
      } catch (writeErr) {
        reject(writeErr);
      }
    });
  });
}

/**
 * Write pending conflicts to settings/pending-conflicts.ttl.
 * Replaces the previous state entirely (written after each import).
 *
 * @param dek pod DEK when the pod is encrypted; omit for a plaintext pod. Without
 *   it this used to drop a plaintext file into a sealed pod on every import,
 *   which both leaked and produced a file DEK-aware readers could not read.
 */
export async function writePendingConflicts(
  podDir: string,
  conflicts: PendingConflict[],
  dek?: Buffer,
): Promise<void> {
  const settingsDir = join(podDir, 'settings');
  await mkdir(settingsDir, { recursive: true });
  const filePath = join(settingsDir, 'pending-conflicts.ttl');

  return new Promise((resolve, reject) => {
    const writer = new Writer({ prefixes: TURTLE_PREFIXES });

    for (const conflict of conflicts) {
      const subj = namedNode(conflict.uri);
      writer.addQuad(makeQuad(subj, namedNode(NS.rdf + 'type'), namedNode(NS.cascade + 'PendingConflict')));
      writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'conflictId'), literal(conflict.conflictId)));
      writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'recordType'), literal(conflict.recordType)));
      writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'detectedAt'),
        literal(conflict.detectedAt.toISOString(), namedNode(NS.xsd + 'dateTime'))));
      for (const uri of conflict.candidateRecordUris) {
        writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'candidateRecords'), namedNode(uri)));
      }
      if (conflict.label) writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'label'), literal(conflict.label)));
      if (conflict.sourceA) writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'sourceA'), literal(conflict.sourceA)));
      if (conflict.sourceB) writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'sourceB'), literal(conflict.sourceB)));
      // The substance of the disagreement, so the row stays answerable after the
      // run that raised it absorbed one of its candidate records. Every one is
      // written only when known, which is what keeps a row from an earlier CLI
      // and a row from this one the same shape apart from what is actually here.
      if (conflict.conflictField) {
        writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'conflictField'), literal(conflict.conflictField)));
      }
      if (conflict.valueA !== undefined) {
        writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'valueA'), literal(conflict.valueA)));
      }
      if (conflict.valueB !== undefined) {
        writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'valueB'), literal(conflict.valueB)));
      }
      if (conflict.survivingRecordUri) {
        writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'survivingRecord'), namedNode(conflict.survivingRecordUri)));
      }
    }

    writer.end((err, result) => {
      if (err) { reject(err); return; }
      try {
        writeResource(filePath, result, dek);
        resolve();
      } catch (writeErr) {
        reject(writeErr);
      }
    });
  });
}

/**
 * Load pending conflicts from settings/pending-conflicts.ttl.
 *
 * @param dek pod DEK when the pod is encrypted; omit for a plaintext pod.
 * @throws {ConflictStoreError} when the file exists but cannot be read, decrypted
 *   or parsed. An absent file is an empty list; a sealed or corrupt one is NOT,
 *   because "no conflicts" and "could not read the conflicts" are different
 *   answers and the caller has to be able to tell them apart.
 */
export async function loadPendingConflicts(
  podDir: string,
  dek?: Buffer,
): Promise<PendingConflict[]> {
  const filePath = join(podDir, 'settings', 'pending-conflicts.ttl');
  const conflicts: PendingConflict[] = [];

  const content = await readStoreFile(filePath, dek);
  if (content === null) return conflicts;

  return new Promise((resolve, reject) => {
    const parser = new Parser({ format: 'Turtle' });
    const bySubject = new Map<string, Map<string, string[]>>();

    parser.parse(content, (error, quad) => {
      if (error) {
        reject(new ConflictStoreError(
          `Could not parse ${filePath}: ${error.message}`,
          filePath,
          error,
        ));
        return;
      }
      if (!quad) {
        for (const [uri, props] of bySubject) {
          const types = props.get(NS.rdf + 'type') ?? [];
          if (!types.includes(NS.cascade + 'PendingConflict')) continue;

          const conflictIds = props.get(NS.cascade + 'conflictId') ?? [];
          if (!conflictIds[0]) continue;

          const detectedAts = props.get(NS.cascade + 'detectedAt') ?? [];

          conflicts.push({
            uri,
            conflictId: conflictIds[0],
            recordType: (props.get(NS.cascade + 'recordType') ?? ['unknown'])[0],
            detectedAt: detectedAts[0] ? new Date(detectedAts[0]) : new Date(),
            candidateRecordUris: props.get(NS.cascade + 'candidateRecords') ?? [],
            label: (props.get(NS.cascade + 'label') ?? [])[0],
            sourceA: (props.get(NS.cascade + 'sourceA') ?? [])[0],
            sourceB: (props.get(NS.cascade + 'sourceB') ?? [])[0],
            // Absent on every row written before these existed, and `undefined`
            // is the right answer for those: the disagreement was never
            // recorded, so the row says so rather than inventing a value.
            conflictField: (props.get(NS.cascade + 'conflictField') ?? [])[0],
            valueA: (props.get(NS.cascade + 'valueA') ?? [])[0],
            valueB: (props.get(NS.cascade + 'valueB') ?? [])[0],
            survivingRecordUri: (props.get(NS.cascade + 'survivingRecord') ?? [])[0],
          });
        }
        resolve(conflicts);
        return;
      }

      if (!bySubject.has(quad.subject.value)) bySubject.set(quad.subject.value, new Map());
      const existing = bySubject.get(quad.subject.value)!;
      const vals = existing.get(quad.predicate.value) ?? [];
      vals.push(quad.object.value);
      existing.set(quad.predicate.value, vals);
    });
  });
}
