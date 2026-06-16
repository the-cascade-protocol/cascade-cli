/**
 * Format detection for GA4GH Phenopacket Schema (v1 + v2) inputs.
 *
 * Heuristic — `true` when the parsed JSON looks like a phenopacket, family,
 * or cohort top-level shape:
 *
 *   1. `metaData.phenopacketSchemaVersion` is present (most decisive — every
 *      schema-conformant phenopacket carries this), OR
 *   2. `subject` (or `proband.subject` for families, or `members[].subject`
 *      for cohorts) coexists with at least one of `phenotypicFeatures`,
 *      `interpretations`, `variants`, or `genomicInterpretations`, AND a
 *      top-level `id` is present.
 *
 * Distinct from `detectFhirGenomics` because phenopackets are NOT FHIR
 * Bundles — they have no `resourceType` field, no FHIR profile URLs.
 *
 * Must not throw on malformed JSON, on binary buffers (ZIPs), or on
 * unexpected shapes; returns `false`.
 */

interface PhenopacketBag {
  id?: unknown;
  subject?: unknown;
  phenotypicFeatures?: unknown;
  interpretations?: unknown;
  variants?: unknown;
  metaData?: { phenopacketSchemaVersion?: unknown };

  // Family resource shape
  proband?: { subject?: unknown; phenotypicFeatures?: unknown; interpretations?: unknown };
  relatives?: unknown;
  pedigree?: { persons?: unknown };

  // Cohort resource shape
  members?: unknown;
}

function hasSchemaVersion(parsed: PhenopacketBag): boolean {
  const meta = parsed.metaData;
  if (!meta || typeof meta !== 'object') return false;
  return typeof meta.phenopacketSchemaVersion === 'string';
}

function looksLikePhenopacket(parsed: PhenopacketBag): boolean {
  if (typeof parsed.id !== 'string') return false;
  if (!parsed.subject || typeof parsed.subject !== 'object') return false;
  const hasFeatures = Array.isArray(parsed.phenotypicFeatures);
  const hasInterps = Array.isArray(parsed.interpretations);
  const hasVariants = Array.isArray(parsed.variants);
  return hasFeatures || hasInterps || hasVariants;
}

function looksLikeFamily(parsed: PhenopacketBag): boolean {
  if (typeof parsed.id !== 'string') return false;
  if (!parsed.proband || typeof parsed.proband !== 'object') return false;
  if (!parsed.proband.subject) return false;
  return Array.isArray(parsed.relatives) || (parsed.pedigree && Array.isArray(parsed.pedigree.persons))
    ? true
    : false;
}

function looksLikeCohort(parsed: PhenopacketBag): boolean {
  if (typeof parsed.id !== 'string') return false;
  if (!Array.isArray(parsed.members)) return false;
  // First member must have a subject (otherwise this is some other "members"-shaped record).
  const first = parsed.members[0];
  return !!first && typeof first === 'object' && 'subject' in (first as object);
}

/**
 * Returns `true` when the input looks like a GA4GH Phenopacket, Family, or
 * Cohort. Safe for binary buffers (returns false instead of attempting JSON
 * parse on ZIP magic bytes).
 */
export function detectPhenopacket(input: string | Buffer): boolean {
  let text: string;
  if (Buffer.isBuffer(input)) {
    // ZIP/binary inputs are never phenopacket JSON.
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

  // Phenopackets have no `resourceType` field — that's a FHIR marker.
  // Reject anything that does (a phenopacket has none).
  if ('resourceType' in (parsed as object)) return false;

  const bag = parsed as PhenopacketBag;

  if (hasSchemaVersion(bag)) return true;
  if (looksLikePhenopacket(bag)) return true;
  if (looksLikeFamily(bag)) return true;
  if (looksLikeCohort(bag)) return true;

  return false;
}

/**
 * Classify a parsed phenopacket-shaped object. Caller must have already
 * confirmed `detectPhenopacket()` returned true.
 */
export function classifyPhenopacket(parsed: any): 'phenopacket' | 'family' | 'cohort' | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const bag = parsed as PhenopacketBag;
  if (Array.isArray(bag.members)) return 'cohort';
  if (bag.proband && typeof bag.proband === 'object') return 'family';
  if (bag.subject && typeof bag.subject === 'object') return 'phenopacket';
  // Schema-version-only inputs (e.g., marfan.input.json with no subject)
  // still classify as a single phenopacket — the importer will gracefully
  // emit gap-warnings for the missing subject.
  if (hasSchemaVersion(bag)) return 'phenopacket';
  return null;
}
