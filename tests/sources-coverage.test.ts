/**
 * `cascade sources coverage`: the field-coverage report a person can run on
 * their own pod, and the same disclosure written into an import manifest.
 *
 * Three things are worth pinning here, and only one of them is the arithmetic.
 *
 * 1. THE REPORT CARRIES NO VALUES. It exists to be shared — a design partner
 *    sends back the SHAPE of what their EHR populates so a synthetic fixture can
 *    be authored for it — and that only works if paths and counts are all it
 *    ever prints. The test asserts that no value from the source appears in the
 *    output, so a future "helpful" example value fails here rather than in
 *    somebody's inbox.
 *
 * 2. AN UNREADABLE POD IS NOT AN EMPTY ONE. `sources/` is inside a sealed pod's
 *    encrypted set. A verb that read ciphertext, parsed nothing and reported
 *    "no fields lost" would be making a confident claim about a health record it
 *    could not open. Exit 2, per docs/exit-codes.md.
 *
 * 3. THE MANIFEST DISTINGUISHES "not measured" FROM "nothing lost". The
 *    fieldCoverage block is absent when there was nothing to measure, never zero.
 *
 * The verb runs as a real subprocess: the exit code is part of what is under
 * test, and it is set on `process.exitCode` inside an action handler.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPassphraseManifest,
  writeEncryptionManifest,
  writeResource,
} from '../src/lib/pod-encryption.js';
import {
  buildFieldCoverageDisclosure,
  buildImportManifest,
} from '../src/lib/fhir-converter/import-manifest.js';
import type { BatchConversionResult } from '../src/lib/fhir-converter/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'dist', 'index.js');
const FIXTURE_DIR = path.resolve(HERE, '..', 'test-fixtures', 'field-coverage');

const PASSPHRASE = 'sources-coverage-passphrase';

function fixtures(): Record<string, unknown>[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf-8')));
}

function bundleOf(resources: unknown[]): string {
  return JSON.stringify({
    resourceType: 'Bundle',
    type: 'searchset',
    entry: resources.map((resource) => ({ resource })),
  });
}

let tmpRoot: string;
let plainPod: string;
let sealedPod: string;
let podWithoutSources: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-sources-coverage-'));
  plainPod = path.join(tmpRoot, 'plain-pod');
  sealedPod = path.join(tmpRoot, 'sealed-pod');
  podWithoutSources = path.join(tmpRoot, 'no-sources-pod');

  const all = fixtures();
  // The same encounter twice across two overlapping pulls, plus a second one, so
  // the de-duplication and the per-path counts are both exercised.
  const encounter = all.find((r) => r.resourceType === 'Encounter')!;
  const secondEncounter = structuredClone(encounter);
  secondEncounter.id = 'fc-encounter-derm-2';

  fs.mkdirSync(path.join(plainPod, 'sources'), { recursive: true });
  fs.writeFileSync(path.join(plainPod, 'sources', 'bundle-1.json'), bundleOf(all));
  fs.writeFileSync(
    path.join(plainPod, 'sources', 'bundle-2.json'),
    bundleOf([encounter, secondEncounter]),
  );
  // A JSON file in sources/ that is not FHIR: named in a warning, never fatal.
  fs.writeFileSync(path.join(plainPod, 'sources', 'pull-metadata.json'), '{"pulledAt":"2025-04-02"}');

  fs.mkdirSync(podWithoutSources, { recursive: true });

  fs.mkdirSync(path.join(sealedPod, 'sources'), { recursive: true });
  const dek = Buffer.alloc(32, 7);
  // Cheap KDF parameters: this suite derives a KEK per invocation and the
  // default cost is deliberately heavy. The pod records its own parameters, so
  // every code path under test is unchanged.
  writeEncryptionManifest(sealedPod, buildPassphraseManifest(dek, PASSPHRASE, { t: 1, m: 8192, p: 1 }));
  writeResource(path.join(sealedPod, 'sources', 'bundle-1.json'), bundleOf(all), dek);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CASCADE_POD_PASSPHRASE: '', ...env },
  });
}

describe('cascade sources coverage', () => {
  it('reports paths and counts over the retained sources', () => {
    const result = run(['sources', 'coverage', plainPod]);
    expect(result.status).toBe(0);
    // Deduplicated: the encounter appearing in both bundles is one resource.
    expect(result.stdout).toContain('11 unique of 12 read');
    expect(result.stdout).toMatch(/Encounter \(2 resources\)/);
    expect(result.stdout).toMatch(/2 {2}Encounter\.identifier\s+pending 3\.254/);
    expect(result.stdout).toMatch(/Encounter\.reasonCode\s+pending 3\.254/);
    expect(result.stdout).toMatch(/Observation\.specimen\s+pending 3\.256/);
    // The disclosure says where the data still is, not only that it is missing.
    expect(result.stdout).toContain('retained under sources/');
    // A non-FHIR JSON file is named, and does not fail the command.
    expect(result.stderr).toContain('pull-metadata.json');
  });

  it('prints no value from the sources', () => {
    const result = run(['sources', 'coverage', plainPod]);
    expect(result.status).toBe(0);
    // A sample drawn from every fixture: names, identifiers, free text, codes.
    const values = [
      'NORTHGATE DERMATOLOGY',
      'Derm Problem',
      '20100000001',
      'Rowan',
      'Sample',
      '555-0100',
      'MEM-88213400',
      'LOT-2024-4471',
      'Cashew',
      'hemolyzed',
      'CETIRIZINE',
      'Amara Okoye',
      'MRN-9100042',
    ];
    const leaked = values.filter((v) => result.stdout.includes(v));
    expect(
      leaked,
      'The coverage report is meant to be shareable. Element paths and counts only — never a value.',
    ).toEqual([]);
  });

  it('exits 2 rather than reporting an unreadable pod as a clean one', () => {
    const result = run(['sources', 'coverage', sealedPod]);
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('not imported');
  });

  it('reads a sealed pod when given its passphrase', () => {
    const result = run(['sources', 'coverage', sealedPod], { CASCADE_POD_PASSPHRASE: PASSPHRASE });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Encounter \(1 resources\)/);
  }, 60_000);

  it('exits 1 when the directory is not a pod, or retains no sources', () => {
    expect(run(['sources', 'coverage', path.join(tmpRoot, 'nope')]).status).toBe(1);
    const noSources = run(['sources', 'coverage', podWithoutSources]);
    expect(noSources.status).toBe(1);
    expect(noSources.stderr).toContain('sources/');
  });

  it('answers as JSON with the same numbers', () => {
    const result = run(['--json', 'sources', 'coverage', plainPod]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      resourcesUnique: number;
      totals: { droppedFields: number; unaccounted: number };
      byType: Record<string, { droppedPaths: Array<{ path: string; count: number }> }>;
    };
    expect(parsed.resourcesUnique).toBe(11);
    expect(parsed.totals.droppedFields).toBeGreaterThan(0);
    // Every drop in this corpus is accounted for by a manifest; if that ever
    // stops being true the conformance test fails too, and this is the same
    // fact stated where a user would see it.
    expect(parsed.totals.unaccounted).toBe(0);
    expect(
      parsed.byType.Encounter.droppedPaths.find((p) => p.path === 'Encounter.location[1]')?.count,
    ).toBe(2);
  });
});

describe('the import manifest discloses the same thing', () => {
  const emptyResult: BatchConversionResult = {
    success: true,
    output: '',
    format: 'turtle',
    resourceCount: 1,
    skippedCount: 0,
    warnings: [],
    errors: [],
    results: [{ turtle: '', warnings: [], resourceType: 'Encounter', cascadeType: 'clinical:Encounter' }],
  };

  it('carries the field-level counts and a sentence saying where the data is', () => {
    const disclosure = buildFieldCoverageDisclosure(fixtures());
    const manifest = buildImportManifest(emptyResult, 'bundle.json', 'test', {}, disclosure);
    expect(manifest.fieldCoverage).toBeDefined();
    expect(manifest.fieldCoverage!.notImportedFields).toBeGreaterThan(0);
    expect(manifest.fieldCoverage!.populatedFields).toBe(
      manifest.fieldCoverage!.importedFields + manifest.fieldCoverage!.notImportedFields,
    );
    expect(manifest.fieldCoverage!.acknowledged + manifest.fieldCoverage!.pending +
      manifest.fieldCoverage!.unaccounted).toBe(manifest.fieldCoverage!.notImportedFields);
    expect(manifest.fieldCoverage!.summary).toContain('retained under sources/');
    expect(manifest.fieldCoverage!.byType.Encounter.droppedPaths.length).toBeGreaterThan(0);
  });

  it('omits the block entirely when nothing was measured', () => {
    const manifest = buildImportManifest(emptyResult, 'bundle.json', 'test', {});
    expect(manifest.fieldCoverage).toBeUndefined();
    expect('fieldCoverage' in manifest).toBe(false);
  });
});
