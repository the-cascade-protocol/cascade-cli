/**
 * A lab result's identity must be able to tell two lab results apart.
 *
 * THE DEFECT THESE PIN
 * --------------------
 * `convertObservationLab` minted its subject as
 * `contentHashedUri('Observation', { patient, loincCode, date }, resource.id)`.
 * Three things were wrong with that at once:
 *
 *   1. The MEASURED VALUE was not in the key. The whole point of a lab result.
 *   2. The timestamp was truncated to a calendar day by `.split('T')[0]`.
 *   3. `resource.id` was passed as `fallbackId`, which `contentHashedUri`
 *      consults ONLY when every content field is empty — which never happens on
 *      a real lab. So a perfectly good, distinct, server-assigned id was
 *      discarded on every single record.
 *
 * Measured against the published build: a fasting glucose of 95 (`id
 * "obs-fasting-95"`) and a post-prandial glucose of 310 (`id
 * "obs-postprandial-310"`), same patient, same LOINC, same morning, both minted
 * `urn:uuid:d2257c58-3d9f-5fe7-a34d-e48f97f6f27e`. The reconciler then passed
 * over the second as a re-import of the first, and WHICH of the two values
 * survived was decided by the order the input files happened to enumerate.
 *
 * Serial same-day labs are routine clinical practice — glucose curves, troponin
 * series, repeat potassium, pre- and post-dialysis — so this fired on ordinary
 * EHR output, not on hand-crafted input.
 *
 * WHAT THESE TESTS WOULD DO IF THE FIX WERE ABSENT
 * ------------------------------------------------
 * Almost every case below FAILS against the previous behavior; that is the
 * point, and it was verified rather than assumed. The handful that pass either
 * way are labelled STABILITY PIN in place, and each states what it is really
 * guarding (an IRI that must NOT move, or a guarantee from the identity-door
 * work that must not regress). Nothing here is counted as evidence for the fix
 * unless it fails without it.
 *
 * Every fixture is synthetic and PHI-free.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  convertObservationLab,
  convertObservationVital,
  convertMedicationStatement,
} from '../src/lib/fhir-converter/converters-clinical.js';

// ---------------------------------------------------------------------------
// Helpers and fixtures
// ---------------------------------------------------------------------------

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** The minted subject IRI: the first quad is the `rdf:type` triple on it. */
function subjectOf(result: { _quads: Array<{ subject: { value: string } }> }): string {
  expect(result._quads.length).toBeGreaterThan(0);
  return result._quads[0].subject.value;
}

const labUri = (r: any): string => subjectOf(convertObservationLab(clone(r)));

/**
 * A glucose result. The exact shape a FHIR server returns for a basic metabolic
 * panel member: LOINC-coded, `laboratory` category, quantity value, and a
 * server-assigned id.
 */
function glucose(overrides: Record<string, unknown> = {}): any {
  return {
    resourceType: 'Observation',
    status: 'final',
    category: [{
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }],
    }],
    code: { coding: [{ system: 'http://loinc.org', code: '2339-0', display: 'Glucose [Mass/volume] in Blood' }] },
    subject: { reference: 'Patient/synthetic-1' },
    effectiveDateTime: '2026-08-02T07:00:00Z',
    valueQuantity: { value: 95, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' },
    ...overrides,
  };
}

/** The same result with no server-assigned id — the FHIR-optional case. */
function idLessGlucose(overrides: Record<string, unknown> = {}): any {
  const r = glucose(overrides);
  delete r.id;
  return r;
}

// ---------------------------------------------------------------------------
// 1. The reported collision: two same-day results are two records
// ---------------------------------------------------------------------------

describe('two lab results that differ are two records', () => {
  it('the reported repro: fasting 95 and post-prandial 310, same patient, LOINC and day', () => {
    const fasting = glucose({
      id: 'obs-fasting-95',
      effectiveDateTime: '2026-08-02T07:00:00Z',
      valueQuantity: { value: 95, unit: 'mg/dL' },
    });
    const postPrandial = glucose({
      id: 'obs-postprandial-310',
      effectiveDateTime: '2026-08-02T11:00:00Z',
      valueQuantity: { value: 310, unit: 'mg/dL' },
    });

    // Previously BOTH were urn:uuid:d2257c58-3d9f-5fe7-a34d-e48f97f6f27e, and
    // the 310 was dropped as a duplicate of the 95.
    expect(labUri(fasting)).not.toBe(labUri(postPrandial));
  });

  it('a present id decides identity, so identical content does NOT merge', () => {
    // Two records the source deliberately kept apart. Nothing in their content
    // distinguishes them; the ids are the source telling us they are two draws.
    const a = glucose({ id: 'obs-draw-a' });
    const b = glucose({ id: 'obs-draw-b' });
    expect(labUri(a)).not.toBe(labUri(b));
  });

  it('the id path is deterministic AND discriminating, not merely deterministic', () => {
    // Determinism alone is satisfied by returning a constant, which is exactly
    // what the defect did. Both halves, or neither is evidence.
    const a = glucose({ id: 'obs-draw-a' });
    const b = glucose({ id: 'obs-draw-b', valueQuantity: { value: 310, unit: 'mg/dL' } });
    expect(labUri(a)).toBe(labUri(clone(a)));
    expect(labUri(b)).toBe(labUri(clone(b)));
    expect(labUri(a)).not.toBe(labUri(b));
  });

  it('re-importing the SAME id-bearing record stays one record', () => {
    // STABILITY PIN (passes without the fix too). The fix must not convert the
    // collision bug into its mirror image — a fresh IRI on every sync. Server
    // metadata churns between fetches and must not move the identity.
    const first = glucose({ id: 'obs-fasting-95' });
    const refetched = glucose({
      id: 'obs-fasting-95',
      meta: { lastUpdated: '2026-08-03T19:22:41.881+00:00', versionId: '4', source: 'urn:oid:1.2.3#z' },
    });
    expect(labUri(first)).toBe(labUri(refetched));
  });
});

// ---------------------------------------------------------------------------
// 2. The id-less path: the discriminating fields are in the key
// ---------------------------------------------------------------------------

describe('id-less lab results are separated by what actually differs', () => {
  it('the measured value is part of identity', () => {
    const normal = idLessGlucose({ valueQuantity: { value: 95, unit: 'mg/dL' } });
    const critical = idLessGlucose({ valueQuantity: { value: 310, unit: 'mg/dL' } });
    expect(labUri(normal)).not.toBe(labUri(critical));
  });

  it('the unit is part of identity — 5 mg/dL is not 5 mmol/L', () => {
    const mgdl = idLessGlucose({ valueQuantity: { value: 5, unit: 'mg/dL' } });
    const mmoll = idLessGlucose({ valueQuantity: { value: 5, unit: 'mmol/L' } });
    expect(labUri(mgdl)).not.toBe(labUri(mmoll));
  });

  it('the timestamp is identity at FULL precision, not truncated to a day', () => {
    // A glucose curve: same patient, same test, same value, four hours apart.
    // `.split('T')[0]` made these one record.
    const morning = idLessGlucose({ effectiveDateTime: '2026-08-02T07:00:00Z' });
    const midday = idLessGlucose({ effectiveDateTime: '2026-08-02T11:00:00Z' });
    expect(labUri(morning)).not.toBe(labUri(midday));
  });

  it('value forms this converter does not special-case still separate results', () => {
    // Collected by `value[x]` PREFIX rather than from a hand-written list, so a
    // form the converter has never met still splits instead of merging. If this
    // were a list, each miss would be a silent merge.
    const uris = [
      idLessGlucose({ valueQuantity: undefined, valueString: 'Reactive' }),
      idLessGlucose({ valueQuantity: undefined, valueString: 'Non-reactive' }),
      idLessGlucose({
        valueQuantity: undefined,
        valueCodeableConcept: { coding: [{ system: 'http://snomed.info/sct', code: '10828004', display: 'Positive' }] },
      }),
      idLessGlucose({
        valueQuantity: undefined,
        valueCodeableConcept: { coding: [{ system: 'http://snomed.info/sct', code: '260385009', display: 'Negative' }] },
      }),
      idLessGlucose({ valueQuantity: undefined, valueRatio: { numerator: { value: 1 }, denominator: { value: 40 } } }),
      idLessGlucose({ valueQuantity: undefined, valueRatio: { numerator: { value: 1 }, denominator: { value: 320 } } }),
      idLessGlucose({ valueQuantity: undefined, valueInteger: 3 }),
      idLessGlucose({ valueQuantity: undefined, valueInteger: 4 }),
    ].map(labUri);
    expect(new Set(uris).size, 'two results with different values shared an IRI').toBe(uris.length);
  });

  it('a panel-style Observation is separated by its components', () => {
    const survey = (answer: string) => idLessGlucose({
      valueQuantity: undefined,
      component: [{
        code: { coding: [{ system: 'http://loinc.org', code: '63586-2', display: 'Total income' }] },
        valueString: answer,
      }],
    });
    expect(labUri(survey('under 10000'))).not.toBe(labUri(survey('over 100000')));
  });

  it('the specimen is part of identity', () => {
    const blood = idLessGlucose({ specimen: { reference: 'Specimen/blood-1' } });
    const csf = idLessGlucose({ specimen: { reference: 'Specimen/csf-1' } });
    expect(labUri(blood)).not.toBe(labUri(csf));
  });

  it('the category is part of identity', () => {
    const lab = idLessGlucose();
    const survey = idLessGlucose({
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'survey' }] }],
    });
    expect(labUri(lab)).not.toBe(labUri(survey));
  });

  it('category ORDER does not move the IRI, so two servers agree', () => {
    // Category is a set. Sorting removes a source of spurious splits; it can
    // never cause a merge, because a differing set still sorts differently.
    const twoCats = (order: string[]) => idLessGlucose({
      category: order.map((code) => ({
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code }],
      })),
    });
    expect(labUri(twoCats(['laboratory', 'survey']))).toBe(labUri(twoCats(['survey', 'laboratory'])));
  });

  it('the same id-less record converted twice yields one IRI, and a different one two', () => {
    const r = idLessGlucose();
    const other = idLessGlucose({ valueQuantity: { value: 310, unit: 'mg/dL' } });
    expect(labUri(r)).toBe(labUri(clone(r)));
    expect(labUri(r)).not.toBe(labUri(other));
  });

  it('source key ORDER does not perturb an id-less lab IRI', () => {
    // STABILITY PIN. Guards the sorted-key serialization the identity door
    // relies on; two EHRs emitting the same record must agree.
    const forward = idLessGlucose();
    const reversed: any = {};
    for (const k of Object.keys(forward).reverse()) reversed[k] = forward[k];
    expect(labUri(reversed)).toBe(labUri(forward));
  });

  it('server metadata does not move an id-less lab IRI', () => {
    // STABILITY PIN. `meta.lastUpdated`/`versionId`/`source` churn on every
    // re-fetch; hashing them would mint a fresh IRI on every sync.
    const base = idLessGlucose();
    const refetched = idLessGlucose({
      meta: { lastUpdated: '2026-08-03T19:22:41.881+00:00', versionId: '4', source: 'urn:oid:1.2.3#z' },
    });
    expect(labUri(base)).toBe(labUri(refetched));
  });

  it('the display name alone does not split a result — the LOINC code decides', () => {
    // STABILITY PIN, and the reason `testName` is NOT an identity field: the
    // converter defaults it to the literal 'Unknown Lab Test'. A placeholder in
    // an identity key turns "we do not know" into "these are the same record".
    const short = idLessGlucose();
    const verbose = idLessGlucose({
      code: { coding: [{ system: 'http://loinc.org', code: '2339-0', display: 'GLUCOSE, BLOOD' }] },
    });
    expect(labUri(short)).toBe(labUri(verbose));
  });

  it('a content-free Observation still collapses LOUDLY (identity-door tier 4 intact)', () => {
    // STABILITY PIN for the identity-door guarantee: a record with no id, no
    // structured content and no narrative merges, but never silently.
    const r = convertObservationLab({ resourceType: 'Observation' });
    const collapse = r.warnings.filter((w) => w.includes('no identifier and no identity-bearing content'));
    expect(collapse.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. The two real-world corpus shapes
// ---------------------------------------------------------------------------

/**
 * Measured on a real imported pod of 1,150 subjects, 659 of them lab results
 * across 30 draw days: 144 same-(LOINC, day) groups, every one a pair, every
 * pair cross-source with a byte-identical timestamp, and 3 of the 144
 * DISAGREEING on value.
 *
 * The corpus is undamaged today only because cross-source records carry
 * different `subject.reference` values and `patient` is in the key. Any
 * normalization that unifies patient references across sources — which
 * reconciliation naturally wants, and which that corpus's own remediation plan
 * calls for — would have made all 144 pairs collide at import, merging them
 * silently at the wrong layer, with no conflict record and no review. The 3
 * that disagree on value are the case where that loses a real measurement.
 */
describe('the shapes measured on a real 659-lab corpus survive', () => {
  const CROSS_SOURCE_TIMESTAMP = '2011-05-14T14:32:00Z';

  function crossSourcePair(normalizePatient: boolean, values: [number, number]) {
    const mk = (i: 0 | 1) => glucose({
      id: i === 0 ? 'epic-obs-88213' : 'cerner-obs-4471',
      subject: { reference: normalizePatient ? 'Patient/unified-1' : `Patient/source-${i}` },
      effectiveDateTime: CROSS_SOURCE_TIMESTAMP,
      valueQuantity: { value: values[i], unit: 'mg/dL' },
    });
    return [labUri(mk(0)), labUri(mk(1))] as const;
  }

  it('cross-source pairs stay distinct — and stay distinct after patient normalization', () => {
    // As they arrive today: distinct because `patient` differs.
    const [a1, b1] = crossSourcePair(false, [95, 95]);
    expect(a1).not.toBe(b1);

    // After the remediation that unifies patient references across sources.
    // This is the half that the previous behavior failed: LOINC, calendar day
    // and patient all now agree, so the two records collapsed onto one IRI.
    const [a2, b2] = crossSourcePair(true, [95, 95]);
    expect(a2, 'patient normalization silently merged a cross-source pair').not.toBe(b2);
  });

  it('the 3-of-144 pairs that DISAGREE on value stay two records', () => {
    // Same source-normalized patient, same LOINC, byte-identical timestamp,
    // different measurements. This is the human-review case, and under the
    // previous key it became an invisible merge — the disagreement that is the
    // whole reason a person is asked simply disappeared.
    const [a, b] = crossSourcePair(true, [95, 310]);
    expect(a).not.toBe(b);
  });

  it('same-source repeat draws on one day stay distinct', () => {
    // The serial-lab shape: a troponin series, three draws, one day, one source.
    const uris = ['2026-08-02T06:00:00Z', '2026-08-02T09:00:00Z', '2026-08-02T12:00:00Z'].map((t, i) =>
      labUri(glucose({
        id: `epic-trop-${i}`,
        code: { coding: [{ system: 'http://loinc.org', code: '6598-7', display: 'Troponin T' }] },
        effectiveDateTime: t,
        valueQuantity: { value: [0.01, 0.42, 1.9][i], unit: 'ng/mL' },
      })),
    );
    expect(new Set(uris).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Vitals must not move
// ---------------------------------------------------------------------------

/**
 * STABILITY PINS, all of them. `convertObservationVital` mints via
 * `mintSubjectUri`, which honours the FHIR id, and that is precisely why the
 * real corpus's 318 same-source same-(LOINC, day) vital pairs survived as
 * distinct records while the lab pairs did not. This change must not disturb
 * that, and must not "helpfully" content-hash vitals on the way past.
 */
describe('vital signs keep their existing identity', () => {
  function heartRate(overrides: Record<string, unknown> = {}): any {
    return {
      resourceType: 'Observation',
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] },
      subject: { reference: 'Patient/synthetic-1' },
      effectiveDateTime: '2026-01-15T09:30:00Z',
      valueQuantity: { value: 72, unit: 'beats/minute' },
      ...overrides,
    };
  }
  const vitalUri = (r: any) => subjectOf(convertObservationVital(clone(r)));

  it('an id-bearing vital mints exactly the IRI it always has', () => {
    // Golden value, computed before this change. A drift here means an existing
    // pod's vitals moved.
    expect(vitalUri(heartRate({ id: 'obs-hr-1' })))
      .toBe('urn:uuid:4075fcee-43dd-5011-b531-1946a2c41849');
  });

  it('a vital whose value changes keeps its IRI, because the id decides', () => {
    const base = heartRate({ id: 'obs-hr-1' });
    const changed = heartRate({ id: 'obs-hr-1', valueQuantity: { value: 118, unit: 'beats/minute' } });
    expect(vitalUri(base)).toBe(vitalUri(changed));
  });

  it('the 318-pair shape: same-source same-day repeat vitals stay distinct', () => {
    const uris = ['13:25', '14:00', '15:00'].map((hhmm, i) =>
      vitalUri(heartRate({
        id: `epic-hr-${i}`,
        effectiveDateTime: `2026-01-15T${hhmm}:00Z`,
        valueQuantity: { value: [88, 76, 72][i], unit: 'beats/minute' },
      })),
    );
    expect(new Set(uris).size).toBe(3);
  });

  it('both Observation converters now agree on one id-bearing resource', () => {
    // The two Observation converters in this file used OPPOSITE identity
    // strategies: the vital one honoured the FHIR id, the lab one discarded it
    // for a {patient, LOINC, calendar day} hash. So the same resource minted two
    // different IRIs depending on which converter saw it, and which one that is
    // depends on `VITAL_TYPE_TO_SHACL` — a routing table that can change.
    //
    // Deliberately NOT written as `vitalUri(x) === labUri(x)` on a resource the
    // vital converter REROUTES to the lab converter: that comparison is
    // tautological, since both sides end up calling the same function, and it
    // passes with or without this change.
    const hr = heartRate({ id: 'obs-hr-1' });
    expect(vitalUri(hr)).toBe(labUri(hr));
  });
});

// ---------------------------------------------------------------------------
// 5. The placeholder-default class
// ---------------------------------------------------------------------------

/**
 * A placeholder default that reaches an identity key converts "we do not know"
 * into "these are the same record", which is the merge failure mode. It is
 * invisible to the identity door's four-tier cascade, because the constant
 * arrives pre-baked from the converter: the content tier "succeeds" with a
 * value identical for every content-free record of that type, so the tier-4
 * collapse warning can never fire.
 *
 * The class-wide guard lives in `identity-determinism.test.ts`, which now
 * requires EVERY FHIR converter — `convertMedicationStatement` included — to
 * report the collapse for a bare resource. These cases pin the specific
 * medication instance and, just as importantly, pin that fixing it did not move
 * the IRI of a medication that actually names a drug.
 */
describe('placeholder defaults do not reach an identity key', () => {
  it('two content-free MedicationStatements are two records, and say so', () => {
    const bare = convertMedicationStatement({ resourceType: 'MedicationStatement' });
    const withNote = convertMedicationStatement({
      resourceType: 'MedicationStatement',
      note: [{ text: 'a different medication entirely' }],
    });
    // Previously both minted urn:uuid:6fdb46b2-be25-52f9-80b8-2a356c4c3a87.
    expect(subjectOf(bare)).not.toBe(subjectOf(withNote));
    // And the genuinely empty one now reaches the tier-4 collapse notice, which
    // the placeholder constant had made structurally unreachable.
    expect(bare.warnings.filter((w) => w.includes('no identifier and no identity-bearing content')).length).toBe(1);
    expect(withNote.warnings.filter((w) => w.includes('no identifier and no identity-bearing content'))).toEqual([]);
  });

  it('a medication that names a drug keeps the IRI it already had', () => {
    // STABILITY PIN, and the reason this half is NOT an IRI-breaking change:
    // when the source names a drug, the identity input is unchanged. Golden
    // value measured against the previous build.
    const lisinopril = {
      resourceType: 'MedicationStatement',
      subject: { reference: 'Patient/synthetic-1' },
      medicationCodeableConcept: {
        text: 'Lisinopril 10 MG',
        coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '314076' }],
      },
      effectivePeriod: { start: '2024-01-01' },
    };
    expect(subjectOf(convertMedicationStatement(clone(lisinopril))))
      .toBe('urn:uuid:c133ddb5-e7c3-5251-b4c7-17ffc20d735c');
  });

  it('a medication named only by medicationReference.display also keeps its IRI', () => {
    // STABILITY PIN. The second real source of a drug name must keep feeding
    // identity; only the placeholder was removed.
    const byReference = {
      resourceType: 'MedicationStatement',
      subject: { reference: 'Patient/synthetic-1' },
      medicationReference: { reference: 'Medication/m1', display: 'Lisinopril 10 MG' },
      effectivePeriod: { start: '2024-01-01' },
    };
    const byConcept = {
      resourceType: 'MedicationStatement',
      subject: { reference: 'Patient/synthetic-1' },
      medicationCodeableConcept: { text: 'Lisinopril 10 MG' },
      effectivePeriod: { start: '2024-01-01' },
    };
    expect(subjectOf(convertMedicationStatement(clone(byReference))))
      .toBe(subjectOf(convertMedicationStatement(clone(byConcept))));
  });

  it('the placeholder is still what the record DISPLAYS', () => {
    // STABILITY PIN. Removing the constant from identity must not remove it
    // from the output — a nameless medication still reads as one.
    const bare = convertMedicationStatement({ resourceType: 'MedicationStatement' });
    const names = bare._quads
      .filter((q: any) => q.predicate.value.endsWith('drugName'))
      .map((q: any) => q.object.value);
    expect(names).toEqual(['Unknown Medication']);
  });
});

// ---------------------------------------------------------------------------
// 6. Across processes and across working directories
// ---------------------------------------------------------------------------

/**
 * Minting twice inside one process shares a warm module cache, one
 * `process.cwd()`, and any memoization a converter holds, so a defect keyed on
 * any of those is invisible to it. That is not hypothetical in this repo: the
 * previous identity defect in this family was path-dependent and stayed green
 * for months because everything ran from one directory.
 *
 * So this spawns SEPARATE node processes from DIFFERENT working directories and
 * compares across them, through `dist/` — the artifact an npm consumer installs.
 *
 * The skip guard keys on a module present in EVERY revision of this repo, not
 * on anything this change introduces. A guard that keys on a new file SKIPS
 * instead of FAILING when run against a pre-fix build, which is exactly how a
 * determinism suite looks green while proving nothing.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(REPO, 'dist');
const HAVE_DIST = fs.existsSync(path.join(DIST, 'lib', 'fhir-converter', 'converters-clinical.js'));

const SCRIPT = `
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
const dist = process.env.CASCADE_DIST;
const { convertObservationLab } = await import(
  pathToFileURL(path.join(dist, 'lib/fhir-converter/converters-clinical.js')).href
);
const payload = JSON.parse(process.env.CASCADE_PAYLOAD);
const out = { cwd: process.cwd(), uris: payload.map((r) => convertObservationLab(r)._quads[0].subject.value) };
process.stdout.write(JSON.stringify(out));
`;

function mintIn(dir: string, resources: any[]): { cwd: string; uris: string[] } {
  const scriptPath = path.join(dir, 'mint.mjs');
  fs.writeFileSync(scriptPath, SCRIPT, 'utf8');
  const stdout = execFileSync(process.execPath, [scriptPath], {
    cwd: dir,
    env: { ...process.env, CASCADE_DIST: DIST, CASCADE_PAYLOAD: JSON.stringify(resources) },
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

describe.skipIf(!HAVE_DIST)('lab identity survives the process and the working directory', () => {
  it('two processes in two directories agree, and still tell the two results apart', () => {
    const resources = [
      glucose({ id: 'obs-fasting-95', effectiveDateTime: '2026-08-02T07:00:00Z', valueQuantity: { value: 95, unit: 'mg/dL' } }),
      glucose({ id: 'obs-postprandial-310', effectiveDateTime: '2026-08-02T11:00:00Z', valueQuantity: { value: 310, unit: 'mg/dL' } }),
      idLessGlucose({ valueQuantity: { value: 95, unit: 'mg/dL' } }),
      idLessGlucose({ valueQuantity: { value: 310, unit: 'mg/dL' } }),
    ];

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-lab-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-lab-b-'));
    try {
      const a = mintIn(dirA, clone(resources));
      const b = mintIn(dirB, clone(resources));

      expect(a.cwd).not.toBe(b.cwd);
      // DETERMINISM: two processes, two directories, one answer.
      expect(a.uris, `cwd ${a.cwd} disagreed with cwd ${b.cwd}`).toEqual(b.uris);
      // DISTINCTNESS: and the answer is not a constant. Without this half a
      // function returning one string would pass the line above perfectly.
      expect(new Set(a.uris).size, `four different results shared an IRI: ${a.uris.join(' ')}`).toBe(4);
      for (const uri of a.uris) expect(uri).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });
});
