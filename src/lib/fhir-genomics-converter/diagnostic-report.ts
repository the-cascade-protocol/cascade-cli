/**
 * DiagnosticReport → GeneticTest parser.
 *
 * Maps a FHIR DiagnosticReport (typically carrying the FHIR Genomics IG
 * `genomic-report` profile) to a `genomics:GeneticTest` record.
 *
 * Mapping:
 *   code (LOINC coding)           → genomics:testType
 *     (LOINC 51969-4 'Genetic analysis report' → GenePanelTest by default;
 *      narrower test-type LOINCs map to ExomeSequencing / GenomeSequencing
 *      etc. when the source is unambiguous. Otherwise emits info-gap and
 *      defaults to GenePanelTest — most-permissive Phase 1 default.)
 *   result[*]                     → genomics:variantsObserved (filter to
 *                                    Variant records only — non-Variant
 *                                    Observations like dis-path / haplotype
 *                                    aren't 'observed variants' per the
 *                                    v1-draft semantics)
 *   effectiveDateTime / issued    → genomics:testDate (xsd:date)
 *   performer[0]                  → genomics:performingLab
 *
 * Gene panel inference (D-DIRECTORY): if the bundle has region-studied
 * profile observations OR explicit `genePanel` extension, populate
 * genomics:genePanel; otherwise emit info-severity vocabulary gap.
 *
 * Sequencing-run metadata: rare in this corpus; if Observation.method or
 * extensions carry coverage/technology hints we'd populate a
 * genomics:SequencingRun, but Phase 1 emits an info-gap if any such hints
 * exist and lets a later task author the SequencingRun model.
 */

import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import {
  GENOMICS_NS,
  CODING_SYSTEMS,
  type ParsedRecord,
  type Quad,
} from './types.js';
import {
  NS,
  SCHEMA_VERSION,
  tripleType,
  tripleStr,
  tripleRef,
  tripleDate,
  deterministicUuid,
} from '../fhir-converter/types.js';

export interface DiagnosticReportParseOutput {
  record: ParsedRecord;
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

function mintGeneticTestIri(resource: any, ctx: ImportContext): string {
  const id = resource?.id ?? Math.random().toString(36);
  const sys = ctx.sourceSystem ?? 'fhir-genomics';
  return `urn:uuid:${deterministicUuid(`genomics:GeneticTest:${sys}:${id}`)}`;
}

function resolveRef(
  ref: { reference?: string } | undefined,
  idIndex: Map<string, string>,
): string | undefined {
  const r = ref?.reference;
  if (!r) return undefined;
  if (idIndex.has(r)) return idIndex.get(r);
  const slashIdx = r.indexOf('/');
  if (slashIdx > 0 && idIndex.has(r.slice(slashIdx + 1))) {
    return idIndex.get(r.slice(slashIdx + 1));
  }
  if (r.startsWith('urn:uuid:')) return r;
  return undefined;
}

/**
 * Map a DiagnosticReport.code LOINC code to a genomics:TestType named
 * individual. Unknown codes default to GenePanelTest with a gap.
 */
function inferTestType(loincCode: string | undefined): {
  individual: string;
  inferred: boolean;
} {
  if (!loincCode) return { individual: 'GenePanelTest', inferred: false };
  switch (loincCode) {
    case '51969-4':
      // Generic "Genetic analysis report" — assume panel.
      return { individual: 'GenePanelTest', inferred: true };
    case '81247-9':
      return { individual: 'GenomeSequencing', inferred: false };
    case '81293-4':
    case '83321-0':
      return { individual: 'ExomeSequencing', inferred: false };
    case '81251-7':
      return { individual: 'KaryotypeAnalysis', inferred: false };
    default:
      return { individual: 'GenePanelTest', inferred: true };
  }
}

export function parseDiagnosticReport(
  resource: any,
  idIndex: Map<string, string>,
  ctx: ImportContext,
  /** IRIs of records that are genomics:Variant — used to filter result[]
   *  to only true variantsObserved (not Interpretations / Haplotypes). */
  variantIris: ReadonlySet<string> = new Set(),
): DiagnosticReportParseOutput | null {
  if (!resource || resource.resourceType !== 'DiagnosticReport') return null;

  const sourceId: string = resource.id ?? '<no-id>';
  const iri = mintGeneticTestIri(resource, ctx);
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];

  quads.push(tripleType(iri, GENOMICS_NS + 'GeneticTest'));
  quads.push(tripleRef(iri, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'));
  quads.push(tripleStr(iri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));

  // ---- Test type (from code.coding LOINC) ----
  const loincCoding = resource.code?.coding?.find(
    (c: any) => c?.system === CODING_SYSTEMS.loinc,
  );
  const { individual, inferred } = inferTestType(loincCoding?.code);
  quads.push(tripleRef(iri, GENOMICS_NS + 'testType', GENOMICS_NS + individual));
  if (inferred) {
    gaps.push({
      sourceField: `DiagnosticReport/${sourceId}.code`,
      reason: `Test type defaulted to ${individual} from LOINC ${loincCoding?.code ?? '<no code>'} (${loincCoding?.display ?? ''}); a panel-name extension is recommended for precise type inference.`,
      severity: 'info',
      context: sourceId,
    });
  }

  // ---- Variants observed (filter result[] to Variant records) ----
  // result[] mixes Variants, VariantInterpretations, Haplotypes, Diplotypes,
  // and PGx therapeutic-implication observations. Only Variants belong on
  // genomics:variantsObserved per the v1-draft semantics
  // (rdfs:range genomics:Variant — see genomics.ttl).
  const results: any[] = resource.result ?? [];
  let variantsLinked = 0;
  for (const ref of results) {
    const resolved = resolveRef(ref, idIndex);
    if (!resolved) {
      gaps.push({
        sourceField: `DiagnosticReport/${sourceId}.result`,
        reason: `Result reference ${ref?.reference} could not be resolved; not all referenced Observations are parseable as genomics records.`,
        severity: 'info',
        context: sourceId,
      });
      continue;
    }
    if (!variantIris.has(resolved)) {
      // Resolved to a non-Variant record (Interpretation, Haplotype,
      // Diplotype, PGx implication, etc.) — not eligible for
      // variantsObserved given its declared range (genomics:Variant).
      // v1-draft.0.2: emit genomics:reportedRecord instead — the generic
      // GeneticTest → record predicate that resolves the HLA tie-break
      // (cascade-coordination/tie-breaks/2026-05-05-task-1.9-hla-variantsObserved.md).
      // For Variant-typed references we still prefer the more specific
      // genomics:variantsObserved (rdfs:range genomics:Variant) below.
      quads.push(tripleRef(iri, GENOMICS_NS + 'reportedRecord', resolved));
      continue;
    }
    quads.push(tripleRef(iri, GENOMICS_NS + 'variantsObserved', resolved));
    variantsLinked += 1;
  }

  if (results.length > 0 && variantsLinked === 0) {
    // Bundle expresses a genomic report whose result[] references only
    // non-Variant records (typically Diplotypes for HLA / PGx, or
    // Haplotypes alone). v1-draft.0.2 covers these via genomics:reportedRecord
    // (emitted above per non-Variant reference). Keep this info gap with
    // reduced wording so downstream tooling still surfaces the situation;
    // a more specific predicate (diplotypesObserved / haplotypesObserved)
    // remains a v1.x evolution candidate.
    gaps.push({
      sourceField: `DiagnosticReport/${sourceId}.result`,
      reason: `Genomic report references only non-Variant records (Diplotypes/Haplotypes/PGx implications) — emitted via genomics:reportedRecord. Type-specific predicates (genomics:diplotypesObserved / haplotypesObserved) remain a v1.x evolution candidate.`,
      severity: 'info',
      context: sourceId,
    });
  }

  if (variantsLinked === 0 && results.length === 0) {
    // Empty result list with non-empty genePanel = clinically meaningful
    // negative result. We can't tell yet; just record the situation.
    gaps.push({
      sourceField: `DiagnosticReport/${sourceId}.result`,
      reason: 'DiagnosticReport has no result references; cannot link variantsObserved.',
      severity: 'info',
      context: sourceId,
    });
  }

  // ---- Test date ----
  // Prefer issued (full YYYY-MM-DD) over effectiveDateTime (which the IG
  // examples often leave at year-only granularity, e.g. '2016'). Year-only
  // strings would fail xsd:date validation, so upgrade them to YYYY-01-01.
  const issuedDate: string | undefined = resource.issued;
  const effectiveDate: string | undefined = resource.effectiveDateTime;
  let dateRaw: string | undefined = issuedDate ?? effectiveDate;
  if (dateRaw) {
    let dateOnly = String(dateRaw).split('T')[0];
    if (/^\d{4}$/.test(dateOnly)) dateOnly = `${dateOnly}-01-01`;
    if (/^\d{4}-\d{2}$/.test(dateOnly)) dateOnly = `${dateOnly}-01`;
    quads.push(tripleDate(iri, GENOMICS_NS + 'testDate', dateOnly));
  }
  void dateRaw;

  // ---- Performing lab ----
  const performer = resource.performer?.[0]?.display ?? resource.performer?.[0]?.reference;
  if (performer) {
    quads.push(tripleStr(iri, GENOMICS_NS + 'performingLab', performer));
  }

  // ---- basedOn → set on the linked GeneticTestOrder (TASK-1.7) ----
  // Captured here as a sourceFhirReference triple so TASK-1.7 can find it.
  // The reverse link genomics:resultedIn lives on the Order.
  const basedOn = resource.basedOn?.[0]?.reference;
  if (basedOn) {
    const orderIri = resolveRef(resource.basedOn[0], idIndex);
    if (orderIri) {
      // Add resultedIn FROM the order TO this test.
      quads.push(tripleRef(orderIri, GENOMICS_NS + 'resultedIn', iri));
    }
  }

  // ---- Gene panel inference ----
  // Look in `extension` for a genePanel-shaped extension.
  let genePanelEmitted = false;
  const ext: any[] = resource.extension ?? [];
  for (const e of ext) {
    if (typeof e?.url !== 'string') continue;
    if (e.url.toLowerCase().includes('genepanel') || e.url.includes('panel-name')) {
      const v = e.valueString ?? e.valueCodeableConcept?.text;
      if (typeof v === 'string') {
        quads.push(tripleStr(iri, GENOMICS_NS + 'genePanel', v));
        genePanelEmitted = true;
      }
    }
  }
  if (!genePanelEmitted) {
    gaps.push({
      sourceField: `DiagnosticReport/${sourceId}.genePanel`,
      reason: 'No genePanel extension on DiagnosticReport and no region-studied scaffolding in the bundle; gene-panel scope cannot be inferred. Reports without explicit panel scope under-specify negative-result semantics.',
      severity: 'info',
      context: sourceId,
    });
  }

  // ---- Sequencing-run / coverage hints (D-DIRECTORY) ----
  if (resource.method) {
    gaps.push({
      sourceField: `DiagnosticReport/${sourceId}.method`,
      reason: 'DiagnosticReport.method (assay description) recognized but not yet mapped to genomics:SequencingRun in Phase 1.',
      severity: 'info',
      context: sourceId,
    });
  }

  // ---- presentedForm (PDF / text report) ----
  if (Array.isArray(resource.presentedForm) && resource.presentedForm.length > 0) {
    gaps.push({
      sourceField: `DiagnosticReport/${sourceId}.presentedForm`,
      reason: 'DiagnosticReport.presentedForm carries an inline rendered report (e.g. base64 PDF). Not preserved in genomics v1-draft.',
      severity: 'info',
      context: sourceId,
    });
  }

  // Source identity passthrough.
  quads.push(tripleStr(iri, NS.cascade + 'sourceFhirId', sourceId));

  void warnings; // populate when we add fail-fast paths

  const record: ParsedRecord = {
    iri,
    cascadeType: 'genomics:GeneticTest',
    sourceId,
    fhirResourceType: 'DiagnosticReport',
    quads,
  };

  return { record, warnings, gaps };
}
