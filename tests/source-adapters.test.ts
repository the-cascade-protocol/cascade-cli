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
let appleSrcDir: string;
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

  // A second Apple-shaped export whose export.xml carries <ClinicalRecord>
  // wrappers (the authoritative per-record source labels) at the END of the
  // file, after the device <Record> firehose — exactly Apple's real layout. One
  // clinical file has no wrapper (to prove partial coverage degrades gracefully),
  // and one sourceName carries an XML entity (to prove it is decoded).
  appleSrcDir = path.join(root, 'apple_health_export_sourced');
  fs.mkdirSync(path.join(appleSrcDir, 'clinical-records'), { recursive: true });
  for (const f of ['AllergyIntolerance-1.json', 'Condition-2.json', 'Observation-3.json']) {
    fs.writeFileSync(path.join(appleSrcDir, 'clinical-records', f), '{"resourceType":"Condition"}');
  }
  const filler = '  <Record type="HKQuantityTypeIdentifierHeartRate" value="72"/>\n'.repeat(50);
  const exportXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n' +
    '  <ExportDate value="2026-06-22 16:15:00 -0700"/>\n' +
    filler +
    '  <ClinicalRecord type="AllergyIntolerance" identifier="a1" sourceName="Swedish" ' +
    'sourceURL="https://haiku.swedish.org/fhir/AllergyIntolerance/a1" fhirVersion="1.0.2" ' +
    'receivedDate="2019-11-18 22:16:15 -0700" resourceFilePath="/clinical-records/AllergyIntolerance-1.json"/>\n' +
    '  <ClinicalRecord type="Condition" identifier="c2" sourceName="Providence Health &amp; Services" ' +
    'sourceURL="https://api.providence.org/fhir/Condition/c2" fhirVersion="4.0.1" ' +
    'receivedDate="2025-11-14 00:11:20 -0700" resourceFilePath="/clinical-records/Condition-2.json"/>\n' +
    '</HealthData>\n';
  fs.writeFileSync(path.join(appleSrcDir, 'export.xml'), exportXml);

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

  it('recovers per-record source (sourceName) from export.xml <ClinicalRecord> wrappers', () => {
    const out = appleHealthAdapter.expand(appleSrcDir);
    expect(out.fileSources).toBeDefined();
    const fs2 = out.fileSources!;

    const allergyPath = path.join(appleSrcDir, 'clinical-records', 'AllergyIntolerance-1.json');
    const conditionPath = path.join(appleSrcDir, 'clinical-records', 'Condition-2.json');
    const observationPath = path.join(appleSrcDir, 'clinical-records', 'Observation-3.json');

    // sourceName becomes the authoritative EHR/account label, keyed by abs path.
    expect(fs2[allergyPath]?.sourceEhr).toBe('Swedish');
    expect(fs2[allergyPath]?.sourceUrl).toBe('https://haiku.swedish.org/fhir/AllergyIntolerance/a1');
    expect(fs2[allergyPath]?.receivedDate).toBe('2019-11-18 22:16:15 -0700');

    // XML entities in sourceName are decoded (&amp; -> &).
    expect(fs2[conditionPath]?.sourceEhr).toBe('Providence Health & Services');

    // A clinical file with no wrapper is simply absent (falls back to derivation).
    expect(fs2[observationPath]).toBeUndefined();

    // The device export is still skipped despite being read for its tail block.
    expect(out.skipped.map((s) => path.basename(s.path))).toContain('export.xml');
  });

  it('yields no fileSources when export.xml has no clinical wrappers', () => {
    const out = appleHealthAdapter.expand(appleDir);
    expect(out.fileSources && Object.keys(out.fileSources).length).toBeFalsy();
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
