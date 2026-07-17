/**
 * R4 acceptance (integration, root backlog 3.13a): a record-to-record edge must
 * survive reconciliation. Drives the real `cascade pod import --reconcile-existing`
 * path end to end: bundle A carries a lab panel report whose clinical:hasLabResult
 * points at a lab result; bundle B (imported second) carries a near-duplicate of
 * that lab result from a higher-trust source, so the reconciler merges them and
 * discards bundle A's lab. Before R4 the report's edge re-dangled at the ghost
 * subject; now it must resolve to the surviving lab on disk. Data is synthetic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolve } from 'path';
import { Parser } from 'n3';
import type { Quad } from 'n3';

const CLI_PATH = resolve(__dirname, '../dist/index.js');

function runCli(args: string): string {
  try {
    return execSync(`node ${CLI_PATH} ${args}`, { encoding: 'utf-8', timeout: 30000 }).trim();
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string };
    return (e.stdout ?? '').trim() + (e.stderr ?? '').trim();
  }
}

const PREFIXES = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
`;

const REPORT = 'urn:uuid:panel-report-int-0001';
const LAB_A = 'urn:uuid:lab-a-int-0001';
const LAB_B = 'urn:uuid:lab-b-int-0001';

const HAS_LAB_RESULT = 'https://ns.cascadeprotocol.org/clinical/v1#hasLabResult';

// Bundle A: a panel report referencing a lab result, plus that lab result. No
// cascade:sourceSystem, so on re-import the record loads as existing-pod content
// and the second import exercises the cross-batch reconciliation path.
const BUNDLE_A = `${PREFIXES}
<${REPORT}> a clinical:LaboratoryReport ;
    clinical:panelName "Basic Metabolic Panel" ;
    clinical:hasLabResult <${LAB_A}> .

<${LAB_A}> a health:LabResultRecord ;
    health:testCode <http://loinc.org/rdf#2345-7> ;
    health:testName "Glucose" ;
    health:performedDate "2026-01-15" ;
    health:resultValue "100" .
`;

// Bundle B: a near-duplicate of the lab result (same LOINC + date, value within
// tolerance) from a different source, imported at higher trust so it wins.
const BUNDLE_B = `${PREFIXES}
<${LAB_B}> a health:LabResultRecord ;
    health:testCode <http://loinc.org/rdf#2345-7> ;
    health:testName "Glucose" ;
    health:performedDate "2026-01-15" ;
    health:resultValue "101" .
`;

/** Parse every .ttl under the pod's data dirs into one quad list. */
async function censusPod(podDir: string): Promise<Quad[]> {
  const quads: Quad[] = [];
  for (const dir of ['clinical', 'wellness']) {
    const dirPath = path.join(podDir, dir);
    let files: string[];
    try { files = await fs.readdir(dirPath); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.ttl')) continue;
      const ttl = await fs.readFile(path.join(dirPath, file), 'utf-8');
      quads.push(...new Parser({ format: 'Turtle' }).parse(ttl));
    }
  }
  return quads;
}

describe('pod import: a hasLabResult edge survives a reconciled re-import (R4)', () => {
  let tempDir: string;
  let podDir: string;

  beforeEach(async () => {
    tempDir = path.join('/tmp', `cascade-edgerewrite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
    podDir = path.join(tempDir, 'test-pod');
    runCli(`pod init ${podDir}`);
  });

  afterEach(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('redirects the report edge from the merged-away lab to the survivor on disk', async () => {
    const fileA = path.join(tempDir, 'bundle-a.ttl');
    const fileB = path.join(tempDir, 'bundle-b.ttl');
    const reportJson = path.join(tempDir, 'import-report.json');
    await fs.writeFile(fileA, BUNDLE_A, 'utf-8');
    await fs.writeFile(fileB, BUNDLE_B, 'utf-8');

    runCli(`pod import ${podDir} ${fileA} --source-system quest`);
    runCli(`pod import ${podDir} ${fileB} --source-system labcorp --reconcile-existing --trust labcorp=0.95 --report ${reportJson}`);

    const quads = await censusPod(podDir);
    const subjects = new Set(quads.filter(q => q.subject.termType === 'NamedNode').map(q => q.subject.value));

    // The near-duplicate lab merged: labcorp's lab survives, quest's is gone.
    expect(subjects.has(LAB_B)).toBe(true);
    expect(subjects.has(LAB_A)).toBe(false);

    // The report's edge was redirected to the surviving lab and resolves.
    const edgeObjects = quads
      .filter(q => q.subject.value === REPORT && q.predicate.value === HAS_LAB_RESULT)
      .map(q => q.object.value);
    expect(edgeObjects).toEqual([LAB_B]);
    expect(subjects.has(edgeObjects[0])).toBe(true);

    // Pod-wide edge integrity: every hasLabResult object resolves to a subject.
    const allLabEdges = quads.filter(q => q.predicate.value === HAS_LAB_RESULT);
    expect(allLabEdges.length).toBeGreaterThan(0);
    for (const e of allLabEdges) {
      expect(subjects.has(e.object.value), `edge object ${e.object.value} should resolve`).toBe(true);
    }

    // The import report records at least one repaired edge.
    const report = JSON.parse(await fs.readFile(reportJson, 'utf-8'));
    expect(report.reconciliation?.summary?.edgeObjectsRewritten).toBeGreaterThanOrEqual(1);
  });
});
