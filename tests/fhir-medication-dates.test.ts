/**
 * A prescription that states only when it was written must not import undated.
 *
 * WHAT WAS WRONG
 * --------------
 * `convertMedicationStatement` already knew `authoredOn` is a medication's date:
 * it feeds the subject IRI, as `authoredOn ?? effectivePeriod.start`. But the
 * date TRIPLE was emitted only from `effectivePeriod.start` / `effectiveDateTime`,
 * so a MedicationRequest carrying `authoredOn` and nothing else — the ordinary
 * shape of a prescription order — reached the pod with no date predicate at all.
 * Undated in every consumer, invisible to anything that places records in time,
 * and keyed on a date the record itself did not state.
 *
 * WHAT IT DOES NOW
 * ----------------
 * `authoredOn` becomes `health:startDate` when the resource states no effective
 * date, through `tripleDateTime` — the same helper the two branches above it use,
 * so the new triple is typed and precision-handled exactly like its siblings
 * rather than by a fourth rule.
 *
 * THE ORDER IS DELIBERATELY NOT THE IDENTITY ORDER
 * ------------------------------------------------
 * Identity reads `authoredOn` FIRST; the triple reads it LAST. That is not an
 * oversight to be tidied up:
 *
 *   - The identity key wants the most stable value across re-exports, and the
 *     date a prescription was written never moves. Changing that order would
 *     re-mint every medication in every existing pod.
 *   - The triple wants what the record MEANS by "started". When a resource
 *     states an effective period, the period is when the patient took the drug;
 *     `authoredOn` is when a clinician typed it. Preferring the order date over
 *     a stated effective period would be a downgrade.
 *
 * So the two orders differ, on purpose, and the golden pins below are the proof
 * that adding the triple moved no key.
 *
 * Every fixture is synthetic and authored for this repository.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';
import type { Quad } from 'n3';
import { convert } from '../src/lib/fhir-converter/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../test-fixtures');
const BUNDLE = path.join(FIXTURES, 'fhir-medication-dates-bundle.json');

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const HEALTH = 'https://ns.cascadeprotocol.org/health/v1#';
const CLINICAL = 'https://ns.cascadeprotocol.org/clinical/v1#';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

async function convertBundle(): Promise<Quad[]> {
  const input = fs.readFileSync(BUNDLE, 'utf-8');
  const result = await convert(input, 'fhir', 'cascade', 'turtle', 'medication-dates');
  return new Parser().parse(result.output);
}

/** Medication subject IRI, keyed by the drug name the record displays. */
function medicationsByDrug(quads: Quad[]): Map<string, string> {
  const isMed = new Set(
    quads
      .filter((q) => q.predicate.value === RDF_TYPE && q.object.value === CLINICAL + 'Medication')
      .map((q) => q.subject.value),
  );
  const byDrug = new Map<string, string>();
  for (const q of quads) {
    if (q.predicate.value !== CLINICAL + 'drugName') continue;
    if (!isMed.has(q.subject.value)) continue;
    byDrug.set(q.object.value, q.subject.value);
  }
  return byDrug;
}

function objectsOf(quads: Quad[], subject: string, predicate: string): { value: string; datatype: string }[] {
  return quads
    .filter((q) => q.subject.value === subject && q.predicate.value === predicate)
    .map((q) => ({
      value: q.object.value,
      datatype: (q.object as { datatype?: { value: string } }).datatype?.value ?? '(not a literal)',
    }));
}

describe('FHIR medications — authoredOn is a date the record states', () => {
  it('gives a MedicationRequest with only authoredOn a startDate', async () => {
    const quads = await convertBundle();
    const subject = medicationsByDrug(quads).get('Levothyroxine 50 mcg');
    expect(subject, 'the order must be minted at all').toBeTruthy();

    expect(objectsOf(quads, subject!, HEALTH + 'startDate')).toEqual([
      { value: '2025-04-09T00:00:00Z', datatype: XSD_DATETIME },
    ]);
  });

  it('gives an id-less MedicationRequest with only authoredOn a startDate too', async () => {
    // The id-less case matters separately: without a resource.id the record's
    // identity is built from its own content, so this is the resource where a
    // careless fix is most likely to disturb the key.
    const quads = await convertBundle();
    const subject = medicationsByDrug(quads).get('Omeprazole 20 mg');
    expect(subject).toBeTruthy();

    expect(objectsOf(quads, subject!, HEALTH + 'startDate')).toEqual([
      { value: '2025-05-21T08:15:00-05:00', datatype: XSD_DATETIME },
    ]);
  });

  it('prefers a stated effective period over the order date, and states it once', async () => {
    // Sertraline carries BOTH. The period is when the patient takes the drug;
    // authoredOn is when a clinician typed it. A record that emitted both would
    // give two answers to "when did this start", and the maxCount on the shape
    // would not be the thing that noticed.
    const quads = await convertBundle();
    const subject = medicationsByDrug(quads).get('Sertraline 50 mg');
    expect(subject).toBeTruthy();

    expect(objectsOf(quads, subject!, HEALTH + 'startDate')).toEqual([
      { value: '2025-06-04T00:00:00Z', datatype: XSD_DATETIME },
    ]);
    expect(objectsOf(quads, subject!, HEALTH + 'endDate')).toEqual([
      { value: '2025-09-04T00:00:00Z', datatype: XSD_DATETIME },
    ]);
  });

  it('leaves a medication that states no date of any kind undated', async () => {
    const quads = await convertBundle();
    const subject = medicationsByDrug(quads).get('Cetirizine 10 mg');
    expect(subject).toBeTruthy();
    expect(objectsOf(quads, subject!, HEALTH + 'startDate')).toEqual([]);
    expect(objectsOf(quads, subject!, HEALTH + 'endDate')).toEqual([]);
  });

  it('does not disturb the two paths that already worked', async () => {
    const quads = await convertBundle();
    const byDrug = medicationsByDrug(quads);
    expect(objectsOf(quads, byDrug.get('Metformin 500 mg')!, HEALTH + 'startDate')).toEqual([
      { value: '2025-02-14T00:00:00Z', datatype: XSD_DATETIME },
    ]);
    expect(objectsOf(quads, byDrug.get('Atorvastatin 10 mg')!, HEALTH + 'startDate')).toEqual([
      { value: '2025-01-07T00:00:00Z', datatype: XSD_DATETIME },
    ]);
  });

  it('leaves every medication in the fixture carrying at most one startDate', async () => {
    // The whole-bundle form of the assertion above. A second `quads.push` added
    // beside the first rather than in the `else if` chain passes every named
    // case and fails here.
    const quads = await convertBundle();
    for (const [drug, subject] of medicationsByDrug(quads)) {
      expect(objectsOf(quads, subject, HEALTH + 'startDate').length, drug).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * THE NEGATIVE CLAIM, and the one that had to be proved before this could ship:
 * emitting the date moved NO record identity.
 *
 * A medication IRI that moves is a duplicate on every pod that already holds the
 * record, invisible until someone counts. `medicationUri` is not reached by the
 * change — the emission sits well below it and reads the same resource fields —
 * but "is not reached by" is exactly what a golden pin exists to check, because
 * a test that compares two computed values passes just as happily when both have
 * moved.
 *
 * HOW THESE VALUES WERE OBTAINED: they are the IRIs the FHIR converter at
 * origin/main mints from this bundle, read out of a detached checkout of
 * origin/main BEFORE the emission existed. Three of the six resources below —
 * Levothyroxine, Omeprazole, Cetirizine — carried no date triple at all in that
 * run, which is the defect; their keys are pinned here unchanged.
 */
describe('golden pins: no medication IRI moves when authoredOn starts being stated', () => {
  it('mints the pre-change IRIs for every medication in the bundle', async () => {
    const quads = await convertBundle();
    expect(Object.fromEntries(medicationsByDrug(quads))).toEqual({
      // MedicationRequest, authoredOn only, WITH a resource.id.
      'Levothyroxine 50 mcg': 'urn:uuid:99cc4be1-40ee-514f-9669-2de4f49c4528',
      // MedicationRequest, authoredOn only, NO resource.id: keyed on content.
      'Omeprazole 20 mg': 'urn:uuid:71ea3165-09bf-5227-8de7-17ca551371de',
      // Both dates present: the key takes authoredOn, the triple takes the period.
      'Sertraline 50 mg': 'urn:uuid:1c468983-157c-55bb-a289-010bb27f5bb8',
      'Metformin 500 mg': 'urn:uuid:e0f84d35-cc98-5b6c-a544-9bf86d44314b',
      'Atorvastatin 10 mg': 'urn:uuid:2cbb94df-3291-535e-9114-7013d91b89c6',
      // No date at all: the identity door falls through to content.
      'Cetirizine 10 mg': 'urn:uuid:5c628737-cd13-5230-b9ef-b360cfbede0f',
    });
  });
});
