/**
 * A C-CDA encounter must import with the time the document stated.
 *
 * WHAT WAS WRONG
 * --------------
 * `sections/encounters.ts` read `<effectiveTime>` only to build the record's
 * IDENTITY, and the single date triple it emitted was
 * `health:effectiveDate "2025-06-12"` — an untyped literal on a predicate the
 * Encounter shapes do not look at. `clinical:EncounterTemporalShape` asks for
 * `clinical:encounterStart`, `clinical:encounterEnd` or `clinical:encounterDate`
 * and the converter wrote none of them, so EVERY C-CDA encounter fired the
 * Warning-severity "should carry a start, an end or an encounter date" — on
 * documents whose Encounters section states the visit times perfectly well.
 * `<high>` was never read at all, in any path.
 *
 * WHAT IT DOES NOW
 * ----------------
 * The three shapes an Encounters section actually uses each get the triple that
 * says what they say, through `ccdaDateQuad` — the same typed-date chokepoint the
 * labs, problems, immunizations and vitals handlers use, so an encounter's
 * precision rule is the document's precision rule and not a fifth opinion:
 *
 *   <effectiveTime><low/><high/></effectiveTime>  -> encounterStart + encounterEnd
 *   <effectiveTime value="..."/>                  -> encounterDate
 *   <effectiveTime><low/></effectiveTime>         -> encounterStart only
 *   (no effectiveTime)                            -> nothing, and the Warning stands
 *
 * The last line is not an oversight. FHIR R4 `Encounter.period` is 0..1 and a
 * referenced-only visit legitimately has no time; inventing one to silence a
 * warning is the fabrication the whole date module exists to refuse.
 *
 * WHAT DELIBERATELY DID NOT CHANGE
 * --------------------------------
 * The identity input. `ccdaRecordUri` is still handed the same day string from
 * the same `effectiveTime` field in the same order, so no encounter re-mints and
 * no pod acquires a duplicate. The golden pins at the bottom are that claim,
 * measured against the converter BEFORE this change.
 *
 * `health:effectiveDate` is still written, unchanged, because the reconciler
 * reads it and a record's date must not move underneath a matcher in the same
 * commit that gives it a second one.
 *
 * Every fixture is synthetic and authored for this repository.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';
import type { Quad } from 'n3';
import { convertCcda } from '../src/lib/ccda-converter/index.js';
import { loadShapes, validateTurtle } from '../src/lib/shacl-validator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../test-fixtures');

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const CASCADE = 'https://ns.cascadeprotocol.org/core/v1#';
const HEALTH = 'https://ns.cascadeprotocol.org/health/v1#';
const CLINICAL = 'https://ns.cascadeprotocol.org/clinical/v1#';
const XSD_DATE = 'http://www.w3.org/2001/XMLSchema#date';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

const TEMPORAL_WARNING = 'start, an end or an encounter date';

async function convertFixture(name: string): Promise<Quad[]> {
  const xml = fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
  const result = await convertCcda(xml, {
    sourceSystem: 'TestSystem',
    importedAt: '2026-01-01T00:00:00Z',
  });
  expect(result.errors, `conversion errors: ${result.errors.join(', ')}`).toHaveLength(0);
  return new Parser().parse(result.output);
}

/** Every clinical:Encounter subject, keyed by the source id it carries. */
function encountersBySourceId(quads: Quad[]): Map<string, string> {
  const isEncounter = new Set(
    quads
      .filter((q) => q.predicate.value === RDF_TYPE && q.object.value === CLINICAL + 'Encounter')
      .map((q) => q.subject.value),
  );
  const bySourceId = new Map<string, string>();
  for (const q of quads) {
    if (q.predicate.value !== CASCADE + 'sourceRecordId') continue;
    if (!isEncounter.has(q.subject.value)) continue;
    bySourceId.set(q.object.value.split(':').pop() as string, q.subject.value);
  }
  return bySourceId;
}

/** One subject's object for a predicate, as {value, datatype}, or undefined. */
function typedObject(
  quads: Quad[],
  subject: string,
  predicate: string,
): { value: string; datatype: string } | undefined {
  const q = quads.find((x) => x.subject.value === subject && x.predicate.value === predicate);
  if (!q) return undefined;
  return {
    value: q.object.value,
    datatype: (q.object as { datatype?: { value: string } }).datatype?.value ?? '(not a literal)',
  };
}

describe('C-CDA Encounters section — the visit imports with its time', () => {
  it('states an interval as a typed encounterStart and encounterEnd', async () => {
    const quads = await convertFixture('ccda-encounter-dates.xml');
    const subject = encountersBySourceId(quads).get('ENC-INTERVAL');
    expect(subject, 'the interval encounter must be minted at all').toBeTruthy();

    expect(typedObject(quads, subject!, CLINICAL + 'encounterStart')).toEqual({
      value: '2025-06-12T09:30:00-04:00',
      datatype: XSD_DATETIME,
    });
    expect(typedObject(quads, subject!, CLINICAL + 'encounterEnd')).toEqual({
      value: '2025-06-12T10:15:00-04:00',
      datatype: XSD_DATETIME,
    });
    // A span is a span. Restating its start as a bare "date" as well would give
    // two answers to "when was this visit" that a consumer has to choose between.
    expect(typedObject(quads, subject!, CLINICAL + 'encounterDate')).toBeUndefined();
  });

  it('states a single effectiveTime as an encounterDate at the source precision', async () => {
    const quads = await convertFixture('ccda-encounter-dates.xml');
    const subject = encountersBySourceId(quads).get('ENC-SINGLE');
    expect(subject).toBeTruthy();

    expect(typedObject(quads, subject!, CLINICAL + 'encounterDate')).toEqual({
      value: '2025-07-18',
      datatype: XSD_DATE,
    });
    // No invented midnight, and no span the document never stated.
    expect(typedObject(quads, subject!, CLINICAL + 'encounterStart')).toBeUndefined();
    expect(typedObject(quads, subject!, CLINICAL + 'encounterEnd')).toBeUndefined();
  });

  it('states a low-only interval as a start with no invented end', async () => {
    const quads = await convertFixture('ccda-encounter-dates.xml');
    const subject = encountersBySourceId(quads).get('ENC-LOW-ONLY');
    expect(subject).toBeTruthy();

    expect(typedObject(quads, subject!, CLINICAL + 'encounterStart')).toEqual({
      value: '2025-09-03',
      datatype: XSD_DATE,
    });
    expect(typedObject(quads, subject!, CLINICAL + 'encounterEnd')).toBeUndefined();
    expect(typedObject(quads, subject!, CLINICAL + 'encounterDate')).toBeUndefined();
  });

  it('leaves an encounter the document never dated undated', async () => {
    const quads = await convertFixture('ccda-encounter-dates.xml');
    const subject = encountersBySourceId(quads).get('ENC-UNDATED');
    expect(subject).toBeTruthy();

    for (const p of ['encounterStart', 'encounterEnd', 'encounterDate']) {
      expect(typedObject(quads, subject!, CLINICAL + p), p).toBeUndefined();
    }
  });

  it('keeps writing health:effectiveDate, which the reconciler reads', async () => {
    // Pinned because the new triples are ADDITIVE. Dropping this one in the same
    // commit would move a date out from under a matcher that reads it, and the
    // suite would still be green on everything above.
    const quads = await convertFixture('ccda-encounter-dates.xml');
    const byId = encountersBySourceId(quads);
    expect(typedObject(quads, byId.get('ENC-INTERVAL')!, HEALTH + 'effectiveDate')?.value).toBe(
      '2025-06-12',
    );
    expect(typedObject(quads, byId.get('ENC-SINGLE')!, HEALTH + 'effectiveDate')?.value).toBe(
      '2025-07-18',
    );
  });

  it('dates the encounter nested inside a lab observation by the same rule', async () => {
    // sections/labs.ts reuses buildEncounterRecord for the <entryRelationship>
    // form real exports bury the visit in. One rule, both paths — asserted here
    // because a fix applied at the Encounters-section call site only would leave
    // this path exactly as broken and every test above green.
    const quads = await convertFixture('ccda-encounter-panel.xml');
    const subject = encountersBySourceId(quads).get('VISIT-778899');
    expect(subject).toBeTruthy();

    expect(typedObject(quads, subject!, CLINICAL + 'encounterStart')).toEqual({
      value: '2025-03-10T08:30:00-07:00',
      datatype: XSD_DATETIME,
    });
    expect(typedObject(quads, subject!, CLINICAL + 'encounterEnd')).toEqual({
      value: '2025-03-10T09:00:00-07:00',
      datatype: XSD_DATETIME,
    });
  });
});

describe('C-CDA Encounters section — SHACL', () => {
  it('collapses the temporal warning to the one encounter that has no time', async () => {
    const xml = fs.readFileSync(path.join(FIXTURES, 'ccda-encounter-dates.xml'), 'utf-8');
    const result = await convertCcda(xml, {
      sourceSystem: 'TestSystem',
      importedAt: '2026-01-01T00:00:00Z',
    });
    const { store, shapeFiles } = loadShapes();
    const validation = validateTurtle(result.output, store, shapeFiles, 'ccda-encounter-dates.xml');

    const temporal = validation.results.filter((r) => String(r.message).includes(TEMPORAL_WARNING));
    // 4 of 4 before this change; 1 of 4 after, and that one is the encounter the
    // document genuinely left undated.
    expect(
      temporal.length,
      temporal.map((r) => `  ${r.severity}: ${r.message}`).join('\n'),
    ).toBe(1);

    const violations = validation.results.filter((r) => r.severity === 'violation');
    expect(violations, violations.map((v) => `  ${v.property}: ${v.message}`).join('\n')).toHaveLength(0);
  });

  it('leaves the nested-encounter fixture with no temporal warning at all', async () => {
    const xml = fs.readFileSync(path.join(FIXTURES, 'ccda-encounter-panel.xml'), 'utf-8');
    const result = await convertCcda(xml, {
      sourceSystem: 'TestSystem',
      importedAt: '2026-01-01T00:00:00Z',
    });
    const { store, shapeFiles } = loadShapes();
    const validation = validateTurtle(result.output, store, shapeFiles, 'ccda-encounter-panel.xml');
    const temporal = validation.results.filter((r) => String(r.message).includes(TEMPORAL_WARNING));
    expect(temporal.map((r) => r.message)).toEqual([]);
  });
});

describe('golden pins: no encounter IRI moves when the dates start being stated', () => {
  /**
   * HOW THESE WERE OBTAINED, because a golden pin copied out of the run it
   * constrains proves nothing: they are the IRIs the C-CDA converter at
   * origin/main mints from these fixtures, read out of a build of origin/main
   * BEFORE any of this change existed.
   *
   * An encounter IRI that moves is a duplicate visit on every pod that already
   * holds it, and every clinical:hasEncounter edge pointing at the old one is
   * dangling. Nothing in the change above should be able to do that — the date
   * reaches `ccdaRecordUri` through the same field, formatted the same way — and
   * "should not be able to" is what a golden pin is for.
   */
  it('mints the pre-change IRIs for the Encounters-section fixture', async () => {
    const quads = await convertFixture('ccda-encounter-dates.xml');
    expect(Object.fromEntries(encountersBySourceId(quads))).toEqual({
      'ENC-INTERVAL': 'urn:uuid:dadac7e3-af72-562d-ba43-df13518d1857',
      'ENC-SINGLE': 'urn:uuid:dca04918-11ea-556c-a45a-840cbb9639f8',
      'ENC-LOW-ONLY': 'urn:uuid:46501fee-3168-5b55-9a4f-01109cf91529',
      'ENC-UNDATED': 'urn:uuid:30a1e368-177b-55f0-8467-09f82deddee0',
    });
  });

  it('mints the pre-change IRI for the nested-encounter fixture', async () => {
    const quads = await convertFixture('ccda-encounter-panel.xml');
    expect(encountersBySourceId(quads).get('VISIT-778899')).toBe(
      'urn:uuid:3ea1a023-9cf8-55e4-8f79-53fe664cece6',
    );
  });
});
