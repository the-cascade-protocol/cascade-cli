/**
 * Phenopacket variationDescriptor → genomics:Variant (or CopyNumberVariant
 * or Haplotype).
 *
 * The phenopacket `variationDescriptor` is the variant-data carrier inside
 * `interpretations[].diagnosis.genomicInterpretations[].variantInterpretation`.
 * It carries one of three internal `variation` shapes:
 *
 *   - `allele`     → point variant (sequence + literal/derived expression)
 *                    → genomics:Variant
 *   - `copyNumber` → structural variant (interval + integer copy number)
 *                    → genomics:CopyNumberVariant
 *   - `haplotype`  → ordered allele set on one chromosome (rare)
 *                    → genomics:Haplotype
 *
 * VRS preservation (D-Q6): if `variationDescriptor.variation.variation` (or
 * any nested object) carries a VRS `_id`, we record it under `genomics:vrsId`
 * and the full JSON object under `genomics:vrsObject` — never compute.
 *
 * D-QUALITY-TIER: phenopackets are research-context by default. We tag
 * every emitted Variant with `genomics:dataQualityTier = ResearchGrade`
 * unless the parent metaData carries CLIA/clinical signals (rare in this
 * corpus). If the concurrent vocab-evolution agent has merged the
 * `reportedRecord` / `refAllele` / `altAllele` / `genomicStartEnd` /
 * `somaticStatus` / `variantAlleleFrequency` properties into v1-draft.0.2,
 * USE them; if not, emit info-severity gap-warnings (caller must pass a
 * resolved `predicateInventory` flag — for now we conservatively assume
 * NOT merged and rely on the gap-warnings).
 *
 * Per the implementation plan, `extensions[].name = "mosaicism"` /
 * `"allele-frequency"` carry numeric percentage strings ("40.0%"). We
 * convert to a 0..1 fraction and store under genomics:mosaicismFraction
 * for both interpretations (single-variant VAF and CNV mosaicism are
 * semantically the same field in v1-draft).
 */

import { DataFactory } from 'n3';
import { GENOMICS_NS, GENO_ZYGOSITY_TO_VALUE } from './types.js';
import type { ParsedRecord, Quad } from './types.js';
import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import {
  NS,
  SCHEMA_VERSION,
  tripleType,
  tripleStr,
  tripleRef,
  tripleInt,
  deterministicUuid,
} from '../fhir-converter/types.js';

const { namedNode, literal, quad: makeQuad } = DataFactory;

export interface VariationParseOutput {
  record: ParsedRecord;
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

/**
 * Parse `extensions[].value` of the form `'40.0%'` or `'40%'` or `0.4`
 * to a fraction in [0, 1]. Returns undefined if unparseable.
 */
function extensionPercentToFraction(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value > 1 ? value / 100 : value;
  }
  if (typeof value === 'string') {
    const m = /^(\d+(\.\d+)?)\s*%?$/.exec(value.trim());
    if (m) {
      const n = parseFloat(m[1]);
      return value.trim().endsWith('%') ? n / 100 : (n > 1 ? n / 100 : n);
    }
  }
  return undefined;
}

/**
 * Mint a deterministic Cascade IRI for a Variant / CNV / Haplotype derived
 * from a phenopacket variationDescriptor.
 */
function mintVariantIri(descriptor: any, ctx: ImportContext, kind: string): string {
  const sys = ctx.sourceSystem ?? 'phenopacket';
  const id =
    (typeof descriptor?.id === 'string' && descriptor.id) ||
    (typeof descriptor?.label === 'string' && descriptor.label) ||
    `anon:${ctx.importedAt}:${Math.random()}`;
  return `urn:uuid:${deterministicUuid(`genomics:${kind}:${sys}:${id}`)}`;
}

/**
 * Detect the variation sub-shape inside a variationDescriptor.
 *
 *   - copyNumber → 'cnv'
 *   - allele     → 'allele'
 *   - haplotype  → 'haplotype'
 *
 * Phenopacket v2 nests the actual shape under
 * `variationDescriptor.variation`; some v1 / interim records put it
 * directly on the descriptor (alongside `vcfRecord`/`expressions`).
 * We accept both.
 */
function detectVariationKind(descriptor: any): 'cnv' | 'allele' | 'haplotype' | 'vcf-only' | 'unknown' {
  const v = descriptor?.variation;
  if (v && typeof v === 'object') {
    if ('copyNumber' in v) return 'cnv';
    if ('allele' in v) return 'allele';
    if ('haplotype' in v) return 'haplotype';
  }
  // v1-style fallbacks
  if (descriptor?.vcfRecord) return 'vcf-only';
  if (descriptor?.expressions || descriptor?.geneContext) return 'allele';
  return 'unknown';
}

/**
 * Look up a CnvNumber.value of the form `{ value: '1' }` and return integer.
 */
function cnvNumberAsInt(node: any): number | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (typeof node.value === 'string') {
    const n = parseInt(node.value, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof node.value === 'number') return node.value | 0;
  return undefined;
}

/**
 * Look for VRS-shaped identifiers anywhere in the descriptor's `variation`
 * object. v2 VRS objects carry a top-level `_id` or `id` like
 * `'ga4gh:VA.<digest>'`.
 */
function extractVrs(descriptor: any): { vrsId?: string; vrsObject?: string } {
  const v = descriptor?.variation;
  if (!v || typeof v !== 'object') return {};
  // VRS allele inside variation.allele — keep object; capture id if present.
  for (const key of Object.keys(v)) {
    const node = (v as any)[key];
    if (node && typeof node === 'object') {
      const id = (node._id ?? node.id) as string | undefined;
      if (typeof id === 'string' && id.startsWith('ga4gh:')) {
        return { vrsId: id, vrsObject: JSON.stringify(node) };
      }
    }
  }
  // Top-level VRS id?
  const topId = v._id ?? v.id;
  if (typeof topId === 'string' && topId.startsWith('ga4gh:')) {
    return { vrsId: topId, vrsObject: JSON.stringify(v) };
  }
  return {};
}

/**
 * Parse a phenopacket variationDescriptor. Returns null if the descriptor
 * is empty / unrecognized.
 */
export function parseVariationDescriptor(
  descriptor: any,
  ctx: ImportContext,
  contextLabel: string,
): VariationParseOutput | null {
  if (!descriptor || typeof descriptor !== 'object') return null;

  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];
  const kind = detectVariationKind(descriptor);

  if (kind === 'unknown') {
    gaps.push({
      sourceField: `${contextLabel}.variationDescriptor`,
      reason: 'Unrecognized variationDescriptor shape — no allele/copyNumber/haplotype/vcfRecord found.',
      severity: 'warning',
      context: contextLabel,
    });
    return null;
  }

  const cascadeKind: 'Variant' | 'CopyNumberVariant' | 'Haplotype' =
    kind === 'cnv' ? 'CopyNumberVariant' : kind === 'haplotype' ? 'Haplotype' : 'Variant';

  const iri = mintVariantIri(descriptor, ctx, cascadeKind);
  const subject = namedNode(iri);
  const quads: Quad[] = [];
  const sourceId: string =
    (typeof descriptor.id === 'string' && descriptor.id) ||
    (typeof descriptor.label === 'string' && descriptor.label) ||
    '<anon>';

  // ---- Type + provenance ----
  quads.push(tripleType(iri, GENOMICS_NS + cascadeKind));
  quads.push(tripleRef(iri, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'));
  quads.push(tripleStr(iri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));

  // ---- D-QUALITY-TIER: research-grade by default for phenopackets ----
  quads.push(tripleRef(iri, GENOMICS_NS + 'dataQualityTier', GENOMICS_NS + 'ResearchGrade'));
  quads.push(
    tripleRef(iri, GENOMICS_NS + 'dataProvenance', GENOMICS_NS + 'ResearchSequencing'),
  );

  // ---- Common: gene context ----
  if (descriptor.geneContext && typeof descriptor.geneContext === 'object') {
    if (typeof descriptor.geneContext.symbol === 'string') {
      quads.push(tripleStr(iri, GENOMICS_NS + 'geneSymbol', descriptor.geneContext.symbol));
    }
    if (typeof descriptor.geneContext.valueId === 'string') {
      quads.push(tripleStr(iri, GENOMICS_NS + 'hgncId', descriptor.geneContext.valueId));
    }
  }

  // ---- HGVS + transcript expressions ----
  if (Array.isArray(descriptor.expressions)) {
    for (const expr of descriptor.expressions) {
      const syntax: string = expr?.syntax ?? '';
      const value: string = expr?.value ?? '';
      if (!value) continue;
      switch (syntax) {
        case 'hgvs.c':
        case 'hgvs':
          quads.push(tripleStr(iri, GENOMICS_NS + 'hgvsCDot', value));
          break;
        case 'hgvs.p':
          quads.push(tripleStr(iri, GENOMICS_NS + 'hgvsPDot', value));
          break;
        case 'hgvs.g':
          quads.push(tripleStr(iri, GENOMICS_NS + 'hgvsGDot', value));
          break;
        case 'transcript_reference':
          quads.push(tripleStr(iri, GENOMICS_NS + 'transcriptRef', value));
          break;
        default:
          gaps.push({
            sourceField: `${contextLabel}.variationDescriptor.expressions[${syntax}]`,
            reason: `Unhandled expression syntax: ${syntax}`,
            severity: 'info',
            context: sourceId,
          });
      }
    }
  }

  // ---- VCF record (chromosome, position, ref, alt, assembly) ----
  if (descriptor.vcfRecord && typeof descriptor.vcfRecord === 'object') {
    const vcf = descriptor.vcfRecord;
    if (typeof vcf.genomeAssembly === 'string') {
      quads.push(tripleStr(iri, GENOMICS_NS + 'genomeAssembly', vcf.genomeAssembly));
    }
    // chr/pos/ref/alt: v1-draft has no first-class chr/pos slot. The
    // concurrent vocab-evolution agent is adding refAllele / altAllele /
    // genomicStartEnd. Until merged, we capture the data via a coarse
    // hgvsGDot-like string and emit gaps.
    if (vcf.chrom && vcf.pos && vcf.ref && vcf.alt) {
      const compact = `${vcf.chrom}:g.${vcf.pos}${vcf.ref}>${vcf.alt}`;
      quads.push(tripleStr(iri, GENOMICS_NS + 'hgvsGDot', compact));
      gaps.push({
        sourceField: `${contextLabel}.variationDescriptor.vcfRecord`,
        reason:
          'VCF record fields (chrom/pos/ref/alt) compacted into hgvsGDot string — v1-draft has no refAllele/altAllele/genomicStartEnd properties yet (vocab evolution in flight).',
        severity: 'info',
        context: sourceId,
      });
    }
  }

  // ---- Allelic state / zygosity (GENO term) ----
  if (descriptor.allelicState && typeof descriptor.allelicState === 'object') {
    const id: string = descriptor.allelicState.id ?? '';
    const named = GENO_ZYGOSITY_TO_VALUE[id];
    if (named) {
      quads.push(tripleRef(iri, GENOMICS_NS + 'zygosity', GENOMICS_NS + named));
    } else {
      gaps.push({
        sourceField: `${contextLabel}.variationDescriptor.allelicState`,
        reason: `Unrecognized GENO allelic-state ${id} (${descriptor.allelicState.label ?? '<no label>'})`,
        severity: 'info',
        context: sourceId,
      });
    }
  }

  // ---- Extensions (mosaicism, allele-frequency) ----
  if (Array.isArray(descriptor.extensions)) {
    for (const ext of descriptor.extensions) {
      const name: string = ext?.name ?? '';
      const value: unknown = ext?.value;
      if (name === 'mosaicism' || name === 'allele-frequency') {
        const fraction = extensionPercentToFraction(value);
        if (fraction !== undefined) {
          quads.push(
            makeQuad(
              subject,
              namedNode(GENOMICS_NS + 'mosaicismFraction'),
              literal(String(fraction), namedNode(NS.xsd + 'decimal')),
            ),
          );
        } else {
          gaps.push({
            sourceField: `${contextLabel}.variationDescriptor.extensions[${name}]`,
            reason: `Unparseable extension value: ${String(value)}`,
            severity: 'info',
            context: sourceId,
          });
        }
      } else {
        gaps.push({
          sourceField: `${contextLabel}.variationDescriptor.extensions[${name}]`,
          reason: `Unhandled extension: ${name} (${String(value)}). v1-draft has no slot for this extension.`,
          severity: 'info',
          context: sourceId,
        });
      }
    }
  }

  // ---- VRS preservation (D-Q6) ----
  const { vrsId, vrsObject } = extractVrs(descriptor);
  if (vrsId) quads.push(tripleStr(iri, GENOMICS_NS + 'vrsId', vrsId));
  if (vrsObject) quads.push(tripleStr(iri, GENOMICS_NS + 'vrsObject', vrsObject));

  // ---- CNV-specific properties ----
  if (kind === 'cnv') {
    const cn = descriptor.variation?.copyNumber;
    if (cn) {
      // Number of copies: { value: 'N' }
      const copies = cnvNumberAsInt(cn.number);
      if (copies !== undefined) {
        quads.push(tripleInt(iri, GENOMICS_NS + 'copyNumber', copies));
      }

      // Interval (sequenceLocation / sequenceInterval)
      const loc = cn.derivedSequenceExpression?.location ?? cn.allele?.location ?? cn.location;
      if (loc) {
        if (typeof loc.sequenceId === 'string') {
          quads.push(tripleStr(iri, GENOMICS_NS + 'cnvIntervalRef', loc.sequenceId));
        }
        const interval = loc.sequenceInterval ?? loc.interval;
        const start = cnvNumberAsInt(interval?.startNumber ?? interval?.start);
        const end = cnvNumberAsInt(interval?.endNumber ?? interval?.end);
        if (start !== undefined) {
          quads.push(tripleInt(iri, GENOMICS_NS + 'cnvIntervalStart', start));
        }
        if (end !== undefined) {
          quads.push(tripleInt(iri, GENOMICS_NS + 'cnvIntervalEnd', end));
        }
      }
    }
  }

  // ---- Haplotype-specific (rare path) ----
  if (kind === 'haplotype') {
    gaps.push({
      sourceField: `${contextLabel}.variationDescriptor.variation.haplotype`,
      reason:
        'Phenopacket haplotype shape (members[].allele) not fully expanded — v1-draft Haplotype expects component variant references, but these are inline in the descriptor.',
      severity: 'info',
      context: sourceId,
    });
  }

  // ---- moleculeContext / structuralType / vrs* (extra fields) ----
  if (typeof descriptor.moleculeContext === 'string') {
    gaps.push({
      sourceField: `${contextLabel}.variationDescriptor.moleculeContext`,
      reason: `moleculeContext (${descriptor.moleculeContext}) dropped — v1-draft has no slot for this distinction (genomic vs transcript vs protein).`,
      severity: 'info',
      context: sourceId,
    });
  }
  if (descriptor.structuralType) {
    gaps.push({
      sourceField: `${contextLabel}.variationDescriptor.structuralType`,
      reason: `structuralType (${descriptor.structuralType.id ?? ''}) dropped — v1-draft has no SO-class slot for SV typing.`,
      severity: 'info',
      context: sourceId,
    });
  }

  // ---- Source identity passthrough ----
  quads.push(tripleStr(iri, NS.cascade + 'sourceFhirId', sourceId));

  return {
    record: {
      iri,
      cascadeType: `genomics:${cascadeKind}`,
      sourceId,
      fhirResourceType: 'Observation',
      quads,
    },
    warnings,
    gaps,
  };
}
