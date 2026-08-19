/**
 * A DERIVED reference edge must not be read as evidence that two copies of one
 * record are two different records.
 *
 * WHAT WENT WRONG
 * ---------------
 * `clinical:parsedIndicationReference` and `clinical:linkedCondition` are not
 * stated by any source. `liftTrappedLiterals` derives them at the END of an
 * import, from a reason the converter captured or from the UUIDs packed into a
 * `clinical:linkedConditionIds` literal. Reconciliation runs BEFORE that pass,
 * so the two copies of one record it compares were caught at different stages
 * of one pipeline:
 *
 *   - the copy read back out of the POD is post-lift and carries the derived
 *     edge pointing at a real subject, or carries nothing because the reason
 *     matched no condition and the pass dropped it;
 *   - the copy from the BATCH is pre-lift and carries an opaque
 *     `urn:cascade:parsed-indication:` placeholder holding the reason's codes,
 *     or nothing at all on `clinical:linkedCondition` because the pass has not
 *     run yet.
 *
 * Compared as written those never agree, so the content fingerprint declared
 * them materially different records that the identity layer had put on one IRI:
 * a false identity collision, a split onto a second IRI, and an unresolved
 * conflict labelled "differs on clinical:parsedIndicationReference" for two
 * records identical in everything a source ever said, source record id
 * included.
 *
 * MEASURED AGAINST THE PRE-FIX BUILD
 *   - re-importing the reason-code bundle once: 3 identity collisions, 3
 *     unresolved conflicts, and the pod grew from 6 records to 9. A third
 *     import grew it again.
 *   - re-importing the linked-conditions fixture once: 1 identity collision and
 *     the pod grew from 2 records to 3.
 *
 * THE FIX, AND WHY IT IS NOT "IGNORE THE PREDICATE"
 * -------------------------------------------------
 * Both sides are put through the SAME derivation and what is compared is the
 * edge set the lift will actually write. Simply dropping these predicates from
 * the fingerprint would remove the false conflicts and the true ones together:
 * two records whose parsed indications genuinely point at different conditions
 * would compare equal and one would be discarded as a duplicate. So both
 * directions are pinned below, and the "still conflicts" half is the one that
 * fails if the fix is ever loosened into an ignore-list.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseTurtle,
  splitIdentityCollisions,
  recordContentFingerprint,
  buildDerivedReferenceValues,
} from '../src/lib/reconciler.js';
import {
  DERIVED_REFERENCE_PREDICATES,
  parsedIndicationPlaceholder,
} from '../src/lib/literal-lifting.js';
import { Parser } from 'n3';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'dist', 'index.js');
const REASONCODE_BUNDLE = path.join(REPO, 'test-fixtures', 'graph-meaning-m1-reasoncode-bundle.json');
const LINKED_FIXTURE = path.join(REPO, 'test-fixtures', 'derived-reference-linked-conditions.ttl');

const CLIN = 'https://ns.cascadeprotocol.org/clinical/v1#';
const PARSED_INDICATION = `${CLIN}parsedIndicationReference`;
const LINKED_CONDITION = `${CLIN}linkedCondition`;

const roots: string[] = [];

function cli(args: string[]): { output: string; status: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', timeout: 300000 });
  return { output: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status ?? 1 };
}

/** Init a pod, drop `fixture` into an input directory, and return both paths. */
function podWithInput(fixture: string, basename: string): { podDir: string; inputs: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'derived-ref-'));
  roots.push(root);
  const podDir = path.join(root, 'pod');
  const inputs = path.join(root, 'inputs');
  fs.mkdirSync(inputs);
  fs.copyFileSync(fixture, path.join(inputs, basename));

  expect(cli(['pod', 'init', podDir]).status).toBe(0);
  return { podDir, inputs };
}

/** Total records the pod holds, across every registered bucket. */
function recordCount(podDir: string): number {
  const r = cli(['--json', 'pod', 'query', podDir, '--all']);
  expect(r.status, r.output).toBe(0);
  const parsed = JSON.parse(r.output) as { dataTypes: Record<string, { count: number }> };
  return Object.values(parsed.dataTypes).reduce((n, b) => n + b.count, 0);
}

function unresolvedConflicts(podDir: string): number {
  const r = cli(['pod', 'conflicts', podDir, '--format', 'json']);
  return (JSON.parse(r.output) as unknown[]).length;
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error('dist/index.js is missing. Run `npm run build` before `npm test`.');
  }
});

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Direction 1: a content-identical restatement no longer conflicts
// ---------------------------------------------------------------------------

describe('re-importing one unchanged file whose records carry a parsed indication', () => {
  it('raises no identity collision and does not grow the pod', () => {
    const { podDir, inputs } = podWithInput(REASONCODE_BUNDLE, 'bundle.json');

    const first = cli(['pod', 'import', podDir, inputs, '--reconcile-existing']);
    expect(first.status, first.output).toBe(0);
    const afterFirst = recordCount(podDir);
    expect(afterFirst).toBe(6);

    const second = cli(['pod', 'import', podDir, inputs, '--reconcile-existing']);
    expect(second.status, second.output).toBe(0);
    expect(second.output).not.toContain('identity collision');
    expect(recordCount(podDir)).toBe(afterFirst);
    expect(unresolvedConflicts(podDir)).toBe(0);
  });

  it('stays flat over a third import, so the growth is not merely deferred', () => {
    // Each false split minted a NEW iri that the next import collided with in
    // turn, so a fix that only survived one re-import would still grow without
    // bound. Three imports is the shortest run that shows the difference.
    const { podDir, inputs } = podWithInput(REASONCODE_BUNDLE, 'bundle.json');
    for (let i = 0; i < 3; i++) {
      expect(cli(['pod', 'import', podDir, inputs, '--reconcile-existing']).status).toBe(0);
    }
    expect(recordCount(podDir)).toBe(6);
    expect(unresolvedConflicts(podDir)).toBe(0);
  });

  it('keeps the derived edge itself: suppressing the conflict must not drop the edge', () => {
    const { podDir, inputs } = podWithInput(REASONCODE_BUNDLE, 'bundle.json');
    expect(cli(['pod', 'import', podDir, inputs, '--reconcile-existing']).status).toBe(0);
    expect(cli(['pod', 'import', podDir, inputs, '--reconcile-existing']).status).toBe(0);

    const medications = fs.readFileSync(path.join(podDir, 'clinical', 'medications.ttl'), 'utf-8');
    const quads = new Parser({ format: 'Turtle' }).parse(medications);
    // One lisinopril -> hypertension parsed indication, exactly one copy of it.
    expect(quads.filter((q) => q.predicate.value === PARSED_INDICATION)).toHaveLength(1);
    // And no placeholder ever reached disk.
    expect(medications).not.toContain('urn:cascade:parsed-indication:');
  });
});

describe('re-importing one unchanged file whose records carry linked-condition ids', () => {
  it('raises no identity collision and does not grow the pod', () => {
    const { podDir, inputs } = podWithInput(LINKED_FIXTURE, 'linked.ttl');

    expect(cli(['pod', 'import', podDir, inputs, '--reconcile-existing']).status).toBe(0);
    expect(recordCount(podDir)).toBe(2);

    const second = cli(['pod', 'import', podDir, inputs, '--reconcile-existing']);
    expect(second.status, second.output).toBe(0);
    expect(second.output).not.toContain('identity collision');
    expect(recordCount(podDir)).toBe(2);
    expect(unresolvedConflicts(podDir)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Direction 2: a genuine disagreement still conflicts
// ---------------------------------------------------------------------------

const HYPERLIPIDEMIA = 'urn:uuid:cccccccc-0000-4000-8000-000000000001';
const DIABETES = 'urn:uuid:cccccccc-0000-4000-8000-000000000002';
const MED = 'urn:uuid:dddddddd-0000-4000-8000-000000000001';

const CONDITIONS = `
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .

<${HYPERLIPIDEMIA}> a health:ConditionRecord ;
    health:conditionName "Hyperlipidemia" ;
    health:snomedCode <http://snomed.info/sct/55822004> .

<${DIABETES}> a health:ConditionRecord ;
    health:conditionName "Type 2 diabetes mellitus" ;
    health:snomedCode <http://snomed.info/sct/44054006> .
`;

/** One medication stating the given parsed-indication object, verbatim. */
function medicationStating(object: string): string {
  return `${CONDITIONS}
<${MED}> a clinical:Medication ;
    clinical:drugName "simvastatin" ;
    clinical:sourceRecordId "med-1" ;
    clinical:parsedIndicationReference <${object}> .
`;
}

/** Reconcile two spellings of ONE iri and report which predicates disagreed. */
async function collisionOver(podTurtle: string, batchTurtle: string): Promise<string[] | null> {
  const podRecords = await parseTurtle(podTurtle, 'pod', true);
  const batchRecords = await parseTurtle(batchTurtle, 'batch', false);
  const allQuads = new Parser({ format: 'Turtle' }).parse(`${podTurtle}\n${batchTurtle}`);

  const derived = buildDerivedReferenceValues(allQuads);
  const split = splitIdentityCollisions([...podRecords, ...batchRecords], undefined, derived);

  const collision = split.collisions.find((c) => c.mintedUri === MED);
  return collision ? collision.differingPredicates : null;
}

describe('two records whose parsed indications genuinely differ', () => {
  it('still collide, and the conflict still names the derived predicate', async () => {
    const differing = await collisionOver(
      medicationStating(HYPERLIPIDEMIA),
      medicationStating(DIABETES),
    );
    expect(differing).not.toBeNull();
    expect(differing).toContain(PARSED_INDICATION);
  });

  it('still collide when one side states it and the other only implies it', async () => {
    // The half that an ignore-list fix would break: the batch copy carries a
    // placeholder for DIABETES, which re-derives to a different condition than
    // the hyperlipidemia the pod copy states. Re-derivation must resolve it, and
    // then still find the two unequal.
    const placeholder = parsedIndicationPlaceholder(
      ['http://snomed.info/sct/44054006'], 'Type 2 diabetes mellitus',
    );
    const differing = await collisionOver(
      medicationStating(HYPERLIPIDEMIA),
      medicationStating(placeholder),
    );
    expect(differing).not.toBeNull();
    expect(differing).toContain(PARSED_INDICATION);
  });

  it('do NOT collide when the placeholder re-derives to the condition the pod already states', async () => {
    // The same comparison with the codes agreeing. This is the pair that used to
    // conflict, and it is the control for the two assertions above: without it,
    // a fingerprint that simply always disagreed would pass them both.
    const placeholder = parsedIndicationPlaceholder(
      ['http://snomed.info/sct/55822004'], 'Hyperlipidemia',
    );
    const differing = await collisionOver(
      medicationStating(HYPERLIPIDEMIA),
      medicationStating(placeholder),
    );
    expect(differing).toBeNull();
  });
});

describe('two records whose linked conditions genuinely differ', () => {
  const linkedTo = (uuid: string) => `${CONDITIONS}
<${MED}> a clinical:Medication ;
    clinical:drugName "simvastatin" ;
    clinical:sourceRecordId "med-1" ;
    clinical:linkedConditionIds "${uuid}" .
`;

  it('still collide', async () => {
    const differing = await collisionOver(
      linkedTo('cccccccc-0000-4000-8000-000000000001'),
      linkedTo('cccccccc-0000-4000-8000-000000000002'),
    );
    expect(differing).not.toBeNull();
    // The deriving literal differs too, and BOTH are reported: the derived edge
    // is not silently dropped from the explanation.
    expect(differing).toContain(LINKED_CONDITION);
  });

  it('do NOT collide when one side has already had the edge derived onto it', async () => {
    const stated = `${CONDITIONS}
<${MED}> a clinical:Medication ;
    clinical:drugName "simvastatin" ;
    clinical:sourceRecordId "med-1" ;
    clinical:linkedConditionIds "cccccccc-0000-4000-8000-000000000001" ;
    clinical:linkedCondition <${HYPERLIPIDEMIA}> .
`;
    const differing = await collisionOver(
      stated,
      linkedTo('cccccccc-0000-4000-8000-000000000001'),
    );
    expect(differing).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The chokepoint itself
// ---------------------------------------------------------------------------

describe('the derived-reference predicate set', () => {
  it('holds both predicates the lift derives, and nothing it merely reads', () => {
    expect([...DERIVED_REFERENCE_PREDICATES].sort()).toEqual([LINKED_CONDITION, PARSED_INDICATION]);
    // A STATED reference is the source's own claim and must keep counting as
    // content. Putting it here would hide a real disagreement about what a
    // record says.
    expect(DERIVED_REFERENCE_PREDICATES.has(`${CLIN}indicationReference`)).toBe(false);
  });

  it('re-derives every predicate in the set, so adding one without wiring it fails here', async () => {
    // The tripwire for the next derived edge family. A predicate listed in the
    // set but not handled by `buildDerivedReferenceValues` returns [] for every
    // record, which silently turns the set entry into an ignore-list entry: the
    // false conflicts go away and the true ones go with them.
    const implying = `${CONDITIONS}
<${MED}> a clinical:Medication ;
    clinical:drugName "simvastatin" ;
    clinical:linkedConditionIds "cccccccc-0000-4000-8000-000000000001" ;
    clinical:parsedIndicationReference <${DIABETES}> .
`;
    const records = await parseTurtle(implying, 'batch', false);
    const quads = new Parser({ format: 'Turtle' }).parse(implying);
    const derived = buildDerivedReferenceValues(quads);
    const record = records.find((r) => r.uri === MED)!;

    for (const predicate of DERIVED_REFERENCE_PREDICATES) {
      expect(derived(record, predicate), `${predicate} re-derived to nothing`).not.toEqual([]);
    }
  });

  it('leaves the fingerprint sensitive to everything else', async () => {
    // The derived predicates are re-derived, not excused. A difference in
    // ordinary content must still change the fingerprint, or the fix would have
    // quietly widened into "records with indications never collide".
    const a = (await parseTurtle(medicationStating(HYPERLIPIDEMIA), 'a', false))
      .find((r) => r.uri === MED)!;
    const b = (await parseTurtle(
      medicationStating(HYPERLIPIDEMIA).replace('"simvastatin"', '"lovastatin"'), 'b', false,
    )).find((r) => r.uri === MED)!;

    const quads = new Parser({ format: 'Turtle' }).parse(medicationStating(HYPERLIPIDEMIA));
    const derived = buildDerivedReferenceValues(quads);
    expect(recordContentFingerprint(a, undefined, undefined, derived))
      .not.toBe(recordContentFingerprint(b, undefined, undefined, derived));
  });
});
