/**
 * ServiceRequest → GeneticTestOrder parser.
 *
 * Maps FHIR ServiceRequest resources to `genomics:GeneticTestOrder`. Used
 * by counseling workflows to track 'ordered but not yet resulted' state.
 *
 * Mapping:
 *   status                       → genomics:orderStatus (FHIR
 *                                    request-status → OrderStatus named
 *                                    individuals: active → InProgress,
 *                                    completed → Resulted, draft → Pending,
 *                                    revoked / entered-in-error → Cancelled)
 *   authoredOn / occurrence      → genomics:orderedAt (xsd:dateTime)
 *   reasonCode[0].text           → cascade:notes (no first-class field on
 *                                    GeneticTestOrder for ordering reason
 *                                    in v1-draft; emit gap)
 *
 * The reverse `resultedIn` link from this Order to its fulfilling
 * GeneticTest is set by the DiagnosticReport parser (TASK-1.6) when the
 * DR's `basedOn` field references this ServiceRequest. (Discovery
 * happens via the idIndex.)
 */

import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import {
  GENOMICS_NS,
  type ParsedRecord,
  type Quad,
} from './types.js';
import {
  NS,
  SCHEMA_VERSION,
  tripleType,
  tripleStr,
  tripleRef,
  tripleDateTime,
  deterministicUuid,
} from '../fhir-converter/types.js';

export interface ServiceRequestParseOutput {
  record: ParsedRecord;
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

function mintOrderIri(resource: any, ctx: ImportContext): string {
  const id = resource?.id ?? Math.random().toString(36);
  const sys = ctx.sourceSystem ?? 'fhir-genomics';
  return `urn:uuid:${deterministicUuid(`genomics:GeneticTestOrder:${sys}:${id}`)}`;
}

/**
 * Map a FHIR ServiceRequest.status to a genomics:OrderStatus named
 * individual. Unknown values default to OrderPending with an info-gap.
 */
function mapStatus(fhirStatus: string | undefined): { individual: string; recognized: boolean } {
  switch (fhirStatus) {
    case 'draft':
      return { individual: 'OrderPending', recognized: true };
    case 'active':
    case 'on-hold':
      return { individual: 'OrderInProgress', recognized: true };
    case 'completed':
      return { individual: 'OrderResulted', recognized: true };
    case 'revoked':
    case 'entered-in-error':
      return { individual: 'OrderCancelled', recognized: true };
    default:
      return { individual: 'OrderPending', recognized: false };
  }
}

export function parseServiceRequest(
  resource: any,
  ctx: ImportContext,
): ServiceRequestParseOutput | null {
  if (!resource || resource.resourceType !== 'ServiceRequest') return null;

  const sourceId: string = resource.id ?? '<no-id>';
  const iri = mintOrderIri(resource, ctx);
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];

  quads.push(tripleType(iri, GENOMICS_NS + 'GeneticTestOrder'));
  quads.push(tripleRef(iri, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'));
  quads.push(tripleStr(iri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));

  // Order status
  const { individual, recognized } = mapStatus(resource.status);
  quads.push(tripleRef(iri, GENOMICS_NS + 'orderStatus', GENOMICS_NS + individual));
  if (!recognized) {
    gaps.push({
      sourceField: `ServiceRequest/${sourceId}.status`,
      reason: `FHIR ServiceRequest.status "${resource.status ?? '<missing>'}" not mapped — defaulted to OrderPending.`,
      severity: 'info',
      context: sourceId,
    });
  }

  // Ordered at — authoredOn preferred; occurrenceDateTime as fallback.
  const orderedAt: string | undefined =
    resource.authoredOn ?? resource.occurrenceDateTime ?? resource.occurrencePeriod?.start;
  if (orderedAt) {
    quads.push(tripleDateTime(iri, GENOMICS_NS + 'orderedAt', orderedAt));
  } else {
    gaps.push({
      sourceField: `ServiceRequest/${sourceId}.authoredOn`,
      reason: 'ServiceRequest has no authoredOn or occurrence date; orderedAt cannot be populated.',
      severity: 'info',
      context: sourceId,
    });
  }

  // Reason for the order — no first-class field in v1-draft.
  const reasonText: string | undefined =
    resource.reasonCode?.[0]?.text ??
    resource.reasonCode?.[0]?.coding?.[0]?.display;
  if (reasonText) {
    gaps.push({
      sourceField: `ServiceRequest/${sourceId}.reasonCode`,
      reason: `Order reason "${reasonText}" recognized but no genomics:GeneticTestOrder property in v1-draft to attach it. Stored as cascade:notes for now.`,
      severity: 'info',
      context: sourceId,
    });
    quads.push(tripleStr(iri, NS.cascade + 'notes', reasonText));
  }

  // Source identity passthrough.
  quads.push(tripleStr(iri, NS.cascade + 'sourceFhirId', sourceId));

  void warnings;

  const record: ParsedRecord = {
    iri,
    cascadeType: 'genomics:GeneticTestOrder',
    sourceId,
    fhirResourceType: 'ServiceRequest',
    quads,
  };

  return { record, warnings, gaps };
}
