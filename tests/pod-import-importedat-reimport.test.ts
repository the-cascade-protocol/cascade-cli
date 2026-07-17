/**
 * Re-import acceptance (integration, root backlog 1.5 symptom 3): re-importing a
 * portal export is the normal monthly update path. The converter stamps a fresh
 * `clinical:importedAt` each run while the document/panel subjects are
 * content-hash-stable, so before this fix a second import gave every document and
 * lab-report two importedAt values and `cascade validate` failed "must have
 * exactly one importedAt timestamp". This drives `cascade pod import` twice over
 * a synthetic C-CDA fixture and asserts one importedAt per subject on disk plus a
 * clean validate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolve } from 'path';
import { Parser } from 'n3';
import type { Quad } from 'n3';

const CLI_PATH = resolve(__dirname, '../dist/index.js');
const FIXTURE = resolve(__dirname, '../test-fixtures/ccda-lab-panel.xml');
const IMPORTED_AT = 'https://ns.cascadeprotocol.org/clinical/v1#importedAt';

function runCli(args: string): string {
  try {
    return execSync(`node ${CLI_PATH} ${args}`, { encoding: 'utf-8', timeout: 30000 }).trim();
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string };
    return (e.stdout ?? '').trim() + (e.stderr ?? '').trim();
  }
}

async function clinicalQuads(podDir: string): Promise<Quad[]> {
  const quads: Quad[] = [];
  const dirPath = path.join(podDir, 'clinical');
  let files: string[];
  try { files = await fs.readdir(dirPath); } catch { return quads; }
  for (const file of files) {
    if (!file.endsWith('.ttl')) continue;
    const ttl = await fs.readFile(path.join(dirPath, file), 'utf-8');
    quads.push(...new Parser({ format: 'Turtle' }).parse(ttl));
  }
  return quads;
}

describe('pod import: re-import keeps exactly one importedAt (root 1.5 symptom 3)', () => {
  let tempDir: string;
  let podDir: string;

  beforeEach(async () => {
    tempDir = path.join('/tmp', `cascade-reimport-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
    podDir = path.join(tempDir, 'test-pod');
    runCli(`pod init ${podDir}`);
  });

  afterEach(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('does not accumulate a second importedAt on the monthly re-import path', async () => {
    // Two imports of the SAME export; the second reconciles against the first.
    runCli(`pod import ${podDir} ${FIXTURE} --source-system epic`);
    runCli(`pod import ${podDir} ${FIXTURE} --source-system epic --reconcile-existing`);

    const quads = await clinicalQuads(podDir);

    // Every subject carrying importedAt carries exactly one (SHACL maxCount 1).
    const bySubject = new Map<string, Set<string>>();
    for (const q of quads) {
      if (q.predicate.value !== IMPORTED_AT) continue;
      if (!bySubject.has(q.subject.value)) bySubject.set(q.subject.value, new Set());
      bySubject.get(q.subject.value)!.add(q.object.value);
    }
    expect(bySubject.size).toBeGreaterThan(0); // fixture yields document + lab-report
    for (const [subject, values] of bySubject) {
      expect(values.size, `${subject} should have exactly one importedAt`).toBe(1);
    }

    // And the pod validates clean: the specific SHACL failure this fix targets
    // ("must have exactly one importedAt timestamp") is gone, 0 files fail.
    const out = runCli(`validate ${podDir}`);
    expect(out).not.toMatch(/exactly one importedAt/i);
    expect(out).toMatch(/0 failed/);
  });
});
