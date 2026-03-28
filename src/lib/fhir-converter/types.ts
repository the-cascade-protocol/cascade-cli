/**
 * Shared types and namespace constants for FHIR conversion.
 *
 * Used by both fhir-to-cascade and cascade-to-fhir converters.
 */

import { DataFactory, Writer, type Quad } from 'n3';
import { randomUUID, createHash } from 'node:crypto';

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
  skippedCount: number;
  warnings: string[];
  errors: string[];
  results: ConversionResult[];
}

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/** Current Cascade Protocol schema version emitted on all converted records. */
export const SCHEMA_VERSION = '1.3';

// ---------------------------------------------------------------------------
// Namespace constants
// ---------------------------------------------------------------------------

export const NS = {
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
export const TURTLE_PREFIXES: Record<string, string> = {
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

export const CODING_SYSTEM_MAP: Record<string, string> = {
  'http://www.nlm.nih.gov/research/umls/rxnorm': NS.rxnorm,
  'urn:oid:2.16.840.1.113883.6.88': NS.rxnorm,
  'http://snomed.info/sct': NS.sct,
  'http://loinc.org': NS.loinc,
  'https://loinc.org': NS.loinc,
  'http://loinc.org/': NS.loinc,
  'urn:oid:2.16.840.1.113883.6.1': NS.loinc,   // LOINC OID (C-CDA / older HL7)
  'http://hl7.org/fhir/sid/icd-10-cm': NS.icd10,
  'http://hl7.org/fhir/sid/icd-10': NS.icd10,
};

/** Returns true for any known LOINC coding system URL variant. */
export function isLoincSystem(system: string | undefined): boolean {
  if (!system) return false;
  return CODING_SYSTEM_MAP[system] === NS.loinc;
}

// ---------------------------------------------------------------------------
// FHIR vital-sign LOINC code mapping
// ---------------------------------------------------------------------------

export const VITAL_LOINC_CODES: Record<string, { type: string; name: string; unit: string; snomedCode: string }> = {
  // Core vital signs (US Core Vital Signs profile)
  '8480-6': { type: 'bloodPressureSystolic', name: 'Systolic Blood Pressure', unit: 'mmHg', snomedCode: '271649006' },
  '8462-4': { type: 'bloodPressureDiastolic', name: 'Diastolic Blood Pressure', unit: 'mmHg', snomedCode: '271650006' },
  '55284-4': { type: 'bloodPressurePanel', name: 'Blood Pressure Panel', unit: 'mmHg', snomedCode: '75367002' },
  '85354-9': { type: 'bloodPressurePanel', name: 'Blood Pressure Panel', unit: 'mmHg', snomedCode: '75367002' },
  '8478-0': { type: 'meanBloodPressure', name: 'Mean Blood Pressure', unit: 'mmHg', snomedCode: '6797001' },
  '8867-4': { type: 'heartRate', name: 'Heart Rate', unit: 'bpm', snomedCode: '364075005' },
  '9279-1': { type: 'respiratoryRate', name: 'Respiratory Rate', unit: 'breaths/min', snomedCode: '86290005' },
  '8310-5': { type: 'bodyTemperature', name: 'Body Temperature', unit: 'degC', snomedCode: '386725007' },
  '8331-1': { type: 'bodyTemperatureOral', name: 'Body Temperature (Oral)', unit: 'degC', snomedCode: '386725007' },
  '2708-6': { type: 'oxygenSaturation', name: 'Oxygen Saturation', unit: '%', snomedCode: '431314004' },
  '59408-5': { type: 'oxygenSaturation', name: 'Oxygen Saturation (Pulse Ox)', unit: '%', snomedCode: '431314004' },
  '29463-7': { type: 'bodyWeight', name: 'Body Weight', unit: 'kg', snomedCode: '27113001' },
  '8302-2': { type: 'bodyHeight', name: 'Body Height', unit: 'cm', snomedCode: '50373000' },
  '39156-5': { type: 'bmi', name: 'Body Mass Index', unit: 'kg/m2', snomedCode: '60621009' },
  // Pain
  '72514-3': { type: 'painSeverity', name: 'Pain Severity (0-10 NRS)', unit: '{score}', snomedCode: '225908003' },
  // Pediatric growth measurements
  '9843-4': { type: 'headCircumference', name: 'Head Occipital-Frontal Circumference', unit: 'cm', snomedCode: '363812007' },
  '8289-1': { type: 'headCircumferencePercentile', name: 'Head Circumference Percentile', unit: '%', snomedCode: '363812007' },
  '77606-2': { type: 'weightForLengthPercentile', name: 'Weight-for-Length Percentile', unit: '%', snomedCode: '248334005' },
  '59576-9': { type: 'bmiPercentile', name: 'BMI Percentile', unit: '%', snomedCode: '60621009' },
  // Ophthalmology
  '79893-4': { type: 'intraocularPressureRightEye', name: 'Intraocular Pressure (Right Eye)', unit: 'mm[Hg]', snomedCode: '41633001' },
  '79892-6': { type: 'intraocularPressureLeftEye', name: 'Intraocular Pressure (Left Eye)', unit: 'mm[Hg]', snomedCode: '41633001' },
};

/** FHIR observation categories that indicate vital signs */
export const VITAL_CATEGORIES = ['vital-signs', 'vital-sign'];

/** Set of FHIR resource types that receive full Layer 2 conversion */
export const SUPPORTED_TYPES = new Set([
  'MedicationStatement', 'MedicationRequest',
  'Condition',
  'AllergyIntolerance',
  'Observation',
  'Patient',
  'Immunization',
  'Coverage',
  'Procedure',
  'DocumentReference',
  'Encounter',
  'DiagnosticReport',
  'MedicationAdministration',
  'Device',
  'ImagingStudy',
  'Claim',
  'ExplanationOfBenefit',
]);

// ---------------------------------------------------------------------------
// Helper: date formatting
// ---------------------------------------------------------------------------

/**
 * Ensure an ISO 8601 dateTime string with timezone.
 * Bare dates (YYYY-MM-DD) get T00:00:00Z appended.
 */
export function ensureDateTimeWithTz(dateStr: string): string {
  if (!dateStr) return '';
  // Already has time component with timezone
  if (/T.+Z$/.test(dateStr) || /T.+[+-]\d{2}:\d{2}$/.test(dateStr)) {
    return dateStr;
  }
  // Has time component but no timezone -- append Z
  if (/T/.test(dateStr)) {
    return dateStr + 'Z';
  }
  // Date only -- append midnight UTC
  return dateStr + 'T00:00:00Z';
}

// ---------------------------------------------------------------------------
// Helper: extract coding info from FHIR codeable concept
// ---------------------------------------------------------------------------

export interface CodingInfo {
  system: string;
  code: string;
  display?: string;
}

export function extractCodings(codeableConcept: any): CodingInfo[] {
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

export function codeableConceptText(cc: any): string | undefined {
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

export function tripleStr(subject: string, predicate: string, value: string): Quad {
  return makeQuad(
    namedNode(subject),
    namedNode(predicate),
    literal(value),
  );
}

export function tripleTyped(subject: string, predicate: string, value: string, datatype: string): Quad {
  return makeQuad(
    namedNode(subject),
    namedNode(predicate),
    literal(value, namedNode(datatype)),
  );
}

export function tripleBool(subject: string, predicate: string, value: boolean): Quad {
  return makeQuad(
    namedNode(subject),
    namedNode(predicate),
    literal(String(value), namedNode(NS.xsd + 'boolean')),
  );
}

export function tripleInt(subject: string, predicate: string, value: number): Quad {
  return makeQuad(
    namedNode(subject),
    namedNode(predicate),
    literal(String(value), namedNode(NS.xsd + 'integer')),
  );
}

export function tripleDouble(subject: string, predicate: string, value: number): Quad {
  return makeQuad(
    namedNode(subject),
    namedNode(predicate),
    literal(String(value), namedNode(NS.xsd + 'double')),
  );
}

export function tripleRef(subject: string, predicate: string, object: string): Quad {
  return makeQuad(
    namedNode(subject),
    namedNode(predicate),
    namedNode(object),
  );
}

export function tripleType(subject: string, rdfType: string): Quad {
  return tripleRef(subject, NS.rdf + 'type', rdfType);
}

export function tripleDateTime(subject: string, predicate: string, dateStr: string): Quad {
  return tripleTyped(subject, predicate, ensureDateTimeWithTz(dateStr), NS.xsd + 'dateTime');
}

export function tripleDate(subject: string, predicate: string, dateStr: string): Quad {
  return tripleTyped(subject, predicate, dateStr, NS.xsd + 'date');
}

// ---------------------------------------------------------------------------
// Subject URI minting (deterministic from resource.id)
// ---------------------------------------------------------------------------

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Cascade Protocol Deterministic UUID (CDP-UUID)
 *
 * Algorithm:
 *   Input:   UTF-8 string
 *   Hash:    SHA-1(input) -> 40-char lowercase hex digest `h`
 *   Layout:  {h[0:8]}-{h[8:12]}-5{h[13:16]}-{v}{h[18:20]}-{h[20:32]}
 *            where v = (parseInt(h[16:18], 16) & 0x3f | 0x80).toString(16).padStart(2,'0')
 *            (Sets UUID version nibble to 5, variant bits to 10xx -- same layout as RFC 4122 v5
 *             but hashing the raw input string directly, not a namespace+name pair)
 *
 * Cross-SDK verification:
 *   SHA-1("hello") == "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d"
 *   deterministicUuid("hello") == "aaf4c61d-dcc5-58a2-9abe-de0f3b482cd9"
 *   (verify this value before using in any SDK implementation)
 */
function deterministicUuid(input: string): string {
  const hash = createHash('sha1').update(input).digest('hex');
  const v = ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${v}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Mint a deterministic subject URI from a FHIR resource.
 * - If resource.id is a valid UUID v4: returns urn:uuid:{resource.id}
 * - If resource.id exists but is not a UUID: returns urn:uuid:{deterministicUuid(resourceType:id)}
 * - If no resource.id: falls back to a random UUID (last resort)
 */
export function mintSubjectUri(resource: any): string {
  const id = resource?.id as string | undefined;
  if (!id) return `urn:uuid:${randomUUID()}`;
  if (UUID_V4_REGEX.test(id)) return `urn:uuid:${id}`;
  const resourceType = (resource?.resourceType as string) ?? 'Unknown';
  return `urn:uuid:${deterministicUuid(`${resourceType}:${id}`)}`;
}

/**
 * Generate a deterministic urn:uuid: URI from clinical content fields.
 * Used when no stable FHIR resource ID is available.
 *
 * Identity string construction:
 *   "{resourceType}::{sortedKeyValuePairs}"
 *   where sortedKeyValuePairs =
 *     entries of contentFields where value is non-null and non-empty after .trim()
 *     sorted ascending by key (localeCompare)
 *     mapped as "key=value"
 *     joined with "|"
 *
 * URI selection:
 *   If identity string has content: return "urn:uuid:" + deterministicUuid(identity)
 *   Else if fallbackId:             return "urn:uuid:" + deterministicUuid("{resourceType}:{fallbackId}")
 *   Else:                           return "urn:uuid:" + randomUUID()  (non-deterministic fallback)
 *
 * Example:
 *   contentHashedUri("Patient", { dob:"1985-03-15", sex:"male", family:"Smith", given:"John" })
 *   -> identity: "Patient::dob=1985-03-15|family=Smith|given=John|sex=male"
 *   -> urn:uuid:{deterministicUuid("Patient::dob=1985-03-15|family=Smith|given=John|sex=male")}
 *   -> urn:uuid:aba8c9f5-fdc6-5187-a363-0d5a7cb72438
 */
export function contentHashedUri(
  resourceType: string,
  contentFields: Record<string, string | undefined>,
  fallbackId?: string,
): string {
  // Filter out undefined/empty values and sort keys for stability
  const content = Object.entries(contentFields)
    .filter(([, v]) => v != null && v.trim().length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('|');

  if (content.length > 0) {
    return `urn:uuid:${deterministicUuid(`${resourceType}::${content}`)}`;
  }
  if (fallbackId) {
    return `urn:uuid:${deterministicUuid(`${resourceType}:${fallbackId}`)}`;
  }
  return `urn:uuid:${randomUUID()}`;  // true last resort
}

/** Common triples every Cascade resource gets */
export function commonTriples(subject: string): Quad[] {
  return [
    tripleRef(subject, NS.cascade + 'dataProvenance', NS.cascade + 'ClinicalGenerated'),
    tripleStr(subject, NS.cascade + 'schemaVersion', SCHEMA_VERSION),
  ];
}

// ---------------------------------------------------------------------------
// Quads -> Turtle serialization
// ---------------------------------------------------------------------------

export function quadsToTurtle(quads: Quad[]): Promise<string> {
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

export function quadsToJsonLd(quads: Quad[], _cascadeType: string): object {
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
