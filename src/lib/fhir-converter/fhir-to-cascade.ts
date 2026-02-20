/**
 * FHIR -> Cascade dispatcher and public API.
 *
 * Routes FHIR resources to the appropriate per-type converter and
 * provides the main public conversion functions.
 *
 * Individual converters are in:
 *   - converters-clinical.ts     Medications, conditions, allergies, observations
 *   - converters-demographics.ts Patient, immunization, coverage
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
} from './converters-clinical.js';

import {
  convertPatient,
  convertImmunization,
  convertCoverage,
} from './converters-demographics.js';

// ---------------------------------------------------------------------------
// Main dispatcher: single FHIR resource -> Cascade
// ---------------------------------------------------------------------------

export function convertFhirResourceToQuads(fhirResource: any): (ConversionResult & { _quads: Quad[] }) | null {
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
    default:
      return null;
  }
}

export async function convertFhirToCascade(fhirResource: any): Promise<ConversionResult> {
  const result = convertFhirResourceToQuads(fhirResource);
  if (!result) {
    return {
      turtle: '',
      warnings: [`Unsupported FHIR resource type: ${fhirResource?.resourceType ?? 'unknown'}`],
      resourceType: fhirResource?.resourceType ?? 'unknown',
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
