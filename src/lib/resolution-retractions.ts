/**
 * Writing the consequence of an owner's keep-one answer to a conflict.
 *
 * `pod resolve --keep source-a|source-b` records a judgement in
 * `settings/user-resolutions.ttl`. The reconciler reads those judgements as an
 * input and reports, for every pair a judgement names that is still in the pod,
 * which record the owner chose against ({@link Supersession}). This module
 * writes each one as the SAME append-only overlay `pod retract --superseded-by`
 * writes, a `workbench:Retraction` with `workbench:supersededBy`, so a reader
 * that already honours a hand-made merge honours this one without learning a
 * second representation.
 *
 * Two things set it apart from a hand-written retraction, and both are
 * additive triples on the same class:
 *
 *   prov:wasDerivedFrom <the UserResolution>   the judgement that caused it.
 *     The convention the reconciler already uses for "this was produced from
 *     that"; a retraction derived from a decision is an entity derived from an
 *     entity.
 *   cascade:autoResolved true                  the core term for "resolved by
 *     applying a stored user resolution".
 *
 * IDEMPOTENT BY CONSTRUCTION
 * --------------------------
 * The overlay's subject IRI is derived from the judgement's IRI and the
 * superseded record's IRI, and its `dct:created` is the judgement's own
 * timestamp. So the overlay is a function of the judgement alone: a second run
 * finds it already present and writes nothing, and a pod rebuilt from the same
 * records and the same `user-resolutions.ttl` gets the identical overlay.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DataFactory, Parser } from 'n3';
import { deterministicUuid } from './fhir-converter/types.js';
import { readResource } from './pod-encryption.js';
import { relBaseFor } from './bucket-write.js';
import {
  ANNOTATIONS_DIR,
  appendOverlays,
  iriRef,
  strLit,
  type OverlaySpec,
} from './annotations.js';
import type { Supersession } from './reconciler.js';

const { literal, namedNode } = DataFactory;

/** The overlay file retractions live in, as `pod retract` writes it. */
export const RETRACTIONS_FILE = 'retractions.ttl';

const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';

/** The retraction overlay's subject IRI for one supersession. Stable. */
export function supersessionRetractionUri(s: Supersession): string {
  return `urn:uuid:${deterministicUuid(`user-resolution-retraction|${s.resolutionUri}|${s.supersededRecordUri}`)}`;
}

/** The overlay `pod retract --superseded-by` would write, plus the link. */
export function supersessionOverlay(s: Supersession): OverlaySpec {
  return {
    fileName: RETRACTIONS_FILE,
    subjectUri: supersessionRetractionUri(s),
    rdfType: 'workbench:Retraction',
    lines: [
      { predicate: 'workbench:retractsRecord', object: iriRef(s.supersededRecordUri) },
      {
        predicate: 'workbench:retractionReason',
        object: strLit(`Superseded by the owner's resolution of conflict ${s.conflictId}`),
      },
      { predicate: 'workbench:supersededBy', object: iriRef(s.keptRecordUri) },
      { predicate: 'prov:wasDerivedFrom', object: iriRef(s.resolutionUri) },
      { predicate: 'cascade:autoResolved', object: literal('true', namedNode(XSD_BOOLEAN)) },
    ],
    actorIri: s.actorIri,
    createdIso: s.resolvedAt,
  };
}

/** Subjects already present in the pod's retraction overlays. */
function existingRetractionSubjects(podDir: string, dek: Buffer | undefined): Set<string> {
  const file = path.join(podDir, ANNOTATIONS_DIR, RETRACTIONS_FILE);
  if (!fs.existsSync(file)) return new Set();
  // A file that exists and cannot be read or parsed throws: writing beside
  // overlays this run could not see would risk a duplicate, and the overlay
  // writer below refuses an unparseable file anyway.
  const text = readResource(file, dek);
  const subjects = new Set<string>();
  for (const q of new Parser({ format: 'Turtle', baseIRI: relBaseFor(text) }).parse(text)) {
    subjects.add(q.subject.value);
  }
  return subjects;
}

/**
 * Write every supersession not already in the pod.
 *
 * @returns how many overlays were written and how many were already there.
 */
export async function writeSupersessionRetractions(
  podDir: string,
  supersessions: readonly Supersession[],
  dek: Buffer | undefined,
): Promise<{ written: number; alreadyPresent: number }> {
  if (supersessions.length === 0) return { written: 0, alreadyPresent: 0 };
  const present = existingRetractionSubjects(podDir, dek);
  const toWrite = supersessions.filter((s) => !present.has(supersessionRetractionUri(s)));
  await appendOverlays(podDir, RETRACTIONS_FILE, toWrite.map(supersessionOverlay), dek);
  return { written: toWrite.length, alreadyPresent: supersessions.length - toWrite.length };
}
