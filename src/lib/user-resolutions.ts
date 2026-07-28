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
        throw new ConflictStoreError(
          `Could not decrypt ${filePath}: ${err.message}`,
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
}

export interface PendingConflict {
  uri: string;             // urn:uuid:conflict-{conflictId}
  conflictId: string;
  recordType: string;      // e.g. "health:ConditionRecord"
  detectedAt: Date;
  candidateRecordUris: string[];
  // Human-readable summary fields (for display)
  label?: string;          // e.g. "Hypertension"
  sourceA?: string;        // source system name
  sourceB?: string;
}

/**
 * Generate a deterministic conflict ID from record type and identity fields.
 * Same inputs always produce the same conflict ID (stable across re-imports).
 */
export function generateConflictId(recordType: string, matchedOn: string): string {
  // Simple deterministic ID — use the matchedOn string from the reconciler
  const safe = `${recordType}::${matchedOn}`.replace(/[^a-zA-Z0-9:+./-]/g, '_');
  return safe.slice(0, 80);  // Truncate to avoid overly long IDs
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
