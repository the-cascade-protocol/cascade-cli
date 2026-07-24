/**
 * Full-scale bundle == split equivalence for cross-file reference resolution
 * (root backlog 3.22; builds on R5 / root 2.11).
 *
 * R5 moved reference resolution from per-CONVERSION-BATCH to once per IMPORT
 * INVOCATION so an Apple Health export (one FHIR resource per file) resolves the
 * same cross-file edges a single Bundle resolves in-batch. R5's committed
 * synthetic fixture (9 files) proves the MECHANISM; the real Apple Health export
 * proves the real source (which structurally carries no Encounter resource, so
 * its hasEncounter answer is a permanent zero and it cannot be committed).
 *
 * This test closes the gap between them: it takes the PHI-free Synthea specimen
 * bundle (Grant908_Haley279, a single 254-resource FHIR Bundle with FULL
 * relationship richness), splits it into the one-resource-per-file Apple Health
 * layout at test time via the committed `scripts/2026-07-23-split-fhir-bundle.mjs`
 * splitter, imports BOTH layouts into fresh pods, and asserts they are
 * equivalent: identical record subjects and identical resolved edge triples
 * across all four edge families, with NONZERO encounter resolution (181) because
 * the specimen carries its Encounter resources. Any future per-batch or per-file
 * resolution regression breaks this equivalence at full scale.
 *
 * The bundle is committed minified (test-fixtures/synthea-grant908-bundle.json,
 * byte-derived from the Synthea FHIR output); the split corpus is generated at
 * test time so the repo carries one artifact, not 254 files.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { Parser } from 'n3';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain-JS splitter shared with the CLI script; no type declaration.
import { splitBundle } from '../scripts/2026-07-23-split-fhir-bundle.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLI_PATH = resolve(__dirname, '../dist/index.js');
const BUNDLE_PATH = resolve(__dirname, '../test-fixtures/synthea-grant908-bundle.json');

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const EDGE_PREDS = new Set([
  'https://ns.cascadeprotocol.org/clinical/v1#hasEncounter',
  'https://ns.cascadeprotocol.org/clinical/v1#hasLabResult',
  'https://ns.cascadeprotocol.org/clinical/v1#indicationReference',
  'https://ns.cascadeprotocol.org/coverage/v1#relatedClaim',
]);

interface EdgeResolution {
  resolved: number;
  unresolved: number;
  byPredicate: Record<string, { resolved: number; unresolved: number }>;
}
interface ImportReport {
  totalRecordsImported: number;
  edgeResolution: EdgeResolution;
}

/** init a fresh pod and import one input (a bundle file or a split directory). */
function importInto(input: string, podDir: string, reportPath: string): ImportReport {
  execFileSync('node', [CLI_PATH, 'pod', 'init', podDir], { encoding: 'utf-8' });
  execFileSync('node', [CLI_PATH, 'pod', 'import', podDir, input, '--report', reportPath], {
    encoding: 'utf-8',
    timeout: 120000,
  });
  return JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as ImportReport;
}

/** The pod's record-to-record graph: the set of record subjects + edge triples. */
function loadRecordGraph(podDir: string): { subjects: Set<string>; edges: Set<string> } {
  const parser = new Parser({ format: 'Turtle' });
  const quads = [];
  for (const dir of ['clinical', 'wellness']) {
    const dirPath = path.join(podDir, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const file of fs.readdirSync(dirPath)) {
      if (file.endsWith('.ttl')) quads.push(...parser.parse(fs.readFileSync(path.join(dirPath, file), 'utf-8')));
    }
  }
  const subjects = new Set(quads.filter((q) => q.predicate.value === RDF_TYPE).map((q) => q.subject.value));
  const edges = new Set(
    quads
      .filter((q) => EDGE_PREDS.has(q.predicate.value))
      .map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`),
  );
  return { subjects, edges };
}

/** All record TTL concatenated with per-run import timestamps normalized. */
function normalizedPodData(podDir: string): string {
  const chunks: string[] = [];
  for (const dir of ['clinical', 'wellness']) {
    const dirPath = path.join(podDir, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const file of fs.readdirSync(dirPath).sort()) {
      if (!file.endsWith('.ttl')) continue;
      chunks.push(`=== ${dir}/${file} ===`);
      chunks.push(fs.readFileSync(path.join(dirPath, file), 'utf-8'));
    }
  }
  return chunks.join('\n').replace(/"20\d\d-\d\d-\d\dT[0-9:.]+Z"\^\^xsd:dateTime/g, '"TS"^^xsd:dateTime');
}

describe('Synthea bundle == split equivalence (root 3.22)', () => {
  let root: string;
  let splitDir: string;
  let bundlePod: string;
  let splitPod: string;
  let splitFiles: string[];
  let bundleReport: ImportReport;
  let splitReport: ImportReport;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-3-22-'));
    splitDir = path.join(root, 'split');
    bundlePod = path.join(root, 'pod-bundle');
    splitPod = path.join(root, 'pod-split');

    // Split the committed bundle into the Apple Health one-resource-per-file shape.
    const bundle = JSON.parse(fs.readFileSync(BUNDLE_PATH, 'utf-8'));
    splitFiles = splitBundle(bundle, splitDir);

    bundleReport = importInto(BUNDLE_PATH, bundlePod, path.join(root, 'report-bundle.json'));
    splitReport = importInto(splitDir, splitPod, path.join(root, 'report-split.json'));
  }, 120000);

  it('splits the 254-resource bundle into one file per resource', () => {
    expect(splitFiles.length).toBe(254);
    // Every emitted file is a bare single resource named <ResourceType>-<id>.json.
    expect(fs.readdirSync(splitDir).filter((f) => f.endsWith('.json')).length).toBe(254);
  });

  it('imports the same record count from both layouts', () => {
    expect(bundleReport.totalRecordsImported).toBe(236);
    expect(splitReport.totalRecordsImported).toBe(bundleReport.totalRecordsImported);
  });

  it('resolves the same edge totals from both layouts (249 resolved, 0 unresolved)', () => {
    expect(bundleReport.edgeResolution.resolved).toBe(249);
    expect(bundleReport.edgeResolution.unresolved).toBe(0);
    expect(splitReport.edgeResolution.resolved).toBe(bundleReport.edgeResolution.resolved);
    expect(splitReport.edgeResolution.unresolved).toBe(bundleReport.edgeResolution.unresolved);
  });

  it('resolves each of the four edge families identically across layouts', () => {
    const expected = {
      'clinical:hasEncounter': { resolved: 181, unresolved: 0 },
      'clinical:hasLabResult': { resolved: 31, unresolved: 0 },
      'clinical:indicationReference': { resolved: 19, unresolved: 0 },
      'coverage:relatedClaim': { resolved: 18, unresolved: 0 },
    };
    for (const [pred, counts] of Object.entries(expected)) {
      expect(bundleReport.edgeResolution.byPredicate[pred]).toEqual(counts);
      expect(splitReport.edgeResolution.byPredicate[pred]).toEqual(counts);
    }
  });

  it('resolves encounter references at full scale (the property the real export cannot exercise)', () => {
    // The real Apple Health export carries no Encounter resource, so its
    // hasEncounter is a permanent zero. The specimen carries its Encounters, so
    // the split layout must resolve every one of them across files.
    expect(splitReport.edgeResolution.byPredicate['clinical:hasEncounter'].resolved).toBe(181);
  });

  it('produces an identical record-subject set from both layouts', () => {
    const b = loadRecordGraph(bundlePod);
    const s = loadRecordGraph(splitPod);
    expect(s.subjects.size).toBe(b.subjects.size);
    expect([...s.subjects].sort()).toEqual([...b.subjects].sort());
  });

  it('produces an identical resolved-edge-triple set from both layouts', () => {
    const b = loadRecordGraph(bundlePod);
    const s = loadRecordGraph(splitPod);
    // 249 record-to-record edges, each pointing at the same real subject IRI
    // regardless of whether its target arrived in the same bundle or a sibling file.
    expect(b.edges.size).toBe(249);
    expect(s.edges.size).toBe(249);
    expect([...s.edges].sort()).toEqual([...b.edges].sort());
  });

  it('leaves no unresolved-reference placeholder on disk (split layout)', () => {
    let ttl = '';
    for (const dir of ['clinical', 'wellness']) {
      const dirPath = path.join(splitPod, dir);
      if (!fs.existsSync(dirPath)) continue;
      for (const file of fs.readdirSync(dirPath)) {
        if (file.endsWith('.ttl')) ttl += fs.readFileSync(path.join(dirPath, file), 'utf-8');
      }
    }
    expect(ttl).not.toContain('unresolved-ref');
    expect(ttl).not.toContain('parsed-indication');
  });

  it('is byte-deterministic: two independent split imports match (timestamps excepted)', () => {
    const podB = path.join(root, 'pod-split-2');
    importInto(splitDir, podB, path.join(root, 'report-split-2.json'));
    expect(normalizedPodData(podB)).toBe(normalizedPodData(splitPod));
  }, 120000);
});
