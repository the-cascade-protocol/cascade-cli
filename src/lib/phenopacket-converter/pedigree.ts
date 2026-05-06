/**
 * Phenopacket family resource → genomics:Pedigree + genomics:PedigreeMember.
 *
 * The phenopacket "family" top-level shape is distinct from the single-
 * subject "phenopacket" shape: it carries `proband`, `relatives[]`, and a
 * `pedigree` block describing the family graph in PED-like notation.
 *
 *   family: {
 *     id, proband: { subject: ..., phenotypicFeatures: ..., interpretations: ... },
 *     relatives: [{ subject: ..., phenotypicFeatures: ... }, ...],
 *     pedigree: {
 *       persons: [
 *         { individualId, paternalId?, maternalId?, sex, affectedStatus }
 *       ]
 *     }
 *   }
 *
 * This module produces the genomics:Pedigree summary record + a
 * PedigreeMember per `pedigree.persons[]` entry. Subject-level details
 * (HPO terms, demographics) are still handled by parseSubject() at the
 * orchestrator level — pedigree adds the relationship structure.
 *
 * Mapping:
 *   pedigree.persons[].individualId   → PedigreeMember IRI
 *   pedigree.persons[].paternalId/maternalId
 *                                      → genomics:relativeRole (FTH/MTH/SIS/BRO/SON/DAU)
 *                                         determined relative to the proband
 *   pedigree.persons[].sex             → genomics:relativeSex ('male' | 'female' | 'unknown')
 *   pedigree.persons[].affectedStatus  → recorded as info-severity gap +
 *                                         a synthetic genomics:affectedStatus
 *                                         string predicate (no v1-draft slot)
 *
 * Acceptance: trio (proband + MOTHER + FATHER) preserves Proband / MTH /
 * FTH roles. Sibling rows resolve to SIS / BRO when the proband
 * paternalId & maternalId match.
 */

import { GENOMICS_NS } from './types.js';
import type { Quad, ParsedRecord } from './types.js';
import type { ImportContext, ImportWarning, VocabularyGap } from '../import-types.js';
import {
  NS,
  SCHEMA_VERSION,
  tripleType,
  tripleStr,
  tripleRef,
  deterministicUuid,
} from '../fhir-converter/types.js';

export interface PedigreeParseOutput {
  records: ParsedRecord[];
  quads: Quad[];
  warnings: ImportWarning[];
  gaps: VocabularyGap[];
}

interface PedigreePerson {
  individualId: string;
  paternalId?: string;
  maternalId?: string;
  sex?: string;
  affectedStatus?: string;
}

function mintPedigreeIri(familyId: string, ctx: ImportContext): string {
  const sys = ctx.sourceSystem ?? 'phenopacket';
  return `urn:uuid:${deterministicUuid(`genomics:Pedigree:${sys}:${familyId}`)}`;
}

function mintMemberIri(familyId: string, individualId: string, ctx: ImportContext): string {
  const sys = ctx.sourceSystem ?? 'phenopacket';
  return `urn:uuid:${deterministicUuid(
    `genomics:PedigreeMember:${sys}:${familyId}:${individualId}`,
  )}`;
}

/**
 * Determine a member's role relative to the proband.
 *
 *   proband itself                                     → 'Proband'
 *   member is proband.paternalId                       → 'FTH'
 *   member is proband.maternalId                       → 'MTH'
 *   member shares both parents with proband, sex=M     → 'BRO'
 *   member shares both parents with proband, sex=F     → 'SIS'
 *   proband is member.paternalId, sex=M                → 'SON'
 *   proband is member.paternalId, sex=F                → 'DAU'
 *   proband is member.maternalId, sex=M                → 'SON'
 *   proband is member.maternalId, sex=F                → 'DAU'
 *
 * Unrecognized relationships return undefined and the caller emits an
 * info gap.
 */
function inferRole(
  member: PedigreePerson,
  proband: PedigreePerson | undefined,
): string | undefined {
  if (!proband) return undefined;
  if (member.individualId === proband.individualId) return 'Proband';
  const sex = (member.sex ?? '').toUpperCase();
  // Member is proband's parent
  if (proband.paternalId && member.individualId === proband.paternalId) return 'FTH';
  if (proband.maternalId && member.individualId === proband.maternalId) return 'MTH';
  // Member is proband's child
  if (member.paternalId === proband.individualId || member.maternalId === proband.individualId) {
    if (sex === 'MALE') return 'SON';
    if (sex === 'FEMALE') return 'DAU';
    return undefined;
  }
  // Sibling: shares at least one parent with proband, AND has at least one
  // parent specified (otherwise we can't really tell).
  const sharesPaternal =
    !!member.paternalId && !!proband.paternalId && member.paternalId === proband.paternalId;
  const sharesMaternal =
    !!member.maternalId && !!proband.maternalId && member.maternalId === proband.maternalId;
  if (sharesPaternal || sharesMaternal) {
    if (sex === 'MALE') return 'BRO';
    if (sex === 'FEMALE') return 'SIS';
    return undefined;
  }
  return undefined;
}

/**
 * Parse a phenopacket family resource. Returns the Pedigree + PedigreeMember
 * records merged into a single output. Caller passes a `subjectIris` map
 * keyed by individualId, populated by parseSubject() so members can be
 * linked back to their cascade:PatientProfile records.
 */
export function parsePedigree(
  family: any,
  subjectIris: Map<string, string>,
  ctx: ImportContext,
): PedigreeParseOutput {
  const records: ParsedRecord[] = [];
  const quads: Quad[] = [];
  const warnings: ImportWarning[] = [];
  const gaps: VocabularyGap[] = [];

  if (!family || typeof family !== 'object') {
    return { records, quads, warnings, gaps };
  }

  const familyId: string =
    typeof family.id === 'string' && family.id.length > 0 ? family.id : 'family';
  const persons: PedigreePerson[] = Array.isArray(family.pedigree?.persons)
    ? family.pedigree.persons.filter((p: any) => p && typeof p.individualId === 'string')
    : [];

  if (persons.length === 0) {
    gaps.push({
      sourceField: 'family.pedigree.persons',
      reason: 'family resource has no pedigree.persons[] — no Pedigree record emitted.',
      severity: 'info',
      context: familyId,
    });
    return { records, quads, warnings, gaps };
  }

  // Identify the proband from family.proband.subject.id, falling back to
  // the first person with sex=MALE/FEMALE (rare degenerate path).
  const probandIndividualId: string | undefined = family.proband?.subject?.id;
  const proband: PedigreePerson | undefined =
    persons.find((p) => p.individualId === probandIndividualId) ?? persons[0];

  // ---- Pedigree summary record ----
  const pedIri = mintPedigreeIri(familyId, ctx);
  const pedQuads: Quad[] = [];
  pedQuads.push(tripleType(pedIri, GENOMICS_NS + 'Pedigree'));
  pedQuads.push(
    tripleRef(pedIri, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'),
  );
  pedQuads.push(tripleStr(pedIri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));
  pedQuads.push(tripleStr(pedIri, NS.cascade + 'sourceFhirId', familyId));

  // ---- PedigreeMember records ----
  const memberIris = new Map<string, string>();
  for (const person of persons) {
    const memberIri = mintMemberIri(familyId, person.individualId, ctx);
    memberIris.set(person.individualId, memberIri);

    const mQuads: Quad[] = [];
    mQuads.push(tripleType(memberIri, GENOMICS_NS + 'PedigreeMember'));
    mQuads.push(
      tripleRef(memberIri, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'),
    );
    mQuads.push(tripleStr(memberIri, NS.cascade + 'schemaVersion', SCHEMA_VERSION));
    mQuads.push(tripleStr(memberIri, NS.cascade + 'sourceFhirId', person.individualId));

    // Sex
    if (person.sex) {
      const sex = person.sex.toUpperCase();
      const mapped = sex === 'MALE' ? 'male' : sex === 'FEMALE' ? 'female' : 'unknown';
      mQuads.push(tripleStr(memberIri, GENOMICS_NS + 'relativeSex', mapped));
    }

    // Role
    const role = inferRole(person, proband);
    if (role) {
      mQuads.push(tripleRef(memberIri, GENOMICS_NS + 'relativeRole', GENOMICS_NS + role));
    } else {
      gaps.push({
        sourceField: `family.pedigree.persons[${person.individualId}]`,
        reason: `Could not infer relationship role for member ${person.individualId} (paternalId=${person.paternalId ?? '<none>'}, maternalId=${person.maternalId ?? '<none>'}); v1-draft RoleCodes for non-cardinal relationships are limited.`,
        severity: 'info',
        context: familyId,
      });
    }

    // Affected status — no v1-draft slot for AFFECTED/UNAFFECTED outside
    // a specific variant context. Carry as cascade:affectedStatus string +
    // info gap.
    if (typeof person.affectedStatus === 'string') {
      mQuads.push(
        tripleStr(memberIri, NS.cascade + 'affectedStatus', person.affectedStatus.toLowerCase()),
      );
      gaps.push({
        sourceField: `family.pedigree.persons[${person.individualId}].affectedStatus`,
        reason: `affectedStatus=${person.affectedStatus} stored under cascade:affectedStatus string — v1-draft genomics:CarrierStatus requires a tested variant context, not a free affected/unaffected flag.`,
        severity: 'info',
        context: familyId,
      });
    }

    // Link back to the patient profile if parseSubject() registered one.
    const patientIri = subjectIris.get(person.individualId);
    if (patientIri) {
      mQuads.push(tripleRef(memberIri, NS.cascade + 'aboutPatient', patientIri));
    }

    // Pedigree summary references this member.
    pedQuads.push(tripleRef(pedIri, GENOMICS_NS + 'hasMember', memberIri));
    if (person.individualId === proband?.individualId) {
      pedQuads.push(tripleRef(pedIri, GENOMICS_NS + 'proband', memberIri));
    }

    records.push({
      iri: memberIri,
      cascadeType: 'genomics:PedigreeMember',
      sourceId: person.individualId,
      fhirResourceType: 'FamilyMemberHistory',
      quads: mQuads,
    });
    quads.push(...mQuads);
  }

  // Push the Pedigree record itself last so its hasMember references resolve.
  records.push({
    iri: pedIri,
    cascadeType: 'genomics:Pedigree',
    sourceId: familyId,
    fhirResourceType: 'List',
    quads: pedQuads,
  });
  quads.push(...pedQuads);

  return { records, quads, warnings, gaps };
}
