/**
 * The end-to-end harness for the pathology corpus.
 *
 * WHAT THIS IS FOR
 * ----------------
 * `test-fixtures/pathology/` holds synthetic documents that each reproduce ONE
 * named real-world import pathology. This file runs every one of them through
 * the pipeline a person actually runs — `cascade convert`, `pod init`,
 * `pod import --reconcile-existing` once per batch, `pod conflicts`,
 * `cascade validate` — and pins the census that comes out: records in, records
 * out, merges, conflicts, edges, violations.
 *
 * It exists so that import and reconciliation can be worked on iteratively
 * WITHOUT a real chart in the room. Every number below was measured, not
 * predicted, and several of them are wrong. The wrong ones are named in
 * `pathology-known-outcomes.ts` with the outcome that must replace them.
 *
 * FIXTURE TIERS ARE DIRECTORY-DISCOVERED
 * --------------------------------------
 * A tier is any directory containing a `scenarios.json` manifest. This file
 * scans `test-fixtures/` for them, so a second corpus arrives as a SIBLING
 * DIRECTORY with its own manifest and needs no change here. Tiers that must not
 * be committed (differently licensed corpora, or anything cloned locally) are
 * passed as absolute paths in `CASCADE_PATHOLOGY_TIERS`, delimited the way PATH
 * is, and are discovered identically.
 *
 * The manifest is JSON rather than TypeScript for the same reason: a tier can be
 * added, or an expectation corrected, without anyone editing the harness.
 *
 * THE TWO GATES
 * -------------
 * 1. KNOWN_OUTCOMES (`pathology-known-outcomes.ts`) is a ratchet, not a filter.
 *    A new deviation fails; a silently corrected one ALSO fails. The list can
 *    only shrink deliberately.
 *
 * 2. The reconciliation scorecard (`pathology-reconciliation-baseline.json`) is
 *    REPORT-ONLY. For the scenarios that carry a constructed ground truth about
 *    which records denote the same clinical event, it measures precision and
 *    recall over merge PAIRS and compares them to a committed baseline. It does
 *    not assert the numbers are good — two of them are terrible. It asserts they
 *    are known, so that a change to matching has to move the baseline on purpose.
 *
 * Every fixture is synthetic and authored for this repository.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';
import {
  KNOWN_OUTCOMES,
  assertEveryEntryWasExercised,
  assertKnownOutcomesForScenario,
  assertLedgerIsWellFormed,
  type ImportReportLite,
  type ScenarioObservation,
} from './pathology-known-outcomes.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'dist', 'index.js');
const FIXTURE_ROOT = path.join(REPO, 'test-fixtures');
const BASELINE_PATH = path.join(REPO, 'tests', 'pathology-reconciliation-baseline.json');

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const CASCADE = 'https://ns.cascadeprotocol.org/core/v1#';
const MERGED_FROM = CASCADE + 'mergedFrom';

/** Prefixes a manifest may use in a `values` expectation. */
const PREFIXES: Record<string, string> = {
  cascade: CASCADE,
  health: 'https://ns.cascadeprotocol.org/health/v1#',
  clinical: 'https://ns.cascadeprotocol.org/clinical/v1#',
  coverage: 'https://ns.cascadeprotocol.org/coverage/v1#',
};

/** `health:labCategory` -> the full IRI. Throws on an unknown prefix. */
function expandPrefixed(name: string): string {
  const [prefix, local] = name.split(':', 2);
  const ns = PREFIXES[prefix];
  if (!ns || local === undefined) {
    throw new Error(`scenario names "${name}", whose prefix the harness does not know`);
  }
  return ns + local;
}
/** Every predicate any importer uses to carry the source's own record id. */
const SOURCE_RECORD_ID = [
  CASCADE + 'sourceRecordId',
  'https://ns.cascadeprotocol.org/health/v1#sourceRecordId',
  'https://ns.cascadeprotocol.org/clinical/v1#sourceRecordId',
];

// ---------------------------------------------------------------------------
// Manifest types (the on-disk contract a fixture tier implements)
// ---------------------------------------------------------------------------

interface Batch {
  file: string;
  /** `--from` value for `cascade convert`. */
  from: string;
  /** `--source-system` passed to BOTH convert and import, when present. */
  sourceSystem?: string;
}

/**
 * One predicate's object values, as the pod must hold them.
 *
 * The count fields below say how many records came out; this says WHAT THEY SAY.
 * It exists because retiring a KNOWN_OUTCOMES entry has to move its expectation
 * into the scenario rather than delete it: several of those entries were about a
 * single predicate's values (which categories a lab carries, which interpretation
 * codes reached the pod, which doses a medication states), and a record census
 * cannot tell whether those are right. Without a slot for them, "the ledger is
 * allowed to shrink" would quietly mean "the pin is allowed to disappear".
 */
interface ValueExpectation {
  /** Prefixed class name whose subjects are read (`health:LabResultRecord`). */
  on: string;
  /** Prefixed predicate name (`health:labCategory`). */
  predicate: string;
  /** Every object value, sorted, duplicates included. */
  values: string[];
}

interface Expectations {
  /** Typed record subjects the converter emitted, per batch. */
  convertedRecords: number[];
  /** `resourceCount` the converter REPORTED, per batch. Not always the same number. */
  reportedResourceCount: number[];
  /** Record subjects the pod holds when every batch has been imported. */
  podRecords: number;
  /** Those subjects by type local name. */
  podRecordsByType: Record<string, number>;
  /** exactDuplicatesRemoved + nearDuplicatesMerged on the final batch. */
  merges: number;
  /** Rows in `pod conflicts --format json`. */
  conflicts: number;
  /** `edgeResolution.totalInPod` on the final batch. */
  edgesInPod: number;
  /** `sh:Violation` results from `cascade validate` over the pod. */
  violations: number;
  /** Import-time warnings across every batch. */
  importWarnings: number;
  /** Object values the pod must hold, per predicate. Optional. */
  values?: ValueExpectation[];
  /**
   * `sourceBreakdown` on the FIRST batch's import report. Optional, and present
   * where WHICH source label the records land under is the point rather than
   * merely how many there are.
   */
  sourceBreakdown?: Record<string, number>;
}

interface Scenario {
  id: string;
  pathology: string;
  batches: Batch[];
  expect: Expectations;
  /**
   * The complete partition of the records under evaluation into the clinical
   * events they denote, by SOURCE record id. Present only for scenarios where a
   * truth exists by construction. Records outside this universe (patient
   * profiles, reports) are not scored.
   */
  groundTruth?: string[][];
}

interface Tier {
  dir: string;
  name: string;
  scenarios: Scenario[];
}

// ---------------------------------------------------------------------------
// Tier discovery
// ---------------------------------------------------------------------------

function discoverTiers(): Tier[] {
  const candidates: string[] = [];
  for (const entry of fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(path.join(FIXTURE_ROOT, entry.name));
  }
  const external = process.env.CASCADE_PATHOLOGY_TIERS;
  if (external) {
    for (const p of external.split(path.delimiter).filter(Boolean)) candidates.push(p);
  }

  const tiers: Tier[] = [];
  for (const dir of candidates) {
    const manifest = path.join(dir, 'scenarios.json');
    if (!fs.existsSync(manifest)) continue;
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf-8')) as { tier: string; scenarios: Scenario[] };
    tiers.push({ dir, name: parsed.tier, scenarios: parsed.scenarios });
  }
  return tiers.sort((a, b) => a.name.localeCompare(b.name));
}

const TIERS = discoverTiers();
const ALL_SCENARIOS: Array<{ tier: Tier; scenario: Scenario }> = TIERS.flatMap((tier) =>
  tier.scenarios.map((scenario) => ({ tier, scenario })),
);

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

function cli(args: string[]): { out: string; status: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', timeout: 180000 });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status ?? 1 };
}

interface PodQuad {
  subject: string;
  predicate: string;
  object: string;
}

function parseTurtle(ttl: string): PodQuad[] {
  return new Parser({ format: 'Turtle' })
    .parse(ttl)
    .map((q) => ({ subject: q.subject.value, predicate: q.predicate.value, object: q.object.value }));
}

function readPodQuads(podDir: string): PodQuad[] {
  const quads: PodQuad[] = [];
  for (const dir of ['clinical', 'wellness']) {
    const dirPath = path.join(podDir, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const file of fs.readdirSync(dirPath).sort()) {
      if (!file.endsWith('.ttl')) continue;
      quads.push(...parseTurtle(fs.readFileSync(path.join(dirPath, file), 'utf-8')));
    }
  }
  return quads;
}

function localName(iri: string): string {
  return iri.includes('#') ? (iri.split('#').pop() ?? iri) : (iri.split('/').pop() ?? iri);
}

// ---------------------------------------------------------------------------
// Running one scenario
// ---------------------------------------------------------------------------

interface RunResult {
  observation: ScenarioObservation;
  /** `resourceCount` as the converter REPORTED it, per batch. */
  reportedResourceCount: number[];
  /** Pre-reconciliation subject IRI -> the source's own record id, over all batches. */
  iriToSourceId: Map<string, string>;
  /** Final record subject -> every subject IRI merged into it (itself included). */
  mergeGroups: string[][];
}

const tempRoots: string[] = [];

function runScenario(tier: Tier, scenario: Scenario): RunResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pathology-${scenario.id.toLowerCase()}-`));
  tempRoots.push(root);
  const podDir = path.join(root, 'pod');

  const convertedRecords: number[] = [];
  const reportedResourceCount: number[] = [];
  const iriToSourceId = new Map<string, string>();

  // 1. cascade convert, per batch. Run standalone so the per-record subject IRIs
  //    are observed BEFORE reconciliation can merge any of them away — that map
  //    is what makes the scorecard able to say which source records ended up
  //    together.
  for (const batch of scenario.batches) {
    const file = path.join(tier.dir, batch.file);
    const args = ['--json', 'convert', '--from', batch.from, '--to', 'cascade', file];
    if (batch.sourceSystem) args.push('--source-system', batch.sourceSystem);
    const r = cli(args);
    expect(r.status, `convert failed for ${scenario.id}/${batch.file}:\n${r.out}`).toBe(0);
    const parsed = JSON.parse(r.out) as { resourceCount: number; output: string };
    reportedResourceCount.push(parsed.resourceCount);

    const quads = parseTurtle(parsed.output);
    const typed = new Set(quads.filter((q) => q.predicate === RDF_TYPE).map((q) => q.subject));
    convertedRecords.push(typed.size);
    for (const q of quads) {
      if (SOURCE_RECORD_ID.includes(q.predicate)) iriToSourceId.set(q.subject, q.object);
    }
  }

  // 2. pod init
  const init = cli(['pod', 'init', podDir]);
  expect(init.status, `pod init failed for ${scenario.id}:\n${init.out}`).toBe(0);

  // 3. pod import --reconcile-existing, one batch at a time, so cross-batch
  //    reconciliation is exercised against records already on disk.
  const importReports: ImportReportLite[] = [];
  scenario.batches.forEach((batch, i) => {
    const file = path.join(tier.dir, batch.file);
    const reportPath = path.join(root, `report-${i}.json`);
    const args = ['pod', 'import', podDir, file, '--reconcile-existing', '--report', reportPath];
    if (batch.sourceSystem) args.push('--source-system', batch.sourceSystem);
    const r = cli(args);
    expect(r.status, `pod import failed for ${scenario.id}/${batch.file}:\n${r.out}`).toBe(0);
    importReports.push(JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as ImportReportLite);
  });

  // 4. pod conflicts. Exit 1 means "conflicts present" and is expected; exit 2
  //    means the conflict store could not be READ, which is never acceptable.
  const conflictsRun = cli(['pod', 'conflicts', podDir, '--format', 'json']);
  expect(
    conflictsRun.status,
    `pod conflicts could not read the pod for ${scenario.id}:\n${conflictsRun.out}`,
  ).not.toBe(2);
  const conflicts = JSON.parse(conflictsRun.out) as Array<{ conflictId: string; recordType: string }>;

  // 5. cascade validate
  const validateRun = cli(['--json', 'validate', podDir]);
  const validated = JSON.parse(validateRun.out) as Array<{
    results: Array<{ severity: string; property: string; message: string }>;
  }>;
  const violations = validated
    .flatMap((f) => f.results)
    .filter((r) => r.severity === 'violation')
    .map((r) => ({ property: r.property, message: r.message }));

  // 6. Census
  const quads = readPodQuads(podDir);
  const typeOf = new Map<string, string>();
  for (const q of quads) if (q.predicate === RDF_TYPE) typeOf.set(q.subject, q.object);

  const podRecordsByType: Record<string, number> = {};
  for (const t of typeOf.values()) {
    const n = localName(t);
    podRecordsByType[n] = (podRecordsByType[n] ?? 0) + 1;
  }

  const mergedFrom = new Map<string, Set<string>>();
  for (const q of quads) {
    if (q.predicate !== MERGED_FROM) continue;
    const set = mergedFrom.get(q.subject) ?? new Set<string>();
    set.add(q.object);
    mergedFrom.set(q.subject, set);
  }
  const mergeGroups = [...typeOf.keys()].map((s) => [...new Set([s, ...(mergedFrom.get(s) ?? [])])]);

  const importWarnings = importReports.flatMap((r) => r.warnings ?? []);

  const valuesOn = (typeIri: string, predicateIri: string): string[] =>
    quads
      .filter((q) => q.predicate === predicateIri && typeOf.get(q.subject) === typeIri)
      .map((q) => q.object)
      .sort();

  const observation: ScenarioObservation = {
    id: scenario.id,
    convertedRecords,
    reportedResourceCount,
    importReports,
    importWarnings,
    podRecords: typeOf.size,
    podRecordsByType,
    conflicts,
    violations,
    values: (predicateIri) =>
      [...new Set(quads.filter((q) => q.predicate === predicateIri).map((q) => q.object))].sort(),
    subjectsWith: (predicateIri) =>
      [...new Set(quads.filter((q) => q.predicate === predicateIri).map((q) => q.subject))].sort(),
    valuesOn,
    countMissing: (typeIri, predicateIri) => {
      const have = new Set(
        quads.filter((q) => q.predicate === predicateIri).map((q) => q.subject),
      );
      return [...typeOf.entries()].filter(([s, t]) => t === typeIri && !have.has(s)).length;
    },
  };

  return { observation, reportedResourceCount, iriToSourceId, mergeGroups };
}

// ---------------------------------------------------------------------------
// The reconciliation scorecard (report-only)
// ---------------------------------------------------------------------------

interface Score {
  /** Records under evaluation, from the scenario's ground truth. */
  universe: number;
  /** Pairs the truth says belong together. */
  truthPairs: number;
  /** Pairs the reconciler actually put together, within the universe. */
  predictedPairs: number;
  /** Predicted pairs that are also truth pairs. */
  correctPairs: number;
  precision: number;
  recall: number;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function pairsOf(group: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) out.push(pairKey(group[i], group[j]));
  }
  return out;
}

function score(scenario: Scenario, run: RunResult): Score {
  const universe = new Set(scenario.groundTruth!.flat());
  const truth = new Set(scenario.groundTruth!.flatMap(pairsOf));

  const predicted = new Set<string>();
  for (const group of run.mergeGroups) {
    const ids = group
      .map((iri) => run.iriToSourceId.get(iri))
      .filter((id): id is string => !!id && universe.has(id));
    for (const p of pairsOf([...new Set(ids)])) predicted.add(p);
  }

  const correct = [...predicted].filter((p) => truth.has(p)).length;
  return {
    universe: universe.size,
    truthPairs: truth.size,
    predictedPairs: predicted.size,
    correctPairs: correct,
    // An empty prediction set asserts nothing wrong, so precision is 1 by
    // convention. Recall is what exposes it, and does.
    precision: predicted.size === 0 ? 1 : round(correct / predicted.size),
    recall: truth.size === 0 ? 1 : round(correct / truth.size),
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const runs = new Map<string, RunResult>();

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error('dist/index.js is missing — run `npm run build` before `npm test`.');
  }
  for (const { tier, scenario } of ALL_SCENARIOS) {
    runs.set(scenario.id, runScenario(tier, scenario));
  }
}, 900000);

afterAll(() => {
  for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true });
});

describe('pathology corpus', () => {
  it('discovers at least the committed authored-synthetic tier', () => {
    expect(TIERS.map((t) => t.name)).toContain('authored-synthetic');
  });

  it('gives every scenario across every tier a unique id', () => {
    const ids = ALL_SCENARIOS.map((s) => s.scenario.id);
    expect(new Set(ids).size, `duplicate scenario ids: ${ids.join(', ')}`).toBe(ids.length);
  });

  it('names an existing fixture file for every batch of every scenario', () => {
    for (const { tier, scenario } of ALL_SCENARIOS) {
      for (const batch of scenario.batches) {
        expect(
          fs.existsSync(path.join(tier.dir, batch.file)),
          `${scenario.id} names ${batch.file}, which is not in ${tier.dir}`,
        ).toBe(true);
      }
    }
  });

  it('keeps the known-outcome ledger well formed', () => {
    assertLedgerIsWellFormed(ALL_SCENARIOS.map((s) => s.scenario.id));
  });
});

describe.each(ALL_SCENARIOS)('$scenario.id  $scenario.pathology', ({ scenario }) => {
  const obs = () => runs.get(scenario.id)!.observation;

  it('converts the expected number of records per batch', () => {
    expect(obs().convertedRecords).toEqual(scenario.expect.convertedRecords);
  });

  it('reports the resource count it reports', () => {
    // Separate from the assertion above ON PURPOSE: for C-CDA the two numbers
    // disagree, and pinning both is what makes the disagreement visible instead
    // of a matter of which one a caller happened to read.
    expect(runs.get(scenario.id)!.reportedResourceCount).toEqual(
      scenario.expect.reportedResourceCount,
    );
  });

  it('leaves the expected record census in the pod', () => {
    expect(obs().podRecords).toBe(scenario.expect.podRecords);
    expect(obs().podRecordsByType).toEqual(scenario.expect.podRecordsByType);
  });

  it('performs the expected number of merges on the final batch', () => {
    const summary = obs().importReports[obs().importReports.length - 1].reconciliation?.summary;
    const merges = summary ? summary.exactDuplicatesRemoved + summary.nearDuplicatesMerged : 0;
    expect(merges).toBe(scenario.expect.merges);
  });

  it('raises the expected number of unresolved conflicts', () => {
    expect(obs().conflicts.length).toBe(scenario.expect.conflicts);
  });

  it('holds the expected number of record-to-record edges', () => {
    const last = obs().importReports[obs().importReports.length - 1];
    expect(last.edgeResolution.totalInPod).toBe(scenario.expect.edgesInPod);
  });

  it('validates with the expected number of violations', () => {
    expect(
      obs().violations.length,
      `violations:\n${obs()
        .violations.map((v) => `  ${v.property}: ${v.message}`)
        .join('\n')}`,
    ).toBe(scenario.expect.violations);
  });

  it('emits the expected number of import warnings', () => {
    expect(obs().importWarnings.length, obs().importWarnings.join('\n')).toBe(
      scenario.expect.importWarnings,
    );
  });

  it('holds the expected object values for every pinned predicate', () => {
    for (const v of scenario.expect.values ?? []) {
      const actual = obs().valuesOn(expandPrefixed(v.on), expandPrefixed(v.predicate));
      expect(actual, `${v.on} ${v.predicate}`).toEqual(v.values);
    }
  });

  it('accounts every imported record on the source axis', () => {
    // The invariant behind the retired P05 entry, held for EVERY scenario rather
    // than only the one that tripped over it: a record that reached the pod
    // appears in sourceBreakdown, under the ratified "unknown" token when its EHR
    // of origin cannot be determined. A breakdown that silently omits what it
    // could not attribute reads as "this pod has no data".
    for (const [i, report] of obs().importReports.entries()) {
      const accountedFor = Object.values(report.sourceBreakdown).reduce((a, b) => a + b, 0);
      expect(accountedFor, `batch ${i} sourceBreakdown: ${JSON.stringify(report.sourceBreakdown)}`)
        .toBe(report.totalRecordsImported);
    }
    if (scenario.expect.sourceBreakdown) {
      expect(obs().importReports[0].sourceBreakdown).toEqual(scenario.expect.sourceBreakdown);
    }
  });

  it('matches every known-outcome entry recorded against it', () => {
    assertKnownOutcomesForScenario(obs());
  });
});

describe('reconciliation scorecard (report-only)', () => {
  it('matches the committed baseline exactly', () => {
    const scored: Record<string, Score> = {};
    for (const { scenario } of ALL_SCENARIOS) {
      if (!scenario.groundTruth) continue;
      scored[scenario.id] = score(scenario, runs.get(scenario.id)!);
    }

    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8')) as {
      scores: Record<string, Score>;
    };

    // Deliberately NOT an assertion that precision and recall are good. Two of
    // these recalls are 0 and that is the point: the numbers are recorded so a
    // change to matching has to move them ON PURPOSE, with the baseline edited
    // in the same commit as the change that moved it.
    expect(
      scored,
      'The reconciler scored differently than the committed baseline. If the change was\n' +
        'intended, update tests/pathology-reconciliation-baseline.json in the same commit\n' +
        'and say in the message which scenario moved and why.',
    ).toEqual(baseline.scores);
  });

  it('scores every scenario that carries a ground truth, and only those', () => {
    const withTruth = ALL_SCENARIOS.filter((s) => s.scenario.groundTruth).map((s) => s.scenario.id);
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8')) as {
      scores: Record<string, Score>;
    };
    expect(Object.keys(baseline.scores).sort()).toEqual(withTruth.sort());
  });

  it('evaluates every ground-truth record id against a record the converter actually produced', () => {
    // Without this a typo in a ground-truth id silently shrinks the universe and
    // flatters the score, because an id nothing maps to can never be in a wrong pair.
    for (const { scenario } of ALL_SCENARIOS) {
      if (!scenario.groundTruth) continue;
      const produced = new Set(runs.get(scenario.id)!.iriToSourceId.values());
      for (const id of scenario.groundTruth.flat()) {
        expect(produced, `${scenario.id} ground truth names "${id}", which no record carries`).toContain(id);
      }
    }
  });
});

describe('known-outcome ledger coverage', () => {
  it('records at least one open defect', () => {
    // A ledger that emptied itself without anyone noticing would mean either
    // every defect is fixed (worth a person confirming) or the gate stopped
    // running (worth a person fixing).
    expect(KNOWN_OUTCOMES.length).toBeGreaterThan(0);
  });

  it('evaluated every entry in this run', () => {
    // Pins the gate CALL, not just the gate. Deleting
    // `assertKnownOutcomesForScenario` from the per-scenario block leaves every
    // other test in this file green; it does not leave this one green.
    assertEveryEntryWasExercised();
  });
});
