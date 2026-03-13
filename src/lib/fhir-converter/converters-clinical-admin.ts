/**
 * FHIR -> Cascade converters for administrative/financial types.
 *
 * Converts:
 *   - Claim -> coverage:ClaimRecord
 *   - ExplanationOfBenefit -> coverage:BenefitStatement
 */

import type { Quad } from 'n3';

import {
  type ConversionResult,
  NS,
  extractCodings,
  codeableConceptText,
  tripleStr,
  tripleDouble,
  tripleRef,
  tripleType,
  tripleDateTime,
  commonTriples,
  quadsToJsonLd,
  mintSubjectUri,
} from './types.js';

// ---------------------------------------------------------------------------
// Claim converter (B3)
// ---------------------------------------------------------------------------

export function convertClaim(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.coverage + 'ClaimRecord'));
  quads.push(...commonTriples(subjectUri));

  // Claim date — from billablePeriod.start or created
  const claimDate = resource.billablePeriod?.start ?? resource.created;
  if (claimDate) {
    quads.push(tripleDateTime(subjectUri, NS.coverage + 'claimDate', claimDate));
  }

  // Status
  if (resource.status) {
    quads.push(tripleStr(subjectUri, NS.coverage + 'claimStatus', resource.status));
  }

  // Claim type
  const claimType = resource.type?.coding?.[0]?.code ?? codeableConceptText(resource.type);
  if (claimType) {
    quads.push(tripleStr(subjectUri, NS.coverage + 'claimType', claimType));
  }

  // Claim total
  if (resource.total?.value !== undefined) {
    quads.push(tripleDouble(subjectUri, NS.coverage + 'claimTotal', resource.total.value));
  }

  // Billing provider
  const provider = resource.provider?.display ?? resource.careTeam?.[0]?.provider?.display;
  if (provider) {
    quads.push(tripleStr(subjectUri, NS.coverage + 'billingProvider', provider));
  }

  // Diagnosis codes (ICD-10)
  if (Array.isArray(resource.diagnosis)) {
    for (const dx of resource.diagnosis) {
      const codings = extractCodings(dx.diagnosisCodeableConcept);
      for (const c of codings) {
        if (c.system === 'http://hl7.org/fhir/sid/icd-10-cm' || c.system === 'http://hl7.org/fhir/sid/icd-10') {
          quads.push(tripleStr(subjectUri, NS.coverage + 'hasDiagnosis', c.code));
        }
      }
    }
  }

  // Procedure codes (CPT)
  if (Array.isArray(resource.procedure)) {
    for (const proc of resource.procedure) {
      const codings = extractCodings(proc.procedureCodeableConcept);
      for (const c of codings) {
        quads.push(tripleStr(subjectUri, NS.coverage + 'hasProcedure', c.code));
      }
    }
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.coverage + 'sourceRecordId', resource.id));
  }

  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'FullyMapped'));

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'coverage:ClaimRecord'),
    warnings,
    resourceType: 'Claim',
    cascadeType: 'coverage:ClaimRecord',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// ExplanationOfBenefit converter (B3)
// ---------------------------------------------------------------------------

export function convertExplanationOfBenefit(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.coverage + 'BenefitStatement'));
  quads.push(...commonTriples(subjectUri));

  // Adjudication date — from billablePeriod.end or created
  const adjDate = resource.billablePeriod?.end ?? resource.created;
  if (adjDate) {
    quads.push(tripleDateTime(subjectUri, NS.coverage + 'adjudicationDate', adjDate));
  }

  // Status
  if (resource.status) {
    quads.push(tripleStr(subjectUri, NS.coverage + 'adjudicationStatus', resource.status));
  }

  // Outcome
  if (resource.outcome) {
    quads.push(tripleStr(subjectUri, NS.coverage + 'outcomeCode', resource.outcome));
  }

  // Denial reason from adjudication[].reason
  const denialReason = findDenialReason(resource);
  if (denialReason) {
    quads.push(tripleStr(subjectUri, NS.coverage + 'denialReason', denialReason));
  }

  // Totals — walk resource.total[] array
  if (Array.isArray(resource.total)) {
    for (const t of resource.total) {
      const category = t.category?.coding?.[0]?.code;
      const amount = t.amount?.value;
      if (amount === undefined) continue;
      if (category === 'submitted' || category === 'eligible') {
        quads.push(tripleDouble(subjectUri, NS.coverage + 'totalBilled', amount));
      } else if (category === 'allowed' || category === 'negotiated') {
        quads.push(tripleDouble(subjectUri, NS.coverage + 'totalAllowed', amount));
      } else if (category === 'benefit' || category === 'paid') {
        quads.push(tripleDouble(subjectUri, NS.coverage + 'totalPaid', amount));
      } else if (category === 'patientpay' || category === 'copay' || category === 'deductible') {
        quads.push(tripleDouble(subjectUri, NS.coverage + 'patientResponsibility', amount));
      }
    }
  }

  // Related claim via claim reference
  if (resource.claim?.reference) {
    const parts = (resource.claim.reference as string).split('/');
    const claimId = parts[parts.length - 1];
    if (claimId) {
      // Mint deterministic URI matching what convertClaim would produce for that id
      quads.push(tripleRef(subjectUri, NS.coverage + 'relatedClaim', `urn:uuid:${claimId}`));
    }
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.coverage + 'sourceRecordId', resource.id));
  }

  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'FullyMapped'));

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'coverage:BenefitStatement'),
    warnings,
    resourceType: 'ExplanationOfBenefit',
    cascadeType: 'coverage:BenefitStatement',
    _quads: quads,
  };
}

function findDenialReason(resource: any): string | undefined {
  if (!Array.isArray(resource.adjudication)) return undefined;
  for (const adj of resource.adjudication) {
    if (adj.reason) {
      return codeableConceptText(adj.reason) ?? adj.reason?.coding?.[0]?.code;
    }
  }
  // Also check item-level adjudication
  if (Array.isArray(resource.item)) {
    for (const item of resource.item) {
      if (Array.isArray(item.adjudication)) {
        for (const adj of item.adjudication) {
          if (adj.reason) {
            return codeableConceptText(adj.reason) ?? adj.reason?.coding?.[0]?.code;
          }
        }
      }
    }
  }
  return undefined;
}
