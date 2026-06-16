/**
 * VCF record parser → genomics:Variant emission.
 *
 * Each VCF body line describes ONE genomic position with one REF and 1..N
 * ALTs. We emit one `genomics:Variant` per ALT allele.
 *
 * Population strategy:
 *   - rdf:type             → genomics:Variant
 *   - cascade:schemaVersion + cascade:dataProvenance (common triples)
 *   - genomics:hgvsGDot    when ClinVar's CLNHGVS INFO is present
 *   - genomics:dbsnpRsId   from VCF ID column (rs prefix) or INFO.RS
 *   - genomics:clinvarVariationId from VCF ID column on ClinVar (numeric)
 *                                  or INFO.ALLELEID (per-submission)
 *   - genomics:dataQualityTier  ClinicalGrade if header.source ~ ClinVar
 *                               else ResearchGrade
 *   - prov:wasGeneratedBy → SequencingRun IRI (passed in)
 *   - genomics:zygosity   from per-sample GT (when FORMAT has GT)
 *   - genomics:refAllele                        (v1-draft.0.2; from REF column)
 *   - genomics:altAllele                        (v1-draft.0.2; per-ALT)
 *   - genomics:genomicStartEnd                  (v1-draft.0.2; chr:pos-end)
 *   - genomics:variantAlleleFrequency           (v1-draft.0.2; FORMAT/AF or /VAF)
 *   - genomics:somaticStatus                    (v1-draft.0.2; INFO.SOMATIC flag)
 *
 * Gap-info entries for fields still not in v1-draft:
 *   - variantQuality   (QUAL column)
 *   - passedFilter     (FILTER column)
 *   - observedIn       (per-sample observation link)
 *
 * For each remaining gap field we ALSO emit a comment-style triple under
 * `cascade:unmappedField` so the data isn't silently lost — a downstream
 * reconciler can pick those up once the vocabulary lands.
 */

import { DataFactory, type Quad } from 'n3';

import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import {
  NS,
  SCHEMA_VERSION,
  deterministicUuid,
  tripleType,
  tripleStr,
  tripleRef,
} from '../fhir-converter/types.js';
import { GENOMICS_NS } from '../fhir-genomics-converter/types.js';
import type { VcfHeader, VcfSourceProfile } from './types.js';

const { namedNode, literal, quad: makeQuad } = DataFactory;

const RS_RE = /^rs\d+$/i;
const NUMERIC_RE = /^\d+$/;

/**
 * One emitted record from the VCF importer. Matches the FHIR-genomics
 * importer's `ParsedRecord` shape (without `fhirResourceType` since VCF
 * isn't FHIR — but we keep the field nullable so the orchestrator stays
 * uniform).
 */
export interface ParsedRecord {
  iri: string;
  cascadeType: string;
  sourceId: string;
  /** Always undefined for VCF; preserved for orchestrator parity. */
  fhirResourceType?: string;
  quads: Quad[];
}

export interface RecordParseOutput {
  records: ParsedRecord[];
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

/**
 * Result of low-level VCF line splitting. Tab-delimited with at least 8
 * mandatory columns (CHROM POS ID REF ALT QUAL FILTER INFO) followed by
 * optional FORMAT + per-sample columns.
 */
interface SplitLine {
  CHROM: string;
  POS: number;
  ID: string;
  REF: string;
  ALTs: string[];
  QUAL: string;
  FILTER: string;
  INFO: Map<string, string | true>;
  FORMAT?: string[];
  SAMPLES?: string[]; // raw per-sample column values
}

/** Parse the INFO column into a Map. Flag-only keys land as `true`. */
function parseInfo(info: string): Map<string, string | true> {
  const out = new Map<string, string | true>();
  if (!info || info === '.') return out;
  for (const piece of info.split(';')) {
    if (piece.length === 0) continue;
    const eq = piece.indexOf('=');
    if (eq < 0) {
      out.set(piece, true);
    } else {
      out.set(piece.slice(0, eq), piece.slice(eq + 1));
    }
  }
  return out;
}

/** Lightweight, self-contained tab-split — no @gmod/vcf required. */
function splitLine(line: string): SplitLine | null {
  const cols = line.split('\t');
  if (cols.length < 8) return null;
  const [chrom, pos, id, ref, alt, qual, filter, info, fmtCol, ...samples] = cols;
  const posN = parseInt(pos, 10);
  if (!Number.isFinite(posN)) return null;
  return {
    CHROM: chrom,
    POS: posN,
    ID: id,
    REF: ref,
    ALTs: alt === '.' ? [] : alt.split(','),
    QUAL: qual,
    FILTER: filter,
    INFO: parseInfo(info),
    FORMAT: fmtCol ? fmtCol.split(':') : undefined,
    SAMPLES: samples.length > 0 ? samples : undefined,
  };
}

/** Mint a stable Variant IRI from chrom + pos + ref + alt + run IRI. */
function mintVariantIri(
  chrom: string,
  pos: number,
  ref: string,
  alt: string,
  sequencingRunIri: string,
): string {
  return `urn:uuid:${deterministicUuid(
    `Variant|${sequencingRunIri}|${chrom}:${pos}:${ref}:${alt}`,
  )}`;
}

/** Common triples every Cascade resource gets — same set as fhir-converter. */
function commonTriples(subject: string): Quad[] {
  return [
    tripleRef(subject, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'),
    tripleStr(subject, NS.cascade + 'schemaVersion', SCHEMA_VERSION),
  ];
}

/**
 * Map a VCF GT value (e.g. "0/1", "1|0", "1/1", "0/0", "1") to a
 * genomics:ZygosityValue named individual. Returns undefined for unknown
 * or no-call genotypes (e.g. ".", "./.").
 */
function gtToZygosity(gt: string): string | undefined {
  if (!gt || gt === '.' || /^\.[\\|\/]\.$/.test(gt)) return undefined;
  // strip phasing separator into a flat list of allele indices
  const alleles = gt.split(/[\\|\/]/).filter((a) => a !== '.');
  if (alleles.length === 0) return undefined;
  if (alleles.length === 1) {
    // Hemizygous calls (single allele on chrX/Y in males, chrM in everyone).
    return alleles[0] === '0' ? 'HomozygousReference' : 'Hemizygous';
  }
  const allRef = alleles.every((a) => a === '0');
  const allAlt = alleles.every((a) => a !== '0' && alleles[0] === a);
  if (allRef) return 'HomozygousReference';
  if (allAlt) return 'Homozygous';
  return 'Heterozygous';
}

/**
 * For a VCF record, decide whether the ID column carries an rsID, a
 * ClinVar Variation ID, both, or neither.
 */
function classifyVcfId(
  idCol: string,
  isClinvarLike: boolean,
): { rsId?: string; clinvarVariationId?: string } {
  if (!idCol || idCol === '.') return {};
  // VCF spec lets ID be a semicolon-separated list of identifiers.
  const tokens = idCol.split(';');
  const out: { rsId?: string; clinvarVariationId?: string } = {};
  for (const tok of tokens) {
    const t = tok.trim();
    if (!t) continue;
    if (RS_RE.test(t)) {
      out.rsId = t;
    } else if (isClinvarLike && NUMERIC_RE.test(t)) {
      // ClinVar weekly VCF puts the numeric Variation ID in the ID column.
      out.clinvarVariationId = t;
    }
  }
  return out;
}

/** Emit a literal-typed quad (helper for sourceField fallback gap-info). */
function tripleLit(subject: string, predicate: string, value: string): Quad {
  return makeQuad(namedNode(subject), namedNode(predicate), literal(value));
}

/**
 * Surface a vocabulary gap and ALSO emit a `cascade:unmappedField` literal
 * so the data round-trips through the importer instead of silently dropping.
 */
function recordGap(
  quads: Quad[],
  gaps: VocabularyGap[],
  iri: string,
  field: string,
  value: string,
  reason: string,
  severity: 'info' | 'warning' = 'info',
): void {
  gaps.push({
    sourceField: field,
    reason,
    severity,
    context: iri,
  });
  quads.push(tripleLit(iri, NS.cascade + 'unmappedField', `${field}=${value}`));
}

/**
 * Parse one VCF body line into 0+ Variant records. Returns null if the
 * line is malformed (caller tracks recordsRead from successful results).
 */
export function parseRecordLine(
  line: string,
  header: VcfHeader,
  sourceProfile: VcfSourceProfile,
  sequencingRunIri: string,
  _ctx: ImportContext,
): RecordParseOutput | null {
  const split = splitLine(line);
  if (!split) {
    return {
      records: [],
      warnings: [{ message: `Skipping malformed VCF line: ${line.slice(0, 80)}…` }],
      gaps: [],
    };
  }
  if (split.ALTs.length === 0) {
    // VCF record with REF only — no ALT to emit a Variant for. Skip silently.
    return { records: [], warnings: [], gaps: [] };
  }

  const records: ParsedRecord[] = [];
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];

  const idClassification = classifyVcfId(split.ID, sourceProfile.isClinvarLike);

  for (let altIdx = 0; altIdx < split.ALTs.length; altIdx++) {
    const ALT = split.ALTs[altIdx];
    const variantIri = mintVariantIri(
      split.CHROM,
      split.POS,
      split.REF,
      ALT,
      sequencingRunIri,
    );

    const quads: Quad[] = [];

    // 1. rdf:type + common triples
    quads.push(tripleType(variantIri, GENOMICS_NS + 'Variant'));
    quads.push(...commonTriples(variantIri));

    // 2. PROV link to sequencing run
    quads.push(tripleRef(variantIri, NS.prov + 'wasGeneratedBy', sequencingRunIri));

    // 3. Quality tier (D-QUALITY-TIER): ClinVar weekly → ClinicalGrade,
    //    everything else → ResearchGrade.
    const tier = sourceProfile.isClinvarLike ? 'ClinicalGrade' : 'ResearchGrade';
    quads.push(tripleRef(variantIri, GENOMICS_NS + 'dataQualityTier', GENOMICS_NS + tier));

    // 4. ID column → dbsnpRsId / clinvarVariationId
    if (idClassification.rsId) {
      quads.push(tripleStr(variantIri, GENOMICS_NS + 'dbsnpRsId', idClassification.rsId));
    }
    if (idClassification.clinvarVariationId) {
      quads.push(
        tripleStr(
          variantIri,
          GENOMICS_NS + 'clinvarVariationId',
          idClassification.clinvarVariationId,
        ),
      );
    }
    // INFO.RS as a fallback rsID on records whose ID column isn't an rsID
    if (!idClassification.rsId && split.INFO.has('RS')) {
      const rs = split.INFO.get('RS');
      if (typeof rs === 'string' && rs.length > 0) {
        const first = rs.split(',')[0].trim();
        const rsValue = first.startsWith('rs') ? first : `rs${first}`;
        if (RS_RE.test(rsValue)) {
          quads.push(tripleStr(variantIri, GENOMICS_NS + 'dbsnpRsId', rsValue));
        }
      }
    }

    // 5. CLNHGVS → hgvsGDot (ClinVar genomic HGVS)
    const clnhgvs = split.INFO.get('CLNHGVS');
    if (typeof clnhgvs === 'string' && clnhgvs.length > 0) {
      // CLNHGVS is comma-separated for multi-allelic sites; pick the entry at altIdx if available.
      const parts = clnhgvs.split(',');
      const value = parts[altIdx] ?? parts[0];
      if (value) {
        quads.push(tripleStr(variantIri, GENOMICS_NS + 'hgvsGDot', value));
      }
    }

    // 6. Coordinates + alleles (v1-draft.0.2):
    //      REF column         → genomics:refAllele
    //      ALT_i              → genomics:altAllele
    //      CHROM:POS-end      → genomics:genomicStartEnd
    //                            (end = POS + len(REF) - 1, 1-based inclusive)
    quads.push(tripleStr(variantIri, GENOMICS_NS + 'refAllele', split.REF));
    quads.push(tripleStr(variantIri, GENOMICS_NS + 'altAllele', ALT));
    {
      const chrLabel = split.CHROM.startsWith('chr') ? split.CHROM : `chr${split.CHROM}`;
      const endPos = split.POS + Math.max(1, split.REF.length) - 1;
      quads.push(
        tripleStr(
          variantIri,
          GENOMICS_NS + 'genomicStartEnd',
          `${chrLabel}:${split.POS}-${endPos}`,
        ),
      );
    }

    // 6b. INFO.SOMATIC flag (v1-draft.0.2). Present → Somatic. VCF has no
    // clean germline indicator (the inverse of SOMATIC is implicit), so
    // when the flag is absent we omit the triple. Closed-enum SHACL has
    // no minCount on somaticStatus, so omission is fine.
    if (split.INFO.has('SOMATIC')) {
      quads.push(
        tripleRef(variantIri, GENOMICS_NS + 'somaticStatus', GENOMICS_NS + 'Somatic'),
      );
    }

    // 7. QUAL column (variantQuality — gap)
    if (split.QUAL && split.QUAL !== '.') {
      recordGap(
        quads,
        gaps,
        variantIri,
        'VCF.QUAL',
        split.QUAL,
        'genomics:variantQuality not in v1-draft.0.1; pending v1-draft.0.2.',
      );
    }

    // 8. FILTER (passedFilter — gap; preserve PASS / non-PASS as literal)
    if (split.FILTER && split.FILTER !== '.') {
      const passing = split.FILTER === 'PASS';
      recordGap(
        quads,
        gaps,
        variantIri,
        'VCF.FILTER',
        split.FILTER,
        passing
          ? 'genomics:passedFilter not in v1-draft.0.1; preserving PASS as unmapped.'
          : 'genomics:passedFilter not in v1-draft.0.1; record did NOT pass caller filter.',
        passing ? 'info' : 'warning',
      );
    }

    // 9. ClinVar VariantInterpretation context — preserve CLNSIG as
    //    unmapped pending Phase 2A clinvar importer integration. Emit info
    //    rather than warning since this is a forward-compatible signal.
    const clnsig = split.INFO.get('CLNSIG');
    if (typeof clnsig === 'string' && clnsig.length > 0) {
      recordGap(
        quads,
        gaps,
        variantIri,
        'VCF.INFO.CLNSIG',
        clnsig,
        'CLNSIG aggregate-classification preserved; Phase 2A clinvar importer authors VariantInterpretation records from a different fixture stream.',
      );
    }

    // 10. Gene info (GENEINFO) → genomics:geneSymbol (HGNC approved
    //     symbol). ClinVar's GENEINFO is "SYMBOL:ENTREZ_ID|SYMBOL:..." for
    //     multi-gene sites; we take the first symbol. The full multi-gene
    //     surface is held as a gap pending the consequence/cross-gene
    //     model in v1-draft.0.2.
    const geneinfo = split.INFO.get('GENEINFO');
    if (typeof geneinfo === 'string' && geneinfo.length > 0) {
      const firstGenePair = geneinfo.split('|')[0];
      const symbol = firstGenePair.split(':')[0];
      if (symbol) {
        quads.push(tripleStr(variantIri, GENOMICS_NS + 'geneSymbol', symbol));
      }
      if (geneinfo.includes('|')) {
        // Multi-gene site (overlapping transcripts): preserve the full
        // GENEINFO string so a downstream tool can reconstruct.
        recordGap(
          quads,
          gaps,
          variantIri,
          'VCF.INFO.GENEINFO.multiGene',
          geneinfo,
          'multi-gene site: only the first GENEINFO symbol mapped to genomics:geneSymbol; full string preserved for reconciliation.',
        );
      }
    } else {
      // No GENEINFO at all — surface as a warning so SHACL geneSymbol
      // violations are explicable to the user. Consumers SHOULD enrich
      // from a downstream gene-overlap step (Phase 2 reconciler).
      gaps.push({
        sourceField: 'VCF.INFO.GENEINFO',
        reason:
          'VCF record carries no GENEINFO INFO field; genomics:geneSymbol cannot be set from this source. SHACL conformance requires geneSymbol — enrich downstream or accept the violation.',
        severity: 'warning',
        context: variantIri,
      });
    }

    // 11. Per-sample FORMAT handling (multi-sample VCFs only).
    //     Sites-only VCFs (e.g. ClinVar) skip this block entirely.
    if (split.FORMAT && split.SAMPLES && header.sampleColumns.length > 0) {
      const fmtKeys = split.FORMAT;
      const gtIdx = fmtKeys.indexOf('GT');
      const afIdx = fmtKeys.indexOf('AF');
      const vafIdx = fmtKeys.indexOf('VAF');
      const dpIdx = fmtKeys.indexOf('DP');

      // Only the first sample drives the variant's zygosity at v0.1 — full
      // per-sample observedIn emission is gated on v1-draft.0.2 and lands
      // in TASK-3A.4. Surface a gap when there's > 1 sample so the loss
      // is visible.
      if (header.sampleColumns.length > 1) {
        gaps.push({
          sourceField: 'VCF.multi-sample',
          reason:
            'VCF carries >1 sample but genomics:observedIn predicate is not in v1-draft.0.1; only the first sample is currently mapped to this Variant. Per-sample emission will land alongside v1-draft.0.2.',
          severity: 'warning',
          context: variantIri,
        });
      }

      const sampleStr = split.SAMPLES[0];
      if (sampleStr && sampleStr !== '.') {
        const fields = sampleStr.split(':');
        if (gtIdx >= 0) {
          const gt = fields[gtIdx];
          const zyg = gt ? gtToZygosity(gt) : undefined;
          if (zyg && zyg !== 'HomozygousReference') {
            // HomozygousReference isn't in the v1-draft ZygosityValue
            // enumeration — surface as gap, omit the rdf:type link.
            quads.push(tripleRef(variantIri, GENOMICS_NS + 'zygosity', GENOMICS_NS + zyg));
          } else if (zyg === 'HomozygousReference') {
            recordGap(
              quads,
              gaps,
              variantIri,
              'VCF.FORMAT.GT',
              gt ?? '',
              'genomics:HomozygousReference not in v1-draft.0.1 ZygosityValue enumeration; sample is reference at this site.',
            );
          }
          // Phasing (| vs /) → cis/trans: gated on v1-draft phase predicate
          // already present in the spec but tied to compound-het records;
          // single-Variant phase emission is deferred to v1-draft.0.2.
          if (gt && gt.includes('|')) {
            recordGap(
              quads,
              gaps,
              variantIri,
              'VCF.FORMAT.GT.phase',
              gt,
              'phased genotype recorded; per-Variant cis/trans predicate lands in v1-draft.0.2.',
            );
          }
        }
        const afOrVafIdx = afIdx >= 0 ? afIdx : vafIdx;
        if (afOrVafIdx >= 0) {
          const af = fields[afOrVafIdx];
          if (af && af !== '.') {
            // Multi-allelic VCFs may carry comma-separated AF values per
            // ALT; pick the entry at altIdx if available.
            const piece = af.split(',')[altIdx] ?? af.split(',')[0];
            const n = Number(piece);
            if (Number.isFinite(n) && n >= 0 && n <= 1) {
              quads.push(
                makeQuad(
                  namedNode(variantIri),
                  namedNode(GENOMICS_NS + 'variantAlleleFrequency'),
                  literal(String(n), namedNode(NS.xsd + 'decimal')),
                ),
              );
            }
            // If the value is outside 0..1 (some pipelines emit percent),
            // we skip rather than coerce — the SHACL property shape on
            // variantAlleleFrequency is sh:Violation severity for out-of-range.
          }
        }
        if (dpIdx >= 0) {
          const dp = fields[dpIdx];
          if (dp && dp !== '.') {
            // Per-sample DP is not the same as run-level coverageDepth.
            // Preserve as unmapped pending a Variant-level depth predicate.
            recordGap(
              quads,
              gaps,
              variantIri,
              'VCF.FORMAT.DP',
              dp,
              'per-sample depth preserved; Variant-level depth predicate not in v1-draft.0.1 (run-level coverageDepth lives on SequencingRun).',
            );
          }
        }
      }
    }

    records.push({
      iri: variantIri,
      cascadeType: 'genomics:Variant',
      sourceId: `${split.CHROM}:${split.POS}:${split.REF}>${ALT}`,
      quads,
    });
  }

  return { records, warnings, gaps };
}

// Suppress unused-import warning under noUnusedLocals when literal/makeQuad
// aren't used directly in some build modes — they back tripleLit / recordGap.
void literal;
void makeQuad;
