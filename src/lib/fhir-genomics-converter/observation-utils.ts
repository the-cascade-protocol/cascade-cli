/**
 * Common helpers for walking FHIR Genomics IG Observation `component`
 * arrays and resolving LOINC-keyed components / codings.
 *
 * These exist to keep the per-profile parsers (variant, haplotype,
 * genotype, diagnostic-implication) thin and consistent.
 */

import { CODING_SYSTEMS } from './types.js';

/** A FHIR Coding object. */
export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
  version?: string;
}

/** A FHIR component (Observation.component[i]). */
export interface FhirComponent {
  code?: { coding?: FhirCoding[] };
  valueCodeableConcept?: { coding?: FhirCoding[]; text?: string };
  valueQuantity?: { value?: number; unit?: string; code?: string; system?: string };
  valueString?: string;
  valueRange?: { low?: { value?: number }; high?: { value?: number } };
}

/** Returns true if any coding on a CodeableConcept is from the LOINC system. */
export function isLoincSystemUrl(system: string | undefined): boolean {
  if (!system) return false;
  return system === CODING_SYSTEMS.loinc || system === 'https://loinc.org' || system === 'http://loinc.org/';
}

/** Find the first coding under code.coding that's LOINC and return its `code`. */
export function loincCodeOfComponent(c: FhirComponent): string | undefined {
  const codings = c.code?.coding ?? [];
  for (const coding of codings) {
    if (isLoincSystemUrl(coding.system)) {
      return coding.code;
    }
  }
  return undefined;
}

/**
 * Iterate every component on an Observation that's keyed by the given
 * LOINC code. (Some components like 81252-9 may appear multiple times
 * with different valueCodeableConcept codings — discrete-variant + dbSNP
 * are both 81252-9 in the cgexample bundle.)
 */
export function componentsByLoinc(
  obs: any,
  loincCode: string,
): FhirComponent[] {
  const components: FhirComponent[] = obs?.component ?? [];
  return components.filter((c) => loincCodeOfComponent(c) === loincCode);
}

/** Convenience — first component matching the given LOINC code. */
export function firstComponentByLoinc(
  obs: any,
  loincCode: string,
): FhirComponent | undefined {
  return componentsByLoinc(obs, loincCode)[0];
}

/** First coding on a CodeableConcept whose `system` matches `system`. */
export function findCoding(
  cc: { coding?: FhirCoding[] } | undefined,
  system: string,
): FhirCoding | undefined {
  return cc?.coding?.find((c) => c.system === system);
}

/** First non-empty string from a CodeableConcept: text > display > code. */
export function ccDisplayOrCode(cc: { coding?: FhirCoding[]; text?: string } | undefined): string | undefined {
  if (!cc) return undefined;
  if (cc.text) return cc.text;
  for (const c of cc.coding ?? []) {
    if (c.display) return c.display;
    if (c.code) return c.code;
  }
  return undefined;
}

/** First raw `code` from a CodeableConcept's coding array. */
export function ccCode(cc: { coding?: FhirCoding[] } | undefined): string | undefined {
  return cc?.coding?.[0]?.code;
}
