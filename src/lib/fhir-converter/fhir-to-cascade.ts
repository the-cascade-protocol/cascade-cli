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

import { type ConversionResult, quadsToTurtle } from './types.js';

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
  convertLaboratoryReport,
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

// ---------------------------------------------------------------------------
// Main dispatcher: single FHIR resource -> Cascade
// ---------------------------------------------------------------------------

export function convertFhirResourceToQuads(fhirResource: any, passthroughMinimal = false): (ConversionResult & { _quads: Quad[] }) | null {
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
      return convertLaboratoryReport(fhirResource);
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

  const turtle = await quadsToTurtle(result._quads);
  return {
    turtle,
    jsonld: result.jsonld,
    warnings: result.warnings,
    resourceType: result.resourceType,
    cascadeType: result.cascadeType,
  };
}
