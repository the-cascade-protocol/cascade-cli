/**
 * Format detection for FHIR Genomics IG bundles and resources.
 *
 * Heuristic: parse the input as JSON; scan every entry's `meta.profile`
 * array for any URL containing the FHIR Genomics IG namespace. Returns
 * true on the first match.
 *
 * Distinct from generic `--from fhir` detection because the Genomics IG
 * uses profiles layered on top of the base R4 Observation/DiagnosticReport
 * resources — without inspecting profile URLs there's no way to tell a
 * genomics bundle from a vital-signs bundle.
 *
 * Must not throw on malformed JSON or unexpected shapes; returns false.
 */

import { GENOMICS_PROFILE_PREFIX } from './types.js';

interface MetaProfileBag {
  meta?: { profile?: unknown };
}

interface BundleEntryBag {
  resource?: unknown;
}

interface BundleBag {
  resourceType?: unknown;
  entry?: unknown;
  meta?: { profile?: unknown };
}

function hasGenomicsProfile(resource: unknown): boolean {
  if (!resource || typeof resource !== 'object') return false;
  const meta = (resource as MetaProfileBag).meta;
  if (!meta || typeof meta !== 'object') return false;
  const profile = meta.profile;
  if (!Array.isArray(profile)) return false;
  return profile.some(
    (p) => typeof p === 'string' && p.includes(GENOMICS_PROFILE_PREFIX),
  );
}

/**
 * Returns true when the input looks like a FHIR Genomics IG bundle or
 * single resource. Safe for binary buffers (returns false instead of
 * attempting JSON parse).
 */
export function detectFhirGenomics(input: string | Buffer): boolean {
  let text: string;
  if (Buffer.isBuffer(input)) {
    // ZIP / binary inputs are never genomics JSON.
    if (input.length >= 2 && input[0] === 0x50 && input[1] === 0x4b) return false;
    text = input.toString('utf-8');
  } else {
    text = input;
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;

  const obj = parsed as BundleBag;

  // Single-resource case
  if (obj.resourceType !== 'Bundle') {
    return hasGenomicsProfile(obj);
  }

  // Bundle case: scan every entry.resource.meta.profile, plus the bundle's own profile.
  if (hasGenomicsProfile(obj)) return true;
  if (!Array.isArray(obj.entry)) return false;
  for (const entry of obj.entry as BundleEntryBag[]) {
    if (entry && typeof entry === 'object' && hasGenomicsProfile(entry.resource)) {
      return true;
    }
  }
  return false;
}
