/**
 * `cascade pod import <Apple Health export folder>`: the wellness half.
 *
 * The clinical-records FHIR in an Apple Health export goes through the ordinary
 * per-file import path. `export.xml` (the device firehose, 4.6 GB in a real
 * export) comes here instead, and is read exactly once, as a stream:
 *
 *   1. SCAN   one streaming pass; samples of the aggregated types go to an
 *             encrypted, day-partitioned scratch store (`scan.ts`, `spill.ts`).
 *   2. ZONE   the pod's `cascade:dayZone`, or the spec's default chain when the
 *             pod states none (the majority `HKTimeZone`, else the importing
 *             machine's zone), recorded on the profile and in the import report.
 *   3. DERIVE one closed day at a time: retain the day's samples, then compute
 *             that day's aggregates from exactly those samples (`aggregate.ts`).
 *   4. WRITE  sample files first (content-addressed attachments), then their
 *             descriptors, then the records that point at them. A computed
 *             aggregate is a derived view and is only written once the samples
 *             it derives from are in the pod.
 *
 * Every write is additive and deterministic: records are merged by subject,
 * each file is written in one canonical order, and nothing carries a per-run
 * value, so importing the same export twice leaves every file byte-identical.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Quad } from 'n3';
import { mergeIntoBucket } from '../bucket-write.js';
import { readResource, writeResource, writeResourceBytes, readResourceBytes } from '../pod-encryption.js';
import { DATA_TYPES } from '../pod-data-types.js';
import { PodReader } from '../pod-read.js';
import { SampleSpill } from './spill.js';
import { scanExport } from './scan.js';
import { aggregate, majorityTimeZone, type SampleFile, type WellnessRecord } from './aggregate.js';
import { appendAll } from '../append-all.js';
import { recordQuads, sampleFileQuads, ruleActivityQuads, sampleFilePath } from './quads.js';
import { fileTextChunks } from './xml-scanner.js';
import { canonicalZone, isKnownZone, isoUtc, machineZone } from './time.js';
import { wellnessRules } from './rules.js';

const CASCADE = 'https://ns.cascadeprotocol.org/core/v1#';
const HEALTH = 'https://ns.cascadeprotocol.org/health/v1#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * PROVISIONAL location of the descriptors of the retained sample files and of
 * the rule activity every aggregate names. A nested container under
 * `wellness/` (pod-structure.md section 4.2 permits nested containers there)
 * rather than a top-level bucket, because these are provenance for the
 * records, not records, and no registered data type claims them.
 */
export const WELLNESS_SAMPLES_DESCRIPTOR = 'wellness/samples/samples.ttl';

/** Which rule of the day-zone default chain applied. */
export type DayZoneRule = 'pod' | 'HKTimeZone majority' | 'importing machine' | 'UTC fallback';

export interface WellnessFileReport {
  /** `DATA_TYPES` key, or `wellness-samples` for the descriptor file. */
  key: string;
  /** Pod-relative path. */
  path: string;
  /** Records this import handed to the file. */
  recordsWritten: number;
  /** Of those, records the file did not already hold. */
  recordsNew: number;
  /** True when the file did not exist before this import. */
  created: boolean;
  /** The classes (full IRIs) of the records this import handed to the file, sorted. */
  classes: string[];
}

export interface WellnessImportReport {
  export: string;
  dayZone: { zone: string; rule: DayZoneRule; written: boolean };
  exportDate?: string;
  coverageEnd?: string;
  recordsRead: number;
  samplesRetained: number;
  samplesAggregated: number;
  correlationRecordsSkipped: number;
  invalidSamples: number;
  nonNumericSamples: number;
  unknownUnits: Record<string, number>;
  closedDays: number;
  openDaysSkipped: number;
  activitySummaries: { imported: number; sentinel: number; openDay: number; empty: number };
  /** Distinct workouts (a workout the export lists more than once is counted once; see `duplicateRecords`). */
  workouts: number;
  devices: number;
  /**
   * Records the export yielded more than once with identical content, by kind:
   * written once, counted here and nowhere else. The same name with DIFFERENT
   * content is a collision (`collisions`), never a duplicate.
   */
  duplicateRecords: Record<string, number>;
  /** Top-level `<Record>` types this release does not read, and how many of each the export holds. */
  unreadRecordTypes: Record<string, number>;
  sampleFiles: { total: number; new: number };
  files: WellnessFileReport[];
  /**
   * Names that arrived with content different from what the pod (or this same
   * export) already gave them. The pod keeps what it had; within one export,
   * the version whose canonical triples sort first is kept.
   */
  collisions: string[];
  warnings: string[];
  /** HealthKit types aggregated by this release. */
  built: string[];
}

export interface WellnessImportOptions {
  podDir: string;
  exportXmlPath: string;
  dek?: Buffer;
  dryRun?: boolean;
  /** Test seam: the export's text, in place of reading `exportXmlPath`. */
  chunks?: AsyncIterable<string>;
  /** Test seam: the zone to fall back to in place of the machine's. */
  machineZoneOverride?: string;
  /** Spill buffer budget, in characters (tests use a small one to force flushes). */
  spillBudgetChars?: number;
}

// ---------------------------------------------------------------------------
// Pod facts the aggregator reads
// ---------------------------------------------------------------------------

const LOCAL_ORIGIN = 'https://pod.invalid';

/** Parse a pod resource through the read layer, which holds the key. Undefined when it cannot be read or parsed. */
function readPodQuads(podDir: string, rel: string, dek?: Buffer): Quad[] | undefined {
  const r = new PodReader(podDir, dek).parseFile(path.join(podDir, rel), { baseIri: `${LOCAL_ORIGIN}/${rel}` });
  return r.ok ? r.value.quads : undefined;
}

/**
 * The pod subject component of every wellness seed: the owner's WebID as the
 * card states it (`/profile/card.ttl#me` for a local pod), or that default.
 *
 * PROVISIONAL. D-WELLNESS-1 requires only that this be stable for the life of
 * the pod. The pod's own identifier (a `urn:uuid` minted at pod creation) is
 * decided but not yet written by `pod init`; once it is, this function reads
 * it instead, and records minted before then are re-minted.
 */
export async function resolvePodSubject(podDir: string, dek?: Buffer): Promise<string> {
  const fallback = '/profile/card.ttl#me';
  if (!fs.existsSync(path.join(podDir, 'profile', 'card.ttl'))) return fallback;
  const quads = readPodQuads(podDir, 'profile/card.ttl', dek);
  const topic = quads?.find((q) => q.predicate.value === 'http://xmlns.com/foaf/0.1/primaryTopic')?.object.value;
  if (!topic) return fallback;
  return topic.startsWith(LOCAL_ORIGIN) ? topic.slice(LOCAL_ORIGIN.length) : topic;
}

/**
 * The `cascade:dayZone` the pod's owner-only profile states, if any.
 * `readable` is false when the profile exists and does not parse: the zone is
 * then unknown, and nothing may be appended to a file that cannot be read.
 */
export async function readPodDayZone(podDir: string, dek?: Buffer): Promise<{ zone?: string; readable: boolean }> {
  if (!fs.existsSync(path.join(podDir, 'profile', 'extended.ttl'))) return { readable: true };
  const quads = readPodQuads(podDir, 'profile/extended.ttl', dek);
  if (!quads) return { readable: false };
  const zone = quads.find((q) => q.predicate.value === CASCADE + 'dayZone' && q.object.termType === 'Literal')?.object.value;
  return { zone, readable: true };
}

/**
 * Record the day zone on the owner-only extended profile, once. Appended as a
 * statement of its own, with a full IRI, so the hand-curated comments in the
 * file survive and the triple parses whatever prefixes the file declares.
 */
function writePodDayZone(podDir: string, zone: string, rule: DayZoneRule, dek?: Buffer): void {
  const ext = path.join(podDir, 'profile', 'extended.ttl');
  const existing = fs.existsSync(ext) ? readResource(ext, dek) : '';
  const block =
    `\n# The zone a day is cut in for daily wellness records (cascade:dayZone).\n` +
    `# Set by the first wellness import (${rule}). Change it only on a permanent move.\n` +
    `<#me> <${CASCADE}dayZone> "${zone}" .\n`;
  fs.mkdirSync(path.dirname(ext), { recursive: true });
  writeResource(ext, existing + block, dek);
}

// ---------------------------------------------------------------------------
// Canonical, additive merge
// ---------------------------------------------------------------------------

function termKey(t: Quad['object']): string {
  if (t.termType === 'Literal') return `L${t.value}\u0000${t.datatype?.value ?? ''}\u0000${t.language ?? ''}`;
  return `${t.termType[0]}${t.value}`;
}

function quadKey(q: Quad): string {
  return `${q.predicate.value}\u0000${termKey(q.object)}`;
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Merge incoming records into what a file holds, by subject, and return the
 * result in one canonical order (subjects, then each subject's triples, sorted),
 * so the bytes written depend only on the set of triples.
 *
 *   - A subject the file lacks is added.
 *   - A subject the file holds with the same triples is left alone.
 *   - A `health:Device` the file holds is UNIONED: its manufacturer and
 *     software spellings are set-valued and accumulate across exports.
 *   - Any other subject the file holds with DIFFERENT triples is left as it
 *     was and reported. A record is never edited in place (layer 1 only adds).
 */
function additiveCanonicalMerge(
  existing: Quad[],
  incoming: Quad[],
  stats: { added: number; collisions: string[] },
): Quad[] {
  const group = (quads: Quad[]): Map<string, Quad[]> => {
    const m = new Map<string, Quad[]>();
    for (const q of quads) {
      const k = `${q.subject.termType[0]}${q.subject.value}`;
      let a = m.get(k);
      if (!a) m.set(k, (a = []));
      a.push(q);
    }
    return m;
  };
  const have = group(existing);
  // `incoming` holds each subject once: same-name records within one export
  // were compared and resolved before the write (`dedupeRecords`).
  for (const [k, quads] of group(incoming)) {
    const prior = have.get(k);
    if (!prior) {
      have.set(k, quads);
      stats.added++;
      continue;
    }
    const priorKeys = new Set(prior.map(quadKey));
    const incomingKeys = new Set(quads.map(quadKey));
    const same = priorKeys.size === incomingKeys.size && [...incomingKeys].every((x) => priorKeys.has(x));
    if (same) continue;
    const isDevice = prior.some((q) => q.predicate.value === RDF_TYPE && q.object.value === HEALTH + 'Device');
    if (isDevice) {
      for (const q of quads) if (!priorKeys.has(quadKey(q))) prior.push(q);
      continue;
    }
    stats.collisions.push(quads[0].subject.value);
  }
  const out: Quad[] = [];
  for (const k of [...have.keys()].sort(cmpStr)) {
    const seen = new Set<string>();
    const sorted = [...have.get(k)!].sort((a, b) => cmpStr(quadKey(a), quadKey(b)));
    for (const q of sorted) {
      const qk = quadKey(q);
      if (seen.has(qk)) continue;
      seen.add(qk);
      out.push(q);
    }
  }
  return out;
}

/** One record's triples and the canonical string they compare by. */
interface PreparedRecord {
  record: WellnessRecord;
  quads: Quad[];
  canonical: string;
}

/**
 * Resolve records the export yielded under one name. Identical content is a
 * duplicate (an export can list the same workout twice): kept once and
 * counted. Different content is a collision: reported, and the version whose
 * canonical triples sort first is kept, so the outcome does not depend on the
 * order the export listed them in. Never a union of the two.
 */
function dedupeRecords(records: WellnessRecord[]): {
  unique: PreparedRecord[];
  duplicates: Record<string, number>;
  collisions: string[];
} {
  const byIri = new Map<string, PreparedRecord>();
  const duplicates: Record<string, number> = {};
  const collided = new Set<string>();
  for (const record of records) {
    const quads = recordQuads(record);
    const canonical = quads.map(quadKey).sort(cmpStr).join('\u0001');
    const prior = byIri.get(record.iri);
    if (!prior) {
      byIri.set(record.iri, { record, quads, canonical });
      continue;
    }
    if (prior.canonical === canonical) {
      duplicates[record.kind] = (duplicates[record.kind] ?? 0) + 1;
      continue;
    }
    collided.add(record.iri);
    if (canonical < prior.canonical) byIri.set(record.iri, { record, quads, canonical });
  }
  return { unique: [...byIri.values()], duplicates, collisions: [...collided].sort(cmpStr) };
}

async function writeFile(
  podDir: string,
  rel: string,
  key: string,
  quads: Quad[],
  subjects: number,
  dek: Buffer | undefined,
  dryRun: boolean,
  collisions: string[],
): Promise<WellnessFileReport> {
  const target = path.join(podDir, ...rel.split('/'));
  const created = !fs.existsSync(target);
  const stats = { added: 0, collisions: [] as string[] };
  await mergeIntoBucket(target, quads, dek, {
    dryRun,
    combine: (existing, incoming) => additiveCanonicalMerge(existing, incoming, stats),
  });
  appendAll(collisions, stats.collisions.map((s) => `${rel}: ${s}`));
  const classes = [...new Set(quads.filter((q) => q.predicate.value === RDF_TYPE).map((q) => q.object.value))].sort(cmpStr);
  return { key, path: rel, recordsWritten: subjects, recordsNew: stats.added, created, classes };
}

// ---------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------

export async function importAppleHealthWellness(opts: WellnessImportOptions): Promise<WellnessImportReport> {
  const { podDir, dek } = opts;
  const dryRun = opts.dryRun ?? false;
  const rules = wellnessRules();
  const spill = new SampleSpill(opts.spillBudgetChars);
  try {
    // 1. SCAN
    const scan = await scanExport(opts.chunks ?? fileTextChunks(opts.exportXmlPath), spill);

    // 2. ZONE
    const warnings: string[] = [];
    let zone: string | undefined;
    let rule: DayZoneRule = 'pod';
    const profile = await readPodDayZone(podDir, dek);
    const stated = profile.zone;
    if (!profile.readable) {
      warnings.push('profile/extended.ttl could not be read as Turtle, so the pod\'s day zone is unknown; a default was used for this import and nothing was written to the profile.');
    }
    if (stated !== undefined) {
      if (isKnownZone(stated)) zone = stated;
      else warnings.push(`The pod's cascade:dayZone "${stated}" is not a known IANA zone name; it was left as it is and a default was used for this import.`);
    }
    if (!zone) {
      const majority = majorityTimeZone(scan.timeZoneCounts);
      const machine = canonicalZone(opts.machineZoneOverride ?? machineZone() ?? '');
      if (majority) {
        zone = majority;
        rule = 'HKTimeZone majority';
      } else if (machine) {
        zone = machine;
        rule = 'importing machine';
      } else {
        zone = 'UTC';
        rule = 'UTC fallback';
      }
    }
    const writeZone = stated === undefined && profile.readable;
    if (!dryRun && writeZone) writePodDayZone(podDir, zone, rule, dek);

    // 3. DERIVE, and 4a. WRITE each day's sample pack as soon as it is built,
    // before any aggregate derived from it is written, and without holding
    // every day's bytes until the end.
    const podSubject = await resolvePodSubject(podDir, dek);
    let newSampleFiles = 0;
    const writeSamplePack = (f: SampleFile, bytes: Buffer): void => {
      const target = path.join(podDir, ...sampleFilePath(f.digest).split('/'));
      if (fs.existsSync(target)) {
        // Content-addressed: a file already under this name holds these bytes,
        // unless it was damaged. Verify rather than trust, and never overwrite.
        let intact = false;
        try {
          intact = readResourceBytes(target, dek).equals(bytes);
        } catch {
          intact = false;
        }
        if (!intact) warnings.push(`${sampleFilePath(f.digest)} exists but does not hold the bytes its name promises; it was left untouched.`);
        return;
      }
      newSampleFiles++;
      if (!dryRun) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        writeResourceBytes(target, bytes, dek);
      }
    };
    const agg = aggregate(scan, spill, { podSubject, dayZone: zone, onSampleFile: writeSamplePack });
    appendAll(warnings, agg.warnings);
    // The scratch store has served its purpose; drop it before the writes.
    spill.close();

    // 4b. Descriptors, then the records that point at them.
    const collisions: string[] = [];
    const deduped = dedupeRecords(agg.records);
    for (const iri of deduped.collisions) collisions.push(`(this export): ${iri}`);
    const files: WellnessFileReport[] = [];
    const hasAggregates = deduped.unique.some((r) => r.record.kind === 'vitalReading' || r.record.kind === 'stepSnapshot');
    if (hasAggregates) {
      const quads = ruleActivityQuads(agg.activity);
      for (const f of agg.sampleFiles) appendAll(quads, sampleFileQuads(f));
      files.push(
        await writeFile(podDir, WELLNESS_SAMPLES_DESCRIPTOR, 'wellness-samples', quads, agg.sampleFiles.length + 1, dek, dryRun, collisions),
      );
    }

    const byFile = new Map<string, PreparedRecord[]>();
    for (const r of deduped.unique) {
      let a = byFile.get(r.record.fileKey);
      if (!a) byFile.set(r.record.fileKey, (a = []));
      a.push(r);
    }
    for (const key of [...byFile.keys()].sort(cmpStr)) {
      const info = DATA_TYPES[key];
      if (!info) throw new Error(`wellness rules name an unknown pod data type "${key}"`);
      const records = byFile.get(key)!;
      const rel = `${info.directory}/${info.filename}`;
      const quads: Quad[] = [];
      for (const r of records) appendAll(quads, r.quads);
      files.push(await writeFile(podDir, rel, key, quads, records.length, dek, dryRun, collisions));
    }

    if (collisions.length > 0) {
      warnings.push(
        `${collisions.length} name(s) arrived with content different from what the pod or this export already gave them; ` +
          `the version already held was kept, nothing was edited in place and no two versions were merged: ` +
          `${collisions.slice(0, 5).join(', ')}${collisions.length > 5 ? ', ...' : ''}`,
      );
    }
    const unknownUnitTotal = Object.values(agg.unknownUnits).reduce((a, b) => a + b, 0);
    if (unknownUnitTotal > 0) {
      warnings.push(
        `${unknownUnitTotal} sample(s) in a unit the wellness rules do not accept were not aggregated: ` +
          Object.entries(agg.unknownUnits)
            .sort((a, b) => cmpStr(a[0], b[0]))
            .map(([k, n]) => `${k} (${n})`)
            .join(', '),
      );
    }

    const count = (kind: WellnessRecord['kind']): number => deduped.unique.filter((r) => r.record.kind === kind).length;
    return {
      export: opts.exportXmlPath,
      dayZone: { zone, rule, written: writeZone && !dryRun },
      exportDate: scan.exportDate === undefined ? undefined : isoUtc(scan.exportDate),
      coverageEnd: agg.coverageEnd === undefined ? undefined : isoUtc(agg.coverageEnd),
      recordsRead: scan.recordsRead,
      samplesRetained: agg.samplesRetained,
      samplesAggregated: agg.samplesAggregated,
      correlationRecordsSkipped: scan.correlationRecordsSkipped,
      invalidSamples: scan.invalidSamples,
      nonNumericSamples: agg.nonNumericSamples,
      unknownUnits: agg.unknownUnits,
      closedDays: agg.closedDays,
      openDaysSkipped: agg.openDaysSkipped,
      activitySummaries: { imported: count('activitySummary'), ...agg.activitySummariesSkipped },
      workouts: count('workout'),
      devices: count('device'),
      duplicateRecords: deduped.duplicates,
      unreadRecordTypes: Object.fromEntries([...scan.unreadRecordTypes.entries()].sort((a, b) => cmpStr(a[0], b[0]))),
      sampleFiles: { total: agg.sampleFiles.length, new: newSampleFiles },
      files,
      collisions,
      warnings,
      built: rules.metrics.map((m) => m.hkType),
    };
  } finally {
    spill.close();
  }
}
