/**
 * Shared types and namespace constants for FHIR conversion.
 *
 * Used by both fhir-to-cascade and cascade-to-fhir converters.
 */

import { DataFactory, Writer, type Quad } from 'n3';
import { createHash } from 'node:crypto';
import { normalizeMedName } from '../medication-normalize.js';
import { contentFingerprint, EMPTY_SEED, identitySeed } from '../identity.js';

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

/**
 * Cross-record edge resolution tally for one conversion batch: how many
 * reference edges (clinical:hasLabResult, coverage:relatedClaim, ...) were
 * rewritten to a real subject IRI vs dropped because the target was not in the
 * batch. `byPredicate` is keyed by the compacted predicate (e.g.
 * "clinical:hasLabResult"). Surfaced in the import summary.
 */
export interface EdgeResolutionSummary {
  resolved: number;
  unresolved: number;
  byPredicate: Record<string, { resolved: number; unresolved: number }>;
}

/**
 * One structured section of a source document: how many entries it offered, and
 * how many records the importer actually wrote.
 *
 * These two numbers were never compared, and three entire clinical sections
 * imported as zero records while the summary reported success and simply omitted
 * the empty buckets. A section that reads N structured entries and writes 0
 * records has to say so, whatever the cause — a handler defect, an unsupported
 * nesting, or genuinely empty entries.
 */
export interface SectionCensusEntry {
  /** Section title from the document, or the LOINC code when it has none. */
  label: string;
  /** Section-level LOINC code, where the document states one. */
  loinc?: string;
  /** `<entry>` elements the section offered. */
  entriesIn: number;
  /** Distinct record subjects the handler produced from them. */
  recordsOut: number;
  /** False when the section's templateId matches no structured handler. */
  handled: boolean;
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
  /**
   * Per-section entries-read vs records-written, for import paths that read a
   * sectioned document (C-CDA). Absent for formats without sections.
   */
  sectionCensus?: SectionCensusEntry[];
  /** Present for FHIR -> Cascade conversions; tallies cross-record edges. */
  edgeResolution?: EdgeResolutionSummary;
  /**
   * M1 trapped-literal lifting tally. Present only when this call performed the
   * lift itself; absent when the caller deferred it to a wider scope (see
   * `convert`'s `deferLiteralLifting`), in which case the caller owns the tally.
   */
  literalLifting?: import('../literal-lifting.js').LiteralLiftSummary;
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
  ndc: 'http://hl7.org/fhir/sid/ndc/',
  atc: 'http://www.whocc.no/atc/',
  icd10: 'http://hl7.org/fhir/sid/icd-10-cm/',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  prov: 'http://www.w3.org/ns/prov#',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  vcard: 'http://www.w3.org/2006/vcard/ns#',
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
  vcard: NS.vcard,
};

// ---------------------------------------------------------------------------
// FHIR coding-system to Cascade namespace mapping
// ---------------------------------------------------------------------------

export const CODING_SYSTEM_MAP: Record<string, string> = {
  'http://www.nlm.nih.gov/research/umls/rxnorm': NS.rxnorm,
  'urn:oid:2.16.840.1.113883.6.88': NS.rxnorm,
  'http://snomed.info/sct': NS.sct,
  'urn:oid:2.16.840.1.113883.6.96': NS.sct,      // SNOMED CT OID (C-CDA)
  'http://hl7.org/fhir/sid/ndc': NS.ndc,
  'urn:oid:2.16.840.1.113883.6.69': NS.ndc,      // NDC OID (C-CDA / HL7)
  'http://www.whocc.no/atc': NS.atc,
  'urn:oid:2.16.840.1.113883.6.73': NS.atc,      // WHO ATC OID
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
export function deterministicUuid(input: string): string {
  const hash = createHash('sha1').update(input).digest('hex');
  const v = ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${v}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Mint a deterministic subject URI from a FHIR resource.
 * - If resource.id is a valid UUID v4: returns urn:uuid:{resource.id}
 * - If resource.id exists but is not a UUID: returns urn:uuid:{deterministicUuid(resourceType:id)}
 * - If no resource.id: the seed comes from the resource's own non-volatile
 *   content, via the identity door. Never from randomness.
 *
 * This used to answer the id-less case with `randomUUID()`, so re-importing one
 * document minted a fresh identity for every id-less record in it and the pod
 * duplicated instead of reconciling — on every sync, silently. `Resource.id` is
 * optional in FHIR and real payloads omit it (transaction Bundles, contained
 * resources, hand-authored and exported documents), so this was reachable, not
 * theoretical.
 *
 * The with-id path is UNCHANGED, deliberately: an anonymous seed is
 * `anon-` + 64 hex = 69 characters, and FHIR caps `Resource.id` at 64, so a
 * content seed can never be mistaken for an id a source assigned, and no IRI
 * that a source id already determines moves.
 */
export function mintSubjectUri(resource: any, warnings?: string[]): string {
  const resourceTypeForLabel = (resource?.resourceType as string) ?? 'Resource';
  const { seed } = identitySeed({
    explicitId: resource?.id,
    content: resource,
    // Optional so that a caller with nothing to report stays source-compatible.
    // Every production converter has a warnings array and passes it, because a
    // tier-4 collapse the user never hears about is the failure this whole
    // module exists to prevent.
    warnings,
    label: `${resourceTypeForLabel} (no id)`,
  });
  if (UUID_V4_REGEX.test(seed)) return `urn:uuid:${seed}`;
  const resourceType = (resource?.resourceType as string) ?? 'Unknown';
  return `urn:uuid:${deterministicUuid(`${resourceType}:${seed}`)}`;
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
 *   Else:                           hash `source` through the identity door
 *
 * The final tier used to be `randomUUID()`, labelled "true last resort". It was
 * more defensible than the other random fallbacks in this codebase — it fires
 * only after BOTH the content fields and a fallback id come up empty — but it
 * has the same consequence when it does fire, so it is gone. It is replaced by
 * a hash of the raw `source` object where a caller can supply one, and by a
 * deterministic per-type sentinel where it cannot.
 *
 * That sentinel COLLAPSES records rather than splitting them: two resources
 * with no identity-bearing content and no id are indistinguishable to every
 * part of this system, and merging things nothing can tell apart is a decision
 * a user can see and argue with, where minting a fresh IRI for each one is a
 * duplicate set that grows forever and never announces itself. The sentinel key
 * also cannot collide with the content tier: content entries are always `k=v`
 * pairs and always contain `=`, and an anonymous seed never does.
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
  /**
   * The raw source object, used only when the content fields and the fallback
   * id are both empty. Optional so that the ~20 existing call sites are
   * unaffected; supplying it simply gives the last tier something real to hash
   * instead of landing on the per-type sentinel.
   */
  source?: unknown,
  /** Collects a tier-4 collapse notice. See `mintSubjectUri` for why it is optional. */
  warnings?: string[],
  /**
   * How to name the record in a tier-4 collapse notice. Defaults to
   * `resourceType`, which is right at most call sites and wrong where the
   * identity `resourceType` is a shared canonical key rather than the source's
   * own type: a bare `MedicationStatement` mints under `MedicationRequest` (the
   * single medication identity used by every importer), and reporting the
   * collapse of a "MedicationRequest" to someone who imported a
   * MedicationStatement sends them looking for a record that is not there.
   */
  label?: string,
): string {
  // Filter out undefined/empty values and sort keys for stability. Values are
  // coerced to string before trimming: the type says string, but real-world
  // FHIR (e.g. an Apple Health Patient) can slip a non-string field through, and
  // String(s) === s for valid string inputs, so the derived URI is unchanged.
  const content = Object.entries(contentFields)
    .filter(([, v]) => v != null && String(v).trim().length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('|');

  if (content.length > 0) {
    return `urn:uuid:${deterministicUuid(`${resourceType}::${content}`)}`;
  }
  if (fallbackId) {
    return `urn:uuid:${deterministicUuid(`${resourceType}:${fallbackId}`)}`;
  }
  // Last tier: the identity door. Deterministic whether or not `source` was
  // supplied — with it, a hash of the resource's non-volatile content; without
  // it, the per-type sentinel. Never random.
  const { seed } = identitySeed({
    content: source,
    warnings,
    label: `${label ?? resourceType} (no id)`,
  });
  return `urn:uuid:${deterministicUuid(`${resourceType}::${seed}`)}`;
}

// ---------------------------------------------------------------------------
// The rule: a present `resource.id` wins
// ---------------------------------------------------------------------------

/**
 * Mint a subject IRI for a converter that carries its own curated content key:
 * THE SOURCE'S OWN IDENTIFIER DECIDES, and the curated key is what answers the
 * question when there is no identifier.
 *
 * WHY THIS EXISTS RATHER THAN `contentHashedUri(type, fields, resource.id, …)`
 * ---------------------------------------------------------------------------
 * That call reads as "identify by content, and fall back to the id", but
 * `contentHashedUri` consults `fallbackId` ONLY when every content field is
 * empty. On a real record they never are. So the id was not a fallback, it was
 * DEAD, and a distinct, stable, server-assigned identifier was discarded on
 * every record that carried one.
 *
 * That is how two records the source had deliberately kept apart ended up on
 * one IRI. It was measured first for lab results — a fasting glucose of 95 and
 * a post-prandial of 310, each with its own id, minting a single subject — and
 * the same call shape was in four more converters, so the same thing happened
 * to Conditions, allergies, immunizations and patients.
 *
 * THE RULE
 * --------
 * Identity answers "is this that record?", and the source's identifier is the
 * source answering it. Deciding that two records are the same THING is a
 * different judgement: it needs both records side by side and a trail saying it
 * happened, so it belongs to the reconciler, which has both, and not to the
 * identity layer, which sees one record at a time and can only overwrite.
 *
 * The merges this stops being silent are NOT lost. Every type routed through
 * here has a reconciler matcher that still finds them — a Condition on its
 * SNOMED code, an allergy on the allergen, an immunization on CVX plus date, a
 * patient on date of birth plus sex — all well above the match threshold. What
 * changes is that the merge now happens where it can be seen, counted, and
 * argued with, instead of in a hash.
 *
 * `convertObservationVital`, `convertProcedure`, `convertEncounter` and nine
 * other converters already did exactly this via `mintSubjectUri`. This is not a
 * new strategy; it is the end of a second one.
 *
 * WHAT THE CURATED KEY IS FOR
 * ---------------------------
 * Without an id, `mintSubjectUri` would hash the whole resource, which splits
 * on any incidental difference between two renderings of the same record. A
 * curated key is deliberately narrower and therefore tolerant — but only of
 * things that do not distinguish two records. Every field a converter
 * SERIALIZES and leaves out of its key is a field on which two records sharing
 * an IRI can disagree, which is the lab defect restated. So a key is widened
 * until that set is empty, and no further.
 *
 * @param resourceType the identity key's type prefix. Both tiers feed the same
 *                     template (`{type}:{id}` and `{type}::{fields}`), and an
 *                     anonymous content seed is 69 characters where FHIR caps
 *                     `Resource.id` at 64, so the two tiers cannot collide.
 */
export function idOrContentUri(
  resourceType: string,
  resource: any,
  contentFields: Record<string, string | undefined>,
  warnings?: string[],
): string {
  // Tier 1 — the source assigned an identifier. `mintSubjectUri` routes it
  // through the identity door, so the explicit-id tier is the same code path
  // every other converter in this file uses.
  if (typeof resource?.id === 'string' && resource.id.trim().length > 0) {
    return mintSubjectUri(resource, warnings);
  }
  // No `fallbackId`: this branch runs only when there is no id to fall back to.
  // Passing one here is what hid the defect above for so long.
  return contentHashedUri(resourceType, contentFields, undefined, resource, warnings);
}

/**
 * A stable token for a FHIR CodeableConcept, or `undefined` when it carries
 * nothing.
 *
 * Every coding is included as `system|code`, not just `coding[0].code`, because
 * reading one coding without its system is how a key stops telling two records
 * apart: two different code systems reusing the same digits collide, and a
 * resource whose first coding happens to be the local EHR's own numbering keys
 * on that instead of the standard code. Sorted, because `coding` is a set in
 * practice and two servers may enumerate it in different order — sorting can
 * only remove spurious SPLITS, never cause a merge, since a differing set still
 * sorts to a differing string.
 *
 * `text` is included because it is frequently the ONLY thing a record carries:
 * a Condition with `code.text: "Asthma"` and no coding would otherwise
 * contribute nothing to its own identity and merge with every other uncoded
 * condition for that patient.
 *
 * NOTE FOR CALLERS: pass the RAW concept. Do not pass a converter's display
 * value, which is typically `codeableConceptText(x) ?? 'Unknown …'`. A
 * placeholder in an identity key turns "we do not know" into "these are the
 * same record", and a content hash that succeeds with a constant is
 * indistinguishable from one that fails except that it merges.
 */
export function codeableConceptKey(cc: any): string | undefined {
  if (cc == null || typeof cc !== 'object') return undefined;
  const parts: string[] = [];
  if (Array.isArray(cc.coding)) {
    for (const c of cc.coding) {
      if (c?.code) parts.push(`${c.system ?? ''}|${c.code}`);
    }
  }
  if (typeof cc.text === 'string' && cc.text.trim().length > 0) parts.push(cc.text.trim());
  return canonicalSetKey(parts, ',');
}

/**
 * The canonical form of a SET-valued identity input, stated normatively in core
 * v3.6 on `cascade:cascadeUri`: discard empty members, deduplicate, sort by code
 * point, join with a fixed separator.
 *
 * WHAT THE DEDUPE CHANGES, PRECISELY. Sorting was already here. Deduplication is
 * the new half, and it moves an identity for exactly one kind of record: one
 * whose source listed the SAME coding more than once, which real bundles produce
 * when a resource is assembled from several sources. Those are the records the
 * rule exists to stop splitting. A record with one member, or with distinct
 * members, hashes byte-for-byte as it did before — a one-element array joins to
 * the bare element with any separator — which is what keeps every identity
 * already written exactly where it is. `tests/uri-generation.test.ts` pins that
 * as a golden value rather than leaving it as a claim.
 *
 * THE SEPARATOR IS A PARAMETER, AND THAT IS DELIBERATE. core v3.6 recommends
 * U+002C and requires it of NEW implementations, but explicitly lets an
 * implementation that already ships a different fixed separator keep it, because
 * changing a separator re-mints every identifier that site ever produced — the
 * precise harm the rule exists to prevent. This repository ships ',' at two
 * sites and ';' at one, so each caller passes the separator it already shipped
 * and none of them moves. The cross-implementation contract is the three
 * invariants (order independence, scalar agreement, duplicate independence), not
 * the byte string.
 *
 * DO NOT REACH FOR THIS FOR ORDERED INPUTS. It is for elements that are SETS:
 * `CodeableConcept.coding`, a repeating CodeableConcept, a category list. FHIR
 * `name[0]` is the primary name and a component or note list is a sequence;
 * sorting those merges records the source deliberately kept apart. `stableStringify`
 * preserves array order for that reason and is not built on this.
 */
export function canonicalSetKey(parts: string[], separator: string): string | undefined {
  const seen = new Set<string>();
  for (const p of parts) {
    const t = p.trim();
    if (t.length > 0) seen.add(t);
  }
  return seen.size > 0 ? [...seen].sort().join(separator) : undefined;
}

/**
 * The same, for a repeating CodeableConcept element (`Condition.category`,
 * `Immunization.programEligibility`, …), and tolerating the plain-string
 * members FHIR uses for `AllergyIntolerance.category`.
 */
export function codeableConceptSetKey(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.trim().length > 0) parts.push(item.trim());
      continue;
    }
    const key = codeableConceptKey(item);
    if (key) parts.push(key);
  }
  // ';' and not ',' — this site has always joined with ';' and changing it would
  // re-mint every identity it has ever produced. core v3.6 permits exactly this:
  // an existing site keeps its separator, and conformance is the three
  // invariants rather than the byte string. See canonicalSetKey.
  return canonicalSetKey(parts, ';');
}

/**
 * A fixed-length token standing for an arbitrary sub-object of a resource
 * (`AllergyIntolerance.reaction`, `Immunization.doseQuantity`, a `name` array).
 *
 * Reduced to a fingerprint rather than embedded raw for two reasons: the
 * identity string stays a fixed length however large the structure is, and free
 * text inside it cannot smuggle the `|` and `=` characters that
 * `contentHashedUri` uses as its own field separators into the key.
 */
export function structuredKey(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const fingerprint = contentFingerprint(value);
  return fingerprint === EMPTY_SEED ? undefined : fingerprint;
}

/**
 * Deterministic URI for a medication record. The single medication-identity
 * field set, shared by every importer (FHIR, C-CDA) and aligned with
 * sdk-typescript's `medicationUri` and the conformance vector
 * (`medication-lisinopril-rxnorm`): RxNorm + normalized drug name + start date
 * + patient, under the `MedicationRequest` resource type.
 *
 * The raw drug name is run through the shared `normalizeMedName` so brand/dose/
 * form variants collapse to one identity. Dose is intentionally excluded (a dose
 * change is a conflict on the same identity, surfaced by the reconciler, not a
 * new record). `startDate` is part of the identity; the matcher and retrieval
 * index deliberately key on code/name only.
 */
export function medicationUri(
  fields: { rxNormCode?: string; medicationName?: string; startDate?: string; patient?: string },
  fallbackId?: string,
  /** Raw source resource, forwarded to `contentHashedUri`'s salvage tier. */
  source?: unknown,
  /** Forwarded to `contentHashedUri`; collects a tier-4 collapse notice. */
  warnings?: string[],
  /**
   * The SOURCE's own resource type, for the tier-4 notice only. Identity is
   * always minted under `MedicationRequest` — that is the shared key every
   * importer agrees on — but a warning should name what the caller imported.
   */
  label?: string,
): string {
  return contentHashedUri(
    'MedicationRequest',
    {
      rxNormCode: fields.rxNormCode,
      normalizedName: fields.medicationName ? normalizeMedName(fields.medicationName) : undefined,
      startDate: fields.startDate,
      patient: fields.patient,
    },
    fallbackId,
    source,
    warnings,
    label,
  );
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
