/**
 * Shape coverage measured against the reference patient pod.
 *
 * This file records the coverage of the bundled shapes over the reference pod
 * AS MEASURED WHEN THE REPORTING WAS BUILT, before SHACL shapes existed for
 * several health record classes. At that point `cascade validate` reported
 * 19 of 19 files passing and exit code 0 on a pod where most subjects matched
 * no shape at all, because a conforming report over zero constraints is
 * indistinguishable from a conforming report over many.
 *
 * The numbers below are therefore a deliberate high-water mark of a gap, not a
 * target. Authoring shapes for the unshaped classes SHOULD move them down, and
 * this file is expected to be updated in the same change that moves them. What
 * must not happen is the numbers moving without anyone noticing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadShapes, validateFile, findTurtleFiles } from '../src/lib/shacl-validator.js';

const CLI_PATH = resolve(__dirname, '../dist/index.js');
const REFERENCE_POD = resolve(__dirname, '../../reference-patient-pod');
const skipIfNoPod = !existsSync(REFERENCE_POD);

const CASCADE_NS = 'https://ns.cascadeprotocol.org/';

/**
 * Coverage of the bundled shapes over the reference pod at the commit that
 * introduced this reporting.
 *
 * Two denominators are recorded because both are meaningful and they differ a
 * lot. `totalSubjects` counts every subject carrying an rdf:type, including
 * those typed only in non-Cascade vocabularies (prov:, foaf:, ldp:, solid:,
 * fhir:) that the Cascade shapes were never written to constrain.
 * `cascadeTypedSubjects` counts only subjects carrying at least one type in the
 * Cascade namespace, which is the population the protocol is responsible for
 * constraining.
 */
const PRE_SHAPE_COVERAGE = {
  files: 19,
  totalSubjects: 448,
  checkedSubjects: 156,
  unshapedSubjects: 292,
  cascadeTypedSubjects: 278,
  unshapedCascadeTypedSubjects: 122,
} as const;

/** Per-file totals, so a shift can be attributed rather than just noticed. */
const PRE_SHAPE_BY_FILE: Record<string, { total: number; checked: number }> = {
  'clinical/allergies.ttl': { total: 3, checked: 0 },
  'clinical/conditions.ttl': { total: 5, checked: 0 },
  'clinical/immunizations.ttl': { total: 4, checked: 0 },
  'clinical/insurance.ttl': { total: 1, checked: 0 },
  'clinical/lab-results.ttl': { total: 11, checked: 0 },
  'clinical/medications.ttl': { total: 8, checked: 8 },
  'clinical/patient-profile.ttl': { total: 4, checked: 4 },
  'clinical/vital-signs.ttl': { total: 141, checked: 141 },
  'index.ttl': { total: 1, checked: 0 },
  'manifest.ttl': { total: 8, checked: 0 },
  'profile/card.ttl': { total: 2, checked: 0 },
  'profile/extended.ttl': { total: 0, checked: 0 },
  'settings/privateTypeIndex.ttl': { total: 5, checked: 0 },
  'settings/publicTypeIndex.ttl': { total: 8, checked: 0 },
  'wellness/activity.ttl': { total: 61, checked: 0 },
  'wellness/blood-pressure.ttl': { total: 61, checked: 0 },
  'wellness/heart-rate.ttl': { total: 61, checked: 0 },
  'wellness/sleep.ttl': { total: 61, checked: 0 },
  'wellness/supplements.ttl': { total: 3, checked: 3 },
};

/**
 * The health record classes carrying real clinical content that no shape
 * constrained at this commit. Each count is a number of subjects that
 * `cascade validate` reported PASS on while running nothing against them.
 */
const UNSHAPED_CLINICAL_CLASSES: Record<string, number> = {
  'https://ns.cascadeprotocol.org/health/v1#LabResultRecord': 11,
  'https://ns.cascadeprotocol.org/health/v1#ConditionRecord': 5,
  'https://ns.cascadeprotocol.org/health/v1#ImmunizationRecord': 4,
  'https://ns.cascadeprotocol.org/health/v1#AllergyRecord': 3,
};

describe.skipIf(skipIfNoPod)('shape coverage over the reference patient pod', () => {
  let results: ReturnType<typeof validateFile>[];

  beforeAll(() => {
    const { store, shapeFiles } = loadShapes();
    results = findTurtleFiles(REFERENCE_POD).map((f) => validateFile(f, store, shapeFiles));
  });

  it('measures the pod at the recorded pre-shape coverage', () => {
    const totalSubjects = results.reduce((n, r) => n + r.coverage.totalSubjects, 0);
    const checkedSubjects = results.reduce((n, r) => n + r.coverage.checkedSubjects, 0);

    expect(results).toHaveLength(PRE_SHAPE_COVERAGE.files);
    expect(totalSubjects).toBe(PRE_SHAPE_COVERAGE.totalSubjects);
    expect(checkedSubjects).toBe(PRE_SHAPE_COVERAGE.checkedSubjects);
    expect(totalSubjects - checkedSubjects).toBe(PRE_SHAPE_COVERAGE.unshapedSubjects);
  });

  it('measures the Cascade-typed population at the recorded pre-shape coverage', () => {
    const isCascadeTyped = (s: { types: string[] }) =>
      s.types.some((t) => t.startsWith(CASCADE_NS));

    const cascadeTyped = results.reduce(
      (n, r) => n + r.subjects.filter(isCascadeTyped).length,
      0,
    );
    const unshapedCascadeTyped = results.reduce(
      (n, r) => n + r.coverage.unshapedSubjects.filter(isCascadeTyped).length,
      0,
    );

    expect(cascadeTyped).toBe(PRE_SHAPE_COVERAGE.cascadeTypedSubjects);
    expect(unshapedCascadeTyped).toBe(PRE_SHAPE_COVERAGE.unshapedCascadeTypedSubjects);
  });

  it('attributes the coverage to specific files', () => {
    const actual: Record<string, { total: number; checked: number }> = {};
    for (const r of results) {
      const rel = r.file.slice(REFERENCE_POD.length + 1);
      actual[rel] = {
        total: r.coverage.totalSubjects,
        checked: r.coverage.checkedSubjects,
      };
    }
    expect(actual).toEqual(PRE_SHAPE_BY_FILE);
  });

  it('names the clinical record classes no shape constrains', () => {
    const counts = new Map<string, number>();
    for (const r of results) {
      for (const t of r.coverage.unshapedTypes) {
        counts.set(t.type, (counts.get(t.type) ?? 0) + t.count);
      }
    }
    for (const [type, expected] of Object.entries(UNSHAPED_CLINICAL_CLASSES)) {
      expect(counts.get(type), `unshaped count for ${type}`).toBe(expected);
    }
  });

  it('reports files that pass while running zero constraints', () => {
    // The defect in one assertion: files the validator called PASS having
    // selected no focus node at all.
    const passedWithNothingChecked = results.filter(
      (r) => r.valid && r.coverage.totalSubjects > 0 && r.coverage.checkedSubjects === 0,
    );
    expect(passedWithNothingChecked.length).toBeGreaterThan(0);
    for (const r of passedWithNothingChecked) {
      expect(r.shapesUsed).toEqual([]);
      expect(r.shapesFired).toEqual([]);
    }
  });

  it('does not name a shape file for a file whose subjects match no target', () => {
    // conditions.ttl declares the health: prefix and uses health: predicates,
    // so prefix-based reporting named health.shapes.ttl and claimed constraints
    // that never ran.
    const conditions = results.find((r) => r.file.endsWith('clinical/conditions.ttl'));
    expect(conditions).toBeDefined();
    expect(conditions?.valid).toBe(true);
    expect(conditions?.coverage.totalSubjects).toBe(5);
    expect(conditions?.coverage.checkedSubjects).toBe(0);
    expect(conditions?.shapesUsed).toEqual([]);
  });

  it('names the shape files that did fire on a file with real coverage', () => {
    const medications = results.find((r) => r.file.endsWith('clinical/medications.ttl'));
    expect(medications?.coverage.checkedSubjects).toBe(8);
    expect(medications?.shapesUsed.length).toBeGreaterThan(0);
    expect(medications?.shapesFired.length).toBeGreaterThan(0);
  });
});

describe.skipIf(skipIfNoPod)('cascade validate output over the reference pod', () => {
  const runCli = (args: string[], cwd: string): string =>
    execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf-8',
      cwd,
      timeout: 120000,
      // Keep colour codes out of the assertions.
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });

  // Strip ANSI so assertions match the text, not the styling.
  const plain = (s: string) => s.replace(/\[[0-9;]*m/g, '');

  it('states how many subjects were checked on a passing file', () => {
    const out = plain(
      runCli(['validate', resolve(REFERENCE_POD, 'clinical/conditions.ttl')], '/'),
    );
    expect(out).toContain(
      '0 of 5 subjects checked; 5 subjects of type health:ConditionRecord had no applicable shape',
    );
    expect(out).toContain('PASS');
  });

  it('does not print a Shapes: line when no shape fired', () => {
    const out = plain(
      runCli(
        ['--verbose', 'validate', resolve(REFERENCE_POD, 'clinical/conditions.ttl')],
        '/',
      ),
    );
    // Match the exact indented output line rather than the bare word, which
    // also occurs in the verbose "Loaded N shape files" preamble.
    expect(out).not.toMatch(/^ {5}Shapes: /m);
  });

  it('prints a pod-wide coverage summary', () => {
    const out = plain(runCli(['validate', REFERENCE_POD], '/'));
    expect(out).toContain(
      `Coverage: ${PRE_SHAPE_COVERAGE.checkedSubjects} of ${PRE_SHAPE_COVERAGE.totalSubjects} subjects checked, ${PRE_SHAPE_COVERAGE.unshapedSubjects} with no applicable shape`,
    );
  });

  it('keeps exit code 0: unshaped subjects are reported, not failed', () => {
    // Deliberate. An unshaped subject is a gap in the vocabulary, not a defect
    // in the data, and failing on it would break every existing caller on
    // upgrade for something they cannot fix in their own pod.
    const out = plain(runCli(['validate', REFERENCE_POD], '/'));
    expect(out).toContain('19 passed');
    expect(out).toContain('with no applicable shape');
  });

  it('is deterministic across processes and working directories', () => {
    const a = plain(runCli(['validate', REFERENCE_POD], '/'));
    const b = plain(runCli(['validate', REFERENCE_POD], resolve(__dirname, '..')));
    expect(a).toBe(b);
    expect(a).toContain('Coverage:');
  });

  it('reports different coverage for genuinely different inputs', () => {
    const labs = plain(
      runCli(['--json', 'validate', resolve(REFERENCE_POD, 'clinical/lab-results.ttl')], '/'),
    );
    const meds = plain(
      runCli(['--json', 'validate', resolve(REFERENCE_POD, 'clinical/medications.ttl')], '/'),
    );

    const labsCoverage = JSON.parse(labs)[0].coverage;
    const medsCoverage = JSON.parse(meds)[0].coverage;

    expect(labsCoverage).not.toEqual(medsCoverage);
    expect(labsCoverage.checkedSubjects).toBe(0);
    expect(labsCoverage.totalSubjects).toBe(11);
    expect(medsCoverage.checkedSubjects).toBe(8);
    expect(medsCoverage.totalSubjects).toBe(8);
  });

  it('exposes coverage in the JSON output', () => {
    const out = runCli(
      ['--json', 'validate', resolve(REFERENCE_POD, 'clinical/allergies.ttl')],
      '/',
    );
    const parsed = JSON.parse(out);
    expect(parsed[0].coverage).toEqual({
      totalSubjects: 3,
      checkedSubjects: 0,
      unshapedSubjects: expect.any(Array),
      unshapedTypes: [
        { type: 'https://ns.cascadeprotocol.org/health/v1#AllergyRecord', count: 3 },
      ],
    });
    expect(parsed[0].coverage.unshapedSubjects).toHaveLength(3);
    expect(parsed[0].shapesUsed).toEqual([]);
  });
});
