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
 * THE GOVERNING PRINCIPLE: WHEN IDENTITY IS UNCERTAIN, PREFER A SPLIT
 * ------------------------------------------------------------------
 * The two failure modes are not symmetric, and the asymmetry decides every
 * judgement call in this module:
 *
 *   A SPLIT (one record minting two identities) is RECOVERABLE. All the data is
 *   still present; the duplicates can be reconciled later, by a tool or a
 *   person, because both copies are there to compare.
 *
 *   A MERGE (two records minting one identity) is NOT RECOVERABLE. The second
 *   record's content is simply gone — overwritten by the first, or dropped as a
 *   duplicate — and nothing downstream can know it existed.
 *
 * So an uncertain identity must err toward splitting.
 *
 * THE CASCADE, in strict order
 * ---------------------------
 *   1. EXPLICIT ID — the source assigned an identifier. Use it verbatim.
 *      This tier is byte-for-byte what every call site did before this module
 *      existed, which is deliberate: changing an IRI that a source id already
 *      determines would break every pod in the field.
 *
 *   2. CONTENT HASH — the source assigned nothing, so identity comes from what
 *      the record IS. The resource is stripped of volatile, derivative and
 *      scaffold fields (see {@link VOLATILE_FIELDS}), serialized with sorted
 *      keys at every level so source key order cannot perturb the digest, and
 *      hashed. Two byte-equal resources get one identity no matter how many
 *      times, from how many directories, or in what bundle position they are
 *      imported.
 *
 *   3. SALVAGE — nothing survived tier 2, but a DERIVATIVE field did. Hash the
 *      resource again with the derivative fields put BACK. In practice this is
 *      a narrative-only resource: no structured content, but prose that plainly
 *      distinguishes it from the next one.
 *
 *      This tier exists because without it the exclusion list MANUFACTURES the
 *      indistinguishability it then acts on. Two Conditions whose only content
 *      is `text.div` — "Type 2 diabetes mellitus" and "Metastatic breast
 *      cancer" — are trivially distinguishable to any reader, and an earlier
 *      revision of this module collapsed them into one IRI because it had
 *      thrown away the only field that told them apart. That is data
 *      destruction dressed up as deduplication.
 *
 *      The cost of this tier is bounded and recoverable: a server that
 *      regenerates a narrative can produce a DUPLICATE of a narrative-only
 *      record. Per the principle above, that is the failure to prefer.
 *
 *   4. COLLAPSE, LOUDLY — there is nothing left at all: no id, no structured
 *      content, no narrative. Such a record cannot be told apart from any other
 *      record of its type by any means, so it lands on a deterministic sentinel
 *      ({@link EMPTY_SEED}) and merges. Crucially, merging here destroys
 *      NOTHING, because there is no content to destroy — the split-over-merge
 *      rule has no force when both records are empty, while splitting them
 *      would recreate the original defect (a fresh IRI on every sync, forever).
 *
 *      This tier MUST NOT be silent. It emits a warning naming what happened
 *      (see {@link identityCollapseWarning}); a caller that passes a `warnings`
 *      array to {@link identitySeed} receives it.
 *
 *      That obligation is on the CALL SITE, so it is worth being precise about
 *      where it is met, because a comment like the one above is exactly what a
 *      future reader will trust:
 *
 *        * FHIR clinical — met. `mintSubjectUri` and `contentHashedUri` both
 *          take an optional `warnings` array, and all 18 converter call sites
 *          pass the one they already build. It is emitted where the identity is
 *          MINTED, not at the dispatcher: an earlier revision emitted it from
 *          `convertFhirResourceToQuads`, which looked like the right single
 *          chokepoint but meant `convertCondition(...)` called directly
 *          reported nothing.
 *        * Genomics (6 sites), phenopacket subject + biosample, C-CDA document
 *          id, C-CDA patient demographics — met, each threading its own array.
 *        * C-CDA sections other than the patient — tier 4 is UNREACHABLE, not
 *          unreported: every one keys on `patient: patientUri`, always a
 *          non-empty `urn:uuid:`, so the content tier always fires.
 *        * `convertMedicationStatement` — tier 4 is unreachable for a different
 *          and less comfortable reason: it defaults the drug name to the literal
 *          'Unknown Medication' before minting, so the content tier "succeeds"
 *          with a constant. Same shape as the `resourceType` scaffold bug below,
 *          but originating in the converter's choice of identity fields rather
 *          than here. Pinned by a test and filed for the converter
 *          identity-field review; deliberately NOT fixed in this module.
 *
 *   There is no tier 5. Not `randomUUID()`, not `Math.random()`, not
 *   `Date.now()`, not `ctx.importedAt`.
 *
 * WHY FIELDS ARE EXCLUDED, AND THE THREE KINDS OF EXCLUSION
 * --------------------------------------------------------
 * A content hash is only as stable as its least stable input. `meta.lastUpdated`
 * and `meta.versionId` are assigned by the FHIR server and change every time a
 * resource is re-fetched, so hashing them would mint a fresh IRI on every EHR
 * sync — this exact bug, reintroduced in a subtler and much harder-to-see form,
 * since it would look deterministic in any test that imports the same file
 * twice from disk.
 *
 * But not every exclusion is excluded for that reason, and conflating them is
 * what produced the data-destroying collapse described in tier 3. So each rule
 * declares its `kind`:
 *
 *   'volatile'   — differs between two encounters with the SAME logical record.
 *                  Never usable for identity at any tier, because using it IS
 *                  the bug. Server metadata. Stripped at tiers 2 and 3.
 *
 *   'derivative' — stable for a given record, and content-bearing, but not the
 *                  PREFERRED identity signal because the structured fields
 *                  already say it. Stripped at tier 2, RESTORED at tier 3.
 *
 *   'scaffold'   — structural boilerplate present on every record of a kind,
 *                  and already spliced into the call site's key template.
 *                  Stripped at tiers 2 and 3, and — the part that matters — it
 *                  must not count toward "does this resource have content".
 *                  `resourceType` is the whole reason this kind exists: while it
 *                  counted as content, a narrative-only Condition hashed to
 *                  `{"resourceType":"Condition"}`, tier 2 "succeeded" with a
 *                  value identical for every Condition in existence, and the
 *                  salvage tier never ran. Tier 2 succeeding with a constant is
 *                  indistinguishable from tier 2 failing, except that it merges.
 *
 * See {@link VOLATILE_FIELDS} for the full list and the reason each entry is on
 * it.
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
  /**
   * 'volatile'   — changes for the same logical record; never an identity input.
   * 'derivative' — stable and content-bearing, just not preferred; restored by
   *                the tier-3 salvage pass so it can still tell records apart.
   * 'scaffold'   — structural boilerplate that every record of a kind carries,
   *                and that the call site ALREADY puts in its key template.
   *                Never hashed, at any tier. Critically, it must not count
   *                toward "does this resource have content", or a resource
   *                whose only real content is narrative looks non-empty and
   *                never reaches the salvage tier.
   */
  kind: 'volatile' | 'derivative' | 'scaffold';
  why: string;
}> = [
  {
    field: 'lastUpdated',
    under: 'meta',
    kind: 'volatile',
    why:
      'Server-assigned write timestamp. Changes on every re-fetch of an unchanged resource, so ' +
      'hashing it mints a new IRI on every EHR sync — the defect this module exists to end.',
  },
  {
    field: 'versionId',
    under: 'meta',
    kind: 'volatile',
    why:
      'Server-assigned version counter. Increments on any server-side touch, including ones that ' +
      'change nothing a patient would recognize as a different record.',
  },
  {
    field: 'source',
    under: 'meta',
    kind: 'volatile',
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
    kind: 'derivative',
    why:
      'FHIR Narrative. Derivative rather than volatile — the spec requires it to convey the same ' +
      'information as the structured data, so where structured fields exist it adds no identity ' +
      'they do not already carry, and servers regenerate it with their own formatting. So it is ' +
      'kept OUT of the preferred hash. But it is real content, and it is restored by the tier-3 ' +
      'salvage pass, because for a narrative-only resource it is the only thing that tells one ' +
      'record from another: dropping it there collapsed "Type 2 diabetes mellitus" and ' +
      '"Metastatic breast cancer" into a single IRI. Restricted to object values so that ' +
      'CodeableConcept.text (a string, and often the ONLY human-meaningful content on a coding) ' +
      'is never stripped at any tier.',
  },
  {
    field: 'resourceType',
    under: null,
    kind: 'scaffold',
    why:
      'The FHIR type discriminator. Every call site already splices the resource type into its ' +
      'key template — `${resourceType}:${seed}`, `${resourceType}::${seed}`, ' +
      '`genomics:Variant:${sys}:${seed}` — so hashing it as well is redundant and type separation ' +
      'is preserved without it. It has to be stripped rather than merely deprioritized, because ' +
      'while it is present EVERY resource looks like it has content: a Condition whose only real ' +
      'content is narrative hashed to `{"resourceType":"Condition"}`, which is identical for every ' +
      'Condition on earth, so tier 2 "succeeded" with a constant and the salvage tier never ran. ' +
      'That is what silently merged two different diagnoses.',
  },
];

/** Kinds stripped at tier 2 (the preferred hash) and at tier 3 (salvage). */
type ExclusionKind = 'volatile' | 'derivative' | 'scaffold';
const TIER2_STRIP: ReadonlyArray<ExclusionKind> = ['volatile', 'derivative', 'scaffold'];
const TIER3_STRIP: ReadonlyArray<ExclusionKind> = ['volatile', 'scaffold'];

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
export type IdentitySource = 'explicit' | 'content' | 'salvage' | 'empty';

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

/** True when a rule of one of `kinds` matches this (parentKey, key, value) position. */
function isExcluded(
  parentKey: string | null,
  key: string,
  value: unknown,
  kinds: ReadonlyArray<ExclusionKind>,
): boolean {
  for (const rule of VOLATILE_FIELDS) {
    if (rule.field !== key) continue;
    if (!kinds.includes(rule.kind)) continue;
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
export function stripVolatile(
  value: unknown,
  parentKey: string | null = null,
  kinds: ReadonlyArray<ExclusionKind> = TIER2_STRIP,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items = value.map((v) => stripVolatile(v, parentKey, kinds)).filter((v) => v !== undefined);
    return items.length > 0 ? items : undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (isExcluded(parentKey, k, v, kinds)) continue;
    const kept = stripVolatile(v, k, kinds);
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
export function contentFingerprint(
  content: unknown,
  kinds: ReadonlyArray<ExclusionKind> = TIER2_STRIP,
): string {
  const stripped = stripVolatile(content, null, kinds);
  if (stripped === undefined) return EMPTY_SEED;
  const serialized = stableStringify(stripped);
  // `{}` / `[]` / `null` / `""` carry no more identity than nothing at all.
  if (serialized === '{}' || serialized === '[]' || serialized === 'null' || serialized === '""') {
    return EMPTY_SEED;
  }
  // Domain-separate the two passes so a tier-3 seed can never equal a tier-2
  // seed, even for an input where the two serializations coincide.
  const domain = kinds === TIER3_STRIP ? 'salvage:' : 'content:';
  return ANON_PREFIX + createHash('sha256').update(domain + serialized, 'utf8').digest('hex');
}

/**
 * The sentence emitted when tier 4 fires. Exported so tests can assert on it
 * rather than on a string literal copied into three places.
 */
export function identityCollapseWarning(label: string): string {
  return (
    `${label}: this record carries no identifier and no identity-bearing content (no structured ` +
    `fields and no narrative), so it cannot be distinguished from any other empty record of its ` +
    `type. It has been given a shared, deterministic IRI, which means such records MERGE rather ` +
    `than accumulating duplicates. Nothing is lost — there is no content to lose — but if you ` +
    `expected separate records here, the source data is not carrying what would separate them.`
  );
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
export function identitySeed(opts: {
  explicitId?: unknown;
  content?: unknown;
  /** Collected warnings. Tier 4 pushes {@link identityCollapseWarning} here. */
  warnings?: string[];
  /** How to name this record in a tier-4 warning. */
  label?: string;
}): IdentitySeed {
  const { explicitId, content, warnings, label } = opts;

  // Tier 1 — explicit id.
  if (typeof explicitId === 'string' && explicitId.trim().length > 0) {
    return { seed: explicitId, source: 'explicit' };
  }

  // Tier 2 — content hash, derivative and scaffold fields excluded.
  const fingerprint = contentFingerprint(content, TIER2_STRIP);
  if (fingerprint !== EMPTY_SEED) {
    return { seed: fingerprint, source: 'content' };
  }

  // Tier 3 — salvage. Nothing structured survived, so put the derivative fields
  // back rather than merging records that a narrative plainly tells apart.
  const salvaged = contentFingerprint(content, TIER3_STRIP);
  if (salvaged !== EMPTY_SEED) {
    return { seed: salvaged, source: 'salvage' };
  }

  // Tier 4 — nothing at all. Collapse, but never silently.
  warnings?.push(identityCollapseWarning(label ?? 'Record'));
  return { seed: EMPTY_SEED, source: 'empty' };
}

/**
 * Convenience for the common call-site shape: resolve a seed and return only
 * the string. Use {@link identitySeed} where the tier is worth reporting.
 */
export function identityKey(
  explicitId: unknown,
  content: unknown,
  warnings?: string[],
  label?: string,
): string {
  return identitySeed({ explicitId, content, warnings, label }).seed;
}

// ===========================================================================
// WELLNESS SEEDS (D-WELLNESS-1 Q1)
// ===========================================================================
//
// A wellness record is named by one of exactly two seeds, one per naming tier
// of D-CANONICAL-1. Both are built HERE and nowhere else; a converter hands the
// returned string to `deterministicUuid` and adds nothing to it.
//
//   Tier 1, the source supplied an identifier (a workout's HKExternalUUID or
//   HKMetadataKeySyncIdentifier, an ActivitySummary's date):
//
//     pod subject | id space | the raw source identifier
//
//   Digest tier, a record no source names (a computed aggregate, or a source
//   element that carries no identifier):
//
//     pod subject | id space | device | metric | statistic | UTC interval |
//     digest of the constituent samples
//
// Components are LENGTH-PREFIXED (UTF-8 byte length, a colon, the bytes), never
// delimiter-joined, so a source named `a|b` and a source `a` with a metric
// starting `b` cannot produce one seed. The record class is deliberately absent
// from both: it is redundant with the metric or the id space, and a component
// that can disagree with itself is a component that can split one record into
// two. The metric is the SOURCE's own type identifier, never a LOINC or SNOMED
// code, so a corrected code mapping re-mints nothing.
//
// Length-prefixed sequences parse unambiguously, so a three-component seed can
// never equal a seven-component one; no tier tag is needed to keep them apart.

/** The closed set of wellness id spaces (health:sourceIdSpace, health v2.10). */
export const WELLNESS_ID_SPACES = ['healthkit', 'google-health', 'fitbit'] as const;
export type WellnessIdSpace = (typeof WELLNESS_ID_SPACES)[number];

/** Length-prefix each component by its UTF-8 byte length and concatenate. */
export function lengthPrefixed(components: readonly string[]): string {
  return components.map((c) => `${Buffer.byteLength(c, 'utf8')}:${c}`).join('');
}

function assertIdSpace(idSpace: string): void {
  if (!(WELLNESS_ID_SPACES as readonly string[]).includes(idSpace)) {
    throw new Error(`Unknown wellness id space "${idSpace}"; expected one of ${WELLNESS_ID_SPACES.join(', ')}`);
  }
}

/**
 * Tier-1 seed: a record whose source supplied its own identifier.
 *
 * The identifier is used RAW. The id space is a separate component rather than
 * a prefix on the id, so this seed, not a string grammar, decides identity.
 */
export function wellnessSourceRecordSeed(opts: {
  podSubject: string;
  idSpace: WellnessIdSpace;
  sourceId: string;
}): string {
  assertIdSpace(opts.idSpace);
  if (opts.sourceId.length === 0) throw new Error('A tier-1 wellness seed needs a non-empty source identifier');
  return lengthPrefixed([opts.podSubject, opts.idSpace, opts.sourceId]);
}

/**
 * Digest-tier seed: a record no source names. For a computed aggregate
 * `statistic` is its `cascade:statistic`; for a source element that carries no
 * identifier (a workout without one) it is the empty string.
 *
 * `device` is {@link wellnessDeviceIdentity}, or the empty string when the
 * samples name no device: the source's own name is then still in the seed,
 * because the sample digest covers it.
 */
export function wellnessDigestSeed(opts: {
  podSubject: string;
  idSpace: WellnessIdSpace;
  device: string;
  metric: string;
  statistic: string;
  periodStart: string;
  periodEnd: string;
  sampleDigest: string;
}): string {
  assertIdSpace(opts.idSpace);
  if (!/^[0-9a-f]{64}$/.test(opts.sampleDigest)) {
    throw new Error('A digest-tier wellness seed needs a SHA-256 sample digest (64 lowercase hex characters)');
  }
  return lengthPrefixed([
    opts.podSubject,
    opts.idSpace,
    opts.device,
    opts.metric,
    opts.statistic,
    `${opts.periodStart}/${opts.periodEnd}`,
    opts.sampleDigest,
  ]);
}

/**
 * The identity of a device: normalized name plus hardware model, length-prefixed.
 *
 * Never the raw device string (Apple embeds a memory address in it that changes
 * on every export), never the manufacturer (it flips between "Apple" and
 * "Apple Inc." by software version), never the software version (it changes
 * over a device's life).
 */
export function wellnessDeviceIdentity(deviceName: string, hardwareVersion: string | undefined): string {
  return lengthPrefixed([deviceName, hardwareVersion ?? '']);
}

/** Seed for a `health:Device` record: the pod subject plus the device identity. */
export function wellnessDeviceSeed(opts: { podSubject: string; deviceIdentity: string }): string {
  return lengthPrefixed(['health:Device', opts.podSubject, opts.deviceIdentity]);
}

/**
 * Seed for a supporting node named by what it IS: a content-addressed sample
 * file (`kind` "attachment", `key` its digest), or the activity that names a
 * derivation rule and its version (`kind` "rule").
 */
export function wellnessSupportSeed(opts: { podSubject: string; kind: 'attachment' | 'rule'; key: string }): string {
  return lengthPrefixed([`wellness-${opts.kind}`, opts.podSubject, opts.key]);
}

/**
 * Order-independent SHA-256 digest of a multiset of samples.
 *
 * Each sample is its field list (the measured D-WELLNESS-1 field set), made one
 * canonical line by length-prefixing. Lines are sorted by their UTF-8 bytes,
 * which is Unicode code point order (the order core.ttl requires of a
 * multi-valued identity input, never locale collation), and duplicates are
 * KEPT: two identical samples are two samples, and the digest counts both.
 */
export function wellnessSampleDigest(samples: ReadonlyArray<readonly string[]>): string {
  const lines = samples.map((fields) => Buffer.from(lengthPrefixed(fields), 'utf8'));
  lines.sort(Buffer.compare);
  const hash = createHash('sha256');
  for (const line of lines) {
    hash.update(`${line.length}:`);
    hash.update(line);
  }
  return hash.digest('hex');
}
