/**
 * Phase 2 acceptance (integration): a medication dose conflict must reach the
 * Workbench-facing artifact, settings/pending-conflicts.ttl. The conflict is
 * useless if it is swallowed before persistence, so this drives the real
 * `cascade pod import --reconcile-existing` path end to end and reads the file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolve } from 'path';
import { existsSync } from 'fs';

const CLI_PATH = resolve(__dirname, '../dist/index.js');

function runCli(args: string): string {
  try {
    return execSync(`node ${CLI_PATH} ${args}`, { encoding: 'utf-8', timeout: 30000 }).trim();
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string };
    return (e.stdout ?? '').trim() + (e.stderr ?? '').trim();
  }
}

/** A minimal, valid clinical:Medication turtle record. */
function medTtl(uri: string, drugName: string, dosage: string): string {
  return `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .

<${uri}> a clinical:Medication ;
    clinical:drugName "${drugName}" ;
    clinical:rxNormCode <https://ns.cascadeprotocol.org/rxnorm/29046> ;
    clinical:dosage "${dosage}" ;
    clinical:status "active" ;
    cascade:dataProvenance cascade:Imported ;
    cascade:schemaVersion "1.9" .
`;
}

describe('pod import: medication dose conflict reaches pending-conflicts.ttl', () => {
  let tempDir: string;
  let podDir: string;

  beforeEach(async () => {
    tempDir = path.join('/tmp', `cascade-medconflict-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
    podDir = path.join(tempDir, 'test-pod');
    runCli(`pod init ${podDir}`);
  });

  afterEach(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes an unresolved medication conflict when a re-import disagrees on dose', async () => {
    const med1 = path.join(tempDir, 'med-10mg.ttl');
    const med2 = path.join(tempDir, 'med-20mg.ttl');
    await fs.writeFile(med1, medTtl('urn:cascade:med:lisinopril', 'Lisinopril 10 mg', '10 mg'), 'utf-8');
    await fs.writeFile(med2, medTtl('urn:cascade:med:lisinopril-b', 'Lisinopril 20 mg', '20 mg'), 'utf-8');

    // First import establishes the record; second re-import (different source)
    // disagrees on dose and must reconcile against the existing pod record.
    runCli(`pod import ${podDir} ${med1} --source-system pharmacy-a`);
    runCli(`pod import ${podDir} ${med2} --source-system clinic-b --reconcile-existing`);

    const pendingPath = path.join(podDir, 'settings', 'pending-conflicts.ttl');
    expect(existsSync(pendingPath)).toBe(true);

    const pending = await fs.readFile(pendingPath, 'utf-8');
    // The conflict is recorded for a medication record (not swallowed as a dup).
    expect(pending).toContain('PendingConflict');
    expect(pending).toContain('clinical:Medication');

    // And the CI-friendly conflicts command flags it (non-empty exit).
    const conflicts = runCli(`pod conflicts ${podDir}`);
    expect(conflicts.toLowerCase()).toContain('conflict');
  });
});
