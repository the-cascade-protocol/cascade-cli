/**
 * Conformance suite for record identity on general clinical FHIR resources.
 *
 * WHY THIS FILE HAS TO EXIST FOR THE FIXTURES TO MEAN ANYTHING
 * -----------------------------------------------------------
 * The `conformance` repository has no test runner of its own: no workflow, no
 * package.json, no Makefile. It is data. Its fixtures execute only because
 * suites in THIS repository reach into the sibling checkout and assert on them.
 * A fixture added there with no consuming test here is an inert file that will
 * never run anywhere, so a corpus gap is only half closed by adding fixtures.
 *
 * The other half is this file. The gap it closes: before the
 * `fixtures/clinical-fhir/` corpus, a search of that whole repository for
 * `"resourceType"` returned 7 files, every one a FHIR Genomics bundle — so the
 * FHIR clinical path, which every SMART on FHIR pull and every Apple Health
 * import runs through, had no shared-corpus coverage at all. And every fixture
 * that did exist carried an `id`, which is precisely why a defect that only
 * appears when a resource has none stayed invisible in both suites.
 *
 * WHAT IS ASSERTED
 * ----------------
 * `identity-expectations.json` states RELATIONS between fixtures — two must be
 * distinct, two must be the same — rather than pinned IRIs. A relation is what
 * actually has to hold for the data to survive; it is the same claim in every
 * SDK; and it does not need regenerating each time an identity key is
 * legitimately widened, whereas a pinned oracle does and is vacuously green
 * against its own generator.
 *
 * THE `status` FIELD IS A TRIPWIRE IN BOTH DIRECTIONS, NOT A SKIP
 * --------------------------------------------------------------
 * Three of the twelve expectations are not satisfied by the importer as it
 * stands, and the manifest records that as measured fact. This suite asserts
 * them ANYWAY, in the direction the manifest declares:
 *
 *   satisfied      → assert the relation HOLDS. Fails if it regresses.
 *   not-yet        → assert the relation still FAILS. Fails the moment the
 *                    importer starts satisfying it, with a message naming the
 *                    one-line manifest edit that resolves it.
 *
 * So neither direction can drift silently, and nothing here is skipped. The
 * cost is explicit and deliberate: when the importer-side fix for those three
 * lands, this suite goes red until the corpus is told, which is the correct
 * order of events for a corpus that is supposed to be the source of truth.
 *
 * Fixture path resolution matches the other conformance suites: the sibling
 * checkout by default, overridable with `CASCADE_CONFORMANCE_DIR` for agents
 * working in a conformance worktree.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';

import { fhirImporter } from '../src/lib/fhir-converter/registry-entry.js';
import type { ImportContext } from '../src/lib/import-types.js';
import { conformancePath } from './helpers/conformance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURES_DIR = process.env.CASCADE_CONFORMANCE_DIR
  ? path.resolve(process.env.CASCADE_CONFORMANCE_DIR, 'fixtures/clinical-fhir')
  : conformancePath('fixtures/clinical-fhir');

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const CTX: ImportContext = {
  inputPath: '<conformance>',
  outputSerialization: 'turtle',
  importedAt: '2026-01-01T00:00:00Z',
  options: {},
};

interface Expectation {
  id: string;
  relation: 'distinct' | 'same';
  fixtures: string[];
  why: string;
  status: string;
}
interface Manifest {
  expectations: Expectation[];
  additionalRequirements: Array<{ id: string; requirement: string }>;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(FIXTURES_DIR, 'identity-expectations.json'), 'utf-8'),
) as Manifest;

/** The single clinical-record subject IRI a fixture converts to. */
async function iriOf(fixture: string): Promise<string> {
  const source = fs.readFileSync(path.join(FIXTURES_DIR, fixture), 'utf-8');
  const result = await fhirImporter.convert(source, 'turtle', CTX);
  const turtle = (result as { output?: string }).output ?? '';
  const subjects = [...new Set(
    new Parser({ format: 'Turtle' }).parse(turtle)
      .filter(q => q.predicate.value === RDF_TYPE && q.subject.value.startsWith('urn:uuid:'))
      .map(q => q.subject.value),
  )];
  expect(subjects, `${fixture} must convert to exactly one clinical record`).toHaveLength(1);
  return subjects[0];
}

describe('conformance: identity on general clinical FHIR resources', () => {
  it('the corpus is present and states expectations', () => {
    // A missing sibling checkout must fail here, loudly and once, rather than
    // producing twelve confusing failures further down.
    expect(fs.existsSync(FIXTURES_DIR), `conformance corpus not found at ${FIXTURES_DIR}`).toBe(true);
    expect(manifest.expectations.length).toBeGreaterThanOrEqual(12);
    expect(manifest.expectations.every(e => e.fixtures.length >= 2)).toBe(true);
    // Every expectation states WHY, at length: an expectation nobody can read
    // is one nobody can review.
    for (const e of manifest.expectations) {
      expect(e.why.length, `${e.id} needs a real justification`).toBeGreaterThan(80);
    }
  });

  for (const e of manifest.expectations) {
    const declaredSatisfied = !e.status.startsWith('not-yet-satisfied');
    const title = declaredSatisfied
      ? `${e.relation}: ${e.id}`
      : `${e.relation}: ${e.id} — NOT YET SATISFIED, pinned`;

    it(title, async () => {
      const iris: string[] = [];
      for (const f of e.fixtures) iris.push(await iriOf(f));
      const holds = e.relation === 'same'
        ? iris.every(i => i === iris[0])
        : new Set(iris).size === iris.length;

      if (declaredSatisfied) {
        expect(holds, `${e.why}\n\nIRIs: ${iris.join('\n      ')}`).toBe(true);
      } else {
        // Not a skip: this asserts the CURRENT, wrong behaviour, so it turns red
        // the moment the behaviour is fixed and the corpus has to be updated.
        expect(
          holds,
          `${e.id} is now satisfied by the importer. That is the fix landing, not a ` +
            `regression: set its "status" to "satisfied" in the conformance corpus at ` +
            `fixtures/clinical-fhir/identity-expectations.json and this assertion flips ` +
            `to the real one.\n\n${e.why}\n\nIRIs: ${iris.join('\n      ')}`,
        ).toBe(false);
      }
    });
  }

  it('mints the same IRIs from another process in another working directory', () => {
    // The corpus requires identity to depend on the resource and on nothing
    // else. A separate process rules out module-level state carried between
    // calls; a different working directory rules out any dependence on where
    // the tool was invoked from, which is a defect this repo has actually
    // shipped. Determinism is asserted together with DISTINCTNESS, because a
    // constant satisfies determinism alone and carries no identity.
    const probes = [
      'condition-no-id-narrative-diabetes.json',
      'condition-no-id-narrative-breast-cancer.json',
      'allergy-no-id-sulfa.json',
      'vital-heartrate-no-id-evening.json',
    ];
    const script = `
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { fhirImporter } = await import(${JSON.stringify(path.resolve(__dirname, '../dist/lib/fhir-converter/registry-entry.js'))});
      const out = [];
      for (const f of ${JSON.stringify(probes)}) {
        const src = fs.readFileSync(path.join(${JSON.stringify(FIXTURES_DIR)}, f), 'utf-8');
        const r = await fhirImporter.convert(src, 'turtle', ${JSON.stringify(CTX)});
        const m = [...(r.output ?? '').matchAll(/<(urn:uuid:[0-9a-f-]+)> a /g)].map(x => x[1]);
        out.push([...new Set(m)].sort().join(','));
      }
      console.log(JSON.stringify(out));
    `;
    const run = (cwd: string): string[] =>
      JSON.parse(execFileSync('node', ['--input-type=module', '-e', script], {
        cwd, encoding: 'utf-8', timeout: 120000,
      }).trim().split('\n').pop()!) as string[];

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'clinical-conf-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'clinical-conf-b-'));
    const fromA = run(dirA);
    const fromB = run(dirB);

    expect(fromA).toEqual(fromB);
    expect(fromA).toHaveLength(probes.length);
    expect(fromA.every(v => v.length > 0)).toBe(true);
    // ... and they are four DIFFERENT identities, not one repeated.
    expect(new Set(fromA).size).toBe(probes.length);
  });
});
