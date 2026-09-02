/**
 * FHIR -> Cascade dispatcher and public API.
 *
 * Routes FHIR resources to the appropriate per-type converter and
 * provides the main public conversion functions.
 *
 * Individual converters are in:
 *   - converters-clinical.ts      Medications, conditions, allergies, observations,
 *                                  procedures, encounters, clinical documents, lab reports,
 *                                  medication admin, devices, imaging studies
 *   - converters-demographics.ts  Patient, immunization, coverage
 *   - converters-clinical-admin.ts Claim, ExplanationOfBenefit
 *   - converters-passthrough.ts   Layer 1 FHIR passthrough for unknown types
 */

import type { Quad } from 'n3';

import { type ConversionResult, NS, quadsToTurtle } from './types.js';
import { resolveReferenceEdges } from './reference-resolution.js';

import {
  convertMedicationStatement,
  convertCondition,
  convertAllergyIntolerance,
  isVitalSignObservation,
  convertObservationLab,
  convertObservationVital,
  convertProcedure,
  convertClinicalDocument,
  convertEncounter,
  convertDiagnosticReport,
  convertMedicationAdministration,
  convertDevice,
  convertImagingStudy,
} from './converters-clinical.js';

import {
  convertPatient,
  convertImmunization,
  convertCoverage,
} from './converters-demographics.js';

import {
  convertClaim,
  convertExplanationOfBenefit,
} from './converters-clinical-admin.js';

import {
  convertFhirPassthrough,
  EXCLUDED_TYPES,
} from './converters-passthrough.js';

import { appendProvenanceQuads } from './provenance.js';

// ---------------------------------------------------------------------------
// Main dispatcher: single FHIR resource -> Cascade
// ---------------------------------------------------------------------------

export function convertFhirResourceToQuads(fhirResource: any, passthroughMinimal = false): (ConversionResult & { _quads: Quad[] }) | null {
  const result = dispatchFhirResource(fhirResource, passthroughMinimal);
  // Recover the performing clinician + source EHR/organization that the per-type
  // converters historically dropped for most types ("Cascade does not drop
  // data"). Additive + idempotent; see provenance.ts.
  if (result) appendProvenanceQuads(fhirResource, result._quads);
  // NOTE: the identity door's tier-4 collapse warning is NOT re-derived here.
  // An earlier revision did exactly that, and it looked right — the dispatcher
  // is one place covering every converter — but it only reached callers who came
  // through the dispatcher. `convertCondition(...)` called directly returned an
  // empty `warnings`, so the "this tier must not be silent" contract was true on
  // the genomics and C-CDA paths and false on the most reachable one in the repo.
  // The warning now originates where the identity is actually minted, inside
  // `mintSubjectUri` / `contentHashedUri`, so it reaches every caller of every
  // converter. Re-deriving it here as well would duplicate it.
  return result;
}

function dispatchFhirResource(fhirResource: any, passthroughMinimal: boolean): (ConversionResult & { _quads: Quad[] }) | null {
  const resourceType = fhirResource?.resourceType as string | undefined;
  if (!resourceType) return null;

  switch (resourceType) {
    case 'MedicationStatement':
    case 'MedicationRequest':
      return convertMedicationStatement(fhirResource);
    case 'Condition':
      return convertCondition(fhirResource);
    case 'AllergyIntolerance':
      return convertAllergyIntolerance(fhirResource);
    case 'Observation':
      if (isVitalSignObservation(fhirResource)) {
        return convertObservationVital(fhirResource);
      }
      return convertObservationLab(fhirResource);
    case 'Patient':
      return convertPatient(fhirResource);
    case 'Immunization':
      return convertImmunization(fhirResource);
    case 'Coverage':
      return convertCoverage(fhirResource);
    case 'Procedure':
      return convertProcedure(fhirResource);
    case 'DocumentReference':
      return convertClinicalDocument(fhirResource);
    case 'Encounter':
      return convertEncounter(fhirResource);
    case 'DiagnosticReport':
      // Not always a laboratory report: the converter routes on
      // DiagnosticReport.category and may return clinical:ImagingReport. See
      // routeDiagnosticReport (3.221).
      return convertDiagnosticReport(fhirResource);
    case 'MedicationAdministration':
      return convertMedicationAdministration(fhirResource);
    case 'Device':
      return convertDevice(fhirResource);
    case 'ImagingStudy':
      return convertImagingStudy(fhirResource);
    case 'Claim':
      return convertClaim(fhirResource);
    case 'ExplanationOfBenefit':
      return convertExplanationOfBenefit(fhirResource);
    default: {
      if (EXCLUDED_TYPES.has(resourceType)) {
        // Intentionally excluded — log to manifest as excluded, return null
        return null;
      }
      // Layer 1 passthrough for everything else
      return convertFhirPassthrough(fhirResource, passthroughMinimal);
    }
  }
}

export async function convertFhirToCascade(fhirResource: any, passthroughMinimal = false): Promise<ConversionResult> {
  const result = convertFhirResourceToQuads(fhirResource, passthroughMinimal);
  if (!result) {
    const resourceType = fhirResource?.resourceType ?? 'unknown';
    return {
      turtle: '',
      warnings: [`Unsupported FHIR resource type: ${resourceType}`],
      resourceType,
      cascadeType: 'unknown',
    };
  }

  // Resolve reference edges so no unresolved placeholder ever leaks into single
  // -resource output. A lone resource has no in-scope targets, so its cross-record
  // references (e.g. a DiagnosticReport's hasLabResult) correctly drop rather than
  // dangle. The batch converter (convert() in index.ts) is where a full bundle's
  // references actually resolve against sibling records.
  const subject = result._quads.find((q) => q.predicate.value === NS.rdf + 'type')?.subject.value;
  const resources = subject && fhirResource?.resourceType
    ? [{ resourceType: fhirResource.resourceType as string, id: fhirResource.id as string | undefined, subject }]
    : [];
  const { quads } = resolveReferenceEdges(result._quads, resources);

  const turtle = await quadsToTurtle(quads);
  return {
    turtle,
    jsonld: result.jsonld,
    warnings: result.warnings,
    resourceType: result.resourceType,
    cascadeType: result.cascadeType,
  };
}
