/**
 * ClinVar `<ReviewStatus>` text → genomics:ReviewStatus named-individual
 * mapping (TASK-2A.5).
 *
 * The genomics v1-draft.0.1 ontology declares seven ReviewStatus named
 * individuals corresponding to the de-facto ClinGen / ClinVar tier
 * taxonomy:
 *
 *   ClinVar text                                          | genomics:        | star rating
 *   ------------------------------------------------------+------------------+-------------
 *   no assertion provided                                 | NoAssertionProvided      | 0
 *   no assertion criteria provided                        | CriteriaNotProvided      | 0
 *   criteria provided, single submitter                   | SingleSubmitter          | 1
 *   criteria provided, conflicting (interpretations|classifications)
 *                                                         | ConflictingSubmissions   | 1
 *   criteria provided, multiple submitters, no conflicts  | MultipleSubmittersNoConflict | 2
 *   reviewed by expert panel                              | ExpertPanelReviewed      | 3
 *   practice guideline                                    | PracticeGuideline        | 4
 *
 * The mapping is exact-string and case-insensitive on the leading word
 * because ClinVar occasionally uppercases the first character. Returns
 * undefined for unknown values; the caller emits a warning gap.
 */

const TABLE: Record<string, string> = {
  'no assertion provided': 'NoAssertionProvided',
  'no assertion criteria provided': 'CriteriaNotProvided',
  'criteria provided, single submitter': 'SingleSubmitter',
  // ClinVar has used both phrasings over time; map both to the same individual.
  'criteria provided, conflicting interpretations': 'ConflictingSubmissions',
  'criteria provided, conflicting classifications': 'ConflictingSubmissions',
  'criteria provided, conflicting classifications of pathogenicity': 'ConflictingSubmissions',
  'criteria provided, multiple submitters, no conflicts': 'MultipleSubmittersNoConflict',
  'reviewed by expert panel': 'ExpertPanelReviewed',
  'practice guideline': 'PracticeGuideline',
};

/**
 * Map a ClinVar review-status string to the corresponding
 * genomics:ReviewStatus named-individual local name. Returns undefined
 * for unknown / future statuses; the caller emits a warning gap.
 */
export function mapReviewStatus(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = text.trim().toLowerCase();
  return TABLE[normalized];
}

/**
 * Star rating (0..4) for a given genomics:ReviewStatus local name. Useful
 * when a downstream tool wants the integer rating without the named
 * individual. Returns undefined for unknown names.
 */
export function starRatingForReviewStatus(name: string | undefined): number | undefined {
  switch (name) {
    case 'NoAssertionProvided':
    case 'CriteriaNotProvided':
      return 0;
    case 'SingleSubmitter':
    case 'ConflictingSubmissions':
      return 1;
    case 'MultipleSubmittersNoConflict':
      return 2;
    case 'ExpertPanelReviewed':
      return 3;
    case 'PracticeGuideline':
      return 4;
    default:
      return undefined;
  }
}

/** All ClinVar review-status strings the table accepts. */
export const KNOWN_CLINVAR_REVIEW_STATUSES: ReadonlyArray<string> = Object.keys(TABLE);
