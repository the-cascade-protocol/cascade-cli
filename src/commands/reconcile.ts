/**
 * cascade reconcile <file1> <file2> [file3...] [options]
 *
 * Reconcile Cascade Protocol Turtle files from multiple sources into a
 * single normalized record set.
 *
 * Detects and resolves:
 *   - Exact duplicates (same record from multiple systems)
 *   - Near-duplicates (same record, minor value drift)
 *   - Status conflicts (active vs resolved)
 *   - Value conflicts (same test, different result)
 *
 * Adds reconciliation provenance to the merged output:
 *   cascade:reconciliationStatus  "canonical" | "merged" | "conflict-resolved" | "unresolved-conflict"
 *   cascade:mergedFrom            <source-uri1>, <source-uri2>, ...
 *   cascade:mergedSources         "system-a, system-b"
 *   cascade:conflictResolution    "trust_priority" | "merge_values"
 *
 * Options:
 *   --output <file>                     Write merged Turtle to file (default: stdout)
 *   --report <file>                     Write JSON transformation report to file
 *   --trust <system=score,...>          Set trust scores (e.g. hospital=0.95,specialist=0.85)
 *   --lab-tolerance <number>            Numeric tolerance for lab value matching (default: 0.05)
 *   --json                              Output report as JSON to stdout
 *
 * Examples:
 *   cascade reconcile primary-care.ttl specialist.ttl hospital.ttl --output merged.ttl --report report.json
 *   cascade reconcile *.ttl --trust hospital=0.95
 */

import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Parser, Writer, DataFactory } from 'n3';
import { printResult, printError, printVerbose, type OutputOptions } from '../lib/output.js';
import { NS, TURTLE_PREFIXES } from '../lib/fhir-converter/types.js';

const { namedNode, literal, quad: makeQuad } = DataFactory;

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

async function parseTurtle(turtle: string, defaultSystem: string): Promise<ParsedRecord[]> {
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

function normalizeMedName(name: string): string {
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
// Command registration
// ---------------------------------------------------------------------------

export function registerReconcileCommand(program: Command): void {
  program
    .command('reconcile')
    .description('Reconcile Cascade RDF from multiple sources into a normalized record set')
    .argument('<files...>', 'Cascade Turtle files to reconcile (2 or more)')
    .option('--output <file>', 'Write merged Turtle output to file (default: stdout)')
    .option('--report <file>', 'Write JSON transformation report to file')
    .option('--trust <scores>', 'Source trust scores: system1=0.9,system2=0.85')
    .option('--lab-tolerance <number>', 'Lab value match tolerance as fraction (default: 0.05)', '0.05')
    .action(async (files: string[], options: { output?: string; report?: string; trust?: string; labTolerance: string }) => {
      const globalOpts = program.opts() as OutputOptions;

      if (files.length < 2) {
        printError('reconcile requires at least 2 input files', globalOpts);
        process.exitCode = 1;
        return;
      }

      const trustScores: Record<string, number> = { 'primary-care': 0.90, 'specialist': 0.85, 'hospital': 0.95 };
      if (options.trust) {
        for (const pair of options.trust.split(',')) {
          const [sys, score] = pair.split('=');
          if (sys && score) trustScores[sys] = parseFloat(score);
        }
      }
      const defaultTrust = 0.80;
      const labTol = parseFloat(options.labTolerance);

      printVerbose(`Reconciling ${files.length} files`, globalOpts);
      printVerbose(`Trust scores: ${JSON.stringify(trustScores)}`, globalOpts);

      // Parse all files
      const allRecords: ParsedRecord[] = [];
      const sourceInfo: Array<{ system: string; file: string; count: number }> = [];

      for (const filePath of files) {
        let turtle: string;
        try {
          turtle = readFileSync(filePath, 'utf-8');
        } catch (err: any) {
          printError(`Cannot read file: ${filePath}`, globalOpts);
          process.exitCode = 1;
          return;
        }

        const systemName = basename(filePath, '.ttl').replace(/_/g, '-');
        const records = await parseTurtle(turtle, systemName);

        // Use the cascade:sourceSystem from the file if present, otherwise derive from filename
        const systemNames = [...new Set(records.map(r => r.sourceSystem).filter(s => s !== systemName))];
        const effectiveSystem = systemNames[0] ?? systemName;

        // Re-tag with effective system if all records share one
        for (const r of records) {
          if (r.sourceSystem === systemName && systemNames.length > 0) r.sourceSystem = effectiveSystem;
        }

        allRecords.push(...records);
        sourceInfo.push({ system: effectiveSystem, file: filePath, count: records.length });
        printVerbose(`  ${filePath}: ${records.length} records (system: ${effectiveSystem})`, globalOpts);
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
      const mergedTurtle = await serializeGroups(groups, resolutions);

      // Build report
      let exactDups = 0, nearDups = 0, resolved = 0, unresolved = 0, passThrough = 0;
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
          case 'pass_through':    passThrough++; break;
        }

        if (g.matchType !== 'pass_through') transformations.push(t);
        if (!res.resolved) unresolvedList.push(t);
      }

      const report = {
        generatedAt: new Date().toISOString(),
        sources: sourceInfo.map(s => ({ ...s, trustScore: trustScores[s.system] ?? defaultTrust })),
        summary: {
          totalInputRecords: allRecords.length,
          exactDuplicatesRemoved: exactDups,
          nearDuplicatesMerged: nearDups,
          conflictsResolved: resolved,
          conflictsUnresolved: unresolved,
          passThrough,
          finalRecordCount: groups.length,
        },
        transformations,
        unresolvedConflicts: unresolvedList,
      };

      // Output
      if (options.output) {
        writeFileSync(options.output, mergedTurtle);
        console.error(`Merged Turtle written to: ${options.output}`);
      } else {
        console.log(mergedTurtle);
      }

      if (options.report) {
        writeFileSync(options.report, JSON.stringify(report, null, 2));
        console.error(`Report written to: ${options.report}`);
      }

      // Summary to stderr
      const { summary } = report;
      console.error(`\nReconciliation summary:`);
      console.error(`  Input records:       ${summary.totalInputRecords}`);
      console.error(`  Exact duplicates:    -${summary.exactDuplicatesRemoved}`);
      console.error(`  Near-duplicates:     ~${summary.nearDuplicatesMerged} merged`);
      console.error(`  Conflicts resolved:  ${summary.conflictsResolved}`);
      if (summary.conflictsUnresolved > 0) {
        console.error(`  ⚠️  Unresolved:       ${summary.conflictsUnresolved}`);
      }
      console.error(`  Final records:       ${summary.finalRecordCount}`);

      if (globalOpts.json) {
        printResult(report, globalOpts);
      }
    });
}
