/**
 * FHIR conversion utilities.
 *
 * Converts between FHIR R4 JSON and Cascade Protocol RDF (Turtle/JSON-LD).
 *
 * Supported FHIR R4 resource types:
 *   - MedicationStatement / MedicationRequest -> health:MedicationRecord
 *   - Condition -> health:ConditionRecord
 *   - AllergyIntolerance -> health:AllergyRecord
 *   - Observation (lab) -> health:LabResultRecord
 *   - Observation (vital) -> clinical:VitalSign
 *   - Patient -> cascade:PatientProfile
 *   - Immunization -> health:ImmunizationRecord
 *   - Coverage -> coverage:InsurancePlan
 *
 * Zero network calls. All conversion is local.
 */

import { randomUUID } from 'node:crypto';
import { Parser, Writer, DataFactory, type Quad } from 'n3';

const { namedNode, literal, quad: makeQuad } = DataFactory;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InputFormat = 'fhir' | 'cascade' | 'c-cda';
export type OutputFormat = 'turtle' | 'jsonld' | 'fhir' | 'cascade';

export interface ConversionResult {
  turtle: string;
  jsonld?: object;
  warnings: string[];
  resourceType: string;
  cascadeType: string;
}

export interface BatchConversionResult {
  success: boolean;
  output: string;
  format: OutputFormat;
  resourceCount: number;
  warnings: string[];
  errors: string[];
  results: ConversionResult[];
}

// ---------------------------------------------------------------------------
// Namespace constants
// ---------------------------------------------------------------------------

const NS = {
  cascade: 'https://ns.cascadeprotocol.org/core/v1#',
  health: 'https://ns.cascadeprotocol.org/health/v1#',
  clinical: 'https://ns.cascadeprotocol.org/clinical/v1#',
  coverage: 'https://ns.cascadeprotocol.org/coverage/v1#',
  fhir: 'http://hl7.org/fhir/',
  sct: 'http://snomed.info/sct/',
  loinc: 'http://loinc.org/rdf#',
  rxnorm: 'http://www.nlm.nih.gov/research/umls/rxnorm/',
  icd10: 'http://hl7.org/fhir/sid/icd-10-cm/',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  prov: 'http://www.w3.org/ns/prov#',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
} as const;

/** Standard Turtle prefix block for all generated output. */
const TURTLE_PREFIXES: Record<string, string> = {
  cascade: NS.cascade,
  health: NS.health,
  clinical: NS.clinical,
  coverage: NS.coverage,
  fhir: NS.fhir,
  sct: NS.sct,
  loinc: NS.loinc,
  rxnorm: NS.rxnorm,
  xsd: NS.xsd,
  prov: NS.prov,
};

// ---------------------------------------------------------------------------
// FHIR coding-system to Cascade namespace mapping
// ---------------------------------------------------------------------------

const CODING_SYSTEM_MAP: Record<string, string> = {
  'http://www.nlm.nih.gov/research/umls/rxnorm': NS.rxnorm,
  'urn:oid:2.16.840.1.113883.6.88': NS.rxnorm,
  'http://snomed.info/sct': NS.sct,
  'http://loinc.org': NS.loinc,
  'http://hl7.org/fhir/sid/icd-10-cm': NS.icd10,
  'http://hl7.org/fhir/sid/icd-10': NS.icd10,
};

// ---------------------------------------------------------------------------
// FHIR vital-sign LOINC code mapping
// ---------------------------------------------------------------------------

const VITAL_LOINC_CODES: Record<string, { type: string; name: string; unit: string; snomedCode: string }> = {
  '8480-6': { type: 'bloodPressureSystolic', name: 'Systolic Blood Pressure', unit: 'mmHg', snomedCode: '271649006' },
  '8462-4': { type: 'bloodPressureDiastolic', name: 'Diastolic Blood Pressure', unit: 'mmHg', snomedCode: '271650006' },
  '8867-4': { type: 'heartRate', name: 'Heart Rate', unit: 'bpm', snomedCode: '364075005' },
  '9279-1': { type: 'respiratoryRate', name: 'Respiratory Rate', unit: 'breaths/min', snomedCode: '86290005' },
  '8310-5': { type: 'bodyTemperature', name: 'Body Temperature', unit: 'degC', snomedCode: '386725007' },
  '2708-6': { type: 'oxygenSaturation', name: 'Oxygen Saturation', unit: '%', snomedCode: '431314004' },
  '29463-7': { type: 'bodyWeight', name: 'Body Weight', unit: 'kg', snomedCode: '27113001' },
  '8302-2': { type: 'bodyHeight', name: 'Body Height', unit: 'cm', snomedCode: '50373000' },
  '39156-5': { type: 'bmi', name: 'Body Mass Index', unit: 'kg/m2', snomedCode: '60621009' },
};

/** FHIR observation categories that indicate vital signs */
const VITAL_CATEGORIES = ['vital-signs', 'vital-sign'];

// ---------------------------------------------------------------------------
// Helper: date formatting
// ---------------------------------------------------------------------------

/**
 * Ensure an ISO 8601 dateTime string with timezone.
 * Bare dates (YYYY-MM-DD) get T00:00:00Z appended.
 */
function ensureDateTimeWithTz(dateStr: string): string {
  if (!dateStr) return '';
  // Already has time component with timezone
  if (/T.+Z$/.test(dateStr) || /T.+[+-]\d{2}:\d{2}$/.test(dateStr)) {
    return dateStr;
  }
  // Has time component but no timezone — append Z
  if (/T/.test(dateStr)) {
    return dateStr + 'Z';
  }
  // Date only — append midnight UTC
  return dateStr + 'T00:00:00Z';
}

// ---------------------------------------------------------------------------
// Helper: extract coding info from FHIR codeable concept
// ---------------------------------------------------------------------------

interface CodingInfo {
  system: string;
  code: string;
  display?: string;
}

function extractCodings(codeableConcept: any): CodingInfo[] {
  if (!codeableConcept) return [];
  const codings: CodingInfo[] = [];
  if (Array.isArray(codeableConcept.coding)) {
    for (const c of codeableConcept.coding) {
      if (c.system && c.code) {
        codings.push({ system: c.system, code: c.code, display: c.display });
      }
    }
  }
  return codings;
}

function codeableConceptText(cc: any): string | undefined {
  if (!cc) return undefined;
  if (cc.text) return cc.text as string;
  if (Array.isArray(cc.coding) && cc.coding.length > 0 && cc.coding[0].display) {
    return cc.coding[0].display as string;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Quad-building helpers
// ---------------------------------------------------------------------------

function tripleStr(subject: string, predicate: string, value: string): Quad {
  return makeQuad(
    namedNode(subject),
    namedNode(predicate),
    literal(value),
  );
}

function tripleTyped(subject: string, predicate: string, value: string, datatype: string): Quad {
  return makeQuad(
    namedNode(subject),
    namedNode(predicate),
    literal(value, namedNode(datatype)),
  );
}

function tripleBool(subject: string, predicate: string, value: boolean): Quad {
  return makeQuad(
    namedNode(subject),
    namedNode(predicate),
    literal(String(value), namedNode(NS.xsd + 'boolean')),
  );
}

function tripleInt(subject: string, predicate: string, value: number): Quad {
  return makeQuad(
    namedNode(subject),
    namedNode(predicate),
    literal(String(value), namedNode(NS.xsd + 'integer')),
  );
}

function tripleDouble(subject: string, predicate: string, value: number): Quad {
  return makeQuad(
    namedNode(subject),
    namedNode(predicate),
    literal(String(value), namedNode(NS.xsd + 'double')),
  );
}

function tripleRef(subject: string, predicate: string, object: string): Quad {
  return makeQuad(
    namedNode(subject),
    namedNode(predicate),
    namedNode(object),
  );
}

function tripleType(subject: string, rdfType: string): Quad {
  return tripleRef(subject, NS.rdf + 'type', rdfType);
}

function tripleDateTime(subject: string, predicate: string, dateStr: string): Quad {
  return tripleTyped(subject, predicate, ensureDateTimeWithTz(dateStr), NS.xsd + 'dateTime');
}

function tripleDate(subject: string, predicate: string, dateStr: string): Quad {
  return tripleTyped(subject, predicate, dateStr, NS.xsd + 'date');
}

// Common triples every Cascade resource gets
function commonTriples(subject: string): Quad[] {
  return [
    tripleRef(subject, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'),
    tripleStr(subject, NS.cascade + 'schemaVersion', '1.3'),
  ];
}

// ---------------------------------------------------------------------------
// Quads -> Turtle serialization
// ---------------------------------------------------------------------------

function quadsToTurtle(quads: Quad[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const writer = new Writer({ prefixes: TURTLE_PREFIXES });
    for (const q of quads) {
      writer.addQuad(q);
    }
    writer.end((error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

// ---------------------------------------------------------------------------
// Quads -> JSON-LD object (lightweight, no @context resolution)
// ---------------------------------------------------------------------------

function quadsToJsonLd(quads: Quad[], _cascadeType: string): object {
  // Build a simple JSON-LD representation grouped by subject
  const subjects = new Map<string, Record<string, any>>();

  for (const q of quads) {
    const subj = q.subject.value;
    if (!subjects.has(subj)) {
      subjects.set(subj, {
        '@context': 'https://ns.cascadeprotocol.org/context/v1/cascade.jsonld',
        '@id': subj,
      });
    }
    const obj = subjects.get(subj)!;
    const pred = q.predicate.value;

    if (pred === NS.rdf + 'type') {
      obj['@type'] = q.object.value;
      continue;
    }

    // Compact the predicate using known prefixes
    let key = pred;
    for (const [prefix, uri] of Object.entries(TURTLE_PREFIXES)) {
      if (pred.startsWith(uri)) {
        key = `${prefix}:${pred.slice(uri.length)}`;
        break;
      }
    }

    // Handle object vs literal
    if (q.object.termType === 'NamedNode') {
      // Check if this is a provenance reference
      let idVal = q.object.value;
      for (const [prefix, uri] of Object.entries(TURTLE_PREFIXES)) {
        if (idVal.startsWith(uri)) {
          idVal = `${prefix}:${idVal.slice(uri.length)}`;
          break;
        }
      }
      obj[key] = { '@id': idVal };
    } else {
      // Literal
      const dt = (q.object as any).datatype?.value;
      if (dt === NS.xsd + 'dateTime' || dt === NS.xsd + 'date') {
        obj[key] = { '@value': q.object.value, '@type': dt === NS.xsd + 'dateTime' ? 'xsd:dateTime' : 'xsd:date' };
      } else if (dt === NS.xsd + 'boolean') {
        obj[key] = q.object.value === 'true';
      } else if (dt === NS.xsd + 'integer') {
        obj[key] = parseInt(q.object.value, 10);
      } else if (dt === NS.xsd + 'double' || dt === NS.xsd + 'decimal') {
        obj[key] = parseFloat(q.object.value);
      } else {
        obj[key] = q.object.value;
      }
    }
  }

  const entries = Array.from(subjects.values());
  return entries.length === 1 ? entries[0] : entries;
}

// ---------------------------------------------------------------------------
// Per-resource FHIR -> Cascade converters
// ---------------------------------------------------------------------------

function convertMedicationStatement(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = `urn:uuid:${randomUUID()}`;
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.health + 'MedicationRecord'));
  quads.push(...commonTriples(subjectUri));

  // Medication name
  const medName = codeableConceptText(resource.medicationCodeableConcept)
    ?? resource.medicationReference?.display
    ?? 'Unknown Medication';
  quads.push(tripleStr(subjectUri, NS.health + 'medicationName', medName));

  // isActive from FHIR status
  const status = resource.status as string | undefined;
  const isActive = status === 'active' || status === 'intended' || status === 'on-hold';
  quads.push(tripleBool(subjectUri, NS.health + 'isActive', isActive));

  // Drug codes
  const codings = extractCodings(resource.medicationCodeableConcept);
  for (const coding of codings) {
    const nsUri = CODING_SYSTEM_MAP[coding.system];
    if (nsUri) {
      quads.push(tripleRef(subjectUri, NS.clinical + 'drugCode', nsUri + coding.code));
      // If RxNorm, also emit health:rxNormCode
      if (nsUri === NS.rxnorm) {
        quads.push(tripleRef(subjectUri, NS.health + 'rxNormCode', nsUri + coding.code));
      }
    } else {
      warnings.push(`Unknown coding system: ${coding.system} (code ${coding.code})`);
    }
  }

  // Dosage
  const dosage = Array.isArray(resource.dosage) ? resource.dosage[0] : undefined;
  if (dosage) {
    if (dosage.text) {
      quads.push(tripleStr(subjectUri, NS.health + 'dose', dosage.text));
    }
    if (dosage.route?.text) {
      quads.push(tripleStr(subjectUri, NS.health + 'route', dosage.route.text));
    } else if (dosage.route?.coding?.[0]?.display) {
      quads.push(tripleStr(subjectUri, NS.health + 'route', dosage.route.coding[0].display));
    }
    if (dosage.timing?.repeat?.frequency) {
      const freq = dosage.timing.repeat.frequency;
      const periodUnit = dosage.timing.repeat.periodUnit ?? 'd';
      const unitLabel = periodUnit === 'd' ? 'daily' : periodUnit === 'wk' ? 'weekly' : periodUnit;
      const freqText = freq === 1 ? `once ${unitLabel}` : `${freq} times ${unitLabel}`;
      quads.push(tripleStr(subjectUri, NS.health + 'frequency', freqText));
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

  // Provenance class — based on resource type
  const fhirResourceType = resource.resourceType as string;
  if (fhirResourceType === 'MedicationStatement') {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceFhirResourceType', 'MedicationStatement'));
    quads.push(tripleStr(subjectUri, NS.clinical + 'clinicalIntent', 'reportedUse'));
  } else if (fhirResourceType === 'MedicationRequest') {
    quads.push(tripleStr(subjectUri, NS.clinical + 'sourceFhirResourceType', 'MedicationRequest'));
    quads.push(tripleStr(subjectUri, NS.clinical + 'clinicalIntent', 'prescribed'));
  }
  quads.push(tripleStr(subjectUri, NS.clinical + 'provenanceClass', 'imported'));

  // Source record ID
  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  // Notes
  if (resource.note && Array.isArray(resource.note)) {
    const noteText = resource.note.map((n: any) => n.text).filter(Boolean).join('; ');
    if (noteText) quads.push(tripleStr(subjectUri, NS.health + 'notes', noteText));
  }

  return {
    turtle: '', // filled by caller
    warnings,
    resourceType: fhirResourceType,
    cascadeType: 'health:MedicationRecord',
    jsonld: quadsToJsonLd(quads, 'health:MedicationRecord'),
    _quads: quads,
  } as ConversionResult & { _quads: Quad[] };
}

function convertCondition(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = `urn:uuid:${randomUUID()}`;
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.health + 'ConditionRecord'));
  quads.push(...commonTriples(subjectUri));

  // Condition name
  const condName = codeableConceptText(resource.code) ?? 'Unknown Condition';
  quads.push(tripleStr(subjectUri, NS.health + 'conditionName', condName));

  // Status — map FHIR clinicalStatus to Cascade health:status
  const clinicalStatus = resource.clinicalStatus?.coding?.[0]?.code ?? 'active';
  quads.push(tripleStr(subjectUri, NS.health + 'status', clinicalStatus));

  // Onset date
  if (resource.onsetDateTime) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'onsetDate', resource.onsetDateTime));
  } else if (resource.onsetPeriod?.start) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'onsetDate', resource.onsetPeriod.start));
  }

  // Abatement date
  if (resource.abatementDateTime) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'abatementDate', resource.abatementDateTime));
  }

  // Coding: ICD-10 and SNOMED
  const codings = extractCodings(resource.code);
  for (const coding of codings) {
    const nsUri = CODING_SYSTEM_MAP[coding.system];
    if (nsUri === NS.icd10) {
      quads.push(tripleRef(subjectUri, NS.health + 'icd10Code', nsUri + coding.code));
    } else if (nsUri === NS.sct) {
      quads.push(tripleRef(subjectUri, NS.health + 'snomedCode', nsUri + coding.code));
    } else if (nsUri) {
      // Other code system
      warnings.push(`Condition code from non-standard system: ${coding.system}`);
    }
  }

  // Source record ID
  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  // Notes
  if (resource.note && Array.isArray(resource.note)) {
    const noteText = resource.note.map((n: any) => n.text).filter(Boolean).join('; ');
    if (noteText) quads.push(tripleStr(subjectUri, NS.health + 'notes', noteText));
  }

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'health:ConditionRecord'),
    warnings,
    resourceType: 'Condition',
    cascadeType: 'health:ConditionRecord',
    _quads: quads,
  };
}

function convertAllergyIntolerance(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = `urn:uuid:${randomUUID()}`;
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.health + 'AllergyRecord'));
  quads.push(...commonTriples(subjectUri));

  // Allergen
  const allergen = codeableConceptText(resource.code) ?? 'Unknown Allergen';
  quads.push(tripleStr(subjectUri, NS.health + 'allergen', allergen));

  // Category
  if (Array.isArray(resource.category) && resource.category.length > 0) {
    quads.push(tripleStr(subjectUri, NS.health + 'allergyCategory', resource.category[0]));
  }

  // Reaction
  if (Array.isArray(resource.reaction) && resource.reaction.length > 0) {
    const manifestations = resource.reaction
      .flatMap((r: any) => r.manifestation ?? [])
      .map((m: any) => codeableConceptText(m))
      .filter(Boolean);
    if (manifestations.length > 0) {
      quads.push(tripleStr(subjectUri, NS.health + 'reaction', manifestations.join(', ')));
    }
    // Severity from the first reaction
    const severity = resource.reaction[0]?.severity;
    if (severity) {
      const severityMap: Record<string, string> = {
        mild: 'mild',
        moderate: 'moderate',
        severe: 'severe',
      };
      quads.push(tripleStr(subjectUri, NS.health + 'allergySeverity', severityMap[severity] ?? severity));
    }
  }

  // Criticality -> severity mapping if no reaction severity
  if (resource.criticality && !(Array.isArray(resource.reaction) && resource.reaction[0]?.severity)) {
    const critMap: Record<string, string> = {
      low: 'mild',
      high: 'severe',
      'unable-to-assess': 'moderate',
    };
    quads.push(tripleStr(subjectUri, NS.health + 'allergySeverity', critMap[resource.criticality] ?? resource.criticality));
  }

  // Onset date
  if (resource.onsetDateTime) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'onsetDate', resource.onsetDateTime));
  }

  // Source record ID
  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  // Notes
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

function isVitalSignObservation(resource: any): boolean {
  // Check category for vital-signs
  if (Array.isArray(resource.category)) {
    for (const cat of resource.category) {
      if (Array.isArray(cat.coding)) {
        for (const c of cat.coding) {
          if (VITAL_CATEGORIES.includes(c.code)) return true;
        }
      }
    }
  }
  // Check if code has a known vital-sign LOINC
  const codings = extractCodings(resource.code);
  for (const c of codings) {
    if (c.system === 'http://loinc.org' && VITAL_LOINC_CODES[c.code]) return true;
  }
  return false;
}

function convertObservationLab(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = `urn:uuid:${randomUUID()}`;
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.health + 'LabResultRecord'));
  quads.push(...commonTriples(subjectUri));

  // Test name
  const testName = codeableConceptText(resource.code) ?? 'Unknown Lab Test';
  quads.push(tripleStr(subjectUri, NS.health + 'testName', testName));

  // Result value
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
  } else {
    quads.push(tripleStr(subjectUri, NS.health + 'resultValue', ''));
    warnings.push('No result value found in Observation resource');
  }

  // Interpretation
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

  // Performed date
  const effectiveDate = resource.effectiveDateTime ?? resource.effectivePeriod?.start ?? resource.issued;
  if (effectiveDate) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'performedDate', effectiveDate));
  } else {
    warnings.push('No effective date found in Observation resource');
  }

  // LOINC test code
  const codings = extractCodings(resource.code);
  for (const c of codings) {
    if (c.system === 'http://loinc.org') {
      quads.push(tripleRef(subjectUri, NS.health + 'testCode', NS.loinc + c.code));
    }
  }

  // Category
  if (Array.isArray(resource.category)) {
    for (const cat of resource.category) {
      if (Array.isArray(cat.coding)) {
        for (const c of cat.coding) {
          if (c.code && c.code !== 'laboratory') {
            quads.push(tripleStr(subjectUri, NS.health + 'labCategory', c.code));
          } else if (c.code === 'laboratory') {
            // Standard lab category — may want to use text or further coding
          }
        }
      }
      if (cat.text) {
        quads.push(tripleStr(subjectUri, NS.health + 'labCategory', cat.text));
      }
    }
  }

  // Reference range
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

  // Source record ID
  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'health:LabResultRecord'),
    warnings,
    resourceType: 'Observation',
    cascadeType: 'health:LabResultRecord',
    _quads: quads,
  };
}

function convertObservationVital(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = `urn:uuid:${randomUUID()}`;
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.clinical + 'VitalSign'));
  quads.push(...commonTriples(subjectUri));

  // Identify vital type from LOINC code
  const codings = extractCodings(resource.code);
  let vitalInfo: { type: string; name: string; unit: string; snomedCode: string } | undefined;
  for (const c of codings) {
    if (c.system === 'http://loinc.org' && VITAL_LOINC_CODES[c.code]) {
      vitalInfo = VITAL_LOINC_CODES[c.code];
      quads.push(tripleRef(subjectUri, NS.clinical + 'loincCode', NS.loinc + c.code));
      break;
    }
  }

  if (vitalInfo) {
    quads.push(tripleStr(subjectUri, NS.clinical + 'vitalType', vitalInfo.type));
    quads.push(tripleStr(subjectUri, NS.clinical + 'vitalTypeName', vitalInfo.name));
    quads.push(tripleRef(subjectUri, NS.clinical + 'snomedCode', NS.sct + vitalInfo.snomedCode));
  } else {
    const name = codeableConceptText(resource.code) ?? 'Unknown Vital';
    quads.push(tripleStr(subjectUri, NS.clinical + 'vitalType', name.toLowerCase().replace(/\s+/g, '_')));
    quads.push(tripleStr(subjectUri, NS.clinical + 'vitalTypeName', name));
    warnings.push(`Unknown vital sign LOINC code — using display name: ${name}`);
  }

  // Value
  if (resource.valueQuantity) {
    quads.push(tripleDouble(subjectUri, NS.clinical + 'value', resource.valueQuantity.value));
    quads.push(tripleStr(subjectUri, NS.clinical + 'unit', resource.valueQuantity.unit ?? vitalInfo?.unit ?? ''));
  } else {
    warnings.push('No valueQuantity found in vital sign Observation');
  }

  // Effective date
  const effectiveDate = resource.effectiveDateTime ?? resource.effectivePeriod?.start;
  if (effectiveDate) {
    quads.push(tripleDateTime(subjectUri, NS.clinical + 'effectiveDate', effectiveDate));
  }

  // Reference range
  if (Array.isArray(resource.referenceRange) && resource.referenceRange.length > 0) {
    const rr = resource.referenceRange[0];
    if (rr.low?.value !== undefined) {
      quads.push(tripleDouble(subjectUri, NS.clinical + 'referenceRangeLow', rr.low.value));
    }
    if (rr.high?.value !== undefined) {
      quads.push(tripleDouble(subjectUri, NS.clinical + 'referenceRangeHigh', rr.high.value));
    }
  }

  // Interpretation
  if (resource.interpretation && Array.isArray(resource.interpretation) && resource.interpretation.length > 0) {
    const interpCode = resource.interpretation[0]?.coding?.[0]?.code ?? 'unknown';
    const interpMap: Record<string, string> = {
      N: 'normal', H: 'high', L: 'low', A: 'abnormal',
      HH: 'critical', LL: 'critical',
    };
    quads.push(tripleStr(subjectUri, NS.clinical + 'interpretation', interpMap[interpCode] ?? interpCode));
  }

  // Source record ID
  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'clinical:VitalSign'),
    warnings,
    resourceType: 'Observation',
    cascadeType: 'clinical:VitalSign',
    _quads: quads,
  };
}

function convertPatient(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = `urn:uuid:${randomUUID()}`;
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.cascade + 'PatientProfile'));
  quads.push(...commonTriples(subjectUri));

  // Date of birth
  if (resource.birthDate) {
    quads.push(tripleDate(subjectUri, NS.cascade + 'dateOfBirth', resource.birthDate));
    // Compute age
    const dob = new Date(resource.birthDate);
    const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    const monthDiff = now.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) {
      age--;
    }
    quads.push(tripleInt(subjectUri, NS.cascade + 'computedAge', age));
    // Age group
    let ageGroup: string;
    if (age < 18) ageGroup = 'pediatric';
    else if (age < 40) ageGroup = 'young_adult';
    else if (age < 65) ageGroup = 'adult';
    else ageGroup = 'senior';
    quads.push(tripleStr(subjectUri, NS.cascade + 'ageGroup', ageGroup));
  } else {
    warnings.push('No birthDate found in Patient resource');
  }

  // Biological sex
  if (resource.gender) {
    const genderMap: Record<string, string> = {
      male: 'male',
      female: 'female',
      other: 'intersex',
      unknown: 'intersex',
    };
    quads.push(tripleStr(subjectUri, NS.cascade + 'biologicalSex', genderMap[resource.gender] ?? resource.gender));
  }

  // Address
  if (Array.isArray(resource.address) && resource.address.length > 0) {
    const addr = resource.address[0];
    // Emit address fields directly on the subject since we cannot easily do blank nodes with n3 quads
    // We will note this simplification
    if (addr.city) quads.push(tripleStr(subjectUri, NS.cascade + 'addressCity', addr.city));
    if (addr.state) quads.push(tripleStr(subjectUri, NS.cascade + 'addressState', addr.state));
    if (addr.postalCode) quads.push(tripleStr(subjectUri, NS.cascade + 'addressPostalCode', addr.postalCode));
    if (addr.country) quads.push(tripleStr(subjectUri, NS.cascade + 'addressCountry', addr.country));
    if (Array.isArray(addr.line)) {
      for (const line of addr.line) {
        quads.push(tripleStr(subjectUri, NS.cascade + 'addressLine', line));
      }
    }
    warnings.push('Patient address flattened onto profile (blank node structure simplified)');
  }

  // Marital status
  if (resource.maritalStatus) {
    const maritalText = codeableConceptText(resource.maritalStatus);
    if (maritalText) {
      const maritalMap: Record<string, string> = {
        S: 'single', M: 'married', D: 'divorced', W: 'widowed',
        A: 'separated', T: 'domestic_partnership', UNK: 'prefer_not_to_say',
        // Display text mappings
        'Never Married': 'single', 'Married': 'married', 'Divorced': 'divorced',
        'Widowed': 'widowed', 'Separated': 'separated',
      };
      const code = resource.maritalStatus.coding?.[0]?.code;
      const mapped = maritalMap[code] ?? maritalMap[maritalText] ?? maritalText.toLowerCase();
      quads.push(tripleStr(subjectUri, NS.cascade + 'maritalStatus', mapped));
    }
  }

  // Profile ID
  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.cascade + 'profileId', resource.id));
  }

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'cascade:PatientProfile'),
    warnings,
    resourceType: 'Patient',
    cascadeType: 'cascade:PatientProfile',
    _quads: quads,
  };
}

function convertImmunization(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = `urn:uuid:${randomUUID()}`;
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.health + 'ImmunizationRecord'));
  quads.push(...commonTriples(subjectUri));

  // Vaccine name
  const vaccineName = codeableConceptText(resource.vaccineCode) ?? 'Unknown Vaccine';
  quads.push(tripleStr(subjectUri, NS.health + 'vaccineName', vaccineName));

  // Administration date
  if (resource.occurrenceDateTime) {
    quads.push(tripleDateTime(subjectUri, NS.health + 'administrationDate', resource.occurrenceDateTime));
  } else if (resource.occurrenceString) {
    warnings.push(`Immunization date is a string: ${resource.occurrenceString}`);
  }

  // Status
  quads.push(tripleStr(subjectUri, NS.health + 'status', resource.status ?? 'completed'));

  // Vaccine code (CVX)
  const codings = extractCodings(resource.vaccineCode);
  for (const c of codings) {
    if (c.system === 'http://hl7.org/fhir/sid/cvx' || c.system === 'urn:oid:2.16.840.1.113883.12.292') {
      quads.push(tripleStr(subjectUri, NS.health + 'vaccineCode', `CVX-${c.code}`));
      break;
    }
  }

  // Manufacturer
  if (resource.manufacturer?.display) {
    quads.push(tripleStr(subjectUri, NS.health + 'manufacturer', resource.manufacturer.display));
  }

  // Lot number
  if (resource.lotNumber) {
    quads.push(tripleStr(subjectUri, NS.health + 'lotNumber', resource.lotNumber));
  }

  // Dose quantity
  if (resource.doseQuantity) {
    const qty = `${resource.doseQuantity.value} ${resource.doseQuantity.unit ?? ''}`.trim();
    quads.push(tripleStr(subjectUri, NS.health + 'doseQuantity', qty));
  }

  // Route
  if (resource.route) {
    const routeText = codeableConceptText(resource.route);
    if (routeText) quads.push(tripleStr(subjectUri, NS.health + 'route', routeText));
  }

  // Site
  if (resource.site) {
    const siteText = codeableConceptText(resource.site);
    if (siteText) quads.push(tripleStr(subjectUri, NS.health + 'site', siteText));
  }

  // Performer
  if (Array.isArray(resource.performer) && resource.performer.length > 0) {
    const performer = resource.performer[0]?.actor?.display;
    if (performer) quads.push(tripleStr(subjectUri, NS.health + 'administeringProvider', performer));
  }

  // Location
  if (resource.location?.display) {
    quads.push(tripleStr(subjectUri, NS.health + 'administeringLocation', resource.location.display));
  }

  // Notes
  if (resource.note && Array.isArray(resource.note)) {
    const noteText = resource.note.map((n: any) => n.text).filter(Boolean).join('; ');
    if (noteText) quads.push(tripleStr(subjectUri, NS.health + 'notes', noteText));
  }

  // Source record ID
  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'health:ImmunizationRecord'),
    warnings,
    resourceType: 'Immunization',
    cascadeType: 'health:ImmunizationRecord',
    _quads: quads,
  };
}

function convertCoverage(resource: any): ConversionResult & { _quads: Quad[] } {
  const warnings: string[] = [];
  const subjectUri = `urn:uuid:${randomUUID()}`;
  const quads: Quad[] = [];

  quads.push(tripleType(subjectUri, NS.coverage + 'InsurancePlan'));
  quads.push(...commonTriples(subjectUri));

  // Provider name (from payor)
  if (Array.isArray(resource.payor) && resource.payor.length > 0) {
    const payorName = resource.payor[0]?.display ?? 'Unknown Insurance';
    quads.push(tripleStr(subjectUri, NS.coverage + 'providerName', payorName));
  } else {
    quads.push(tripleStr(subjectUri, NS.coverage + 'providerName', 'Unknown Insurance'));
    warnings.push('No payor information found in Coverage resource');
  }

  // Member ID
  if (resource.subscriberId) {
    quads.push(tripleStr(subjectUri, NS.coverage + 'memberId', resource.subscriberId));
    quads.push(tripleStr(subjectUri, NS.coverage + 'subscriberId', resource.subscriberId));
  } else if (resource.identifier && Array.isArray(resource.identifier) && resource.identifier.length > 0) {
    const memberId = resource.identifier[0]?.value ?? '';
    quads.push(tripleStr(subjectUri, NS.coverage + 'memberId', memberId));
  } else {
    warnings.push('No member/subscriber ID found in Coverage resource');
  }

  // Coverage type (from FHIR type)
  if (resource.type) {
    const typeText = resource.type.coding?.[0]?.code ?? codeableConceptText(resource.type) ?? 'primary';
    quads.push(tripleStr(subjectUri, NS.coverage + 'coverageType', typeText));
  } else {
    quads.push(tripleStr(subjectUri, NS.coverage + 'coverageType', 'primary'));
  }

  // Class — group number, plan name, etc
  if (Array.isArray(resource.class)) {
    for (const cls of resource.class) {
      const clsType = cls.type?.coding?.[0]?.code ?? '';
      if (clsType === 'group' && cls.value) {
        quads.push(tripleStr(subjectUri, NS.coverage + 'groupNumber', cls.value));
        if (cls.name) quads.push(tripleStr(subjectUri, NS.coverage + 'planName', cls.name));
      } else if (clsType === 'plan' && cls.value) {
        quads.push(tripleStr(subjectUri, NS.coverage + 'planName', cls.name ?? cls.value));
      } else if (clsType === 'rxbin' && cls.value) {
        quads.push(tripleStr(subjectUri, NS.coverage + 'rxBin', cls.value));
      } else if (clsType === 'rxpcn' && cls.value) {
        quads.push(tripleStr(subjectUri, NS.coverage + 'rxPcn', cls.value));
      } else if (clsType === 'rxgroup' && cls.value) {
        quads.push(tripleStr(subjectUri, NS.coverage + 'rxGroup', cls.value));
      }
    }
  }

  // Relationship
  if (resource.relationship) {
    const relCode = resource.relationship.coding?.[0]?.code ?? 'self';
    quads.push(tripleStr(subjectUri, NS.coverage + 'subscriberRelationship', relCode));
  }

  // Period
  if (resource.period?.start) {
    // Coverage uses xsd:date, not dateTime
    quads.push(tripleDate(subjectUri, NS.coverage + 'effectiveStart', resource.period.start.substring(0, 10)));
  }
  if (resource.period?.end) {
    quads.push(tripleDate(subjectUri, NS.coverage + 'effectiveEnd', resource.period.end.substring(0, 10)));
  }

  // Source record ID
  if (resource.id) {
    quads.push(tripleStr(subjectUri, NS.health + 'sourceRecordId', resource.id));
  }

  return {
    turtle: '',
    jsonld: quadsToJsonLd(quads, 'coverage:InsurancePlan'),
    warnings,
    resourceType: 'Coverage',
    cascadeType: 'coverage:InsurancePlan',
    _quads: quads,
  };
}

// ---------------------------------------------------------------------------
// Main dispatcher: single FHIR resource -> Cascade
// ---------------------------------------------------------------------------

const SUPPORTED_TYPES = new Set([
  'MedicationStatement', 'MedicationRequest',
  'Condition',
  'AllergyIntolerance',
  'Observation',
  'Patient',
  'Immunization',
  'Coverage',
]);

export function convertFhirResourceToQuads(fhirResource: any): (ConversionResult & { _quads: Quad[] }) | null {
  const resourceType = fhirResource?.resourceType as string | undefined;
  if (!resourceType) return null;

  switch (resourceType) {
    case 'MedicationStatement':
    case 'MedicationRequest':
      return convertMedicationStatement(fhirResource);
    case 'Condition':
      return convertCondition(fhirResource);
    case 'AllergyIntolerance':
      return convertAllergyIntolerance(fhirResource);
    case 'Observation':
      if (isVitalSignObservation(fhirResource)) {
        return convertObservationVital(fhirResource);
      }
      return convertObservationLab(fhirResource);
    case 'Patient':
      return convertPatient(fhirResource);
    case 'Immunization':
      return convertImmunization(fhirResource);
    case 'Coverage':
      return convertCoverage(fhirResource);
    default:
      return null;
  }
}

export async function convertFhirToCascade(fhirResource: any): Promise<ConversionResult> {
  const result = convertFhirResourceToQuads(fhirResource);
  if (!result) {
    return {
      turtle: '',
      warnings: [`Unsupported FHIR resource type: ${fhirResource?.resourceType ?? 'unknown'}`],
      resourceType: fhirResource?.resourceType ?? 'unknown',
      cascadeType: 'unknown',
    };
  }

  const turtle = await quadsToTurtle(result._quads);
  return {
    turtle,
    jsonld: result.jsonld,
    warnings: result.warnings,
    resourceType: result.resourceType,
    cascadeType: result.cascadeType,
  };
}

// ---------------------------------------------------------------------------
// Cascade -> FHIR (reverse conversion)
// ---------------------------------------------------------------------------

/**
 * Convert Cascade Turtle to FHIR R4 JSON.
 *
 * Parses the Turtle using n3, identifies the resource type from rdf:type,
 * and maps Cascade predicates back to FHIR fields.
 *
 * Not all Cascade fields have FHIR equivalents -- lost fields are reported
 * as warnings.
 */
export async function convertCascadeToFhir(turtle: string): Promise<{
  resources: any[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const resources: any[] = [];

  // Parse Turtle
  const parser = new Parser();
  const quads: Quad[] = [];
  try {
    const parsed = parser.parse(turtle);
    quads.push(...parsed);
  } catch (err: any) {
    return { resources: [], warnings: [`Turtle parse error: ${err.message}`] };
  }

  // Group quads by subject
  const subjects = new Map<string, Quad[]>();
  for (const q of quads) {
    const subj = q.subject.value;
    if (!subjects.has(subj)) subjects.set(subj, []);
    subjects.get(subj)!.push(q);
  }

  for (const [_subjectUri, subjectQuads] of subjects) {
    // Find rdf:type
    const typeQuad = subjectQuads.find(q => q.predicate.value === NS.rdf + 'type');
    if (!typeQuad) continue;

    const rdfType = typeQuad.object.value;

    // Build a predicate->value map for quick access
    const pv = new Map<string, string[]>();
    for (const q of subjectQuads) {
      const pred = q.predicate.value;
      if (!pv.has(pred)) pv.set(pred, []);
      pv.get(pred)!.push(q.object.value);
    }

    const getFirst = (pred: string): string | undefined => pv.get(pred)?.[0];

    if (rdfType === NS.health + 'MedicationRecord') {
      const fhirResource: any = {
        resourceType: 'MedicationStatement',
        status: 'active',
        medicationCodeableConcept: { text: getFirst(NS.health + 'medicationName') ?? '' },
      };

      // isActive -> status
      const isActive = getFirst(NS.health + 'isActive');
      if (isActive === 'false') fhirResource.status = 'stopped';

      // Drug codes
      const drugCodes = pv.get(NS.clinical + 'drugCode') ?? [];
      const codingArr: any[] = [];
      for (const uri of drugCodes) {
        if (uri.startsWith(NS.rxnorm)) {
          codingArr.push({ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: uri.slice(NS.rxnorm.length) });
        } else if (uri.startsWith(NS.sct)) {
          codingArr.push({ system: 'http://snomed.info/sct', code: uri.slice(NS.sct.length) });
        }
      }
      if (codingArr.length > 0) {
        fhirResource.medicationCodeableConcept.coding = codingArr;
      }

      // Dosage
      const doseText = getFirst(NS.health + 'dose');
      if (doseText) {
        fhirResource.dosage = [{ text: doseText }];
      }

      // Dates
      const startDate = getFirst(NS.health + 'startDate');
      const endDate = getFirst(NS.health + 'endDate');
      if (startDate || endDate) {
        fhirResource.effectivePeriod = {};
        if (startDate) fhirResource.effectivePeriod.start = startDate;
        if (endDate) fhirResource.effectivePeriod.end = endDate;
      }

      // Source record ID
      const srcId = getFirst(NS.health + 'sourceRecordId');
      if (srcId) fhirResource.id = srcId;

      // Cascade-only fields that have no FHIR equivalent
      const cascadeOnlyFields = [
        NS.clinical + 'provenanceClass',
        NS.clinical + 'clinicalIntent',
        NS.cascade + 'schemaVersion',
        NS.health + 'medicationClass',
      ];
      for (const field of cascadeOnlyFields) {
        if (getFirst(field)) {
          const shortName = field.split('#')[1] ?? field;
          warnings.push(`Cascade field '${shortName}' has no FHIR equivalent and was not included in output`);
        }
      }

      resources.push(fhirResource);
    } else if (rdfType === NS.health + 'ConditionRecord') {
      const fhirResource: any = {
        resourceType: 'Condition',
        code: {
          text: getFirst(NS.health + 'conditionName') ?? '',
        },
      };

      // Status
      const status = getFirst(NS.health + 'status');
      if (status) {
        fhirResource.clinicalStatus = {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: status }],
        };
      }

      // Onset
      const onset = getFirst(NS.health + 'onsetDate');
      if (onset) fhirResource.onsetDateTime = onset;

      // Codes
      const codingArr: any[] = [];
      const icd10 = pv.get(NS.health + 'icd10Code') ?? [];
      for (const uri of icd10) {
        codingArr.push({ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: uri.startsWith(NS.icd10) ? uri.slice(NS.icd10.length) : uri });
      }
      const snomed = pv.get(NS.health + 'snomedCode') ?? [];
      for (const uri of snomed) {
        codingArr.push({ system: 'http://snomed.info/sct', code: uri.startsWith(NS.sct) ? uri.slice(NS.sct.length) : uri });
      }
      if (codingArr.length > 0) fhirResource.code.coding = codingArr;

      const srcId = getFirst(NS.health + 'sourceRecordId');
      if (srcId) fhirResource.id = srcId;

      resources.push(fhirResource);
    } else if (rdfType === NS.health + 'AllergyRecord') {
      const fhirResource: any = {
        resourceType: 'AllergyIntolerance',
        code: { text: getFirst(NS.health + 'allergen') ?? '' },
      };

      const cat = getFirst(NS.health + 'allergyCategory');
      if (cat) fhirResource.category = [cat];

      const severity = getFirst(NS.health + 'allergySeverity');
      const reaction = getFirst(NS.health + 'reaction');
      if (reaction || severity) {
        const rxn: any = {};
        if (reaction) rxn.manifestation = [{ text: reaction }];
        if (severity) rxn.severity = severity;
        fhirResource.reaction = [rxn];
      }

      const onset = getFirst(NS.health + 'onsetDate');
      if (onset) fhirResource.onsetDateTime = onset;

      const srcId = getFirst(NS.health + 'sourceRecordId');
      if (srcId) fhirResource.id = srcId;

      resources.push(fhirResource);
    } else if (rdfType === NS.health + 'LabResultRecord') {
      const fhirResource: any = {
        resourceType: 'Observation',
        code: { text: getFirst(NS.health + 'testName') ?? '' },
        category: [{ coding: [{ code: 'laboratory' }] }],
      };

      // LOINC code
      const testCode = pv.get(NS.health + 'testCode') ?? [];
      const codingArr: any[] = [];
      for (const uri of testCode) {
        const code = uri.startsWith(NS.loinc) ? uri.slice(NS.loinc.length) : uri;
        codingArr.push({ system: 'http://loinc.org', code });
      }
      if (codingArr.length > 0) fhirResource.code.coding = codingArr;

      // Value
      const resultVal = getFirst(NS.health + 'resultValue');
      const resultUnit = getFirst(NS.health + 'resultUnit');
      if (resultVal) {
        const numVal = parseFloat(resultVal);
        if (!isNaN(numVal)) {
          fhirResource.valueQuantity = { value: numVal };
          if (resultUnit) fhirResource.valueQuantity.unit = resultUnit;
        } else {
          fhirResource.valueString = resultVal;
        }
      }

      // Date
      const perfDate = getFirst(NS.health + 'performedDate');
      if (perfDate) fhirResource.effectiveDateTime = perfDate;

      // Interpretation
      const interp = getFirst(NS.health + 'interpretation');
      if (interp) {
        const revInterpMap: Record<string, string> = {
          normal: 'N', abnormal: 'A', critical: 'HH', unknown: 'UNK',
        };
        fhirResource.interpretation = [{
          coding: [{ code: revInterpMap[interp] ?? interp }],
        }];
      }

      const srcId = getFirst(NS.health + 'sourceRecordId');
      if (srcId) fhirResource.id = srcId;

      resources.push(fhirResource);
    } else if (rdfType === NS.clinical + 'VitalSign') {
      const fhirResource: any = {
        resourceType: 'Observation',
        code: {},
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
      };

      // LOINC code
      const loincUri = getFirst(NS.clinical + 'loincCode');
      if (loincUri) {
        const code = loincUri.startsWith(NS.loinc) ? loincUri.slice(NS.loinc.length) : loincUri;
        fhirResource.code.coding = [{ system: 'http://loinc.org', code }];
      }
      const vitalName = getFirst(NS.clinical + 'vitalTypeName');
      if (vitalName) fhirResource.code.text = vitalName;

      // Value
      const value = getFirst(NS.clinical + 'value');
      const unit = getFirst(NS.clinical + 'unit');
      if (value) {
        fhirResource.valueQuantity = { value: parseFloat(value) };
        if (unit) fhirResource.valueQuantity.unit = unit;
      }

      // Date
      const effDate = getFirst(NS.clinical + 'effectiveDate');
      if (effDate) fhirResource.effectiveDateTime = effDate;

      const srcId = getFirst(NS.health + 'sourceRecordId');
      if (srcId) fhirResource.id = srcId;

      // Warn about Cascade-specific fields
      if (getFirst(NS.clinical + 'snomedCode')) {
        warnings.push("Cascade field 'snomedCode' has no standard FHIR Observation field and was not included");
      }

      resources.push(fhirResource);
    } else if (rdfType === NS.cascade + 'PatientProfile') {
      const fhirResource: any = {
        resourceType: 'Patient',
      };

      const dob = getFirst(NS.cascade + 'dateOfBirth');
      if (dob) fhirResource.birthDate = dob;

      const sex = getFirst(NS.cascade + 'biologicalSex');
      if (sex) {
        const sexMap: Record<string, string> = { male: 'male', female: 'female', intersex: 'other' };
        fhirResource.gender = sexMap[sex] ?? 'unknown';
      }

      const marital = getFirst(NS.cascade + 'maritalStatus');
      if (marital) {
        const maritalMap: Record<string, string> = {
          single: 'S', married: 'M', divorced: 'D', widowed: 'W',
          separated: 'A', domestic_partnership: 'T',
        };
        fhirResource.maritalStatus = {
          coding: [{ code: maritalMap[marital] ?? 'UNK' }],
          text: marital,
        };
      }

      const profileId = getFirst(NS.cascade + 'profileId');
      if (profileId) fhirResource.id = profileId;

      // Warn about Cascade-only fields
      const cascadeOnly = ['computedAge', 'ageGroup', 'genderIdentity'];
      for (const field of cascadeOnly) {
        if (getFirst(NS.cascade + field)) {
          warnings.push(`Cascade field '${field}' has no FHIR Patient equivalent and was not included`);
        }
      }

      resources.push(fhirResource);
    } else if (rdfType === NS.health + 'ImmunizationRecord') {
      const fhirResource: any = {
        resourceType: 'Immunization',
        status: getFirst(NS.health + 'status') ?? 'completed',
        vaccineCode: { text: getFirst(NS.health + 'vaccineName') ?? '' },
      };

      const adminDate = getFirst(NS.health + 'administrationDate');
      if (adminDate) fhirResource.occurrenceDateTime = adminDate;

      const vaccineCode = getFirst(NS.health + 'vaccineCode');
      if (vaccineCode) {
        // Strip "CVX-" prefix
        const code = vaccineCode.startsWith('CVX-') ? vaccineCode.slice(4) : vaccineCode;
        fhirResource.vaccineCode.coding = [{ system: 'http://hl7.org/fhir/sid/cvx', code }];
      }

      const manufacturer = getFirst(NS.health + 'manufacturer');
      if (manufacturer) fhirResource.manufacturer = { display: manufacturer };

      const lotNumber = getFirst(NS.health + 'lotNumber');
      if (lotNumber) fhirResource.lotNumber = lotNumber;

      const srcId = getFirst(NS.health + 'sourceRecordId');
      if (srcId) fhirResource.id = srcId;

      resources.push(fhirResource);
    } else if (rdfType === NS.coverage + 'InsurancePlan') {
      const fhirResource: any = {
        resourceType: 'Coverage',
        status: 'active',
      };

      const providerName = getFirst(NS.coverage + 'providerName');
      if (providerName) fhirResource.payor = [{ display: providerName }];

      const memberId = getFirst(NS.coverage + 'memberId');
      if (memberId) fhirResource.subscriberId = memberId;

      const groupNum = getFirst(NS.coverage + 'groupNumber');
      const planName = getFirst(NS.coverage + 'planName');
      const classArr: any[] = [];
      if (groupNum) classArr.push({ type: { coding: [{ code: 'group' }] }, value: groupNum, name: planName });
      else if (planName) classArr.push({ type: { coding: [{ code: 'plan' }] }, value: planName });
      if (classArr.length > 0) fhirResource.class = classArr;

      const start = getFirst(NS.coverage + 'effectiveStart');
      const end = getFirst(NS.coverage + 'effectiveEnd');
      if (start || end) {
        fhirResource.period = {};
        if (start) fhirResource.period.start = start;
        if (end) fhirResource.period.end = end;
      }

      const rel = getFirst(NS.coverage + 'subscriberRelationship');
      if (rel) fhirResource.relationship = { coding: [{ code: rel }] };

      const srcId = getFirst(NS.health + 'sourceRecordId');
      if (srcId) fhirResource.id = srcId;

      resources.push(fhirResource);
    } else {
      warnings.push(`Unknown Cascade RDF type: ${rdfType}`);
    }
  }

  return { resources, warnings };
}

// ---------------------------------------------------------------------------
// Batch conversion (FHIR Bundle support)
// ---------------------------------------------------------------------------

/**
 * Convert an entire FHIR input (single resource or Bundle) to Cascade format.
 */
export async function convert(
  input: string,
  from: InputFormat,
  to: OutputFormat,
  outputSerialization: 'turtle' | 'jsonld' = 'turtle',
): Promise<BatchConversionResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const results: ConversionResult[] = [];

  if (from === 'fhir' && (to === 'cascade' || to === 'turtle' || to === 'jsonld')) {
    // FHIR -> Cascade
    let parsed: any;
    try {
      parsed = JSON.parse(input);
    } catch {
      return {
        success: false, output: '', format: to, resourceCount: 0,
        warnings: [], errors: ['Invalid JSON input'], results: [],
      };
    }

    // Collect resources from Bundle or single resource
    const fhirResources: any[] = [];
    if (parsed.resourceType === 'Bundle' && Array.isArray(parsed.entry)) {
      for (const entry of parsed.entry) {
        if (entry.resource) fhirResources.push(entry.resource);
      }
    } else if (parsed.resourceType) {
      fhirResources.push(parsed);
    } else {
      return {
        success: false, output: '', format: to, resourceCount: 0,
        warnings: [], errors: ['Input does not appear to be a FHIR resource or Bundle'], results: [],
      };
    }

    const allQuads: Quad[] = [];
    for (const res of fhirResources) {
      if (!SUPPORTED_TYPES.has(res.resourceType)) {
        warnings.push(`Skipping unsupported FHIR resource type: ${res.resourceType}`);
        continue;
      }
      const result = convertFhirResourceToQuads(res);
      if (result) {
        allQuads.push(...result._quads);
        results.push({
          turtle: '', // will be filled with combined output
          jsonld: result.jsonld,
          warnings: result.warnings,
          resourceType: result.resourceType,
          cascadeType: result.cascadeType,
        });
        warnings.push(...result.warnings);
      }
    }

    if (allQuads.length === 0) {
      return {
        success: false, output: '', format: to, resourceCount: 0,
        warnings, errors: ['No convertible FHIR resources found'], results: [],
      };
    }

    // Determine output format
    let output: string;
    if (outputSerialization === 'jsonld' || to === 'jsonld') {
      const jsonLd = quadsToJsonLd(allQuads, results[0]?.cascadeType ?? '');
      output = JSON.stringify(jsonLd, null, 2);
    } else {
      output = await quadsToTurtle(allQuads);
    }

    return {
      success: true,
      output,
      format: to === 'cascade' ? (outputSerialization === 'jsonld' ? 'jsonld' : 'turtle') : to,
      resourceCount: results.length,
      warnings,
      errors,
      results,
    };
  } else if (from === 'cascade' && to === 'fhir') {
    // Cascade -> FHIR
    const { resources, warnings: convWarnings } = await convertCascadeToFhir(input);
    warnings.push(...convWarnings);

    if (resources.length === 0) {
      return {
        success: false, output: '', format: 'fhir', resourceCount: 0,
        warnings, errors: ['No resources converted from Cascade Turtle'], results: [],
      };
    }

    const output = resources.length === 1
      ? JSON.stringify(resources[0], null, 2)
      : JSON.stringify({ resourceType: 'Bundle', type: 'collection', entry: resources.map(r => ({ resource: r })) }, null, 2);

    return {
      success: true,
      output,
      format: 'fhir',
      resourceCount: resources.length,
      warnings,
      errors,
      results: resources.map(r => ({
        turtle: '',
        warnings: [],
        resourceType: r.resourceType,
        cascadeType: 'fhir',
      })),
    };
  } else if (from === 'c-cda') {
    return {
      success: false, output: '', format: to, resourceCount: 0,
      warnings: [], errors: ['C-CDA conversion is not yet supported'], results: [],
    };
  } else {
    return {
      success: false, output: '', format: to, resourceCount: 0,
      warnings: [], errors: [`Unsupported conversion: ${from} -> ${to}`], results: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/**
 * Detect the format of input data by inspecting its content.
 */
export function detectFormat(input: string): InputFormat | null {
  const trimmed = input.trim();

  // Check for FHIR JSON (has "resourceType")
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.resourceType) return 'fhir';
      if (parsed['@context'] || parsed['@type']) return 'cascade'; // JSON-LD
    } catch {
      // Not valid JSON
    }
  }

  // Check for Turtle (has @prefix declarations or common Cascade namespace URIs)
  if (
    trimmed.includes('@prefix') ||
    trimmed.includes('ns.cascadeprotocol.org') ||
    /^<[^>]+>\s+a\s+/.test(trimmed)
  ) {
    return 'cascade';
  }

  // Check for C-CDA (XML with ClinicalDocument root)
  if (trimmed.startsWith('<?xml') || trimmed.includes('<ClinicalDocument')) {
    return 'c-cda';
  }

  return null;
}
