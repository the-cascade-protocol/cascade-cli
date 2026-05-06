/**
 * Public surface for the GA4GH Phenopacket → Cascade converter.
 *
 * `convertPhenopacket()` is the orchestrator. It detects the top-level shape
 * (single phenopacket vs family vs cohort), dispatches each resource through
 * the per-section parsers, and returns the merged quad stream + per-record
 * metadata.
 *
 * Per-section parser landings:
 *   TASK-2B.2  — subject.ts             (subject → cascade:PatientProfile)
 *   TASK-2B.3  — phenotypic-features.ts (HPO terms on the patient)
 *   TASK-2B.4  — interpretations.ts     (genomics:VariantInterpretation)
 *   TASK-2B.5  — variation-descriptor.ts (genomics:Variant + CNV)
 *   TASK-2B.6  — pedigree.ts            (genomics:Pedigree, family resource)
 *   TASK-2B.7  — biosamples.ts          (fhir:Specimen + RawFile)
 *   TASK-2B.8  — medical-actions.ts     (checkup:recommendedActions text)
 *
 * D-Q5: multi-condition cardinality — one VariantInterpretation per
 *       (variant, condition) pair.
 * D-Q6: VRS hashes preserved only — never computed.
 * D-DIRECTORY: biosample/file refs that look like FASTQ/BAM/VCF emit
 *              genomics:RawFile pointer-and-hash records.
 * D-QUALITY-TIER: phenopackets are research-context by default →
 *                 genomics:ResearchGrade. CLIA/clinical signals upgrade
 *                 to ClinicalGrade (rare in this corpus).
 */

import type { Quad } from 'n3';
import type {
  ImportContext,
  ImportWarning,
  VocabularyGap,
  ImportedIdentifier,
} from '../import-types.js';
import type { ParsedRecord } from '../fhir-genomics-converter/types.js';
import { classifyPhenopacket } from './detect.js';
import { parseSubject } from './subject.js';

export { detectPhenopacket, classifyPhenopacket } from './detect.js';
export { phenopacketImporter } from './registry-entry.js';

export interface PhenopacketConversionResult {
  records: ParsedRecord[];
  quads: Quad[];
  warnings: ImportWarning[];
  vocabularyGaps: VocabularyGap[];
  importedIdentifiers: ImportedIdentifier[];
  skippedCount: number;
}

/**
 * One phenopacket worth of conversion state. A single-phenopacket input
 * produces one of these; family inputs produce one for the proband + one
 * per relative; cohort inputs produce one per member.
 */
interface PhenopacketUnit {
  /** Source record: a phenopacket (or family.proband, or cohort.members[i]). */
  pp: any;
  /** Patient IRI minted by the subject parser. */
  patientIri: string;
}

/**
 * Walk a parsed phenopacket / family / cohort resource and emit Cascade
 * records.
 *
 * At TASK-2B.2 the orchestrator wires subject parsing for all three top-
 * level shapes. Phenotypic features, interpretations, variants, and
 * biosamples land in subsequent tasks.
 */
export async function convertPhenopacket(
  parsed: any,
  ctx: ImportContext,
): Promise<PhenopacketConversionResult> {
  const records: ParsedRecord[] = [];
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const vocabularyGaps: VocabularyGap[] = [];
  const importedIdentifiers: ImportedIdentifier[] = [];
  let skippedCount = 0;

  const kind = classifyPhenopacket(parsed);
  if (kind === null) {
    vocabularyGaps.push({
      sourceField: '<root>',
      reason:
        'Input does not match any recognized phenopacket top-level shape (phenopacket, family, cohort).',
      severity: 'warning',
      context: typeof parsed?.id === 'string' ? parsed.id : undefined,
    });
    skippedCount += 1;
    return { records, quads, warnings, vocabularyGaps, importedIdentifiers, skippedCount };
  }

  // -------- Decompose into one or more "phenopacket units" --------
  const units: PhenopacketUnit[] = [];

  if (kind === 'phenopacket') {
    const out = parseSubject(parsed.subject, parsed.id, ctx);
    records.push(out.record);
    quads.push(...out.record.quads);
    warnings.push(...out.warnings);
    vocabularyGaps.push(...out.gaps);
    importedIdentifiers.push({
      cascadeIri: out.record.iri,
      cascadeType: out.record.cascadeType,
      sourceType: 'Phenopacket.subject',
      sourceId: out.record.sourceId,
    });
    units.push({ pp: parsed, patientIri: out.record.iri });
  } else if (kind === 'family') {
    // Proband first.
    const probandPp = parsed.proband ?? {};
    const probandOut = parseSubject(probandPp.subject, probandPp.id ?? parsed.id, ctx);
    records.push(probandOut.record);
    quads.push(...probandOut.record.quads);
    warnings.push(...probandOut.warnings);
    vocabularyGaps.push(...probandOut.gaps);
    importedIdentifiers.push({
      cascadeIri: probandOut.record.iri,
      cascadeType: probandOut.record.cascadeType,
      sourceType: 'Phenopacket.family.proband.subject',
      sourceId: probandOut.record.sourceId,
    });
    units.push({ pp: probandPp, patientIri: probandOut.record.iri });

    // Then each relative.
    if (Array.isArray(parsed.relatives)) {
      for (const rel of parsed.relatives) {
        const relOut = parseSubject(rel?.subject, rel?.id ?? rel?.subject?.id, ctx);
        records.push(relOut.record);
        quads.push(...relOut.record.quads);
        warnings.push(...relOut.warnings);
        vocabularyGaps.push(...relOut.gaps);
        importedIdentifiers.push({
          cascadeIri: relOut.record.iri,
          cascadeType: relOut.record.cascadeType,
          sourceType: 'Phenopacket.family.relative.subject',
          sourceId: relOut.record.sourceId,
        });
        units.push({ pp: rel, patientIri: relOut.record.iri });
      }
    }
  } else if (kind === 'cohort') {
    if (Array.isArray(parsed.members)) {
      for (const member of parsed.members) {
        const memberOut = parseSubject(member?.subject, member?.id, ctx);
        records.push(memberOut.record);
        quads.push(...memberOut.record.quads);
        warnings.push(...memberOut.warnings);
        vocabularyGaps.push(...memberOut.gaps);
        importedIdentifiers.push({
          cascadeIri: memberOut.record.iri,
          cascadeType: memberOut.record.cascadeType,
          sourceType: 'Phenopacket.cohort.member.subject',
          sourceId: memberOut.record.sourceId,
        });
        units.push({ pp: member, patientIri: memberOut.record.iri });
      }
    }
  }

  // Subsequent tasks add per-unit processing here:
  //   - TASK-2B.3 phenotypicFeatures → HPO refs on the patient
  //   - TASK-2B.4 interpretations    → VariantInterpretation records
  //   - TASK-2B.5 variation desc.    → Variant / CNV records
  //   - TASK-2B.7 biosamples         → Specimen records
  //   - TASK-2B.8 medicalActions     → recommendedActions text on the patient
  void units;

  return {
    records,
    quads,
    warnings,
    vocabularyGaps,
    importedIdentifiers,
    skippedCount,
  };
}
