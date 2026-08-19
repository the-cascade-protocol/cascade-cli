/**
 * A value `pod add-record` writes must land as the datatype its property is
 * declared to have.
 *
 * WHAT WENT WRONG
 * ---------------
 * `add-record` takes every property value as a string, because JSON and a shell
 * both hand it one, and it wrote every one of them as a PLAIN literal:
 *
 *     checkup:supplementIsActive "true" ;
 *     checkup:supplementStartDate "2026-01-15" ;
 *     checkup:patientCost "12.50" ;
 *     checkup:doctorAware "false" ;
 *
 * The checkup vocabulary declares those `xsd:boolean`, `xsd:date`,
 * `xsd:decimal` and `xsd:boolean`. Measured against the pre-fix build, one
 * five-property supplement produced FIVE `sh:datatype` violations from
 * `cascade validate` (patientCost is constrained by two shapes and reports
 * twice). They are Info severity on the checkup shapes, so the file still
 * reported PASS and the defect was easy to walk past, but the pod held dates
 * that sort lexically by luck and decimals that cannot be summed without
 * re-deriving a schema the pod does not carry, and the SAME properties written
 * by an import arrived correctly typed, so one pod could hold both spellings of
 * one property with nothing to say which was canonical.
 *
 * WHAT THESE WOULD DO IF THE FIX WERE ABSENT
 *   - `stamps the declared datatype` FAILS: the serialized bucket holds
 *     `checkup:supplementIsActive "true"`, not a typed boolean.
 *   - `validates with nothing to report` FAILS with 5 Info results.
 *   - `refuses a value that cannot be its declared datatype` FAILS: "maybe" was
 *     accepted and written.
 *
 * The declaration is read from the BUNDLED SHAPES rather than from a table in
 * this repo, so the two invariant tests at the bottom guard the reading: every
 * datatype the shapes declare must have a lexical-form check, and no property
 * may be declared with two different datatypes. Both are tripwires for the next
 * vocabulary sync.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { Parser } from 'n3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  XSD,
  ambiguouslyDeclaredProperties,
  checkedDatatypes,
  declaredDatatype,
  shapeDeclaredDatatypes,
  typedLiteralForPredicate,
  DatatypeMismatchError,
} from '../src/lib/shape-datatypes.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'dist', 'index.js');
const CHECKUP = 'https://ns.cascadeprotocol.org/checkup/v1#';

const roots: string[] = [];

function cli(args: string[]): { output: string; status: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', timeout: 180000 });
  return { output: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status ?? 1 };
}

/**
 * The fixture bucket: one supplement summary carrying a value of every
 * non-string datatype the class declares.
 */
const MIXED_DATATYPE_PROPS = {
  'checkup:supplementName': 'Synthetic Kelp Blend',
  'checkup:regulatoryStatus': 'dietarySupplement',
  'checkup:supplementIsActive': 'true',
  'checkup:doctorAware': 'false',
  'checkup:supplementStartDate': '2026-01-15',
  'checkup:patientCost': '12.50',
};

function podWithMixedDatatypes(): { podDir: string; bucket: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-lit-'));
  roots.push(root);
  const podDir = path.join(root, 'pod');

  expect(cli(['pod', 'init', podDir]).status).toBe(0);
  const add = cli([
    '--json', 'pod', 'add-record', podDir,
    '--type', 'checkup:SupplementSummary',
    '--json', JSON.stringify(MIXED_DATATYPE_PROPS),
  ]);
  expect(add.status, add.output).toBe(0);

  return { podDir, bucket: path.join(podDir, 'wellness', 'supplements.ttl') };
}

/** The datatype IRI of the object of `predicate`, as the WRITTEN file holds it. */
function writtenDatatype(turtle: string, predicate: string): string | undefined {
  const quads = new Parser({ format: 'Turtle' }).parse(turtle);
  const q = quads.find((x) => x.predicate.value === predicate);
  if (!q || q.object.termType !== 'Literal') return undefined;
  return q.object.datatype.value;
}

function writtenValue(turtle: string, predicate: string): string | undefined {
  const quads = new Parser({ format: 'Turtle' }).parse(turtle);
  return quads.find((x) => x.predicate.value === predicate)?.object.value;
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error('dist/index.js is missing. Run `npm run build` before `npm test`.');
  }
});

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('pod add-record writes the datatype the shapes declare', () => {
  it('stamps xsd:boolean, xsd:date and xsd:decimal on the values that need them', () => {
    const { bucket } = podWithMixedDatatypes();
    const turtle = fs.readFileSync(bucket, 'utf-8');

    expect(writtenDatatype(turtle, `${CHECKUP}supplementIsActive`)).toBe(`${XSD}boolean`);
    expect(writtenDatatype(turtle, `${CHECKUP}doctorAware`)).toBe(`${XSD}boolean`);
    expect(writtenDatatype(turtle, `${CHECKUP}supplementStartDate`)).toBe(`${XSD}date`);
    expect(writtenDatatype(turtle, `${CHECKUP}patientCost`)).toBe(`${XSD}decimal`);
  });

  it('preserves the lexical value exactly as given', () => {
    // Typing must not reformat. "12.50" becoming "12.5" would silently rewrite
    // what the patient entered, and a date normalized through a Date object
    // would shift by a timezone.
    const { bucket } = podWithMixedDatatypes();
    const turtle = fs.readFileSync(bucket, 'utf-8');

    expect(writtenValue(turtle, `${CHECKUP}patientCost`)).toBe('12.50');
    expect(writtenValue(turtle, `${CHECKUP}supplementStartDate`)).toBe('2026-01-15');
    expect(writtenValue(turtle, `${CHECKUP}supplementIsActive`)).toBe('true');
  });

  it('leaves a string-declared property a plain literal', () => {
    // RDF 1.1 makes a plain literal xsd:string already. Writing the long form
    // would rewrite every existing string-valued bucket on its next merge for
    // no semantic gain, so the test pins the SHORT form.
    const { bucket } = podWithMixedDatatypes();
    const turtle = fs.readFileSync(bucket, 'utf-8');

    expect(writtenDatatype(turtle, `${CHECKUP}supplementName`)).toBe(`${XSD}string`);
    expect(turtle).toContain('checkup:supplementName "Synthetic Kelp Blend"');
    expect(turtle).not.toContain('"Synthetic Kelp Blend"^^xsd:string');
  });

  it('validates with nothing to report', () => {
    const { bucket } = podWithMixedDatatypes();
    const r = cli(['--json', 'validate', bucket]);
    expect(r.status, r.output).toBe(0);

    const [report] = JSON.parse(r.output);
    expect(report.shapesFired).toContain('SupplementSummaryShape');
    // Not `valid: true`, which was already true before the fix: these were
    // Info-severity results and Info does not fail a file. The count is the
    // assertion that moved, from 5 to 0.
    expect(report.results).toEqual([]);
  });

  it('survives the round trip through pod query', () => {
    const { podDir } = podWithMixedDatatypes();
    const r = cli(['--json', 'pod', 'query', podDir, '--supplements']);
    expect(r.status, r.output).toBe(0);

    const record = JSON.parse(r.output).dataTypes.supplements.records[0];
    expect(record.properties[`checkup:supplementIsActive`]).toBe('true');
    expect(record.properties[`checkup:supplementStartDate`]).toBe('2026-01-15');
    expect(record.properties[`checkup:patientCost`]).toBe('12.50');
  });

  it('types a JSON boolean and a JSON number the same as their string forms', () => {
    // The payload is JSON, so a caller may well send `true` and `12.5` rather
    // than "true" and "12.5". Both reach the writer as strings, and both must
    // land typed.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-lit-json-'));
    roots.push(root);
    const podDir = path.join(root, 'pod');
    expect(cli(['pod', 'init', podDir]).status).toBe(0);

    const add = cli([
      '--json', 'pod', 'add-record', podDir,
      '--type', 'checkup:SupplementSummary',
      '--json', '{"checkup:supplementName":"Synthetic Beet Powder","checkup:supplementIsActive":true,"checkup:patientCost":12.5}',
    ]);
    expect(add.status, add.output).toBe(0);

    const turtle = fs.readFileSync(path.join(podDir, 'wellness', 'supplements.ttl'), 'utf-8');
    expect(writtenDatatype(turtle, `${CHECKUP}supplementIsActive`)).toBe(`${XSD}boolean`);
    expect(writtenDatatype(turtle, `${CHECKUP}patientCost`)).toBe(`${XSD}decimal`);
  });

  it('refuses a value that cannot be its declared datatype, and writes nothing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-lit-bad-'));
    roots.push(root);
    const podDir = path.join(root, 'pod');
    expect(cli(['pod', 'init', podDir]).status).toBe(0);

    const add = cli([
      'pod', 'add-record', podDir,
      '--type', 'checkup:SupplementSummary',
      '--json', '{"checkup:supplementName":"Synthetic Beet Powder","checkup:supplementIsActive":"maybe"}',
    ]);
    expect(add.status).toBe(1);
    expect(add.output).toContain('xsd:boolean');
    expect(add.output).toContain('checkup:supplementIsActive');
    // Refusal means refusal: the bucket must not exist holding a half-written
    // record. Coercing "maybe" to a boolean, or falling back to an untyped
    // literal, would both leave a file here.
    expect(fs.existsSync(path.join(podDir, 'wellness', 'supplements.ttl'))).toBe(false);
  });

  it('refuses an impossible date as well as an impossible boolean', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-lit-date-'));
    roots.push(root);
    const podDir = path.join(root, 'pod');
    expect(cli(['pod', 'init', podDir]).status).toBe(0);

    const add = cli([
      'pod', 'add-record', podDir,
      '--type', 'checkup:SupplementSummary',
      '--json', '{"checkup:supplementName":"Synthetic Beet Powder","checkup:supplementStartDate":"2026-02-30"}',
    ]);
    expect(add.status).toBe(1);
    expect(add.output).toContain('xsd:date');
  });
});

describe('the declaration map read from the bundled shapes', () => {
  it('reads the checkup supplement datatypes off the shapes, not off a local table', () => {
    expect(declaredDatatype(`${CHECKUP}supplementIsActive`)).toBe(`${XSD}boolean`);
    expect(declaredDatatype(`${CHECKUP}supplementStartDate`)).toBe(`${XSD}date`);
    expect(declaredDatatype(`${CHECKUP}patientCost`)).toBe(`${XSD}decimal`);
    expect(declaredDatatype(`${CHECKUP}supplementName`)).toBe(`${XSD}string`);
  });

  it('declares nothing for a property no shape constrains', () => {
    expect(declaredDatatype('https://ns.cascadeprotocol.org/checkup/v1#notAProperty')).toBeUndefined();
    expect(typedLiteralForPredicate(
      'https://ns.cascadeprotocol.org/checkup/v1#notAProperty', 'anything',
    ).datatype.value).toBe(`${XSD}string`);
  });

  it('is non-empty, so an all-undefined map cannot pass as "nothing is declared"', () => {
    expect(shapeDeclaredDatatypes().size).toBeGreaterThan(100);
  });

  it('has a lexical-form check for every datatype the shapes declare', () => {
    // The tripwire for the next vocabulary sync. A datatype with no check is
    // refused at runtime rather than written unchecked, so without this test the
    // first sign of a new one would be a user's write failing.
    const declared = [...new Set(shapeDeclaredDatatypes().values())].sort();
    const checked = new Set(checkedDatatypes());
    expect(declared.filter((d) => !checked.has(d))).toEqual([]);
  });

  it('declares no property with two different datatypes', () => {
    // Such a property is omitted from the map (the writer would have to pick one
    // and the other shape would reject the pick), so it would silently go back
    // to being written untyped. Zero today; this makes a change visible.
    expect(ambiguouslyDeclaredProperties()).toEqual([]);
  });

  it('rejects each declared datatype with a value that cannot be it', () => {
    const cases: Array<[string, string]> = [
      [`${XSD}boolean`, 'maybe'],
      [`${XSD}decimal`, '12.5.1'],
      [`${XSD}integer`, '3.5'],
      [`${XSD}date`, '15/01/2026'],
      [`${XSD}dateTime`, '2026-01-15'],
    ];
    for (const [datatype, bad] of cases) {
      const predicate = [...shapeDeclaredDatatypes()].find(([, d]) => d === datatype)?.[0];
      expect(predicate, `no bundled property is declared ${datatype}`).toBeDefined();
      expect(() => typedLiteralForPredicate(predicate!, bad)).toThrow(DatatypeMismatchError);
    }
  });
});
