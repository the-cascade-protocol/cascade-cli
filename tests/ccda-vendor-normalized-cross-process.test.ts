/**
 * The recovered sections, measured from a FRESH process and a DIFFERENT working
 * directory, through the BUILT artifact.
 *
 * WHY THIS IS SEPARATE FROM THE IN-PROCESS CASES
 * ----------------------------------------------
 * Two conversions inside one process share a module cache, one `process.cwd()`
 * and any memoization a converter holds, so a defect keyed on any of those is
 * invisible to them. That is not hypothetical in this repo: an earlier identity
 * defect hashed an ABSOLUTE input path and stayed green for months because every
 * run started from the same directory.
 *
 * These cases therefore spawn a separate `node` per measurement, from two
 * different directories, and import the converter from `dist/` — the artifact an
 * npm consumer installs, not the TypeScript sources.
 *
 * They do NOT skip when `dist/` is missing. A determinism claim that quietly
 * declines to run is the same "absence reported as success" shape as the defect
 * this suite is about; a missing build is a broken checkout, and it says so.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYNTHETIC_EPIC_CCDA, SYNTHETIC_UNKNOWN_VENDOR_CCDA } from './ccda-synthetic-documents.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(REPO, 'dist');

const SCRIPT = `
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
const dist = process.env.CASCADE_DIST;
const { convertCcda } = await import(pathToFileURL(path.join(dist, 'lib/ccda-converter/index.js')).href);
const payload = JSON.parse(process.env.CASCADE_PAYLOAD);
const r = await convertCcda(payload.xml, { sourceSystem: 'test', importedAt: payload.importedAt });
const iris = [...new Set((r.output ?? '').match(/urn:uuid:[0-9a-f-]{36}/g) ?? [])].sort();
const typeCount = (t) => (r.output ?? '').split(t).length - 1;
process.stdout.write(JSON.stringify({
  iris,
  cwd: process.cwd(),
  census: r.sectionCensus ?? [],
  counts: {
    vitals: typeCount('clinical:VitalSign'),
    labs: typeCount('health:LabResultRecord'),
    panels: typeCount('clinical:LaboratoryReport'),
    familyHistory: typeCount('health:FamilyHistoryRecord'),
    devices: typeCount('clinical:ImplantedDevice'),
    procedures: typeCount('clinical:Procedure'),
  },
}));
`;

interface Run {
  iris: string[];
  cwd: string;
  census: Array<{ label: string; entriesIn: number; recordsOut: number }>;
  counts: Record<string, number>;
}

let scriptPath = '';
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function runFresh(xml: string, cwd: string, importedAt: string): Run {
  const stdout = execFileSync(process.execPath, [scriptPath], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CASCADE_DIST: DIST, CASCADE_PAYLOAD: JSON.stringify({ xml, importedAt }) },
  });
  return JSON.parse(stdout) as Run;
}

beforeAll(() => {
  if (!fs.existsSync(path.join(DIST, 'lib', 'ccda-converter', 'index.js'))) {
    throw new Error(
      `dist/ is missing — run \`npm run build\` before \`npm test\`. This suite verifies the BUILT ` +
        `artifact and will not skip: a determinism claim that declines to run is not a claim.`,
    );
  }
  const d = tempDir('cascade-ccda-xproc-');
  scriptPath = path.join(d, 'convert.mjs');
  fs.writeFileSync(scriptPath, SCRIPT);
});

describe('the recovered sections survive the process and the directory', () => {
  it('mints identical IRIs from two processes in two different directories', () => {
    const a = runFresh(SYNTHETIC_EPIC_CCDA, tempDir('cascade-a-'), '2026-01-02T03:04:05.000Z');
    const b = runFresh(SYNTHETIC_EPIC_CCDA, tempDir('cascade-b-'), '2027-11-12T13:14:15.000Z');
    expect(a.cwd).not.toBe(b.cwd);
    expect(b.iris).toEqual(a.iris);
  });

  it('the records the source kept apart are distinct IRIs, not one collapsed record', () => {
    // Determinism alone is satisfied by minting ONE constant IRI for everything.
    // Distinctness is the other half of the claim.
    const a = runFresh(SYNTHETIC_EPIC_CCDA, tempDir('cascade-c-'), '2026-01-02T03:04:05.000Z');
    expect(new Set(a.iris).size).toBe(a.iris.length);
    expect(a.iris.length).toBeGreaterThanOrEqual(23);
  });

  it('the built artifact recovers every section, in a process that never saw a test fixture', () => {
    const a = runFresh(SYNTHETIC_EPIC_CCDA, tempDir('cascade-d-'), '2026-01-02T03:04:05.000Z');
    expect(a.counts).toEqual({
      vitals: 8,
      labs: 6,
      panels: 2,
      familyHistory: 2,
      devices: 1,
      procedures: 1,
    });
  });

  it('the custodian name does not change the record set, across processes', () => {
    const epic = runFresh(SYNTHETIC_EPIC_CCDA, tempDir('cascade-e-'), '2026-01-02T03:04:05.000Z');
    const unknown = runFresh(SYNTHETIC_UNKNOWN_VENDOR_CCDA, tempDir('cascade-f-'), '2026-01-02T03:04:05.000Z');
    expect(unknown.counts).toEqual(epic.counts);
    expect(
      unknown.census.map((s) => [s.label, s.entriesIn, s.recordsOut]),
    ).toEqual(epic.census.map((s) => [s.label, s.entriesIn, s.recordsOut]));
  });
});
