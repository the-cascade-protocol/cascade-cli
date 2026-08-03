/**
 * Record identity: ONE door every minted IRI goes through.
 *
 * WHY this module exists
 * ----------------------
 * Every importer in this codebase mints a subject IRI for each record it
 * produces, and every one of them independently reached for the same shape:
 * take the source resource's `id`, and if there isn't one, make something up.
 * "Make something up" was spelled `randomUUID()` in the FHIR converter,
 * `Math.random().toString(36)` in six genomics converters, and
 * `${ctx.importedAt}:${Math.random()}` in two more. A per-run timestamp is the
 * same defect wearing a disguise: `importedAt` changes on every invocation, so
 * hashing it is randomness with extra steps.
 *
 * The consequence is that importing the same document twice mints two
 * identities for the same record. Nothing reconciles, nothing dedupes, and the
 * pod grows a duplicate record set on every re-import — silently, with no
 * warning and no gap entry, because a fresh IRI looks exactly like a new
 * record. It is the G-2 byte-reproducibility guarantee failing open.
 *
 * The pattern that ends it already existed in this repo, twice, and was
 * propagated neither time: `contentSeed()` in the phenopacket variation
 * descriptor (written in May 2026 to fix precisely this bug in ONE file) and
 * `contentHashedUri()` in the FHIR converter. That is the actual root cause of
 * this class — a correct pattern that exists, is enforced nowhere, and is
 * re-broken by each new converter. So a patch per site does not end it either.
 * This module owns the rule, and `tests/identity-chokepoint.test.ts` is the
 * lock on every other way in.
 *
 * THE CASCADE, in strict order, with no fourth tier
 * ------------------------------------------------
 *   1. EXPLICIT ID — the source assigned an identifier. Use it verbatim.
 *      This tier is byte-for-byte what every call site did before this module
 *      existed, which is deliberate: changing an IRI that a source id already
 *      determines would break every pod in the field.
 *
 *   2. CONTENT HASH — the source assigned nothing, so identity comes from what
 *      the record IS. The resource is stripped of volatile fields (see
 *      {@link VOLATILE_FIELDS}), serialized with sorted keys at every level so
 *      source key order cannot perturb the digest, and hashed. Two byte-equal
 *      resources get one identity no matter how many times, from how many
 *      directories, or in what bundle position they are imported.
 *
 *   3. THERE IS NO TIER 3. Not `randomUUID()`, not `Math.random()`, not
 *      `Date.now()`, not `ctx.importedAt`. A resource whose every
 *      identity-bearing field is empty is a resource that carries no identity,
 *      and the honest answer is a deterministic sentinel ({@link EMPTY_SEED})
 *      that collapses such records together — plus a `source: 'empty'` signal
 *      the caller can surface — NOT a fresh random IRI that splits them apart
 *      forever. Collapsing indistinguishable records is a decision a user can
 *      see and argue with. Duplicating them on every sync is not.
 *
 * WHY VOLATILE FIELDS ARE STRIPPED
 * --------------------------------
 * A content hash is only as stable as its least stable input. `meta.lastUpdated`
 * and `meta.versionId` are assigned by the FHIR server and change every time a
 * resource is re-fetched, so hashing them would mint a fresh IRI on every EHR
 * sync — this exact bug, reintroduced in a subtler and much harder-to-see form,
 * since it would look deterministic in any test that imports the same file
 * twice from disk. See {@link VOLATILE_FIELDS} for the full list and the reason
 * each entry is on it.
 *
 * ANONYMOUS SEEDS CANNOT COLLIDE WITH REAL IDS
 * --------------------------------------------
 * A tier-2 seed is `anon-` + 64 hex characters = 69 characters. FHIR constrains
 * `Resource.id` to at most 64 characters of `[A-Za-z0-9\-\.]`, so a minted seed
 * is structurally incapable of colliding with an id a source could legitimately
 * assign. That matters because tiers 1 and 2 feed the SAME key template at each
 * call site: an id-less resource can never be confused with an id-bearing one.
 */

import { createHash } from 'node:crypto';

/**
 * Fields excluded from every content hash, and why each one is here.
 *
 * The test `identity-volatile-fields.test.ts` pins this list. Adding an entry
 * is a claim that the field can differ between two encounters with the SAME
 * logical record; removing one is a claim that it cannot.
 *
 * Matching is by (enclosing key, field name) rather than by name alone, at any
 * depth, so that a `contained[0].meta.lastUpdated` is stripped too — and, more
 * importantly, so that stripping is precise. `source` is a volatile provenance
 * pointer under `meta` and load-bearing content almost everywhere else, and
 * `text` is generated narrative on a Resource but a genuine clinical label on a
 * CodeableConcept ("Blood pressure"). A name-only ban would delete real
 * identity content and quietly merge unrelated records.
 */
export const VOLATILE_FIELDS: ReadonlyArray<{
  /** Field name to strip. */
  field: string;
  /** Only strip when the immediately enclosing object was reached under this key. `null` = any parent. */
  under: string | null;
  /** Only strip when the value has this shape. Guards against name collisions. */
  shape?: 'object';
  why: string;
}> = [
  {
    field: 'lastUpdated',
    under: 'meta',
    why:
      'Server-assigned write timestamp. Changes on every re-fetch of an unchanged resource, so ' +
      'hashing it mints a new IRI on every EHR sync — the defect this module exists to end.',
  },
  {
    field: 'versionId',
    under: 'meta',
    why:
      'Server-assigned version counter. Increments on any server-side touch, including ones that ' +
      'change nothing a patient would recognize as a different record.',
  },
  {
    field: 'source',
    under: 'meta',
    why:
      'Meta.source is a pointer at the system/message a resource arrived through, not at what the ' +
      'resource says. It differs between a bulk export and a live FHIR read of the same resource, ' +
      'and Epic-style servers append a per-version fragment to it. Scoped to `meta` because ' +
      '`source` is content-bearing under nearly every other parent.',
  },
  {
    field: 'text',
    under: null,
    shape: 'object',
    why:
      'FHIR Narrative. Derivative by definition — the spec requires it to convey the same ' +
      'information as the structured data, so it adds no identity the structured fields do not ' +
      'already carry — and volatile in practice, because servers regenerate it with their own ' +
      'formatting and can render timestamps into it. Restricted to object values so that ' +
      'CodeableConcept.text (a string, and often the ONLY human-meaningful content on a coding) ' +
      'is preserved. Consequence accepted deliberately: a resource whose only content is narrative ' +
      'hashes to EMPTY_SEED rather than to its prose, because a rendered timestamp inside prose ' +
      'would reintroduce exactly the bug being fixed, one layer down where no test would see it.',
  },
];

/** Prefix on every content-derived seed. See the module header for why it cannot collide with a FHIR id. */
export const ANON_PREFIX = 'anon-';

/**
 * The seed for a resource with no explicit id and no non-volatile content.
 *
 * Deterministic on purpose. Records that reach it are indistinguishable to
 * every part of this system, so they collapse to one identity instead of
 * multiplying. Callers that can surface this to a user should branch on
 * `source === 'empty'` rather than on the string.
 */
export const EMPTY_SEED = `${ANON_PREFIX}empty`;

/** Which tier of the cascade produced a seed. */
export type IdentitySource = 'explicit' | 'content' | 'empty';

export interface IdentitySeed {
  /** The seed to splice into a call site's key template. */
  seed: string;
  /** Which tier produced it. */
  source: IdentitySource;
}

/**
 * `JSON.stringify` with sorted keys at every level.
 *
 * Sorting is what makes the digest independent of source key order: the same
 * resource serialized by two EHRs, or round-tripped through two JSON libraries,
 * has to hash the same. Arrays keep their order, because array order in FHIR is
 * meaningful (`name[0]` is the primary name).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const inner = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',');
  return `{${inner}}`;
}

/** True when a volatile rule matches this (parentKey, key, value) position. */
function isVolatile(parentKey: string | null, key: string, value: unknown): boolean {
  for (const rule of VOLATILE_FIELDS) {
    if (rule.field !== key) continue;
    if (rule.under !== null && rule.under !== parentKey) continue;
    if (rule.shape === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) continue;
    return true;
  }
  return false;
}

/**
 * Recursively remove volatile fields, and prune anything that becomes empty.
 *
 * Pruning matters: a resource whose only field was `meta.lastUpdated` must land
 * on "no content" rather than on `{"meta":{}}`, so that two such resources are
 * recognized as carrying no identity instead of hashing to the same
 * accidental-looking digest under different circumstances.
 */
export function stripVolatile(value: unknown, parentKey: string | null = null): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items = value.map((v) => stripVolatile(v, parentKey)).filter((v) => v !== undefined);
    return items.length > 0 ? items : undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (isVolatile(parentKey, k, v)) continue;
    const kept = stripVolatile(v, k);
    if (kept === undefined) continue;
    out[k] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Hash a resource's non-volatile content into an anonymous seed.
 *
 * Returns `EMPTY_SEED` when nothing survives stripping. SHA-256 rather than the
 * SHA-1 that `deterministicUuid` uses downstream: the seed is an intermediate
 * key, so there is no cross-SDK UUID-v5 compatibility constraint on it and no
 * reason to pick the weaker digest.
 */
export function contentFingerprint(content: unknown): string {
  const stripped = stripVolatile(content);
  if (stripped === undefined) return EMPTY_SEED;
  const serialized = stableStringify(stripped);
  // `{}` / `[]` / `null` / `""` carry no more identity than nothing at all.
  if (serialized === '{}' || serialized === '[]' || serialized === 'null' || serialized === '""') {
    return EMPTY_SEED;
  }
  return ANON_PREFIX + createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * THE DOOR. Resolve the identity seed for one record.
 *
 * Splice the returned `seed` into whatever key template the call site already
 * uses. When `explicitId` is present the seed IS that id, so the key string is
 * byte-identical to what the site produced before it took the door — which is
 * the property that lets this change ship without moving a single existing IRI.
 *
 * @param explicitId the source-assigned identifier, if any. Non-strings and
 *                   blank strings are treated as absent, because an id that is
 *                   `null`, `0` or `"   "` is not an identifier.
 * @param content    the source object to hash when there is no explicit id.
 */
export function identitySeed(opts: { explicitId?: unknown; content?: unknown }): IdentitySeed {
  const { explicitId, content } = opts;

  // Tier 1 — explicit id.
  if (typeof explicitId === 'string' && explicitId.trim().length > 0) {
    return { seed: explicitId, source: 'explicit' };
  }

  // Tier 2 — content hash.
  const fingerprint = contentFingerprint(content);
  if (fingerprint !== EMPTY_SEED) {
    return { seed: fingerprint, source: 'content' };
  }

  // Tier 3 does not exist. See the module header.
  return { seed: EMPTY_SEED, source: 'empty' };
}

/**
 * Convenience for the common call-site shape: resolve a seed and return only
 * the string. Use {@link identitySeed} where the tier is worth reporting.
 */
export function identityKey(explicitId: unknown, content: unknown): string {
  return identitySeed({ explicitId, content }).seed;
}
