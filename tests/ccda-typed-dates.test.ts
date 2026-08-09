/**
 * The C-CDA converter must state a date at the precision the SOURCE stated it,
 * and must say which kind of date it is.
 *
 * health v2.6 / clinical v1.14 constrain the source-carried date properties with
 * `sh:or ( [ sh:datatype xsd:date ] [ sh:datatype xsd:dateTime ] )`. A plain RDF
 * literal is `xsd:string`, which is neither, so every C-CDA-converted record
 * carrying one of these properties failed validation on it. The five emitters
 * now build the literal through one helper, `ccdaDateQuad`, which decides the
 * datatype from the precision of the `<effectiveTime>` value:
 *
 *   <effectiveTime value="20250311143000-0500"/>  -> "2025-03-11T14:30:00-05:00"^^xsd:dateTime
 *   <effectiveTime value="20250311"/>             -> "2025-03-11"^^xsd:date
 *
 * The second line is the point of the exercise. Satisfying an `xsd:dateTime`
 * constraint by appending `T00:00:00` would have made the record claim a draw
 * time the document never gave, so the shapes were widened instead and the
 * converter says exactly what it was told.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';
import type { Quad } from 'n3';
import { convertCcda } from '../src/lib/ccda-converter/index.js';
import { ccdaDateTerm } from '../src/lib/ccda-converter/dates.js';
import { loadShapes, validateTurtle } from '../src/lib/shacl-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES = path.resolve(__dirname, '../test-fixtures');
const CLI_PATH = path.resolve(__dirname, '../dist/index.js');
const HAVE_DIST = fs.existsSync(CLI_PATH);

const XSD_DATE = 'http://www.w3.org/2001/XMLSchema#date';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

const HEALTH = 'https://ns.cascadeprotocol.org/health/v1#';

async function convertFixture(name: string): Promise<Quad[]> {
  const xml = fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
  const result = await convertCcda(xml, {
    sourceSystem: 'TestSystem',
    importedAt: '2026-01-01T00:00:00Z',
  });
  expect(result.errors, `conversion errors: ${result.errors.join(', ')}`).toHaveLength(0);
  return new Parser().parse(result.output);
}

/** Every object of `predicate`, as {value, datatype}. */
function objectsOf(quads: Quad[], predicate: string): { value: string; datatype: string }[] {
  return quads
    .filter((q) => q.predicate.value === predicate)
    .map((q) => ({
      value: q.object.value,
      datatype: (q.object as any).datatype?.value ?? '(not a literal)',
    }));
}

// ---------------------------------------------------------------------------
// The helper itself
// ---------------------------------------------------------------------------

describe('ccdaDateTerm — HL7 v3 TS precision to RDF datatype', () => {
  it('types a second-precision value with a zone offset as xsd:dateTime', () => {
    expect(ccdaDateTerm('20250311143000-0500')).toEqual({
      value: '2025-03-11T14:30:00-05:00',
      datatype: XSD_DATETIME,
    });
  });

  it('types a day-precision value as xsd:date and invents no time', () => {
    expect(ccdaDateTerm('20250311')).toEqual({
      value: '2025-03-11',
      datatype: XSD_DATE,
    });
  });

  it('keeps a time that carries no zone unzoned rather than assuming UTC', () => {
    expect(ccdaDateTerm('20250311143000')).toEqual({
      value: '2025-03-11T14:30:00',
      datatype: XSD_DATETIME,
    });
  });

  it('zero-fills minutes and seconds for hour- and minute-precision values', () => {
    expect(ccdaDateTerm('2025031114')).toEqual({
      value: '2025-03-11T14:00:00',
      datatype: XSD_DATETIME,
    });
    expect(ccdaDateTerm('202503111430')).toEqual({
      value: '2025-03-11T14:30:00',
      datatype: XSD_DATETIME,
    });
  });

  it('drops fractional seconds, which neither datatype needs here', () => {
    expect(ccdaDateTerm('20250311143000.000+0000')).toEqual({
      value: '2025-03-11T14:30:00+00:00',
      datatype: XSD_DATETIME,
    });
  });

  it('returns null for a value coarser than a calendar day', () => {
    // xsd:date is YYYY-MM-DD exactly; "2025-03" is xsd:gYearMonth, which the
    // shapes do not accept. Emitting it typed either way would be a lie, and
    // emitting it untyped is the defect this helper exists to remove.
    expect(ccdaDateTerm('202503')).toBeNull();
    expect(ccdaDateTerm('2025')).toBeNull();
  });

  it('returns null for absent, empty and non-numeric values', () => {
    expect(ccdaDateTerm(undefined)).toBeNull();
    expect(ccdaDateTerm(null)).toBeNull();
    expect(ccdaDateTerm('')).toBeNull();
    expect(ccdaDateTerm('   ')).toBeNull();
    expect(ccdaDateTerm('not-a-date')).toBeNull();
  });

  it('passes an already-ISO value through with the matching datatype', () => {
    expect(ccdaDateTerm('2025-03-11')).toEqual({ value: '2025-03-11', datatype: XSD_DATE });
    expect(ccdaDateTerm('2025-03-11T14:30:00Z')).toEqual({
      value: '2025-03-11T14:30:00Z',
      datatype: XSD_DATETIME,
    });
  });

  it('falls back to day precision when the digits past the day are malformed', () => {
    // 9 digits: the calendar day is known, the time is not. Reporting the day is
    // honest; reporting "T0:00:00" from a stray digit would not be.
    expect(ccdaDateTerm('202503111')).toEqual({ value: '2025-03-11', datatype: XSD_DATE });
  });
});

// ---------------------------------------------------------------------------
// The five emission sites
// ---------------------------------------------------------------------------

describe('C-CDA date emitters — typed literals at every constrained site', () => {
  it('labs: a timed effectiveTime becomes an xsd:dateTime carrying that time', async () => {
    const quads = await convertFixture('ccda-typed-dates.xml');
    const dates = objectsOf(quads, HEALTH + 'performedDate');
    expect(dates).toContainEqual({
      value: '2025-03-11T14:30:00-05:00',
      datatype: XSD_DATETIME,
    });
  });

  it('labs: a day-precision effectiveTime becomes an xsd:date with no time', async () => {
    const quads = await convertFixture('ccda-typed-dates.xml');
    const dates = objectsOf(quads, HEALTH + 'performedDate');
    expect(dates).toContainEqual({ value: '2025-03-11', datatype: XSD_DATE });
  });

  it('problems: onsetDate is typed', async () => {
    const quads = await convertFixture('ccda-typed-dates.xml');
    expect(objectsOf(quads, HEALTH + 'onsetDate')).toEqual([
      { value: '2007-01-03', datatype: XSD_DATE },
    ]);
  });

  it('immunizations: administrationDate is typed', async () => {
    const quads = await convertFixture('ccda-typed-dates.xml');
    expect(objectsOf(quads, HEALTH + 'administrationDate')).toEqual([
      { value: '2024-10-02T09:15:00+00:00', datatype: XSD_DATETIME },
    ]);
  });

  it('vitals: the lab-result fallback path types performedDate too', async () => {
    // Mean blood pressure is outside the VitalSignShape enum, so vitals.ts
    // re-routes it to a LabResultRecord through a second, separate emitter.
    const quads = await convertFixture('ccda-typed-dates.xml');
    const mbp = quads.find(
      (q) => q.predicate.value === HEALTH + 'testName' && q.object.value === 'Mean blood pressure',
    );
    expect(mbp, 'mean blood pressure lab fallback record').toBeDefined();
    const dateQuad = quads.find(
      (q) => q.subject.value === mbp!.subject.value && q.predicate.value === HEALTH + 'performedDate',
    );
    expect((dateQuad!.object as any).datatype.value).toBe(XSD_DATE);
    expect(dateQuad!.object.value).toBe('2025-03-11');
  });

  it('procedures: performedDate is typed', async () => {
    const quads = await convertFixture('ccda-narrative-names.xml');
    expect(objectsOf(quads, HEALTH + 'performedDate')).toContainEqual({
      value: '2024-06-12T10:30:00-04:00',
      datatype: XSD_DATETIME,
    });
  });

  it('no date property is left as a plain (xsd:string) literal', async () => {
    const quads = await convertFixture('ccda-typed-dates.xml');
    const dateProps = [
      HEALTH + 'performedDate',
      HEALTH + 'onsetDate',
      HEALTH + 'administrationDate',
    ];
    const untyped = quads
      .filter((q) => dateProps.includes(q.predicate.value))
      .filter((q) => {
        const dt = (q.object as any).datatype?.value;
        return dt !== XSD_DATE && dt !== XSD_DATETIME;
      })
      .map((q) => `${q.predicate.value} = ${q.object.value}`);
    expect(untyped, `untyped date literals:\n${untyped.join('\n')}`).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SHACL
// ---------------------------------------------------------------------------

describe('C-CDA typed dates — SHACL', () => {
  it('the typed-date fixture validates with zero violations', async () => {
    const xml = fs.readFileSync(path.join(FIXTURES, 'ccda-typed-dates.xml'), 'utf-8');
    const result = await convertCcda(xml, {
      sourceSystem: 'TestSystem',
      importedAt: '2026-01-01T00:00:00Z',
    });
    const { store, shapeFiles } = loadShapes();
    const validation = validateTurtle(result.output, store, shapeFiles, 'ccda-typed-dates.xml');
    const violations = validation.results.filter((r) => r.severity === 'violation');
    expect(
      violations,
      violations.map((v) => `  ${v.property}: ${v.message}`).join('\n'),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// End to end through the CLI a user actually runs
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_DIST)('C-CDA typed dates — convert, import, validate', () => {
  function cli(args: string[]): string {
    return execFileSync('node', [CLI_PATH, ...args], { encoding: 'utf-8', timeout: 120000 });
  }

  it('a pod built from the fixture validates clean', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-typed-dates-'));
    const podDir = path.join(dir, 'pod');
    cli(['pod', 'init', podDir]);

    const ttl = path.join(dir, 'typed-dates.ttl');
    fs.writeFileSync(
      ttl,
      cli(['convert', '--from', 'c-cda', '--to', 'turtle', path.join(FIXTURES, 'ccda-typed-dates.xml')]),
    );
    cli(['pod', 'import', podDir, ttl]);

    // `cascade validate` exits 1 on any violation, so a clean exit IS the
    // assertion; the output is captured so a failure says which property broke.
    let out = '';
    let status = 0;
    try {
      out = cli(['validate', podDir]);
    } catch (e: any) {
      status = e.status ?? -1;
      out = String(e.stdout ?? '');
    }
    expect(status, `cascade validate reported violations:\n${out}`).toBe(0);
    expect(out).not.toMatch(/Property: (performedDate|onsetDate|administrationDate)/);
  });
});
