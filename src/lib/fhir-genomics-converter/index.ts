/**
 * Public surface for the FHIR Genomics IG → Cascade converter.
 *
 * The orchestrator function `convertGenomicsBundle()` walks a parsed FHIR
 * Bundle (or a single resource), dispatches each entry to its profile-
 * specific parser, and returns the merged quad stream + per-record
 * metadata.
 *
 * Stub at TASK-1.1: dispatcher returns an empty result for every bundle.
 * TASK-1.2 onward each plug in one parser.
 */

import type { Quad } from 'n3';
import type {
  ImportContext,
  ImportWarning,
  VocabularyGap,
  ImportedIdentifier,
} from '../import-types.js';
import type { ParsedRecord } from './types.js';
import { GENOMICS_PROFILES } from './types.js';
import { parseVariantObservation } from './observation-variant.js';
import { parseHaplotypeObservation } from './observation-haplotype.js';
import { parseGenotypeObservation } from './observation-genotype.js';
import { parseDiagnosticImplication } from './observation-diagnostic-implication.js';
import { parseDiagnosticReport } from './diagnostic-report.js';
import { parseServiceRequest } from './service-request.js';

export { detectFhirGenomics } from './detect.js';
export { fhirGenomicsImporter } from './registry-entry.js';

export interface GenomicsConversionResult {
  records: ParsedRecord[];
  quads: Quad[];
  warnings: ImportWarning[];
  vocabularyGaps: VocabularyGap[];
  importedIdentifiers: ImportedIdentifier[];
  skippedCount: number;
}

/**
 * Determine which parser handles a given Observation by inspecting its
 * `meta.profile` URLs. Returns the profile constant or null.
 */
function profileOf(resource: any): string | null {
  const profiles: unknown = resource?.meta?.profile;
  if (!Array.isArray(profiles)) return null;
  for (const p of profiles) {
    if (typeof p !== 'string') continue;
    for (const known of Object.values(GENOMICS_PROFILES)) {
      if (p === known) return known;
    }
  }
  return null;
}

/**
 * Walk a parsed FHIR Bundle / resource and dispatch each entry to its
 * profile-specific parser. Two-pass: first pass parses Variant /
 * Haplotype / Genotype / ServiceRequest into records and a sourceId →
 * IRI index; second pass parses dependents (DiagnosticReport,
 * diagnostic-implication) which need cross-references resolved.
 */
export async function convertGenomicsBundle(
  parsed: any,
  ctx: ImportContext,
): Promise<GenomicsConversionResult> {
  const records: ParsedRecord[] = [];
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const vocabularyGaps: VocabularyGap[] = [];
  const importedIdentifiers: ImportedIdentifier[] = [];
  let skippedCount = 0;

  // Cross-reference index: FHIR id ("Observation/discrete-variant" or just
  // "discrete-variant" or "urn:uuid:...") → minted Cascade IRI.
  const idIndex = new Map<string, string>();

  const resources: any[] =
    parsed?.resourceType === 'Bundle'
      ? (parsed.entry ?? []).map((e: any) => e?.resource).filter(Boolean)
      : [parsed];

  // -------- Pass 1: Variants, Haplotypes, ServiceRequests --------
  // Variants must land first so haplotype/genotype `hasComponent` references resolve.
  for (const r of resources) {
    if (!r || typeof r !== 'object') continue;
    const profile = profileOf(r);
    if (r.resourceType === 'Observation' && profile === GENOMICS_PROFILES.variant) {
      const out = parseVariantObservation(r, ctx);
      if (out) {
        records.push(out.record);
        quads.push(...out.record.quads);
        warnings.push(...out.warnings);
        vocabularyGaps.push(...out.gaps);
        importedIdentifiers.push({
          cascadeIri: out.record.iri,
          cascadeType: out.record.cascadeType,
          sourceType: 'FHIR.Observation.variant',
          sourceId: out.record.sourceId,
        });
        registerId(idIndex, r, out.record.iri);
      }
    } else if (r.resourceType === 'ServiceRequest') {
      const out = parseServiceRequest(r, ctx);
      if (out) {
        records.push(out.record);
        quads.push(...out.record.quads);
        warnings.push(...out.warnings);
        vocabularyGaps.push(...out.gaps);
        importedIdentifiers.push({
          cascadeIri: out.record.iri,
          cascadeType: out.record.cascadeType,
          sourceType: 'FHIR.ServiceRequest',
          sourceId: out.record.sourceId,
        });
        registerId(idIndex, r, out.record.iri);
      }
    }
  }

  // -------- Pass 2: Haplotypes (need Variant references) --------
  for (const r of resources) {
    if (!r || typeof r !== 'object') continue;
    const profile = profileOf(r);
    if (r.resourceType === 'Observation' && profile === GENOMICS_PROFILES.haplotype) {
      const out = parseHaplotypeObservation(r, idIndex, ctx);
      if (out) {
        records.push(out.record);
        quads.push(...out.record.quads);
        warnings.push(...out.warnings);
        vocabularyGaps.push(...out.gaps);
        importedIdentifiers.push({
          cascadeIri: out.record.iri,
          cascadeType: out.record.cascadeType,
          sourceType: 'FHIR.Observation.haplotype',
          sourceId: out.record.sourceId,
        });
        registerId(idIndex, r, out.record.iri);
      }
    }
  }

  // -------- Pass 3: Genotypes (need Haplotype references) --------
  for (const r of resources) {
    if (!r || typeof r !== 'object') continue;
    const profile = profileOf(r);
    if (r.resourceType === 'Observation' && profile === GENOMICS_PROFILES.genotype) {
      const out = parseGenotypeObservation(r, idIndex, ctx);
      if (out) {
        records.push(out.record);
        quads.push(...out.record.quads);
        warnings.push(...out.warnings);
        vocabularyGaps.push(...out.gaps);
        importedIdentifiers.push({
          cascadeIri: out.record.iri,
          cascadeType: out.record.cascadeType,
          sourceType: 'FHIR.Observation.genotype',
          sourceId: out.record.sourceId,
        });
        registerId(idIndex, r, out.record.iri);
      }
    }
  }

  // -------- Pass 4: Diagnostic implications + reports --------
  for (const r of resources) {
    if (!r || typeof r !== 'object') continue;
    const profile = profileOf(r);

    if (
      r.resourceType === 'Observation' &&
      profile === GENOMICS_PROFILES.diagnosticImplication
    ) {
      const out = parseDiagnosticImplication(r, idIndex, ctx);
      if (out) {
        for (const rec of out.records) {
          records.push(rec);
          quads.push(...rec.quads);
          importedIdentifiers.push({
            cascadeIri: rec.iri,
            cascadeType: rec.cascadeType,
            sourceType: 'FHIR.Observation.diagnostic-implication',
            sourceId: rec.sourceId,
          });
        }
        warnings.push(...out.warnings);
        vocabularyGaps.push(...out.gaps);
      }
    } else if (r.resourceType === 'DiagnosticReport') {
      const out = parseDiagnosticReport(r, idIndex, ctx);
      if (out) {
        records.push(out.record);
        quads.push(...out.record.quads);
        warnings.push(...out.warnings);
        vocabularyGaps.push(...out.gaps);
        importedIdentifiers.push({
          cascadeIri: out.record.iri,
          cascadeType: out.record.cascadeType,
          sourceType: 'FHIR.DiagnosticReport',
          sourceId: out.record.sourceId,
        });
        registerId(idIndex, r, out.record.iri);
      }
    } else if (
      r.resourceType === 'Observation' &&
      (profile === GENOMICS_PROFILES.therapeuticImplication ||
        profile === GENOMICS_PROFILES.medicationRecommendation ||
        profile === GENOMICS_PROFILES.regionStudied)
    ) {
      // Phase 1 deferral — emit info-level gap for these PGx / scope profiles.
      vocabularyGaps.push({
        sourceField: `Observation/${r.id ?? '<no-id>'}`,
        reason: `${profile} not in Phase 1 scope — PGx and region-studied profiles deferred.`,
        severity: 'info',
        context: r.id,
      });
      skippedCount += 1;
    } else if (
      r.resourceType === 'Task' ||
      r.resourceType === 'Patient' ||
      r.resourceType === 'Specimen' ||
      r.resourceType === 'Organization' ||
      r.resourceType === 'Practitioner' ||
      r.resourceType === 'Encounter'
    ) {
      // Demographics / context resources are out of scope for the genomics
      // importer. They land in the bundle but don't produce genomics: records.
      skippedCount += 1;
    } else if (
      r.resourceType === 'Observation' &&
      profile == null &&
      r.id // already-handled-in-pass-1 variants/haplotypes/genotypes have profiles
    ) {
      // Untyped Observation — surface as a vocabulary gap so authors know
      // they have a non-IG-profiled genomics-related observation.
      vocabularyGaps.push({
        sourceField: `Observation/${r.id}`,
        reason: 'Observation has no FHIR Genomics IG profile; cannot dispatch to a parser.',
        severity: 'warning',
        context: r.id,
      });
      skippedCount += 1;
    }
  }

  return {
    records,
    quads,
    warnings,
    vocabularyGaps,
    importedIdentifiers,
    skippedCount,
  };
}

/**
 * Index a resource under its plain id, its `ResourceType/id` form, and
 * any `fullUrl` (urn:uuid:...) found on its bundle entry.
 */
function registerId(
  idx: Map<string, string>,
  resource: any,
  cascadeIri: string,
): void {
  if (resource?.id) {
    idx.set(resource.id, cascadeIri);
    if (resource.resourceType) {
      idx.set(`${resource.resourceType}/${resource.id}`, cascadeIri);
    }
  }
}
