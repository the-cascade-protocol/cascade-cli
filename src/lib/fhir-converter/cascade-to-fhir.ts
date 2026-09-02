/**
 * Cascade -> FHIR (reverse conversion) dispatcher.
 *
 * Parses Cascade Protocol Turtle using n3, identifies the resource type from
 * rdf:type, and dispatches to per-type handler functions. Each handler maps
 * Cascade predicates back to FHIR R4 fields.
 *
 * Not all Cascade fields have FHIR equivalents — lost fields are reported
 * as warnings.
 *
 * Handlers are organized by domain:
 *   cascade-to-fhir-clinical.ts     Clinical record types (medications, conditions, etc.)
 *   cascade-to-fhir-demographics.ts Patient, immunization, coverage
 *   cascade-to-fhir-admin.ts        Claim, ExplanationOfBenefit
 */

import { Parser, type Quad } from 'n3';
import { NS } from './types.js';

import {
  restoreMedicationRecord,
  restoreConditionRecord,
  restoreAllergyRecord,
  restoreLabResultRecord,
  restoreVitalSign,
  restoreProcedure,
  restoreClinicalDocument,
  restoreEncounter,
  restoreDiagnosticReport,
  restoreMedicationAdministration,
  restoreImplantedDevice,
  restoreImagingStudy,
} from './cascade-to-fhir-clinical.js';

import {
  restorePatientProfile,
  restoreImmunizationRecord,
  restoreInsurancePlan,
} from './cascade-to-fhir-demographics.js';

import {
  restoreClaimRecord,
  restoreBenefitStatement,
} from './cascade-to-fhir-admin.js';

/**
 * Convert Cascade Turtle to FHIR R4 JSON.
 */
export async function convertCascadeToFhir(turtle: string): Promise<{
  resources: any[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const resources: any[] = [];

  // Parse Turtle
  const parser = new Parser();
  const quads: Quad[] = [];
  try {
    const parsed = parser.parse(turtle);
    quads.push(...parsed);
  } catch (err: any) {
    return { resources: [], warnings: [`Turtle parse error: ${err.message}`] };
  }

  // Group quads by subject
  const subjects = new Map<string, Quad[]>();
  for (const q of quads) {
    const subj = q.subject.value;
    if (!subjects.has(subj)) subjects.set(subj, []);
    subjects.get(subj)!.push(q);
  }

  /** Predicate-value map for one subject. */
  const pvOf = (quadsForSubject: Quad[]): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const q of quadsForSubject) {
      const pred = q.predicate.value;
      if (!map.has(pred)) map.set(pred, []);
      map.get(pred)!.push(q.object.value);
    }
    return map;
  };

  /**
   * Read another subject in this graph, for restorers that have to follow an
   * edge to a structural SUB-NODE — today only `clinical:hasParticipant`.
   *
   * A sub-node is not a resource of its own: it exists to be read back into the
   * FHIR BackboneElement it came from. Passing a reader, rather than dispatching
   * on the node's own type, is what keeps that true — the node is reached from
   * the encounter that owns it and from nowhere else.
   */
  const resolveNode = (iri: string): Map<string, string[]> | undefined => {
    const quadsForSubject = subjects.get(iri);
    return quadsForSubject ? pvOf(quadsForSubject) : undefined;
  };

  for (const [subjectUri, subjectQuads] of subjects) {
    // Find rdf:type
    const typeQuad = subjectQuads.find(q => q.predicate.value === NS.rdf + 'type');
    if (!typeQuad) continue;

    const rdfType = typeQuad.object.value;

    // Structural sub-nodes are restored BY the record that owns them, never as
    // resources of their own. `clinical:EncounterParticipant` mirrors FHIR's
    // Encounter.participant BackboneElement, which has no independent existence
    // in FHIR at all; emitting one as a top-level resource would invent a
    // resource type, and falling through to the unknown-type branch below would
    // warn about a node this converter handles perfectly well.
    if (rdfType === NS.clinical + 'EncounterParticipant') continue;

    // Build predicate->value map
    const pv = pvOf(subjectQuads);

    // Dispatch to per-type handler
    let resource: any | null = null;

    if (rdfType === NS.clinical + 'Medication') {
      resource = restoreMedicationRecord(pv, warnings);
    } else if (rdfType === NS.health + 'ConditionRecord') {
      resource = restoreConditionRecord(pv, warnings);
    } else if (rdfType === NS.health + 'AllergyRecord') {
      resource = restoreAllergyRecord(pv, warnings);
    } else if (rdfType === NS.health + 'LabResultRecord') {
      resource = restoreLabResultRecord(pv, warnings);
    } else if (rdfType === NS.clinical + 'VitalSign') {
      resource = restoreVitalSign(pv, warnings);
    } else if (rdfType === NS.cascade + 'PatientProfile') {
      resource = restorePatientProfile(pv, warnings);
    } else if (rdfType === NS.health + 'ImmunizationRecord') {
      resource = restoreImmunizationRecord(pv, warnings);
    } else if (rdfType === NS.coverage + 'InsurancePlan') {
      resource = restoreInsurancePlan(pv, warnings);
    } else if (rdfType === NS.clinical + 'Procedure') {
      resource = restoreProcedure(pv, warnings);
    } else if (rdfType === NS.clinical + 'ClinicalDocument') {
      resource = restoreClinicalDocument(pv, warnings);
    } else if (rdfType === NS.clinical + 'Encounter') {
      resource = restoreEncounter(pv, warnings, resolveNode);
    } else if (
      rdfType === NS.clinical + 'LaboratoryReport' ||
      rdfType === NS.clinical + 'ImagingReport'
    ) {
      // Both classes come from a FHIR DiagnosticReport and restore to one.
      // Without the second arm an imaging report would fall past every branch
      // to the passthrough test, fail it (no cascade:fhirJson), and be
      // reported as an unknown Cascade type — the export losing exactly the
      // records 3.221 just started typing correctly.
      resource = restoreDiagnosticReport(pv, warnings);
    } else if (rdfType === NS.clinical + 'MedicationAdministration') {
      resource = restoreMedicationAdministration(pv, warnings);
    } else if (rdfType === NS.clinical + 'ImplantedDevice') {
      resource = restoreImplantedDevice(pv, warnings);
    } else if (rdfType === NS.clinical + 'ImagingStudy') {
      resource = restoreImagingStudy(pv, warnings);
    } else if (rdfType === NS.coverage + 'ClaimRecord') {
      resource = restoreClaimRecord(pv, warnings);
    } else if (rdfType === NS.coverage + 'BenefitStatement') {
      resource = restoreBenefitStatement(pv, warnings);
    } else if (pv.get(NS.cascade + 'layerPromotionStatus')?.[0] === NS.cascade + 'PendingLayerTwoPromotion') {
      // Layer 1 passthrough — restore original FHIR JSON verbatim
      const fhirJson = pv.get(NS.cascade + 'fhirJson')?.[0];
      if (fhirJson) {
        try {
          resources.push(JSON.parse(fhirJson));
        } catch {
          warnings.push(`Failed to parse passthrough FHIR JSON for subject: ${subjectUri}`);
        }
      } else {
        const resourceType = pv.get(NS.cascade + 'fhirResourceType')?.[0] ?? 'Unknown';
        warnings.push(`Passthrough record for ${resourceType} has no cascade:fhirJson — cannot restore (minimal mode?)`);
      }
      continue; // Already pushed (or warned); skip the push below
    } else {
      warnings.push(`Unknown Cascade RDF type: ${rdfType}`);
    }

    if (resource) resources.push(resource);
  }

  return { resources, warnings };
}
