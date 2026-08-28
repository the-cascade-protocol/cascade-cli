/**
 * The field-coverage chokepoint: no FHIR field is dropped in silence.
 *
 * THE DEFECT CLASS THIS EXISTS FOR
 * --------------------------------
 * A converter that never reads a field, a converter that reads a field only to
 * mint identity and never writes it, and a converter that reads the first
 * element of an array and ignores the rest all produce the same thing from
 * outside: a pod that is quietly thinner than its source. Measured on one real
 * Epic R4 pull, that came to a visit record holding seven bookkeeping facts
 * while the source stated the clinic, the reason, four typed participants, the
 * contact serial number and four type codings — and, twice, an AMENDED result
 * imported byte-identical to a final one.
 *
 * No single omission was the bug. The bug was that omissions were silent. So
 * this gate does not check for any particular field: it requires that EVERY
 * populated element either reaches the converted output or sits on that
 * converter's drop manifest with a written reason.
 *
 * WHY DIFFERENTIAL, AND WHY NOT THE TWO OBVIOUS ALTERNATIVES
 * ----------------------------------------------------------
 * Both were tried on the real corpus and both gave wrong answers.
 *
 *   Grep the converter for `resource.<field>`: wrong in both directions.
 *   `convertEncounter` reads `resource.identifier` for identity and never emits
 *   it, so the read-list called it kept while the pod contained none.
 *
 *   Match source VALUES against the pod: wrong in the other direction. Matching
 *   against the whole corpus reports a hit whenever any unrelated record
 *   contains the same string, so encounter reason texts collided with condition
 *   names and retention was overstated.
 *
 * Deleting one element and re-converting asks the question that answers itself.
 * If the output does not move, the element reached nothing.
 *
 * WHAT COUNTS AS REACHING THE OUTPUT
 * ----------------------------------
 * Predicate + object multiset, plus the SET OF SUBJECT IRIs. A field that only
 * moves the IRI still counts as emitted, because on the content-keyed types it
 * decides which records merge — a stronger effect than a triple. That is the
 * seam with `clinical-identity.test.ts`: source -> serialized is proven here,
 * serialized -> identity key is proven there, and a field cannot silently skip a
 * layer.
 *
 * THE ONE THING THE DIFFERENTIAL CANNOT SEE
 * -----------------------------------------
 * It deletes ONE element at a time, so two elements that express the same value
 * (a `text` beside a coding `display`, or a stated status equal to the
 * converter's default) each measure as dropped: with either one gone the other
 * still produces the same output. Those are recorded as `acknowledged` entries
 * whose reason names the redundancy, rather than silently excluded — the
 * defaulting cases in particular are worth stating, since they are how an
 * ABSENT status becomes a confident "completed" in the pod.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeResourceCoverage } from '../src/lib/fhir-converter/field-coverage/analyze.js';
import {
  FIELD_DROP_MANIFESTS,
  manifestFor,
  manifestedTypes,
} from '../src/lib/fhir-converter/field-coverage/manifests/index.js';
import {
  childFieldPaths,
  enumerateFieldPaths,
  topLevelFieldPaths,
  withoutPath,
} from '../src/lib/fhir-converter/field-coverage/paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, '..', 'test-fixtures', 'field-coverage');

interface Fixture {
  file: string;
  resource: Record<string, unknown>;
  resourceType: string;
}

function loadFixtures(): Fixture[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const resource = JSON.parse(
        fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf-8'),
      ) as Record<string, unknown>;
      return { file, resource, resourceType: String(resource.resourceType) };
    });
}

const FIXTURES = loadFixtures();

/**
 * The coverage of every fixture, measured once. Each measurement runs one
 * conversion per visited path, so doing it per assertion would multiply a real
 * cost for no extra proof.
 */
const COVERAGE = FIXTURES.map((fixture) => ({
  fixture,
  coverage: analyzeResourceCoverage(fixture.resource),
}));

/** Every path any fixture proved dropped, as `Type|path`. */
const DROPPED_SOMEWHERE = new Set(
  COVERAGE.flatMap(({ fixture, coverage }) =>
    coverage.dropped.map((p) => `${fixture.resourceType}|${p}`),
  ),
);

/** Every path any fixture proved emitted, as `Type|path`. */
const EMITTED_SOMEWHERE = new Set(
  COVERAGE.flatMap(({ fixture, coverage }) =>
    coverage.emitted.map((p) => `${fixture.resourceType}|${p}`),
  ),
);

/** Every path any fixture populated at all, as `Type|path`. */
const POPULATED_SOMEWHERE = new Set(
  FIXTURES.flatMap((fixture) =>
    enumerateFieldPaths(fixture.resource).map((p) => `${fixture.resourceType}|${p}`),
  ),
);

describe('FHIR field coverage: the corpus and the manifests describe the same converters', () => {
  it('every fixture is a resource type that has a drop manifest', () => {
    const orphans = FIXTURES.filter((f) => !manifestFor(f.resourceType)).map(
      (f) => `${f.file} (${f.resourceType})`,
    );
    expect(
      orphans,
      'A fixture without a manifest cannot be checked: every dropped path would fail with nowhere to record it.',
    ).toEqual([]);
  });

  it('every manifested resource type has at least one fixture', () => {
    const covered = new Set(FIXTURES.map((f) => f.resourceType));
    const unexercised = manifestedTypes().filter((t) => !covered.has(t));
    expect(
      unexercised,
      'A manifest with no fixture is unfalsifiable: nothing can ever prove one of its entries stale.',
    ).toEqual([]);
  });

  it('every manifest entry is well formed', () => {
    const problems: string[] = [];
    for (const manifest of FIELD_DROP_MANIFESTS) {
      for (const [entryPath, entry] of Object.entries(manifest.drops)) {
        if (!entryPath.startsWith(`${manifest.resourceType}.`)) {
          problems.push(`${entryPath}: path does not start with ${manifest.resourceType}.`);
        }
        if (entry.disposition === 'pending' && !entry.backlog) {
          problems.push(`${entryPath}: pending without a backlog id — an untracked gap becomes permanent by accident.`);
        }
        if (entry.disposition === 'acknowledged' && entry.backlog) {
          problems.push(`${entryPath}: acknowledged with a backlog id — decide whether it is a decision or a debt.`);
        }
        if (entry.reason.trim().length < 40) {
          problems.push(`${entryPath}: reason is too short to be an argument.`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe.each(COVERAGE)('$fixture.file', ({ fixture, coverage }) => {
  it('every populated element is either emitted or on the drop manifest', () => {
    const manifest = manifestFor(fixture.resourceType);
    const undeclared = coverage.dropped.filter((p) => !manifest?.drops[p]);
    expect(
      undeclared,
      `${fixture.resourceType}: these populated elements reach nothing in the converted output and no drop ` +
        `manifest accounts for them. Either emit them, or add an entry to ` +
        `src/lib/fhir-converter/field-coverage/manifests/ saying why they are not emitted.`,
    ).toEqual([]);
  });

  it('no element is untestable', () => {
    expect(
      coverage.untestable,
      'An element that could not be deleted was not measured. Reporting it as either kept or dropped would be a guess.',
    ).toEqual([]);
  });

  it('the fixture exercises both outcomes', () => {
    // A fixture that emits everything, or drops everything, is not measuring the
    // converter — it is measuring itself.
    expect(coverage.emitted.length).toBeGreaterThan(0);
    expect(coverage.dropped.length + coverage.emitted.length).toBeGreaterThan(10);
  });
});

describe('drop manifests stay honest', () => {
  it('no manifest entry describes a drop that no longer happens at that level', () => {
    // Two ways an entry goes stale, and the message says which, because the two
    // read very differently to whoever has to act on it:
    //
    //   EMITTED — the converter now carries the field. This is what a fix looks
    //   like from here, and finishing the fix means deleting the entry.
    //
    //   COVERED BY A DROPPED ANCESTOR — the field is still lost, but the loss is
    //   now reported one level up, because the walk stops descending at a drop.
    //   Wave 1 produced exactly this: role-aware provider selection moved the
    //   drop from `participant[0].type` to the whole of `participant[0]`.
    //
    // Both mean delete, and calling the second one "emitted" would tell a reader
    // their data is safe when it is not.
    const stale: string[] = [];
    for (const manifest of FIELD_DROP_MANIFESTS) {
      for (const entryPath of Object.keys(manifest.drops)) {
        const key = `${manifest.resourceType}|${entryPath}`;
        if (!POPULATED_SOMEWHERE.has(key)) continue;
        if (DROPPED_SOMEWHERE.has(key)) continue;
        stale.push(
          `${entryPath} — ${EMITTED_SOMEWHERE.has(key) ? 'EMITTED now' : 'still dropped, but covered by a dropped ancestor'}`,
        );
      }
    }
    expect(
      stale,
      'These manifest entries no longer describe a drop measured at their own path. Delete them.',
    ).toEqual([]);
  });

  it('no manifest entry names a path no fixture populates', () => {
    const unexercised: string[] = [];
    for (const manifest of FIELD_DROP_MANIFESTS) {
      for (const entryPath of Object.keys(manifest.drops)) {
        if (!POPULATED_SOMEWHERE.has(`${manifest.resourceType}|${entryPath}`)) {
          unexercised.push(entryPath);
        }
      }
    }
    expect(
      unexercised,
      'An entry no fixture populates can never be proven stale, so it would outlive the omission it describes. ' +
        'Either populate the path in the fixture or delete the entry.',
    ).toEqual([]);
  });

  it('every pending entry carries a backlog id and every acknowledged one carries none', () => {
    // Restated here as a corpus-wide count so the numbers appear in the run,
    // and so a manifest added later without either property is visible.
    const pending = FIELD_DROP_MANIFESTS.flatMap((m) =>
      Object.values(m.drops).filter((e) => e.disposition === 'pending'),
    );
    const acknowledged = FIELD_DROP_MANIFESTS.flatMap((m) =>
      Object.values(m.drops).filter((e) => e.disposition === 'acknowledged'),
    );
    expect(pending.every((e) => typeof e.backlog === 'string' && e.backlog.length > 0)).toBe(true);
    expect(acknowledged.every((e) => e.backlog === undefined)).toBe(true);
    expect(pending.length + acknowledged.length).toBe(
      FIELD_DROP_MANIFESTS.reduce((n, m) => n + Object.keys(m.drops).length, 0),
    );
  });
});

describe('the measurement itself', () => {
  /**
   * The differential is only as good as its deletion step. If `withoutPath` ever
   * stopped removing anything, every path would measure as emitted, every drop
   * would disappear, and the whole suite above would pass while proving nothing.
   * These pin the mechanism rather than the converters.
   */
  it('deleting a path removes exactly that path', () => {
    const encounter = FIXTURES.find((f) => f.resourceType === 'Encounter')!.resource;
    const reduced = withoutPath(encounter, 'Encounter.type[1]');
    expect(reduced).toBeDefined();
    expect((encounter.type as unknown[]).length).toBe(4);
    expect(((reduced as Record<string, unknown>).type as unknown[]).length).toBe(3);
    // Spliced out, not blanked: index 1 is now what index 2 was.
    expect(((reduced as Record<string, unknown>).type as unknown[])[1]).toEqual(
      (encounter.type as unknown[])[2],
    );
    // And the original is untouched, so one measurement cannot poison the next.
    expect((encounter.type as unknown[]).length).toBe(4);
  });

  it('a path that does not resolve is reported, never treated as unchanged', () => {
    const encounter = FIXTURES.find((f) => f.resourceType === 'Encounter')!.resource;
    expect(withoutPath(encounter, 'Encounter.noSuchField')).toBeUndefined();
    expect(withoutPath(encounter, 'Encounter.type[99]')).toBeUndefined();
    expect(withoutPath(encounter, 'not a path')).toBeUndefined();
  });

  it('enumeration reaches array tails and one level of qualifier', () => {
    const encounter = FIXTURES.find((f) => f.resourceType === 'Encounter')!.resource;
    const top = topLevelFieldPaths(encounter);
    expect(top).toContain('Encounter.type');
    expect(top).toContain('Encounter.participant');
    expect(childFieldPaths(encounter, 'Encounter.type')).toEqual([
      'Encounter.type[0]',
      'Encounter.type[1]',
      'Encounter.type[2]',
      'Encounter.type[3]',
    ]);
    expect(childFieldPaths(encounter, 'Encounter.class')).toContain('Encounter.class.display');
    expect(childFieldPaths(encounter, 'Encounter.participant[1]')).toContain(
      'Encounter.participant[1].type',
    );
    // Bounded: nothing below two named steps.
    expect(childFieldPaths(encounter, 'Encounter.participant[1].type')).toEqual([]);
  });

  it('the three known loss modes are each measured as a drop', () => {
    // Not an assertion about which fields SHOULD be lost — the manifests hold
    // that — but proof that the instrument detects all three shapes. If a wave
    // lands that fixes one of these, its manifest entry goes stale and the test
    // above fails first, which is the intended order.
    const encounter = COVERAGE.find((c) => c.fixture.resourceType === 'Encounter')!.coverage;
    // Never read. Was `Encounter.reasonCode` until wave 4 emitted it, which is
    // the intended order this comment describes happening: the manifest entry
    // went stale, the test above failed first, and the exemplar moved to a field
    // still exhibiting the mode. `serviceType` — the specialty the visit was
    // booked under — is read by no line of `convertEncounter`.
    expect(encounter.dropped).toContain('Encounter.serviceType');
    // Read for identity, never written as a fact. `Encounter.identifier` was the
    // exemplar of this mode and is now emitted (wave 2, the encounter join key),
    // so the mode is pinned on the resource that still exhibits it: a
    // DiagnosticReport's `identifier` reaches the identity seed and no triple.
    const report = COVERAGE.find((c) => c.fixture.resourceType === 'DiagnosticReport')!.coverage;
    expect(report.dropped).toContain('DiagnosticReport.identifier');
    // And the exemplar's fix is pinned in the same place the gap was, so a
    // regression that stops emitting it fails HERE as well as in the manifest.
    expect(encounter.emitted).toContain('Encounter.identifier');
    // Partial array: the head is emitted, the tail is not.
    expect(encounter.emitted).toContain('Encounter.type[0]');
    expect(encounter.dropped).toContain('Encounter.type[1]');
  });
});
