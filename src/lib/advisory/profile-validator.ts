/**
 * Cascade Advisory Patch (CAP) — Profile Validator (TASK-4.2).
 *
 * Enforces the six CAP profile constraints defined in
 * `cascadeprotocol.org/drafts/advisory-v1/PROFILE.md`:
 *
 *   C1 — Operations restricted to `Add` (and a single `Bind`). No Delete /
 *        Cut / UpdateList. The parser already rejects out-of-profile keywords;
 *        the validator re-checks that the AST contains at least one Add and
 *        no semantically-Delete-like patterns slipped through.
 *
 *   C2 — At most one `Bind` per advisory, with predicate from a published
 *        whitelist and object as a fully-quoted string literal.
 *
 *   C3 — Only whitelisted vocabulary prefixes may be declared. No prefix
 *        manipulation after the initial @prefix block (parser already rejects
 *        late @prefix; validator double-checks the declared prefixes are on
 *        the published whitelist).
 *
 *   C4 — No IRI computation. Every IRI inserted by an Add must be either a
 *        fully-qualified literal from the patch text OR the bound `?var`.
 *        We enforce: no other variable references in Add objects/subjects,
 *        and the only legal variable is the one bound by the Bind clause.
 *
 *   C5 — At most 64 inserted triples per match (sum across all Add blocks).
 *
 *   C6 — Mandatory envelope metadata: `humanSummary`, `advisoryClass`,
 *        `issuer`, `issuedAt` are required.
 *
 * The validator is pure: it does not touch the filesystem, network, or any
 * pod state. Selector evaluation against a pod is TASK-4.4.
 */

import type { CapAst, CapTerm, CapTriple, CapViolation } from './types.js';
import {
  ADVISORY_NS,
  C2_WHITELISTED_BIND_PREDICATES,
  C5_MAX_INSERTED_TRIPLES,
  CASCADE_VOCAB_IRIS,
  GENOMICS_STANDARD_IRIS,
  W3C_VOCAB_IRIS,
} from './types.js';

export interface CapValidationResult {
  valid: boolean;
  violations: CapViolation[];
}

/** Validate a CAP AST against PROFILE.md §Constraints. */
export function validateCap(ast: CapAst): CapValidationResult {
  const violations: CapViolation[] = [];

  validateC1(ast, violations);
  validateC2(ast, violations);
  validateC3(ast, violations);
  validateC4(ast, violations);
  validateC5(ast, violations);
  validateC6(ast, violations);

  return { valid: violations.length === 0, violations };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* C1 — Add-only                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

function validateC1(ast: CapAst, out: CapViolation[]): void {
  if (ast.adds.length === 0) {
    out.push({
      code: 'C1',
      message:
        'CAP advisory must contain at least one Add operation; no operation produces triples (C1)',
    });
  }
  // The parser rejects Delete/Cut/UpdateList syntactically, so by the time we
  // have an AST there's no other operation type to check. C1 is structurally
  // satisfied by AST shape alone — this branch exists for defensive symmetry.
}

/* ────────────────────────────────────────────────────────────────────────── */
/* C2 — Single Bind, whitelisted predicate, literal object                    */
/* ────────────────────────────────────────────────────────────────────────── */

function validateC2(ast: CapAst, out: CapViolation[]): void {
  // CAP allows zero or one Bind. Multiple Binds are caught by the parser.
  if (!ast.bind) return;

  // Whitelisted predicate
  if (!C2_WHITELISTED_BIND_PREDICATES.includes(ast.bind.predicate)) {
    out.push({
      code: 'C2',
      message:
        `Bind predicate <${ast.bind.predicate}> is not in the CAP whitelist of stable identifiers ` +
        `(allowed: ${C2_WHITELISTED_BIND_PREDICATES.map((p) => `<${p}>`).join(', ')})`,
      location: ast.bind.pos,
    });
  }

  // Object must be a string literal (a fully-quoted literal — no variable, no IRI computation)
  if (ast.bind.object.kind !== 'literal') {
    out.push({
      code: 'C2',
      message: `Bind path object must be a string literal; got ${ast.bind.object.kind}`,
      location: ast.bind.pos,
    });
  }

  // Subject must be the bound variable
  if (
    ast.bind.subject.kind !== 'variable' ||
    ast.bind.subject.value !== ast.bind.variable
  ) {
    out.push({
      code: 'C2',
      message: 'Bind path subject must be the bound variable (single-identifier match)',
      location: ast.bind.pos,
    });
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* C3 — No prefix manipulation; only whitelisted vocabularies                 */
/* ────────────────────────────────────────────────────────────────────────── */

function validateC3(ast: CapAst, out: CapViolation[]): void {
  const allowed: ReadonlyArray<string> = [
    ...CASCADE_VOCAB_IRIS,
    ...W3C_VOCAB_IRIS,
    ...GENOMICS_STANDARD_IRIS,
  ];
  for (const [prefix, ns] of Object.entries(ast.prefixes)) {
    const onWhitelist = allowed.some(
      (allowedNs) => ns === allowedNs || ns.startsWith(allowedNs),
    );
    if (!onWhitelist) {
      out.push({
        code: 'C3',
        message:
          `Prefix '${prefix}:' maps to <${ns}>, which is not on the published CAP vocabulary whitelist (C3). ` +
          'Allowed: Cascade vocabularies, W3C standard prefixes (prov:, xsd:, rdfs:, owl:, rdf:, ldp:), ' +
          'and canonical genomics-standards prefixes (hpo:, mondo:, so:, clinvar:, omim:, hgnc:).',
      });
    }
  }
  // Late @prefix is caught by the parser (returns out_of_profile error before
  // an AST is produced); we therefore have nothing further to check here.
}

/* ────────────────────────────────────────────────────────────────────────── */
/* C4 — No IRI computation                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

function validateC4(ast: CapAst, out: CapViolation[]): void {
  const boundVarName = ast.bind?.variable ?? null;

  const checkTerm = (term: CapTerm, role: string, triple: CapTriple): void => {
    if (term.kind === 'variable') {
      if (boundVarName === null) {
        out.push({
          code: 'C4',
          message:
            `Add ${role} references variable ?${term.value}, but no Bind clause is declared. ` +
            'Variables in Adds must reference the bound ?var only (C4: no IRI computation).',
          location: triple.pos,
        });
      } else if (term.value !== boundVarName) {
        out.push({
          code: 'C4',
          message:
            `Add ${role} references ?${term.value}, but only the bound variable ?${boundVarName} ` +
            'is permitted in Adds (C4: no IRI computation).',
          location: triple.pos,
        });
      }
    }
    // Bnodes are allowed (anonymous local nodes, no computation involved).
    // IRIs and literals are by construction "fully-qualified literals from the patch text".
  };

  for (const add of ast.adds) {
    for (const triple of add.triples) {
      checkTerm(triple.subject, 'subject', triple);
      checkTerm(triple.object, 'object', triple);
      // Predicates are always IRIs in our AST (see parser); no need to check.
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* C5 — Bounded insert size                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function validateC5(ast: CapAst, out: CapViolation[]): void {
  const total = ast.adds.reduce((sum, a) => sum + a.triples.length, 0);
  if (total > C5_MAX_INSERTED_TRIPLES) {
    out.push({
      code: 'C5',
      message:
        `CAP advisory inserts ${total} triples per match; the profile permits at most ` +
        `${C5_MAX_INSERTED_TRIPLES} (C5: bounded insert size). Split into multiple advisories ` +
        'or use a non-CAP delivery mechanism.',
    });
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* C6 — Mandatory envelope metadata                                           */
/* ────────────────────────────────────────────────────────────────────────── */

function validateC6(ast: CapAst, out: CapViolation[]): void {
  const env = ast.envelope;

  // Type must include advisory:CascadeAdvisoryPatch
  const typeIri = `${ADVISORY_NS}CascadeAdvisoryPatch`;
  if (!env.types.includes(typeIri)) {
    out.push({
      code: 'C6',
      message:
        `Envelope must declare 'a advisory:CascadeAdvisoryPatch' (got types: [${env.types.join(', ')}])`,
      location: env.pos,
    });
  }

  // Required fields per PROFILE.md §C6
  const required: Array<[keyof typeof env, string]> = [
    ['profileVersion', 'advisory:profileVersion'],
    ['advisoryClass', 'advisory:advisoryClass'],
    ['issuer', 'advisory:issuer'],
    ['issuedAt', 'advisory:issuedAt'],
    ['humanSummary', 'advisory:humanSummary'],
  ];
  for (const [field, label] of required) {
    const v = env[field];
    if (typeof v !== 'string' || v.length === 0) {
      out.push({
        code: 'C6',
        message: `Envelope missing required field ${label} (C6: mandatory envelope metadata)`,
        location: env.pos,
      });
    }
  }
}
