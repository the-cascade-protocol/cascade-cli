/**
 * Cascade Advisory Patch (CAP) — Selector Evaluator (TASK-4.4).
 *
 * The CAP profile constraint C2 enforces that an advisory's Bind clause is a
 * single-identifier match: `?var <whitelisted-predicate> "<literal>"`. That
 * makes selector evaluation an indexed lookup, not a graph traversal — we
 * call `Store.match(null, predicate, object)` and walk the result.
 *
 * Each subject that matches the Bind triple-pattern produces one
 * `MatchResult`. The applier (TASK-4.5) instantiates the Add operations once
 * per match.
 *
 * Inapplicability is NOT an error: zero matches is a valid outcome — the
 * advisory is logged as inapplicable to this pod and the user sees nothing.
 *
 * Multiple matches are also valid: each is treated as a separate application.
 * For example, an advisory bound to `genomics:hgncId "HGNC:1100"` will match
 * every `Variant` that carries that HGNC ID — which is the right behavior for
 * a gene-level reclassification advisory.
 */

import type { Store } from 'n3';
import { DataFactory } from 'n3';
import type { CapAst } from './types.js';

const { namedNode, literal } = DataFactory;

/** A single Bind match — one binding of `?var` to an IRI from the pod. */
export interface MatchResult {
  /** The variable name (without leading '?'), e.g. 'v' for `?v`. */
  variable: string;
  /** The IRI the variable resolved to (always a NamedNode in CAP v0.1). */
  boundIri: string;
}

export interface EvaluateOptions {
  /**
   * Optional time budget in milliseconds. The selector returns whatever it has
   * matched so far if the budget is exhausted. Defaults to no budget.
   * Useful for tests of the sub-100ms target on synthetic 10k-record pods.
   */
  budgetMs?: number;
}

/**
 * Evaluate a CAP advisory's selector against a pod's RDF store.
 *
 * @param ast       The parsed CAP AST. Must have `bind` set; if `bind` is null,
 *                  the advisory is unconditional (matches once with an empty
 *                  binding map). The validator (TASK-4.2) doesn't currently
 *                  require a Bind, so we handle the null case gracefully.
 * @param podGraph  The pod's RDF store (n3.js `Store`). The caller is
 *                  responsible for loading the pod's TTL/JSON-LD into this
 *                  store first — see `src/lib/turtle-parser.ts` for the
 *                  standard loader.
 * @param options   Time budget + future tuning knobs.
 * @returns         Zero or more bindings. Empty array means the advisory is
 *                  inapplicable to this pod.
 */
export function evaluateSelector(
  ast: CapAst,
  podGraph: Store,
  options: EvaluateOptions = {},
): MatchResult[] {
  if (!ast.bind) {
    // Unconditional advisory — single empty binding. (Used rarely; mostly
    // safety-critical announcements that don't target a specific record.)
    return [{ variable: '', boundIri: '' }];
  }

  const bind = ast.bind;
  if (bind.object.kind !== 'literal') {
    // Validator C2 catches this; defensive return.
    return [];
  }

  const predicateNode = namedNode(bind.predicate);
  // Build the literal node — preserve datatype if the AST has one (the parser
  // emits a datatype on bind.object only if the source carried `^^xsd:...`,
  // which CAP profile §C2 currently allows but doesn't mandate).
  const objectNode = bind.object.datatype
    ? literal(bind.object.value, namedNode(bind.object.datatype))
    : bind.object.lang
      ? literal(bind.object.value, bind.object.lang)
      : literal(bind.object.value);

  const startedAt = Date.now();
  const out: MatchResult[] = [];

  // n3 Store.match returns an iterable of Quads. With concrete predicate +
  // object and an unbound subject, this is an indexed lookup — O(matches).
  for (const quad of podGraph.match(null, predicateNode, objectNode)) {
    if (options.budgetMs && Date.now() - startedAt > options.budgetMs) break;
    const subject = quad.subject;
    if (subject.termType !== 'NamedNode' && subject.termType !== 'BlankNode') {
      continue; // skip variables/literal subjects (shouldn't happen)
    }
    out.push({ variable: bind.variable, boundIri: subject.value });
  }

  // Also try the literal-without-datatype form: many serializers store
  // `"CA000123"` plain even when SHACL declares xsd:string. n3's `literal()`
  // call without a datatype produces an `xsd:string`-typed literal, which
  // n3 considers equal to the plain form — so the above match() catches both.
  // No second-pass needed in practice.

  return out;
}
