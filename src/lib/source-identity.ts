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
 *                                         screen. DERIVED FROM THE ORIGIN, for
 *                                         the reason set out under THE LABEL IS
 *                                         A FUNCTION OF THE ORIGIN below.
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
 *   derived it from the registrable domain of the endpoint and the C-CDA path
 *   from the custodian organization name, so ONE system rendered as TWO sources
 *   the moment a patient downloaded both transports. Corpus scenarios P01 and
 *   P13; the second is the half a per-transport rule cannot reach, and the one
 *   the label derivation below exists for.
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
 * THE LABEL IS A FUNCTION OF THE ORIGIN
 * -------------------------------------
 * The origin axis converged; the label axis did not, and the split it left was
 * MEASURED on a real pod. One health system arrived by both transports and
 * occupied two rows: 1,175 records under the C-CDA custodian's stated
 * organization name and 938 under the FHIR endpoint's registrable domain. A
 * second system split 92 against 92. Every source-scoped consumer inherits the
 * split, because every one of them groups on the label.
 *
 * The reason it could not be fixed by making one transport's rule better is
 * arithmetic, not effort: a bundle that carries no `Organization` states no
 * organization NAME anywhere. Its domain is all it has. No string transform
 * turns "providence.org" into a legal entity name, so no rule computed from each
 * transport's own input can make the two agree on a name.
 *
 * What both transports DO agree on is the canonical origin — that is what
 * {@link orgSlug} is for. So the label is derived from it:
 *
 *     LABEL := displayNameOf(ORIGIN)
 *
 * and the invariant stops being a coincidence that holds while both documents
 * happen to say the same thing. Two records with one origin CANNOT carry two
 * labels, because the label is not independently derived at all.
 *
 * The cost is stated plainly: a label is now as coarse as the origin. A system
 * whose documents call it "Providence Health and Services Washington and
 * Montana" renders under the canonical name for `org:providence`, and two
 * organizations that collapse to one slug also collapse to one label. That is
 * the same trade {@link orgSlug} already takes, in the same direction, and for
 * the same reason: a collapsed row is visible and recoverable, a split source
 * axis is neither.
 *
 * {@link CANONICAL_ORGANIZATIONS} is where a coarse default is bought back. It
 * is a curated table, and it is the only mechanism here that is EXPECTED to
 * grow.
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

/**
 * ONE canonical organization: the slug that IS its identity, the name to show
 * for it, and the raw tokens that must fold into it.
 */
export interface CanonicalOrganization {
  /** The canonical `org:` slug. Every alias resolves here; this never moves. */
  slug: string;
  /** The one display name every record of this origin renders under. */
  display: string;
  /**
   * Raw tokens {@link orgSlug}'s generic normalization produces for OTHER
   * spellings of this organization, which must fold into `slug`.
   *
   * These are slug-space values, not hosts or names: the normalization runs
   * first and its output is looked up here. So the entry for a host is the token
   * that host reduces to (`kp.org` -> `kp`), which keeps the table independent of
   * subdomains, of `www.`, and of every future spelling that reduces the same way.
   */
  aliases: readonly string[];
}

/**
 * THE CROSSWALK. Curated, deliberately short, and the ONLY part of this module
 * that is meant to grow.
 *
 * TWO JOBS, AND THEY ARE DIFFERENT
 * --------------------------------
 *   `aliases` moves an ORIGIN. It is identity-adjacent: adding one re-keys the
 *   reconciler's same-source guard for every record whose origin folds, and two
 *   groups that were never compared become comparable. Add one only for an
 *   organization whose public host and whose stated name genuinely share no
 *   token, which is the case the generic normalization provably cannot reach.
 *
 *   `display` moves only a LABEL. It buys back the readability the coarse
 *   default gives up, and it costs nothing but a row on screen. Adding one is
 *   safe.
 *
 * Absence from this table is not an error. An organization not listed gets its
 * slug from the normalization and its label from {@link titleCaseSlug}, which is
 * convergent, just plainer.
 *
 * WHY A TABLE AND NOT A RULE
 * --------------------------
 * Because the fact it encodes is not derivable. "kp.org" and "Kaiser Permanente"
 * are one organization because of a naming decision that organization made, and
 * there is no transform over the two strings that discovers it. A rule that
 * appeared to bridge them would be bridging them by accident, and the same
 * accident would bridge organizations that are not one. Stating the few known
 * facts and computing everything else is the honest split.
 */
export const CANONICAL_ORGANIZATIONS: readonly CanonicalOrganization[] = [
  // Public host shares no token with the stated name, so the normalization gives
  // `kp` from the endpoint and `kaiser` from every document that names it. Both
  // spellings of one system were measured on one real pod, splitting it evenly.
  { slug: 'kaiser', display: 'Kaiser Permanente', aliases: ['kp'] },
  // Host and name already converge. The entry exists only for the display name:
  // the stated organization name is a regional legal entity, and the origin is
  // the system, so neither the full legal name nor the bare token is the right
  // thing to put on a source row.
  { slug: 'providence', display: 'Providence Health & Services', aliases: [] },
];

/** Raw normalization output -> canonical slug. Built once from the table. */
const ALIAS_TO_CANONICAL: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const org of CANONICAL_ORGANIZATIONS) {
    for (const alias of org.aliases) m.set(alias, org.slug);
  }
  return m;
})();

/** Canonical slug -> display name. */
const CANONICAL_DISPLAY: ReadonlyMap<string, string> = new Map(
  CANONICAL_ORGANIZATIONS.map((o) => [o.slug, o.display]),
);

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
  if (distinctive.length > 0) return canonicalize(distinctive[0]);

  // Every token was generic ("Regional Medical Center"). Falling through to
  // undefined would file the organization under "origin unknown", which is worse
  // than a low-information but STABLE identity, so use the whole normalized form.
  const joined = tokens.join('');
  return joined ? canonicalize(joined) : undefined;
}

/**
 * The last step of {@link orgSlug}: fold a raw normalization result onto its
 * canonical slug, when the crosswalk names one.
 *
 * A pass-through for everything not in the table, which is almost everything.
 * Applied at BOTH exits of `orgSlug` on purpose: an organization whose every
 * token is generic can still have an alias, and a fold that only covered the
 * common exit would be a rule with a hole in it that nothing would ever surface.
 */
function canonicalize(rawSlug: string): string {
  return ALIAS_TO_CANONICAL.get(rawSlug) ?? rawSlug;
}

/**
 * A slug rendered for a person to read, when the crosswalk names no display.
 *
 * Capitalizing the first letter and nothing else is deliberate. A slug is one
 * token by construction, so there is no word boundary to title-case, and the
 * degenerate all-generic case ("regionalmedicalcenter") has no boundary a
 * transform could find either. Guessing at one would produce a different wrong
 * answer for each input; capitalizing produces the same plain one every time,
 * and the crosswalk is where a better name is supplied.
 */
function titleCaseSlug(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/**
 * The display name for a canonical `org:` slug: curated, else the plain form.
 *
 * Exported because the label is a fact about the ORIGIN, so anything that has an
 * origin and wants to show it derives the name here rather than keeping its own
 * copy of the rule.
 */
export function orgDisplayName(slug: string): string {
  return CANONICAL_DISPLAY.get(slug) ?? titleCaseSlug(slug);
}

/**
 * The `org:` slug inside a stored identity value, or `undefined` for the `ns:`
 * and `transport:` tiers, which name no organization to look up.
 */
export function organizationSlugOf(identityValue: string | undefined): string | undefined {
  if (typeof identityValue !== 'string' || !identityValue.startsWith('org:')) return undefined;
  const slug = identityValue.slice('org:'.length);
  return slug || undefined;
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
 * THE OTHER DOOR: the display LABEL (`clinical:sourceEHR`) for a record set whose
 * origin has already been resolved.
 *
 * Every converter calls this instead of writing whatever its own transport
 * happened to state, which is the whole of the label fix. The two arguments are
 * NOT alternatives to choose between:
 *
 *   ORGANIZATION TIER — the identity names an organization, so the label is that
 *   organization's canonical display name and `statedName` is ignored outright.
 *   Ignoring it is the point: it is exactly the value that differed by transport,
 *   and consulting it at all would put the split back.
 *
 *   ns: / transport: TIER — no organization was derivable, so there is no
 *   canonical name to render and `statedName` is all there is. In practice it is
 *   the ratified data-absent token the C-CDA path writes when the custodian named
 *   nobody, and passing it through keeps "we do not know" legible rather than
 *   inventing a name out of an OID or a batch tag.
 *
 * Returns `undefined` when there is nothing honest to say, leaving the caller to
 * write no triple or to apply its own data-absent rule.
 */
export function sourceLabel(
  identity: SourceIdentity | undefined,
  statedName?: string,
): string | undefined {
  const slug = identity?.tier === 'organization' ? organizationSlugOf(identity.value) : undefined;
  if (slug) return orgDisplayName(slug);
  const stated = typeof statedName === 'string' ? statedName.trim() : '';
  return stated || undefined;
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
