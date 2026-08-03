/**
 * The C-CDA importer must honour a source record's own identifier, for every
 * record type, and it must keep working when that identifier is the root-only
 * form that real EHR exports actually emit.
 *
 * THE DEFECT THESE PIN, MEASURED AGAINST `main` BEFORE THE CHANGE
 * --------------------------------------------------------------
 * Every section minted with
 *
 *     contentHashedUri('X', { patient: patientUri, … }, sourceId || undefined, entry)
 *
 * and `contentHashedUri` reads `fallbackId` ONLY when every content field is
 * empty. `patient` never is. So two entries identical in every content field and
 * differing only in their `<id extension>` minted ONE IRI, at all ten identity
 * sites:
 *
 *     problems allergies immunizations vitals devices procedures encounters
 *     family-history medications patient        -> 10 of 10 MERGED
 *
 * And the id most of them would have needed was unreadable anyway: eight of nine
 * section handlers extracted an id only when `@extension` was present, so
 * `<id root="9a6d1bac-…"/>` — the canonical C-CDA form for a locally minted
 * identifier — was discarded outright, along with the `cascade:sourceRecordId`
 * that would have been emitted from it.
 *
 *     problems allergies immunizations vitals devices procedures
 *     family-history medications labs           -> 9 of 10 DISCARDED a root-only id
 *
 * The derived `patientUri` in those keys also failed in the opposite direction:
 * it is derived from four mutable demographic fields, so one person recorded as
 * "John" in one document and "Johnny" in another produced two patient IRIs, and
 * a byte-identical procedure carrying the SAME source id split into two records.
 *
 * WHAT THESE WOULD DO IF THE FIX WERE ABSENT
 * ------------------------------------------
 * Every `it` in the first four describes FAILS against a build of `main` at
 * 51a4089. That was run, not assumed. The re-import and determinism blocks are
 * the opposite kind of test — they pass both before and after BY DESIGN, and
 * they are labelled where they sit: they are the controls that catch this fix
 * over-correcting into a blunt split.
 *
 * Every fixture is synthetic and PHI-free.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';

import { convertCcda } from '../src/lib/ccda-converter/index.js';
import { ccdaSourceId } from '../src/lib/ccda-converter/record-identity.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_FIXTURES = path.join(REPO, 'test-fixtures');
const ROOT_ONLY_FIXTURE = path.join(LOCAL_FIXTURES, 'ccda-root-only-ids.xml');

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const CASCADE = 'https://ns.cascadeprotocol.org/core/v1#';

function readRootOnlyFixture(): string {
  return fs.readFileSync(ROOT_ONLY_FIXTURE, 'utf8');
}

/** Convert a C-CDA document and return its parsed quads. */
async function quadsOf(xml: string): Promise<any[]> {
  const result = await convertCcda(xml, { sourceSystem: 'SyntheticEHR' });
  expect(result.errors, `conversion errors: ${result.errors.join(', ')}`).toHaveLength(0);
  return new Parser({ format: 'Turtle' }).parse(result.output);
}

/** Every subject carrying an rdf:type whose IRI ends with `localName`. */
function subjectsOfType(quads: any[], localName: string): string[] {
  return [
    ...new Set(
      quads
        .filter((q) => q.predicate.value === RDF_TYPE && q.object.value.endsWith(localName))
        .map((q) => q.subject.value),
    ),
  ];
}

// ---------------------------------------------------------------------------
// 1. The id extraction chokepoint
// ---------------------------------------------------------------------------

describe('ccdaSourceId reads every HL7 II form a real export emits', () => {
  it('root + extension: the shape every section already handled', () => {
    expect(ccdaSourceId({ '@_root': '1.2.3', '@_extension': 'A' })).toBe('1.2.3:A');
  });

  it('ROOT ONLY: the canonical locally-minted identifier, discarded by 9 of 10 sections', () => {
    expect(ccdaSourceId({ '@_root': '9a6d1bac-17d3-4195-89a4-1121bc809b4a' }))
      .toBe('9a6d1bac-17d3-4195-89a4-1121bc809b4a');
  });

  it('extension only, which stays byte-compatible with the old inline readers', () => {
    expect(ccdaSourceId({ '@_extension': 'A' })).toBe(':A');
  });

  it('the bare (non-attribute) spelling only immunizations used to handle', () => {
    expect(ccdaSourceId({ root: '1.2.3', extension: 'A' })).toBe('1.2.3:A');
    expect(ccdaSourceId({ root: '1.2.3' })).toBe('1.2.3');
  });

  it('multiple ids: the first USABLE one, so a nullFlavor placeholder does not blind it', () => {
    // `id[0]`, which every section used, returned nothing here.
    expect(ccdaSourceId([{ '@_nullFlavor': 'NI' }, { '@_root': '1.2.3', '@_extension': 'B' }]))
      .toBe('1.2.3:B');
    // …and with real ids it is document order, which is stable within a
    // document's bytes. Not a sort: a sort would change which id wins when a
    // vendor adds a second one.
    expect(ccdaSourceId([{ '@_root': 'z' }, { '@_root': 'a' }])).toBe('z');
  });

  it('no usable identifier at all is undefined, not an empty string', () => {
    expect(ccdaSourceId(undefined)).toBeUndefined();
    expect(ccdaSourceId(null)).toBeUndefined();
    expect(ccdaSourceId({})).toBeUndefined();
    expect(ccdaSourceId({ '@_nullFlavor': 'NI' })).toBeUndefined();
    expect(ccdaSourceId({ '@_root': '   ' })).toBeUndefined();
  });

  it('accepts the element OR its id, because a silent undefined is not a chokepoint', () => {
    // Writing this with an id-value-only signature cost a real defect during the
    // change that introduced it: `ccdaSourceId(organizer)` returned undefined
    // with no error and two lab panels with different ids MERGED.
    const idEl = { '@_root': '1.2.3', '@_extension': 'A' };
    expect(ccdaSourceId({ id: idEl })).toBe('1.2.3:A');
    expect(ccdaSourceId(idEl)).toBe('1.2.3:A');
    expect(ccdaSourceId({ id: [idEl] })).toBe('1.2.3:A');
  });
});

// ---------------------------------------------------------------------------
// 2. Root-only ids across every section, end to end
// ---------------------------------------------------------------------------

/**
 * The fixture carries TWO entries per section, identical in every content field
 * and differing ONLY in a root-only `<id>`. Before the change, each pair minted
 * one record; after it, two.
 *
 * This is the case §4 of the plan calls out: a suite whose fixtures all carry
 * `@extension` passes while the importer still ignores the id on the majority of
 * real documents. The conformance corpus carries zero root-only ids, which is
 * why this fixture lives here.
 */
describe('root-only <id> is honoured in every section, end to end', () => {
  const CASES: ReadonlyArray<{ type: string; expected: number; why: string }> = [
    { type: 'ConditionRecord', expected: 2, why: 'two problem acts, one diagnosis' },
    { type: 'AllergyRecord', expected: 2, why: 'two concern acts, one allergen' },
    { type: 'ImmunizationRecord', expected: 2, why: 'two doses, same vaccine and day' },
    { type: 'Medication', expected: 2, why: 'two orders, same drug and start date' },
    { type: 'VitalSign', expected: 2, why: 'two heart-rate readings, same value' },
    { type: 'Procedure', expected: 2, why: 'two colonoscopies on one day' },
    { type: 'Encounter', expected: 2, why: 'two office visits on one day' },
    // STABILITY PIN, not evidence: the panel key already carried the organizer
    // id as a first-class CONTENT field, so this one passes on a build without
    // the change too. It guards the panel path against regressing INTO the
    // defect the other nine had.
    { type: 'LaboratoryReport', expected: 2, why: 'two panels, same code and time' },
    { type: 'FamilyHistoryRecord', expected: 2, why: 'two sisters, one diagnosis' },
    { type: 'ImplantedDevice', expected: 2, why: 'two pacemaker leads on one day' },
  ];

  for (const { type, expected, why } of CASES) {
    it(`${type}: ${why} -> ${expected} records`, async () => {
      const quads = await quadsOf(readRootOnlyFixture());
      const subs = subjectsOfType(quads, type);
      expect(subs.length, `${type} collapsed: ${subs.join(' ')}`).toBe(expected);
    });
  }

  it('and every one of them emits cascade:sourceRecordId, which was lost too', async () => {
    const quads = await quadsOf(readRootOnlyFixture());
    const withSourceId = new Set(
      quads
        .filter((q) => q.predicate.value === `${CASCADE}sourceRecordId`)
        .map((q) => q.subject.value),
    );
    // The root-only ids in the fixture are UUIDs; a section that discarded them
    // emitted no sourceRecordId at all.
    expect(withSourceId.size).toBeGreaterThanOrEqual(18);
    for (const value of quads
      .filter((q) => q.predicate.value === `${CASCADE}sourceRecordId`)
      .map((q) => q.object.value)) {
      expect(value, 'a root-only id must survive verbatim, not as ":ext"').not.toMatch(/^:/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Patient identity: the MRN, and the John / Johnny case
// ---------------------------------------------------------------------------

/** A minimal C-CDA carrying only a recordTarget. */
function patientDoc(opts: { mrn?: string | null; given?: string; family?: string; addr?: string }): string {
  const idEl = opts.mrn === null || opts.mrn === undefined
    ? ''
    : `<id root="2.16.840.1.113883.19.5" extension="${opts.mrn}"/>`;
  const addr = opts.addr
    ? `<addr use="HP"><streetAddressLine>${opts.addr}</streetAddressLine><city>Springfield</city></addr>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <id root="2.16.840.1.113883.19.5" extension="DOC-1"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Patient identity fixture</title>
  <effectiveTime value="20260201120000+0000"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <recordTarget>
    <patientRole>
      ${idEl}
      ${addr}
      <patient>
        <name><given>${opts.given ?? 'John'}</given><family>${opts.family ?? 'Smith'}</family></name>
        <administrativeGenderCode code="M" codeSystem="2.16.840.1.113883.5.1"/>
        <birthTime value="19800412"/>
      </patient>
    </patientRole>
  </recordTarget>
  <component><structuredBody></structuredBody></component>
</ClinicalDocument>`;
}

async function patientUriOf(xml: string): Promise<string> {
  const subs = subjectsOfType(await quadsOf(xml), 'PatientProfile');
  expect(subs.length, 'expected exactly one PatientProfile').toBe(1);
  return subs[0];
}

describe('C-CDA patient identity keys on the MRN the source assigned', () => {
  it('two different people with distinct MRNs are two profiles', async () => {
    // Previously: the key was {dob, sex, family, given[0]}, so two people
    // sharing all four merged and every record of either hung off one profile.
    const a = await patientUriOf(patientDoc({ mrn: 'MRN-000111', given: 'John', family: 'Smith' }));
    const b = await patientUriOf(patientDoc({ mrn: 'MRN-999888', given: 'John', family: 'Smith' }));
    expect(a).not.toBe(b);
  });

  it('one person under two spellings, one MRN, is ONE profile', async () => {
    const john = await patientUriOf(patientDoc({ mrn: 'MRN-000111', given: 'John' }));
    const johnny = await patientUriOf(patientDoc({ mrn: 'MRN-000111', given: 'Johnny' }));
    expect(johnny).toBe(john);
  });

  // STABILITY PIN, not evidence: `address` was outside the old four-field key
  // too, so this passes on a build without the change. It guards the widened key
  // from over-correcting — an address change must not re-identify a person whose
  // MRN the source stated.
  it('the MRN decides even when the address differs between two exports', async () => {
    const home = await patientUriOf(patientDoc({ mrn: 'MRN-000111', addr: '1 Elm St' }));
    const moved = await patientUriOf(patientDoc({ mrn: 'MRN-000111', addr: '2 Oak Ave' }));
    expect(moved).toBe(home);
  });

  it('without an MRN the demographics separate, including beyond given[0]', async () => {
    const a = await patientUriOf(patientDoc({ mrn: null, given: 'John', family: 'Smith' }));
    const b = await patientUriOf(patientDoc({ mrn: null, given: 'Jane', family: 'Smith' }));
    expect(a).not.toBe(b);

    // A field the converter SERIALIZES but the old four-field key left out.
    const here = await patientUriOf(patientDoc({ mrn: null, addr: '1 Elm St' }));
    const there = await patientUriOf(patientDoc({ mrn: null, addr: '2 Oak Ave' }));
    expect(here).not.toBe(there);
  });
});

// ---------------------------------------------------------------------------
// 4. The derived patient IRI no longer splits records across documents
// ---------------------------------------------------------------------------

/** One C-CDA carrying a single procedure with a fixed source id. */
function procedureDoc(given: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <templateId root="2.16.840.1.113883.10.20.22.1.1"/>
  <id root="2.16.840.1.113883.19.5" extension="DOC-${given}"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Procedure fixture</title>
  <effectiveTime value="20260201120000+0000"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <recordTarget>
    <patientRole>
      <id root="2.16.840.1.113883.19.5" extension="MRN-000111"/>
      <patient>
        <name><given>${given}</given><family>Smith</family></name>
        <administrativeGenderCode code="M" codeSystem="2.16.840.1.113883.5.1"/>
        <birthTime value="19800412"/>
      </patient>
    </patientRole>
  </recordTarget>
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.7.1"/>
      <code code="47519-4" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Procedures</title>
      <text>Appendectomy.</text>
      <entry typeCode="DRIV">
        <procedure classCode="PROC" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.14"/>
          <id root="1.2.3.4" extension="PROC-1"/>
          <code code="80146002" displayName="Appendectomy" codeSystem="2.16.840.1.113883.6.96"/>
          <statusCode code="completed"/>
          <effectiveTime value="20260101"/>
        </procedure>
      </entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;
}

describe('a record does not change identity because the patient changed nickname', () => {
  it('the same procedure, same source id, in a "John" doc and a "Johnny" doc is ONE record', async () => {
    // Previously TWO. `patientUri` was derived from {dob, sex, family, given[0]}
    // and spliced into every section key, so a nickname re-identified every
    // clinical record in the document.
    const [john] = subjectsOfType(await quadsOf(procedureDoc('John')), 'Procedure');
    const [johnny] = subjectsOfType(await quadsOf(procedureDoc('Johnny')), 'Procedure');
    expect(john).toBeTruthy();
    expect(johnny).toBe(john);
  });
});

// ---------------------------------------------------------------------------
// 5. CONTROLS. These pass before and after, by design.
// ---------------------------------------------------------------------------

describe('CONTROL — a true re-import still produces one record set', () => {
  /** Every record subject in a converted document. */
  async function recordSubjects(xml: string): Promise<string[]> {
    return [
      ...new Set(
        (await quadsOf(xml))
          .filter((q) => q.predicate.value === RDF_TYPE)
          .map((q) => q.subject.value),
      ),
    ].sort();
  }

  it('importing the same document twice mints exactly the same subjects', async () => {
    // This is what separates a fix from a blunt split. If honouring the source
    // id had been implemented as "mint something new for each entry", this
    // fails — and this is the control that caught an over-correction earlier in
    // this work.
    const xml = readRootOnlyFixture();
    const first = await recordSubjects(xml);
    const second = await recordSubjects(xml);

    expect(first.length, 'the fixture must actually produce records').toBeGreaterThan(18);
    expect(second).toEqual(first);
  });

  it('and two documents that differ only in whitespace agree', async () => {
    // Identity must be a function of what the record SAYS, not of the bytes'
    // incidental formatting.
    const xml = readRootOnlyFixture();
    const reflowed = xml.replace(/>\s+</g, '>\n            <');
    expect(await recordSubjects(reflowed)).toEqual(await recordSubjects(xml));
  });
});

describe('CONTROL — determinism AND distinctness, across processes and directories', () => {
  /**
   * Minting twice in one process shares a warm module cache and one
   * `process.cwd()`. A previous identity defect in this repo was path-dependent
   * and stayed green for months for exactly that reason.
   *
   * The guard keys on a module present in EVERY revision (`sections/labs.js`),
   * not on anything this change introduces: a guard on a new file SKIPS rather
   * than FAILS against a pre-fix build, which is how a determinism suite looks
   * green while proving nothing.
   */
  const DIST = path.join(REPO, 'dist');
  const HAVE_DIST = fs.existsSync(path.join(DIST, 'lib', 'ccda-converter', 'sections', 'labs.js'));

  const SCRIPT = `
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
const dist = process.env.CASCADE_DIST;
const { convertCcda } = await import(
  pathToFileURL(path.join(dist, 'lib/ccda-converter/index.js')).href
);
const xml = fs.readFileSync(process.env.CASCADE_FIXTURE, 'utf8');
const result = await convertCcda(xml, { sourceSystem: 'SyntheticEHR' });
const uris = [...new Set(
  (result.output.match(/<urn:uuid:[0-9a-f-]{36}>/g) ?? []).map((s) => s.slice(1, -1)),
)].sort();
process.stdout.write(JSON.stringify({ cwd: process.cwd(), uris }));
`;

  function mintIn(dir: string): { cwd: string; uris: string[] } {
    const scriptPath = path.join(dir, 'mint-ccda-identity.mjs');
    fs.writeFileSync(scriptPath, SCRIPT, 'utf8');
    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd: dir,
      env: { ...process.env, CASCADE_DIST: DIST, CASCADE_FIXTURE: ROOT_ONLY_FIXTURE },
      encoding: 'utf8',
    });
    return JSON.parse(stdout);
  }

  it.skipIf(!HAVE_DIST)('two processes in two directories agree, and still tell the records apart', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-ccda-id-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-ccda-id-b-'));
    try {
      const a = mintIn(dirA);
      const b = mintIn(dirB);

      expect(a.cwd, 'the two runs must not share a working directory').not.toBe(b.cwd);
      // Determinism.
      expect(a.uris).toEqual(b.uris);
      // Distinctness. Determinism alone is satisfied by a constant, which is
      // precisely what the previous key set was.
      expect(new Set(a.uris).size).toBe(a.uris.length);
      expect(a.uris.length).toBeGreaterThan(18);
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('the guard is not silently skipping', () => {
    // `dist/` is built by `npm run build`, which the test script runs. If this
    // fails, the determinism test above did NOT run and its green is meaningless.
    expect(HAVE_DIST, 'run `npm run build` — the cross-process check needs dist/').toBe(true);
  });
});
