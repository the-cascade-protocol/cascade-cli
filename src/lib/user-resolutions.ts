/**
 * Persistence layer for user conflict resolutions and pending conflicts.
 *
 * Files written to the pod:
 *   settings/user-resolutions.ttl — User's stored resolution decisions
 *   settings/pending-conflicts.ttl — Unresolved conflicts from most recent import
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Parser, Writer, DataFactory } from 'n3';
import { NS, TURTLE_PREFIXES } from './fhir-converter/types.js';
import { randomUUID } from 'node:crypto';

export { randomUUID };

const { namedNode, literal, quad: makeQuad } = DataFactory;

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
 */
export async function loadUserResolutions(podDir: string): Promise<Map<string, UserResolution>> {
  const filePath = join(podDir, 'settings', 'user-resolutions.ttl');
  const map = new Map<string, UserResolution>();

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return map; // File doesn't exist yet
  }

  return new Promise((resolve) => {
    const parser = new Parser({ format: 'Turtle' });
    const bySubject = new Map<string, Map<string, string>>();
    const discardedBySubject = new Map<string, string[]>();

    parser.parse(content, (error, quad) => {
      if (error) { resolve(map); return; }  // Soft failure — return empty map
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
 */
export async function saveUserResolution(podDir: string, resolution: UserResolution): Promise<void> {
  const settingsDir = join(podDir, 'settings');
  await mkdir(settingsDir, { recursive: true });
  const filePath = join(settingsDir, 'user-resolutions.ttl');

  // Load existing resolutions
  const existing = await loadUserResolutions(podDir);
  existing.set(resolution.conflictId, resolution);

  // Write all resolutions to file
  await writeUserResolutions(filePath, Array.from(existing.values()));
}

async function writeUserResolutions(filePath: string, resolutions: UserResolution[]): Promise<void> {
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

    writer.end(async (err, result) => {
      if (err) { reject(err); return; }
      try {
        await writeFile(filePath, result, 'utf-8');
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
 */
export async function writePendingConflicts(podDir: string, conflicts: PendingConflict[]): Promise<void> {
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

    writer.end(async (err, result) => {
      if (err) { reject(err); return; }
      try {
        await writeFile(filePath, result, 'utf-8');
        resolve();
      } catch (writeErr) {
        reject(writeErr);
      }
    });
  });
}

/**
 * Load pending conflicts from settings/pending-conflicts.ttl.
 */
export async function loadPendingConflicts(podDir: string): Promise<PendingConflict[]> {
  const filePath = join(podDir, 'settings', 'pending-conflicts.ttl');
  const conflicts: PendingConflict[] = [];

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return conflicts;
  }

  return new Promise((resolve) => {
    const parser = new Parser({ format: 'Turtle' });
    const bySubject = new Map<string, Map<string, string[]>>();

    parser.parse(content, (error, quad) => {
      if (error) { resolve(conflicts); return; }
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
