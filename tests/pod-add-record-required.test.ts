import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredProperties } from '../src/lib/shape-requirements.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'dist', 'index.js');
const CLINICAL = 'https://ns.cascadeprotocol.org/clinical/v1#';
const HEALTH = 'https://ns.cascadeprotocol.org/health/v1#';
const CHECKUP = 'https://ns.cascadeprotocol.org/checkup/v1#';

function cli(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', timeout: 180000 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function freshPod(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'add-record-required-'));
  roots.push(root);
  const podDir = path.join(root, 'pod');
  expect(cli(['pod', 'init', podDir]).status).toBe(0);
  return podDir;
}

function podFiles(podDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(podDir, full)] = fs.readFileSync(full, 'utf-8');
    }
  };
  walk(podDir);
  return out;
}

describe('required properties are read from the bundled shapes', () => {
  it('names the Violation-level requirements of a class', () => {
    expect(requiredProperties(`${CLINICAL}Supplement`)).toEqual(
      expect.arrayContaining([`${CLINICAL}supplementName`, `${CLINICAL}regulatoryStatus`]),
    );
    expect(requiredProperties(`${HEALTH}ConditionRecord`)).toContain(`${HEALTH}conditionName`);
  });

  it('leaves out Warning-level requirements, which validate does not fail on', () => {
    expect(requiredProperties(`${CHECKUP}SupplementSummary`)).toEqual([]);
  });
});

describe('pod add-record refuses a record missing a required property', () => {
  it('names the missing property, exits 1, and writes nothing', () => {
    const podDir = freshPod();
    const before = podFiles(podDir);
    const r = cli([
      'pod', 'add-record', podDir, '--type', 'clinical:Supplement',
      JSON.stringify({ 'clinical:supplementName': 'Vitamin D3' }),
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('clinical:regulatoryStatus');
    expect(r.stdout + r.stderr).not.toContain('clinical:supplementName');
    expect(podFiles(podDir)).toEqual(before);
  });

  it('names every missing property at once', () => {
    const podDir = freshPod();
    const r = cli(['pod', 'add-record', podDir, '--type', 'clinical:Supplement', '{}']);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('clinical:regulatoryStatus');
    expect(r.stdout + r.stderr).toContain('clinical:supplementName');
  });

  it('treats a blank value as missing', () => {
    const podDir = freshPod();
    const r = cli([
      'pod', 'add-record', podDir, '--type', 'health:ConditionRecord',
      JSON.stringify({ 'health:conditionName': '   ' }),
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('health:conditionName');
  });

  it('reports the refusal in the --json error envelope', () => {
    const podDir = freshPod();
    const r = cli(['--json', 'pod', 'add-record', podDir, '--type', 'health:AllergyRecord', '{}']);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout || r.stderr).error).toContain('health:allergen');
  });

  it('still accepts a record whose only gaps are Warning-level', () => {
    const podDir = freshPod();
    const r = cli(['pod', 'add-record', podDir, '--type', 'checkup:SupplementSummary', '{}']);
    expect(r.status).toBe(0);
  });
});
