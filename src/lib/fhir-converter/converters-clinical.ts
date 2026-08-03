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
 *   - DiagnosticReport -> clinical:LaboratoryReport
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
  contentHashedUri,
} from './types.js';
import {
  referencePlaceholder,
  pushEncounterEdge,
  pushIndicationEdges,
  pushParsedIndicationCandidates,
} from './reference-resolution.js';
import { contentFingerprint, EMPTY_SEED } from '../identity.js';

// ---------------------------------------------------------------------------
// Medication converter
// ---------------------------------------------------------------------------

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

  // Dosage
  const dosage = Array.isArray(resource.dosage) ? resource.dosage[0] : undefined;
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

  // Effective period
  if (resource.effectivePeriod?.start) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'startDate', resource.effectivePeriod.start));
  } else if (resource.effectiveDateTime) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'startDate', resource.effectiveDateTime));
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

export function convertCondition(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const patientRef = resource.subject?.reference ?? '';
  const subjectUri = contentHashedUri('Condition', {
    patient: patientRef,
    snomedCode: resource.code?.coding?.find((c: any) => c.system?.includes('snomed'))?.code,
    icd10Code: resource.code?.coding?.find((c: any) => c.system?.includes('icd'))?.code,
    onsetDate: (resource.onsetDateTime ?? resource.onsetPeriod?.start)?.split('T')[0],
  }, resource.id, resource, warnings);
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

  const clinicalStatus = resource.clinicalStatus?.coding?.[0]?.code ?? 'active';
  quads.push(tripleStr(subjectUri, NS.health + 'status', clinicalStatus));

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

export function convertAllergyIntolerance(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const patientRef = resource.patient?.reference ?? '';
  const subjectUri = contentHashedUri('AllergyIntolerance', {
    patient: patientRef,
    allergenCode: resource.code?.coding?.[0]?.code,
    allergenName: resource.code?.text,
  }, resource.id, resource, warnings);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.health + 'AllergyRecord'));
  quads.push(...commonTriples(subjectUri));

  const allergen = codeableConceptText(resource.code) ?? 'Unknown Allergen';
  quads.push(tripleStr(subjectUri, NS.health + 'allergen', allergen));

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
 * `contentHashedUri` uses as its own field separators into the key.
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
  const fingerprint = contentFingerprint(measured);
  return fingerprint === EMPTY_SEED ? undefined : fingerprint;
}

/**
 * The Observation's category codes, or `undefined` when it carries none.
 *
 * Sorted, because `Observation.category` is a set rather than an ordered list
 * and two servers may enumerate the same categories in different order. Sorting
 * therefore removes a source of spurious SPLITS; it can never cause a merge,
 * since a differing set still sorts to a differing string.
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
  return parts.length > 0 ? parts.sort().join(',') : undefined;
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
 */
function labSubjectUri(resource: any, warnings: string[]): string {
  // Tier 1 — the source assigned an identifier. Same door, same key template,
  // and the same answer `convertObservationVital` gives for this resource.
  if (typeof resource?.id === 'string' && resource.id.trim().length > 0) {
    return mintSubjectUri(resource, warnings);
  }
  return contentHashedUri('Observation', {
    patient: resource?.subject?.reference,
    loincCode: resource?.code?.coding?.find((c: any) => c.system?.includes('loinc'))?.code,
    // Full precision. `.split('T')[0]` merged a 07:00 draw with an 11:00 draw.
    effective: resource?.effectiveDateTime ?? resource?.effectivePeriod?.start,
    value: labMeasuredValueKey(resource),
    specimen: resource?.specimen?.reference,
    category: labCategoryKey(resource),
    // No `fallbackId`: this branch runs only when there is no id to fall back
    // to. Passing one here is what hid the defect above for so long.
  }, undefined, resource, warnings);
}

export function convertObservationLab(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = labSubjectUri(resource, warnings);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.health + 'LabResultRecord'));
  quads.push(...commonTriples(subjectUri));

  const testName = codeableConceptText(resource.code) ?? 'Unknown Lab Test';
  quads.push(tripleStr(subjectUri, NS.health + 'testName', testName));

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

  if (resource.interpretation && Array.isArray(resource.interpretation) && resource.interpretation.length > 0) {
    const interpCode = resource.interpretation[0]?.coding?.[0]?.code ?? 'unknown';
    const interpMap: Record<string, string> = {
      N: 'normal', H: 'abnormal', L: 'abnormal', A: 'abnormal',
      HH: 'critical', LL: 'critical', AA: 'critical',
      HU: 'critical', LU: 'critical',
    };
    quads.push(tripleStr(subjectUri, NS.health + 'interpretation', interpMap[interpCode] ?? 'unknown'));
  } else {
    quads.push(tripleStr(subjectUri, NS.health + 'interpretation', 'unknown'));
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

  if (Array.isArray(resource.category)) {
    for (const cat of resource.category) {
      if (Array.isArray(cat.coding)) {
        for (const c of cat.coding) {
          if (c.code && c.code !== 'laboratory') {
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

  // Date
  const docDate = resource.date ?? resource.indexed;
  if (docDate) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'documentDate', docDate));
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

export function convertEncounter(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource, warnings);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'Encounter'));
  quads.push(...commonTriples(subjectUri));

  // Encounter class (ambulatory, emergency, inpatient, etc.)
  const encounterClass = resource.class?.code ?? resource.class?.coding?.[0]?.code;
  if (encounterClass) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'encounterClass', encounterClass));
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

  // Provider from first participant
  if (Array.isArray(resource.participant) && resource.participant.length > 0) {
    const providerName = resource.participant[0]?.individual?.display;
    if (providerName) {
      quads.push(tripleStr(subjectUri, NS.clinical + 'providerName', providerName));
    }
  }

  // Facility from serviceProvider
  if (resource.serviceProvider?.display) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'facilityName', resource.serviceProvider.display));
  }

  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceRecordId', resource.id));
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
// LaboratoryReport (DiagnosticReport) converter (B5)
// ---------------------------------------------------------------------------

export function convertLaboratoryReport(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource, warnings);
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'LaboratoryReport'));
  quads.push(...commonTriples(subjectUri));

  // Panel name from code.text or first coding display
  const panelName = codeableConceptText(resource.code) ?? 'Unknown Panel';
  quads.push(tripleStr(subjectUri, NS.clinical + 'panelName', panelName));

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

  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'FullyMapped'));

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:LaboratoryReport'),
    warnings,
    resourceType: 'DiagnosticReport',
    cascadeType: 'clinical:LaboratoryReport',
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

export function convertImagingStudy(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = mintSubjectUri(resource, warnings);
  const quads: Quad[] = [];

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

  quads.push(tripleRef(subjectUri, NS.cascade + 'layerPromotionStatus', NS.cascade + 'FullyMapped'));

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:ImagingStudy'),
    warnings,
    resourceType: 'ImagingStudy',
    cascadeType: 'clinical:ImagingStudy',
    _quads: quads,
  };
}
