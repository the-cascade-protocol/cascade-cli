/**
 * Source-adapter layer: the container abstraction above per-file importers.
 * Detection + expansion are pure filesystem reads, so these tests build small
 * temp fixtures (an Apple Health-shaped export, a plain folder) and assert what
 * each adapter yields and skips, plus the registry's specific-first dispatch.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appleHealthAdapter } from '../src/lib/source-adapters/apple-health.js';
import { directoryAdapter } from '../src/lib/source-adapters/directory.js';
import { detectSource } from '../src/lib/source-adapters/registry.js';

let root: string;
let appleDir: string;
let plainDir: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-source-adapters-'));

  // An Apple Health-shaped export: clinical-records FHIR + two device exports.
  appleDir = path.join(root, 'apple_health_export');
  fs.mkdirSync(path.join(appleDir, 'clinical-records'), { recursive: true });
  fs.writeFileSync(path.join(appleDir, 'clinical-records', 'Condition-1.json'), '{"resourceType":"Condition"}');
  fs.writeFileSync(path.join(appleDir, 'clinical-records', 'Observation-2.json'), '{"resourceType":"Observation"}');
  fs.writeFileSync(path.join(appleDir, 'export.xml'), '<HealthData/>');
  fs.writeFileSync(path.join(appleDir, 'export_cda.xml'), '<ClinicalDocument/>');
  fs.mkdirSync(path.join(appleDir, 'workout-routes'));

  // A plain folder of mixed files, including a nested dir, an unsupported file,
  // and a dotfile.
  plainDir = path.join(root, 'records');
  fs.mkdirSync(path.join(plainDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(plainDir, 'a.json'), '{}');
  fs.writeFileSync(path.join(plainDir, 'b.ttl'), '');
  fs.writeFileSync(path.join(plainDir, 'sub', 'c.xml'), '<x/>');
  fs.writeFileSync(path.join(plainDir, 'notes.txt'), 'not importable');
  fs.writeFileSync(path.join(plainDir, '.DS_Store'), '');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('appleHealthAdapter', () => {
  it('detects an export folder by clinical-records / device exports', () => {
    expect(appleHealthAdapter.detect(appleDir)).toBe(true);
    expect(appleHealthAdapter.detect(plainDir)).toBe(false);
    expect(appleHealthAdapter.detect(path.join(appleDir, 'export.xml'))).toBe(false); // a file, not a dir
  });

  it('expands to clinical-records FHIR and skips the device exports', () => {
    const out = appleHealthAdapter.expand(appleDir);
    expect(out.sourceLabel).toBe('Apple Health export');
    expect(out.files.map((f) => path.basename(f)).sort()).toEqual([
      'Condition-1.json',
      'Observation-2.json',
    ]);
    // Every imported file lives under clinical-records.
    expect(out.files.every((f) => f.includes(`${path.sep}clinical-records${path.sep}`))).toBe(true);
    // Both device exports and the workout-routes dir are skipped with reasons.
    const skippedNames = out.skipped.map((s) => path.basename(s.path)).sort();
    expect(skippedNames).toEqual(['export.xml', 'export_cda.xml', 'workout-routes']);
    expect(out.skipped.every((s) => s.reason.length > 0)).toBe(true);
  });
});

describe('directoryAdapter', () => {
  it('detects any directory', () => {
    expect(directoryAdapter.detect(plainDir)).toBe(true);
    expect(directoryAdapter.detect(path.join(plainDir, 'a.json'))).toBe(false);
  });

  it('recursively collects supported files; skips unsupported + dotfiles', () => {
    const out = directoryAdapter.expand(plainDir);
    const names = out.files.map((f) => path.basename(f)).sort();
    expect(names).toEqual(['a.json', 'b.ttl', 'c.xml']); // recursed into sub/, dropped notes.txt + .DS_Store
  });
});

describe('detectSource (registry dispatch)', () => {
  it('routes an Apple Health export to its adapter, a plain folder to directory', () => {
    expect(detectSource(appleDir)?.id).toBe('apple-health'); // specific wins
    expect(detectSource(plainDir)?.id).toBe('directory');
  });

  it('returns undefined for a non-directory path', () => {
    expect(detectSource(path.join(plainDir, 'a.json'))).toBeUndefined();
  });
});
