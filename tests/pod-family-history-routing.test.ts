/**
 * Family-history records must land in the family-history file.
 *
 * WHAT WENT WRONG
 * ---------------
 * The C-CDA Family History section emits `health:FamilyHistoryRecord`. That IRI
 * appeared in no `DATA_TYPES` entry, so `routeTypeKey` (`commands/pod/import.ts`)
 * matched nothing and fell through to its final `return 'fhir-passthrough'` —
 * the branch meant for genuinely unmapped `http://hl7.org/fhir/*` types. Every
 * family-history record a C-CDA import produced was therefore written to
 * `clinical/fhir-passthrough.ttl`.
 *
 * Nothing about that looked wrong from the outside. The import succeeded, the
 * summary counted the records, and the section reported `Family History: 2 -> 2`.
 * The records existed; they were just filed under "type we could not map", which
 * is the one bucket a reader is entitled to ignore.
 *
 * WHY IT MATTERS MORE NOW
 * -----------------------
 * health v2.5 gives `health:FamilyHistoryRecord` a ratified SHACL shape, and the
 * conformance corpus carries fixtures against it. A class with a shape whose
 * records sit in the passthrough bucket is worse than one with neither: the
 * shape's consumers look at `family-history.ttl`, find no file, and conclude
 * there is no family history.
 *
 * WHAT THESE WOULD DO IF THE FIX WERE ABSENT — measured against 1750f16:
 *   - `writes them to clinical/family-history.ttl` FAILS: the file does not exist.
 *   - `does not file them under FHIR passthrough` FAILS: both records are in
 *     `clinical/fhir-passthrough.ttl`.
 *   - `registers the bucket` FAILS: `DATA_TYPES['family-history']` is undefined.
 *   - `reaches them through pod query --all` FAILS: the records are reported
 *     under `fhir-passthrough`, not `family-history`.
 *
 * Note the assertions name the FILE, not the type string. An assertion that only
 * checked the pod's concatenated Turtle for `health:FamilyHistoryRecord` passes
 * either way — the records were always present, just in the wrong file — and one
 * such assertion already existed and stayed green throughout.
 *
 * The fixture is synthetic, authored from the C-CDA R2.1 specification: two
 * relatives (mother/Type 2 diabetes mellitus, father/myocardial infarction).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYNTHETIC_EPIC_CCDA } from './ccda-synthetic-documents.js';
import { DATA_TYPES } from '../src/lib/pod-data-types.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'dist', 'index.js');
const roots: string[] = [];

function cli(args: string[]): { output: string; status: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', timeout: 180000 });
  return { output: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status ?? 1 };
}

function importedPod(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fhx-routing-'));
  roots.push(root);
  const podDir = path.join(root, 'pod');
  const inputs = path.join(root, 'inputs');
  fs.mkdirSync(inputs);
  fs.writeFileSync(path.join(inputs, 'summary.xml'), SYNTHETIC_EPIC_CCDA);

  const init = cli(['pod', 'init', podDir]);
  expect(init.status, init.output).toBe(0);
  const imp = cli(['pod', 'import', podDir, inputs]);
  expect(imp.status, imp.output).toBe(0);
  return podDir;
}

function read(podDir: string, rel: string): string {
  const p = path.join(podDir, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error('dist/index.js is missing — run `npm run build` before `npm test`.');
  }
});

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('the family-history routing bucket', () => {
  it('registers health:FamilyHistoryRecord against clinical/family-history.ttl', () => {
    const bucket = DATA_TYPES['family-history'];
    expect(bucket).toBeDefined();
    expect(bucket.rdfTypes).toContain('https://ns.cascadeprotocol.org/health/v1#FamilyHistoryRecord');
    expect(bucket.directory).toBe('clinical');
    expect(bucket.filename).toBe('family-history.ttl');
  });

  it('claims the type exclusively — no other bucket also routes it', () => {
    // Two buckets claiming one type makes routing depend on object key order,
    // which is a different defect wearing the same symptom.
    const claimants = Object.entries(DATA_TYPES)
      .filter(([, info]) =>
        info.rdfTypes.includes('https://ns.cascadeprotocol.org/health/v1#FamilyHistoryRecord'),
      )
      .map(([key]) => key);
    expect(claimants).toEqual(['family-history']);
  });
});

describe('cascade pod import, on a C-CDA carrying a Family History section', () => {
  it('writes the records to clinical/family-history.ttl', () => {
    const podDir = importedPod();
    const familyHistory = read(podDir, 'clinical/family-history.ttl');

    expect(familyHistory).not.toBe('');
    expect(familyHistory).toContain('health:FamilyHistoryRecord');
    // The values, not only the type: a file holding the right type and the wrong
    // content would satisfy the line above.
    expect(familyHistory).toContain('Type 2 diabetes mellitus');
    expect(familyHistory).toContain('Myocardial infarction');
    expect(familyHistory).toContain('Mother');
    expect(familyHistory).toContain('Father');
  });

  it('does not file them under FHIR passthrough', () => {
    const podDir = importedPod();
    const passthrough = read(podDir, 'clinical/fhir-passthrough.ttl');

    // This is the half that fails on the pre-fix build, where both records were
    // here and `family-history.ttl` did not exist.
    expect(passthrough).not.toContain('FamilyHistoryRecord');
    expect(passthrough).not.toContain('Myocardial infarction');
  });

  it('writes exactly the two records the section carries', () => {
    const podDir = importedPod();
    const familyHistory = read(podDir, 'clinical/family-history.ttl');
    const count = familyHistory.split('health:FamilyHistoryRecord').length - 1;
    expect(count).toBe(2);
  });

  it('reaches them through pod query --all', () => {
    const podDir = importedPod();
    const r = cli(['--json', 'pod', 'query', podDir, '--all']);
    expect(r.status, r.output).toBe(0);

    const parsed = JSON.parse(r.output);
    // `--all` enumerates DATA_TYPES keys, so an unregistered type is unreachable
    // through it by construction — which is what "records exist but no read verb
    // can see them as family history" meant in practice.
    const serialized = JSON.stringify(parsed);
    expect(serialized).toContain('family-history');
    expect(serialized).toContain('Type 2 diabetes mellitus');
  });

  it('counts the bucket in pod info', () => {
    const podDir = importedPod();
    const r = cli(['pod', 'info', podDir]);
    expect(r.status, r.output).toBe(0);

    // `pod info` enumerates registered files, so before the bucket existed this
    // line was absent entirely and the two records were counted, if at all, as
    // `fhir-passthrough.ttl`. Matching the count as well as the name keeps a
    // stray empty file from satisfying it.
    expect(r.output).toMatch(/family-history\.ttl\s+2 records/);
    expect(r.output).not.toMatch(/fhir-passthrough\.ttl/);
  });
});
