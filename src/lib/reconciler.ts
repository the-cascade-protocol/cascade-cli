/**
 * Core reconciliation logic extracted from the reconcile command.
 *
 * Exported so that other commands (e.g., pod import) can reuse reconciliation
 * without going through the CLI layer.
 */

import { Parser, Writer, DataFactory } from 'n3';
import type { Quad, Quad_Subject, Quad_Object } from 'n3';
import { NS, TURTLE_PREFIXES } from './fhir-converter/types.js';
import { normalizeMedName, normalizeDose, normalizeFrequency, type DrugNameNormalizer } from './medication-normalize.js';
import { medicationCodeKeys, sharedMedicationCodeKey } from './code-keys.js';
import { cascadeTerminologyResolver } from './terminology.js';

// Re-export so existing consumers of the reconciler's normalizeMedName keep
// working. The canonical definition now lives in ./medication-normalize.ts
// (shared, byte-identical to sdk-typescript).
export { normalizeMedName };

const { namedNode, literal, blankNode, quad: makeQuad } = DataFactory;

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface ReconcilerOptions {
  trustScores?: Record<string, number>;
  labTolerance?: number;
  /**
   * Brand-to-generic resolver applied during medication name normalization, so
   * a brand and its generic (Zyrtec / cetirizine) dedupe without a shared code.
   * Defaults to the bundled Cascade terminology asset; pass
   * `identityTerminologyResolver` to disable (asset-free behaviour).
   */
  terminologyResolver?: DrugNameNormalizer;
  /**
   * When `false` (the opt-in guard, Checkup parity), matched records that come
   * from different provenance classes (`clinical:provenanceClass`) are flagged
   * for review instead of auto-merged. Defaults to `true` (merge allowed), since
   * cross-source dedup is the primary goal; set `false` for the conservative
   * stance that never silently merges across provenance.
   */
  allowCrossProvenanceMerge?: boolean;
}

export interface ReconcilerInput {
  content: string;    // Turtle string
  systemName: string;
}

export interface ReconcilerResult {
  turtle: string;
  report: {
    sources: Array<{ system: string; count: number }>;
    summary: {
      totalInputRecords: number;
      exactDuplicatesRemoved: number;
      nearDuplicatesMerged: number;
      conflictsResolved: number;
      conflictsUnresolved: number;
      finalRecordCount: number;
      /** Subjects preserved verbatim because their type is not reconcilable. */
      passthroughSubjects: number;
      /**
       * Record-to-record edge objects redirected from a merged-away (discarded)
       * subject to its surviving canonical subject during serialization
       * (R4, root backlog 3.13a). Zero when no referenced record was merged, e.g.
       * a fresh single import. Excludes lineage predicates (dangling by design).
       */
      edgeObjectsRewritten: number;
    };
    transformations: object[];
    unresolvedConflicts: object[];
  };
}

// ---------------------------------------------------------------------------
// Cascade record types
// ---------------------------------------------------------------------------

type CascadeRecordType =
  | 'clinical:Medication'
  | 'health:ConditionRecord'
  | 'health:AllergyRecord'
  | 'health:LabResultRecord'
  | 'health:ImmunizationRecord'
  | 'clinical:VitalSign'
  | 'cascade:PatientProfile'
  | 'coverage:InsurancePlan';

const KNOWN_TYPES: Record<string, CascadeRecordType> = {
  [NS.clinical + 'Medication']:        'clinical:Medication',
  [NS.health + 'ConditionRecord']:    'health:ConditionRecord',
  [NS.health + 'AllergyRecord']:      'health:AllergyRecord',
  [NS.health + 'LabResultRecord']:    'health:LabResultRecord',
  [NS.health + 'ImmunizationRecord']: 'health:ImmunizationRecord',
  [NS.clinical + 'VitalSign']:        'clinical:VitalSign',
  [NS.cascade + 'PatientProfile']:    'cascade:PatientProfile',
  [NS.coverage + 'InsurancePlan']:    'coverage:InsurancePlan',
};

// ---------------------------------------------------------------------------
// Parser: Turtle → records
// ---------------------------------------------------------------------------

interface RdfValue {
  value: string;
  /** xsd:* datatype URI for typed literals; undefined for URIs and plain strings */
  datatype?: string;
}

interface ParsedRecord {
  uri: string;
  type: CascadeRecordType;
  sourceSystem: string;
  properties: Map<string, RdfValue[]>;
}

export async function parseTurtle(turtle: string, defaultSystem: string): Promise<ParsedRecord[]> {
  return new Promise((resolve, reject) => {
    const parser = new Parser({ format: 'Turtle' });
    const bySubject = new Map<string, Array<{ pred: string; obj: RdfValue }>>();

    parser.parse(turtle, (error, quad) => {
      if (error) { reject(error); return; }
      if (!quad) {
        const records: ParsedRecord[] = [];
        for (const [uri, triples] of bySubject) {
          const typeTriple = triples.find(t => t.pred === NS.rdf + 'type');
          if (!typeTriple || !KNOWN_TYPES[typeTriple.obj.value]) continue;

          const properties = new Map<string, RdfValue[]>();
          for (const t of triples) {
            const existing = properties.get(t.pred);
            if (existing) {
              // Deduplicate: skip if this exact value is already present
              const isDup = existing.some(v => v.value === t.obj.value && v.datatype === t.obj.datatype);
              if (!isDup) existing.push(t.obj);
            } else {
              properties.set(t.pred, [t.obj]);
            }
          }

          const sourceSystem = properties.get(NS.cascade + 'sourceSystem')?.[0]?.value ?? defaultSystem;
          records.push({ uri, type: KNOWN_TYPES[typeTriple.obj.value], sourceSystem, properties });
        }
        resolve(records);
        return;
      }
      const subj = quad.subject.value;
      if (!bySubject.has(subj)) bySubject.set(subj, []);
      const obj = quad.object;
      const rdfVal: RdfValue = obj.termType === 'Literal' && obj.datatype?.value && obj.datatype.value !== NS.xsd + 'string'
        ? { value: obj.value, datatype: obj.datatype.value }
        : { value: obj.value };
      bySubject.get(subj)!.push({ pred: quad.predicate.value, obj: rdfVal });
    });
  });
}

// ---------------------------------------------------------------------------
// Passthrough: subjects the reconciler does not understand
// ---------------------------------------------------------------------------

/**
 * Collect the quads of every subject that is NOT a reconcilable record, i.e.
 * whose rdf:type is outside KNOWN_TYPES or that has no rdf:type at all.
 *
 * The reconciler only understands the KNOWN_TYPES record families. Everything
 * else (clinical:ClinicalDocument narrative documents and their
 * requiresLLMExtraction flags, encounters, imaging studies, procedures, FHIR
 * passthrough nodes, provenance activities, ...) must survive reconciliation
 * verbatim. Before this existed, any reconciliation pass silently dropped
 * those subjects from the merged output.
 */
async function collectPassthroughQuads(turtle: string): Promise<Quad[]> {
  return new Promise((resolve, reject) => {
    const parser = new Parser({ format: 'Turtle' });
    const quadsBySubject = new Map<string, Quad[]>();

    parser.parse(turtle, (error, quad) => {
      if (error) { reject(error); return; }
      if (!quad) {
        const passthrough: Quad[] = [];
        for (const quads of quadsBySubject.values()) {
          const typeQuad = quads.find(q => q.predicate.value === NS.rdf + 'type');
          if (typeQuad && KNOWN_TYPES[typeQuad.object.value]) continue; // reconciled elsewhere
          passthrough.push(...quads);
        }
        resolve(passthrough);
        return;
      }
      const subjKey = `${quad.subject.termType}:${quad.subject.value}`;
      const bucket = quadsBySubject.get(subjKey);
      if (bucket) bucket.push(quad);
      else quadsBySubject.set(subjKey, [quad]);
    });
  });
}

/** Stable identity for cross-input deduplication of passthrough quads. */
function quadKey(q: Quad): string {
  const o = q.object;
  const objKey = o.termType === 'Literal'
    ? `L:${o.value}|${o.datatype?.value ?? ''}|${o.language ?? ''}`
    : `${o.termType}:${o.value}`;
  return `${q.subject.termType}:${q.subject.value}|${q.predicate.value}|${objKey}`;
}

/**
 * Re-label blank nodes per input so labels from independent parses cannot
 * collide. Named-node quads (the converters' normal output) pass unchanged.
 */
function relabelQuadBlankNodes(q: Quad, inputIndex: number): Quad {
  if (q.subject.termType !== 'BlankNode' && q.object.termType !== 'BlankNode') return q;
  const subj: Quad_Subject = q.subject.termType === 'BlankNode'
    ? blankNode(`in${inputIndex}_${q.subject.value}`)
    : q.subject;
  const obj: Quad_Object = q.object.termType === 'BlankNode'
    ? blankNode(`in${inputIndex}_${q.object.value}`)
    : q.object;
  return makeQuad(subj, q.predicate, obj);
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function normalizeConditionName(name: string): string {
  return name.toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

function getProp(r: ParsedRecord, pred: string): string | undefined {
  return r.properties.get(pred)?.[0]?.value;
}

function codeFromUri(uri: string): string {
  return uri.split('/').pop() ?? uri.split('#').pop() ?? uri;
}

function dateOnly(dt: string): string { return dt.split('T')[0] ?? dt; }

// ---------------------------------------------------------------------------
// Medication divergence helpers (Phase 2: dose/frequency/status conflicts)
// ---------------------------------------------------------------------------

/**
 * FHIR/Cascade medication status values that mean the medication is NOT active.
 * Everything else (including `active`, `on-hold`, `draft`, `unknown`, or an
 * absent status) is treated as active. Used for the status-split so an active
 * record and a discontinued record of the same drug never collapse silently.
 */
const INACTIVE_MED_STATUSES = new Set([
  'stopped', 'discontinued', 'inactive', 'cancelled', 'canceled',
  'completed', 'entered-in-error',
]);

/** Coarse active/inactive classification of a medication's status string. */
function medicationActivity(status: string | undefined): 'active' | 'inactive' {
  if (!status) return 'active';
  return INACTIVE_MED_STATUSES.has(status.toLowerCase().trim()) ? 'inactive' : 'active';
}

/**
 * True when both values are present and differ after normalization.
 *
 * A value present on only one side is intentionally NOT a conflict: it is a
 * fill-in handled as a near-duplicate merge (resolveGroup copies the missing
 * field), not a user-actionable disagreement. This tightens Checkup's raw
 * nil-safe predicate (`a != b && (a != nil || b != nil)`) for the CLI, where a
 * conflict is a blocking gate (`cascade pod conflicts` exits 1) and drives a
 * keep-A / keep-B decision: only a genuine disagreement (e.g. 10 mg vs 20 mg)
 * warrants that, never "one source recorded a dose and the other didn't."
 */
function bothPresentAndDiffer(
  a: string | undefined,
  b: string | undefined,
  norm: (s: string) => string,
): boolean {
  if (a == null || b == null || a === '' || b === '') return false;
  return norm(a) !== norm(b);
}

/** True when exactly one of the two values is present (a mergeable fill-in). */
function onlyOneSide(a: string | undefined, b: string | undefined): boolean {
  const pa = a != null && a !== '';
  const pb = b != null && b !== '';
  return pa !== pb;
}

type MatchResult = { match: boolean; confidence: number; matchedOn: string };

/** All drug code URIs a record carries: clinical:rxNormCode + clinical:drugCode[]. */
function medCodeUris(r: ParsedRecord): string[] {
  const rx = (r.properties.get(NS.clinical + 'rxNormCode') ?? []).map(v => v.value);
  const codes = (r.properties.get(NS.clinical + 'drugCode') ?? []).map(v => v.value);
  return [...rx, ...codes];
}

/** Confidence per code-ladder tier at which two medications share an identity. */
const MED_TIER_CONFIDENCE: Record<string, number> = {
  rxnorm: 1.0,
  snomed: 0.95,
  ndc: 0.92,
  atc: 0.85,
  name: 0.85,
};

function matchMedications(a: ParsedRecord, b: ParsedRecord, resolver?: DrugNameNormalizer): MatchResult {
  // Walk the weighted code ladder (RxNorm > SNOMED > NDC > ATC > normalized
  // name) via the shared SDK primitive, so an NDC-only or SNOMED-only pair still
  // matches without an RxNorm code, instead of over-relying on the name match.
  // The resolver maps brand to generic so e.g. Zyrtec and cetirizine match.
  const nA = normalizeMedName(getProp(a, NS.clinical + 'drugName') ?? '', resolver);
  const nB = normalizeMedName(getProp(b, NS.clinical + 'drugName') ?? '', resolver);
  const keysA = medicationCodeKeys(medCodeUris(a), nA || undefined);
  const keysB = medicationCodeKeys(medCodeUris(b), nB || undefined);
  const shared = sharedMedicationCodeKey(keysA, keysB);
  if (shared) {
    const confidence = MED_TIER_CONFIDENCE[shared.system] ?? 0.80;
    const matchedOn = shared.system === 'name' ? `name:"${shared.value}"` : `${shared.system}:${shared.value}`;
    return { match: true, confidence, matchedOn };
  }

  // Partial-name fallback (substring containment), unchanged from the prior matcher.
  if (nA && nB && (nA.includes(nB) || nB.includes(nA))) return { match: true, confidence: 0.70, matchedOn: `partial-name` };
  return { match: false, confidence: 0, matchedOn: '' };
}

function matchConditions(a: ParsedRecord, b: ParsedRecord): MatchResult {
  const sA = getProp(a, NS.health + 'snomedCode');
  const sB = getProp(b, NS.health + 'snomedCode');
  if (sA && sB && codeFromUri(sA) === codeFromUri(sB)) return { match: true, confidence: 1.0, matchedOn: `snomed:${codeFromUri(sA)}` };

  const iA = getProp(a, NS.health + 'icd10Code');
  const iB = getProp(b, NS.health + 'icd10Code');
  if (iA && iB && codeFromUri(iA) === codeFromUri(iB)) return { match: true, confidence: 0.95, matchedOn: `icd10:${codeFromUri(iA)}` };

  const nA = normalizeConditionName(getProp(a, NS.health + 'conditionName') ?? '');
  const nB = normalizeConditionName(getProp(b, NS.health + 'conditionName') ?? '');
  if (nA && nB && nA === nB) return { match: true, confidence: 0.80, matchedOn: `name:"${nA}"` };
  return { match: false, confidence: 0, matchedOn: '' };
}

function matchAllergies(a: ParsedRecord, b: ParsedRecord): MatchResult {
  const nA = (getProp(a, NS.health + 'allergen') ?? '').toLowerCase().trim();
  const nB = (getProp(b, NS.health + 'allergen') ?? '').toLowerCase().trim();
  if (nA && nB && nA === nB) return { match: true, confidence: 0.90, matchedOn: `allergen:"${nA}"` };
  return { match: false, confidence: 0, matchedOn: '' };
}

function matchLabs(a: ParsedRecord, b: ParsedRecord, tol: number): MatchResult {
  const lA = getProp(a, NS.health + 'testCode');
  const lB = getProp(b, NS.health + 'testCode');
  const dA = dateOnly(getProp(a, NS.health + 'performedDate') ?? '');
  const dB = dateOnly(getProp(b, NS.health + 'performedDate') ?? '');
  const vA = parseFloat(getProp(a, NS.health + 'resultValue') ?? 'NaN');
  const vB = parseFloat(getProp(b, NS.health + 'resultValue') ?? 'NaN');
  const sameDay = dA && dB && dA === dB;
  const sameLoinc = lA && lB && codeFromUri(lA) === codeFromUri(lB);

  if (sameLoinc && sameDay) {
    if (!isNaN(vA) && !isNaN(vB)) {
      const diff = Math.abs(vA - vB) / Math.max(Math.abs(vA), 0.001);
      const conf = diff <= tol ? (diff === 0 ? 1.0 : 0.90) : 0.85;
      return { match: true, confidence: conf, matchedOn: `loinc:${codeFromUri(lA)}+${dA}` };
    }
    return { match: true, confidence: 0.90, matchedOn: `loinc:${codeFromUri(lA)}+${dA}` };
  }
  const nA = (getProp(a, NS.health + 'testName') ?? '').toLowerCase().trim();
  const nB = (getProp(b, NS.health + 'testName') ?? '').toLowerCase().trim();
  if (nA && nB && nA === nB && sameDay) return { match: true, confidence: 0.75, matchedOn: `name:"${nA}"+${dA}` };
  return { match: false, confidence: 0, matchedOn: '' };
}

function matchImmunizations(a: ParsedRecord, b: ParsedRecord): MatchResult {
  // Tier 1: CVX code + exact date (high confidence)
  const cA = getProp(a, NS.health + 'cvxCode');
  const cB = getProp(b, NS.health + 'cvxCode');
  const dA = dateOnly(getProp(a, NS.health + 'administrationDate') ?? getProp(a, NS.health + 'startDate') ?? '');
  const dB = dateOnly(getProp(b, NS.health + 'administrationDate') ?? getProp(b, NS.health + 'startDate') ?? '');

  if (cA && cB && codeFromUri(cA) === codeFromUri(cB) && dA && dA === dB)
    return { match: true, confidence: 1.0, matchedOn: `cvx:${codeFromUri(cA)}+${dA}` };

  // Tier 2: Vaccine name (normalized) + date -- fallback when CVX absent
  const nA = (getProp(a, NS.health + 'vaccineName') ?? '').toLowerCase().trim();
  const nB = (getProp(b, NS.health + 'vaccineName') ?? '').toLowerCase().trim();
  if (nA && nB && nA !== 'unknown vaccine' && nA === nB && dA && dA === dB)
    return { match: true, confidence: 0.80, matchedOn: `name:"${nA}"+${dA}` };

  // Tier 3: Vaccine name match, no date -- very conservative
  if (nA && nB && nA !== 'unknown vaccine' && nA === nB)
    return { match: true, confidence: 0.60, matchedOn: `name-only:"${nA}"` };

  return { match: false, confidence: 0, matchedOn: '' };
}

function matchVitalSigns(a: ParsedRecord, b: ParsedRecord): MatchResult {
  const lcA = getProp(a, NS.health + 'testCode');  // LOINC
  const lcB = getProp(b, NS.health + 'testCode');
  const dtA = dateOnly(getProp(a, NS.health + 'effectiveDate') ?? getProp(a, NS.health + 'performedDate') ?? '');
  const dtB = dateOnly(getProp(b, NS.health + 'effectiveDate') ?? getProp(b, NS.health + 'performedDate') ?? '');

  if (lcA && lcB && codeFromUri(lcA) === codeFromUri(lcB) && dtA && dtA === dtB) {
    // Same LOINC, same day -- check value proximity
    const vA = parseFloat(getProp(a, NS.health + 'value') ?? 'NaN');
    const vB = parseFloat(getProp(b, NS.health + 'value') ?? 'NaN');
    if (!isNaN(vA) && !isNaN(vB)) {
      const diff = Math.abs(vA - vB) / Math.max(Math.abs(vA), 0.001);
      if (diff <= 0.05) return { match: true, confidence: 0.95, matchedOn: `loinc:${codeFromUri(lcA)}+${dtA}` };
      if (diff <= 0.15) return { match: true, confidence: 0.75, matchedOn: `loinc-approx:${codeFromUri(lcA)}+${dtA}` };
    }
    return { match: true, confidence: 0.85, matchedOn: `loinc:${codeFromUri(lcA)}+${dtA}` };
  }
  return { match: false, confidence: 0, matchedOn: '' };
}

function matchPatientProfiles(a: ParsedRecord, b: ParsedRecord): MatchResult {
  const dobA = getProp(a, NS.cascade + 'dateOfBirth');
  const dobB = getProp(b, NS.cascade + 'dateOfBirth');
  const sexA = getProp(a, NS.cascade + 'biologicalSex');
  const sexB = getProp(b, NS.cascade + 'biologicalSex');

  if (dobA && dobB && dobA === dobB && sexA && sexB && sexA === sexB) {
    return { match: true, confidence: 0.95, matchedOn: `dob:${dobA}+sex:${sexA}` };
  }
  // Try DOB alone (lower confidence)
  if (dobA && dobB && dobA === dobB) {
    return { match: true, confidence: 0.75, matchedOn: `dob:${dobA}` };
  }
  return { match: false, confidence: 0, matchedOn: '' };
}

/**
 * Returns the confidence threshold to use when comparing two records.
 *
 * Records from summarization documents (LOINC 34133-9, e.g. MyChart "Summarization
 * of Episode Note") contain the patient's full history snapshot.  When the same
 * patient imports multiple such summaries, every clinical fact appears once per
 * summary export.  A lower threshold (0.50) catches these cross-summary duplicates
 * that would otherwise be missed at the standard threshold of 0.65.
 *
 * Additive documents (progress notes, discharge summaries) represent a single
 * encounter; their records are kept at the standard 0.65 threshold.
 */
function getMatchThreshold(a: ParsedRecord, b: ParsedRecord): number {
  const aIsSummary = getProp(a, NS.cascade + 'documentType') === 'summarization';
  const bIsSummary = getProp(b, NS.cascade + 'documentType') === 'summarization';
  if (aIsSummary || bIsSummary) return 0.50;
  return 0.65;
}

function doRecordsMatch(a: ParsedRecord, b: ParsedRecord, tol: number, resolver?: DrugNameNormalizer): MatchResult {
  if (a.type !== b.type) return { match: false, confidence: 0, matchedOn: '' };
  switch (a.type) {
    case 'clinical:Medication':        return matchMedications(a, b, resolver);
    case 'health:ConditionRecord':    return matchConditions(a, b);
    case 'health:AllergyRecord':      return matchAllergies(a, b);
    case 'health:LabResultRecord':    return matchLabs(a, b, tol);
    case 'health:ImmunizationRecord': return matchImmunizations(a, b);
    case 'clinical:VitalSign':        return matchVitalSigns(a, b);
    case 'cascade:PatientProfile':    return matchPatientProfiles(a, b);
    default:                          return { match: false, confidence: 0, matchedOn: '' };
  }
}

// ---------------------------------------------------------------------------
// Conflict classification
// ---------------------------------------------------------------------------

type MatchType = 'exact_duplicate' | 'near_duplicate' | 'status_conflict' | 'value_conflict' | 'pass_through';

function classifyGroup(
  records: ParsedRecord[],
  tol: number,
  resolver?: DrugNameNormalizer,
): { matchType: MatchType; conflictField?: string; conflictValues?: Record<string, string> } {
  if (records.length < 2) return { matchType: 'pass_through' };
  const [a, b] = records;

  if (a.type === 'health:ConditionRecord') {
    const sA = getProp(a, NS.health + 'status');
    const sB = getProp(b, NS.health + 'status');
    if (sA && sB && sA !== sB)
      return { matchType: 'status_conflict', conflictField: 'health:status', conflictValues: { [a.sourceSystem]: sA, [b.sourceSystem]: sB } };
  }
  if (a.type === 'health:AllergyRecord') {
    const sA = getProp(a, NS.health + 'allergySeverity');
    const sB = getProp(b, NS.health + 'allergySeverity');
    if (sA && sB && sA !== sB)
      return { matchType: 'value_conflict', conflictField: 'health:allergySeverity', conflictValues: { [a.sourceSystem]: sA, [b.sourceSystem]: sB } };
  }
  if (a.type === 'health:LabResultRecord') {
    const vA = parseFloat(getProp(a, NS.health + 'resultValue') ?? 'NaN');
    const vB = parseFloat(getProp(b, NS.health + 'resultValue') ?? 'NaN');
    if (!isNaN(vA) && !isNaN(vB)) {
      const diff = Math.abs(vA - vB) / Math.max(Math.abs(vA), 0.001);
      if (diff > tol) return { matchType: 'value_conflict', conflictField: 'health:resultValue', conflictValues: { [a.sourceSystem]: String(vA), [b.sourceSystem]: String(vB) } };
      if (diff > 0)   return { matchType: 'near_duplicate' };
    }
  }
  if (a.type === 'clinical:Medication') {
    // (1) Status split: an active record and a stopped/discontinued record of
    // the same drug is a clinically significant divergence, never a silent
    // merge. (Reference: Checkup SimplifiedImportProcessor splits active vs
    // stopped before dedup.)
    const actA = medicationActivity(getProp(a, NS.clinical + 'status'));
    const actB = medicationActivity(getProp(b, NS.clinical + 'status'));
    if (actA !== actB) {
      return {
        matchType: 'status_conflict',
        conflictField: 'clinical:status',
        conflictValues: {
          [a.sourceSystem]: getProp(a, NS.clinical + 'status') ?? '(none)',
          [b.sourceSystem]: getProp(b, NS.clinical + 'status') ?? '(none)',
        },
      };
    }

    // (2) Dose / frequency disagreement: the flagship conflict the Reconcile tab
    // exists for (e.g. "Lisinopril 10 mg" vs "20 mg"). Compared on the shared
    // normalized form so "10 mg" / "10mg" / "10 milligrams" do NOT conflict.
    const doseA = getProp(a, NS.clinical + 'dosage');
    const doseB = getProp(b, NS.clinical + 'dosage');
    if (bothPresentAndDiffer(doseA, doseB, normalizeDose)) {
      return {
        matchType: 'value_conflict',
        conflictField: 'clinical:dosage',
        conflictValues: { [a.sourceSystem]: doseA as string, [b.sourceSystem]: doseB as string },
      };
    }
    const freqA = getProp(a, NS.clinical + 'frequency') ?? getProp(a, NS.health + 'frequency');
    const freqB = getProp(b, NS.clinical + 'frequency') ?? getProp(b, NS.health + 'frequency');
    if (bothPresentAndDiffer(freqA, freqB, normalizeFrequency)) {
      return {
        matchType: 'value_conflict',
        conflictField: 'clinical:frequency',
        conflictValues: { [a.sourceSystem]: freqA as string, [b.sourceSystem]: freqB as string },
      };
    }

    // (3) No divergence. Mergeable differences (a different normalized name, or
    // a dose/frequency present on only one side) are near-duplicates so
    // resolveGroup fills in the missing fields; otherwise an exact duplicate.
    const nA = normalizeMedName(getProp(a, NS.clinical + 'drugName') ?? '', resolver);
    const nB = normalizeMedName(getProp(b, NS.clinical + 'drugName') ?? '', resolver);
    const mergeable = nA !== nB || onlyOneSide(doseA, doseB) || onlyOneSide(freqA, freqB);
    return { matchType: mergeable ? 'near_duplicate' : 'exact_duplicate' };
  }
  return { matchType: 'exact_duplicate' };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface Group {
  matchType: MatchType;
  confidence: number;
  records: ParsedRecord[];
  matchedOn: string;
  conflictField?: string;
  conflictValues?: Record<string, string>;
}

interface Resolution {
  canonical: ParsedRecord;
  mergedUris: string[];
  mergedSystems: string[];
  strategy: string;
  resolved: boolean;
}

function completeness(r: ParsedRecord): number {
  const skip = new Set([NS.rdf + 'type', NS.cascade + 'dataProvenance', NS.cascade + 'schemaVersion', NS.cascade + 'sourceSystem']);
  let n = 0;
  for (const [p] of r.properties) if (!skip.has(p)) n++;
  return n;
}

/**
 * Provenance-class boost added to a record's trust when selecting a merge
 * winner, mapping Checkup's evidence weighting (MedicationReconciler
 * `evidenceWeight`: +30/+20/+10/+5) onto the 0-1 trust scale. A high-provenance
 * record (e.g. HealthKit FHIR) can outrank a higher-trust source carrying weaker
 * provenance. Records without a `clinical:provenanceClass` get no boost.
 */
const PROVENANCE_BOOST: Record<string, number> = {
  healthKitFHIR: 0.30,
  pharmacyClaim: 0.20,
  userTracked: 0.10,
  imported: 0.05,
};

function provenanceBoost(r: ParsedRecord): number {
  const pc = getProp(r, NS.clinical + 'provenanceClass');
  return pc ? (PROVENANCE_BOOST[pc] ?? 0) : 0;
}

function resolveGroup(
  g: Group,
  trustScores: Record<string, number>,
  defaultTrust: number,
  allowCrossProvenanceMerge = true,
): Resolution {
  const trust = (sys: string) => trustScores[sys] ?? defaultTrust;
  // Effective winner score: source trust plus a provenance-class boost.
  const score = (r: ParsedRecord) => trust(r.sourceSystem) + provenanceBoost(r);

  if (g.records.length === 1) {
    return { canonical: g.records[0], mergedUris: [g.records[0].uri], mergedSystems: [g.records[0].sourceSystem], strategy: 'pass_through', resolved: true };
  }

  const ranked = [...g.records].sort((a, b) => {
    const sd = score(b) - score(a);
    return sd !== 0 ? sd : completeness(b) - completeness(a);
  });

  const winner = ranked[0];
  const losers = ranked.slice(1);
  let strategy = 'trust_priority';
  let resolved = true;

  const isMedication = g.records[0].type === 'clinical:Medication';

  if (g.matchType === 'near_duplicate') {
    strategy = 'merge_values';
  } else if (g.matchType === 'status_conflict') {
    if (isMedication) {
      // Active vs stopped of the same drug is a clinical divergence: always
      // user-resolved, never auto-merged by trust (the silent-merge danger).
      strategy = 'flag_unresolved';
      resolved = false;
    } else {
      // Conditions: auto-resolve by trust unless the two sources are near-equal.
      const diff = Math.abs(trust(ranked[0].sourceSystem) - trust(ranked[1].sourceSystem));
      if (diff < 0.05) { strategy = 'flag_unresolved'; resolved = false; }
    }
  } else if (g.matchType === 'value_conflict' && isMedication) {
    // Dose/frequency disagreement on the same medication: always user-resolved
    // so it reaches settings/pending-conflicts.ttl and the Reconcile tab,
    // rather than being silently collapsed by trust priority.
    strategy = 'flag_unresolved';
    resolved = false;
  }

  // Opt-in cross-provenance guard (Checkup parity): when a would-be merge spans
  // more than one provenance class, flag for review instead of silently merging
  // across provenance. Only affects the merge match types; existing conflicts
  // already flag.
  if (!allowCrossProvenanceMerge && (g.matchType === 'near_duplicate' || g.matchType === 'exact_duplicate')) {
    const provenanceClasses = new Set(
      g.records.map(r => getProp(r, NS.clinical + 'provenanceClass')).filter((v): v is string => !!v),
    );
    if (provenanceClasses.size > 1) {
      strategy = 'flag_cross_provenance';
      resolved = false;
    }
  }

  // Merge missing fields from lower-trust sources
  let canonical: ParsedRecord = winner;
  if (strategy === 'merge_values') {
    const mergedProps = new Map(winner.properties);
    const metaPreds = new Set([NS.rdf + 'type', NS.cascade + 'dataProvenance', NS.cascade + 'schemaVersion', NS.cascade + 'sourceSystem']);
    for (const src of losers) {
      for (const [pred, vals] of src.properties) {
        if (!metaPreds.has(pred) && !mergedProps.has(pred)) mergedProps.set(pred, vals);
      }
    }
    canonical = { ...winner, properties: mergedProps };
  }

  return {
    canonical,
    mergedUris: g.records.map(r => r.uri),
    mergedSystems: g.records.map(r => r.sourceSystem),
    strategy,
    resolved,
  };
}

// ---------------------------------------------------------------------------
// Edge re-dangling repair (R4, root backlog 3.13a)
// ---------------------------------------------------------------------------
//
// R1 resolved every record-to-record edge (clinical:hasLabResult,
// coverage:relatedClaim, clinical:hasEncounter, clinical:indicationReference)
// at conversion time, BEFORE reconciliation. The reconciler then merges
// near-duplicate records and DISCARDS the losing subjects, but it never rewrote
// other records' edge OBJECTS. So an edge pointing at a merged-away duplicate
// re-dangled on every multi-source / --reconcile-existing path. This section
// builds one discarded→canonical map over the run and rewrites matching edge
// objects (in reconciled groups AND passthrough quads) to the survivor.

/**
 * Predicates whose objects deliberately point at PRE-merge (now non-materialized)
 * subjects: they record the merge itself, so rewriting them to the survivor would
 * erase the provenance they exist to capture (mergedFrom → self-loop). Excluded
 * from the edge rewrite and dangling BY DESIGN per the ratified lineage decision
 * (root backlog 3.13: exclude, do not tombstone). Any graph-query surface should
 * treat these as references to historical, non-materialized subjects.
 */
const LINEAGE_PREDICATES: ReadonlySet<string> = new Set<string>([
  NS.cascade + 'mergedFrom',
  NS.prov + 'wasDerivedFrom',
  NS.cascade + 'discardedRecords',
  'https://ns.cascadeprotocol.org/workbench/v1#erasedRecord',
]);

/**
 * Build the discarded-subject → canonical-subject map over every merge decision
 * in the run (in-batch AND against existing pod content). A group of N>1 records
 * collapses to one canonical (resolveGroup's winner); the other N−1 subjects are
 * discarded and vanish from the output, so anything that referenced them must be
 * redirected here. Self-entries (an exact re-import whose duplicate shares the
 * canonical's content-hashed URI) are skipped so the map holds no A→A no-ops.
 */
export function buildDiscardedToCanonical(
  groups: Group[],
  resolutions: Resolution[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < groups.length; i++) {
    const canonicalUri = resolutions[i].canonical.uri;
    for (const r of groups[i].records) {
      if (r.uri !== canonicalUri) map.set(r.uri, canonicalUri);
    }
  }
  return map;
}

/**
 * Resolve a subject to its FINAL canonical by following the map transitively
 * (A→B→C lands on C), with a cycle guard so a malformed A→B→A can never spin.
 * Returns the input unchanged when it was never discarded. A single reconciler
 * run produces a star (each subject is assigned to exactly one group), not a
 * chain, so the transitive walk is defensive: it covers a future multi-pass
 * merge or pre-merged existing-pod content without ever looping.
 */
export function resolveCanonicalSubject(map: Map<string, string>, subject: string): string {
  let current = subject;
  const seen = new Set<string>([current]);
  let next = map.get(current);
  while (next !== undefined && next !== current) {
    if (seen.has(next)) return next; // cycle: stop on the already-seen canonical
    seen.add(next);
    current = next;
    next = map.get(current);
  }
  return current;
}

// ---------------------------------------------------------------------------
// Serializer: resolved groups → Turtle
// ---------------------------------------------------------------------------

async function serializeGroups(
  groups: Group[],
  resolutions: Resolution[],
  passthroughQuads: Quad[],
  discardedToCanonical: Map<string, string>,
): Promise<{ turtle: string; edgeObjectsRewritten: number }> {
  return new Promise((resolve, reject) => {
    const writer = new Writer({ prefixes: TURTLE_PREFIXES });
    let edgeObjectsRewritten = 0;

    // Redirect a NamedNode edge object that points at a merged-away (discarded)
    // subject to its surviving canonical subject; lineage predicates are left
    // dangling by design (see LINEAGE_PREDICATES). Returns the IRI to serialize
    // and counts every real redirect.
    const rewriteEdgeIri = (predicate: string, objectValue: string): string => {
      if (LINEAGE_PREDICATES.has(predicate)) return objectValue;
      const canonical = resolveCanonicalSubject(discardedToCanonical, objectValue);
      if (canonical !== objectValue) edgeObjectsRewritten++;
      return canonical;
    };

    // Non-reconcilable subjects are preserved verbatim, except that an edge
    // object pointing at a merged-away subject is redirected to the survivor.
    for (const q of passthroughQuads) {
      if (q.object.termType === 'NamedNode') {
        const rewritten = rewriteEdgeIri(q.predicate.value, q.object.value);
        if (rewritten !== q.object.value) {
          writer.addQuad(makeQuad(q.subject, q.predicate, namedNode(rewritten)));
          continue;
        }
      }
      writer.addQuad(q);
    }

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const res = resolutions[i];
      const subj = namedNode(res.canonical.uri);

      for (const [pred, vals] of res.canonical.properties) {
        for (const val of vals) {
          const isIri = val.value.startsWith('http') || val.value.startsWith('urn:');
          const obj = isIri
            ? namedNode(rewriteEdgeIri(pred, val.value))
            : val.datatype
              ? literal(val.value, namedNode(val.datatype))
              : literal(val.value);
          writer.addQuad(makeQuad(subj, namedNode(pred), obj));
        }
      }

      // Reconciliation status
      const status = !res.resolved ? 'unresolved-conflict'
        : g.matchType === 'pass_through' ? 'canonical'
        : (g.matchType === 'status_conflict' || g.matchType === 'value_conflict') ? 'conflict-resolved'
        : 'merged';
      writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'reconciliationStatus'), literal(status)));
      writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'sourceSystem'), literal(res.canonical.sourceSystem)));

      if (g.matchType !== 'pass_through' && res.mergedUris.length > 1) {
        for (const srcUri of res.mergedUris) {
          writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'mergedFrom'), namedNode(srcUri)));
          writer.addQuad(makeQuad(subj, namedNode(NS.prov + 'wasDerivedFrom'), namedNode(srcUri)));
        }
        writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'mergedSources'), literal(res.mergedSystems.join(', '))));
        writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'conflictResolution'), literal(res.strategy)));
        if (g.conflictField) writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'conflictField'), literal(g.conflictField)));
        if (g.conflictValues) {
          const valDesc = Object.entries(g.conflictValues).map(([s, v]) => `${s}: "${v}"`).join(' vs ');
          writer.addQuad(makeQuad(subj, namedNode(NS.cascade + 'conflictValues'), literal(valDesc)));
        }
      }
    }

    writer.end((err, result) => err ? reject(err) : resolve({ turtle: result, edgeObjectsRewritten }));
  });
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

export async function runReconciliation(
  inputs: ReconcilerInput[],
  options?: ReconcilerOptions,
): Promise<ReconcilerResult> {
  const trustScores: Record<string, number> = {
    'primary-care': 0.90,
    'specialist': 0.85,
    'hospital': 0.95,
    ...(options?.trustScores ?? {}),
  };
  const defaultTrust = 0.80;
  const labTol = options?.labTolerance ?? 0.05;
  // Brand-to-generic resolver for medication name matching. Defaults to the
  // bundled Cascade terminology asset so Zyrtec/cetirizine dedupe out of the box;
  // callers pass identityTerminologyResolver for asset-free behaviour.
  const resolver = options?.terminologyResolver ?? cascadeTerminologyResolver();

  // Parse all inputs
  const allRecords: ParsedRecord[] = [];
  const sourceInfo: Array<{ system: string; count: number }> = [];

  // Subjects the reconciler cannot reconcile are carried through verbatim,
  // deduplicated by full quad identity across inputs (so re-feeding existing
  // pod content alongside a re-import of the same document does not grow).
  const passthroughQuads: Quad[] = [];
  const seenPassthrough = new Set<string>();
  const passthroughSubjectKeys = new Set<string>();

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const records = await parseTurtle(input.content, input.systemName);
    allRecords.push(...records);
    sourceInfo.push({ system: input.systemName, count: records.length });

    for (const q of await collectPassthroughQuads(input.content)) {
      const key = quadKey(q);
      if (seenPassthrough.has(key)) continue;
      seenPassthrough.add(key);
      passthroughSubjectKeys.add(`${q.subject.termType}:${q.subject.value}`);
      passthroughQuads.push(relabelQuadBlankNodes(q, i));
    }
  }

  // Match and group
  const groups: Group[] = [];
  const assigned = new Set<string>();

  const hasExistingPod = allRecords.some(r => r.sourceSystem === 'existing-pod');

  if (hasExistingPod) {
    // ---------------------------------------------------------------------------
    // Fast path: O(n_new × k) type-indexed matching for --reconcile-existing mode
    // ---------------------------------------------------------------------------

    const existingRecords = allRecords.filter(r => r.sourceSystem === 'existing-pod');
    const newRecords = allRecords.filter(r => r.sourceSystem !== 'existing-pod');

    // Build a type index over existing records only
    const existingIndex = new Map<string, ParsedRecord[]>();
    for (const r of existingRecords) {
      const bucket = existingIndex.get(r.type);
      if (bucket) bucket.push(r);
      else existingIndex.set(r.type, [r]);
    }

    // Cross-batch pass: match each new record against same-type existing records
    for (const a of newRecords) {
      if (assigned.has(a.uri)) continue;
      if (a.type === 'coverage:InsurancePlan') {
        groups.push({ matchType: 'pass_through', confidence: 1.0, records: [a], matchedOn: 'coverage' });
        assigned.add(a.uri);
        continue;
      }

      const matched: ParsedRecord[] = [a];
      let matchedOn = '';
      let bestConf = 1.0;

      const candidates = existingIndex.get(a.type) ?? [];
      for (const b of candidates) {
        if (assigned.has(b.uri) || a.sourceSystem === b.sourceSystem) continue;
        const { match, confidence, matchedOn: mo } = doRecordsMatch(a, b, labTol, resolver);
        const threshold = getMatchThreshold(a, b);
        if (match && confidence >= threshold) {
          matched.push(b);
          assigned.add(b.uri);
          if (!matchedOn) { matchedOn = mo; bestConf = confidence; }
        }
      }
      assigned.add(a.uri);

      if (matched.length === 1) {
        groups.push({ matchType: 'pass_through', confidence: 1.0, records: matched, matchedOn: '' });
      } else {
        const { matchType, conflictField, conflictValues } = classifyGroup(matched, labTol, resolver);
        groups.push({ matchType, confidence: bestConf, records: matched, matchedOn, conflictField, conflictValues });
      }
    }

    // Within-batch pass: pairwise loop over newRecords only (existing-pod records
    // from the same sourceSystem never match each other)
    for (let i = 0; i < newRecords.length; i++) {
      const a = newRecords[i];
      if (assigned.has(a.uri)) continue;
      if (a.type === 'coverage:InsurancePlan') {
        // Already handled above; skip if already assigned
        continue;
      }

      const matched: ParsedRecord[] = [a];
      let matchedOn = '';
      let bestConf = 1.0;

      for (let j = i + 1; j < newRecords.length; j++) {
        const b = newRecords[j];
        if (assigned.has(b.uri) || a.sourceSystem === b.sourceSystem) continue;
        const { match, confidence, matchedOn: mo } = doRecordsMatch(a, b, labTol, resolver);
        const threshold = getMatchThreshold(a, b);
        if (match && confidence >= threshold) {
          matched.push(b);
          assigned.add(b.uri);
          if (!matchedOn) { matchedOn = mo; bestConf = confidence; }
        }
      }
      assigned.add(a.uri);

      if (matched.length === 1) {
        groups.push({ matchType: 'pass_through', confidence: 1.0, records: matched, matchedOn: '' });
      } else {
        const { matchType, conflictField, conflictValues } = classifyGroup(matched, labTol, resolver);
        groups.push({ matchType, confidence: bestConf, records: matched, matchedOn, conflictField, conflictValues });
      }
    }

    // Existing-pod pass-through: records not matched into any group must still
    // appear as their own pass-through groups so they are written back to the pod
    for (const r of existingRecords) {
      if (assigned.has(r.uri)) continue;
      groups.push({ matchType: 'pass_through', confidence: 1.0, records: [r], matchedOn: '' });
      assigned.add(r.uri);
    }

  } else {
    // ---------------------------------------------------------------------------
    // Type-indexed O(n × k/T) algorithm for single-batch reconciliation
    // ---------------------------------------------------------------------------

    // Build a type index so each record is only compared against same-type records
    const typeIndex = new Map<string, ParsedRecord[]>();
    for (const r of allRecords) {
      const bucket = typeIndex.get(r.type);
      if (bucket) bucket.push(r);
      else typeIndex.set(r.type, [r]);
    }

    for (const a of allRecords) {
      if (assigned.has(a.uri)) continue;
      if (a.type === 'coverage:InsurancePlan') {
        groups.push({ matchType: 'pass_through', confidence: 1.0, records: [a], matchedOn: 'coverage' });
        assigned.add(a.uri);
        continue;
      }

      const matched = [a];
      let matchedOn = '';
      let bestConf = 1.0;

      const candidates = typeIndex.get(a.type) ?? [];
      for (const b of candidates) {
        if (b === a || assigned.has(b.uri) || a.sourceSystem === b.sourceSystem) continue;
        const { match, confidence, matchedOn: mo } = doRecordsMatch(a, b, labTol, resolver);
        const threshold = getMatchThreshold(a, b);
        if (match && confidence >= threshold) {
          matched.push(b);
          assigned.add(b.uri);
          if (!matchedOn) { matchedOn = mo; bestConf = confidence; }
        }
      }
      assigned.add(a.uri);

      if (matched.length === 1) {
        groups.push({ matchType: 'pass_through', confidence: 1.0, records: matched, matchedOn: '' });
      } else {
        const { matchType, conflictField, conflictValues } = classifyGroup(matched, labTol, resolver);
        groups.push({ matchType, confidence: bestConf, records: matched, matchedOn, conflictField, conflictValues });
      }
    }
  }

  // Resolve
  const allowCrossProvenanceMerge = options?.allowCrossProvenanceMerge ?? true;
  const resolutions = groups.map(g => resolveGroup(g, trustScores, defaultTrust, allowCrossProvenanceMerge));

  // Edge re-dangling repair (R4, root backlog 3.13a): map every subject discarded
  // in a merge to its survivor, then rewrite matching edge objects at serialization.
  const discardedToCanonical = buildDiscardedToCanonical(groups, resolutions);

  // Serialize
  const { turtle, edgeObjectsRewritten } = await serializeGroups(
    groups, resolutions, passthroughQuads, discardedToCanonical,
  );

  // Build report
  let exactDups = 0, nearDups = 0, resolved = 0, unresolved = 0;
  const transformations: object[] = [];
  const unresolvedList: object[] = [];

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const res = resolutions[i];
    const t = {
      type: g.matchType,
      recordType: g.records[0].type,
      canonicalUri: res.canonical.uri,
      sources: g.records.map(r => r.sourceSystem),
      matchedOn: g.matchedOn,
      strategy: res.strategy,
      conflictField: g.conflictField,
      conflictValues: g.conflictValues,
      resolved: res.resolved,
      documentType: getProp(g.records[0], NS.cascade + 'documentType'),
    };

    if (!res.resolved && (g.matchType === 'exact_duplicate' || g.matchType === 'near_duplicate')) {
      // A would-be merge that the cross-provenance guard flagged: count it as an
      // unresolved conflict, not as a silently-applied merge.
      unresolved++;
    } else {
      switch (g.matchType) {
        case 'exact_duplicate': exactDups++; break;
        case 'near_duplicate':  nearDups++; break;
        case 'status_conflict':
        case 'value_conflict':  res.resolved ? resolved++ : unresolved++; break;
      }
    }

    if (g.matchType !== 'pass_through') transformations.push(t);
    if (!res.resolved) unresolvedList.push({ ...t, candidateUris: g.records.map(r => r.uri) });
  }

  return {
    turtle,
    report: {
      sources: sourceInfo,
      summary: {
        totalInputRecords: allRecords.length,
        exactDuplicatesRemoved: exactDups,
        nearDuplicatesMerged: nearDups,
        conflictsResolved: resolved,
        conflictsUnresolved: unresolved,
        finalRecordCount: groups.length,
        passthroughSubjects: passthroughSubjectKeys.size,
        edgeObjectsRewritten,
      },
      transformations,
      unresolvedConflicts: unresolvedList,
    },
  };
}
