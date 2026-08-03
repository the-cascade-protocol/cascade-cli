/**
 * The C-CDA sections, exercised through the shape a real import produces.
 *
 * THE TRAP THIS TEST EXISTS TO AVOID
 * ----------------------------------
 * A test that hands a section handler a raw parse passes today and proves
 * nothing. The whole defect was that a document's shape changed AFTER parsing,
 * at the vendor-normalization step, and the post-normalization shape was the one
 * shape nothing exercised. Three instances of that shipped.
 *
 * So every case here goes through `convertCcda`, i.e. through `detectVendor` and
 * `applyVendorNormalization`, on a document whose custodian makes it a
 * recognized vendor. That is the path a real portal export takes.
 *
 * WHAT THESE WOULD DO IF THE FIX WERE ABSENT — measured against 0f33c78:
 *   Vital signs        8 records  ->  0
 *   Lab results        8 records  ->  0   (6 results + 2 panels)
 *   Family history     2 records  ->  0
 *   Implanted device   1 record   ->  0
 *   Procedure          name/date/code present -> all three absent
 *   Problem status     "Resolved" -> "active" (the default, on every document)
 * and the import reported success with no warning for any of it.
 *
 * Every fixture is synthetic, authored from the C-CDA R2.1 specification.
 */

import { describe, it, expect } from 'vitest';
import { convertCcda } from '../src/lib/ccda-converter/index.js';
import { parseCcdaXml } from '../src/lib/ccda-converter/parser.js';
import { detectVendor } from '../src/lib/ccda-converter/vendor/detect.js';
import { SYNTHETIC_EPIC_CCDA, SYNTHETIC_UNKNOWN_VENDOR_CCDA } from './ccda-synthetic-documents.js';

const IMPORTED_AT = '2026-01-02T03:04:05.000Z';

async function convert(xml: string) {
  return convertCcda(xml, { sourceSystem: 'test', importedAt: IMPORTED_AT });
}

/** Subjects carrying `rdf:type <type>` in the Turtle output. */
function subjectsOfType(turtle: string, compactType: string): string[] {
  const out = new Set<string>();
  // Turtle from n3's Writer states types as `<subj> a <type>` or in a predicate list.
  const re = new RegExp(`<(urn:uuid:[0-9a-f-]+)>[^.]*?\\ba\\b[^.]*?${compactType}\\b`, 'gs');
  for (const m of turtle.matchAll(re)) out.add(m[1]);
  return [...out].sort();
}

function countOccurrences(turtle: string, needle: string): number {
  return turtle.split(needle).length - 1;
}

describe('the synthetic document really does take the vendor path', () => {
  it('detectVendor classifies it as epic, so normalization runs', () => {
    // Without this the rest of the file would be testing the unknown-vendor path
    // and would have passed before the fix, which is exactly the trap.
    expect(detectVendor(parseCcdaXml(SYNTHETIC_EPIC_CCDA))).toBe('epic');
    expect(detectVendor(parseCcdaXml(SYNTHETIC_UNKNOWN_VENDOR_CCDA))).toBe('unknown');
  });
});

describe('every structured section imports its records on a vendor-detected document', () => {
  it('vital signs: one organizer of 8 readings produces 8 VitalSign records', async () => {
    const r = await convert(SYNTHETIC_EPIC_CCDA);
    expect(r.success).toBe(true);
    // 8 readings, all with LOINCs inside the VitalSignShape enum.
    expect(countOccurrences(r.output, 'clinical:VitalSign')).toBe(8);
    expect(r.output).toContain('"72"');   // heart rate
    expect(r.output).toContain('"118"');  // systolic
    expect(r.output).toContain('"36.8"'); // temperature
  });

  it('labs: two BATTERY panels produce 6 results and 2 LaboratoryReports', async () => {
    const r = await convert(SYNTHETIC_EPIC_CCDA);
    expect(countOccurrences(r.output, 'health:LabResultRecord')).toBe(6);
    expect(countOccurrences(r.output, 'clinical:LaboratoryReport')).toBe(2);
    expect(r.output).toContain('"140"'); // sodium
    expect(r.output).toContain('"180"'); // cholesterol
  });

  it('family history: two relatives produce two FamilyHistoryRecords, kept apart', async () => {
    const r = await convert(SYNTHETIC_EPIC_CCDA);
    expect(countOccurrences(r.output, 'health:FamilyHistoryRecord')).toBe(2);
    expect(r.output).toContain('Type 2 diabetes mellitus');
    expect(r.output).toContain('Myocardial infarction');
    // Two relatives, two subjects — not one record overwriting the other.
    expect(subjectsOfType(r.output, 'health:FamilyHistoryRecord')).toHaveLength(2);
  });

  it('implanted devices: the device inside a <supply> produces one ImplantedDevice', async () => {
    const r = await convert(SYNTHETIC_EPIC_CCDA);
    expect(countOccurrences(r.output, 'clinical:ImplantedDevice')).toBe(1);
    expect(r.output).toContain('Cardiac pacemaker');
    expect(r.output).toContain('2025-06-01');
  });

  it('procedures: the record carries its name, date and code, not just a type', async () => {
    const r = await convert(SYNTHETIC_EPIC_CCDA);
    expect(countOccurrences(r.output, 'clinical:Procedure')).toBe(1);
    // Each of these came back empty while <procedure> was read as an object, and
    // the record was still written — an empty record reported as a success.
    expect(r.output).toContain('Appendectomy');
    expect(r.output).toContain('2019-04-12');
    expect(r.output).toContain('80146002');
  });

  it('problems: the status the source STATED is used, not the "active" default', async () => {
    const r = await convert(SYNTHETIC_EPIC_CCDA);
    expect(countOccurrences(r.output, 'health:ConditionRecord')).toBeGreaterThanOrEqual(1);
    expect(r.output).toContain('Acute bronchitis');
    // Asserted on the PREDICATE, not on the word appearing anywhere: the
    // section's narrative also contains "resolved", so a substring check would
    // have passed against the broken build. Measured against 0f33c78 this is
    // `health:status "active"` — the default — because the status observation
    // sat behind an <entryRelationship> array that could not be read, on every
    // document from every vendor.
    expect(r.output).toMatch(/health:status\s+"resolved"/);
    expect(r.output).not.toMatch(/health:status\s+"active"/);
  });
});

describe('entries in versus records out is reported per section', () => {
  it('every structured section is counted, including the ones that yield nothing', async () => {
    const r = await convert(SYNTHETIC_EPIC_CCDA);
    const census = Object.fromEntries(
      (r.sectionCensus ?? []).map((s) => [s.label, { in: s.entriesIn, out: s.recordsOut }]),
    );

    // Asserted as exact pairs, not as "some records exist": the defect produced
    // a perfectly plausible-looking summary precisely because nothing compared
    // the two numbers.
    expect(census['Vital Signs']).toEqual({ in: 1, out: 8 });
    // 6 member results + 2 BATTERY panel records + the 1 encounter the panels
    // were collected in, which this section also mints.
    expect(census['Results']).toEqual({ in: 2, out: 9 });
    expect(census['Family History']).toEqual({ in: 2, out: 2 });
    expect(census['Medical Equipment']).toEqual({ in: 1, out: 1 });
    expect(census['Procedures']).toEqual({ in: 1, out: 1 });
    expect(census['Problems']).toEqual({ in: 1, out: 1 });
    // The one section that still yields nothing, counted rather than omitted.
    expect(census['Allergies']).toEqual({ in: 1, out: 0 });
  });

  it('a section that reads entries and writes no records says so', async () => {
    const r = await convert(SYNTHETIC_EPIC_CCDA);
    const zeroYield = r.warnings.filter((w) => w.includes('imported 0 records'));
    expect(zeroYield, 'the empty section must be named').toHaveLength(1);
    expect(zeroYield[0]).toContain('Allergies');
    expect(zeroYield[0]).toContain('read 1 structured entry');
  });

  it('a section that yields records raises no such warning', async () => {
    // Otherwise the warning is noise and gets ignored, which is how the real
    // signal would be lost a second time.
    const r = await convert(SYNTHETIC_EPIC_CCDA);
    for (const label of ['Vital Signs', 'Results', 'Family History', 'Procedures']) {
      expect(r.warnings.filter((w) => w.includes(label) && w.includes('imported 0 records'))).toEqual([]);
    }
  });

  it('the allergy whose allergen is narrative-only is reported, not dropped in silence', async () => {
    const r = await convert(SYNTHETIC_EPIC_CCDA);
    const named = r.warnings.filter((w) => w.includes('names no allergen'));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('SYNTH-ALLERGY-ACT-001');
    expect(named[0]).toContain('NOT imported');
  });
});

describe('the vendor is no longer a variable', () => {
  it('the same document imports identically whether or not its custodian is recognized', async () => {
    // This is the property the fix actually establishes. Before it, these two
    // documents — identical but for the custodian NAME — imported different
    // record sets, and the difference was three whole sections.
    const epic = await convert(SYNTHETIC_EPIC_CCDA);
    const unknown = await convert(SYNTHETIC_UNKNOWN_VENDOR_CCDA);

    const records = (turtle: string) =>
      [...new Set(turtle.match(/urn:uuid:[0-9a-f-]{36}/g) ?? [])].sort();

    // The custodian name is a real difference in the data (it is the record's
    // EHR of origin), so the TURTLE differs; the record SET must not.
    expect(records(epic.output)).toEqual(records(unknown.output));
    expect(epic.sectionCensus).toEqual(unknown.sectionCensus);
  });

  it('the record counts are equal section by section across the two vendors', async () => {
    const epic = await convert(SYNTHETIC_EPIC_CCDA);
    const unknown = await convert(SYNTHETIC_UNKNOWN_VENDOR_CCDA);
    for (const type of [
      'clinical:VitalSign',
      'health:LabResultRecord',
      'clinical:LaboratoryReport',
      'health:FamilyHistoryRecord',
      'clinical:ImplantedDevice',
      'clinical:Procedure',
      'health:ConditionRecord',
    ]) {
      expect(
        countOccurrences(unknown.output, type),
        `${type} count must not depend on the custodian`,
      ).toBe(countOccurrences(epic.output, type));
    }
  });
});

describe('re-import and determinism', () => {
  it('converting the same document twice mints the same IRIs', async () => {
    const a = await convert(SYNTHETIC_EPIC_CCDA);
    const b = await convert(SYNTHETIC_EPIC_CCDA);
    const iris = (t: string) => [...new Set(t.match(/urn:uuid:[0-9a-f-]{36}/g) ?? [])].sort();
    expect(iris(b.output)).toEqual(iris(a.output));
    expect(iris(a.output).length).toBeGreaterThan(15);
  });

  it('a different importedAt does not move any IRI', async () => {
    // importedAt is not content. A record whose identity moved with it would
    // duplicate on every re-import.
    const a = await convertCcda(SYNTHETIC_EPIC_CCDA, { sourceSystem: 'test', importedAt: IMPORTED_AT });
    const b = await convertCcda(SYNTHETIC_EPIC_CCDA, { sourceSystem: 'test', importedAt: '2027-09-09T09:09:09.000Z' });
    const iris = (t: string) => [...new Set(t.match(/urn:uuid:[0-9a-f-]{36}/g) ?? [])].sort();
    expect(iris(b.output)).toEqual(iris(a.output));
  });

  it('records the source kept apart stay apart', async () => {
    const r = await convert(SYNTHETIC_EPIC_CCDA);
    const all = r.output.match(/urn:uuid:[0-9a-f-]{36}/g) ?? [];
    const distinct = new Set(all);
    // 8 vitals + 6 labs + 2 panels + 2 family history + 1 device + 1 procedure
    // + 1 problem + 1 patient + 1 encounter = 23 records, plus narrative
    // document nodes. A collapse would show up as a shortfall here.
    expect(distinct.size).toBeGreaterThanOrEqual(23);
  });
});
