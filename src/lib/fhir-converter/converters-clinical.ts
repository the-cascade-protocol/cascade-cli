/**
 * FHIR -> Cascade converters for clinical record types.
 *
 * Converts:
 *   - MedicationStatement / MedicationRequest -> clinical:Medication
 *   - Condition -> health:ConditionRecord
 *   - AllergyIntolerance -> health:AllergyRecord
 *   - Observation (lab) -> health:LabResultRecord
 *   - Observation (vital) -> clinical:VitalSign
 *   - Procedure -> clinical:Procedure
 *   - DocumentReference -> clinical:ClinicalDocument
 *   - Encounter -> clinical:Encounter
 *   - DiagnosticReport -> clinical:LaboratoryReport or clinical:ImagingReport,
 *                         routed on DiagnosticReport.category (see routeDiagnosticReport)
 *   - MedicationAdministration -> clinical:MedicationAdministration
 *   - Device -> clinical:ImplantedDevice
 *   - ImagingStudy -> clinical:ImagingStudy
 */

import type { Quad } from 'n3';

import {
  type ConversionResult,
  NS,
  CODING_SYSTEM_MAP,
  VITAL_LOINC_CODES,
  VITAL_CATEGORIES,
  isLoincSystem,
  extractCodings,
  codeableConceptText,
  medicationUri,
  tripleStr,
  tripleDouble,
  tripleRef,
  tripleType,
  tripleDateTime,
  tripleTyped,
  commonTriples,
  quadsToJsonLd,
  mintSubjectUri,
  idOrContentUri,
  codeableConceptKey,
  codeableConceptSetKey,
  structuredKey,
  canonicalSetKey,
  encounterParticipantUri,
  type EncounterParticipation,
} from './types.js';
import {
  referencePlaceholder,
  pushEncounterEdge,
  pushIndicationEdges,
  pushParsedIndicationCandidates,
} from './reference-resolution.js';
import { interpretationValue } from './interpretation.js';

// ---------------------------------------------------------------------------
// Record lifecycle status
// ---------------------------------------------------------------------------

/**
 * WHY `clinical:status` CARRIES FHIR's `.status` ON EVERY TYPE THAT HAS ONE
 * ------------------------------------------------------------------------
 * An `amended` result and a `final` one are different claims about the same
 * measurement, and until this was emitted they were byte-identical in the pod:
 * measured on one real account, 1 amended Observation and 9 amended
 * DocumentReferences were indistinguishable from final ones. Nothing about that
 * needed new vocabulary; the field was simply never read.
 *
 * `clinical:status` is the predicate used, because:
 *
 *   - It is already how this repo spells FHIR `.status` — `convertMedicationStatement`
 *     writes it, and `restoreMedicationRecord` reads it back.
 *   - It declares NO `rdfs:domain`, so it makes no claim about the class of the
 *     subject it sits on. Its definition says in as many words that permitted
 *     values depend on the record class and are constrained per-shape, which is
 *     also exactly how FHIR treats `.status`.
 *   - It gives a reader ONE predicate to ask for. `clinical:observationStatus`
 *     exists and names this value set precisely, but it carries
 *     `rdfs:domain clinical:LabResult`, which is false for a vital sign — and
 *     `convertObservationVital` re-routes non-canonical vitals into
 *     `convertObservationLab`, so a per-branch predicate would mean the same
 *     source element landing under two different names depending on a routing
 *     table.
 *
 * Deliberately NOT covered here: `Coverage.status`. See `convertCoverage`.
 */
const STATUS_PREDICATE = NS.clinical + 'status';

// ---------------------------------------------------------------------------
// Medication converter
// ---------------------------------------------------------------------------

/**
 * The first FHIR `Dosage` element a medication resource carries, under either of
 * the two field names R4 gives it.
 *
 * `MedicationStatement.dosage` and `MedicationRequest.dosageInstruction` are
 * both `Dosage 0..*` — the same datatype, the same `text`/`route`/`timing`
 * children. They differ only in the name of the field that holds them, and a
 * reader that knows one name sees no dose on half the medication resources that
 * exist.
 *
 * `dosage` is preferred when a resource somehow carries both, since only
 * MedicationStatement declares it and that is then the resource's own field.
 *
 * @see https://hl7.org/fhir/R4/medicationstatement-definitions.html#MedicationStatement.dosage
 * @see https://hl7.org/fhir/R4/medicationrequest-definitions.html#MedicationRequest.dosageInstruction
 */
function firstDosageElement(resource: any): any | undefined {
  const stated = Array.isArray(resource?.dosage) ? resource.dosage[0] : undefined;
  if (stated) return stated;
  return Array.isArray(resource?.dosageInstruction) ? resource.dosageInstruction[0] : undefined;
}

export function convertMedicationStatement(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const patientRef = resource.subject?.reference ?? resource.patient?.reference ?? '';

  // The DISPLAY name and the IDENTITY name are deliberately two different
  // values, and conflating them was a silent record-merging bug.
  //
  // `medName` is what the record says on screen, so a placeholder is the right
  // answer when the source names no drug. `identityMedName` is an input to the
  // subject IRI, where a placeholder is never the right answer: it converts
  // "we do not know what drug this is" into "these are the same drug". Measured
  // before this split, with the placeholder feeding both: a bare
  // `{resourceType:'MedicationStatement'}` and one carrying a distinct `note`
  // minted ONE IRI, with no warning — because the content tier "succeeded" with
  // a constant identical for every content-free medication, so the identity
  // door's tier-4 collapse notice could never fire. A content hash that
  // succeeds with a constant is indistinguishable from one that fails, except
  // that it merges records instead of splitting them.
  //
  // Leaving the field `undefined` instead hands the decision back to the
  // identity door, which falls through to the RxNorm code, the start date, the
  // patient, then the resource's own content, and finally collapses LOUDLY.
  const identityMedName = codeableConceptText(resource.medicationCodeableConcept)
    ?? resource.medicationReference?.display;
  const medName = identityMedName ?? 'Unknown Medication';

  const subjectUri = medicationUri({
    patient: patientRef,
    rxNormCode: resource.medicationCodeableConcept?.coding?.find((c: any) => c.system?.includes('rxnorm'))?.code,
    medicationName: identityMedName,
    startDate: (resource.authoredOn ?? resource.effectivePeriod?.start)?.split('T')[0],
  }, resource.id, resource, warnings, resource.resourceType);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'Medication'));
  quads.push(...commonTriples(subjectUri));

  quads.push(tripleStr(subjectUri, NS.clinical + 'drugName', medName));

  // Status from FHIR status field
  const status = resource.status as string | undefined;
  if (status) quads.push(tripleStr(subjectUri, NS.clinical + 'status', status));

  // Drug codes
  const codings = extractCodings(resource.medicationCodeableConcept);
  for (const coding of codings) {
    const nsUri = CODING_SYSTEM_MAP[coding.system];
    if (nsUri) {
      quads.push(tripleRef(subjectUri, NS.clinical + 'drugCode', nsUri + coding.code));
      if (nsUri === NS.rxnorm) {
        quads.push(tripleRef(subjectUri, NS.clinical + 'rxNormCode', nsUri + coding.code));
      }
    } else {
      warnings.push(`Unknown coding system: ${coding.system} (code ${coding.code})`);
    }
  }

  // Dosage.
  //
  // ONE Dosage element, under two field names. FHIR R4 gives
  // MedicationStatement a `dosage` array and MedicationRequest a
  // `dosageInstruction` array; both are the same `Dosage` datatype with the same
  // `text`, `route` and `timing`. Reading only `dosage` meant a prescription's
  // dose was dropped in silence, and the loss did not stop at the missing
  // triple: dose is deliberately stripped out of the medication identity key, so
  // "sertraline 50 mg" and "sertraline 100 mg" match as one drug and the dose
  // check is what is supposed to raise the disagreement. With both doses absent
  // that check compared two undefineds, found nothing to disagree about, and
  // merged a dose change away with no conflict — while the identical
  // disagreement expressed as a MedicationStatement raised its conflict
  // correctly. Which of the two ordinary FHIR shapes the source happened to use
  // decided whether a dose change survived the import.
  const dosage = firstDosageElement(resource);
  if (dosage) {
    if (dosage.text) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'dosage', dosage.text));
    }
    if (dosage.route?.text) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'route', dosage.route.text));
    } else if (dosage.route?.coding?.[0]?.display) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'route', dosage.route.coding[0].display));
    }
    if (dosage.timing?.repeat?.frequency) {
      const freq = dosage.timing.repeat.frequency;
      const periodUnit = dosage.timing.repeat.periodUnit ?? 'd';
      const unitLabel = periodUnit === 'd' ? 'daily' : periodUnit === 'wk' ? 'weekly' : periodUnit;
      const freqText = freq === 1 ? `once ${unitLabel}` : `${freq} times ${unitLabel}`;
      quads.push(tripleStr(subjectUri, NS.clinical + 'frequency', freqText));
    }
  }

  // Effective period, and the order date when there is no effective period.
  //
  // `authoredOn` was already treated as this record's date where it counted most
  // — it is the FIRST input to the subject IRI, ten lines up — and was never
  // written as a triple. A MedicationRequest carrying `authoredOn` and no
  // effective date is the ordinary shape of a prescription order, so the
  // ordinary prescription imported with NO date predicate: undated in every
  // consumer, invisible to anything that places records in time, and keyed on a
  // date the record did not state.
  //
  // The fallback ORDER here is deliberately not the identity order. Identity
  // takes `authoredOn` first because the date an order was written is the value
  // that survives a re-export unchanged, and reordering it would re-mint every
  // medication in every existing pod. The triple takes it LAST because an
  // effective period is when the patient took the drug, while `authoredOn` is
  // when a clinician typed it — preferring the typing date over a stated period
  // would be a downgrade. Two orders, two different questions.
  if (resource.effectivePeriod?.start) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'startDate', resource.effectivePeriod.start));
  } else if (resource.effectiveDateTime) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'startDate', resource.effectiveDateTime));
  } else if (resource.authoredOn) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'startDate', resource.authoredOn));
  }
  if (resource.effectivePeriod?.end) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'endDate', resource.effectivePeriod.end));
  }

  // Provenance class -- based on resource type
  const fhirResourceType = resource.resourceType as string;
  if (fhirResourceType === 'MedicationStatement') {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceFhirResourceType', 'MedicationStatement'));
    quads.push(tripleStr(subjectUri, NS.clinical + 'clinicalIntent', 'reportedUse'));
  } else if (fhirResourceType === 'MedicationRequest') {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceFhirResourceType', 'MedicationRequest'));
    quads.push(tripleStr(subjectUri, NS.clinical + 'clinicalIntent', 'prescribed'));
  }
  quads.push(tripleStr(subjectUri, NS.clinical + 'provenanceClass', 'imported'));

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  if (resource.note && Array.isArray(resource.note)) {
    const noteText = resource.note.map((n: any) => n.text).filter(Boolean).join('; ');
    if (noteText) quads.push(tripleStr(subjectUri, NS.health + 'notes', noteText));
  }

  // Cross-record edges (resolved/dropped at end of batch): the visit this
  // medication belongs to (MedicationRequest.encounter) and the condition(s) it
  // was prescribed for (reasonReference). The coded reasonCode is captured as a
  // retained clinical:indication literal plus a parsed-indication candidate
  // (M1); it was dropped entirely before.
  pushEncounterEdge(quads, subjectUri, resource.encounter);
  pushIndicationEdges(quads, subjectUri, resource.reasonReference);
  pushParsedIndicationCandidates(quads, subjectUri, resource.reasonCode);

  return {
    turtle: '',
    warnings,
    resourceType: fhirResourceType,
    cascadeType: 'clinical:Medication',
    jsonld: quadsToJsonLd(quads, 'clinical:Medication'),
    _quads: quads,
  } as ConversionResult & { _quads: Quad[] };
}

// ---------------------------------------------------------------------------
// Condition converter
// ---------------------------------------------------------------------------

/**
 * The subject IRI for a Condition.
 *
 * WHY THIS IS NO LONGER
 * `contentHashedUri('Condition', {patient, snomedCode, icd10Code, onsetDate}, resource.id)`
 * -----------------------------------------------------------------------------------------
 * Two separate defects, the same pair the lab converter had:
 *
 *   1. The `resource.id` was passed as `fallbackId`, which `contentHashedUri`
 *      consults only when every content field is empty — never true of a real
 *      Condition. Measured: the same problem carrying id `server-id-A` and id
 *      `server-id-B` minted ONE IRI. See {@link idOrContentUri}.
 *
 *   2. The key was a strict subset of the record. Only two of the codings were
 *      read (SNOMED and ICD), by substring match on the system URL, so a
 *      Condition coded in any other system — or in `code.text` alone, which is
 *      ordinary in portal exports — contributed NOTHING to its own identity and
 *      merged with every other such Condition for that patient. And onset was
 *      truncated to a calendar day.
 *
 * THE PART WORTH READING BEFORE CALLING THIS HARMLESS
 * --------------------------------------------------
 * This was originally judged low severity on the grounds that the merged pairs
 * "really are the same clinical fact, and no data is lost". That is half right,
 * and the wrong half is the dangerous one: the IDENTITY fields agreed, but the
 * NON-identity fields did not have to. Two Conditions sharing patient, code and
 * onset can disagree on `clinicalStatus` and `verificationStatus` — one saying
 * ACTIVE and CONFIRMED, the other RESOLVED and REFUTED — and under the old key
 * they merged, with the winner decided by which file was read first. That is
 * the glucose bug wearing different clothes.
 *
 * What kept it from being an emergency is not that the merges were harmless: it
 * is that a differing-content collision is now SPLIT and raised as a conflict
 * rather than silently overwritten. Visible, not safe.
 *
 * WITHOUT AN ID the key carries everything that can make two Conditions for one
 * patient genuinely different records: the full code (all codings, plus text),
 * onset AT FULL PRECISION, abatement, both status fields, the category, and the
 * encounter it was recorded at.
 *
 * `conditionName` is deliberately NOT a key field: the converter defaults it to
 * the literal 'Unknown Condition', and a placeholder default in an identity key
 * is a content hash that succeeds with a constant. `codeableConceptKey` reads
 * the raw concept instead, and yields `undefined` where the placeholder would
 * have appeared.
 *
 * `recordedDate` is also deliberately excluded. It says when a system wrote the
 * record down, not what the record says, and it differs between two systems
 * holding the same problem — so keying on it would split a genuine duplicate
 * rather than separate two different problems.
 *
 * THE COMPLETENESS RULE THESE KEYS ARE BUILT TO, AND ITS LIMIT
 * -----------------------------------------------------------
 * A curated key is narrower than the record on purpose, so "which fields" is a
 * judgement rather than a formula. The one it is held to here: EVERY FIELD THE
 * CONVERTER SERIALIZES IS EITHER IN THE KEY OR EXCLUDED IN WRITING ABOVE.
 * Anything else is a field on which two records sharing an IRI can disagree,
 * which is the lab defect restated — and it is not hypothetical drafting
 * caution: writing this key without `note` left two id-less Conditions reading
 * "Provisional" and "Ruled out" on one IRI, and only the mechanical audit in
 * `clinical-identity.test.ts` found it. That test walks every serialized field
 * of all four types and fails on the next one anybody forgets.
 */
function conditionSubjectUri(resource: any, warnings: string[]): string {
  return idOrContentUri('Condition', resource, {
    patient: resource?.subject?.reference,
    code: codeableConceptKey(resource?.code),
    // Full precision. `.split('T')[0]` merged two problems recorded hours apart.
    onset: resource?.onsetDateTime
      ?? resource?.onsetPeriod?.start
      ?? resource?.onsetString
      ?? structuredKey(resource?.onsetAge ?? resource?.onsetRange),
    abatement: resource?.abatementDateTime
      ?? resource?.abatementPeriod?.start
      ?? resource?.abatementString
      ?? (resource?.abatementBoolean !== undefined ? String(resource.abatementBoolean) : undefined)
      ?? structuredKey(resource?.abatementAge ?? resource?.abatementRange),
    // "active" and "resolved" are two different claims about a patient.
    clinicalStatus: codeableConceptKey(resource?.clinicalStatus),
    // "confirmed" and "refuted" are opposite claims. This converter does not
    // serialize it yet, so today two records differing only here produce
    // identical quads — but identity must describe the SOURCE record, not the
    // subset this converter happens to write, or adding a field to the
    // serializer later silently changes which records merge.
    verificationStatus: codeableConceptKey(resource?.verificationStatus),
    category: codeableConceptSetKey(resource?.category),
    // An encounter-diagnosis recorded at each of two visits is two records.
    encounter: resource?.encounter?.reference,
    // See the note on completeness below: `note` is serialized as health:notes,
    // so two Conditions differing only in it are two DIFFERENT records in the
    // pod, and an identity that cannot see it merges them.
    note: structuredKey(resource?.note),
  }, warnings);
}

export function convertCondition(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = conditionSubjectUri(resource, warnings);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.health + 'ConditionRecord'));
  quads.push(...commonTriples(subjectUri));

  const condName = codeableConceptText(resource.code) ?? 'Unknown Condition';
  quads.push(tripleStr(subjectUri, NS.health + 'conditionName', condName));

  // FHIR Condition.category — e.g. problem-list-item, encounter-diagnosis, social-history
  const fhirCategory = resource.category?.[0]?.coding?.[0]?.code ?? resource.category?.[0]?.text;
  if (fhirCategory) {
    quads.push(tripleStr(subjectUri, NS.health + 'conditionCategory', fhirCategory));
  }

  // SNOMED semantic tag — the parenthetical type suffix in the display name, e.g. "(disorder)",
  // "(finding)", "(situation)". Lets downstream tools distinguish clinical from administrative records
  // without a full SNOMED hierarchy lookup.
  const semanticTagMatch = condName.match(/\(([^)]+)\)$/);
  if (semanticTagMatch) {
    quads.push(tripleStr(subjectUri, NS.health + 'snomedSemanticTag', semanticTagMatch[1]));
  }

  // Condition.clinicalStatus — active | recurrence | relapse | inactive |
  // remission | resolved.
  //
  // NO DEFAULT. This read `?? 'active'`, so a problem list whose entries state
  // no clinical status arrived as a list of ACTIVE problems — the pod asserting
  // a person still has every condition anyone ever recorded for them.
  //
  // Omitting is safe against the shape: `health:ConditionRecordShape` constrains
  // `health:status` with `sh:maxCount 1` and an `sh:in` value set, and asserts
  // no `sh:minCount` — checked before this line changed.
  //
  // No IRI moves: `conditionSubjectUri` keys
  // `codeableConceptKey(resource?.clinicalStatus)`, the raw element, so identity
  // never saw the default.
  const clinicalStatus = resource.clinicalStatus?.coding?.[0]?.code;
  if (clinicalStatus) {
    quads.push(tripleStr(subjectUri, NS.health + 'status', clinicalStatus));
  }

  // Condition.verificationStatus — `confirmed` and `refuted` are OPPOSITE claims
  // about whether the patient has the problem at all, and the pod stated neither.
  // `clinical:verificationStatus` is the only predicate in the vocabulary for it,
  // it is bound by clinical:ConditionShape to exactly this FHIR R4 value set, and
  // its rdfs:domain (clinical:Condition) is the deprecated spelling of the class
  // this converter emits — health.ttl's namespace-boundary note states the two
  // are one record under two names, so nothing is asserted here that is not true.
  //
  // This field is ALREADY in `conditionSubjectUri`, deliberately and with a
  // comment anticipating this exact change, so no IRI moves.
  const verificationStatus = resource.verificationStatus?.coding?.[0]?.code;
  if (verificationStatus) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'verificationStatus', verificationStatus));
  }

  if (resource.onsetDateTime) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'onsetDate', resource.onsetDateTime));
  } else if (resource.onsetPeriod?.start) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'onsetDate', resource.onsetPeriod.start));
  }

  if (resource.abatementDateTime) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'abatementDate', resource.abatementDateTime));
  }

  const codings = extractCodings(resource.code);
  for (const coding of codings) {
    const nsUri = CODING_SYSTEM_MAP[coding.system];
    if (nsUri === NS.icd10) {
      quads.push(tripleRef(subjectUri, NS.health + 'icd10Code', nsUri + coding.code));
    } else if (nsUri === NS.sct) {
      quads.push(tripleRef(subjectUri, NS.health + 'snomedCode', nsUri + coding.code));
    } else if (nsUri) {
      warnings.push(`Condition code from non-standard system: ${coding.system}`);
    }
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  if (resource.note && Array.isArray(resource.note)) {
    const noteText = resource.note.map((n: any) => n.text).filter(Boolean).join('; ');
    if (noteText) quads.push(tripleStr(subjectUri, NS.health + 'notes', noteText));
  }

  // The visit this condition was recorded in (Condition.encounter).
  pushEncounterEdge(quads, subjectUri, resource.encounter);

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'health:ConditionRecord'),
    warnings,
    resourceType: 'Condition',
    cascadeType: 'health:ConditionRecord',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// AllergyIntolerance converter
// ---------------------------------------------------------------------------

/**
 * The subject IRI for an AllergyIntolerance.
 *
 * WHY THIS IS NO LONGER
 * `contentHashedUri('AllergyIntolerance', {patient, allergenCode, allergenName}, resource.id)`
 * ---------------------------------------------------------------------------------------------
 * Same two defects as Condition, plus a third the shape of the key made worse:
 *
 *   1. `resource.id` was dead as a `fallbackId`. Measured: the same allergen
 *      carrying id `server-id-A` and id `server-id-B` minted ONE IRI.
 *
 *   2. `allergenCode` read `code.coding[0].code` — the FIRST coding, WITHOUT its
 *      system. Two different code systems that reuse the same digits therefore
 *      collided outright, and a resource whose first coding is the local EHR's
 *      own numbering keyed on that rather than on the RxNorm or SNOMED code
 *      sitting beside it.
 *
 *   3. The key held NOTHING about the reaction. A "mild rash on penicillin" and
 *      an "anaphylaxis on penicillin" merged, and which of the two survived was
 *      decided by input order. An allergy record's severity is the part a
 *      clinician acts on, so this is the merge with the sharpest consequence in
 *      this file: it can report a life-threatening allergy as mild.
 *
 * WITHOUT AN ID the key carries the full code, both status fields, the type
 * (allergy vs intolerance), the category, the criticality, the onset, and a
 * fingerprint of the whole `reaction` array — manifestations, severity,
 * substance and all.
 *
 * `allergen` (the serialized display value) is NOT a key field: it defaults to
 * the literal 'Unknown Allergen'.
 */
function allergySubjectUri(resource: any, warnings: string[]): string {
  return idOrContentUri('AllergyIntolerance', resource, {
    patient: resource?.patient?.reference,
    code: codeableConceptKey(resource?.code),
    clinicalStatus: codeableConceptKey(resource?.clinicalStatus),
    verificationStatus: codeableConceptKey(resource?.verificationStatus),
    type: typeof resource?.type === 'string' ? resource.type : codeableConceptKey(resource?.type),
    category: codeableConceptSetKey(resource?.category),
    criticality: resource?.criticality,
    onset: resource?.onsetDateTime
      ?? resource?.onsetPeriod?.start
      ?? resource?.onsetString
      ?? structuredKey(resource?.onsetAge ?? resource?.onsetRange),
    // The whole array, fingerprinted: manifestation, severity, substance,
    // exposure route and description. A key that omitted these merged a mild
    // rash into an anaphylaxis.
    reaction: structuredKey(resource?.reaction),
    // Serialized as health:notes; see the completeness rule on `conditionSubjectUri`.
    note: structuredKey(resource?.note),
  }, warnings);
}

export function convertAllergyIntolerance(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = allergySubjectUri(resource, warnings);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.health + 'AllergyRecord'));
  quads.push(...commonTriples(subjectUri));

  const allergen = codeableConceptText(resource.code) ?? 'Unknown Allergen';
  quads.push(tripleStr(subjectUri, NS.health + 'allergen', allergen));

  // AllergyIntolerance.clinicalStatus — active | inactive | resolved. A resolved
  // penicillin allergy displayed as an active one changes what a clinician
  // prescribes, so this is a correctness field, not colour.
  //
  // `health:status` is NOT used: its rdfs:domain is a deliberately enumerated
  // union of ConditionRecord and ImmunizationRecord, and health.ttl says in the
  // same release note that a domain the data falsifies is the defect it was
  // correcting. `clinical:clinicalStatus` is domain-restricted to Condition,
  // which an allergy is not. `clinical:status` declares no domain — see
  // STATUS_PREDICATE.
  //
  // Already inside `allergySubjectUri`, so no IRI moves.
  const allergyClinicalStatus = resource.clinicalStatus?.coding?.[0]?.code;
  if (allergyClinicalStatus) {
    quads.push(tripleStr(subjectUri, STATUS_PREDICATE, allergyClinicalStatus));
  }

  // AllergyIntolerance.verificationStatus — confirmed | unconfirmed | presumed |
  // refuted | entered-in-error. `confirmed` and `refuted` are OPPOSITE claims
  // about whether the patient is allergic at all, and the pod stated neither, so
  // a refuted allergy narrowed treatment exactly as a confirmed one would.
  //
  // `clinical:verificationStatus` is the same predicate `convertCondition`
  // writes this FHIR element on. Its `sh:in` binding lives on
  // `clinical:ConditionShape`, which targets `clinical:Condition` and therefore
  // does not reach a `health:AllergyRecord`; nothing in the shape set is
  // `sh:closed`, so the triple validates. The allergy value set includes
  // `presumed`, which Condition's does not, and nothing constrains it here.
  //
  // Already inside `allergySubjectUri`, so no IRI moves.
  const allergyVerificationStatus = resource.verificationStatus?.coding?.[0]?.code;
  if (allergyVerificationStatus) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'verificationStatus', allergyVerificationStatus));
  }

  if (Array.isArray(resource.category) && resource.category.length > 0) {
    quads.push(tripleStr(subjectUri, NS.health + 'allergyCategory', resource.category[0]));
  }

  if (Array.isArray(resource.reaction) && resource.reaction.length > 0) {
    const manifestations = resource.reaction
      .flatMap((r: any) => r.manifestation ?? [])
      .map((m: any) => codeableConceptText(m))
      .filter(Boolean);
    if (manifestations.length > 0) {
      quads.push(tripleStr(subjectUri, NS.health + 'reaction', manifestations.join(', ')));
    }
    const severity = resource.reaction[0]?.severity;
    if (severity) {
      const severityMap: Record<string, string> = { mild: 'mild', moderate: 'moderate', severe: 'severe' };
      quads.push(tripleStr(subjectUri, NS.health + 'allergySeverity', severityMap[severity] ?? severity));
    }
  }

  if (resource.criticality && !(Array.isArray(resource.reaction) && resource.reaction[0]?.severity)) {
    const critMap: Record<string, string> = { low: 'mild', high: 'severe', 'unable-to-assess': 'moderate' };
    quads.push(tripleStr(subjectUri, NS.health + 'allergySeverity', critMap[resource.criticality] ?? resource.criticality));
  }

  if (resource.onsetDateTime) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'onsetDate', resource.onsetDateTime));
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  if (resource.note && Array.isArray(resource.note)) {
    const noteText = resource.note.map((n: any) => n.text).filter(Boolean).join('; ');
    if (noteText) quads.push(tripleStr(subjectUri, NS.health + 'notes', noteText));
  }

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'health:AllergyRecord'),
    warnings,
    resourceType: 'AllergyIntolerance',
    cascadeType: 'health:AllergyRecord',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// Observation: vital sign detection
// ---------------------------------------------------------------------------

export function isVitalSignObservation(resource: any): boolean {
  if (Array.isArray(resource.category)) {
    for (const cat of resource.category) {
      // Structured coding check
      if (Array.isArray(cat.coding)) {
        for (const c of cat.coding) {
          if (VITAL_CATEGORIES.includes(c.code)) return true;
        }
      }
      // Text fallback — some systems only populate category.text
      if (typeof cat.text === 'string' && /vital/i.test(cat.text)) return true;
    }
  }
  // LOINC code fallback — catches observations with no/wrong category
  // Accepts all known LOINC system URL variants (http, https, OID, trailing slash)
  const codings = extractCodings(resource.code);
  for (const c of codings) {
    if (isLoincSystem(c.system) && VITAL_LOINC_CODES[c.code]) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Observation (lab) converter
// ---------------------------------------------------------------------------

/**
 * The FHIR `value[x]` choice element prefix. Every measured result a lab
 * Observation can carry is spelled `value` + a type name.
 */
const VALUE_X_PREFIX = 'value';

/**
 * A stable token standing for THE MEASURED RESULT of a lab Observation, or
 * `undefined` when the resource carries no result at all.
 *
 * Collected by PREFIX rather than from a hand-written list of the `value[x]`
 * forms this converter happens to serialize today. A list would have to be kept
 * in step with FHIR forever, and the failure mode of missing one is not a
 * dropped display value — it is two genuinely different results sharing an
 * identity. `component` is included because a panel-style Observation carries
 * its readings there instead.
 *
 * Reduced to a fingerprint rather than embedded raw so that the identity string
 * stays a fixed length regardless of how many components a panel has, and so
 * that a free-text `valueString` cannot smuggle the `|` and `=` characters that
 * `contentHashedUri` uses as its own field separators into the key. That is
 * `structuredKey`, now shared with the four sibling converters.
 */
function labMeasuredValueKey(resource: any): string | undefined {
  if (resource == null || typeof resource !== 'object') return undefined;
  const measured: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resource)) {
    if (value === undefined || value === null) continue;
    if (key === 'component' || (key.startsWith(VALUE_X_PREFIX) && key.length > VALUE_X_PREFIX.length)) {
      measured[key] = value;
    }
  }
  if (Object.keys(measured).length === 0) return undefined;
  return structuredKey(measured);
}

/**
 * The Observation's category codes, or `undefined` when it carries none.
 *
 * Sorted, because `Observation.category` is a set rather than an ordered list
 * and two servers may enumerate the same categories in different order. Sorting
 * therefore removes a source of spurious SPLITS; it can never cause a merge,
 * since a differing set still sorts to a differing string.
 *
 * Deduplicated as well, since core v3.6: a repeated category is the same claim
 * twice and must not split the record from one that states it once. The
 * canonical form is shared with the other set-valued key builders rather than
 * respelled here. Separator stays ',' — the one this site already shipped.
 */
function labCategoryKey(resource: any): string | undefined {
  if (!Array.isArray(resource?.category)) return undefined;
  const parts: string[] = [];
  for (const cat of resource.category) {
    if (Array.isArray(cat?.coding)) {
      for (const c of cat.coding) {
        if (c?.code) parts.push(`${c.system ?? ''}#${c.code}`);
      }
    }
    if (typeof cat?.text === 'string' && cat.text.trim().length > 0) parts.push(cat.text.trim());
  }
  return canonicalSetKey(parts, ',');
}

/**
 * The subject IRI for a lab Observation.
 *
 * WHY THIS IS NO LONGER `contentHashedUri('Observation', {patient, loincCode, date}, resource.id)`
 * ------------------------------------------------------------------------------------------------
 * That key set was a strict subset of the record. The MEASURED VALUE was not in
 * it; the timestamp was truncated to a calendar day by `.split('T')[0]`; and the
 * record's own server-assigned `id` was passed as `fallbackId`, which
 * `contentHashedUri` consults ONLY when every content field is empty — which
 * never happens on a real lab. So the id was discarded and identity was
 * `{patient, LOINC, calendar day}`.
 *
 * Measured consequence: a fasting glucose of 95 (`id "obs-fasting-95"`) and a
 * post-prandial glucose of 310 (`id "obs-postprandial-310"`) drawn the same
 * morning minted ONE IRI. The reconciler then passed over the second as a
 * re-import of the first, and WHICH value survived was decided by the order the
 * input files enumerated. Serial same-day labs are routine clinical practice —
 * glucose curves, troponin series, repeat potassium, pre/post dialysis — so
 * this fired on ordinary EHR output, not on exotic input.
 *
 * THE RULE: A PRESENT `id` WINS.
 * -----------------------------
 * Identity answers "is this that record?". Two records that are the same
 * *thing* may well need merging, but that is a different judgement, it needs a
 * conflict trail, and it belongs to the reconciler — which can see both
 * records, where the identity layer sees one at a time and can only silently
 * overwrite. Honouring the id makes the collision structurally impossible.
 *
 * It is also what `convertObservationVital` has always done via
 * `mintSubjectUri`, which is why same-day repeat VITALS survived as distinct
 * records in a real 1,150-subject pod while same-day repeat LABS did not. The
 * two Observation converters in this file no longer use opposite strategies, so
 * an Observation rerouted from the vital converter to this one (see
 * `VITAL_TYPE_TO_SHACL`) keeps the same IRI either way.
 *
 * WITHOUT AN ID, the key carries what actually tells two results apart:
 * patient, LOINC code, the effective instant AT FULL PRECISION, the measured
 * value in every `value[x]` form, the specimen, and the category.
 *
 * `testName` is deliberately NOT a key field. The converter defaults it to the
 * literal 'Unknown Lab Test', and a placeholder default in an identity key is
 * the same defect in a different costume.
 *
 * The two-tier gate itself now lives in {@link idOrContentUri}, shared with
 * Condition, AllergyIntolerance, Immunization and Patient. It was written here
 * first, and having one copy per converter is how the rule ends up applied in
 * some of them and not others — which is precisely what happened: this
 * converter was fixed while four siblings kept the dead-`fallbackId` shape. The
 * IRIs are unchanged by the move; the lab suites pin that.
 */
function labSubjectUri(resource: any, warnings: string[]): string {
  return idOrContentUri('Observation', resource, {
    patient: resource?.subject?.reference,
    loincCode: resource?.code?.coding?.find((c: any) => c.system?.includes('loinc'))?.code,
    // Full precision. `.split('T')[0]` merged a 07:00 draw with an 11:00 draw.
    effective: resource?.effectiveDateTime ?? resource?.effectivePeriod?.start,
    value: labMeasuredValueKey(resource),
    specimen: resource?.specimen?.reference,
    category: labCategoryKey(resource),
    // Serialized as clinical:status, so it is inside the key: see the
    // completeness rule on `conditionSubjectUri`. A `final` result and an
    // `amended` one are two different assertions about the same draw, and an
    // id-less pair differing only here would otherwise share an IRI and let
    // read order decide which the pod ends up stating. Raw, like the
    // immunization key: no `?? 'final'`, so an absent status stays absent
    // rather than arriving as a constant.
    status: resource?.status,
  }, warnings);
}

export function convertObservationLab(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = labSubjectUri(resource, warnings);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.health + 'LabResultRecord'));
  quads.push(...commonTriples(subjectUri));

  const testName = codeableConceptText(resource.code) ?? 'Unknown Lab Test';
  quads.push(tripleStr(subjectUri, NS.health + 'testName', testName));

  // Observation.status — see STATUS_PREDICATE. Emitted raw and only when the
  // source stated it; a defaulted status would assert `final` about a record
  // whose server never said so.
  if (resource.status) {
    quads.push(tripleStr(subjectUri, STATUS_PREDICATE, resource.status));
  }

  if (resource.valueQuantity) {
    quads.push(tripleStr(subjectUri, NS.health + 'resultValue', String(resource.valueQuantity.value)));
    if (resource.valueQuantity.unit) {
      quads.push(tripleStr(subjectUri, NS.health + 'resultUnit', resource.valueQuantity.unit));
    }
  } else if (resource.valueString) {
    quads.push(tripleStr(subjectUri, NS.health + 'resultValue', resource.valueString));
  } else if (resource.valueCodeableConcept) {
    const valText = codeableConceptText(resource.valueCodeableConcept) ?? '';
    quads.push(tripleStr(subjectUri, NS.health + 'resultValue', valText));
  } else if (Array.isArray(resource.component) && resource.component.length > 0) {
    // Panel-style observation (e.g., PRAPARE survey, multi-question assessments):
    // serialize component question/answer pairs into a single resultValue string.
    const parts: string[] = [];
    for (const comp of resource.component) {
      const question = codeableConceptText(comp.code);
      if (!question) continue;
      const answer =
        (comp.valueCodeableConcept ? codeableConceptText(comp.valueCodeableConcept) : undefined) ??
        comp.valueString ??
        (comp.valueQuantity !== undefined ? `${comp.valueQuantity.value} ${comp.valueQuantity.unit ?? ''}`.trim() : undefined);
      if (answer !== undefined) {
        parts.push(`${question}: ${answer}`);
      }
    }
    if (parts.length > 0) {
      quads.push(tripleStr(subjectUri, NS.health + 'resultValue', parts.join('; ')));
    } else {
      quads.push(tripleStr(subjectUri, NS.health + 'resultValue', ''));
      warnings.push('No result value found in Observation resource');
    }
  } else {
    quads.push(tripleStr(subjectUri, NS.health + 'resultValue', ''));
    warnings.push('No result value found in Observation resource');
  }

  // The source's own ObservationInterpretation code, carried through. health v2.6
  // binds health:interpretation to that code system, so there is nothing left to
  // translate and no reason to collapse H and L onto one word. See
  // `interpretation.ts` for what the accepted set is and what happens outside it.
  const interpretation = interpretationValue(resource.interpretation, warnings);
  if (interpretation !== undefined) {
    quads.push(tripleStr(subjectUri, NS.health + 'interpretation', interpretation));
  }

  const effectiveDate = resource.effectiveDateTime ?? resource.effectivePeriod?.start ?? resource.issued;
  if (effectiveDate) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'performedDate', effectiveDate));
  } else {
    warnings.push('No effective date found in Observation resource');
  }

  const codings = extractCodings(resource.code);
  for (const c of codings) {
    if (c.system === 'http://loinc.org') {
      quads.push(tripleRef(subjectUri, NS.health + 'testCode', NS.loinc + c.code));
    }
  }

  // EVERY category the source stated, `laboratory` included.
  //
  // `laboratory` used to be filtered out on the reading that it is implied by the
  // record's type. It is not: it is a value FHIR R4 asks the server to state, and
  // the record it identifies is exactly the one that needs it. An Observation
  // categorised BOTH laboratory and procedure therefore reached the pod carrying
  // `labCategory "procedure"` alone — the category that DECIDED the routing was
  // the one dropped, so a pod filtered by labCategory omitted a record filed as a
  // lab. health:labCategory is repeatable as of health v2.6 (sh:maxCount removed,
  // mirroring Observation.category 0..*), so there is nothing left to choose
  // between.
  if (Array.isArray(resource.category)) {
    for (const cat of resource.category) {
      if (Array.isArray(cat.coding)) {
        for (const c of cat.coding) {
          if (c.code) {
            quads.push(tripleStr(subjectUri, NS.health + 'labCategory', c.code));
          }
        }
      }
      if (cat.text) {
        quads.push(tripleStr(subjectUri, NS.health + 'labCategory', cat.text));
      }
    }
  }

  if (Array.isArray(resource.referenceRange) && resource.referenceRange.length > 0) {
    const rr = resource.referenceRange[0];
    const parts: string[] = [];
    if (rr.low?.value !== undefined) parts.push(String(rr.low.value));
    if (rr.high?.value !== undefined) parts.push(String(rr.high.value));
    const unit = rr.low?.unit ?? rr.high?.unit ?? '';
    if (parts.length === 2) {
      quads.push(tripleStr(subjectUri, NS.health + 'referenceRange', `${parts[0]}-${parts[1]} ${unit}`.trim()));
    } else if (rr.text) {
      quads.push(tripleStr(subjectUri, NS.health + 'referenceRange', rr.text));
    }
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  // The visit this lab result was collected in (Observation.encounter).
  pushEncounterEdge(quads, subjectUri, resource.encounter);

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'health:LabResultRecord'),
    warnings,
    resourceType: 'Observation',
    cascadeType: 'health:LabResultRecord',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// Observation (vital sign) converter
// ---------------------------------------------------------------------------

/**
 * Maps the converter's internal vital `type` (from VITAL_LOINC_CODES) to a
 * clinical:vitalType value the VitalSignShape's sh:in enum actually accepts.
 * The enum is intentionally narrow (the canonical clinical vital signs), so any
 * VITAL_LOINC_CODES type not listed here (e.g. body surface area, mean blood
 * pressure, head circumference, percentiles, intraocular pressure) is NOT a
 * VitalSign per the shape and is routed to the lab/observation converter so its
 * value is still preserved ("Cascade does not drop data").
 */
const VITAL_TYPE_TO_SHACL: Record<string, string> = {
  heartRate: 'heartRate',
  bloodPressurePanel: 'bloodPressure',
  bloodPressureSystolic: 'bloodPressureSystolic',
  bloodPressureDiastolic: 'bloodPressureDiastolic',
  respiratoryRate: 'respiratoryRate',
  bodyTemperature: 'temperature',
  bodyTemperatureOral: 'temperature',
  oxygenSaturation: 'oxygenSaturation',
  bodyWeight: 'bodyWeight',
  bodyHeight: 'bodyHeight',
  bmi: 'bodyMassIndex',
};

export function convertObservationVital(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource, warnings);
  const quads: Quad[] = [];

  const codings = extractCodings(resource.code);
  let vitalInfo: { type: string; name: string; unit: string; snomedCode: string } | undefined;
  let loincCode: string | undefined;
  for (const c of codings) {
    if (isLoincSystem(c.system) && VITAL_LOINC_CODES[c.code]) {
      vitalInfo = VITAL_LOINC_CODES[c.code];
      loincCode = c.code;
      break;
    }
  }

  // Resolve a clinical:vitalType the VitalSignShape enum accepts. If we cannot
  // (no LOINC match, or a LOINC vital type outside the shape's canonical enum
  // such as body surface area / mean BP / percentiles), this is not a VitalSign
  // per the shape: route it to the lab/observation converter, which preserves
  // every value form (valueQuantity, valueString, valueCodeableConcept,
  // components) without dropping data.
  const shaclVitalType = vitalInfo ? VITAL_TYPE_TO_SHACL[vitalInfo.type] : undefined;
  if (!shaclVitalType) {
    return convertObservationLab(resource);
  }

  quads.push(tripleType(subjectUri, NS.clinical + 'VitalSign'));
  quads.push(...commonTriples(subjectUri));
  if (loincCode) {
    quads.push(tripleRef(subjectUri, NS.clinical + 'loincCode', NS.loinc + loincCode));
  }
  quads.push(tripleStr(subjectUri, NS.clinical + 'vitalType', shaclVitalType));
  quads.push(tripleStr(subjectUri, NS.clinical + 'vitalTypeName', vitalInfo!.name));
  quads.push(tripleRef(subjectUri, NS.clinical + 'snomedCode', NS.sct + vitalInfo!.snomedCode));

  // Observation.status — the same element the lab branch writes, under the same
  // predicate, so a reader does not have to know which branch handled it.
  if (resource.status) {
    quads.push(tripleStr(subjectUri, STATUS_PREDICATE, resource.status));
  }

  if (resource.valueQuantity) {
    quads.push(tripleDouble(subjectUri, NS.clinical + 'value', resource.valueQuantity.value));
    quads.push(tripleStr(subjectUri, NS.clinical + 'unit', resource.valueQuantity.unit ?? vitalInfo?.unit ?? ''));
  } else if (Array.isArray(resource.component) && resource.component.length > 0) {
    // Panel-style vital (e.g., blood pressure panel LOINC 55284-4): component children
    // hold the individual readings. Emit each known component as a typed value predicate,
    // e.g., clinical:bloodPressureSystolicValue / clinical:bloodPressureDiastolicValue.
    let emittedCount = 0;
    for (const comp of resource.component) {
      if (!comp.valueQuantity) continue;
      const compCodings = extractCodings(comp.code);
      let compInfo: { type: string; name: string; unit: string; snomedCode: string } | undefined;
      for (const c of compCodings) {
        if (isLoincSystem(c.system) && VITAL_LOINC_CODES[c.code]) {
          compInfo = VITAL_LOINC_CODES[c.code];
          break;
        }
      }
      if (compInfo) {
        quads.push(tripleDouble(subjectUri, NS.clinical + compInfo.type + 'Value', comp.valueQuantity.value));
        quads.push(tripleStr(subjectUri, NS.clinical + compInfo.type + 'Unit', comp.valueQuantity.unit ?? compInfo.unit ?? ''));
        emittedCount++;
      }
    }
    if (emittedCount === 0) {
      warnings.push('No valueQuantity found in vital sign Observation');
    }
  } else if (typeof resource.valueString === 'string') {
    // Some vitals carry a non-quantity value (e.g. a textual reading). Capture it
    // rather than drop it. clinical:value is untyped in the shape, so a string is fine.
    quads.push(tripleStr(subjectUri, NS.clinical + 'value', resource.valueString));
  } else if (resource.valueCodeableConcept) {
    const valText = codeableConceptText(resource.valueCodeableConcept);
    if (valText) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'value', valText));
    } else {
      warnings.push('No value found in vital sign Observation');
    }
  } else if (typeof resource.valueInteger === 'number') {
    quads.push(tripleDouble(subjectUri, NS.clinical + 'value', resource.valueInteger));
  } else {
    warnings.push('No value found in vital sign Observation');
  }

  const effectiveDate = resource.effectiveDateTime ?? resource.effectivePeriod?.start;
  if (effectiveDate) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'effectiveDate', effectiveDate));
  }

  if (Array.isArray(resource.referenceRange) && resource.referenceRange.length > 0) {
    const rr = resource.referenceRange[0];
    if (rr.low?.value !== undefined) {
      quads.push(tripleDouble(subjectUri, NS.clinical + 'referenceRangeLow', rr.low.value));
    }
    if (rr.high?.value !== undefined) {
      quads.push(tripleDouble(subjectUri, NS.clinical + 'referenceRangeHigh', rr.high.value));
    }
  }

  if (resource.interpretation && Array.isArray(resource.interpretation) && resource.interpretation.length > 0) {
    const interpCode = resource.interpretation[0]?.coding?.[0]?.code ?? 'unknown';
    const interpMap: Record<string, string> = {
      N: 'normal', H: 'high', L: 'low', A: 'abnormal',
      HH: 'critical', LL: 'critical',
    };
    quads.push(tripleStr(subjectUri, NS.clinical + 'interpretation', interpMap[interpCode] ?? interpCode));
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  // The visit this vital sign was taken in (Observation.encounter).
  pushEncounterEdge(quads, subjectUri, resource.encounter);

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:VitalSign'),
    warnings,
    resourceType: 'Observation',
    cascadeType: 'clinical:VitalSign',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// Procedure converter (B1)
// ---------------------------------------------------------------------------

export function convertProcedure(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource, warnings);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'Procedure'));
  quads.push(...commonTriples(subjectUri));

  // Procedure name
  const name = codeableConceptText(resource.code) ?? 'Unknown Procedure';
  quads.push(tripleStr(subjectUri, NS.clinical + 'procedureName', name));

  // Procedure codes
  const codings = extractCodings(resource.code);
  for (const c of codings) {
    if (c.system === 'http://snomed.info/sct') {
      quads.push(tripleRef(subjectUri, NS.clinical + 'procedureSnomedCode', NS.sct + c.code));
    } else if (c.system === 'http://www.ama-assn.org/go/cpt' || c.system.includes('cpt')) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'cptCode', c.code));
    }
  }

  // performedDate -- use performedDateTime first, fall back to performedPeriod.start
  const performedDate = resource.performedDateTime ?? resource.performedPeriod?.start;
  if (performedDate) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'performedDate', performedDate));
  }

  // Status
  if (resource.status) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'procedureStatus', resource.status));
  }

  // Source record ID
  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceRecordId', resource.id));
  }

  // Cross-record edges: the visit this procedure was performed in
  // (Procedure.encounter) and the condition(s) that indicated it
  // (Procedure.reasonReference — the bulk of the specimen's indication edges).
  // Procedure.reasonCode rides the M1 parsed-indication path.
  pushEncounterEdge(quads, subjectUri, resource.encounter);
  pushIndicationEdges(quads, subjectUri, resource.reasonReference);
  pushParsedIndicationCandidates(quads, subjectUri, resource.reasonCode);

  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'FullyMapped'));

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:Procedure'),
    warnings,
    resourceType: 'Procedure',
    cascadeType: 'clinical:Procedure',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// ClinicalDocument converter (B1)
// ---------------------------------------------------------------------------

export function convertClinicalDocument(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource, warnings);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'ClinicalDocument'));
  quads.push(...commonTriples(subjectUri));

  // Document type
  const docType = codeableConceptText(resource.type) ?? 'Unknown Document';
  quads.push(tripleStr(subjectUri, NS.clinical + 'documentType', docType));

  // A DocumentReference carries TWO independent status elements, and from
  // clinical v1.16 each has its own predicate.
  //
  // docStatus is the status of the DOCUMENT (preliminary | final | amended |
  // entered-in-error) and stays on clinical:status, which is what
  // clinical:ClinicalDocument models and what every other converter here spells
  // FHIR `.status` as.
  //
  // status is the status of the REFERENCE (current | superseded |
  // entered-in-error): whether this pod entry is still the current pointer to
  // the document. Sharing one predicate was not merely lossy, it was ambiguous
  // in the costliest case — "entered-in-error" appears in BOTH value sets, and
  // means the FILING was a mistake in one and the clinical CONTENT is repudiated
  // in the other. A reader could not tell which had been said.
  //
  // Neither is defaulted. A document whose source states no status is stored
  // stating none.
  if (resource.docStatus) {
    quads.push(tripleStr(subjectUri, STATUS_PREDICATE, resource.docStatus));
  }
  if (resource.status) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'documentReferenceStatus', resource.status));
  }

  // Date
  const docDate = resource.date ?? resource.indexed;
  if (docDate) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'documentDate', docDate));
  }

  // EVERY author, and separately the authenticator.
  //
  // `DocumentReference.author` is 0..*, and until clinical v1.16 the only
  // predicate available was `clinical:providerName`, which is `sh:maxCount 1` on
  // every shape that constrains it — so a note co-signed by a resident and an
  // attending arrived naming one of them, with nothing recording that the other
  // had been discarded. `clinical:providerName` is unchanged and still holds the
  // single display name (written by the provenance pass from the first author);
  // this predicate holds all of them, that one included.
  //
  // The authenticator is a DIFFERENT FACT, not another author. A resident writes
  // and an attending signs: recording only the author loses the signature, which
  // is the part of a note carrying clinical and legal weight, and recording the
  // signer as an author asserts they wrote the content, which the source did not
  // say. FHIR keeps them as two elements for that reason and so does this.
  for (const author of Array.isArray(resource.author) ? resource.author : []) {
    const display = author?.display;
    if (typeof display === 'string' && display.trim().length > 0) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'documentAuthorName', display.trim()));
    }
  }
  const authenticator = resource.authenticator?.display;
  if (typeof authenticator === 'string' && authenticator.trim().length > 0) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'authenticatorName', authenticator.trim()));
  }

  // Content type and URL from first attachment
  if (Array.isArray(resource.content) && resource.content.length > 0) {
    const attachment = resource.content[0]?.attachment;
    if (attachment) {
      if (attachment.contentType) {
        quads.push(tripleStr(subjectUri, NS.clinical + 'contentType', attachment.contentType));
      }
      if (attachment.url) {
        quads.push(tripleStr(subjectUri, NS.clinical + 'documentUrl', attachment.url));
      }
      if (attachment.title) {
        quads.push(tripleStr(subjectUri, NS.clinical + 'documentTitle', attachment.title));
      }
    }
  }

  // The ClinicalDocumentShape requires clinical:fhirResourceId and
  // clinical:fhirResourceType (not clinical:sourceRecordId). Emit the exact
  // predicates the shape requires from the FHIR resource. Keep sourceRecordId
  // too (used by reconciliation / other consumers); it is additive, not a
  // substitute.
  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'fhirResourceId', resource.id));
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceRecordId', resource.id));
  }
  quads.push(tripleStr(subjectUri, NS.clinical + 'fhirResourceType', resource.resourceType ?? 'DocumentReference'));

  // The visit(s) this document belongs to. NOTE: on DocumentReference the
  // reference is NESTED under context.encounter (an array), not top-level.
  if (Array.isArray(resource.context?.encounter)) {
    for (const enc of resource.context.encounter) {
      pushEncounterEdge(quads, subjectUri, enc);
    }
  }

  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'FullyMapped'));

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:ClinicalDocument'),
    warnings,
    resourceType: 'DocumentReference',
    cascadeType: 'clinical:ClinicalDocument',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// Encounter converter (B2)
// ---------------------------------------------------------------------------

/**
 * How much a participation role recommends its holder as THE provider for a
 * visit, lowest first. Codes are from the HL7 v3 ParticipationType code system,
 * which FHIR R4 binds `Encounter.participant.type` to.
 *
 * WHY THIS EXISTS
 * ---------------
 * The converter used to take `participant[0].individual.display` with no role
 * check at all. Measured on one real Epic account, 54 encounters: the first
 * participant slot held an explicitly NON-TREATING role on 18 of the 52
 * encounters that have participants — `losAuthorizingPhysician` 16 times and
 * `referrer` twice. So the pod named the doctor who referred the patient, or who
 * authorised a length of stay, and dropped the clinician who actually delivered
 * the care — with nothing on the record to say which one a reader was looking
 * at.
 *
 * Roles NOT in this table (referrer, authorising physician, the generic
 * `Participation`, anything an EHR spells locally) are not ranked and therefore
 * never outrank a real performer. They can still be selected, but only when the
 * encounter names nobody better; that is the pre-existing behaviour and losing
 * a name entirely would be a worse answer than an unranked one.
 *
 * @see https://terminology.hl7.org/CodeSystem-v3-ParticipationType.html
 * @see https://hl7.org/fhir/R4/encounter-definitions.html#Encounter.participant.type
 */
const ENCOUNTER_PARTICIPANT_ROLE_RANK: Record<string, number> = {
  ATND: 0, // attender — the clinician responsible for the patient during the visit
  PPRF: 1, // primary performer
  SPRF: 2, // secondary performer
  CON: 3, // consultant
  ADM: 4, // admitter
  DIS: 5, // discharger
  // NOT v3: the measured Epic dialect. On the account this fix was verified
  // against, the treating clinician frequently carries no v3 code at all —
  // the dermatology visit's dermatologist appears only as `PHYSICIAN`,
  // `losAuthorizingPhysician` and `PART`. A generic "Physician" is a weaker
  // claim than any v3 performer role, so it ranks below all of them, but it
  // is still a treating-role signal and must beat the fallback tier — which
  // is where the referrer in slot 0 lives.
  PHYSICIAN: 6,
};

/**
 * Whether a participant's role EXPLICITLY says they did not deliver the care:
 * `referrer` (v3 REF) and Epic's `losAuthorizingPhysician`. These are the two
 * roles the measurement found sitting in slot 0 on 18 of 52 encounters, which
 * is what made blind `participant[0]` wrong. They are never ranked, and the
 * fallback tier prefers any neutrally-typed name over them; they are stored
 * only when the encounter names nobody else at all.
 *
 * `losAuthorizingPhysician` is matched on the `authoriz` stem, not `physician`
 * — its text CONTAINS "Physician" and must not be mistaken for the treating
 * role above.
 */
function participantIsExplicitlyNonTreating(participant: any): boolean {
  const types = Array.isArray(participant?.type) ? participant.type : [];
  for (const type of types) {
    for (const coding of Array.isArray(type?.coding) ? type.coding : []) {
      const code = typeof coding?.code === 'string' ? coding.code.trim().toUpperCase() : undefined;
      if (code === 'REF') return true;
    }
    if (typeof type?.text === 'string' && /referrer|authoriz/i.test(type.text)) return true;
  }
  return false;
}

/** Rank of the best role a single `Encounter.participant` declares, or undefined. */
function participantRoleRank(participant: any): number | undefined {
  const types = Array.isArray(participant?.type) ? participant.type : [];
  let best: number | undefined;
  const consider = (rank: number | undefined): void => {
    if (rank === undefined) return;
    if (best === undefined || rank < best) best = rank;
  };
  for (const type of types) {
    for (const coding of Array.isArray(type?.coding) ? type.coding : []) {
      const code = typeof coding?.code === 'string' ? coding.code.trim().toUpperCase() : undefined;
      if (code) consider(ENCOUNTER_PARTICIPANT_ROLE_RANK[code]);
    }
    // Sources that populate only `type.text`. Epic writes `attender` here rather
    // than the v3 code, and it is the single role most worth recognising, so the
    // text tier looks for it specifically instead of guessing at the rest.
    if (typeof type?.text === 'string' && /attend/i.test(type.text)) {
      consider(ENCOUNTER_PARTICIPANT_ROLE_RANK.ATND);
    }
    // Exact match only: `losAuthorizingPhysician` also contains "Physician"
    // and is an explicitly NON-treating role.
    if (typeof type?.text === 'string' && /^physician$/i.test(type.text.trim())) {
      consider(ENCOUNTER_PARTICIPANT_ROLE_RANK.PHYSICIAN);
    }
  }
  return best;
}

/**
 * The single name to store as `clinical:providerName` for an encounter.
 *
 * Preference order, highest first: attender, primary performer, any other
 * ranked clinical performer role (see the table above, generic Physician
 * last), then — only if no participant declares a ranked role — the first
 * named participant whose role does not explicitly disclaim treating, then
 * the first participant that carries a name at all. Ties are broken by
 * source order, so a stable input gives a stable answer.
 *
 * Emitting EVERY participant with its role is the right long-run answer and
 * needs vocabulary that does not exist yet; this keeps the record's single
 * provider slot and only corrects WHICH name lands in it.
 */
function selectEncounterProviderName(resource: any): string | undefined {
  const participants = Array.isArray(resource?.participant) ? resource.participant : [];
  let chosen: string | undefined;
  let chosenRank: number | undefined;
  let firstNeutralNamed: string | undefined;
  let firstNamed: string | undefined;

  for (const participant of participants) {
    const name = participant?.individual?.display;
    if (typeof name !== 'string' || name.trim().length === 0) continue;
    if (firstNamed === undefined) firstNamed = name;
    const rank = participantRoleRank(participant);
    if (rank === undefined) {
      // The fallback tier is split in two: a name whose role says nothing
      // (generic Participation, untyped) beats a name whose role explicitly
      // says NON-treating (referrer, authorising physician). Silence beats a
      // stated disqualification; a stated disqualification still beats losing
      // the encounter's only name.
      if (firstNeutralNamed === undefined && !participantIsExplicitlyNonTreating(participant)) {
        firstNeutralNamed = name;
      }
      continue;
    }
    if (chosenRank === undefined || rank < chosenRank) {
      chosenRank = rank;
      chosen = name;
    }
  }

  return chosen ?? firstNeutralNamed ?? firstNamed;
}

/**
 * The facility an encounter happened at.
 *
 * `serviceProvider` first, because it is the organisation FHIR designates as
 * responsible for the encounter. It is also, on real vendor output, frequently
 * absent: measured empty on all 54 encounters of one Epic account, while
 * `location[].location.display` was populated on all 54 (24 distinct clinics).
 * `clinical:facilityName` consequently appeared ZERO times in that entire pod
 * despite existing in the vocabulary and being the most orienting single fact
 * on an encounter card.
 *
 * @see https://hl7.org/fhir/R4/encounter-definitions.html#Encounter.serviceProvider
 * @see https://hl7.org/fhir/R4/encounter-definitions.html#Encounter.location.location
 */
function selectEncounterFacilityName(resource: any): string | undefined {
  const serviceProvider = resource?.serviceProvider?.display;
  if (typeof serviceProvider === 'string' && serviceProvider.trim().length > 0) return serviceProvider;

  for (const entry of Array.isArray(resource?.location) ? resource.location : []) {
    const display = entry?.location?.display;
    if (typeof display === 'string' && display.trim().length > 0) return display;
  }
  return undefined;
}

/**
 * Every business identifier an `Encounter` states, normalized to the ONE
 * spelling both transports write.
 *
 * WHY THIS EXISTS
 * ---------------
 * `Encounter.identifier` is the visit's identifier in the health system — on
 * Epic output, the contact serial number. The C-CDA export of the same visit
 * states the same value as `<encounter><id root= extension=/>` and the C-CDA
 * path has always written it into the pod. This converter read `identifier`
 * only when `resource.id` was absent (for identity minting) and never wrote it
 * as a fact, so on a pod holding both transports the join key sat on one side
 * of every duplicate pair: measured 0 of 54 FHIR-derived encounter blocks
 * carrying a serial number, against 48 of 52 C-CDA ones naming the same visits.
 * That is why 177 encounter subjects described about 58 visits and nothing
 * in-pod could tell.
 *
 * THE SPELLING IS `ccdaSourceId`'s, DELIBERATELY
 * ----------------------------------------------
 * `<system>:<value>`, with FHIR's `urn:oid:` URI prefix stripped so what remains
 * is the bare OID the C-CDA `<id root>` carries. A value with no system renders
 * as `:value`, which is exactly what `ccdaSourceId` produces for an
 * extension-only `<id>` — a bare `value` would silently join with a
 * differently-scoped identifier that happens to share it.
 *
 * The two derivations are separate functions in separate modules because the
 * inputs are different shapes; `tests/encounter-identifier-join.test.ts` pins
 * their OUTPUTS as equal on twin fixtures, so a change to either spelling fails
 * rather than quietly unjoining the transports.
 *
 * @see https://hl7.org/fhir/R4/encounter-definitions.html#Encounter.identifier
 */
function encounterIdentifierTokens(resource: any): string[] {
  const identifiers = Array.isArray(resource?.identifier) ? resource.identifier : [];
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const identifier of identifiers) {
    const value = typeof identifier?.value === 'string' ? identifier.value.trim() : '';
    // An identifier with no value identifies nothing. Emitting `system:` for it
    // would put a token in the join space that every other system-only
    // identifier also matches.
    if (!value) continue;
    const rawSystem = typeof identifier?.system === 'string' ? identifier.system.trim() : '';
    const system = rawSystem.startsWith('urn:oid:') ? rawSystem.slice('urn:oid:'.length) : rawSystem;
    const token = `${system}:${value}`;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

/**
 * Every business identifier an `Encounter` states, in FHIR TOKEN form.
 *
 * `{system}|{value}`, the ratified way to write a system-qualified identifier as
 * one string (https://hl7.org/fhir/R4/search.html#token), which `spec` names
 * normatively on `clinical:businessIdentifier` as of clinical v1.16. Where the
 * source states no system the BARE VALUE is written and no system is invented.
 *
 * THE SYSTEM IS VERBATIM. It is NOT stripped of `urn:oid:`, and the difference
 * from {@link encounterIdentifierTokens} directly below is the entire point:
 * that function produces the FROZEN colon form for `cascade:sourceRecordId`, a
 * compatibility artifact whose spelling can never change because changing it
 * would unjoin every pair of encounters already matched on it. This one produces
 * the canonical form. Two spellings, two predicates, and per the ratified
 * migration plan a value of one form is never compared
 * against a value of the other.
 *
 * @see https://hl7.org/fhir/R4/encounter-definitions.html#Encounter.identifier
 */
function encounterBusinessIdentifiers(resource: any): string[] {
  const identifiers = Array.isArray(resource?.identifier) ? resource.identifier : [];
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const identifier of identifiers) {
    const value = typeof identifier?.value === 'string' ? identifier.value.trim() : '';
    // Same rule as the colon form: an identifier with no value identifies
    // nothing, and `system|` would sit in the join space matching every other
    // value-less identifier from that system.
    if (!value) continue;
    const system = typeof identifier?.system === 'string' ? identifier.system.trim() : '';
    const token = system ? `${system}|${value}` : value;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

/**
 * The specialty a participant acted in, where the source carries one.
 *
 * FHIR models this as `PractitionerRole.specialty`, but servers routinely convey
 * it on `Encounter.participant` as an EXTENSION rather than by publishing a
 * resolvable PractitionerRole — which is why `clinical:participantSpecialty`
 * carries a string rather than an edge, and why this reads an extension at all.
 *
 * The url is matched on containing `specialty` rather than on one vendor's exact
 * StructureDefinition URI. A fixed URI list would silently drop the value from
 * every server whose URI is not on it, and the failure would look exactly like
 * "this server does not send specialty" — the class of silent loss this whole
 * effort exists to end. The value is read from `valueCodeableConcept`,
 * `valueCoding.display` or `valueString`, which is every spelling observed.
 *
 * @see https://hl7.org/fhir/R4/practitionerrole-definitions.html#PractitionerRole.specialty
 */
function participantSpecialty(participant: any): string | undefined {
  for (const ext of Array.isArray(participant?.extension) ? participant.extension : []) {
    const url = typeof ext?.url === 'string' ? ext.url : '';
    if (!/specialty/i.test(url)) continue;
    const fromConcept = codeableConceptText(ext.valueCodeableConcept);
    if (fromConcept && fromConcept.trim().length > 0) return fromConcept.trim();
    const display = ext?.valueCoding?.display;
    if (typeof display === 'string' && display.trim().length > 0) return display.trim();
    if (typeof ext?.valueString === 'string' && ext.valueString.trim().length > 0) {
      return ext.valueString.trim();
    }
  }
  return undefined;
}

/**
 * Every participation an `Encounter` describes, reduced to the facts
 * `clinical:EncounterParticipant` models.
 *
 * A participation the source said NOTHING about — no name, no role, no
 * specialty — yields no entry. A node carrying only a link back to its own
 * encounter asserts that somebody participated while describing nobody, which
 * is a claim the source did not make and which no reader could act on.
 *
 * Roles are collected in BOTH spellings because they answer different questions:
 * `participantRole` is the label that makes a stored name interpretable to a
 * reader, and `participantRoleCode` is what a consumer selects on. FHIR binds
 * `participant.type` only EXTENSIBLY, so a server may send a local code and stay
 * conformant; nothing here filters against a value set, because rejecting an
 * unrecognised role would discard the participant along with it.
 *
 * The LABEL is the first one stated and the CODES are all of them, matching the
 * cardinalities `clinical:EncounterParticipantShape` asserts (role 0..1, role
 * code 0..*). One participation with two typed roles therefore keeps both codes
 * and one label, rather than losing a code or failing validation with two
 * labels.
 */
function encounterParticipations(resource: any): EncounterParticipation[] {
  const out: EncounterParticipation[] = [];
  for (const participant of Array.isArray(resource?.participant) ? resource.participant : []) {
    const rawName = participant?.individual?.display;
    const name = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : undefined;

    let role: string | undefined;
    const roleCodes: string[] = [];
    for (const type of Array.isArray(participant?.type) ? participant.type : []) {
      const label = codeableConceptText(type);
      if (role === undefined && typeof label === 'string' && label.trim().length > 0) {
        role = label.trim();
      }
      for (const coding of Array.isArray(type?.coding) ? type.coding : []) {
        const code = typeof coding?.code === 'string' ? coding.code.trim() : '';
        if (code && !roleCodes.includes(code)) roleCodes.push(code);
      }
    }

    const specialty = participantSpecialty(participant);

    if (!name && role === undefined && roleCodes.length === 0 && !specialty) continue;
    out.push({ name, role, roleCodes, specialty });
  }
  return out;
}

export function convertEncounter(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource, warnings);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'Encounter'));
  quads.push(...commonTriples(subjectUri));

  // Encounter class (ambulatory, emergency, inpatient, etc.) — the Coding
  // MIRRORED, not reduced to one of its parts.
  //
  // `Encounter.class` is a Coding bound only EXTENSIBLY, so a conformant server
  // may send `AMB` from v3-ActCode or a local category id from its own system;
  // one Epic account returns `"5"`. All three parts are kept because each
  // answers a question the others cannot: the CODE is what a round-trip export
  // must restore and what a code-system lookup keys on, the DISPLAY is the only
  // readable thing when the code is local (`Appointment`, `Hospital Encounter`),
  // and the SYSTEM is the only thing that distinguishes a ratified ActEncounterCode
  // from a locally-numbered category that happens to look like one. Storing the
  // display INSTEAD of the code was never available; storing the code alone left
  // a bare id on screen. clinical v1.16 authored the other two.
  const classCoding = resource.class?.coding?.[0];
  const encounterClass = resource.class?.code ?? classCoding?.code;
  if (encounterClass) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'encounterClass', encounterClass));
  }
  const classDisplay = resource.class?.display ?? classCoding?.display;
  if (typeof classDisplay === 'string' && classDisplay.trim().length > 0) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'encounterClassDisplay', classDisplay.trim()));
  }
  const classSystem = resource.class?.system ?? classCoding?.system;
  if (typeof classSystem === 'string' && classSystem.trim().length > 0) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'encounterClassSystem', classSystem.trim()));
  }

  // Status
  if (resource.status) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'encounterStatus', resource.status));
  }

  // Encounter type (from type[0])
  if (Array.isArray(resource.type) && resource.type.length > 0) {
    const typeText = codeableConceptText(resource.type[0]);
    if (typeText) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'encounterType', typeText));
    }
    // SNOMED code from type
    const codings = extractCodings(resource.type[0]);
    for (const c of codings) {
      if (c.system === 'http://snomed.info/sct') {
        quads.push(tripleRef(subjectUri, NS.clinical + 'snomedCode', NS.sct + c.code));
        break;
      }
    }
  }

  // Period
  if (resource.period?.start) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'encounterStart', resource.period.start));
  }
  if (resource.period?.end) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'encounterEnd', resource.period.end));
  }

  // Why the visit happened, in the chart's own words. REPEATABLE, because
  // Encounter.reasonCode is 0..* and one visit routinely states several. The
  // value is CodeableConcept.text where the source gives one, else the first
  // coding's display: the reason as WRITTEN, never normalized to a code. FHIR
  // binds this element only PREFERRED, and real exports carry local, free-text
  // and SNOMED reasons in the same field, so an enum here would reject
  // conformant data.
  if (Array.isArray(resource.reasonCode)) {
    const seenReasons = new Set<string>();
    for (const reason of resource.reasonCode) {
      const text = codeableConceptText(reason);
      if (typeof text !== 'string') continue;
      const trimmed = text.trim();
      if (!trimmed || seenReasons.has(trimmed)) continue;
      seenReasons.add(trimmed);
      quads.push(tripleStr(subjectUri, NS.clinical + 'encounterReason', trimmed));
    }
  }

  // The admission detail. The PRESENCE of Encounter.hospitalization is itself
  // the structured signal that a visit was an admission rather than an office
  // visit, and through clinical v1.15 this vocabulary had nowhere to put it, so
  // that distinction was unrecoverable from the pod. Neither predicate is
  // defaulted: an absent element means the source did not say, and inventing
  // "Home or Self Care" for it would be 3.257's defect on a new field.
  const admitSource = codeableConceptText(resource.hospitalization?.admitSource);
  if (typeof admitSource === 'string' && admitSource.trim().length > 0) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'admitSource', admitSource.trim()));
  }
  const dischargeDisposition = codeableConceptText(resource.hospitalization?.dischargeDisposition);
  if (typeof dischargeDisposition === 'string' && dischargeDisposition.trim().length > 0) {
    quads.push(
      tripleStr(subjectUri, NS.clinical + 'dischargeDisposition', dischargeDisposition.trim()),
    );
  }

  // Provider: the participant whose declared ROLE says they treated the patient,
  // not merely the one the server listed first. See selectEncounterProviderName.
  //
  // UNCHANGED by the participation nodes below, deliberately. This is the SUMMARY
  // slot — the one name an application displays — and `clinical:providerName` is
  // `sh:maxCount 1` on every shape that constrains it. The participations are the
  // full record. Two facts, two predicates; replacing the summary with the record
  // would break every reader that asks an encounter who the provider was.
  const providerName = selectEncounterProviderName(resource);
  if (providerName) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'providerName', providerName));
  }

  // The whole care team, each participation as its own node with its role
  // attached. A name recorded with no role is indistinguishable from a treating
  // clinician's and cannot be corrected by a reader; that is why the referrer in
  // slot 0 was previously stored as the provider on 18 of 52 measured encounters
  // with nothing on the record to say so.
  //
  // Node IRIs come from `encounterParticipantUri` and from nowhere else. It is a
  // pure function of this encounter's subject IRI and the participation's own
  // content — never the array index, never a clock — so re-importing the same
  // resource produces the same nodes and adds nothing. See that function for why
  // the index in particular is disqualified.
  //
  // Two participations stating IDENTICAL facts mint one IRI and are written
  // once. RDF would collapse the repeated triples anyway — a graph is a set —
  // so the alternative was not two nodes but the same node emitted twice, which
  // only makes the quad list disagree with the graph it serializes to.
  const seenParticipants = new Set<string>();
  for (const participation of encounterParticipations(resource)) {
    const participantUri = encounterParticipantUri(subjectUri, participation);
    if (seenParticipants.has(participantUri)) continue;
    seenParticipants.add(participantUri);
    quads.push(tripleRef(subjectUri, NS.clinical + 'hasParticipant', participantUri));
    quads.push(tripleType(participantUri, NS.clinical + 'EncounterParticipant'));
    if (participation.name) {
      quads.push(tripleStr(participantUri, NS.clinical + 'participantName', participation.name));
    }
    if (participation.role) {
      quads.push(tripleStr(participantUri, NS.clinical + 'participantRole', participation.role));
    }
    for (const code of participation.roleCodes) {
      quads.push(tripleStr(participantUri, NS.clinical + 'participantRoleCode', code));
    }
    if (participation.specialty) {
      quads.push(
        tripleStr(participantUri, NS.clinical + 'participantSpecialty', participation.specialty),
      );
    }
  }

  // Facility: serviceProvider, falling back to the first named location.
  const facilityName = selectEncounterFacilityName(resource);
  if (facilityName) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'facilityName', facilityName));
  }

  // The FHIR SERVER's row id. Kept on its own predicate: `clinical:sourceRecordId`
  // is `sh:maxCount 1` on clinical:EncounterShape, and it is the join key a
  // `Reference.reference` string points at, which the visit identifier below is
  // not.
  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceRecordId', resource.id));
  }

  // The VISIT's identifier(s) in the health system, on the predicate the C-CDA
  // path already writes them to, so one visit's two transports carry one join
  // key. `cascade:sourceRecordId` is core v3's "original source system record
  // identifier ... preserved for provenance", carries no shape constraint on
  // Encounter, and is repeatable — all three of which `clinical:sourceRecordId`
  // is not. See encounterIdentifierTokens.
  //
  // A FACT, NOT AN IDENTITY INPUT. `mintSubjectUri` above is unchanged and still
  // keys on `resource.id`. Deciding that two subjects are one visit is the
  // reconciler's judgement, made with both records in hand and recorded as
  // cascade:mergedFrom lineage; the identity layer sees one record at a time and
  // could only overwrite.
  for (const token of encounterIdentifierTokens(resource)) {
    quads.push(tripleStr(subjectUri, NS.cascade + 'sourceRecordId', token));
  }

  // The SAME identifiers on the CANONICAL predicate, in FHIR token form. This is
  // the transition step of the ratified identifier migration plan:
  // dual-emit, migrate the reconciler's match key to this predicate, and only
  // then is retiring the frozen spelling above schedulable. Until every pod has
  // been re-imported, some encounters carry only the old predicate, which is why
  // the matcher reads both — each in its own form, never one against the other.
  for (const token of encounterBusinessIdentifiers(resource)) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'businessIdentifier', token));
  }

  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'FullyMapped'));

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:Encounter'),
    warnings,
    resourceType: 'Encounter',
    cascadeType: 'clinical:Encounter',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// DiagnosticReport converter (B5), routed on category (3.221)
// ---------------------------------------------------------------------------

/**
 * The HL7 v2-0074 diagnostic service sections that mean "this report describes
 * pictures of the patient".
 *
 * `DiagnosticReport.category` is bound in FHIR R4 to
 * http://terminology.hl7.org/CodeSystem/v2-0074, whose members are service
 * SECTIONS rather than modalities — but several sections are named for the
 * modality that produced the study (CT scan, nuclear magnetic resonance,
 * radiograph), which is why this set is longer than "RAD". `MR` and `US` are
 * not v2-0074 members at all; they are the DICOM modality abbreviations, and
 * real exports put them in this element often enough that omitting them would
 * send an MRI report back to the laboratory branch.
 *
 * @see https://terminology.hl7.org/CodeSystem-v2-0074.html
 */
const IMAGING_SERVICE_SECTIONS = new Set([
  'RAD', // Radiology
  'CT', // CAT scan
  'CTH', // Cardiac catheterization
  'CUS', // Cardiac ultrasound
  'MR', // Magnetic resonance (DICOM modality, not v2-0074)
  'NMR', // Nuclear magnetic resonance
  'NMS', // Nuclear medicine scan
  'OUS', // OB ultrasound
  'RUS', // Radiology ultrasound
  'RX', // Radiograph
  'US', // Ultrasound (DICOM modality, not v2-0074)
  'VUS', // Vascular ultrasound
  'XRC', // Cineradiograph
]);

/**
 * The v2-0074 sections that mean "a specimen was analysed" — the sections
 * `clinical:LaboratoryReport` already describes correctly.
 *
 * This set exists so that an unrecognised category can be told apart from a
 * laboratory one. Before 3.221 there was no such distinction: everything was a
 * laboratory report, so a section this table does not know still lands on the
 * laboratory class, but now it says so (see `routeDiagnosticReport`).
 */
const LABORATORY_SERVICE_SECTIONS = new Set([
  'BG', // Blood gases
  'BLB', // Blood bank
  'CH', // Chemistry
  'HM', // Hematology
  'IMM', // Immunology
  'LAB', // Laboratory
  'MB', // Microbiology
  'MCB', // Mycobacteriology
  'MYC', // Mycology
  'OSL', // Outside lab
  'SR', // Serology
  'TX', // Toxicology
  'VR', // Virology
]);

/**
 * Category texts an export writes instead of a code. Only the unambiguous ones:
 * a text this table does not hold is treated as unrouted and reported, which is
 * the honest outcome, rather than guessed at with a substring match.
 */
const IMAGING_CATEGORY_TEXTS = new Set(['RADIOLOGY', 'IMAGING', 'DIAGNOSTIC IMAGING']);
const LABORATORY_CATEGORY_TEXTS = new Set(['LAB', 'LABS', 'LABORATORY', 'LABORATORY REPORT']);

export interface DiagnosticReportRoute {
  /** The Cascade class this report is typed as. Both are ratified in clinical.ttl. */
  cascadeClass: 'LaboratoryReport' | 'ImagingReport';
  /**
   * The category token, verbatim, when it is neither a laboratory nor an
   * imaging service section. Undefined when the report routed cleanly.
   */
  unroutedCategory?: string;
}

/**
 * The category token this report is routed and labelled by.
 *
 * Deliberately the SAME derivation as the `clinical:reportCategory` triple
 * below — first category entry, its first coding's code, else its text — so
 * that the fact the pod records and the decision the converter makes can never
 * disagree about what the source said.
 */
function diagnosticReportCategoryToken(resource: any): string | undefined {
  if (!Array.isArray(resource?.category) || resource.category.length === 0) return undefined;
  const first = resource.category[0];
  const token = first?.coding?.[0]?.code ?? codeableConceptText(first);
  if (typeof token !== 'string') return undefined;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Which Cascade class a `DiagnosticReport` becomes.
 *
 * THE DEFECT THIS CLOSES (3.221). Every DiagnosticReport was typed
 * `clinical:LaboratoryReport`, because the dispatcher had one branch for the
 * resource type and the converter asserted that class as its first act. A
 * radiology report therefore entered the pod as a lab report: not merely
 * mislabelled, but invisible — "what imaging do I have?" reads
 * `clinical:ImagingReport` and `clinical:ImagingStudy`, and the record was
 * neither.
 *
 * THREE OUTCOMES, AND THE THIRD IS THE POINT.
 *
 *   Laboratory section, or no category at all -> `clinical:LaboratoryReport`.
 *   Absent stays laboratory because that is what the pod already holds and
 *   what an uncategorised DiagnosticReport overwhelmingly is; retyping those
 *   on no evidence would trade one silent miscategorisation for another.
 *
 *   Imaging section -> `clinical:ImagingReport`. Ratified in clinical.ttl with
 *   a SHACL shape in clinical.shapes.ttl, and already named in this module's
 *   required-fields table. No vocabulary is invented here.
 *
 *   Anything else (surgical pathology, cytogenetics, pulmonary function) keeps
 *   `clinical:LaboratoryReport` and is REPORTED. There is no ratified Cascade
 *   class for those, and a converter is not where vocabulary gets minted. The
 *   caller is told which category went unrouted and the record stops claiming
 *   `cascade:FullyMapped`, so a known gap is stated rather than papered over.
 */
export function routeDiagnosticReport(resource: any): DiagnosticReportRoute {
  const token = diagnosticReportCategoryToken(resource);
  if (token === undefined) return { cascadeClass: 'LaboratoryReport' };

  const normalized = token.toUpperCase();
  if (IMAGING_SERVICE_SECTIONS.has(normalized) || IMAGING_CATEGORY_TEXTS.has(normalized)) {
    return { cascadeClass: 'ImagingReport' };
  }
  if (LABORATORY_SERVICE_SECTIONS.has(normalized) || LABORATORY_CATEGORY_TEXTS.has(normalized)) {
    return { cascadeClass: 'LaboratoryReport' };
  }
  return { cascadeClass: 'LaboratoryReport', unroutedCategory: token };
}

export function convertDiagnosticReport(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource, warnings);
  const quads: Quad[] = [];

  const route = routeDiagnosticReport(resource);
  if (route.unroutedCategory !== undefined) {
    warnings.push(
      `DiagnosticReport category "${route.unroutedCategory}" is neither a laboratory nor an ` +
        `imaging diagnostic service section (HL7 v2-0074). The record keeps ` +
        `clinical:LaboratoryReport, which is not what it is: no ratified Cascade class covers ` +
        `this category, so it is not marked fully mapped.`,
    );
  }

  quads.push(tripleType(subjectUri, NS.clinical + route.cascadeClass));
  quads.push(...commonTriples(subjectUri));

  // Panel name from code.text or first coding display
  const panelName = codeableConceptText(resource.code) ?? 'Unknown Panel';
  quads.push(tripleStr(subjectUri, NS.clinical + 'panelName', panelName));

  // DiagnosticReport.status — registered | partial | preliminary | final |
  // amended | corrected | appended | cancelled | entered-in-error. Unlike
  // DocumentReference, DiagnosticReport has exactly one status element, so there
  // is nothing to disambiguate. See STATUS_PREDICATE.
  if (resource.status) {
    quads.push(tripleStr(subjectUri, STATUS_PREDICATE, resource.status));
  }

  // LOINC code
  const codings = extractCodings(resource.code);
  for (const c of codings) {
    if (c.system === 'http://loinc.org') {
      quads.push(tripleRef(subjectUri, NS.clinical + 'loincCode', NS.loinc + c.code));
      break;
    }
  }

  // Report category
  if (Array.isArray(resource.category) && resource.category.length > 0) {
    const catCode = resource.category[0]?.coding?.[0]?.code ?? codeableConceptText(resource.category[0]);
    if (catCode) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'reportCategory', catCode));
    }
  }

  // Effective date (when procedure/analysis was performed)
  const effectiveDate = resource.effectiveDateTime ?? resource.effectivePeriod?.start;
  if (effectiveDate) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'performedDate', effectiveDate));
  }

  // documentDate (when results were finalized/issued) — required by LaboratoryReportShape
  const issuedDate = resource.issued ?? resource.effectiveDateTime ?? resource.effectivePeriod?.start;
  if (issuedDate) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'documentDate', issuedDate));
  }

  // Provider from first performer
  if (Array.isArray(resource.performer) && resource.performer.length > 0) {
    const provName = resource.performer[0]?.display;
    if (provName) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'providerName', provName));
    }
  }

  // Link to constituent LabResult Observations via hasLabResult. The reference
  // is emitted as a resolvable placeholder carrying the raw FHIR reference; the
  // batch loop (index.ts resolveReferenceEdges) rewrites it to the Observation's
  // real content-hashed subject IRI, or drops the edge if that Observation is
  // not in the bundle. The Observation subject is never the raw id, so no id
  // arithmetic here can produce a resolvable edge.
  if (Array.isArray(resource.result)) {
    for (const ref of resource.result) {
      const refStr = ref?.reference as string | undefined;
      if (refStr) {
        quads.push(tripleRef(subjectUri, NS.clinical + 'hasLabResult', referencePlaceholder(refStr)));
      }
    }
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceRecordId', resource.id));
    quads.push(tripleStr(subjectUri, NS.clinical + 'fhirResourceId', resource.id));
  }
  quads.push(tripleStr(subjectUri, NS.clinical + 'fhirResourceType', 'DiagnosticReport'));

  // The visit this report was produced in (DiagnosticReport.encounter).
  pushEncounterEdge(quads, subjectUri, resource.encounter);

  // A report whose category routed cleanly is fully mapped. One that did not is
  // sitting on a class that does not describe it, and saying "fully mapped"
  // about that is the exact claim 3.221 exists to stop.
  quads.push(
    tripleRef(
      subjectUri,
      NS.cascade + 'layerPromotionStatus',
      NS.cascade +
        (route.unroutedCategory === undefined ? 'FullyMapped' : 'PendingLayerTwoPromotion'),
    ),
  );

  const cascadeType = `clinical:${route.cascadeClass}`;
  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, cascadeType),
    warnings,
    resourceType: 'DiagnosticReport',
    cascadeType,
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// MedicationAdministration converter (B5)
// ---------------------------------------------------------------------------

export function convertMedicationAdministration(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource, warnings);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'MedicationAdministration'));
  quads.push(...commonTriples(subjectUri));

  // Medication name
  const medName = codeableConceptText(resource.medicationCodeableConcept)
    ?? resource.medicationReference?.display
    ?? 'Unknown Medication';
  quads.push(tripleStr(subjectUri, NS.health + 'medicationName', medName));

  // Status
  if (resource.status) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'administrationStatus', resource.status));
  }

  // Administered date
  const adminDate = resource.effectiveDateTime ?? resource.effectivePeriod?.start;
  if (adminDate) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'administeredDate', adminDate));
  }

  // Dose and route from dosage
  if (resource.dosage) {
    if (resource.dosage.dose) {
      const dose = `${resource.dosage.dose.value ?? ''} ${resource.dosage.dose.unit ?? ''}`.trim();
      if (dose) quads.push(tripleStr(subjectUri, NS.clinical + 'administeredDose', dose));
    }
    const route = codeableConceptText(resource.dosage.route);
    if (route) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'administeredRoute', route));
    }
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceRecordId', resource.id));
  }

  // The condition(s) this administration was given for
  // (MedicationAdministration.reasonReference). The encounter link on this
  // resource is FHIR .context (Encounter|EpisodeOfCare) and is out of R3b's
  // top-level .encounter scope, so it is intentionally not wired here.
  pushIndicationEdges(quads, subjectUri, resource.reasonReference);
  pushParsedIndicationCandidates(quads, subjectUri, resource.reasonCode);

  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'FullyMapped'));

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:MedicationAdministration'),
    warnings,
    resourceType: 'MedicationAdministration',
    cascadeType: 'clinical:MedicationAdministration',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// Device (ImplantedDevice) converter (B5)
// ---------------------------------------------------------------------------

export function convertDevice(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource, warnings);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'ImplantedDevice'));
  quads.push(...commonTriples(subjectUri));

  // Device type
  const deviceType = codeableConceptText(resource.type) ?? 'Unknown Device';
  quads.push(tripleStr(subjectUri, NS.clinical + 'deviceType', deviceType));

  // Status
  if (resource.status) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'deviceStatus', resource.status));
  }

  // Manufacturer
  if (resource.manufacturer) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'deviceManufacturer', resource.manufacturer));
  }

  // UDI carrier
  if (Array.isArray(resource.udiCarrier) && resource.udiCarrier.length > 0) {
    const udi = resource.udiCarrier[0]?.deviceIdentifier ?? resource.udiCarrier[0]?.carrierHRF;
    if (udi) quads.push(tripleStr(subjectUri, NS.clinical + 'udiCarrier', udi));
  }

  // Implant date (from manufactureDate or extension)
  if (resource.manufactureDate) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'implantDate', resource.manufactureDate));
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceRecordId', resource.id));
  }

  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'FullyMapped'));

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:ImplantedDevice'),
    warnings,
    resourceType: 'Device',
    cascadeType: 'clinical:ImplantedDevice',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// ImagingStudy converter (B5)
// ---------------------------------------------------------------------------

/**
 * How much of an `ImagingStudy` this converter actually represents.
 *
 * `stated` is what the source says the study holds: the larger of the inlined
 * `series` array and the `numberOfSeries` count. Both are counted because they
 * fail differently — a server can inline four series, or inline one and declare
 * three, and in the second case two series exist that this record does not
 * describe just as surely as in the first.
 *
 * `represented` is what the record below carries: one series if any was inlined,
 * none otherwise. It is not derived from anything; it is the literal fact that
 * modality and retrieve URL are read from `series[0]`.
 */
function imagingStudySeriesCoverage(resource: any): { represented: number; stated: number } {
  const inlined = Array.isArray(resource?.series) ? resource.series.length : 0;
  const declared =
    typeof resource?.numberOfSeries === 'number' && Number.isFinite(resource.numberOfSeries)
      ? resource.numberOfSeries
      : 0;
  return { represented: inlined > 0 ? 1 : 0, stated: Math.max(inlined, declared) };
}

export function convertImagingStudy(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource, warnings);
  const quads: Quad[] = [];

  // WHAT THIS RECORD REPRESENTS, DECIDED BEFORE IT CLAIMS ANYTHING (3.222).
  //
  // Modality and retrieve URL below are read from `series[0]` and from nowhere
  // else, so a four-series MRI arrives carrying one series' modality. Until this
  // check the record then asserted `cascade:FullyMapped` regardless, which made
  // a partial import indistinguishable from a complete one — and
  // `clinical:numberOfSeries` sat next to the single modality saying "4", which
  // reads as a fact about the study rather than the count of what was dropped.
  //
  // Only the STATEMENT is fixed here. Emitting every series needs a decision
  // about how a series is modelled in the pod, and that decision is pending;
  // making the converter honest is separable from making it complete, and
  // shipping the honesty first is what stops the loss being silent meanwhile.
  const series = imagingStudySeriesCoverage(resource);
  const partial = series.stated > series.represented;
  if (partial) {
    warnings.push(
      `ImagingStudy states ${series.stated} series; this record represents only the first ` +
        `(kept series ${series.represented} of ${series.stated}). Modality and retrieve URL are ` +
        `read from that series alone, so the record is not marked fully mapped.`,
    );
  }

  quads.push(tripleType(subjectUri, NS.clinical + 'ImagingStudy'));
  quads.push(...commonTriples(subjectUri));

  // Modality from first series
  const modality = resource.series?.[0]?.modality?.code;
  if (modality) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'imagingModality', modality));
  }

  // Description
  if (resource.description) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'studyDescription', resource.description));
  }

  // Number of series
  if (resource.numberOfSeries !== undefined) {
    quads.push(tripleTyped(subjectUri, NS.clinical + 'numberOfSeries', String(resource.numberOfSeries), NS.xsd + 'integer'));
  }

  // Study date
  if (resource.started) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'studyDate', resource.started));
  }

  // DICOM Study UID from identifier[0]
  if (Array.isArray(resource.identifier) && resource.identifier.length > 0) {
    const uid = resource.identifier[0]?.value;
    if (uid) quads.push(tripleStr(subjectUri, NS.clinical + 'dicomStudyUid', uid));
  }

  // Retrieve URL from first series endpoint
  const retrieveUrl = resource.series?.[0]?.endpoint?.[0]?.reference;
  if (retrieveUrl) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'retrieveUrl', retrieveUrl));
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceRecordId', resource.id));
  }

  // The visit this imaging study was performed in (ImagingStudy.encounter).
  pushEncounterEdge(quads, subjectUri, resource.encounter);

  // A single-series study that reached every field it has is fully mapped and
  // stays so. A partially represented one says what it is.
  quads.push(
    tripleRef(
      subjectUri,
      NS.cascade + 'layerPromotionStatus',
      NS.cascade + (partial ? 'PendingLayerTwoPromotion' : 'FullyMapped'),
    ),
  );

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:ImagingStudy'),
    warnings,
    resourceType: 'ImagingStudy',
    cascadeType: 'clinical:ImagingStudy',
    _quads: quads,
  };
}
