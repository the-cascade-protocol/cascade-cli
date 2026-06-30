/**
 * Cascade clinical terminology resolver for cascade-cli.
 *
 * CANONICAL SOURCE: `sdk-typescript/src/utils/terminology.ts` (interface + logic)
 * and `sdk-typescript/src/data/cascade-terminology.json` (the data asset). This
 * is a byte-identical port held by a parity test (the deterministicUuid /
 * normalizer arrangement); the CLI takes no runtime dependency on
 * `@the-cascade-protocol/sdk`. The asset JSON in `src/data/` is a copy of the
 * SDK's; regenerate both from the same LLM-propose / human-review pipeline.
 *
 * One versioned surface-form map serving both consumers of the shared substrate:
 * reconciliation (brand to generic, so a brand and its generic dedupe without a
 * shared code) and grounding/retrieval (lay synonym / common name to code).
 * Determinism-first O(1) lookup; injectable; degrades to identity when absent.
 */

import type { CodeRef, CodeSystem } from './code-keys.js';
import terminologyAsset from '../data/cascade-terminology.json' with { type: 'json' };

/** A coded concept entry in the asset (a {@link CodeRef} plus an optional label). */
export interface ConceptCode {
  system: CodeSystem;
  code: string;
  display?: string;
}

/** The on-disk asset shape (`cascade-terminology.json`). */
export interface TerminologyAsset {
  version: string;
  description?: string;
  status?: string;
  note?: string;
  /** Lowercased brand/surface form -> canonical generic NAME. */
  brandToGeneric: Record<string, string>;
  /** Lowercased lay/clinical surface form -> coded concept(s). */
  concepts: Record<string, ConceptCode[]>;
}

/**
 * The injectable resolver. A narrow contract so consumers depend on the
 * capability, not the asset: `normalizeMedName` only needs {@link toGeneric},
 * the grounder only needs {@link toCodes}.
 */
export interface TerminologyResolver {
  /** Asset version this resolver was built from (`"identity"` for the no-op). */
  readonly version: string;
  /** Canonical generic name for a brand/surface form, else undefined. */
  toGeneric(surfaceForm: string): string | undefined;
  /** Coded concept(s) for a surface form (lay or clinical), else `[]`. */
  toCodes(surfaceForm: string): CodeRef[];
}

function key(surfaceForm: string): string {
  return surfaceForm.toLowerCase().trim();
}

/** Build a resolver over a terminology asset. Lookups are pure O(1). */
export function createTerminologyResolver(asset: TerminologyAsset): TerminologyResolver {
  const brand = asset.brandToGeneric ?? {};
  const concepts = asset.concepts ?? {};
  return {
    version: asset.version,
    toGeneric(surfaceForm: string): string | undefined {
      return brand[key(surfaceForm)];
    },
    toCodes(surfaceForm: string): CodeRef[] {
      const entries = concepts[key(surfaceForm)];
      return entries ? entries.map((c) => ({ system: c.system, value: c.code })) : [];
    },
  };
}

/** The no-op resolver: every lookup misses (identical to injecting nothing). */
export const identityTerminologyResolver: TerminologyResolver = {
  version: 'identity',
  toGeneric: () => undefined,
  toCodes: () => [],
};

/** Version string of the bundled Cascade terminology asset. */
export const CASCADE_TERMINOLOGY_VERSION: string = (terminologyAsset as TerminologyAsset).version;

let bundled: TerminologyResolver | undefined;

/** A memoized resolver over the terminology asset bundled with the CLI. */
export function cascadeTerminologyResolver(): TerminologyResolver {
  if (!bundled) bundled = createTerminologyResolver(terminologyAsset as TerminologyAsset);
  return bundled;
}
