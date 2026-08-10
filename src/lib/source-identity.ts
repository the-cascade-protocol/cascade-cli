/**
 * Source identity: ONE door every record's ORIGIN goes through.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * A record carries three source-shaped facts, and this codebase had two of them
 * and used both as if they were the third.
 *
 *   ORIGIN      `cascade:sourceIdentity`  WHICH ORGANIZATION the record came
 *                                         from, canonically, whatever transport
 *                                         carried it. The only one of the three
 *                                         that may be a reconciliation key.
 *   LABEL       `clinical:sourceEHR`      what to CALL that organization on
 *                                         screen. Source-worded, so two
 *                                         spellings of one organization are two
 *                                         labels.
 *   INGESTION   `cascade:sourceSystem`    the import batch: how and when data
 *                                         entered the pod. Never an origin.
 *
 * Both misuses were MEASURED, and they fail in opposite directions.
 *
 *   Keying the reconciler's same-source guard on the INGESTION label means that
 *   on a pod imported under one label, every pair of records looks same-source
 *   and NOTHING is ever compared. On one real corpus that hid 148 cross-source
 *   duplicates. The pathology corpus reproduces it as P07-SHARED-LABEL: two
 *   health systems' exports under one batch tag, 12 records where 7 is right.
 *
 *   Reading the display LABEL as an origin fails the other way. The FHIR path
 *   derives it from the registrable domain of the endpoint and the C-CDA path
 *   from the custodian organization name, so ONE system renders as TWO sources
 *   the moment a patient downloads both transports. Corpus scenario P01.
 *
 * So the origin has to be a THIRD, declared thing, derived by a rule both
 * transports implement identically. That rule is `sourceIdentity()` below, and
 * it lives in one module for the reason `identity.ts` gives at length: this repo
 * has a history of a correct derivation existing in one converter, being
 * enforced nowhere, and being re-invented wrongly in the next one. A per-site
 * derivation is how the two transports came to disagree in the first place.
 *
 * THE VALUE IS SCHEME-PREFIXED, AND THAT IS LOAD-BEARING
 * -----------------------------------------------------
 * `org:` / `ns:` / `transport:`. A consumer can always tell how much the
 * producer actually knew, and in particular can tell that it knew NOTHING:
 *
 *   org:{slug}        an organization was derivable. {slug} is {@link orgSlug}.
 *   ns:{namespace}    no organization, but the record's identifiers have an
 *                     assigning authority: the FHIR server base URL, or the
 *                     C-CDA <id> root OID.
 *   transport:{label} LAST RESORT. Nothing named or located an organization, so
 *                     the value restates the ingestion label, honestly
 *                     prefixed. It is NOT an origin claim.
 *
 * The unprefixed spelling is banned by `cascade:SourceIdentityShape`, because an
 * unprefixed value is exactly what a producer writes when it has stamped a
 * display label or a batch tag into the origin axis — the confusion the axis
 * exists to end.
 *
 * @see core v3.5 `cascade:sourceIdentity` in `src/shapes/core.ttl` for the
 *      normative statement of the value form and the normalization.
 */

/** The predicate this module's values are written under. */
export const SOURCE_IDENTITY_PREDICATE = 'https://ns.cascadeprotocol.org/core/v1#sourceIdentity';

/** Which tier of the cascade produced an identity. Mirrors the value's scheme. */
export type SourceIdentityTier = 'organization' | 'namespace' | 'transport';

export interface SourceIdentity {
  /** The value to write to `cascade:sourceIdentity`, scheme prefix included. */
  value: string;
  /** Which tier produced it. Callers that report provenance branch on this, not on the string. */
  tier: SourceIdentityTier;
}

/**
 * Institution-or-specialty vocabulary that names no particular organization.
 *
 * Dropped from both derivation paths, which is what lets a NAME and a HOST for
 * one organization agree: "Meridian Health System" and "meridianhealth.example"
 * both reduce to "meridian" only because `health` and `system` are here.
 *
 * Kept to words that are generic in an ORGANIZATION name. Geography is
 * deliberately absent — "Valley", "Harborview", "Northgate" are what
 * distinguishes one organization from the next, and stripping them would merge
 * organizations that share nothing but a suffix.
 */
const GENERIC_ORG_WORDS: ReadonlySet<string> = new Set([
  // institution
  'health', 'healthcare', 'system', 'systems', 'service', 'services',
  'medical', 'medicine', 'center', 'centre', 'centers', 'centres',
  'hospital', 'hospitals', 'clinic', 'clinics', 'care', 'group',
  'associates', 'association', 'network', 'partners', 'partnership',
  'physicians', 'physician', 'practice', 'practices', 'regional',
  'community', 'memorial', 'university', 'institute', 'foundation',
  'laboratory', 'laboratories', 'labs', 'lab', 'diagnostics', 'imaging',
  'radiology', 'pathology', 'family', 'urgent', 'primary', 'specialty',
  // specialty names that qualify a system rather than name one
  'cardiology', 'oncology', 'orthopedic', 'orthopedics', 'pediatric', 'pediatrics',
  // legal form
  'inc', 'llc', 'llp', 'ltd', 'plc', 'corp', 'corporation', 'co', 'pc', 'pa', 'pllc',
  // stopwords
  'of', 'and', 'the', 'for', 'at', 'in', 'on', 'a', 'an',
]);

/**
 * Multi-label public suffixes worth knowing about, so `nhs.uk` style hosts do
 * not reduce to the suffix. Deliberately short: this is not a Public Suffix List
 * implementation, and does not pretend to be. A suffix it does not know costs
 * one extra label in the registrable name, which the generic-word strip below
 * usually removes anyway.
 */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'nhs.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'gov.au',
  'co.nz', 'co.za', 'co.jp', 'or.jp', 'com.br', 'com.mx',
]);

/** True when a string looks like a bare hostname rather than an organization name. */
function looksLikeHost(raw: string): boolean {
  return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+\.?$/i.test(raw.trim());
}

/** Fold accents to ASCII so "Hôpital" and "Hopital" cannot be two organizations. */
function foldDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * The registrable NAME label of a host: the label immediately left of the public
 * suffix. `fhir.meridianhealth.example` -> `meridianhealth`.
 */
function registrableName(host: string): string {
  const labels = foldDiacritics(host.trim().toLowerCase())
    .replace(/\.$/, '')
    .split('.')
    .filter(Boolean);
  if (labels.length === 0) return '';
  if (labels[0] === 'www' && labels.length > 1) labels.shift();
  if (labels.length === 1) return labels[0];
  const lastTwo = labels.slice(-2).join('.');
  const suffixLabels = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 2 : 1;
  const kept = labels.slice(0, labels.length - suffixLabels);
  // Everything was suffix (e.g. the bare string "co.uk"): keep the first label
  // rather than returning nothing.
  return kept.length > 0 ? kept[kept.length - 1] : labels[0];
}

/**
 * Repeatedly strip any generic organization word forming a whole prefix or
 * suffix of a single concatenated label. `meridianhealth` -> `meridian`,
 * `stonebridgehospital` -> `stonebridge`.
 *
 * Never strips below three characters. Two-letter registrable names exist
 * ("kp.org") and reducing one to nothing or to a single letter would produce an
 * identity that collides with everything.
 */
function stripGenericAffixes(label: string): string {
  let out = label;
  let changed = true;
  while (changed) {
    changed = false;
    for (const word of GENERIC_ORG_WORDS) {
      if (word.length < 3) continue;
      if (out.length - word.length < 3) continue;
      if (out.startsWith(word)) {
        out = out.slice(word.length);
        changed = true;
        break;
      }
      if (out.endsWith(word)) {
        out = out.slice(0, out.length - word.length);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * THE NORMALIZATION. An organization NAME or a HOST reduced to one canonical
 * token, such that both spellings of one organization give the same answer.
 *
 * Returns `undefined` for input that carries no organization at all (empty, or
 * the ratified data-absent token), so a caller cannot accidentally mint
 * `org:unknown` and have every unattributed record on a pod look like one
 * organization.
 *
 * WHY THE LEADING TOKEN AND NOT ALL OF THEM
 * -----------------------------------------
 * Because the two failure directions are not symmetric, and this is the whole
 * argument for the rule:
 *
 *   COLLAPSING two different organizations onto one identity suppresses
 *   comparisons between their records. The duplicates stay in the pod: visible,
 *   and recoverable by a later pass or a person.
 *
 *   SPLITTING one organization across two identities lets records that
 *   organization deliberately kept apart be compared and merged. That destroys
 *   content, and nothing downstream can know it happened.
 *
 * So the rule is biased toward collapsing. Regional and specialty qualifiers get
 * dropped rather than being allowed to split a system: "Providence Health and
 * Services Washington and Montana" and "providence.org" both give "providence",
 * which is what makes a C-CDA custodian and a FHIR endpoint of one system agree.
 * The cost — "Mercy Hospital St. Louis" and "Mercy Medical Center Des Moines"
 * both giving "mercy" — is the recoverable failure, and it is taken knowingly.
 *
 * This is not a registry. It canonicalizes what the documents themselves state,
 * and cannot resolve two organizations that share no token ("Kaiser Permanente"
 * against "kp.org").
 */
export function orgSlug(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // The ratified data-absent token is the source saying it does not know. Minting
  // an identity from it would make every unattributed record one organization.
  if (/^(unknown|unavailable|asked-unknown|not-asked|masked|temp-unknown)$/i.test(trimmed)) {
    return undefined;
  }

  let tokens: string[];
  if (looksLikeHost(trimmed)) {
    const name = registrableName(trimmed);
    if (!name) return undefined;
    tokens = [stripGenericAffixes(name)].filter(Boolean);
  } else {
    tokens = foldDiacritics(trimmed)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
  }

  const distinctive = tokens.filter((t) => !GENERIC_ORG_WORDS.has(t) && !/^\d+$/.test(t));
  if (distinctive.length > 0) return distinctive[0];

  // Every token was generic ("Regional Medical Center"). Falling through to
  // undefined would file the organization under "origin unknown", which is worse
  // than a low-information but STABLE identity, so use the whole normalized form.
  const joined = tokens.join('');
  return joined || undefined;
}

/**
 * THE DOOR. Resolve one record set's source identity.
 *
 * Every caller passes what its transport can see and takes what comes back; no
 * caller composes the value itself. The cascade is strict, and each tier is a
 * weaker claim than the one above it:
 *
 *   1. ORGANIZATION — a name or a host reduced through {@link orgSlug}.
 *      `organizationName` is tried before `endpointHost` because a name is what
 *      the source CALLS itself, and the two normalize into the same space
 *      anyway, so the order only decides tie-breaks.
 *   2. NAMESPACE — no organization, but the record's identifiers have an
 *      assigning authority. Two records agree on origin only if they agree here.
 *   3. TRANSPORT — nothing. Restate the ingestion label, prefixed so a reader
 *      knows this is an absence and not an answer.
 *
 * Returns `undefined` only when even the transport label is absent, which means
 * the caller has nothing to say and must write no triple rather than an empty
 * one.
 */
export function sourceIdentity(opts: {
  /** An organization NAME the source stated: C-CDA custodian, FHIR Organization.name, an institution-looking display. */
  organizationName?: string;
  /** The host of the source FHIR endpoint, or any absolute reference on it. */
  endpointHost?: string;
  /** The assigning authority for this record set's identifiers: server base URL, or C-CDA <id> root OID. */
  idNamespace?: string;
  /** The import-batch label. Used ONLY as the last resort, and prefixed when it is. */
  transportLabel?: string;
}): SourceIdentity | undefined {
  const { organizationName, endpointHost, idNamespace, transportLabel } = opts;

  const slug = orgSlug(organizationName) ?? orgSlug(endpointHost);
  if (slug) return { value: `org:${slug}`, tier: 'organization' };

  const ns = typeof idNamespace === 'string' ? idNamespace.trim() : '';
  if (ns) return { value: `ns:${ns}`, tier: 'namespace' };

  const label = typeof transportLabel === 'string' ? transportLabel.trim() : '';
  if (label) return { value: `transport:${label}`, tier: 'transport' };

  return undefined;
}

/**
 * Whether a stored value names a real organization, as opposed to being an
 * honest statement that the origin is unknown.
 *
 * The reconciler's same-source guard needs this: two records that both landed on
 * `transport:` share a batch tag, not a source, and must not be treated as
 * having the same origin on that basis. Reading the prefix is why the prefix
 * exists.
 */
export function isKnownOrigin(value: string | undefined): boolean {
  return typeof value === 'string' && (value.startsWith('org:') || value.startsWith('ns:'));
}
