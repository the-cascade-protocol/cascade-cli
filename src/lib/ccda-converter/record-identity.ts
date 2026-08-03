/**
 * C-CDA record identity: ONE door, and ONE `<id>` reader.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Every C-CDA section handler minted its subject IRI with the same call shape:
 *
 *     contentHashedUri('X', { patient: patientUri, … }, sourceId || undefined, entry)
 *
 * That reads as "identify by content, and fall back to the source's id", but
 * `contentHashedUri` consults `fallbackId` ONLY when every content field is
 * empty — and `patient` is always a non-empty `urn:uuid:`. So on this path the
 * id tier was not merely usually dead, it was UNCONDITIONALLY dead. Measured on
 * `main`, two entries identical in every content field and differing only in
 * their `<id extension>`: all ten C-CDA identity sites minted ONE IRI, so a
 * record the source had deliberately kept apart from another was silently
 * overwritten by it.
 *
 * That is the same defect the FHIR path fixed with `idOrContentUri`, and this is
 * its C-CDA-shaped sibling. It is not a second strategy: both express one rule.
 *
 * THE RULE
 * --------
 * Identity answers "is this that record?", and the source's own identifier is
 * the source answering it. Deciding that two records are the same THING is a
 * different judgement — it needs both records side by side and a trail saying it
 * happened — so it belongs to the reconciler, which has both, and not to the
 * identity layer, which sees one record at a time and can only overwrite.
 *
 *   1. The source's `<id>` decides. Nothing else is consulted.
 *   2. No id — the curated content key decides.
 *   3. No content either — `contentHashedUri` hashes the raw source element,
 *      and failing that collapses LOUDLY through the shared identity door.
 *
 * WHY THE DERIVED `patientUri` IS NOT IN ANY KEY
 * ---------------------------------------------
 * It used to be spliced into every section's key, and it was derived from four
 * mutable demographic fields (`dob`, `sex`, `family`, `given[0]`). That produced
 * a bidirectional failure from a single cause. It MERGED records the source kept
 * apart, by making the id tier dead (above). And it SPLIT records that are the
 * same: measured, one document recording "John" and another "Johnny" for the
 * same person with the same MRN derive two different `patientUri`s, so a
 * byte-identical procedure carrying the SAME source id became two records.
 *
 * Within a pod that component is either constant — in which case it tells no two
 * records apart and is dead weight in a key — or varying, in which case every
 * variation is one of those spurious splits. A Cascade pod holds one person:
 * `pod init` takes a single `--owner-name`, `pod import` populates the profile
 * from the FIRST `cascade:PatientProfile` it finds, `PodReader.readPatientProfile`
 * reads "the pod owner's" fields first-wins, and core v3.3 models a caregiver as
 * a `cascade:ProxyAgent` acting for the patient precisely BECAUSE the second
 * person in the room is not a second patient profile.
 *
 * It is also never an edge: no C-CDA quad has the patient IRI as its object, so
 * removing it from the keys severs nothing that `pod query --neighbors` can
 * traverse.
 *
 * And removing it has a second effect, which is worth stating PRECISELY because
 * the obvious version of the claim is wrong. While `patient` was in the key the
 * curated key could never be empty, so `contentHashedUri` never fell through to
 * the shared identity door at all: two entries with no usable key fields and
 * PLAINLY different content — a problem noted "left knee" and one noted "right
 * shoulder", neither coded — minted one IRI. They mint two now, because identity
 * falls through to a hash of the entry's own bytes.
 *
 * What does NOT follow is that the tier-4 LOUD COLLAPSE warning now fires in
 * practice. Every section passes its raw source element as `source`, and a
 * parsed C-CDA element is essentially never empty, so tier 2 of the door
 * answers. Tier 4 is reachable THROUGH the door — `ccdaRecordUri` with an empty
 * key and an empty source emits it, and the chokepoint test exercises exactly
 * that — but from a real document it stays as unreached as
 * `src/lib/identity.ts` says. Measured, not assumed: a problem entry whose only
 * `<value>` is `nullFlavor="NI"` emits zero collapse warnings on this build.
 *
 * The other half of the same lesson, learned the expensive way while writing
 * this: the first draft of the problems key included `status`, which the
 * converter DEFAULTS to the literal 'active'. That made the key a non-empty
 * CONSTANT, the fall-through above never happened, and the two differently-noted
 * problems still merged. A placeholder default in an identity key turns "we do
 * not know" into "these are the same record". Only the STATED status is in the
 * key now.
 */

import {
  contentHashedUri,
  deterministicUuid,
  medicationUri,
} from '../fhir-converter/types.js';

/**
 * The single medication identity type, shared by every importer. Medication
 * identity is minted under `MedicationRequest` whatever the source's own element
 * was, so a C-CDA `<substanceAdministration>` and a FHIR MedicationRequest for
 * the same prescription agree.
 */
const MEDICATION_IDENTITY_TYPE = 'MedicationRequest';

/**
 * One HL7 II (`<id root= extension=/>`) reduced to a stable string, or
 * `undefined` when the element carries no usable identifier.
 *
 * WHY THIS IS SHARED RATHER THAN INLINED TEN TIMES
 * ------------------------------------------------
 * Eight of the nine section handlers wrote this inline, and all eight wrote it
 * the same wrong way:
 *
 *     idEl?.['@_extension'] ? `${idEl['@_root'] ?? ''}:${idEl['@_extension']}` : ''
 *
 * which returns nothing at all for `<id root="9a6d1bac-…"/>` — no `@extension`.
 * That is the CANONICAL C-CDA form for a locally-minted identifier and it is
 * everywhere in real Epic and Cerner output. Measured on `main`: nine of ten
 * sections threw a root-only id away entirely, so `cascade:sourceRecordId` was
 * never emitted for those records either. The loss was already visible in pod
 * output, not only in identity.
 *
 * `encounters.ts` was the one section that handled it, and this generalizes from
 * its shape.
 *
 * WHAT IT HANDLES
 * ---------------
 *  - `root` + `extension`  -> `"root:extension"` (byte-identical to what every
 *    section produced before, so no id-bearing IRI moves for this reason).
 *  - `extension` only      -> `":extension"`     (likewise byte-identical).
 *  - `root` only           -> `"root"`.
 *  - Attribute spelling (`@_root`) and the bare spelling (`root`) that some
 *    parser configurations produce. `immunizations.ts` handled both; the others
 *    handled only the first.
 *  - MULTIPLE `<id>` elements: the FIRST that carries a usable root or extension,
 *    in document order. Deterministic, and strictly better than the `id[0]` every
 *    section used, which returned nothing when the first id was a `nullFlavor`
 *    placeholder — a common way for a vendor to say "this act has no id of its
 *    own, but here is the one that follows".
 *
 *    Document order rather than a sort, and the FIRST rather than all of them:
 *    an HL7 II set lists alternative identifiers for one act, so any single one
 *    identifies it, and combining them would SPLIT a document that carries
 *    `{A, B}` from one that carries only `{A}`. Order within one document's bytes
 *    is stable, which is what determinism requires.
 *
 * WHY IT ACCEPTS EITHER THE ELEMENT OR ITS `id`
 * ---------------------------------------------
 * `ccdaSourceId(organizer)` and `ccdaSourceId(organizer.id)` are both correct.
 * They are, because writing this the other way cost a real defect during the
 * change that introduced it: `ccdaSourceId(organizer)` against an id-VALUE-only
 * signature returned `undefined` with no error, so every lab panel silently fell
 * to the content tier and two panels with different ids MERGED. A chokepoint
 * whose two plausible call shapes differ by a silent `undefined` is not a
 * chokepoint. So this resolves both, and a caller cannot get it wrong.
 *
 * ROOT-ONLY IDS ARE TAKEN AT THE SOURCE'S WORD. HL7 v3 II says the root alone
 * may be the entire instance identifier, so two entries carrying the same
 * root-only id are the SOURCE asserting they are one act, and honouring that is
 * deferring to the standard rather than second-guessing it. The cost, if a
 * vendor misuses a shared assigning-authority OID as a root-only id, is a merge;
 * it is filed rather than guarded against by heuristic, and the conformance
 * corpus currently contains zero root-only ids of any kind.
 */
export function ccdaSourceId(idOrElement: unknown): string | undefined {
  const value = isIdElement(idOrElement)
    ? idOrElement
    : (idOrElement as Record<string, unknown> | null | undefined)?.['id'];

  const candidates = Array.isArray(value) ? value : value == null ? [] : [value];
  for (const el of candidates) {
    if (el == null || typeof el !== 'object') continue;
    const raw = el as Record<string, unknown>;
    const root = str(raw['@_root'] ?? raw['root']);
    const extension = str(raw['@_extension'] ?? raw['extension']);
    if (extension) return `${root}:${extension}`;
    if (root) return root;
    // Neither: a nullFlavor placeholder, or an empty element. Try the next id
    // rather than reporting the whole act as unidentified.
  }
  return undefined;
}

/** True when this value is itself an HL7 II (or an array of them), not a wrapper. */
function isIdElement(value: unknown): boolean {
  if (value == null || typeof value !== 'object') return false;
  const probe = Array.isArray(value) ? value[0] : value;
  if (probe == null || typeof probe !== 'object') return Array.isArray(value);
  const raw = probe as Record<string, unknown>;
  return (
    '@_root' in raw || '@_extension' in raw || 'root' in raw || 'extension' in raw ||
    '@_nullFlavor' in raw || 'nullFlavor' in raw
  );
}

/** A trimmed string, or `''` for anything that is not usable identifier text. */
function str(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

/**
 * THE DOOR. Mint the subject IRI for one C-CDA record.
 *
 * @param type    the identity key's type prefix. Both tiers feed the same
 *                template (`{type}:{id}` and `{type}::{fields}`), and an
 *                anonymous content seed is `anon-` + 64 hex = 69 characters,
 *                so the two tiers cannot collide.
 * @param sourceId the value from {@link ccdaSourceId}. Pass it; do not pass a
 *                hand-rolled one.
 * @param content the curated key used when the source assigned no id. It must
 *                contain every field the caller SERIALIZES that could differ
 *                between two records — a serialized field outside the key is a
 *                field two records sharing an IRI can disagree on.
 * @param source  the raw source element. Only reached when `content` is empty
 *                too, where it gives the salvage tier something real to hash.
 */
export function ccdaRecordUri(opts: {
  type: string;
  sourceId?: string;
  content: Record<string, string | undefined>;
  source?: unknown;
  /** Collects the tier-4 loud-collapse notice. Pass the converter's array. */
  warnings?: string[];
  /** How to name this record in that notice. */
  label?: string;
}): string {
  const { type, sourceId, content, source, warnings, label } = opts;

  // Tier 1 — the source identified this record. Nothing else is consulted, so
  // two records the source kept apart can never be merged here.
  //
  // The key is `{type}:{id}`, id PLUS type: the same template `mintSubjectUri`
  // applies to `resource.id` on the FHIR path, and byte-identical to the
  // `contentHashedUri(type, {}, id)` that the C-CDA lab observation path already
  // ships — so no id-bearing lab IRI moves for this reason.
  if (typeof sourceId === 'string' && sourceId.trim().length > 0) {
    return `urn:uuid:${deterministicUuid(`${type}:${sourceId}`)}`;
  }

  // Tiers 2-4 — the curated key, then the raw element, then a loud collapse.
  // `undefined` in the fallbackId slot is deliberate and is enforced by
  // `tests/ccda-identity-chokepoint.test.ts`: passing an id there is the shape
  // that made the id tier dead in the first place, and it is only ever reached
  // when there is no id to pass.
  return contentHashedUri(type, content, undefined, source, warnings, label);
}

/**
 * The same door for medications, which mint under the shared medication identity
 * key (`medicationUri`: RxNorm + normalized drug name + start date) rather than
 * a per-section one, so a C-CDA medication and a FHIR MedicationRequest for the
 * same prescription agree.
 *
 * Tier 1 is the identical rule and the identical template as
 * {@link ccdaRecordUri}; only the no-id key differs.
 */
export function ccdaMedicationRecordUri(opts: {
  sourceId?: string;
  fields: { rxNormCode?: string; medicationName?: string; startDate?: string };
  source?: unknown;
  warnings?: string[];
  label?: string;
}): string {
  const { sourceId, fields, source, warnings, label } = opts;

  if (typeof sourceId === 'string' && sourceId.trim().length > 0) {
    return `urn:uuid:${deterministicUuid(`${MEDICATION_IDENTITY_TYPE}:${sourceId}`)}`;
  }

  // `undefined` in the fallbackId slot, for the same reason as above.
  return medicationUri(fields, undefined, source, warnings, label);
}
