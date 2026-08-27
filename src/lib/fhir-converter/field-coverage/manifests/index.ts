/**
 * The drop-manifest registry: every converter's written record of the fields it
 * does not emit.
 *
 * A resource type with NO manifest here is not "clean" — it is unexamined, and
 * the conformance test says so rather than passing it. Adding a type means
 * authoring its fixture and its manifest together.
 */

import type { FieldDropEntry, FieldDropManifest } from '../types.js';

import { ALLERGY_INTOLERANCE_DROPS } from './allergyintolerance.js';
import { CONDITION_DROPS } from './condition.js';
import { COVERAGE_DROPS } from './coverage.js';
import { DIAGNOSTIC_REPORT_DROPS } from './diagnosticreport.js';
import { DOCUMENT_REFERENCE_DROPS } from './documentreference.js';
import { ENCOUNTER_DROPS } from './encounter.js';
import { IMMUNIZATION_DROPS } from './immunization.js';
import { MEDICATION_REQUEST_DROPS } from './medicationrequest.js';
import { OBSERVATION_DROPS } from './observation.js';
import { PATIENT_DROPS } from './patient.js';

export const FIELD_DROP_MANIFESTS: readonly FieldDropManifest[] = [
  ALLERGY_INTOLERANCE_DROPS,
  CONDITION_DROPS,
  COVERAGE_DROPS,
  DIAGNOSTIC_REPORT_DROPS,
  DOCUMENT_REFERENCE_DROPS,
  ENCOUNTER_DROPS,
  IMMUNIZATION_DROPS,
  MEDICATION_REQUEST_DROPS,
  OBSERVATION_DROPS,
  PATIENT_DROPS,
];

const BY_TYPE = new Map<string, FieldDropManifest>(
  FIELD_DROP_MANIFESTS.map((m) => [m.resourceType, m]),
);

/** The manifest for a resource type, or `undefined` if the type has none yet. */
export function manifestFor(resourceType: string): FieldDropManifest | undefined {
  return BY_TYPE.get(resourceType);
}

/** The drop entry covering one element path, if the converter declared one. */
export function lookupFieldDrop(resourceType: string, path: string): FieldDropEntry | undefined {
  return BY_TYPE.get(resourceType)?.drops[path];
}

/** Every resource type that has a drop manifest. */
export function manifestedTypes(): string[] {
  return [...BY_TYPE.keys()].sort();
}
