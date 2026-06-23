/**
 * Integration tests for the append-only record-amendment commands:
 *   pod amend / annotate / add-record / retract / erase
 *
 * Originals are immutable; every edit/delete is a new overlay resource in
 * <pod>/annotations/, discovered by `pod query --all`. All writes route through
 * the encryption chokepoint. Overlays must pass `cascade validate`; malformed
 * ones must fail. The same flows are exercised on an ENCRYPTED pod.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { registerValidateCommand } from '../src/commands/validate.js';
import { validateOverlayGraph } from '../src/lib/annotations.js';

// Argon2id at 64 MiB makes encrypted runs heavy; allow a generous timeout.
const TEST_TIMEOUT_MS = 60_000;
const PASSPHRASE = 'records-edit-test-passphrase';

function buildProgram(): Command {
  const program = new Command();
  program
    .name('cascade')
    .exitOverride()
    .option('--verbose', 'Verbose output', false)
    .option('--json', 'Output JSON', false);
  registerPodCommand(program);
  registerValidateCommand(program);
  return program;
}

async function runCli(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const program = buildProgram();
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    chunks.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    chunks.push(a.map(String).join(' '));
  });
  const writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
  process.exitCode = 0;
  try {
    await program.parseAsync(['node', 'cascade', ...args]);
  } catch {
    /* exitOverride throws on errors; exitCode reflects the failure */
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return { stdout: chunks.join('\n'), exitCode };
}

/** Pull the last complete JSON object out of captured stdout. */
function lastJson(stdout: string): any {
  const start = stdout.indexOf('{');
  // Find the JSON block: results are pretty-printed objects.
  const candidates: string[] = [];
  let depth = 0;
  let buf = '';
  for (let i = start; i < stdout.length; i++) {
    const ch = stdout[i];
    if (ch === '{') {
      if (depth === 0) buf = '';
      depth++;
    }
    if (depth > 0) buf += ch;
    if (ch === '}') {
      depth--;
      if (depth === 0) candidates.push(buf);
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(candidates[i]);
    } catch {
      /* keep looking */
    }
  }
  throw new Error(`No JSON object found in stdout:\n${stdout}`);
}

let tmpDirs: string[] = [];
function mkTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-rec-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  delete process.env.CASCADE_POD_PASSPHRASE;
  delete process.env.CASCADE_RECORD_JSON;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

/** Init a plaintext pod and add one well-formed Medication; return its URI. */
async function initPodWithMedication(dir: string): Promise<string> {
  await runCli(['pod', 'init', dir]);
  const add = await runCli([
    'pod', 'add-record', dir,
    '--type', 'clinical:Medication',
    '--json', '{"clinical:drugName":"Lisinopril","cascade:schemaVersion":"1.3","clinical:dosage":"10mg"}',
  ]);
  expect(add.exitCode).toBe(0);
  return lastJson(add.stdout).recordUri as string;
}

describe('SHACL overlay gate (unit)', () => {
  it('accepts a well-formed Amendment overlay', () => {
    const ttl = `@prefix workbench: <https://ns.cascadeprotocol.org/workbench/v1#> .
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<urn:uuid:a> a workbench:Amendment ;
  workbench:amendsRecord <urn:uuid:r> ;
  workbench:amendsProperty "clinical:dosage" ;
  workbench:amendedValue "20mg" ;
  cascade:dataProvenance cascade:SelfReported ;
  dct:created "2026-06-22T00:00:00Z"^^xsd:dateTime .`;
    expect(() => validateOverlayGraph(ttl, 'a.ttl')).not.toThrow();
  });

  it('rejects an Amendment missing the required amendedValue', () => {
    const ttl = `@prefix workbench: <https://ns.cascadeprotocol.org/workbench/v1#> .
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
<urn:uuid:b> a workbench:Amendment ;
  workbench:amendsRecord <urn:uuid:r> ;
  workbench:amendsProperty "clinical:dosage" ;
  cascade:dataProvenance cascade:SelfReported .`;
    expect(() => validateOverlayGraph(ttl, 'b.ttl')).toThrow(/SHACL/);
  });

  it('rejects an Annotation with neither text nor value', () => {
    const ttl = `@prefix workbench: <https://ns.cascadeprotocol.org/workbench/v1#> .
@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
<urn:uuid:c> a workbench:Annotation ;
  workbench:annotatesRecord <urn:uuid:r> ;
  cascade:dataProvenance cascade:SelfReported .`;
    expect(() => validateOverlayGraph(ttl, 'c.ttl')).toThrow(/SHACL/);
  });
});

describe('plaintext pod: append-only record amendments', () => {
  it('add-record lands a SelfReported record in the right bucket; query returns it', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    const recordUri = await initPodWithMedication(dir);

    // Lands in clinical/medications.ttl, tagged SelfReported.
    const medsPath = path.join(dir, 'clinical', 'medications.ttl');
    expect(fs.existsSync(medsPath)).toBe(true);
    const medsText = fs.readFileSync(medsPath, 'utf-8');
    expect(medsText).toContain('cascade:SelfReported');
    expect(medsText).toContain('Lisinopril');

    const q = await runCli(['--json', 'pod', 'query', dir, '--medications']);
    expect(q.exitCode).toBe(0);
    const parsed = lastJson(q.stdout);
    expect(parsed.dataTypes.medications.count).toBe(1);
    expect(parsed.dataTypes.medications.records[0].id).toBe(recordUri);
  }, TEST_TIMEOUT_MS);

  it('amend writes a valid Amendment that query --all surfaces with the right fields', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    const recordUri = await initPodWithMedication(dir);

    const a = await runCli([
      '--json', 'pod', 'amend', dir,
      '--record', recordUri,
      '--property', 'clinical:dosage',
      '--value', '20mg',
      '--reason', 'titrated up',
    ]);
    expect(a.exitCode).toBe(0);
    const ares = lastJson(a.stdout);
    expect(ares.amended).toBe(true);
    expect(ares.recordUri).toBe(recordUri);
    expect(ares.property).toBe('clinical:dosage');
    expect(ares.value).toBe('20mg');
    expect(ares.amendmentUri).toMatch(/^urn:uuid:/);

    // Overlay file exists and passes validation.
    const overlayPath = path.join(dir, 'annotations', 'amendments.ttl');
    expect(fs.existsSync(overlayPath)).toBe(true);
    const v = await runCli(['validate', overlayPath]);
    expect(v.exitCode).toBe(0);

    // query --all surfaces the Amendment with the right triples.
    const q = await runCli(['--json', 'pod', 'query', dir, '--all']);
    const dt = lastJson(q.stdout).dataTypes;
    const amendments = (Object.values(dt) as any[]).flatMap((b) => b.records)
      .filter((r: any) => r.type === 'workbench:Amendment');
    expect(amendments.length).toBe(1);
    const props = amendments[0].properties;
    expect(props['workbench:amendsRecord']).toBe(recordUri);
    expect(props['workbench:amendsProperty']).toBe('clinical:dosage');
    expect(props['workbench:amendedValue']).toBe('20mg');
  }, TEST_TIMEOUT_MS);

  it('annotate writes a valid Annotation overlay', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    const recordUri = await initPodWithMedication(dir);

    const r = await runCli([
      '--json', 'pod', 'annotate', dir,
      '--record', recordUri,
      '--text', 'patient reports nausea',
    ]);
    expect(r.exitCode).toBe(0);
    const res = lastJson(r.stdout);
    expect(res.annotated).toBe(true);
    expect(res.recordUri).toBe(recordUri);
    expect(res.annotationUri).toMatch(/^urn:uuid:/);

    const v = await runCli(['validate', path.join(dir, 'annotations', 'annotations.ttl')]);
    expect(v.exitCode).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('annotate with neither --text nor --value errors', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    const recordUri = await initPodWithMedication(dir);
    const r = await runCli(['--json', 'pod', 'annotate', dir, '--record', recordUri]);
    expect(r.exitCode).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('retract writes a Retraction; --superseded-by records the link', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    const recordUri = await initPodWithMedication(dir);

    const r = await runCli([
      '--json', 'pod', 'retract', dir,
      '--record', recordUri,
      '--reason', 'duplicate',
      '--superseded-by', 'urn:uuid:kept-123',
    ]);
    expect(r.exitCode).toBe(0);
    const res = lastJson(r.stdout);
    expect(res.retracted).toBe(true);
    expect(res.recordUri).toBe(recordUri);
    expect(res.supersededBy).toBe('urn:uuid:kept-123');

    const overlayPath = path.join(dir, 'annotations', 'retractions.ttl');
    expect(fs.readFileSync(overlayPath, 'utf-8')).toContain('workbench:supersededBy');
    const v = await runCli(['validate', overlayPath]);
    expect(v.exitCode).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('erase --confirm removes the subject from its bucket and writes a Tombstone with a contentHash', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    const recordUri = await initPodWithMedication(dir);

    const e = await runCli([
      '--json', 'pod', 'erase', dir,
      '--record', recordUri,
      '--confirm',
      '--reason', 'merged duplicate',
    ]);
    expect(e.exitCode).toBe(0);
    const res = lastJson(e.stdout);
    expect(res.erased).toBe(true);
    expect(res.recordUri).toBe(recordUri);
    expect(res.tombstoneUri).toMatch(/^urn:uuid:/);
    expect(res.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // The subject is gone from the bucket: query no longer returns it.
    const q = await runCli(['--json', 'pod', 'query', dir, '--medications']);
    const meds = lastJson(q.stdout).dataTypes.medications;
    expect((meds?.records ?? []).some((r: any) => r.id === recordUri)).toBe(false);

    // A Tombstone overlay exists, carries the hash, and validates.
    const tombPath = path.join(dir, 'annotations', 'tombstones.ttl');
    const tomb = fs.readFileSync(tombPath, 'utf-8');
    expect(tomb).toContain('workbench:Tombstone');
    expect(tomb).toContain(res.contentHash);
    const v = await runCli(['validate', tombPath]);
    expect(v.exitCode).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('erase without --confirm errors and does not mutate the bucket', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    const recordUri = await initPodWithMedication(dir);
    const before = fs.readFileSync(path.join(dir, 'clinical', 'medications.ttl'), 'utf-8');

    const e = await runCli(['--json', 'pod', 'erase', dir, '--record', recordUri]);
    expect(e.exitCode).toBe(1);

    const after = fs.readFileSync(path.join(dir, 'clinical', 'medications.ttl'), 'utf-8');
    expect(after).toBe(before);
    expect(fs.existsSync(path.join(dir, 'annotations', 'tombstones.ttl'))).toBe(false);
  }, TEST_TIMEOUT_MS);
});

describe('encrypted pod: overlays are ciphertext on disk and still work', () => {
  beforeEach(() => {
    process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;
  });

  it('amend/annotate/retract/erase on an encrypted pod write ciphertext overlays', async () => {
    const dir = path.join(mkTmpDir(), 'pod');
    await runCli(['pod', 'init', dir, '--encrypt']);

    const add = await runCli([
      'pod', 'add-record', dir,
      '--type', 'clinical:Medication',
      '--json', '{"clinical:drugName":"Metformin","cascade:schemaVersion":"1.3"}',
    ]);
    expect(add.exitCode).toBe(0);
    const recordUri = lastJson(add.stdout).recordUri as string;

    // amend
    const a = await runCli([
      '--json', 'pod', 'amend', dir,
      '--record', recordUri, '--property', 'clinical:dosage', '--value', '500mg',
    ]);
    expect(a.exitCode).toBe(0);

    // annotate
    const an = await runCli([
      '--json', 'pod', 'annotate', dir, '--record', recordUri, '--text', 'with meals',
    ]);
    expect(an.exitCode).toBe(0);

    // The amendments overlay is CIPHERTEXT on disk (no readable @prefix / URNs).
    const amendBytes = fs.readFileSync(path.join(dir, 'annotations', 'amendments.ttl')).toString('utf-8');
    expect(amendBytes).not.toContain('@prefix');
    expect(amendBytes).not.toContain('workbench:Amendment');
    const annBytes = fs.readFileSync(path.join(dir, 'annotations', 'annotations.ttl')).toString('utf-8');
    expect(annBytes).not.toContain('@prefix');

    // query --all decrypts and surfaces the overlays.
    const q = await runCli(['--json', 'pod', 'query', dir, '--all']);
    expect(q.exitCode).toBe(0);
    const dt = lastJson(q.stdout).dataTypes;
    const types = new Set(
      (Object.values(dt) as any[]).flatMap((b) => b.records).map((r: any) => r.type),
    );
    expect(types.has('workbench:Amendment')).toBe(true);
    expect(types.has('workbench:Annotation')).toBe(true);

    // erase on encrypted pod removes the record and writes a ciphertext Tombstone.
    const e = await runCli(['--json', 'pod', 'erase', dir, '--record', recordUri, '--confirm']);
    expect(e.exitCode).toBe(0);
    const tombBytes = fs.readFileSync(path.join(dir, 'annotations', 'tombstones.ttl')).toString('utf-8');
    expect(tombBytes).not.toContain('@prefix');

    const q2 = await runCli(['--json', 'pod', 'query', dir, '--medications']);
    const meds = lastJson(q2.stdout).dataTypes.medications;
    expect((meds?.records ?? []).some((r: any) => r.id === recordUri)).toBe(false);

    // validate decrypts and the overlays pass.
    const v = await runCli(['validate', dir]);
    expect(v.exitCode).not.toBe(2); // not a read/decrypt error
  }, TEST_TIMEOUT_MS);
});
