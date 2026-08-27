/**
 * The drop-manifest vocabulary: what it means for a converter to NOT emit a
 * field the source populated.
 *
 * This is the field-level analogue of `EXCLUDED_TYPES` / `EXCLUDED_REASONS` in
 * `converters-passthrough.ts`. That pair made type-level exclusion explicit and
 * reasoned; below the type level, omissions were silent, and silence is the
 * actual defect class: a field a converter never reads, a field it reads for
 * identity and never writes as a fact, and an array whose tail is dropped all
 * look identical from outside — nothing says so anywhere.
 *
 * Two dispositions, and the difference between them is a commitment, not a
 * mood:
 *
 *   `acknowledged`  A permanent decision. The reason is the argument for it and
 *                   is expected to still read as correct in a year.
 *   `pending`       A known gap with a fix owed. Carries the backlog id that
 *                   tracks it, so the entry cannot outlive the promise: closing
 *                   the backlog item means the converter emits the field, and
 *                   the differential test then FAILS on the stale entry until it
 *                   is deleted.
 *
 * Manifests are data, deliberately. A converter fix flips an entry by deleting a
 * line in a manifest file — no test edit, no change to the converters, so two
 * sequenced pieces of work do not collide in the same source file.
 */

/** Whether a drop is a decision or a debt. */
export type FieldDropDisposition = 'acknowledged' | 'pending';

/** One element path a converter does not emit, and why. */
export interface FieldDropEntry {
  disposition: FieldDropDisposition;
  /**
   * Why the field is not emitted. A sentence a reader can disagree with, not a
   * restatement of the path.
   */
  reason: string;
  /**
   * The root-backlog id tracking the fix. Required on `pending`, absent on
   * `acknowledged` — an untracked gap is how a gap becomes permanent by
   * accident.
   */
  backlog?: string;
}

/** Every drop one converter takes, keyed by full element path. */
export interface FieldDropManifest {
  /** The FHIR resource type these paths belong to. */
  resourceType: string;
  /**
   * Where the seed list came from, so a reader knows whether an entry was
   * measured or assumed.
   */
  provenance: string;
  drops: Record<string, FieldDropEntry>;
}

/** How one populated element fared: emitted, or dropped with a disposition. */
export interface FieldCoverageVerdict {
  path: string;
  emitted: boolean;
  /** The manifest entry covering this path, when the path is not emitted. */
  entry?: FieldDropEntry;
}
