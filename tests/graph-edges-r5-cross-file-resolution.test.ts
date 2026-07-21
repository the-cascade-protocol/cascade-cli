/**
 * Regression tests for cross-file reference resolution (root backlog 2.11, slice R5).
 *
 * `resolveReferenceEdges` used to run per CONVERSION BATCH. An Apple Health
 * export is one FHIR resource per file, so a reference's target was almost never
 * in the same batch and EVERY cross-file edge dropped (measured 1601/1601 on the
 * real export). R5 moves reference resolution to once per IMPORT INVOCATION: the
 * FHIR converter defers, and `pod import` resolves over the merged, reconciled
 * quad set, so an edge whose target is in a sibling file (or already in the pod)
 * now resolves.
 *
 * This locks in that behavior against a SYNTHETIC multi-file fixture that
 * reproduces the Apple Health layout (one resource per file, cross-file
 * references). All data is synthetic and PHI-free
 * (test-fixtures/apple-health-multifile/). The real export is the local
 * acceptance corpus only; it never enters the repo.
 *
 * The fixture's cross-file edges:
 *   - clinical:hasLabResult      DiagnosticReport dr-1 -> Observation obs-1, obs-2   (2, both resolve)
 *   - clinical:hasEncounter      obs-1, obs-2, dr-1, proc-1 -> Encounter enc-1       (4, resolve)
 *                                obs-3 -> Encounter enc-MISSING (absent)             (1, drops-and-counts)
 *   - clinical:indicationReference  Procedure proc-1 -> Condition cond-1             (1, resolves)
 *   - coverage:relatedClaim      ExplanationOfBenefit eob-1 -> Claim clm-1           (1, resolves)
 *
 * Every one of these targets a resource in a SEPARATE file, so per-batch
 * resolution would drop all of them.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLI_PATH = resolve(__dirname, '../dist/index.js');
const FIXTURE_DIR = resolve(__dirname, '../test-fixtures/apple-health-multifile');

interface EdgeResolution {
  resolved: number;
  unresolved: number;
  byPredicate: Record<string, { resolved: number; unresolved: number }>;
}
interface ImportReport {
  totalRecordsImported: number;
  edgeResolution: EdgeResolution;
}

function runImport(podDir: string, reportPath: string): void {
  execFileSync('node', [CLI_PATH, 'pod', 'init', podDir], { encoding: 'utf-8' });
  execFileSync('node', [CLI_PATH, 'pod', 'import', podDir, FIXTURE_DIR, '--report', reportPath], {
    encoding: 'utf-8',
    timeout: 60000,
  });
}

/** All record TTL from a pod, concatenated, with per-run timestamps normalized. */
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
  return chunks
    .join('\n')
    // The only non-deterministic content is the import-time stamps.
    .replace(/"20\d\d-\d\d-\d\dT[0-9:.]+Z"\^\^xsd:dateTime/g, '"TS"^^xsd:dateTime');
}

function rawPodTtl(podDir: string): string {
  const chunks: string[] = [];
  for (const dir of ['clinical', 'wellness']) {
    const dirPath = path.join(podDir, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const file of fs.readdirSync(dirPath)) {
      if (file.endsWith('.ttl')) chunks.push(fs.readFileSync(path.join(dirPath, file), 'utf-8'));
    }
  }
  return chunks.join('\n');
}

describe('R5 cross-file reference resolution (root 2.11)', () => {
  let podDir: string;
  let report: ImportReport;

  beforeAll(() => {
    podDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-r5-'));
    const reportPath = path.join(podDir, 'report.json');
    runImport(podDir, reportPath);
    report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as ImportReport;
  });

  it('imports all nine single-resource files', () => {
    expect(report.totalRecordsImported).toBe(9);
  });

  it('resolves every cross-file edge whose target is present (8 of 8)', () => {
    // 2 hasLabResult + 4 hasEncounter + 1 indicationReference + 1 relatedClaim.
    expect(report.edgeResolution.resolved).toBe(8);
  });

  it('drops-and-counts the one reference whose target is absent, never dangling', () => {
    // obs-3 -> Encounter/enc-MISSING is the only unresolvable reference.
    expect(report.edgeResolution.unresolved).toBe(1);
  });

  it('resolves each edge family across files', () => {
    const bp = report.edgeResolution.byPredicate;
    expect(bp['clinical:hasLabResult']).toEqual({ resolved: 2, unresolved: 0 });
    expect(bp['clinical:hasEncounter']).toEqual({ resolved: 4, unresolved: 1 });
    expect(bp['clinical:indicationReference']).toEqual({ resolved: 1, unresolved: 0 });
    expect(bp['coverage:relatedClaim']).toEqual({ resolved: 1, unresolved: 0 });
  });

  it('leaves no unresolved-reference or parsed-indication placeholder on disk', () => {
    const ttl = rawPodTtl(podDir);
    expect(ttl).not.toContain('unresolved-ref');
    expect(ttl).not.toContain('parsed-indication');
  });

  it('writes each resolved edge as a real record subject IRI (urn:uuid:), not a placeholder', () => {
    const ttl = rawPodTtl(podDir);
    // The lab-report's hasLabResult objects must be minted urn:uuid: subjects.
    const labEdges = ttl.match(/clinical:hasLabResult\s+<urn:uuid:[0-9a-f-]+>/g) ?? [];
    // n3 may collapse a multi-object list onto one predicate; require at least
    // one materialized, resolved (urn:uuid:) object.
    expect(labEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('is byte-deterministic across two independent imports (timestamps excepted)', () => {
    const podA = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-r5-a-'));
    const podB = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-r5-b-'));
    runImport(podA, path.join(podA, 'r.json'));
    runImport(podB, path.join(podB, 'r.json'));
    expect(normalizedPodData(podA)).toBe(normalizedPodData(podB));
  });
});
