/**
 * Phenopacket subject → cascade:PatientProfile parser.
 *
 * Maps the GA4GH `phenopacket.subject` (or `family.proband.subject`, or
 * `cohort.members[i].subject`) to a Cascade Patient Profile record.
 *
 * Subject fields handled (Phenopacket v2):
 *   - `id`                              → minted Cascade IRI + cascade:profileId
 *   - `sex`                             → cascade:biologicalSex (MALE/FEMALE/
 *                                          OTHER_SEX/UNKNOWN_SEX → male/female/intersex)
 *   - `dateOfBirth`                     → cascade:dateOfBirth (xsd:date)
 *   - `timeAtLastEncounter.age.iso8601duration`
 *                                       → cascade:ageAtLastEncounter (string,
 *                                          ISO 8601 duration P##Y##M##D)
 *   - `taxonomy.id` / `taxonomy.label`  → cascade:speciesTaxon + cascade:speciesLabel
 *   - `alternateIds`                    → recorded as info-severity gap-warnings
 *                                          (no v1-draft slot for additional patient
 *                                          identifiers yet)
 *   - `karyotypicSex`                   → recorded as info-severity gap-warning
 *
 * Subjects in the corpus may be wholly absent (e.g., marfan.input.json) — the
 * caller passes `subject: undefined` and the parser emits a warning-severity
 * gap and synthesizes a minimal anonymous patient IRI from the phenopacket id.
 *
 * IRIs are deterministically derived: `urn:uuid:{deterministicUuid("PatientProfile:" +
 * sourceSystem + ":" + subjectId)}`. This keeps round-trips stable across
 * re-imports and matches the convention already established by the FHIR and
 * C-CDA importers.
 */

import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import type { ParsedRecord, Quad } from './types.js';
import { PHENOPACKET_SEX_TO_BIOLOGICAL_SEX } from './types.js';
import {
  NS,
  SCHEMA_VERSION,
  tripleType,
  tripleStr,
  tripleRef,
  tripleDate,
  deterministicUuid,
} from '../fhir-converter/types.js';

export interface SubjectParseOutput {
  record: ParsedRecord;
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

/**
 * Mint a deterministic Cascade IRI for a phenopacket subject. Falls back to
 * the parent phenopacket id when the subject itself has no id.
 */
export function mintSubjectIri(
  subject: any,
  parentId: string | undefined,
  ctx: ImportContext,
): string {
  const sys = ctx.sourceSystem ?? 'phenopacket';
  const sid: string =
    (typeof subject?.id === 'string' && subject.id) ||
    (typeof parentId === 'string' && parentId) ||
    `unknown:${ctx.importedAt}`;
  return `urn:uuid:${deterministicUuid(`PatientProfile:${sys}:${sid}`)}`;
}

/**
 * Parse a phenopacket subject into a cascade:PatientProfile record.
 *
 * `parentId` is the enclosing phenopacket / cohort-member / family-proband id,
 * used as a fallback when subject.id is missing and to scope the source-id
 * passthrough on the emitted record.
 */
export function parseSubject(
  subject: any,
  parentId: string | undefined,
  ctx: ImportContext,
): SubjectParseOutput {
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];
  const quads: Quad[] = [];

  const iri = mintSubjectIri(subject, parentId, ctx);
  const sourceId: string =
    (typeof subject?.id === 'string' && subject.id) ||
    (typeof parentId === 'string' && parentId) ||
    '<no-id>';

  // ---- Type + provenance ----
  quads.push(tripleType(iri, NS.cascade + 'PatientProfile'));
  quads.push(tripleRef(iri, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'));
  quads.push(tripleStr(iri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));

  // If there's no subject at all (e.g., marfan.input.json), emit a warning
  // gap and return the minimal anchor record so downstream features can still
  // attach to it.
  if (!subject || typeof subject !== 'object') {
    gaps.push({
      sourceField: 'subject',
      reason: 'Phenopacket has no subject — phenotypic features attach to a synthesized anonymous patient IRI.',
      severity: 'warning',
      context: parentId,
    });
    quads.push(tripleStr(iri, NS.cascade + 'profileId', sourceId));
    return {
      record: {
        iri,
        cascadeType: 'cascade:PatientProfile',
        sourceId,
        fhirResourceType: 'Patient',
        quads,
      },
      warnings,
      gaps,
    };
  }

  // ---- profileId (subject.id) ----
  if (typeof subject.id === 'string') {
    quads.push(tripleStr(iri, NS.cascade + 'profileId', subject.id));
  }

  // ---- sex → biologicalSex ----
  if (typeof subject.sex === 'string') {
    const mapped = PHENOPACKET_SEX_TO_BIOLOGICAL_SEX[subject.sex];
    if (mapped) {
      quads.push(tripleStr(iri, NS.cascade + 'biologicalSex', mapped));
    } else {
      gaps.push({
        sourceField: 'subject.sex',
        reason: `Unrecognized phenopacket sex enum value: ${subject.sex}`,
        severity: 'warning',
        context: sourceId,
      });
    }
  }

  // ---- dateOfBirth (ISO 8601 datetime — keep date portion only) ----
  if (typeof subject.dateOfBirth === 'string' && subject.dateOfBirth.length >= 10) {
    const datePart = subject.dateOfBirth.slice(0, 10);
    quads.push(tripleDate(iri, NS.cascade + 'dateOfBirth', datePart));
  }

  // ---- timeAtLastEncounter.age.iso8601duration ----
  // Phenopackets carry age as an ISO 8601 duration (P14Y, P6M, P5M15D, ...).
  // No core:ageAtLastEncounter slot exists yet — we emit it as a string under
  // a stable predicate so downstream tools can pick it up, plus an info gap
  // explaining the v1-draft mismatch.
  const taleAge = subject.timeAtLastEncounter?.age?.iso8601duration;
  if (typeof taleAge === 'string') {
    quads.push(tripleStr(iri, NS.cascade + 'ageAtLastEncounter', taleAge));
    gaps.push({
      sourceField: 'subject.timeAtLastEncounter.age.iso8601duration',
      reason:
        'Phenopacket age stored under cascade:ageAtLastEncounter as ISO 8601 duration string; no native cascade slot in v1-draft.',
      severity: 'info',
      context: sourceId,
    });
  }

  // ---- taxonomy ----
  if (subject.taxonomy && typeof subject.taxonomy === 'object') {
    if (typeof subject.taxonomy.id === 'string') {
      quads.push(tripleStr(iri, NS.cascade + 'speciesTaxon', subject.taxonomy.id));
    }
    if (typeof subject.taxonomy.label === 'string') {
      quads.push(tripleStr(iri, NS.cascade + 'speciesLabel', subject.taxonomy.label));
    }
    gaps.push({
      sourceField: 'subject.taxonomy',
      reason:
        'Species taxonomy stored under cascade:speciesTaxon (string) — no first-class species slot in v1-draft.',
      severity: 'info',
      context: sourceId,
    });
  }

  // ---- alternateIds → gap (no slot in v1-draft) ----
  if (Array.isArray(subject.alternateIds) && subject.alternateIds.length > 0) {
    gaps.push({
      sourceField: 'subject.alternateIds',
      reason: `${subject.alternateIds.length} alternate identifiers (${subject.alternateIds.slice(0, 3).join(', ')}${subject.alternateIds.length > 3 ? ', …' : ''}) dropped — no PatientProfile alternateId slot in v1-draft.`,
      severity: 'info',
      context: sourceId,
    });
  }

  // ---- karyotypicSex → gap ----
  if (typeof subject.karyotypicSex === 'string') {
    gaps.push({
      sourceField: 'subject.karyotypicSex',
      reason: `karyotypicSex (${subject.karyotypicSex}) dropped — no PatientProfile karyotypic-sex slot in v1-draft (distinct from biologicalSex).`,
      severity: 'info',
      context: sourceId,
    });
  }

  // ---- vitalStatus (deceased / cause of death) ----
  if (subject.vitalStatus && typeof subject.vitalStatus === 'object') {
    gaps.push({
      sourceField: 'subject.vitalStatus',
      reason:
        'Phenopacket vitalStatus (status, timeOfDeath, causeOfDeath) dropped — no v1-draft PatientProfile death slot.',
      severity: 'info',
      context: sourceId,
    });
  }

  return {
    record: {
      iri,
      cascadeType: 'cascade:PatientProfile',
      sourceId,
      fhirResourceType: 'Patient',
      quads,
    },
    warnings,
    gaps,
  };
}
