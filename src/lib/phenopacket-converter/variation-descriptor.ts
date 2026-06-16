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
 * corpus).
 *
 * v1-draft.0.2 wiring: refAllele / altAllele / genomicStartEnd are emitted
 * from descriptor.vcfRecord (when present) and from the canonical VRS Allele
 * form under descriptor.variation.allele.location/state (when present).
 * refAllele cannot be recovered from canonical VRS Allele state alone — it
 * would require a seqrepo lookup against the reference assembly (out of
 * scope per D-Q6); emitted only when an explicit ref string is in the
 * vcfRecord.
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
 *
 * Identity preference (most-specific first):
 *   1. descriptor.id — the source's own identifier
 *   2. descriptor.label — semantically meaningful name
 *   3. content hash of (expressions ∪ geneContext ∪ vcfRecord ∪ variation)
 *      — covers anonymous descriptors that nonetheless carry distinguishing
 *      structured content. This is what most v2 phenopackets land on.
 *   4. fallback to a hash of the entire descriptor JSON — last resort,
 *      but still deterministic for byte-equal regression. (Earlier v0.1
 *      revisions used Math.random() here, which broke byte-equal contract
 *      across re-imports of the same input — fixed 2026-05-06.)
 */
function mintVariantIri(descriptor: unknown, ctx: ImportContext, kind: string): string {
  const sys = ctx.sourceSystem ?? 'phenopacket';
  const desc = (descriptor ?? {}) as Record<string, unknown>;
  const id =
    (typeof desc.id === 'string' && desc.id) ||
    (typeof desc.label === 'string' && desc.label) ||
    contentSeed(desc);
  return `urn:uuid:${deterministicUuid(`genomics:${kind}:${sys}:${id}`)}`;
}

/**
 * Build a stable seed string from the structurally-distinguishing fields
 * of a variationDescriptor. The fields are sorted before serialization
 * so key ordering in the source JSON doesn't perturb the hash.
 */
function contentSeed(desc: Record<string, unknown>): string {
  // Pick fields that meaningfully distinguish two anonymous variations.
  // Order matters: keep this list sorted for stability.
  const fields = ['expressions', 'extensions', 'geneContext', 'molecularAttributes', 'variation', 'vcfRecord'] as const;
  const parts: string[] = ['anon'];
  for (const k of fields) {
    if (k in desc) {
      parts.push(`${k}=${stableStringify(desc[k])}`);
    }
  }
  if (parts.length === 1) {
    // Truly bare descriptor — fall through to JSON of the whole thing.
    parts.push(`raw=${stableStringify(desc)}`);
  }
  return parts.join('|');
}

/** JSON.stringify with sorted keys at every level. Stable across object key insertion order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const inner = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',');
  return `{${inner}}`;
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
  // v1-draft.0.2: emit refAllele / altAllele / genomicStartEnd directly from
  // the vcfRecord fields. Also retain the compact hgvsGDot string for
  // human-readable display.
  if (descriptor.vcfRecord && typeof descriptor.vcfRecord === 'object') {
    const vcf = descriptor.vcfRecord;
    if (typeof vcf.genomeAssembly === 'string') {
      quads.push(tripleStr(iri, GENOMICS_NS + 'genomeAssembly', vcf.genomeAssembly));
    }
    if (vcf.chrom && vcf.pos && vcf.ref && vcf.alt) {
      const refStr = String(vcf.ref);
      const altStr = String(vcf.alt);
      const posNum = Number(vcf.pos);
      const compact = `${vcf.chrom}:g.${vcf.pos}${refStr}>${altStr}`;
      quads.push(tripleStr(iri, GENOMICS_NS + 'hgvsGDot', compact));
      quads.push(tripleStr(iri, GENOMICS_NS + 'refAllele', refStr));
      quads.push(tripleStr(iri, GENOMICS_NS + 'altAllele', altStr));
      if (Number.isFinite(posNum) && refStr.length > 0) {
        const chromStr = String(vcf.chrom);
        // RefSeq accessions (NC_000013.11) keep their identifier form;
        // bare chromosome names get a "chr" prefix.
        const isRefSeqLike =
          chromStr.startsWith('chr') ||
          /^N[CGT]_\d+/.test(chromStr) ||
          /^[A-Z]{2,}\d+\.\d+/.test(chromStr);
        const chrLabel = isRefSeqLike ? chromStr : `chr${chromStr}`;
        const endPos = posNum + refStr.length - 1;
        quads.push(
          tripleStr(
            iri,
            GENOMICS_NS + 'genomicStartEnd',
            `${chrLabel}:${posNum}-${endPos}`,
          ),
        );
      }
    }
  }

  // ---- VRS Allele location/state (v1-draft.0.2) ----
  // Phenopacket v2 variationDescriptors with VRS Allele under
  // descriptor.variation.allele carry:
  //   - location.interval.start.value + end.value (1-based inclusive)
  //   - location.sequenceId (RefSeq accession or chr name)
  //   - state.sequence (the alternate allele)
  // refAllele is NOT recoverable from canonical VRS Allele form — that
  // would require a seqrepo lookup against the reference assembly, which
  // is out of scope per D-Q6 (no external sequence-server dependencies).
  // Surface a gap-info when state.sequence is present but refAllele can't
  // be derived from explicit fields.
  const allele = descriptor?.variation?.allele;
  if (allele && typeof allele === 'object') {
    const loc = allele.location;
    const interval = loc?.interval ?? loc?.sequenceInterval;
    const startVal =
      typeof interval?.start?.value === 'number'
        ? interval.start.value
        : typeof interval?.start === 'number'
        ? interval.start
        : typeof interval?.startNumber?.value === 'string'
        ? Number(interval.startNumber.value)
        : undefined;
    const endVal =
      typeof interval?.end?.value === 'number'
        ? interval.end.value
        : typeof interval?.end === 'number'
        ? interval.end
        : typeof interval?.endNumber?.value === 'string'
        ? Number(interval.endNumber.value)
        : undefined;
    const seqId = loc?.sequenceId ?? loc?.sequence_id;
    if (
      typeof seqId === 'string' &&
      Number.isFinite(startVal) &&
      Number.isFinite(endVal)
    ) {
      quads.push(
        tripleStr(
          iri,
          GENOMICS_NS + 'genomicStartEnd',
          `${seqId}:${startVal}-${endVal}`,
        ),
      );
    }
    const stateSeq = allele.state?.sequence ?? allele.state?.literalSequenceExpression?.sequence;
    if (typeof stateSeq === 'string' && stateSeq.length > 0) {
      quads.push(tripleStr(iri, GENOMICS_NS + 'altAllele', stateSeq));
      // refAllele not preserved in canonical VRS Allele form (state.sequence
      // is the ALT only). Recovering REF would require a seqrepo lookup
      // against the reference assembly — out of scope per D-Q6.
      gaps.push({
        sourceField: `${contextLabel}.variationDescriptor.variation.allele.state`,
        reason:
          'VRS Allele canonical form preserves only the alternate sequence; genomics:refAllele not emitted because deriving it would require a seqrepo lookup against the reference assembly (out of scope per D-Q6 — no external sequence-server dependencies).',
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
