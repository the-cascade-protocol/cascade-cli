/**
 * The differential coverage computation, shared by the conformance test and by
 * `cascade sources coverage`.
 *
 * ONE experiment, run per populated element path:
 *
 *   1. Convert the resource.
 *   2. Convert a copy with exactly that element deleted.
 *   3. Compare the two outputs.
 *
 * Identical output means the element reached nothing: not a triple, not an IRI,
 * not a warning-free difference of any kind. That is a DROP, whatever the
 * converter's source code appears to do with the field.
 *
 * WHAT "IDENTICAL" MEANS, AND WHY THE SUBJECT IRI IS PART OF IT
 * ------------------------------------------------------------
 * Records are compared as a multiset of predicate + object, not as raw quads,
 * because on the content-keyed types (Condition, AllergyIntolerance, lab
 * Observation, Immunization, Patient) deleting a field can re-mint the subject
 * IRI and shift every quad's subject with it. Comparing raw quads would then
 * report "everything changed" for a field that changed nothing else.
 *
 * The subject SET is compared separately and a change in it counts as EMITTED,
 * because a field that moves the IRI is a field that participates in identity:
 * it decides which records merge, which is a stronger form of reaching the pod
 * than a triple is. This is the join with `clinical-identity.test.ts`, which
 * holds the next link — that every serialized field is in the identity key or
 * excluded in writing. Source -> serialized is proven here; serialized ->
 * identity is proven there; a field cannot silently skip a layer.
 */

import type { Quad } from 'n3';

import { convertFhirResourceToQuads } from '../fhir-to-cascade.js';
import { EXCLUDED_TYPES } from '../converters-passthrough.js';
import { childFieldPaths, enumerateFieldPaths, topLevelFieldPaths, withoutPath } from './paths.js';
import type { FieldCoverageVerdict, FieldDropEntry } from './types.js';
import { lookupFieldDrop } from './manifests/index.js';

/**
 * A conversion's content, independent of which subject IRI carries it.
 *
 * Object terms are compared with their term type, datatype and language, so a
 * literal "5" and a reference to `.../5` are two different outputs, and an
 * `xsd:dateTime` is not equal to the same characters as a plain string.
 */
function contentSignature(quads: readonly Quad[]): string {
  const triples = quads.map((q) => {
    const o = q.object;
    const datatype = 'datatype' in o && o.datatype ? o.datatype.value : '';
    const language = 'language' in o && o.language ? o.language : '';
    return [q.predicate.value, o.termType, o.value, datatype, language].join('\u0000');
  });
  triples.sort();
  return triples.join('\u0001');
}

/** The set of subject IRIs a conversion minted. */
function subjectSignature(quads: readonly Quad[]): string {
  return [...new Set(quads.map((q) => q.subject.value))].sort().join('\u0001');
}

interface Conversion {
  content: string;
  subjects: string;
}

function convertOnce(resource: unknown): Conversion | undefined {
  const result = convertFhirResourceToQuads(structuredClone(resource));
  if (!result) return undefined;
  return { content: contentSignature(result._quads), subjects: subjectSignature(result._quads) };
}

/** What the analysis found for one resource. */
export interface ResourceCoverage {
  resourceType: string;
  /** Populated element paths whose deletion changes the converted output. */
  emitted: string[];
  /** Populated element paths whose deletion changes nothing. */
  dropped: string[];
  /**
   * Paths that could not be tested (the deletion did not resolve, or conversion
   * returned nothing). Never silently folded into `dropped`: an untestable path
   * reported as a drop is a live field described as lost.
   */
  untestable: string[];
  /** True for a resource type excluded wholesale (see EXCLUDED_TYPES). */
  typeExcluded: boolean;
}

/**
 * Run the differential over the populated elements of one resource.
 *
 * The walk descends only into elements that PROVED emitted: a dropped element
 * takes its whole subtree with it (see `paths.ts` on why that is sound), so one
 * omission is reported once, at the level a person would name it.
 *
 * Cost is one conversion per visited path plus one baseline. Conversions are
 * pure and local, so this is fast enough to run over a whole pod's retained
 * sources, and no result is cached across resources: emission can depend on a
 * VALUE (a coding system that maps, a status that is recognised), so collapsing
 * two resources of the same shape into one measurement would report a field as
 * kept on records where it was not.
 */
export function analyzeResourceCoverage(resource: unknown): ResourceCoverage {
  const resourceType =
    typeof (resource as { resourceType?: unknown })?.resourceType === 'string'
      ? (resource as { resourceType: string }).resourceType
      : 'Unknown';

  if (EXCLUDED_TYPES.has(resourceType)) {
    return { resourceType, emitted: [], dropped: [], untestable: [], typeExcluded: true };
  }

  const baseline = convertOnce(resource);
  if (!baseline) {
    return {
      resourceType,
      emitted: [],
      dropped: [],
      untestable: enumerateFieldPaths(resource),
      typeExcluded: false,
    };
  }

  const emitted: string[] = [];
  const dropped: string[] = [];
  const untestable: string[] = [];

  const queue = [...topLevelFieldPaths(resource)];
  while (queue.length > 0) {
    const path = queue.shift()!;
    const reduced = withoutPath(resource, path);
    if (reduced === undefined) {
      untestable.push(path);
      continue;
    }
    const after = convertOnce(reduced);
    if (!after) {
      untestable.push(path);
      continue;
    }
    if (after.content === baseline.content && after.subjects === baseline.subjects) {
      // Dropped: the subtree below it is dropped with it, and saying so once is
      // the whole difference between a manifest and a transcript.
      dropped.push(path);
      continue;
    }
    emitted.push(path);
    queue.push(...childFieldPaths(resource, path));
  }

  return { resourceType, emitted, dropped, untestable, typeExcluded: false };
}

/** Per-path verdicts with the manifest entry that covers each drop, if any. */
export function verdicts(coverage: ResourceCoverage): FieldCoverageVerdict[] {
  const out: FieldCoverageVerdict[] = [];
  for (const path of coverage.emitted) {
    out.push({ path, emitted: true, entry: lookupFieldDrop(coverage.resourceType, path) });
  }
  for (const path of coverage.dropped) {
    out.push({ path, emitted: false, entry: lookupFieldDrop(coverage.resourceType, path) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Corpus aggregation — the runtime twin
// ---------------------------------------------------------------------------

/** One dropped element path, with how often it was populated and its status. */
export interface DroppedPathTally {
  path: string;
  /** How many resources of this type populated the path but did not emit it. */
  count: number;
  status: 'acknowledged' | 'pending' | 'unaccounted';
  backlog?: string;
  reason?: string;
}

/** What a corpus scan found, per resource type. Paths and counts only. */
export interface TypeCoverageSummary {
  resourcesScanned: number;
  populatedFields: number;
  emittedFields: number;
  droppedFields: number;
  droppedPaths: DroppedPathTally[];
  untestablePaths: string[];
}

/** The whole-corpus report. Contains no values from the source, by construction. */
export interface CoverageReport {
  resourcesScanned: number;
  /** Resources whose whole type is excluded from conversion (EXCLUDED_TYPES). */
  resourcesTypeExcluded: number;
  totals: {
    populatedFields: number;
    emittedFields: number;
    droppedFields: number;
    acknowledged: number;
    pending: number;
    unaccounted: number;
  };
  byType: Record<string, TypeCoverageSummary>;
}

function statusOf(entry: FieldDropEntry | undefined): DroppedPathTally['status'] {
  if (!entry) return 'unaccounted';
  return entry.disposition;
}

/**
 * Accumulates coverage across many resources into a report of PATHS AND COUNTS.
 *
 * Nothing from the source's content enters this structure: element paths are
 * schema, counts are arithmetic. That is what makes the report shareable — a
 * design partner can send the shape of what their EHR populates without sending
 * a single value out of their pod.
 */
export class CoverageAccumulator {
  private scanned = 0;
  private typeExcluded = 0;
  private readonly types = new Map<
    string,
    {
      resources: number;
      populated: number;
      emitted: number;
      dropped: number;
      paths: Map<string, { count: number; entry?: FieldDropEntry }>;
      untestable: Set<string>;
    }
  >();

  add(resource: unknown): void {
    const coverage = analyzeResourceCoverage(resource);
    this.scanned++;
    if (coverage.typeExcluded) {
      this.typeExcluded++;
      return;
    }
    let bucket = this.types.get(coverage.resourceType);
    if (!bucket) {
      bucket = {
        resources: 0,
        populated: 0,
        emitted: 0,
        dropped: 0,
        paths: new Map(),
        untestable: new Set(),
      };
      this.types.set(coverage.resourceType, bucket);
    }
    bucket.resources++;
    bucket.populated += coverage.emitted.length + coverage.dropped.length;
    bucket.emitted += coverage.emitted.length;
    bucket.dropped += coverage.dropped.length;
    for (const path of coverage.dropped) {
      const existing = bucket.paths.get(path);
      if (existing) existing.count++;
      else bucket.paths.set(path, { count: 1, entry: lookupFieldDrop(coverage.resourceType, path) });
    }
    for (const path of coverage.untestable) bucket.untestable.add(path);
  }

  report(): CoverageReport {
    const byType: Record<string, TypeCoverageSummary> = {};
    const totals = {
      populatedFields: 0,
      emittedFields: 0,
      droppedFields: 0,
      acknowledged: 0,
      pending: 0,
      unaccounted: 0,
    };

    for (const [resourceType, bucket] of [...this.types.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    )) {
      const droppedPaths: DroppedPathTally[] = [...bucket.paths.entries()]
        .map(([path, { count, entry }]) => ({
          path,
          count,
          status: statusOf(entry),
          backlog: entry?.backlog,
          reason: entry?.reason,
        }))
        .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1));

      for (const tally of droppedPaths) totals[tally.status] += tally.count;

      totals.populatedFields += bucket.populated;
      totals.emittedFields += bucket.emitted;
      totals.droppedFields += bucket.dropped;

      byType[resourceType] = {
        resourcesScanned: bucket.resources,
        populatedFields: bucket.populated,
        emittedFields: bucket.emitted,
        droppedFields: bucket.dropped,
        droppedPaths,
        untestablePaths: [...bucket.untestable].sort(),
      };
    }

    return {
      resourcesScanned: this.scanned,
      resourcesTypeExcluded: this.typeExcluded,
      totals,
      byType,
    };
  }
}

/** Convenience: a report over an iterable of resources. */
export function analyzeCorpus(resources: Iterable<unknown>): CoverageReport {
  const acc = new CoverageAccumulator();
  for (const resource of resources) acc.add(resource);
  return acc.report();
}

/**
 * The one-line disclosure the import manifest carries.
 *
 * Deliberately states where the unimported data still IS. Nothing is lost when
 * the raw bundle is retained: every field below is recoverable by re-import once
 * the converter widens, and a user who is told a number but not that fact reads
 * it as data destroyed.
 */
export function coverageDisclosure(report: CoverageReport): string {
  const { droppedFields, unaccounted } = report.totals;
  if (droppedFields === 0) return 'Every populated source field was imported.';
  const unaccountedNote =
    unaccounted > 0 ? ` ${unaccounted} of them are not on any converter's drop manifest.` : '';
  return (
    `${droppedFields} populated field${droppedFields === 1 ? '' : 's'} across ` +
    `${report.resourcesScanned} resource${report.resourcesScanned === 1 ? '' : 's'} ` +
    `${droppedFields === 1 ? 'was' : 'were'} not imported; the raw source is retained under sources/ ` +
    `and a re-import recovers them once the converter emits them.${unaccountedNote}`
  );
}
