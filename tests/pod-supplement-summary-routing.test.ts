/**
 * A supplement a person records by hand must have somewhere to go.
 *
 * WHAT WENT WRONG
 * ---------------
 * `DATA_TYPES` registered `clinical:Supplement` and nothing else, so
 *
 *     cascade pod add-record <pod> --type checkup:SupplementSummary --json '{...}'
 *
 * failed outright with
 *
 *     No known bucket for type checkup:SupplementSummary.
 *
 * and there was no way to add a supplement by hand at all. The checkup
 * vocabulary's `SupplementSummary` is the patient-facing spelling: it is the one
 * that carries `checkup:regulatoryStatus`, the classification that separates a
 * dietary supplement or an OTC product from an FDA-approved medication, and it
 * is what a person entering their own supplement has to say. Its SHACL shape has
 * shipped in this package the whole time; only the route was missing.
 *
 * This is the same defect the family-history routing tests were written for: a
 * ratified class with a bundled shape and no bucket. The difference is where it
 * surfaced. Family history fell THROUGH to the FHIR passthrough bucket, so the
 * import "succeeded" and the records were merely misfiled. `add-record` has no
 * passthrough fallback, so this one is a hard refusal on the write path.
 *
 * WHAT THESE WOULD DO IF THE FIX WERE ABSENT
 *   - `registers checkup:SupplementSummary` FAILS: the bucket's rdfTypes hold
 *     only `clinical:Supplement`.
 *   - `add-record writes one` FAILS: exit code 1 and the "No known bucket"
 *     message, with `wellness/supplements.ttl` never created.
 *   - `pod query --supplements returns it` and `pod query --all` FAIL: nothing
 *     was ever written.
 *   - `pod info counts it` FAILS for the same reason.
 *
 * The supplement names are obviously synthetic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_TYPES } from '../src/lib/pod-data-types.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'dist', 'index.js');
const CHECKUP = 'https://ns.cascadeprotocol.org/checkup/v1#';
const CLINICAL = 'https://ns.cascadeprotocol.org/clinical/v1#';

const roots: string[] = [];

function cli(args: string[]): { output: string; status: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', timeout: 180000 });
  return { output: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status ?? 1 };
}

function cliWithEnv(
  args: string[],
  env: Record<string, string>,
): { output: string; status: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', timeout: 180000, env: { ...process.env, ...env },
  });
  return { output: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status ?? 1 };
}

/** A pod holding one hand-entered supplement summary. */
function podWithSupplement(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supp-route-'));
  roots.push(root);
  const podDir = path.join(root, 'pod');

  const init = cli(['pod', 'init', podDir]);
  expect(init.status, init.output).toBe(0);

  const add = cli([
    '--json', 'pod', 'add-record', podDir,
    '--type', 'checkup:SupplementSummary',
    '--json', JSON.stringify({
      'checkup:supplementName': 'Synthetic Kelp Blend',
      'checkup:regulatoryStatus': 'dietarySupplement',
      'checkup:supplementForm': 'capsule',
      'checkup:reasonForUse': 'general wellness',
    }),
  ]);
  expect(add.status, add.output).toBe(0);
  return podDir;
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error('dist/index.js is missing. Run `npm run build` before `npm test`.');
  }
});

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('the supplements routing bucket', () => {
  it('registers checkup:SupplementSummary against wellness/supplements.ttl', () => {
    const bucket = DATA_TYPES.supplements;
    expect(bucket).toBeDefined();
    expect(bucket.rdfTypes).toContain(`${CHECKUP}SupplementSummary`);
    expect(bucket.directory).toBe('wellness');
    expect(bucket.filename).toBe('supplements.ttl');
  });

  it('still registers the importer spelling in the SAME bucket', () => {
    // Both vocabularies name a supplement, and a reader asking "what supplements
    // are there" must not have to know which one the writer used. Two buckets
    // would answer that question twice and agree by luck.
    expect(DATA_TYPES.supplements.rdfTypes).toContain(`${CLINICAL}Supplement`);
  });

  it('claims the type exclusively, so no other bucket also routes it', () => {
    // Two buckets claiming one type makes routing depend on object key order,
    // which is a different defect wearing the same symptom.
    const claimants = Object.entries(DATA_TYPES)
      .filter(([, info]) => info.rdfTypes.includes(`${CHECKUP}SupplementSummary`))
      .map(([key]) => key);
    expect(claimants).toEqual(['supplements']);
  });
});

describe('cascade pod add-record --type checkup:SupplementSummary', () => {
  it('writes the record to wellness/supplements.ttl', () => {
    const podDir = podWithSupplement();
    const file = path.join(podDir, 'wellness', 'supplements.ttl');

    expect(fs.existsSync(file), 'wellness/supplements.ttl was never created').toBe(true);
    const turtle = fs.readFileSync(file, 'utf-8');
    // The type AND the content: a file with the right type and the wrong values
    // would satisfy the first assertion alone.
    expect(turtle).toContain('checkup:SupplementSummary');
    expect(turtle).toContain('Synthetic Kelp Blend');
    expect(turtle).toContain('dietarySupplement');
  });

  it('reports the bucket it chose', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supp-route-msg-'));
    roots.push(root);
    const podDir = path.join(root, 'pod');
    expect(cli(['pod', 'init', podDir]).status).toBe(0);

    // Through CASCADE_RECORD_JSON, so the documented `--json '<propsJson>'`
    // surface does not also set the global JSON flag and the human-readable
    // report (which is where the destination file is named) is what comes back.
    const add = cliWithEnv(
      ['pod', 'add-record', podDir, '--type', 'checkup:SupplementSummary'],
      { CASCADE_RECORD_JSON: '{"checkup:supplementName":"Synthetic Beet Powder","checkup:regulatoryStatus":"dietarySupplement"}' },
    );
    expect(add.status, add.output).toBe(0);
    expect(add.output).toContain('wellness/supplements.ttl');
  });

  it('reaches it through pod query --supplements', () => {
    const podDir = podWithSupplement();
    const r = cli(['--json', 'pod', 'query', podDir, '--supplements']);
    expect(r.status, r.output).toBe(0);

    const parsed = JSON.parse(r.output);
    const bucket = parsed.dataTypes.supplements;
    expect(bucket.count).toBe(1);
    expect(bucket.records[0].type).toBe('checkup:SupplementSummary');
    expect(bucket.records[0].properties['checkup:supplementName']).toBe('Synthetic Kelp Blend');
  });

  it('reaches it through pod query --all', () => {
    const podDir = podWithSupplement();
    const r = cli(['--json', 'pod', 'query', podDir, '--all']);
    expect(r.status, r.output).toBe(0);
    expect(JSON.stringify(JSON.parse(r.output))).toContain('Synthetic Kelp Blend');
  });

  it('counts the bucket in pod info', () => {
    const podDir = podWithSupplement();
    const r = cli(['pod', 'info', podDir]);
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/supplements\.ttl\s+1 record/);
  });

  it('validates against the bundled checkup shapes with nothing to report', () => {
    const podDir = podWithSupplement();
    const r = cli(['--json', 'validate', path.join(podDir, 'wellness', 'supplements.ttl')]);
    expect(r.status, r.output).toBe(0);

    const [report] = JSON.parse(r.output);
    expect(report.valid).toBe(true);
    // The shape must actually have FIRED. A record no shape selects also
    // produces zero results, and "nothing checked it" is not "it is correct".
    expect(report.shapesFired).toContain('SupplementSummaryShape');
    expect(report.coverage.unshapedSubjects).toEqual([]);
    expect(report.results).toEqual([]);
  });

  it('still refuses a type no bucket routes', () => {
    // The fix registers ONE class. A route map that started accepting anything
    // would pass every assertion above and quietly file unknown records.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supp-route-neg-'));
    roots.push(root);
    const podDir = path.join(root, 'pod');
    expect(cli(['pod', 'init', podDir]).status).toBe(0);

    const add = cli([
      'pod', 'add-record', podDir,
      '--type', 'checkup:IntakeFormData',
      '--json', '{"checkup:supplementName":"Synthetic Kelp Blend"}',
    ]);
    expect(add.status).toBe(1);
    expect(add.output).toContain('No known bucket');
  });
});
