/**
 * Layer 1 FHIR passthrough converter.
 *
 * For any FHIR resource type that doesn't have a full Layer 2 mapping,
 * preserves the original FHIR JSON inline for lossless round-trip export.
 *
 * Modes:
 *   full (default) — stores complete FHIR JSON in cascade:fhirJson; round-trip export supported
 *   minimal        — omits cascade:fhirJson; round-trip export not supported; smaller output
 */

import type { Quad } from 'n3';

import {
  type ConversionResult,
  NS,
  tripleStr,
  tripleRef,
  tripleType,
  tripleDateTime,
  commonTriples,
  quadsToJsonLd,
  mintSubjectUri,
} from './types.js';

/**
 * FHIR resource types that are intentionally excluded from conversion.
 * These are never converted or passed through — they are logged in the
 * import manifest with a documented reason and return null.
 */
export const EXCLUDED_TYPES = new Set([
  'SupplyDelivery',   // Logistics artifact — no patient health value
  'CareTeam',         // Personnel registry — captured via encounter provenance
  'CarePlan',         // Complex graph — deferred to future phase
  'Provenance',       // FHIR's own provenance artifacts — Cascade uses PROV-O natively
  'Medication',       // Standalone drug definition — meaning is in MedicationRequest/Statement
]);

export const EXCLUDED_REASONS: Record<string, string> = {
  SupplyDelivery: 'Logistics artifact (delivery of physical supplies). No patient health value.',
  CareTeam: 'Personnel registry. Care team context is captured via encounter provenance.',
  CarePlan: 'Structured care plans are complex graph objects. Deferred to future phase.',
  Provenance: "FHIR's own provenance artifacts. Cascade uses PROV-O natively.",
  Medication: 'Standalone medication definitional resources. Clinical meaning is in MedicationRequest/Statement.',
};

/**
 * Convert any unmapped FHIR resource to a Layer 1 passthrough record.
 *
 * @param resource  The FHIR resource object
 * @param minimal   If true, omits cascade:fhirJson (smaller output, no round-trip)
 */
export function convertFhirPassthrough(resource: any, minimal = false): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const resourceType = resource.resourceType as string ?? 'Unknown';
  const subjectUri = mintSubjectUri(resource);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.fhir + resourceType));
  quads.push(...commonTriples(subjectUri));

  // Layer promotion status — pending Layer 2 mapping
  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'PendingLayerTwoPromotion'));

  // Resource type string for filtering/display
  quads.push(tripleStr(subjectUri, NS.cascade + 'fhirResourceType', resourceType));

  // Minimal projection triples
  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceRecordId', resource.id));
  }

  // Best-effort date extraction
  const dateCandidate = resource.effectiveDateTime
    ?? resource.date
    ?? resource.period?.start
    ?? resource.created
    ?? resource.authoredOn
    ?? resource.occurrenceDateTime
    ?? resource.recordedDate;
  if (dateCandidate) {
    try {
      quads.push(tripleDateTime(subjectUri, NS.cascade + 'sourceRecordDate', dateCandidate));
    } catch {
      // Skip if date is unparseable
    }
  }

  if (minimal) {
    warnings.push(`${resourceType} preserved as Layer 1 passthrough (minimal mode) — round-trip export not supported`);
  } else {
    // Store complete FHIR JSON for lossless round-trip
    quads.push(tripleStr(subjectUri, NS.cascade + 'fhirJson', JSON.stringify(resource)));
    warnings.push(`${resourceType} preserved as Layer 1 passthrough — no Layer 2 mapping yet`);
  }

  const cascadeType = minimal ? `fhir-minimal:${resourceType}` : `fhir:${resourceType}`;

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, cascadeType),
    warnings,
    resourceType,
    cascadeType,
    _quads: quads,
  };
}
