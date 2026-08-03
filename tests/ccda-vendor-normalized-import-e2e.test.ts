/**
 * The recovered sections, through `cascade pod import` — the command a user
 * actually runs — and the summary that command prints.
 *
 * The defect was not only that records were lost. It was that the loss was
 * REPORTED AS SUCCESS: the summary printed a record count and a per-bucket
 * breakdown that simply omitted the sections that produced nothing, so an import
 * that dropped three entire clinical sections looked indistinguishable from one
 * that dropped none. Both halves are asserted here, on the printed output.
 *
 * Every fixture is synthetic, authored from the C-CDA R2.1 specification.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYNTHETIC_EPIC_CCDA } from './ccda-synthetic-documents.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'dist', 'index.js');
const roots: string[] = [];

function cli(args: string[]): { output: string; status: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', timeout: 180000 });
  return { output: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status ?? 1 };
}

function newPod(): { podDir: string; inputs: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccda-sections-'));
  roots.push(root);
  const podDir = path.join(root, 'pod');
  const inputs = path.join(root, 'inputs');
  fs.mkdirSync(inputs);
  fs.writeFileSync(path.join(inputs, 'summary.xml'), SYNTHETIC_EPIC_CCDA);
  const init = cli(['pod', 'init', podDir]);
  expect(init.status, init.output).toBe(0);
  return { podDir, inputs };
}

beforeAll(() => {
  // No skip: without a build this claim cannot be made, and declining to make it
  // quietly is the failure mode this whole suite is about.
  if (!fs.existsSync(CLI)) {
    throw new Error(`dist/index.js is missing — run \`npm run build\` before \`npm test\`.`);
  }
});

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('cascade pod import, on a vendor-detected C-CDA', () => {
  it('writes the sections that used to import as nothing', () => {
    const { podDir, inputs } = newPod();
    const r = cli(['pod', 'import', podDir, inputs]);
    expect(r.status, r.output).toBe(0);

    const read = (rel: string) => {
      const p = path.join(podDir, rel);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
    };
    const pod = fs
      .readdirSync(podDir, { recursive: true } as never)
      .filter((f) => String(f).endsWith('.ttl'))
      .map((f) => read(String(f)))
      .join('\n');

    // Each of these was ZERO on a vendor-detected document before the fix.
    expect(pod).toContain('clinical:VitalSign');
    expect(pod).toContain('health:LabResultRecord');
    expect(pod).toContain('health:FamilyHistoryRecord');
    expect(pod).toContain('clinical:ImplantedDevice');
    // And the values, not merely the types.
    expect(pod).toContain('Type 2 diabetes mellitus');
    expect(pod).toContain('Cardiac pacemaker');
    expect(pod).toContain('Appendectomy');
  });

  it('the summary states entries read versus records imported, per section', () => {
    const { podDir, inputs } = newPod();
    const r = cli(['pod', 'import', podDir, inputs]);
    expect(r.output).toContain('Structured sections (entries read -> records imported)');
    expect(r.output).toMatch(/Vital Signs: 1 -> 8/);
    expect(r.output).toMatch(/Results: 2 -> 9/);
    expect(r.output).toMatch(/Family History: 2 -> 2/);
    expect(r.output).toMatch(/Medical Equipment: 1 -> 1/);
  });

  it('a section that imported nothing is named in the summary, not omitted', () => {
    const { podDir, inputs } = newPod();
    const r = cli(['pod', 'import', podDir, inputs]);
    expect(r.output).toMatch(/Allergies: 1 -> 0/);
    expect(r.output).toContain('NOTHING IMPORTED');
    expect(r.output).toContain('imported 0 records');
  });

  it('a true re-import adds nothing and says so', () => {
    const { podDir, inputs } = newPod();
    const first = cli(['pod', 'import', podDir, inputs]);
    expect(first.status, first.output).toBe(0);
    const second = cli(['pod', 'import', podDir, inputs, '--reconcile-existing']);
    expect(second.status, second.output).toBe(0);
    // Every record is already held: none is new.
    expect(second.output).toMatch(/already in pod/);
    expect(second.output).not.toMatch(/\(\d+ new, 0 already in pod\)/);
  });

  it('re-importing does not multiply the records in the pod', () => {
    const { podDir, inputs } = newPod();
    cli(['pod', 'import', podDir, inputs]);
    const countVitals = () => {
      const p = path.join(podDir, 'clinical', 'vitals.ttl');
      const alt = path.join(podDir, 'clinical', 'vital-signs.ttl');
      const file = fs.existsSync(p) ? p : alt;
      if (!fs.existsSync(file)) return 0;
      return fs.readFileSync(file, 'utf-8').split('clinical:VitalSign').length - 1;
    };
    const after1 = countVitals();
    expect(after1, 'the first import must actually write vitals').toBeGreaterThan(0);
    cli(['pod', 'import', podDir, inputs, '--reconcile-existing']);
    expect(countVitals()).toBe(after1);
  });
});
