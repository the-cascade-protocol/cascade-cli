/**
 * A conformant FHIR record converts and then VALIDATES.
 *
 * WHAT WENT WRONG
 * ---------------
 * Real-world Epic FHIR exports failed `cascade validate` at scale, and every
 * failure was a Cascade constraint narrower than the standard the data was
 * converted from. Nothing was wrong with the source resources, and nothing was
 * wrong with the converter: the shapes described a FHIR that does not exist.
 *
 *   - `interpretation` was constrained to five words invented in `spec`
 *     (normal / high / low / abnormal / critical). FHIR R4 binds
 *     `Observation.interpretation` to the HL7 v3 ObservationInterpretation code
 *     system, which also carries susceptibility (S/I/R), detection
 *     (POS/NEG/DET/ND/IND), reactivity (RR/WR/NR) and change (B/D/U/W)
 *     results. The converter maps what it recognizes and writes the
 *     data-absent-reason code `unknown` for everything else, which was not in
 *     the enum either — so the single most common value in a real export was
 *     also a Violation.
 *   - `labCategory` was `sh:maxCount 1` while `Observation.category` is 0..*.
 *   - `testCode`, `icd10Code` and `snomedCode` were `sh:maxCount 1` while
 *     `CodeableConcept.coding` is 0..*. Dual-coded problem lists are ordinary.
 *   - `cptCode` required five digits, which is CPT Category I only.
 *   - `coverageType` enforced a closed four-member enum at Violation severity
 *     on an element FHIR binds EXTENSIBLY, and `subscriberRelationship` held
 *     five of the seven codes in the value set it points at.
 *   - `clinical:Encounter` had NO SHAPE AT ALL. Encounters did not fail; they
 *     were never checked. `validate` reported PASS having evaluated zero
 *     constraints against them, which is the more dangerous failure of the two.
 *
 * WHAT THIS TEST IS
 * -----------------
 * One synthetic Epic-shaped bundle carrying every one of those cases at once,
 * converted through the real converter and validated against the real bundled
 * shapes. The assertion is the whole point: ZERO violations, and every subject
 * covered by a shape. It is an end-to-end lock, not a unit test of an enum,
 * because the defect was only ever visible end to end — each half looked
 * correct on its own.
 *
 * WHAT THESE DO IF THE FIX IS ABSENT — measured, not predicted, by restoring
 * `src/shapes/` to 522c6fc (health v2.5 / clinical v1.13 / coverage v1.3) and
 * running this file. 3 of the 6 fail:
 *   - `converts and validates with zero violations` FAILS with 7 violations:
 *     cptCode, coverageType, interpretation, testCode, labCategory, icd10Code,
 *     snomedCode.
 *   - `covers every converted subject with a shape` FAILS: 4 of 5 subjects
 *     checked, the Encounter unshaped.
 *   - `raises no warning on a conformant subscriber relationship` FAILS on
 *     `common`.
 *
 * And 3 pass against the broken build, deliberately:
 *   - `preserves every category and code the source sent` pins CONVERTER
 *     behaviour, which did not change here. It is what distinguishes "the
 *     shapes were widened" from "the converter started dropping the values that
 *     used to fail".
 *   - `writes an interpretation the shapes accept ...` likewise pins what the
 *     converter emits, not what the shapes accept.
 *   - `is looking at findings at all` is the non-vacuity control and must hold
 *     in both directions.
 *
 * A NOTE ON HOW THIS FILE NEARLY SHIPPED GREEN AND EMPTY
 * ------------------------------------------------------
 * `ValidationIssue.severity` is lowercase ('violation' | 'warning' | 'info').
 * The first draft filtered on 'Violation', matched nothing, and asserted [] ==
 * [] — so it passed against the very build it was written to catch. That is why
 * `is looking at findings at all` exists, and why the RED run above was
 * measured rather than assumed.
 *
 * EVERY VALUE BELOW IS SYNTHETIC. The names, identifiers, dates and results are
 * invented for this test.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Parser, Store } from 'n3';
import { convert } from '../src/lib/fhir-converter/index.js';
import { loadShapes, validateTurtle } from '../src/lib/shacl-validator.js';

const NS = {
  health: 'https://ns.cascadeprotocol.org/health/v1#',
  clinical: 'https://ns.cascadeprotocol.org/clinical/v1#',
  coverage: 'https://ns.cascadeprotocol.org/coverage/v1#',
};

/**
 * An Epic-shaped bundle. Every element here is one the exports actually carry:
 * an antimicrobial susceptibility result (whose interpretation code has no
 * member of the old enum, and whose Observation is categorised twice and coded
 * twice), a dual-coded oncology problem-list entry using ICD-10-CM categories
 * with a LETTER in the third character, a visit, an employer-sponsored policy
 * typed with a v3-ActCode code, and a Category III procedure.
 */
const SYNTHETIC_EPIC_BUNDLE = {
  resourceType: 'Bundle',
  id: 'bundle-standards-alignment-synthetic',
  type: 'collection',
  entry: [
    {
      resource: {
        resourceType: 'Observation',
        id: 'obs-synthetic-susceptibility-1',
        status: 'final',
        // Observation.category is 0..*, and real exports use all of it.
        category: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                code: 'laboratory',
                display: 'Laboratory',
              },
            ],
          },
          {
            coding: [
              {
                system: 'urn:oid:1.2.3.4.5.6.7.8.9',
                code: 'MICROBIOLOGY',
                display: 'Microbiology',
              },
            ],
            text: 'Antimicrobial Susceptibility',
          },
        ],
        // CodeableConcept.coding is 0..*: two LOINC codings for one test.
        code: {
          coding: [
            { system: 'http://loinc.org', code: '18864-9', display: 'Ampicillin [Susceptibility]' },
            { system: 'http://loinc.org', code: '18928-2', display: 'Ampicillin [Susceptibility] by Method' },
          ],
          text: 'Ampicillin susceptibility',
        },
        subject: { reference: 'Patient/pat-synthetic-1' },
        effectiveDateTime: '2031-04-17T08:15:00Z',
        valueQuantity: { value: 4, unit: 'ug/mL', system: 'http://unitsofmeasure.org', code: 'ug/mL' },
        // "I" (Intermediate) is a susceptibility interpretation. It is a
        // perfectly ordinary HL7 code and had no member of the old five.
        interpretation: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
                code: 'I',
                display: 'Intermediate',
              },
            ],
          },
        ],
        encounter: { reference: 'Encounter/enc-synthetic-1' },
      },
    },
    {
      resource: {
        resourceType: 'Condition',
        id: 'cond-synthetic-1',
        clinicalStatus: {
          coding: [
            { system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' },
          ],
        },
        // Two ICD-10-CM codings and two SNOMED CT codings on one problem.
        // C4A and M1A are live ICD-10-CM categories whose THIRD character is a
        // letter, which is what the ICD pattern elsewhere in the vocabulary
        // used to reject.
        code: {
          coding: [
            { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'C4A.51', display: 'Synthetic Merkel cell carcinoma site' },
            { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'M1A.0110', display: 'Synthetic chronic gout site' },
            { system: 'http://snomed.info/sct', code: '254837009', display: 'Synthetic neoplasm concept' },
            { system: 'http://snomed.info/sct', code: '363418001', display: 'Synthetic secondary concept' },
          ],
          text: 'Synthetic skin neoplasm',
        },
        subject: { reference: 'Patient/pat-synthetic-1' },
        onsetDateTime: '2030-11-02T00:00:00Z',
        encounter: { reference: 'Encounter/enc-synthetic-1' },
      },
    },
    {
      resource: {
        resourceType: 'Encounter',
        id: 'enc-synthetic-1',
        status: 'finished',
        class: {
          system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
          code: 'AMB',
          display: 'ambulatory',
        },
        type: [
          {
            coding: [
              { system: 'http://snomed.info/sct', code: '185349003', display: 'Encounter for check up' },
            ],
            text: 'Ambulatory visit',
          },
        ],
        subject: { reference: 'Patient/pat-synthetic-1' },
        period: { start: '2031-04-17T08:00:00Z', end: '2031-04-17T08:45:00Z' },
        participant: [{ individual: { display: 'Dr Wrenfield Ashcombe' } }],
        serviceProvider: { display: 'Northbrook Synthetic Clinic' },
      },
    },
    {
      resource: {
        resourceType: 'Coverage',
        id: 'cov-synthetic-1',
        status: 'active',
        // EHCPOL is from the value set FHIR binds Coverage.type to. The old
        // enum accepted only primary / secondary / dental / vision.
        type: {
          coding: [
            { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'EHCPOL', display: 'extended healthcare' },
          ],
          text: 'Extended healthcare',
        },
        subscriberId: 'SYN-000-1234',
        beneficiary: { reference: 'Patient/pat-synthetic-1' },
        // "common" is one of the two codes the old enum was missing.
        relationship: {
          coding: [
            { system: 'http://terminology.hl7.org/CodeSystem/subscriber-relationship', code: 'common', display: 'Common Law Spouse' },
          ],
        },
        payor: [{ display: 'Meadowlark Synthetic Health Plan' }],
        period: { start: '2031-01-01', end: '2031-12-31' },
      },
    },
    {
      resource: {
        resourceType: 'Procedure',
        id: 'proc-synthetic-1',
        status: 'completed',
        // A CPT Category III code: four digits and a T, five characters.
        code: {
          coding: [
            { system: 'http://www.ama-assn.org/go/cpt', code: '0042T', display: 'Synthetic category III procedure' },
          ],
          text: 'Synthetic category III procedure',
        },
        subject: { reference: 'Patient/pat-synthetic-1' },
        performedDateTime: '2031-04-17T09:00:00Z',
      },
    },
  ],
};

describe('a conformant Epic-shaped FHIR bundle converts and validates', () => {
  let turtle: string;
  let store: Store;
  let result: ReturnType<typeof validateTurtle>;

  beforeAll(async () => {
    const converted = await convert(JSON.stringify(SYNTHETIC_EPIC_BUNDLE), 'fhir', 'turtle');
    expect(converted.success, converted.errors.join('; ')).toBe(true);
    turtle = converted.output;

    store = new Store();
    for (const q of new Parser().parse(turtle)) store.addQuad(q);

    const shapes = loadShapes();
    result = validateTurtle(turtle, shapes.store, shapes.shapeFiles, 'synthetic-epic-bundle.ttl');
  });

  const objects = (predicate: string): string[] =>
    store
      .getQuads(null, predicate, null, null)
      .map((q) => q.object.value)
      .sort();

  it('converts and validates with zero violations', () => {
    // `severity` is lowercase in ValidationIssue. Filtering on 'Violation'
    // matches nothing and asserts [] against [], which is a test that passes
    // against a broken build; the control below is what proves it does not.
    const violations = result.results.filter((r) => r.severity === 'violation');
    // Named, so a failure says WHICH constraint regressed rather than a count.
    expect(violations.map((v) => `${v.property || '?'}: ${v.message}`)).toEqual([]);
  });

  it('is looking at findings at all — the filters above are not vacuous', () => {
    // The control for the trap named in the previous test. If the validator
    // ever stops populating `severity`, or renames its values, every
    // "expect([]).toEqual([])" above turns green while checking nothing. This
    // asserts that the severities present in a report are drawn from the set
    // the filters actually match.
    const seen = new Set(result.results.map((r) => r.severity));
    for (const s of seen) expect(['violation', 'warning', 'info']).toContain(s);
    // And that the validator really did run: shapes selected focus nodes here.
    expect(result.shapesUsed.length).toBeGreaterThan(0);
    expect(result.shapesUsed).toContain('health.shapes.ttl');
    expect(result.shapesUsed).toContain('clinical.shapes.ttl');
    expect(result.shapesUsed).toContain('coverage.shapes.ttl');
  });

  it('covers every converted subject with a shape', () => {
    // The Encounter is the reason this assertion exists: it used to be the one
    // subject no shape targeted, and an unchecked subject reports PASS.
    expect(result.coverage.unshapedSubjects.map((u) => u.types.join(','))).toEqual([]);
    expect(result.coverage.checkedSubjects).toBe(result.coverage.totalSubjects);
    expect(result.coverage.totalSubjects).toBe(5);
  });

  it('raises no warning on a conformant subscriber relationship', () => {
    const warnings = result.results.filter((r) => r.severity === 'warning');
    expect(warnings.map((w) => `${w.property || '?'}: ${w.message}`)).toEqual([]);
  });

  it('preserves every category and code the source sent', () => {
    // Pins CONVERTER behaviour. Widening a shape and dropping the values that
    // used to trip it produce the same green suite; this separates them.
    expect(objects(`${NS.health}labCategory`)).toEqual([
      'Antimicrobial Susceptibility',
      'MICROBIOLOGY',
    ]);
    expect(objects(`${NS.health}testCode`)).toHaveLength(2);
    expect(objects(`${NS.health}icd10Code`)).toEqual([
      'http://hl7.org/fhir/sid/icd-10-cm/C4A.51',
      'http://hl7.org/fhir/sid/icd-10-cm/M1A.0110',
    ]);
    expect(objects(`${NS.health}snomedCode`)).toHaveLength(2);
    expect(objects(`${NS.coverage}coverageType`)).toEqual(['EHCPOL']);
    expect(objects(`${NS.coverage}subscriberRelationship`)).toEqual(['common']);
    expect(objects(`${NS.clinical}cptCode`)).toEqual(['0042T']);
  });

  it('writes an interpretation the shapes accept for a code outside the old enum', () => {
    // The converter has no mapping for the susceptibility code "I" and writes
    // the data-absent-reason code `unknown`. That value is now IN the value
    // set, which is the specific thing that used to fail. This asserts the
    // value that is actually written rather than the one we wish were written;
    // widening the converter's own HL7 mapping is a separate change.
    expect(objects(`${NS.health}interpretation`)).toEqual(['unknown']);
  });
});
