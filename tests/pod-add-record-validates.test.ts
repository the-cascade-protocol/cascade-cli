/**
 * A record `pod add-record` writes from complete input must pass `cascade validate` with no
 * violation. Overlay verbs are covered in pod-records-edit.test.ts; this covers the bucket
 * add-record writes, for each record class a person is likely to enter by hand.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'dist', 'index.js');

function cli(args: string[]): { stdout: string; status: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', timeout: 180000 });
  return { stdout: r.stdout ?? '', status: r.status ?? 1 };
}

const COMPLETE_RECORDS: Array<{ type: string; props: Record<string, string> }> = [
  { type: 'clinical:Medication', props: { 'clinical:drugName': 'Lisinopril 10 mg tablet' } },
  { type: 'health:ConditionRecord', props: { 'health:conditionName': 'Seasonal allergic rhinitis' } },
  { type: 'health:AllergyRecord', props: { 'health:allergen': 'Penicillin' } },
  {
    type: 'clinical:Supplement',
    props: { 'clinical:supplementName': 'Vitamin D3', 'clinical:regulatoryStatus': 'dietarySupplement' },
  },
];

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('pod add-record writes records that pass cascade validate', () => {
  for (const { type, props } of COMPLETE_RECORDS) {
    it(type, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'add-record-valid-'));
      roots.push(root);
      const podDir = path.join(root, 'pod');
      expect(cli(['pod', 'init', podDir]).status).toBe(0);

      const add = cli(['--json', 'pod', 'add-record', podDir, '--type', type, JSON.stringify(props)]);
      expect(add.status, add.stdout).toBe(0);

      const v = cli(['--json', 'validate', podDir]);
      const reports = JSON.parse(v.stdout) as Array<{
        file: string;
        results: Array<{ severity: string; property?: string; message: string }>;
      }>;
      const violations = reports.flatMap((r) =>
        r.results
          .filter((x) => x.severity === 'violation')
          .map((x) => `${path.relative(podDir, r.file)}: ${x.property ?? ''} ${x.message}`),
      );
      expect(violations).toEqual([]);
      expect(v.status).toBe(0);
    });
  }
});
