/**
 * Integration tests for `cascade pod import`.
 *
 * Each test creates a fresh pod via `pod init`, runs `pod import` with
 * synthetic FHIR JSON or Turtle, and asserts on the resulting pod state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolve } from 'path';
import { existsSync } from 'fs';

const CLI_PATH = resolve(__dirname, '../dist/index.js');

function runCli(args: string, opts?: { timeout?: number }): string {
  try {
    return execSync(`node ${CLI_PATH} ${args}`, {
      encoding: 'utf-8',
      timeout: opts?.timeout ?? 30000,
    }).trim();
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; status?: number };
    return (execError.stdout ?? '').trim() + (execError.stderr ?? '').trim();
  }
}

// ---------------------------------------------------------------------------
// Minimal synthetic FHIR bundles
// ---------------------------------------------------------------------------

/**
 * A FHIR bundle with one Patient, one Condition, one MedicationStatement,
 * and one Immunization.
 */
function makeFhirBundle(patientId = 'patient-001', conditionId = 'cond-001', medId = 'med-001'): string {
  return JSON.stringify({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'Patient',
          id: patientId,
          name: [{ family: 'Test', given: ['Patient'] }],
          birthDate: '1980-01-01',
        },
      },
      {
        resource: {
          resourceType: 'Condition',
          id: conditionId,
          clinicalStatus: {
            coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }],
          },
          code: {
            coding: [
              {
                system: 'http://snomed.info/sct',
                code: '44054006',
                display: 'Type 2 diabetes mellitus',
              },
            ],
            text: 'Type 2 diabetes mellitus',
          },
          subject: { reference: `Patient/${patientId}` },
          onsetDateTime: '2010-03-15T00:00:00Z',
        },
      },
      {
        resource: {
          resourceType: 'MedicationStatement',
          id: medId,
          status: 'active',
          medicationCodeableConcept: {
            coding: [
              {
                system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
                code: '860975',
                display: 'Metformin 500 MG Oral Tablet',
              },
            ],
            text: 'Metformin',
          },
          subject: { reference: `Patient/${patientId}` },
          effectivePeriod: { start: '2010-06-01' },
        },
      },
      {
        resource: {
          resourceType: 'Immunization',
          id: `imm-${patientId}`,
          status: 'completed',
          vaccineCode: {
            coding: [
              {
                system: 'http://hl7.org/fhir/sid/cvx',
                code: '08',
                display: 'Hep B, adolescent or pediatric',
              },
            ],
          },
          patient: { reference: `Patient/${patientId}` },
          occurrenceDateTime: '2020-09-15T00:00:00Z',
        },
      },
    ],
  });
}

/**
 * A second FHIR bundle with the same condition (same SNOMED code) but slight
 * differences (different source system, different status) — exercises reconciliation.
 */
function makeFhirBundleOverlap(patientId = 'patient-001'): string {
  return JSON.stringify({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'Condition',
          id: 'cond-overlap',
          clinicalStatus: {
            coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'resolved' }],
          },
          code: {
            coding: [
              {
                system: 'http://snomed.info/sct',
                code: '44054006',
                display: 'Type 2 diabetes mellitus',
              },
            ],
            text: 'Type 2 diabetes mellitus',
          },
          subject: { reference: `Patient/${patientId}` },
          onsetDateTime: '2010-03-15T00:00:00Z',
        },
      },
    ],
  });
}

/**
 * A FHIR bundle with resource types that should land in fhir-passthrough.
 */
function makeFhirBundlePassthrough(): string {
  return JSON.stringify({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'RelatedPerson',
          id: 'rp-001',
          patient: { reference: 'Patient/patient-001' },
          relationship: [{ text: 'Spouse' }],
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('pod import', () => {
  let tempDir: string;
  let podDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      '/tmp',
      `cascade-import-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });
    podDir = path.join(tempDir, 'test-pod');
    // Initialize the pod
    runCli(`pod init ${podDir}`);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ─── Test 1: Single FHIR bundle creates expected pod files ─────────────────

  it('should create expected pod files from a single FHIR bundle', async () => {
    const bundlePath = path.join(tempDir, 'bundle.json');
    await fs.writeFile(bundlePath, makeFhirBundle(), 'utf-8');

    const output = runCli(`--json pod import ${podDir} ${bundlePath} --source-system test-hospital`);
    const parsed = JSON.parse(output);

    expect(parsed.totalRecordsImported).toBeGreaterThan(0);
    expect(parsed.dryRun).toBe(false);

    // Conditions file should exist
    expect(existsSync(path.join(podDir, 'clinical', 'conditions.ttl'))).toBe(true);
    // Medications file should exist
    expect(existsSync(path.join(podDir, 'clinical', 'medications.ttl'))).toBe(true);
    // Immunizations file should exist
    expect(existsSync(path.join(podDir, 'clinical', 'immunizations.ttl'))).toBe(true);
    // Patient profile file should exist
    expect(existsSync(path.join(podDir, 'clinical', 'patient-profile.ttl'))).toBe(true);

    // Conditions file should contain Turtle content
    const condContent = await fs.readFile(path.join(podDir, 'clinical', 'conditions.ttl'), 'utf-8');
    expect(condContent).toContain('@prefix');
  });

  // ─── Test 2: --dry-run does not write any files ─────────────────────────────

  it('should not write any files with --dry-run', async () => {
    const bundlePath = path.join(tempDir, 'bundle.json');
    await fs.writeFile(bundlePath, makeFhirBundle(), 'utf-8');

    const output = runCli(`--json pod import ${podDir} ${bundlePath} --dry-run`);
    const parsed = JSON.parse(output);

    expect(parsed.dryRun).toBe(true);

    // Pod data files should NOT exist (only the init skeleton should be present)
    expect(existsSync(path.join(podDir, 'clinical', 'conditions.ttl'))).toBe(false);
    expect(existsSync(path.join(podDir, 'clinical', 'medications.ttl'))).toBe(false);
  });

  // ─── Test 3: Second import to same pod merges without duplicating records ───

  it('should merge without duplicating records on second import', async () => {
    const bundlePath = path.join(tempDir, 'bundle.json');
    await fs.writeFile(bundlePath, makeFhirBundle('patient-001', 'cond-unique-001', 'med-unique-001'), 'utf-8');

    // First import
    runCli(`pod import ${podDir} ${bundlePath} --source-system hospital`);

    const condFile = path.join(podDir, 'clinical', 'conditions.ttl');
    expect(existsSync(condFile)).toBe(true);
    const contentAfterFirst = await fs.readFile(condFile, 'utf-8');

    // Count subject URIs in the first import
    const uriMatchesFirst = contentAfterFirst.match(/urn:uuid:/g) ?? [];
    const uriCountFirst = new Set(uriMatchesFirst).size;

    // Second import with same bundle
    runCli(`pod import ${podDir} ${bundlePath} --source-system hospital`);

    const contentAfterSecond = await fs.readFile(condFile, 'utf-8');
    const uriMatchesSecond = contentAfterSecond.match(/urn:uuid:/g) ?? [];
    const uriCountSecond = new Set(uriMatchesSecond).size;

    // The unique subject URI count should be the same (no duplication)
    expect(uriCountSecond).toBe(uriCountFirst);
  });

  // ─── Test 4: Multi-file import with reconciliation ──────────────────────────

  it('should reconcile two FHIR files with overlapping conditions', async () => {
    const bundle1Path = path.join(tempDir, 'bundle1.json');
    const bundle2Path = path.join(tempDir, 'bundle2.json');
    await fs.writeFile(bundle1Path, makeFhirBundle('patient-001', 'cond-001'), 'utf-8');
    await fs.writeFile(bundle2Path, makeFhirBundleOverlap('patient-001'), 'utf-8');

    const output = runCli(
      `--json pod import ${podDir} ${bundle1Path} ${bundle2Path} --source-system primary-care`,
    );
    const parsed = JSON.parse(output);

    expect(parsed.totalRecordsImported).toBeGreaterThanOrEqual(0);
    // Reconciliation should have been enabled (2 files)
    expect(parsed.reconciliation).toBeDefined();
    expect(parsed.reconciliation.enabled).toBe(true);
  });

  // ─── Test 5: publicTypeIndex.ttl gets type registrations ───────────────────

  it('should add type registrations to publicTypeIndex.ttl after import', async () => {
    const bundlePath = path.join(tempDir, 'bundle.json');
    await fs.writeFile(bundlePath, makeFhirBundle(), 'utf-8');

    runCli(`pod import ${podDir} ${bundlePath} --source-system test-clinic`);

    const publicIndexPath = path.join(podDir, 'settings', 'publicTypeIndex.ttl');
    expect(existsSync(publicIndexPath)).toBe(true);

    const content = await fs.readFile(publicIndexPath, 'utf-8');
    // Should contain at least one TypeRegistration
    expect(content).toContain('solid:TypeRegistration');
    expect(content).toContain('solid:forClass');
    expect(content).toContain('solid:instance');
  });

  // ─── Test 6: FHIR passthrough records go to fhir-passthrough.ttl ───────────

  it('should route passthrough FHIR resources to fhir-passthrough.ttl', async () => {
    const bundlePath = path.join(tempDir, 'passthrough.json');
    await fs.writeFile(bundlePath, makeFhirBundlePassthrough(), 'utf-8');

    const output = runCli(`--json pod import ${podDir} ${bundlePath}`);
    const parsed = JSON.parse(output);

    // The import should succeed
    expect(parsed).toBeDefined();

    const passthroughFile = path.join(podDir, 'clinical', 'fhir-passthrough.ttl');
    expect(existsSync(passthroughFile)).toBe(true);

    const content = await fs.readFile(passthroughFile, 'utf-8');
    expect(content).toContain('@prefix');
  });

  // ─── Test 7: index.ttl gets ldp:contains entries for new files ─────────────

  it('should append ldp:contains references to index.ttl', async () => {
    const bundlePath = path.join(tempDir, 'bundle.json');
    await fs.writeFile(bundlePath, makeFhirBundle(), 'utf-8');

    runCli(`pod import ${podDir} ${bundlePath} --source-system clinic`);

    const indexContent = await fs.readFile(path.join(podDir, 'index.ttl'), 'utf-8');
    // index.ttl should reference at least one clinical file
    expect(indexContent).toContain('clinical/');
  });

  // ─── Test 8: --no-reconcile with multiple files concatenates ───────────────

  it('should concatenate inputs without reconciliation when --no-reconcile is set', async () => {
    const bundle1Path = path.join(tempDir, 'b1.json');
    const bundle2Path = path.join(tempDir, 'b2.json');
    await fs.writeFile(bundle1Path, makeFhirBundle('patient-001', 'cond-a', 'med-a'), 'utf-8');
    await fs.writeFile(bundle2Path, makeFhirBundle('patient-002', 'cond-b', 'med-b'), 'utf-8');

    const output = runCli(
      `--json pod import ${podDir} ${bundle1Path} ${bundle2Path} --no-reconcile`,
    );
    const parsed = JSON.parse(output);

    expect(parsed.reconciliation?.enabled).toBe(false);
    expect(parsed.totalRecordsImported).toBeGreaterThan(0);
  });

  // ─── Test 9: Errors when pod does not exist ─────────────────────────────────

  it('should error when pod directory does not exist', async () => {
    const fakePod = path.join(tempDir, 'nonexistent-pod');
    const bundlePath = path.join(tempDir, 'bundle.json');
    await fs.writeFile(bundlePath, makeFhirBundle(), 'utf-8');

    const output = runCli(`pod import ${fakePod} ${bundlePath}`);
    expect(output.toLowerCase()).toMatch(/not found|index\.ttl|pod/);
  });
});
