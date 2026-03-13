/**
 * Cascade -> FHIR reverse converters for administrative/financial types.
 *
 * Handles:
 *   coverage:ClaimRecord     -> Claim
 *   coverage:BenefitStatement -> ExplanationOfBenefit
 */

import { NS } from './types.js';

type PV = Map<string, string[]>;
type FhirResource = Record<string, any>;

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export function restoreClaimRecord(pv: PV, _warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'Claim',
    status: getFirst(NS.coverage + 'claimStatus') ?? 'active',
    use: 'claim',
  };

  const claimDate = getFirst(NS.coverage + 'claimDate');
  if (claimDate) fhirResource.created = claimDate;

  const claimType = getFirst(NS.coverage + 'claimType');
  if (claimType) fhirResource.type = { coding: [{ code: claimType }] };

  const provider = getFirst(NS.coverage + 'billingProvider');
  if (provider) fhirResource.provider = { display: provider };

  const total = getFirst(NS.coverage + 'claimTotal');
  if (total) fhirResource.total = { value: parseFloat(total) };

  const srcId = getFirst(NS.coverage + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  return fhirResource;
}

// ---------------------------------------------------------------------------
// Explanation of Benefit
// ---------------------------------------------------------------------------

export function restoreBenefitStatement(pv: PV, _warnings: string[]): FhirResource {
  const getFirst = (pred: string) => pv.get(pred)?.[0];

  const fhirResource: FhirResource = {
    resourceType: 'ExplanationOfBenefit',
    status: getFirst(NS.coverage + 'adjudicationStatus') ?? 'active',
    use: 'claim',
    outcome: getFirst(NS.coverage + 'outcomeCode') ?? 'complete',
  };

  const adjDate = getFirst(NS.coverage + 'adjudicationDate');
  if (adjDate) fhirResource.created = adjDate;

  const denialReason = getFirst(NS.coverage + 'denialReason');
  if (denialReason) fhirResource.adjudication = [{ reason: { text: denialReason } }];

  const totalBilled = getFirst(NS.coverage + 'totalBilled');
  const totalPaid = getFirst(NS.coverage + 'totalPaid');
  const totalArr: any[] = [];
  if (totalBilled) totalArr.push({ category: { coding: [{ code: 'submitted' }] }, amount: { value: parseFloat(totalBilled) } });
  if (totalPaid) totalArr.push({ category: { coding: [{ code: 'benefit' }] }, amount: { value: parseFloat(totalPaid) } });
  if (totalArr.length > 0) fhirResource.total = totalArr;

  const claimRef = getFirst(NS.coverage + 'relatedClaim');
  if (claimRef) fhirResource.claim = { reference: claimRef };

  const srcId = getFirst(NS.coverage + 'sourceRecordId');
  if (srcId) fhirResource.id = srcId;

  return fhirResource;
}
