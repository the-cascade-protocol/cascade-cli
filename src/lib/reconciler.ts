/**
 * Core reconciliation logic extracted from the reconcile command.
 *
 * Exported so that other commands (e.g., pod import) can reuse reconciliation
 * without going through the CLI layer.
 */

import { Parser, Writer, DataFactory } from 'n3';
import { NS, TURTLE_PREFIXES } from './fhir-converter/types.js';

const { namedNode, literal, quad: makeQuad } = DataFactory;

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface ReconcilerOptions {
  trustScores?: Record<string, number>;
  labTolerance?: number;
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
    };
    transformations: object[];
    unresolvedConflicts: object[];
  };
}

// ---------------------------------------------------------------------------
// Cascade record types
// ---------------------------------------------------------------------------

type CascadeRecordType =
  | 'health:MedicationRecord'
  | 'health:ConditionRecord'
  | 'health:AllergyRecord'
  | 'health:LabResultRecord'
  | 'health:ImmunizationRecord'
  | 'clinical:VitalSign'
  | 'cascade:PatientProfile'
  | 'coverage:InsurancePlan';

const KNOWN_TYPES: Record<string, CascadeRecordType> = {
  [NS.health + 'MedicationRecord']:   'health:MedicationRecord',
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

interface ParsedRecord {
  uri: string;
  type: CascadeRecordType;
  sourceSystem: string;
  properties: Map<string, string[]>;
}

export async function parseTurtle(turtle: string, defaultSystem: string): Promise<ParsedRecord[]> {
  return new Promise((resolve, reject) => {
    const parser = new Parser({ format: 'Turtle' });
    const bySubject = new Map<string, Array<{ pred: string; obj: string }>>();

    parser.parse(turtle, (error, quad) => {
      if (error) { reject(error); return; }
      if (!quad) {
        const records: ParsedRecord[] = [];
        for (const [uri, triples] of bySubject) {
          const typeTriple = triples.find(t => t.pred === NS.rdf + 'type');
          if (!typeTriple || !KNOWN_TYPES[typeTriple.obj]) continue;

          const properties = new Map<string, string[]>();
          for (const t of triples) {
            const existing = properties.get(t.pred);
            if (existing) existing.push(t.obj);
            else properties.set(t.pred, [t.obj]);
          }

          const sourceSystem = properties.get(NS.cascade + 'sourceSystem')?.[0] ?? defaultSystem;
          records.push({ uri, type: KNOWN_TYPES[typeTriple.obj], sourceSystem, properties });
        }
        resolve(records);
        return;
      }
      const subj = quad.subject.value;
      if (!bySubject.has(subj)) bySubject.set(subj, []);
      bySubject.get(subj)!.push({ pred: quad.predicate.value, obj: quad.object.value });
    });
  });
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

export function normalizeMedName(name: string): string {
  return name.toLowerCase()
    .replace(/\d+(\.\d+)?\s*(mg|mcg|g|ml|%|iu|units?|meq)\b/gi, '')
    .replace(/\b(oral|tablet|capsule|solution|injection|extended|release|er|xr|cr|sr|hr)\b/gi, '')
    .replace(/\s+/g, ' ').trim();
}

function normalizeConditionName(name: string): string {
  return name.toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

function getProp(r: ParsedRecord, pred: string): string | undefined {
  return r.properties.get(pred)?.[0];
}

function codeFromUri(uri: string): string {
  return uri.split('/').pop() ?? uri.split('#').pop() ?? uri;
}

function dateOnly(dt: string): string { return dt.split('T')[0] ?? dt; }

type MatchResult = { match: boolean; confidence: number; matchedOn: string };

function matchMedications(a: ParsedRecord, b: ParsedRecord): MatchResult {
  const rxA = (a.properties.get(NS.health + 'rxNormCode') ?? []).map(codeFromUri);
  const rxB = (b.properties.get(NS.health + 'rxNormCode') ?? []).map(codeFromUri);
  const shared = rxA.find(c => c && rxB.includes(c));
  if (shared) return { match: true, confidence: 1.0, matchedOn: `rxnorm:${shared}` };

  const nA = normalizeMedName(getProp(a, NS.health + 'medicationName') ?? '');
  const nB = normalizeMedName(getProp(b, NS.health + 'medicationName') ?? '');
  if (nA && nB && nA === nB) return { match: true, confidence: 0.85, matchedOn: `name:"${nA}"` };
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
  const cA = getProp(a, NS.health + 'cvxCode');
  const cB = getProp(b, NS.health + 'cvxCode');
  const dA = dateOnly(getProp(a, NS.health + 'administrationDate') ?? getProp(a, NS.health + 'startDate') ?? '');
  const dB = dateOnly(getProp(b, NS.health + 'administrationDate') ?? getProp(b, NS.health + 'startDate') ?? '');
  if (cA && cB && codeFromUri(cA) === codeFromUri(cB) && dA && dA === dB)
    return { match: true, confidence: 1.0, matchedOn: `cvx:${codeFromUri(cA)}+${dA}` };
  return { match: false, confidence: 0, matchedOn: '' };
}

function doRecordsMatch(a: ParsedRecord, b: ParsedRecord, tol: number): MatchResult {
  if (a.type !== b.type) return { match: false, confidence: 0, matchedOn: '' };
  switch (a.type) {
    case 'health:MedicationRecord':   return matchMedications(a, b);
    case 'health:ConditionRecord':    return matchConditions(a, b);
    case 'health:AllergyRecord':      return matchAllergies(a, b);
    case 'health:LabResultRecord':    return matchLabs(a, b, tol);
    case 'health:ImmunizationRecord': return matchImmunizations(a, b);
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
  if (a.type === 'health:MedicationRecord') {
    const nA = normalizeMedName(getProp(a, NS.health + 'medicationName') ?? '');
    const nB = normalizeMedName(getProp(b, NS.health + 'medicationName') ?? '');
    if (nA !== nB) return { matchType: 'near_duplicate' };
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

function resolveGroup(g: Group, trustScores: Record<string, number>, defaultTrust: number): Resolution {
  const trust = (sys: string) => trustScores[sys] ?? defaultTrust;

  if (g.records.length === 1) {
    return { canonical: g.records[0], mergedUris: [g.records[0].uri], mergedSystems: [g.records[0].sourceSystem], strategy: 'pass_through', resolved: true };
  }

  const ranked = [...g.records].sort((a, b) => {
    const td = trust(b.sourceSystem) - trust(a.sourceSystem);
    return td !== 0 ? td : completeness(b) - completeness(a);
  });

  const winner = ranked[0];
  const losers = ranked.slice(1);
  let strategy = 'trust_priority';
  let resolved = true;

  if (g.matchType === 'near_duplicate') {
    strategy = 'merge_values';
  } else if (g.matchType === 'status_conflict') {
    const diff = Math.abs(trust(ranked[0].sourceSystem) - trust(ranked[1].sourceSystem));
    if (diff < 0.05) { strategy = 'flag_unresolved'; resolved = false; }
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
// Serializer: resolved groups → Turtle
// ---------------------------------------------------------------------------

async function serializeGroups(
  groups: Group[],
  resolutions: Resolution[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const writer = new Writer({ prefixes: TURTLE_PREFIXES });

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const res = resolutions[i];
      const subj = namedNode(res.canonical.uri);

      for (const [pred, vals] of res.canonical.properties) {
        for (const val of vals) {
          const obj = val.startsWith('http') || val.startsWith('urn:') ? namedNode(val) : literal(val);
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

    writer.end((err, result) => err ? reject(err) : resolve(result));
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

  // Parse all inputs
  const allRecords: ParsedRecord[] = [];
  const sourceInfo: Array<{ system: string; count: number }> = [];

  for (const input of inputs) {
    const records = await parseTurtle(input.content, input.systemName);
    allRecords.push(...records);
    sourceInfo.push({ system: input.systemName, count: records.length });
  }

  // Match and group
  const groups: Group[] = [];
  const assigned = new Set<string>();

  for (let i = 0; i < allRecords.length; i++) {
    const a = allRecords[i];
    if (assigned.has(a.uri)) continue;
    if (a.type === 'cascade:PatientProfile' || a.type === 'coverage:InsurancePlan') {
      groups.push({ matchType: 'pass_through', confidence: 1.0, records: [a], matchedOn: 'profile' });
      assigned.add(a.uri);
      continue;
    }

    const matched = [a];
    let matchedOn = '';
    let bestConf = 1.0;

    for (let j = i + 1; j < allRecords.length; j++) {
      const b = allRecords[j];
      if (assigned.has(b.uri) || a.sourceSystem === b.sourceSystem) continue;
      const { match, confidence, matchedOn: mo } = doRecordsMatch(a, b, labTol);
      if (match && confidence >= 0.65) {
        matched.push(b);
        assigned.add(b.uri);
        if (!matchedOn) { matchedOn = mo; bestConf = confidence; }
      }
    }
    assigned.add(a.uri);

    if (matched.length === 1) {
      groups.push({ matchType: 'pass_through', confidence: 1.0, records: matched, matchedOn: '' });
    } else {
      const { matchType, conflictField, conflictValues } = classifyGroup(matched, labTol);
      groups.push({ matchType, confidence: bestConf, records: matched, matchedOn, conflictField, conflictValues });
    }
  }

  // Resolve
  const resolutions = groups.map(g => resolveGroup(g, trustScores, defaultTrust));

  // Serialize
  const turtle = await serializeGroups(groups, resolutions);

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
    };

    switch (g.matchType) {
      case 'exact_duplicate': exactDups++; break;
      case 'near_duplicate':  nearDups++; break;
      case 'status_conflict':
      case 'value_conflict':  res.resolved ? resolved++ : unresolved++; break;
    }

    if (g.matchType !== 'pass_through') transformations.push(t);
    if (!res.resolved) unresolvedList.push(t);
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
      },
      transformations,
      unresolvedConflicts: unresolvedList,
    },
  };
}
