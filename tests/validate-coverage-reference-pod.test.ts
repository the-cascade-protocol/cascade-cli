/**
 * Shape coverage measured against the reference patient pod.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * It records the coverage of the bundled shapes over the reference pod as an
 * exact measurement, so that a change in coverage has to be acknowledged rather
 * than merely happening. It was written against a pod where most subjects
 * matched no shape at all, and it said of itself: "the numbers below are a
 * deliberate high-water mark of a gap, not a target. Authoring shapes for the
 * unshaped classes SHOULD move them down, and this file is expected to be
 * updated in the same change that moves them."
 *
 * THIS IS THAT CHANGE. The numbers are updated here, in the same commit that
 * synced the vocabulary and shapes that moved them.
 *
 * WHAT MOVED, AND BY HOW MUCH
 * ---------------------------
 * The sync brought in health v2.5, which defines and shapes five record classes
 * that were previously emitted but undefined, and it fixed a sync script that
 * had never copied `health.ttl` at all.
 *
 *                                    before    after
 *   subjects checked                  156       278   (of 448)
 *   subjects with no applicable shape  292       170
 *   Cascade-typed subjects unshaped    122         0
 *
 * The 122 -> 0 line is the one that matters: every one of those 122 was a subject
 * the validator reported PASS on while running nothing whatsoever against them.
 * The last of them was a `clinical:CoverageRecord` in `clinical/insurance.ttl`,
 * closed by retyping it to the ratified `coverage:InsurancePlan` in the reference
 * pod. No Cascade-typed subject in the pod validates vacuously any more.
 *
 * The 170 that remain unshaped are subjects typed only in FOREIGN vocabularies —
 * `prov:Activity` (121), `fhir:Observation` (30), `solid:TypeRegistration` (13),
 * `prov:Agent`, `foaf:Person`, `ldp:BasicContainer` — which the Cascade shapes
 * were never written to constrain and which no Cascade release will shape. That
 * is a floor, not remaining work.
 *
 * Zero violations. Four `sh:Info` advisories on the wellness containers, which
 * fire for the first time because health v2.5 gives `HealthProfileShape` explicit
 * targets. `cascade validate` reports 19 of 19 files passing, exit 0.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadShapes, validateFile, findTurtleFiles } from '../src/lib/shacl-validator.js';
import { conformancePath } from './helpers/conformance.js';

const CLI_PATH = resolve(__dirname, '../dist/index.js');
const REFERENCE_POD = conformancePath('reference-patient-pod');
const skipIfNoPod = !existsSync(REFERENCE_POD);

const CASCADE_NS = 'https://ns.cascadeprotocol.org/';

/**
 * Coverage of the bundled shapes over the reference pod.
 *
 * Two denominators are recorded because both are meaningful and they differ a
 * lot. `totalSubjects` counts every subject carrying an rdf:type, including
 * those typed only in non-Cascade vocabularies (prov:, foaf:, ldp:, solid:,
 * fhir:) that the Cascade shapes were never written to constrain.
 * `cascadeTypedSubjects` counts only subjects carrying at least one type in the
 * Cascade namespace, which is the population the protocol is responsible for
 * constraining — and is therefore the number to watch.
 */
const COVERAGE = {
  files: 19,
  totalSubjects: 448,
  checkedSubjects: 278,
  unshapedSubjects: 170,
  cascadeTypedSubjects: 278,
  unshapedCascadeTypedSubjects: 0,
} as const;

/**
 * The same measurement before the vocabulary and shapes were synced, kept so the
 * delta is legible and so nobody has to dig through history to see what moved.
 * Nothing asserts against it.
 */
const PRE_SYNC_COVERAGE = {
  files: 19,
  totalSubjects: 448,
  checkedSubjects: 156,
  unshapedSubjects: 292,
  cascadeTypedSubjects: 278,
  unshapedCascadeTypedSubjects: 122,
} as const;
void PRE_SYNC_COVERAGE;

/** Per-file totals, so a shift can be attributed rather than just noticed. */
const COVERAGE_BY_FILE: Record<string, { total: number; checked: number }> = {
  'clinical/allergies.ttl': { total: 3, checked: 3 },
  'clinical/conditions.ttl': { total: 5, checked: 5 },
  'clinical/immunizations.ttl': { total: 4, checked: 4 },
  'clinical/insurance.ttl': { total: 1, checked: 1 },
  'clinical/lab-results.ttl': { total: 11, checked: 11 },
  'clinical/medications.ttl': { total: 8, checked: 8 },
  'clinical/patient-profile.ttl': { total: 4, checked: 4 },
  'clinical/vital-signs.ttl': { total: 141, checked: 141 },
  'index.ttl': { total: 1, checked: 0 },
  'manifest.ttl': { total: 8, checked: 4 },
  'profile/card.ttl': { total: 2, checked: 0 },
  'profile/extended.ttl': { total: 0, checked: 0 },
  'settings/privateTypeIndex.ttl': { total: 5, checked: 0 },
  'settings/publicTypeIndex.ttl': { total: 8, checked: 0 },
  'wellness/activity.ttl': { total: 61, checked: 31 },
  'wellness/blood-pressure.ttl': { total: 61, checked: 1 },
  'wellness/heart-rate.ttl': { total: 61, checked: 31 },
  'wellness/sleep.ttl': { total: 61, checked: 31 },
  'wellness/supplements.ttl': { total: 3, checked: 3 },
};

/**
 * The health record classes that carried real clinical content and that NO shape
 * constrained before this sync. Each count was a number of subjects
 * `cascade validate` reported PASS on while running nothing against them.
 *
 * All four are now shaped and fully checked. The assertion below is inverted
 * accordingly: it demands they be absent from the unshaped set, which is a
 * regression guard rather than a record of a gap.
 */
const FORMERLY_UNSHAPED_CLINICAL_CLASSES = [
  'https://ns.cascadeprotocol.org/health/v1#LabResultRecord',
  'https://ns.cascadeprotocol.org/health/v1#ConditionRecord',
  'https://ns.cascadeprotocol.org/health/v1#ImmunizationRecord',
  'https://ns.cascadeprotocol.org/health/v1#AllergyRecord',
];

/**
 * The types that remain unshaped, all foreign. Pinned exactly so that a NEW
 * unshaped type — especially a Cascade one — cannot slip in unremarked.
 */
const REMAINING_UNSHAPED_TYPES: Record<string, number> = {
  'http://www.w3.org/ns/prov#Activity': 121,
  'http://hl7.org/fhir/Observation': 30,
  'http://www.w3.org/ns/solid/terms#TypeRegistration': 13,
  'http://www.w3.org/ns/prov#Agent': 2,
  // The one remaining Cascade-typed holdout; retyping it to
  'http://www.w3.org/ns/ldp#BasicContainer': 1,
  'http://www.w3.org/ns/prov#SoftwareAgent': 1,
  'http://xmlns.com/foaf/0.1/Person': 1,
  'http://xmlns.com/foaf/0.1/PersonalProfileDocument': 1,
};

describe.skipIf(skipIfNoPod)('shape coverage over the reference patient pod', () => {
  let results: ReturnType<typeof validateFile>[];

  beforeAll(() => {
    const { store, shapeFiles } = loadShapes();
    results = findTurtleFiles(REFERENCE_POD).map((f) => validateFile(f, store, shapeFiles));
  });

  it('measures the pod at the recorded coverage', () => {
    const totalSubjects = results.reduce((n, r) => n + r.coverage.totalSubjects, 0);
    const checkedSubjects = results.reduce((n, r) => n + r.coverage.checkedSubjects, 0);

    expect(results).toHaveLength(COVERAGE.files);
    expect(totalSubjects).toBe(COVERAGE.totalSubjects);
    expect(checkedSubjects).toBe(COVERAGE.checkedSubjects);
    expect(totalSubjects - checkedSubjects).toBe(COVERAGE.unshapedSubjects);
  });

  it('measures the Cascade-typed population at the recorded coverage', () => {
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

    expect(cascadeTyped).toBe(COVERAGE.cascadeTypedSubjects);
    expect(unshapedCascadeTyped).toBe(COVERAGE.unshapedCascadeTypedSubjects);
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
    expect(actual).toEqual(COVERAGE_BY_FILE);
  });

  it('leaves no clinical record class unconstrained', () => {
    const counts = new Map<string, number>();
    for (const r of results) {
      for (const t of r.coverage.unshapedTypes) {
        counts.set(t.type, (counts.get(t.type) ?? 0) + t.count);
      }
    }
    // Each of these had every one of its subjects reported PASS with zero
    // constraints run. If one reappears here, a shape stopped firing.
    for (const type of FORMERLY_UNSHAPED_CLINICAL_CLASSES) {
      expect(counts.get(type), `${type} should now be shaped`).toBeUndefined();
    }
  });

  it('accounts for every type that remains unshaped', () => {
    const counts = new Map<string, number>();
    for (const r of results) {
      for (const t of r.coverage.unshapedTypes) {
        counts.set(t.type, (counts.get(t.type) ?? 0) + t.count);
      }
    }
    // Exact, not a subset: a newly unshaped type is a coverage regression and
    // must not be able to arrive quietly.
    expect(Object.fromEntries([...counts].sort())).toEqual(
      Object.fromEntries(Object.entries(REMAINING_UNSHAPED_TYPES).sort()),
    );
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
    // The behaviour under test: a file can declare Cascade prefixes and use
    // Cascade predicates while none of its subjects match any sh:targetClass.
    // Prefix-based reporting named a shape file for such a file and implied
    // constraints that never ran.
    //
    // This assertion has now been re-anchored twice: first from conditions.ttl,
    // then from insurance.ttl, because each got a shape and stopped exercising
    // it. Anchoring it to a Cascade-typed file is the mistake — shaping all of
    // them is the entire point of the vocabulary work, so any such file is a
    // temporary anchor. profile/card.ttl is typed only in foaf:, which no
    // Cascade release will ever shape, so it cannot move out from under this.
    const card = results.find((r) => r.file.endsWith('profile/card.ttl'));
    expect(card).toBeDefined();
    expect(card?.valid).toBe(true);
    expect(card?.coverage.totalSubjects).toBeGreaterThan(0);
    expect(card?.coverage.checkedSubjects).toBe(0);
    expect(card?.shapesUsed).toEqual([]);
  });

  it('now checks the insurance record, which was the last unshaped Cascade subject', () => {
    // Retyping it from the undefined clinical:CoverageRecord to the ratified
    // coverage:InsurancePlan took the pod's vacuously-validating Cascade-typed
    // population to zero. Asserted here so a regression in the reference pod
    // shows up as a failure rather than as a quietly smaller number.
    const insurance = results.find((r) => r.file.endsWith('clinical/insurance.ttl'));
    expect(insurance).toBeDefined();
    expect(insurance?.valid).toBe(true);
    expect(insurance?.coverage.totalSubjects).toBe(1);
    expect(insurance?.coverage.checkedSubjects).toBe(1);
    expect(insurance?.shapesUsed).toContain('coverage.shapes.ttl');
  });

  it('now fully checks the clinical record files that ran zero constraints', () => {
    // The other half of the assertion above: these four were the pod's real
    // clinical content and every one of them was passing vacuously.
    for (const rel of [
      'clinical/conditions.ttl',
      'clinical/allergies.ttl',
      'clinical/immunizations.ttl',
      'clinical/lab-results.ttl',
    ]) {
      const r = results.find((x) => x.file.endsWith(rel));
      expect(r, rel).toBeDefined();
      expect(r!.coverage.checkedSubjects, rel).toBe(r!.coverage.totalSubjects);
      expect(r!.coverage.checkedSubjects, rel).toBeGreaterThan(0);
      expect(r!.shapesUsed, rel).toContain('health.shapes.ttl');
      // Shaped AND clean: the records were correct all along, they were simply
      // never checked.
      expect(r!.results.filter((i) => i.severity === 'violation'), rel).toHaveLength(0);
    }
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
    // Was `0 of 5 subjects checked; 5 subjects of type health:ConditionRecord
    // had no applicable shape`.
    expect(out).toContain('5 of 5 subjects checked');
    expect(out).not.toContain('no applicable shape');
    expect(out).toContain('PASS');
  });

  it('does not print a Shapes: line when no shape fired', () => {
    // profile/card.ttl for the reason given above: it is typed only in foaf:,
    // so unlike a Cascade-typed file it cannot acquire a shape later and stop
    // exercising this.
    const out = plain(
      runCli(['--verbose', 'validate', resolve(REFERENCE_POD, 'profile/card.ttl')], '/'),
    );
    // Match the exact indented output line rather than the bare word, which
    // also occurs in the verbose "Loaded N shape files" preamble.
    expect(out).not.toMatch(/^ {5}Shapes: /m);
  });

  it('DOES print a Shapes: line when a shape fired', () => {
    // Without this, the assertion above would pass just as happily against a
    // build that never printed a Shapes: line at all.
    const out = plain(
      runCli(
        ['--verbose', 'validate', resolve(REFERENCE_POD, 'clinical/insurance.ttl')],
        '/',
      ),
    );
    expect(out).toMatch(/^ {5}Shapes: /m);
  });

  it('prints a pod-wide coverage summary', () => {
    const out = plain(runCli(['validate', REFERENCE_POD], '/'));
    expect(out).toContain(
      `Coverage: ${COVERAGE.checkedSubjects} of ${COVERAGE.totalSubjects} subjects checked, ${COVERAGE.unshapedSubjects} with no applicable shape`,
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
    expect(labsCoverage.checkedSubjects).toBe(11);
    expect(labsCoverage.totalSubjects).toBe(11);
    expect(medsCoverage.checkedSubjects).toBe(8);
    expect(medsCoverage.totalSubjects).toBe(8);
  });

  it('reports zero coverage distinctly from full coverage', () => {
    // The distinctness claim that matters: reporting must not collapse
    // "everything checked" and "nothing checked" into the same output.
    //
    // The unchecked side of this pair has been re-anchored twice already, from
    // conditions.ttl and then insurance.ttl, because each acquired a shape.
    // profile/card.ttl is typed only in foaf:, which no Cascade release will
    // shape, so it is a stable contrast rather than a temporary one.
    const card = plain(
      runCli(['--json', 'validate', resolve(REFERENCE_POD, 'profile/card.ttl')], '/'),
    );
    const labs = plain(
      runCli(['--json', 'validate', resolve(REFERENCE_POD, 'clinical/lab-results.ttl')], '/'),
    );

    const cardCoverage = JSON.parse(card)[0].coverage;
    const labsCoverage = JSON.parse(labs)[0].coverage;

    expect(cardCoverage.checkedSubjects).toBe(0);
    expect(cardCoverage.totalSubjects).toBeGreaterThan(0);
    expect(labsCoverage.checkedSubjects).toBe(11);
    expect(labsCoverage.checkedSubjects).toBe(labsCoverage.totalSubjects);
    expect(cardCoverage).not.toEqual(labsCoverage);
  });

  it('exposes coverage in the JSON output', () => {
    const out = runCli(
      ['--json', 'validate', resolve(REFERENCE_POD, 'clinical/allergies.ttl')],
      '/',
    );
    const parsed = JSON.parse(out);
    // Was `checkedSubjects: 0` with all three subjects listed under
    // `unshapedTypes` as health:AllergyRecord.
    expect(parsed[0].coverage).toEqual({
      totalSubjects: 3,
      checkedSubjects: 3,
      unshapedSubjects: [],
      unshapedTypes: [],
    });
    expect(parsed[0].shapesUsed).toContain('health.shapes.ttl');
  });
});
