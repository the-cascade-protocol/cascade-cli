/**
 * Cascade Advisory Patch (CAP) — Auto-Apply Policy Engine (TASK-4.8).
 *
 * Pods may declare auto-apply policies of the form
 * "(issuer × advisoryClass) tuples that auto-apply silently". Default for any
 * non-matching tuple is `queue` — surface to user for explicit approval.
 *
 * Per D-QUALITY-TIER, even when a policy matches, auto-apply is REFUSED if
 * the advisory targets a Variant whose:
 *   - genomics:dataQualityTier is genomics:ConsumerGrade, OR
 *   - genomics:requiresConfirmation is true
 *
 * The reasoning: consumer-grade data and confirmation-required interpretations
 * carry enough false-positive risk that the user MUST be in the loop. Issuer
 * trust does not override this. The advisory is queued for approval (NOT
 * declined) — the user can still apply it manually after reviewing the source.
 *
 * Policies live at `<pod>/policies/auto-apply.ttl` as Turtle. Schema:
 *
 *   @prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
 *   @prefix advisory: <https://ns.cascadeprotocol.org/advisory/v1#> .
 *
 *   <urn:pod:policy:auto-apply:1> a cascade:AutoApplyPolicy ;
 *       cascade:trustsIssuer <https://clingen.org/affiliation/40016> ;
 *       cascade:trustsAdvisoryClass advisory:VariantReclassification .
 *
 * A policy may declare multiple `cascade:trustsAdvisoryClass` values; the
 * tuple matches if BOTH the issuer and the advisory class match.
 *
 * Decline tracking: declined advisories live in the per-pod cache (TASK-4.6,
 * status === 'declined'). We don't re-evaluate declined entries.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CapAst } from './types.js';
import { parseTurtle } from '../turtle-parser.js';
import { Store } from 'n3';

/** A single auto-apply policy declaration loaded from a pod. */
export interface AutoApplyPolicy {
  /** The policy IRI (subject of the rdf:type cascade:AutoApplyPolicy triple). */
  iri: string;
  /** Issuer IRI(s) this policy trusts. */
  issuers: ReadonlyArray<string>;
  /** Advisory class IRI(s) this policy trusts (full IRIs). */
  advisoryClasses: ReadonlyArray<string>;
}

export type PolicyDecision = 'auto-apply' | 'queue' | 'decline';

/** Optional context describing the bound record's quality flags. */
export interface BoundRecordQuality {
  /**
   * Full IRI of the matched record's `genomics:dataQualityTier`, if any.
   * Examples: `https://ns.cascadeprotocol.org/genomics/v1#ConsumerGrade`,
   * `https://ns.cascadeprotocol.org/genomics/v1#ClinicalGrade`.
   */
  dataQualityTier?: string;
  /** Whether the matched record carries `genomics:requiresConfirmation true`. */
  requiresConfirmation?: boolean;
}

const NS_CORE = 'https://ns.cascadeprotocol.org/core/v1#';
const NS_GENOMICS = 'https://ns.cascadeprotocol.org/genomics/v1#';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const AUTO_APPLY_POLICY_TYPE = `${NS_CORE}AutoApplyPolicy`;
const TRUSTS_ISSUER = `${NS_CORE}trustsIssuer`;
const TRUSTS_ADVISORY_CLASS = `${NS_CORE}trustsAdvisoryClass`;

const CONSUMER_GRADE = `${NS_GENOMICS}ConsumerGrade`;

/**
 * Decide whether an advisory may be auto-applied given the pod's policies and
 * the matched record's quality flags.
 *
 * Returns:
 *   - `'auto-apply'` if some policy trusts (issuer × advisoryClass) AND no
 *     D-QUALITY-TIER safety override applies.
 *   - `'queue'` otherwise (default behavior, including the safety override).
 *
 * The CAP envelope MUST carry both `issuer` and `advisoryClass`; otherwise the
 * decision defaults to `queue`. (The validator catches missing fields earlier;
 * this branch is defensive.)
 */
export function evaluatePolicy(
  advisory: CapAst,
  podPolicies: ReadonlyArray<AutoApplyPolicy>,
  boundQuality: BoundRecordQuality = {},
): PolicyDecision {
  const issuer = advisory.envelope.issuer;
  const advisoryClass = advisory.envelope.advisoryClass;
  if (!issuer || !advisoryClass) return 'queue';

  // ── 1. Match a policy on (issuer × advisoryClass) ─────────────────────
  let matched = false;
  for (const policy of podPolicies) {
    if (
      policy.issuers.includes(issuer) &&
      policy.advisoryClasses.includes(advisoryClass)
    ) {
      matched = true;
      break;
    }
  }
  if (!matched) return 'queue';

  // ── 2. D-QUALITY-TIER safety override ─────────────────────────────────
  // Auto-apply is REFUSED on consumer-grade or confirmation-required records,
  // regardless of issuer trust. Queue for user review instead.
  if (boundQuality.dataQualityTier === CONSUMER_GRADE) return 'queue';
  if (boundQuality.requiresConfirmation === true) return 'queue';

  return 'auto-apply';
}

/**
 * Load auto-apply policies from `<pod>/policies/auto-apply.ttl`. Returns an
 * empty array if the file does not exist. Parsing errors are swallowed — a
 * malformed policy file behaves the same as no policies (queue everything),
 * which is the safe default.
 */
export function loadPolicies(podDir: string): AutoApplyPolicy[] {
  const filePath = path.join(podDir, 'policies', 'auto-apply.ttl');
  if (!fs.existsSync(filePath)) return [];
  let ttl: string;
  try {
    ttl = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const { success, store } = parseTurtle(ttl);
  if (!success) return [];
  return policiesFromStore(store);
}

/**
 * Extract AutoApplyPolicy declarations from an n3 Store. Exposed so tests can
 * build policies in-memory without going through the filesystem.
 */
export function policiesFromStore(store: Store): AutoApplyPolicy[] {
  const out: AutoApplyPolicy[] = [];
  // Find all subjects of type cascade:AutoApplyPolicy
  const policySubjects = new Set<string>();
  for (const quad of store.match(null, namedNodeOf(RDF_TYPE), namedNodeOf(AUTO_APPLY_POLICY_TYPE))) {
    if (quad.subject.termType === 'NamedNode' || quad.subject.termType === 'BlankNode') {
      policySubjects.add(quad.subject.value);
    }
  }

  for (const iri of policySubjects) {
    const issuers: string[] = [];
    const classes: string[] = [];
    for (const q of store.match(namedNodeOf(iri), namedNodeOf(TRUSTS_ISSUER), null)) {
      if (q.object.termType === 'NamedNode') issuers.push(q.object.value);
    }
    for (const q of store.match(namedNodeOf(iri), namedNodeOf(TRUSTS_ADVISORY_CLASS), null)) {
      if (q.object.termType === 'NamedNode') classes.push(q.object.value);
    }
    out.push({ iri, issuers, advisoryClasses: classes });
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* n3 helper                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

import { DataFactory } from 'n3';
const { namedNode } = DataFactory;
function namedNodeOf(iri: string) {
  return namedNode(iri);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Quality probe (helper for callers)                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Probe a pod store for the quality flags on a bound record. Convenience
 * wrapper for the applier pipeline so callers don't have to reimplement the
 * dataQualityTier + requiresConfirmation lookup.
 */
export function probeBoundQuality(
  podStore: Store,
  recordIri: string,
): BoundRecordQuality {
  const out: BoundRecordQuality = {};
  for (const q of podStore.match(
    namedNodeOf(recordIri),
    namedNodeOf(`${NS_GENOMICS}dataQualityTier`),
    null,
  )) {
    if (q.object.termType === 'NamedNode') {
      out.dataQualityTier = q.object.value;
      break;
    }
  }
  for (const q of podStore.match(
    namedNodeOf(recordIri),
    namedNodeOf(`${NS_GENOMICS}requiresConfirmation`),
    null,
  )) {
    if (q.object.termType === 'Literal') {
      out.requiresConfirmation = q.object.value === 'true';
      break;
    }
  }
  return out;
}
