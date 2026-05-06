/**
 * Tests for the ClinVar ReviewStatus → genomics:ReviewStatus enum
 * mapping (TASK-2A.5). The lookup table itself was added alongside
 * TASK-2A.3 (RCV parser depends on it); these tests pin the
 * canonical 7-tier mapping and the unknown-status fallback.
 */

import { describe, it, expect } from 'vitest';

import {
  mapReviewStatus,
  starRatingForReviewStatus,
  KNOWN_CLINVAR_REVIEW_STATUSES,
} from '../src/lib/clinvar-converter/review-status-map.js';

describe('mapReviewStatus (TASK-2A.5)', () => {
  it('maps the 7 canonical ClinVar review-status strings', () => {
    expect(mapReviewStatus('no assertion provided')).toBe('NoAssertionProvided');
    expect(mapReviewStatus('no assertion criteria provided')).toBe('CriteriaNotProvided');
    expect(mapReviewStatus('criteria provided, single submitter')).toBe('SingleSubmitter');
    expect(mapReviewStatus('criteria provided, conflicting interpretations')).toBe(
      'ConflictingSubmissions',
    );
    expect(mapReviewStatus('criteria provided, multiple submitters, no conflicts')).toBe(
      'MultipleSubmittersNoConflict',
    );
    expect(mapReviewStatus('reviewed by expert panel')).toBe('ExpertPanelReviewed');
    expect(mapReviewStatus('practice guideline')).toBe('PracticeGuideline');
  });

  it('maps the newer "conflicting classifications" wording to the same individual', () => {
    expect(mapReviewStatus('criteria provided, conflicting classifications')).toBe(
      'ConflictingSubmissions',
    );
    expect(
      mapReviewStatus('criteria provided, conflicting classifications of pathogenicity'),
    ).toBe('ConflictingSubmissions');
  });

  it('is case-insensitive on the leading word', () => {
    expect(mapReviewStatus('Reviewed by expert panel')).toBe('ExpertPanelReviewed');
    expect(mapReviewStatus('PRACTICE GUIDELINE')).toBe('PracticeGuideline');
  });

  it('trims surrounding whitespace', () => {
    expect(mapReviewStatus('  reviewed by expert panel  ')).toBe('ExpertPanelReviewed');
  });

  it('returns undefined for unknown / future status strings', () => {
    expect(mapReviewStatus('classified by stable diffusion model')).toBeUndefined();
    expect(mapReviewStatus('')).toBeUndefined();
    expect(mapReviewStatus(undefined)).toBeUndefined();
  });
});

describe('starRatingForReviewStatus (TASK-2A.5)', () => {
  it('maps each named-individual to the corresponding 0–4 star rating', () => {
    expect(starRatingForReviewStatus('NoAssertionProvided')).toBe(0);
    expect(starRatingForReviewStatus('CriteriaNotProvided')).toBe(0);
    expect(starRatingForReviewStatus('SingleSubmitter')).toBe(1);
    expect(starRatingForReviewStatus('ConflictingSubmissions')).toBe(1);
    expect(starRatingForReviewStatus('MultipleSubmittersNoConflict')).toBe(2);
    expect(starRatingForReviewStatus('ExpertPanelReviewed')).toBe(3);
    expect(starRatingForReviewStatus('PracticeGuideline')).toBe(4);
  });

  it('returns undefined for unknown names', () => {
    expect(starRatingForReviewStatus('NotAStatus')).toBeUndefined();
    expect(starRatingForReviewStatus(undefined)).toBeUndefined();
  });
});

describe('KNOWN_CLINVAR_REVIEW_STATUSES', () => {
  it('exposes every accepted source string for downstream tooling', () => {
    // Tooling can iterate this to validate user-supplied free text.
    expect(KNOWN_CLINVAR_REVIEW_STATUSES).toContain('reviewed by expert panel');
    expect(KNOWN_CLINVAR_REVIEW_STATUSES).toContain('practice guideline');
    expect(KNOWN_CLINVAR_REVIEW_STATUSES.length).toBeGreaterThanOrEqual(7);
  });
});
