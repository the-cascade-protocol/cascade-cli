/**
 * Tests for slice M1 (graph-meaning #2): lifting relation-shaped LITERALS into
 * real, traversable, basis-labeled edges.
 *
 * Two families, two fixtures, both synthetic and PHI-free:
 *
 *  (a) `test-fixtures/checkup-linked-conditions.ttl` — a trimmed Cascade Checkup
 *      export. Exercises `clinical:linkedConditionIds` (comma AND space
 *      delimited, plus one dangling UUID) and the free-text
 *      `checkup:reasonForUse` path that only the name fallback can resolve.
 *
 *  (b) `test-fixtures/graph-meaning-m1-reasoncode-bundle.json` — a FHIR bundle
 *      whose medications/procedures carry `reasonCode`. Exercises the code-first
 *      match, the unmappable-code-system skip (ICD-9), the "already stated"
 *      suppression when `reasonReference` covers the same condition, and the
 *      retained `clinical:indication` literal.
 *
 * The invariants under test, beyond the counts:
 *   - an edge is written ONLY when it resolves unambiguously;
 *   - the source literal is always retained (nothing is lost even unresolved);
 *   - no parsed-indication placeholder ever survives into serialized output;
 *   - the pass is idempotent, so re-import does not grow duplicate edges.
 */

import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import type { Quad } from 'n3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import { convert } from '../src/lib/fhir-converter/index.js';
import { liftTrappedLiterals, emptyLiftSummary } from '../src/lib/literal-lifting.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REASONCODE_BUNDLE = resolve(__dirname, '../test-fixtures/graph-meaning-m1-reasoncode-bundle.json');
const CHECKUP_TTL = resolve(__dirname, '../test-fixtures/checkup-linked-conditions.ttl');

const NS_CLIN = 'https://ns.cascadeprotocol.org/clinical/v1#';
const NS_CHECKUP = 'https://ns.cascadeprotocol.org/checkup/v1#';
const PARSED_INDICATION = NS_CLIN + 'parsedIndicationReference';
const STATED_INDICATION = NS_CLIN + 'indicationReference';
const LINKED_CONDITION = NS_CLIN + 'linkedCondition';
const LINKED_CONDITION_IDS = NS_CLIN + 'linkedConditionIds';
const INDICATION_TEXT = NS_CLIN + 'indication';

function parse(ttl: string): Quad[] {
  return new Parser({ format: 'Turtle' }).parse(ttl);
}

function countPredicate(quads: Quad[], predicate: string): number {
  return quads.filter((q) => q.predicate.value === predicate).length;
}

function objectsOf(quads: Quad[], predicate: string): string[] {
  return quads.filter((q) => q.predicate.value === predicate).map((q) => q.object.value).sort();
}

// ---------------------------------------------------------------------------
// (b) FHIR reasonCode -> parsed indication edge
// ---------------------------------------------------------------------------

describe('M1 (b): FHIR reasonCode lifted to clinical:parsedIndicationReference', () => {
  it('matches code-first, retains the literal, and never writes an unresolved edge', async () => {
    const bundle = readFileSync(REASONCODE_BUNDLE, 'utf-8');
    const result = await convert(bundle, 'fhir', 'cascade', 'turtle', 'test-system');
    expect(result.success).toBe(true);

    const quads = parse(result.output);

    // Two reasons resolve by exact SNOMED identity: lisinopril -> hypertension,
    // and the retinopathy screening -> type 2 diabetes (whose ICD-9 coding is
    // skipped as unmappable, so the SNOMED sibling is what matches).
    expect(result.literalLifting).toBeDefined();
    expect(result.literalLifting!.parsedIndication).toEqual({
      lifted: 2,
      ambiguous: 0,
      // warfarin's atrial-fibrillation reason has no condition record here
      unmatched: 1,
      // metformin already states the same condition via reasonReference
      redundant: 1,
    });
    expect(countPredicate(quads, PARSED_INDICATION)).toBe(2);

    // The stated edge is untouched and still exactly one (R3 behavior).
    expect(countPredicate(quads, STATED_INDICATION)).toBe(1);

    // Every reason is retained as text, including the one that matched nothing:
    // four reasonCode-bearing records in, four literals out.
    expect(countPredicate(quads, INDICATION_TEXT)).toBe(4);
    expect(objectsOf(quads, INDICATION_TEXT)).toContain('Atrial fibrillation');
  });

  it('leaves no parsed-indication placeholder in serialized output', async () => {
    const bundle = readFileSync(REASONCODE_BUNDLE, 'utf-8');
    const result = await convert(bundle, 'fhir', 'cascade', 'turtle', 'test-system');
    expect(result.output).not.toContain('urn:cascade:parsed-indication:');
    expect(result.output).not.toContain('urn:cascade:unresolved-ref:');
  });

  it('is deterministic: converting twice yields byte-identical output', async () => {
    const bundle = readFileSync(REASONCODE_BUNDLE, 'utf-8');
    const a = await convert(bundle, 'fhir', 'cascade', 'turtle', 'test-system');
    const b = await convert(bundle, 'fhir', 'cascade', 'turtle', 'test-system');
    expect(a.output).toBe(b.output);
  });

  it('defers the lift when the caller owns a wider scope', async () => {
    const bundle = readFileSync(REASONCODE_BUNDLE, 'utf-8');
    const deferred = await convert(
      bundle, 'fhir', 'cascade', 'turtle', 'test-system', false, undefined, true,
    );
    // The caller (pod import) is responsible for resolving these, so the
    // placeholders are still present and no tally was computed here.
    expect(deferred.literalLifting).toBeUndefined();
    expect(deferred.output).toContain('urn:cascade:parsed-indication:');
  });
});

// ---------------------------------------------------------------------------
// (a) linkedConditionIds -> linkedCondition
// ---------------------------------------------------------------------------

describe('M1 (a): clinical:linkedConditionIds lifted to clinical:linkedCondition', () => {
  it('parses both delimiters, drops the dangling UUID, and retains the literal', () => {
    const quads = parse(readFileSync(CHECKUP_TTL, 'utf-8'));
    const { quads: lifted, stats } = liftTrappedLiterals(quads);

    // cond1 -> cond2 (one dangling UUID alongside it), cond2 -> cond1,
    // and cond3 -> both, written with a SPACE delimiter.
    expect(stats.linkedCondition).toEqual({ lifted: 4, unresolved: 1 });
    expect(countPredicate(lifted, LINKED_CONDITION)).toBe(4);

    // The deprecated source literal is retained this slice.
    expect(countPredicate(lifted, LINKED_CONDITION_IDS)).toBe(3);

    // The dangling UUID is nowhere in the output.
    const targets = objectsOf(lifted, LINKED_CONDITION);
    expect(targets.some((t) => t.includes('99999999'))).toBe(false);
  });

  it('resolves a UUID carried in a relative fragment subject (the real Checkup form)', () => {
    // CheckupSerializer writes `<#condition-{uuid}>`, which n3 keeps relative
    // when no base is supplied. The UUID must still be found.
    const ttl = `
      @prefix clinical: <${NS_CLIN}> .
      @prefix checkup: <${NS_CHECKUP}> .
      <#condition-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa> a checkup:ConditionSummary ;
          checkup:conditionName "Root condition" .
      <#condition-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb> a checkup:ConditionSummary ;
          checkup:conditionName "Complication" ;
          clinical:linkedConditionIds "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" .
    `;
    const { quads, stats } = liftTrappedLiterals(parse(ttl));
    expect(stats.linkedCondition).toEqual({ lifted: 1, unresolved: 0 });
    expect(objectsOf(quads, LINKED_CONDITION)).toEqual(['#condition-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
  });

  it('never links a condition to itself', () => {
    const ttl = `
      @prefix clinical: <${NS_CLIN}> .
      @prefix checkup: <${NS_CHECKUP}> .
      <https://ex.org/condition-cccccccc-cccc-4ccc-8ccc-cccccccccccc> a checkup:ConditionSummary ;
          checkup:conditionName "Self referencing" ;
          clinical:linkedConditionIds "cccccccc-cccc-4ccc-8ccc-cccccccccccc" .
    `;
    const { quads, stats } = liftTrappedLiterals(parse(ttl));
    expect(countPredicate(quads, LINKED_CONDITION)).toBe(0);
    expect(stats.linkedCondition.unresolved).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Free-text indication with no coded candidate (Turtle passthrough path)
// ---------------------------------------------------------------------------

describe('M1 (b): free-text indication literals', () => {
  it('lifts an unambiguous name match and leaves an unmatched one as text', () => {
    const quads = parse(readFileSync(CHECKUP_TTL, 'utf-8'));
    const { quads: lifted, stats } = liftTrappedLiterals(quads);

    // "Chronic kidney disease" names a condition in the same file; "General
    // wellness" names nothing.
    expect(stats.parsedIndication.lifted).toBe(1);
    expect(stats.parsedIndication.unmatched).toBe(1);
    expect(countPredicate(lifted, PARSED_INDICATION)).toBe(1);
    // Both reasonForUse literals survive regardless.
    expect(countPredicate(lifted, NS_CHECKUP + 'reasonForUse')).toBe(2);
  });

  it('does not write an edge when the name is ambiguous across conditions', () => {
    const ttl = `
      @prefix clinical: <${NS_CLIN}> .
      @prefix checkup: <${NS_CHECKUP}> .
      <https://ex.org/cond-1> a checkup:ConditionSummary ; checkup:conditionName "Anemia" .
      <https://ex.org/cond-2> a checkup:ConditionSummary ; checkup:conditionName "anemia" .
      <https://ex.org/supp-1> a checkup:SupplementSummary ; checkup:reasonForUse "Anemia" .
    `;
    const { quads, stats } = liftTrappedLiterals(parse(ttl));
    expect(countPredicate(quads, PARSED_INDICATION)).toBe(0);
    expect(stats.parsedIndication.ambiguous).toBe(1);
    expect(stats.parsedIndication.lifted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotence (regression: mismatched edge-key separators silently duplicated)
// ---------------------------------------------------------------------------

describe('M1 idempotence', () => {
  it('re-running over already-lifted output adds nothing', () => {
    const first = liftTrappedLiterals(parse(readFileSync(CHECKUP_TTL, 'utf-8')));
    const second = liftTrappedLiterals(first.quads);

    expect(second.stats.linkedCondition.lifted).toBe(0);
    expect(second.stats.parsedIndication.lifted).toBe(0);
    // The already-present parsed edge is reported as redundant, not rewritten.
    expect(second.stats.parsedIndication.redundant).toBe(1);

    expect(countPredicate(second.quads, LINKED_CONDITION))
      .toBe(countPredicate(first.quads, LINKED_CONDITION));
    expect(countPredicate(second.quads, PARSED_INDICATION))
      .toBe(countPredicate(first.quads, PARSED_INDICATION));
  });

  it('suppresses a parsed edge the record already states via reasonReference', () => {
    const ttl = `
      @prefix clinical: <${NS_CLIN}> .
      @prefix checkup: <${NS_CHECKUP}> .
      <https://ex.org/cond-a> a checkup:ConditionSummary ; checkup:conditionName "Hypertension" .
      <https://ex.org/med-1> a clinical:Medication ;
          clinical:indication "Hypertension" ;
          clinical:indicationReference <https://ex.org/cond-a> .
    `;
    const { quads, stats } = liftTrappedLiterals(parse(ttl));
    expect(countPredicate(quads, PARSED_INDICATION)).toBe(0);
    expect(stats.parsedIndication.redundant).toBe(1);
    expect(countPredicate(quads, STATED_INDICATION)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

describe('M1 summary helpers', () => {
  it('starts empty and stays a pure tally', () => {
    const s = emptyLiftSummary();
    expect(s.linkedCondition).toEqual({ lifted: 0, unresolved: 0 });
    expect(s.parsedIndication).toEqual({ lifted: 0, ambiguous: 0, unmatched: 0, redundant: 0 });
  });

  it('does not mutate its input quad array', () => {
    const quads = parse(readFileSync(CHECKUP_TTL, 'utf-8'));
    const before = quads.length;
    liftTrappedLiterals(quads);
    expect(quads.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// R4 carry-through: the reconciler must redirect the NEW predicates too
// ---------------------------------------------------------------------------

describe('M1 x R4: reconciler carries the lifted predicates through a merge', () => {
  const PREFIXES = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <${NS_CLIN}> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
`;
  const COND_QUEST = 'urn:uuid:cond-quest-0001';
  const COND_LABCORP = 'urn:uuid:cond-labcorp-0001';
  const MED = 'urn:uuid:med-0001';
  const OTHER_COND = 'urn:uuid:cond-other-0001';

  // Bundle A: a medication whose LIFTED edges point at quest's condition, plus
  // a second condition whose lifted linkedCondition also points at it.
  const BUNDLE_A = `${PREFIXES}
<${MED}> a clinical:Medication ;
  clinical:drugName "Lisinopril" ;
  clinical:parsedIndicationReference <${COND_QUEST}> .

<${OTHER_COND}> a health:ConditionRecord ;
  cascade:sourceSystem "quest" ;
  health:conditionName "Chronic kidney disease" ;
  health:snomedCode <http://snomed.info/sct/709044004> ;
  clinical:linkedCondition <${COND_QUEST}> .

<${COND_QUEST}> a health:ConditionRecord ;
  cascade:sourceSystem "quest" ;
  health:conditionName "Essential hypertension" ;
  health:snomedCode <http://snomed.info/sct/59621000> .
`;

  // Bundle B: the same condition from a higher-trust source, so quest's copy
  // is merged away and both lifted edges must follow the survivor.
  const BUNDLE_B = `${PREFIXES}
<${COND_LABCORP}> a health:ConditionRecord ;
  cascade:sourceSystem "labcorp" ;
  health:conditionName "Essential hypertension" ;
  health:snomedCode <http://snomed.info/sct/59621000> .
`;

  it('redirects parsedIndicationReference and linkedCondition to the survivor', async () => {
    const { runReconciliation } = await import('../src/lib/reconciler.js');
    const result = await runReconciliation(
      [{ content: BUNDLE_A, systemName: 'quest' }, { content: BUNDLE_B, systemName: 'labcorp' }],
      { trustScores: { labcorp: 0.95, quest: 0.8 } },
    );

    const quads = parse(result.turtle);
    const subjects = new Set(quads.map((q) => q.subject.value));

    // The duplicate conditions merged; quest's copy is gone.
    expect(subjects.has(COND_QUEST)).toBe(false);

    const survivor = subjects.has(COND_LABCORP) ? COND_LABCORP : COND_QUEST;

    // Both lifted edge families now point at a subject that really exists.
    const parsed = quads
      .filter((q) => q.subject.value === MED && q.predicate.value === PARSED_INDICATION)
      .map((q) => q.object.value);
    const linked = quads
      .filter((q) => q.subject.value === OTHER_COND && q.predicate.value === LINKED_CONDITION)
      .map((q) => q.object.value);

    expect(parsed).toEqual([survivor]);
    expect(linked).toEqual([survivor]);
    expect(subjects.has(parsed[0])).toBe(true);
    expect(subjects.has(linked[0])).toBe(true);
  });
});
