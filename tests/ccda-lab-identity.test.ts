/**
 * The C-CDA importer must tell two lab results apart, exactly as the FHIR one must.
 *
 * THE DEFECT THESE PIN
 * --------------------
 * `extractObservationQuads` minted a `health:LabResultRecord` as
 * `contentHashedUri('LabResult', { patient, loincCode, testName, date }, sourceId)`.
 * The same three things were wrong with it as with the FHIR importer's version,
 * in the same function:
 *
 *   1. The MEASURED VALUE was extracted a few lines above the mint (`value`,
 *      `unit`), emitted as quads, and never entered the key.
 *   2. `date` was `formatCcdaDate()`, truncated from the HL7
 *      `YYYYMMDDHHMMSS±ZZZZ` to a calendar day.
 *   3. The observation's own `<id root= extension=>` was passed as `fallbackId`,
 *      which `contentHashedUri` consults only when EVERY content field is empty
 *      — never true here, because `patient` is always populated.
 *
 * Measured against the previous build: a fasting glucose of 95 and a
 * post-prandial glucose of 310, same patient, same LOINC, same day, with
 * DISTINCT source ids, both minted
 * `urn:uuid:dc68ecd7-acc0-5d61-981a-e51a3dbc0b0c` — and so did the id-less
 * versions of both. Four genuinely different results, one identity.
 *
 * That is the path a downloaded portal export (MyChart and friends) actually
 * takes, so it is not a lesser case than the FHIR one.
 *
 * WHAT THESE WOULD DO IF THE FIX WERE ABSENT
 * ------------------------------------------
 * Most of them FAIL against the previous behavior, which was verified rather
 * than assumed. The ones that pass either way are labelled STABILITY PIN in
 * place and say what they actually guard — an IRI that must NOT move, or an
 * invariant the change could plausibly have broken. None is counted as evidence
 * for the fix.
 *
 * Every fixture is synthetic and PHI-free.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractLabQuads } from '../src/lib/ccda-converter/sections/labs.js';

// ---------------------------------------------------------------------------
// Helpers and fixtures — the shapes fast-xml-parser produces from real C-CDA
// ---------------------------------------------------------------------------

const SOURCE = 'SyntheticEHR';
const IMPORTED_AT = '2026-08-03T00:00:00Z';

const LOINC_OID = '2.16.840.1.113883.6.1';

/** One `<observation>` inside a results section. */
function labObs(opts: {
  id?: string;
  value?: string;
  unit?: string;
  /** Raw HL7 `effectiveTime/@value`, full precision. */
  time?: string;
  code?: string;
  name?: string;
}): any {
  const o: any = {
    code: {
      '@_code': opts.code ?? '2339-0',
      '@_codeSystem': LOINC_OID,
      '@_displayName': opts.name ?? 'Glucose',
    },
    effectiveTime: { '@_value': opts.time ?? '20260802070000-0500' },
    value: { '@_value': opts.value ?? '95', '@_unit': opts.unit ?? 'mg/dL' },
  };
  if (opts.id !== undefined) o.id = { '@_root': '1.2.840.114350', '@_extension': opts.id };
  return o;
}

/** A BATTERY `<organizer>` wrapping member observations. */
function panel(opts: { id?: string; code?: string; time?: string; members: any[] }): any {
  const org: any = {
    '@_classCode': 'BATTERY',
    component: opts.members.map((observation) => ({ observation })),
  };
  if (opts.id !== undefined) org.id = { '@_root': '1.2.840.114350', '@_extension': opts.id };
  if (opts.code !== undefined) {
    org.code = { '@_code': opts.code, '@_codeSystem': LOINC_OID, '@_displayName': 'Basic metabolic panel' };
  }
  if (opts.time !== undefined) org.effectiveTime = { '@_value': opts.time };
  return { organizer: org };
}

function convert(entries: any[]): any[] {
  return extractLabQuads(entries, SOURCE, undefined, IMPORTED_AT);
}

/** Every subject carrying an `rdf:type` of the given local name, in emission order. */
function subjectsOfType(quads: any[], localName: string): string[] {
  return quads
    .filter((q) => q.predicate.value.endsWith('#type') && q.object.value.endsWith(localName))
    .map((q) => q.subject.value);
}

/** The single `health:LabResultRecord` subject minted for one observation. */
function resultUri(obs: any): string {
  const subs = subjectsOfType(convert([{ observation: obs }]), 'LabResultRecord');
  expect(subs.length, 'expected exactly one lab result record').toBe(1);
  return subs[0];
}

/** The single `clinical:LaboratoryReport` subject minted for one BATTERY organizer. */
function panelUri(entry: any): string {
  const subs = subjectsOfType(convert([entry]), 'LaboratoryReport');
  expect(subs.length, 'expected exactly one panel record').toBe(1);
  return subs[0];
}

// ---------------------------------------------------------------------------
// 1. Member observations: the reported collision
// ---------------------------------------------------------------------------

describe('C-CDA lab results that differ are two records', () => {
  it('the repro: fasting 95 and post-prandial 310, distinct source ids, same day', () => {
    // Previously BOTH minted urn:uuid:dc68ecd7-acc0-5d61-981a-e51a3dbc0b0c.
    const fasting = labObs({ id: 'obs-fasting-95', value: '95', time: '20260802070000-0500' });
    const post = labObs({ id: 'obs-postprandial-310', value: '310', time: '20260802110000-0500' });
    expect(resultUri(fasting)).not.toBe(resultUri(post));
  });

  it('a present source id decides, so identical content does NOT merge', () => {
    // Two draws the source deliberately kept apart. Nothing in the content
    // separates them; the ids are the source saying they are two records.
    expect(resultUri(labObs({ id: 'obs-draw-a' }))).not.toBe(resultUri(labObs({ id: 'obs-draw-b' })));
  });

  it('id-less results are separated by the measured value', () => {
    expect(resultUri(labObs({ value: '95' }))).not.toBe(resultUri(labObs({ value: '310' })));
  });

  it('id-less results are separated by the unit — 5 mg/dL is not 5 mmol/L', () => {
    expect(resultUri(labObs({ value: '5', unit: 'mg/dL' })))
      .not.toBe(resultUri(labObs({ value: '5', unit: 'mmol/L' })));
  });

  it('id-less results keep the effective time at FULL precision, not a calendar day', () => {
    // A glucose curve: same test, same value, four hours apart. `formatCcdaDate`
    // truncated both to 2026-08-02 and made them one record.
    expect(resultUri(labObs({ time: '20260802070000-0500' })))
      .not.toBe(resultUri(labObs({ time: '20260802110000-0500' })));
  });

  it('is deterministic AND discriminating, not merely deterministic', () => {
    // A function returning a constant satisfies determinism perfectly, which is
    // exactly what the previous key set did. Both halves, or neither is evidence.
    const a = labObs({ id: 'obs-draw-a', value: '95' });
    const b = labObs({ id: 'obs-draw-b', value: '310' });
    expect(resultUri(a)).toBe(resultUri(structuredClone(a)));
    expect(resultUri(b)).toBe(resultUri(structuredClone(b)));
    expect(resultUri(a)).not.toBe(resultUri(b));
  });

  it('four results that used to be one record are now four', () => {
    const uris = [
      labObs({ id: 'obs-f-95', value: '95', time: '20260802070000-0500' }),
      labObs({ id: 'obs-p-310', value: '310', time: '20260802110000-0500' }),
      labObs({ value: '95', time: '20260802070000-0500' }),
      labObs({ value: '310', time: '20260802110000-0500' }),
    ].map(resultUri);
    expect(new Set(uris).size, `collapsed: ${uris.join(' ')}`).toBe(4);
  });

  it('re-importing the same document mints the same identities', () => {
    // STABILITY PIN. The fix must not turn a merge bug into its mirror image, a
    // fresh IRI on every import. Determinism here is the whole point of content
    // hashing and would be silently lost by, say, keying on a parse timestamp.
    const doc = [
      { observation: labObs({ id: 'obs-1', value: '95' }) },
      { observation: labObs({ value: '310', time: '20260802110000-0500' }) },
    ];
    expect(subjectsOfType(convert(structuredClone(doc)), 'LabResultRecord'))
      .toEqual(subjectsOfType(convert(structuredClone(doc)), 'LabResultRecord'));
  });

  it('the record REPORTS the date at the precision the source stated', () => {
    // This used to assert `['2026-08-02']`, and said so as a stability pin: full
    // precision had moved into the identity key while the emitted literal stayed
    // day-truncated. That is no longer the behaviour, deliberately. The emitters
    // now type the literal, and typing it meant deciding WHICH type — which
    // meant reading the precision the source stated instead of discarding it.
    // A source that wrote 07:00 gets 07:00; the day-truncated string is still
    // what the identity key uses, and `tests/ccda-typed-dates.test.ts` covers the
    // day-precision case where no time is invented.
    const quads = convert([{ observation: labObs({ id: 'obs-1', time: '20260802070000-0500' }) }]);
    const dates = quads
      .filter((q: any) => q.predicate.value.endsWith('performedDate'))
      .map((q: any) => q.object.value);
    expect(dates).toEqual(['2026-08-02T07:00:00-05:00']);
  });
});

// ---------------------------------------------------------------------------
// 2. Panel (BATTERY organizer) identity
// ---------------------------------------------------------------------------

/**
 * The panel path did NOT carry the member path's "the id was discarded" defect:
 * `panelId` was already a first-class content field, put there by an earlier fix
 * for a related collision, so an id-bearing organizer was already separated by
 * its id.
 *
 * Its IRI moves anyway, and it is worth being precise about why, because the
 * previous revision of this file pinned it as deliberately unmoved. The panel
 * key also carried the document's DERIVED patient IRI, and that component has
 * left every C-CDA key — it merged records the source kept apart and split
 * records that were the same. So the panel IRI was going to move whichever way
 * this was written, and given that, the panel takes the same door as every other
 * record rather than keeping a hybrid key: the organizer's own `<id>` decides.
 *
 * The other half of the original defect stands and is still pinned below: a
 * day-truncated `clinicalDate`, which bites when the organizer has neither an id
 * nor a code — the combination the converter's own comment reports is common in
 * real Epic exports (47 of 55 panels in an acceptance export carry no code).
 */
describe('C-CDA lab panels', () => {
  const memberA = labObs({ id: 'm-a', value: '95', time: '20260802070000-0500' });
  const memberB = labObs({ id: 'm-b', value: '310', time: '20260802110000-0500' });

  it('an id-bearing panel keys on its id alone', () => {
    // GOLDEN PIN. The value is `deterministicUuid('LaboratoryReport:1.2.3:org-1')`
    // and nothing else feeds it, so changing the organizer's code, its time or
    // its members cannot move it.
    const withId = (over: Record<string, unknown>) =>
      panelUri(panel({ id: 'org-1', code: '24323-8', time: '20260802070000-0500', members: [memberA], ...over }));

    expect(withId({})).toBe('urn:uuid:a3ae422f-8cea-51a9-8a2c-61cb10216694');
    expect(withId({ code: '58410-2' })).toBe(withId({}));
    expect(withId({ time: '20260802110000-0500' })).toBe(withId({}));
    expect(withId({ members: [memberB] })).toBe(withId({}));
  });

  it('two panels with different ids are two records', () => {
    const p1 = panel({ id: 'org-1', code: '24323-8', time: '20260802070000-0500', members: [memberA] });
    const p2 = panel({ id: 'org-2', code: '24323-8', time: '20260802070000-0500', members: [memberA] });
    expect(panelUri(p1)).not.toBe(panelUri(p2));
  });

  it('two id-less, code-less panels on one day are two records', () => {
    // Previously both minted urn:uuid:0335391b-48fb-5d69-ab87-7bbf2429e434: with
    // no id and no code the key degenerated to {patient, calendar day}.
    const p1 = panel({ time: '20260802070000-0500', members: [memberA] });
    const p2 = panel({ time: '20260802110000-0500', members: [memberB] });
    expect(panelUri(p1)).not.toBe(panelUri(p2));
  });

  it('two id-less panels distinguished ONLY by their members are two records', () => {
    // Real Epic organizers routinely omit effectiveTime as well as code, so the
    // member set is the last thing left that can separate them. A panel has no
    // measured value of its own; its members ARE its content.
    const p1 = panel({ members: [memberA] });
    const p2 = panel({ members: [memberB] });
    expect(panelUri(p1)).not.toBe(panelUri(p2));
  });

  it('an id-less panel is deterministic AND discriminating', () => {
    const p = panel({ time: '20260802070000-0500', members: [memberA] });
    const other = panel({ time: '20260802110000-0500', members: [memberB] });
    expect(panelUri(structuredClone(p))).toBe(panelUri(structuredClone(p)));
    expect(panelUri(p)).not.toBe(panelUri(other));
  });

  it('every hasLabResult edge still points at a member this walk actually minted', () => {
    // STABILITY PIN, and the invariant most at risk from changing how members
    // are minted: the panel's edges are built from the member subjects computed
    // in the same walk, so a second, differently-derived mint would produce
    // edges that resolve to nothing.
    const quads = convert([panel({ id: 'org-1', code: '24323-8', members: [memberA, memberB] })]);
    const members = new Set(subjectsOfType(quads, 'LabResultRecord'));
    const edges = quads
      .filter((q: any) => q.predicate.value.endsWith('hasLabResult'))
      .map((q: any) => q.object.value);
    expect(edges.length).toBe(2);
    for (const e of edges) expect(members.has(e), `dangling hasLabResult -> ${e}`).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Across processes and across working directories
// ---------------------------------------------------------------------------

/**
 * Minting twice in one process shares a warm module cache and one
 * `process.cwd()`. The previous identity defect in this repo was
 * path-dependent and stayed green for months for exactly that reason, so this
 * spawns separate processes from different directories, through `dist/`.
 *
 * The skip guard keys on a module present in EVERY revision, not on anything
 * this change introduces — a guard on a new file SKIPS rather than FAILS
 * against a pre-fix build, which is how a determinism suite looks green while
 * proving nothing.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(REPO, 'dist');
const HAVE_DIST = fs.existsSync(path.join(DIST, 'lib', 'ccda-converter', 'sections', 'labs.js'));

const SCRIPT = `
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
const dist = process.env.CASCADE_DIST;
const { extractLabQuads } = await import(
  pathToFileURL(path.join(dist, 'lib/ccda-converter/sections/labs.js')).href
);
const p = JSON.parse(process.env.CASCADE_PAYLOAD);
const quads = extractLabQuads(p.entries, p.source, undefined, p.importedAt);
const uris = quads
  .filter((q) => q.predicate.value.endsWith('#type'))
  .map((q) => q.subject.value);
process.stdout.write(JSON.stringify({ cwd: process.cwd(), uris }));
`;

function mintIn(dir: string, entries: any[]): { cwd: string; uris: string[] } {
  const scriptPath = path.join(dir, 'mint-ccda.mjs');
  fs.writeFileSync(scriptPath, SCRIPT, 'utf8');
  const stdout = execFileSync(process.execPath, [scriptPath], {
    cwd: dir,
    env: {
      ...process.env,
      CASCADE_DIST: DIST,
      CASCADE_PAYLOAD: JSON.stringify({ entries, source: SOURCE, importedAt: IMPORTED_AT }),
    },
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

describe.skipIf(!HAVE_DIST)('C-CDA lab identity survives the process and the working directory', () => {
  it('two processes in two directories agree, and still tell the results apart', () => {
    const entries = [
      { observation: labObs({ id: 'obs-f-95', value: '95', time: '20260802070000-0500' }) },
      { observation: labObs({ id: 'obs-p-310', value: '310', time: '20260802110000-0500' }) },
      { observation: labObs({ value: '95', time: '20260802070000-0500' }) },
      { observation: labObs({ value: '310', time: '20260802110000-0500' }) },
    ];

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-ccda-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-ccda-b-'));
    try {
      const a = mintIn(dirA, structuredClone(entries));
      const b = mintIn(dirB, structuredClone(entries));

      expect(a.cwd).not.toBe(b.cwd);
      // DETERMINISM: two processes, two directories, one answer.
      expect(a.uris, `cwd ${a.cwd} disagreed with cwd ${b.cwd}`).toEqual(b.uris);
      // DISTINCTNESS: and the answer is not a constant. Without this half, a
      // function returning one string passes the line above perfectly.
      expect(new Set(a.uris).size, `four results shared an IRI: ${a.uris.join(' ')}`).toBe(4);
      for (const uri of a.uris) expect(uri).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });
});
