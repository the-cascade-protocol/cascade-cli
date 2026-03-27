/**
 * FHIR conversion utilities.
 *
 * Converts between FHIR R4 JSON and Cascade Protocol RDF (Turtle/JSON-LD).
 *
 * Supported FHIR R4 resource types (Layer 2 — full vocabulary mapping):
 *   - MedicationStatement / MedicationRequest -> health:MedicationRecord
 *   - Condition                               -> health:ConditionRecord
 *   - AllergyIntolerance                      -> health:AllergyRecord
 *   - Observation (lab)                       -> health:LabResultRecord
 *   - Observation (vital signs)               -> clinical:VitalSign
 *   - Patient                                 -> cascade:PatientProfile
 *   - Immunization                            -> health:ImmunizationRecord
 *   - Coverage                                -> coverage:InsurancePlan
 *   - Procedure                               -> clinical:Procedure
 *   - DocumentReference                       -> clinical:ClinicalDocument
 *   - Encounter                               -> clinical:Encounter
 *   - DiagnosticReport                        -> clinical:LaboratoryReport
 *   - MedicationAdministration                -> clinical:MedicationAdministration
 *   - Device                                  -> clinical:ImplantedDevice
 *   - ImagingStudy                            -> clinical:ImagingStudy
 *   - Claim                                   -> coverage:ClaimRecord
 *   - ExplanationOfBenefit                    -> coverage:BenefitStatement
 *
 * All other resource types receive Layer 1 passthrough (stored as fhir:{Type}).
 * Explicitly excluded types: SupplyDelivery, CareTeam, CarePlan, Provenance, Medication.
 *
 * Zero network calls. All conversion is local.
 *
 * This module re-exports all public API.
 * Internal implementation is split across:
 *   - types.ts                  Shared types, namespaces, and quad helpers
 *   - fhir-to-cascade.ts        FHIR -> Cascade dispatcher
 *   - converters-clinical.ts    Clinical resource converters
 *   - converters-demographics.ts Patient, immunization, coverage converters
 *   - converters-clinical-admin.ts Claim, EOB converters
 *   - converters-passthrough.ts  Layer 1 passthrough for unknown types
 *   - cascade-to-fhir.ts        Cascade -> FHIR reverse converters
 */

import type { Quad } from 'n3';

import { DataFactory } from 'n3';

import {
  type InputFormat,
  type OutputFormat,
  type ConversionResult,
  type BatchConversionResult,
  NS,
  quadsToTurtle,
  quadsToJsonLd,
} from './types.js';

const { namedNode, literal, quad: makeQuad } = DataFactory;

import { convertFhirResourceToQuads } from './fhir-to-cascade.js';
import { convertCascadeToFhir } from './cascade-to-fhir.js';
import { EXCLUDED_TYPES } from './converters-passthrough.js';

// Re-export public types
export type { InputFormat, OutputFormat, ConversionResult, BatchConversionResult };

// Re-export public functions from sub-modules
export { convertFhirResourceToQuads, convertFhirToCascade } from './fhir-to-cascade.js';
export { convertCascadeToFhir } from './cascade-to-fhir.js';

// ---------------------------------------------------------------------------
// Batch conversion (FHIR Bundle support)
// ---------------------------------------------------------------------------

/**
 * Convert an entire FHIR input (single resource or Bundle) to Cascade format.
 *
 * @param passthroughMinimal  If true, omits cascade:fhirJson from passthrough records.
 *                            Round-trip export is not supported in minimal mode.
 *                            Produces smaller output for display-only scenarios.
 */
export async function convert(
  input: string,
  from: InputFormat,
  to: OutputFormat,
  outputSerialization: 'turtle' | 'jsonld' = 'turtle',
  sourceSystem?: string,
  passthroughMinimal = false,
): Promise<BatchConversionResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const results: ConversionResult[] = [];
  let skippedCount = 0;

  if (from === 'fhir' && (to === 'cascade' || to === 'turtle' || to === 'jsonld')) {
    // FHIR -> Cascade
    let parsed: any;
    try {
      parsed = JSON.parse(input);
    } catch {
      return {
        success: false, output: '', format: to, resourceCount: 0, skippedCount: 0,
        warnings: [], errors: ['Invalid JSON input'], results: [],
      };
    }

    // Collect resources from Bundle or single resource
    const fhirResources: any[] = [];
    if (parsed.resourceType === 'Bundle' && Array.isArray(parsed.entry)) {
      for (const entry of parsed.entry) {
        if (entry.resource) fhirResources.push(entry.resource);
      }
    } else if (parsed.resourceType) {
      fhirResources.push(parsed);
    } else {
      return {
        success: false, output: '', format: to, resourceCount: 0, skippedCount: 0,
        warnings: [], errors: ['Input does not appear to be a FHIR resource or Bundle'], results: [],
      };
    }

    const allQuads: Quad[] = [];
    for (const res of fhirResources) {
      if (EXCLUDED_TYPES.has(res.resourceType)) {
        skippedCount++;
        continue;
      }
      const result = convertFhirResourceToQuads(res, passthroughMinimal);
      if (result) {
        allQuads.push(...result._quads);
        results.push({
          turtle: '', // will be filled with combined output
          jsonld: result.jsonld,
          warnings: result.warnings,
          resourceType: result.resourceType,
          cascadeType: result.cascadeType,
        });
        warnings.push(...result.warnings);
      }
    }

    if (allQuads.length === 0) {
      return {
        success: false, output: '', format: to, resourceCount: 0, skippedCount,
        warnings, errors: ['No convertible FHIR resources found'], results: [],
      };
    }

    // Inject cascade:sourceSystem into every record if --source-system was given.
    // Also inject clinical:importedAt and clinical:sourceEHR for ClinicalDocument subtypes
    // (LaboratoryReport, ImagingReport, etc.) which require these fields per the SHACL shapes.
    const clinicalDocTypes = new Set([
      NS.clinical + 'LaboratoryReport',
      NS.clinical + 'ImagingReport',
      NS.clinical + 'ClinicalDocument',
      NS.clinical + 'VisitSummary',
    ]);
    const conversionTimestamp = new Date().toISOString();
    const clinicalDocSubjects = new Set<string>();
    const recordSubjects = new Set<string>();
    for (const q of allQuads) {
      if (q.predicate.value === NS.rdf + 'type') {
        recordSubjects.add(q.subject.value);
        if (clinicalDocTypes.has(q.object.value)) {
          clinicalDocSubjects.add(q.subject.value);
        }
      }
    }
    if (sourceSystem) {
      for (const subjectUri of recordSubjects) {
        allQuads.push(
          makeQuad(
            namedNode(subjectUri),
            namedNode(NS.cascade + 'sourceSystem'),
            literal(sourceSystem),
          ),
        );
      }
    }
    for (const subjectUri of clinicalDocSubjects) {
      allQuads.push(
        makeQuad(namedNode(subjectUri), namedNode(NS.clinical + 'importedAt'),
          literal(conversionTimestamp, namedNode(NS.xsd + 'dateTime'))),
      );
      if (sourceSystem) {
        allQuads.push(
          makeQuad(namedNode(subjectUri), namedNode(NS.clinical + 'sourceEHR'), literal(sourceSystem)),
        );
      }
    }

    // Determine output format
    let output: string;
    if (outputSerialization === 'jsonld' || to === 'jsonld') {
      const jsonLd = quadsToJsonLd(allQuads, results[0]?.cascadeType ?? '');
      output = JSON.stringify(jsonLd, null, 2);
    } else {
      output = await quadsToTurtle(allQuads);
    }

    return {
      success: true,
      output,
      format: to === 'cascade' ? (outputSerialization === 'jsonld' ? 'jsonld' : 'turtle') : to,
      resourceCount: results.length,
      skippedCount,
      warnings,
      errors,
      results,
    };
  } else if (from === 'cascade' && to === 'fhir') {
    // Cascade -> FHIR
    const { resources, warnings: convWarnings } = await convertCascadeToFhir(input);
    warnings.push(...convWarnings);

    if (resources.length === 0) {
      return {
        success: false, output: '', format: 'fhir', resourceCount: 0, skippedCount: 0,
        warnings, errors: ['No resources converted from Cascade Turtle'], results: [],
      };
    }

    const output = resources.length === 1
      ? JSON.stringify(resources[0], null, 2)
      : JSON.stringify({ resourceType: 'Bundle', type: 'collection', entry: resources.map(r => ({ resource: r })) }, null, 2);

    return {
      success: true,
      output,
      format: 'fhir',
      resourceCount: resources.length,
      skippedCount: 0,
      warnings,
      errors,
      results: resources.map(r => ({
        turtle: '',
        warnings: [],
        resourceType: r.resourceType,
        cascadeType: 'fhir',
      })),
    };
  } else if (from === 'c-cda') {
    // Native C-CDA converter — preserves CVX, LOINC, SNOMED, RxNorm, ICD-10 codes
    const { convertCcda } = await import('../ccda-converter/index.js');

    // Detect if input looks like an IHE XDM zip (binary PK header)
    let inputData: string | Buffer;
    const firstTwo = input.charCodeAt(0) === 0x50 && input.charCodeAt(1) === 0x4b;
    if (firstTwo) {
      inputData = Buffer.from(input, 'binary');
    } else {
      inputData = input;
    }

    return await convertCcda(inputData, {
      sourceSystem,
      importedAt: new Date().toISOString(),
    });
  } else {
    return {
      success: false, output: '', format: to, resourceCount: 0, skippedCount: 0,
      warnings: [], errors: [`Unsupported conversion: ${from} -> ${to}`], results: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/**
 * Detect the format of input data by inspecting its content.
 */
export function detectFormat(input: string): InputFormat | null {
  const trimmed = input.trim();

  // Check for FHIR JSON (has "resourceType")
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.resourceType) return 'fhir';
      if (parsed['@context'] || parsed['@type']) return 'cascade'; // JSON-LD
    } catch {
      // Not valid JSON
    }
  }

  // Check for Turtle (has @prefix declarations or common Cascade namespace URIs)
  if (
    trimmed.includes('@prefix') ||
    trimmed.includes('ns.cascadeprotocol.org') ||
    /^<[^>]+>\s+a\s+/.test(trimmed)
  ) {
    return 'cascade';
  }

  // Check for C-CDA (XML with ClinicalDocument root)
  if (trimmed.startsWith('<?xml') || trimmed.includes('<ClinicalDocument')) {
    return 'c-cda';
  }

  return null;
}
