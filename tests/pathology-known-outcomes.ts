/**
 * The known-defect ledger for the pathology corpus, and the rule that stops it
 * becoming a place to hide things.
 *
 * WHY A LEDGER AND NOT A LIST OF SKIPS
 * ------------------------------------
 * The corpus in `test-fixtures/pathology/` is built out of import pathologies
 * that real exports contain, so a harness that runs it end to end trips over
 * defects that are open today. There are two dishonest ways to land such a
 * harness green: assert the wrong numbers with no comment (which makes the wrong
 * behaviour look intended), or skip the cases that fail (which makes the corpus
 * decorative). This file is the third way.
 *
 * Each entry names ONE deviation, states what the pipeline does today and what
 * it must do once fixed, and carries a probe that reads the measurement out of
 * the scenario's observed run. The gate is two-sided:
 *
 *   - the probe returns something OTHER than `current`   -> FAIL. Either a new
 *     defect appeared, or this one changed shape. Both want a person.
 *   - the probe returns `fixed`                          -> FAIL, loudly, with
 *     "this appears to be FIXED". A ledger entry that outlives its defect is
 *     worse than no ledger, because the next reader trusts it. Removing the
 *     entry and folding the expectation into the scenario is the intended
 *     response, and it has to be deliberate.
 *
 * So the list cannot silently absorb a new defect and it cannot silently keep a
 * dead one. It only shrinks on purpose.
 *
 * WHAT DOES NOT BELONG HERE
 * -------------------------
 * Anything the pipeline already gets right. If a scenario's numbers are correct,
 * they are asserted in the scenario itself and this file says nothing about it.
 *
 * `current` and `fixed` are compared with `toEqual`, so they may be any
 * JSON-shaped value; they MUST differ from each other, which `assertLedgerIsWellFormed`
 * enforces — an entry whose two states are the same is a no-op that would pass
 * forever.
 */

import { expect } from 'vitest';

/** Everything the harness measured for one scenario, as the probes see it. */
export interface ScenarioObservation {
  id: string;
  /** Typed record subjects the converter actually emitted, one per batch. */
  convertedRecords: number[];
  /** `resourceCount` as `cascade convert --json` REPORTED it, one per batch. */
  reportedResourceCount: number[];
  /** Parsed `--report` JSON from `cascade pod import`, one per batch. */
  importReports: ImportReportLite[];
  /** Every `--report` warning across every batch. */
  importWarnings: string[];
  /** Record subjects (those carrying an rdf:type) in clinical/ + wellness/. */
  podRecords: number;
  /** Those subjects counted by their type's local name. */
  podRecordsByType: Record<string, number>;
  /** `cascade pod conflicts --format json`. */
  conflicts: Array<{ conflictId: string; recordType: string }>;
  /** Every `sh:Violation` from `cascade --json validate <pod>`. */
  violations: Array<{ property: string; message: string }>;
  /** Object values of one predicate across the pod, deduplicated and sorted. */
  values(predicateIri: string): string[];
  /** Subjects carrying `predicateIri` at all. */
  subjectsWith(predicateIri: string): string[];
  /** Every object value of `predicateIri` on subjects of `typeIri`, sorted. */
  valuesOn(typeIri: string, predicateIri: string): string[];
  /** How many subjects of `typeIri` carry no `predicateIri` at all. */
  countMissing(typeIri: string, predicateIri: string): number;
}

export interface ImportReportLite {
  totalRecordsImported: number;
  recordsNew: number;
  recordsAlreadyPresent: number;
  sourceBreakdown: Record<string, number>;
  warnings: string[];
  edgeResolution: { resolved: number; unresolved: number; totalInPod: number };
  reconciliation?: {
    enabled: boolean;
    summary?: {
      exactDuplicatesRemoved: number;
      nearDuplicatesMerged: number;
      conflictsUnresolved: number;
      identityCollisionsSplit: number;
      finalRecordCount: number;
    };
  };
  sectionCensus: Array<{ label: string; entriesIn: number; recordsOut: number }>;
}

export interface KnownOutcome {
  /** Stable id. Referenced in failure messages; never reused after removal. */
  id: string;
  /** The scenario whose observation the probe reads. */
  scenario: string;
  /** What the pipeline does today, and why that is wrong. */
  currentWrongOutcome: string;
  /** What must be true instead once this is fixed. */
  expectedOnceFixed: string;
  probe: (o: ScenarioObservation) => unknown;
  /** What `probe` returns today. */
  current: unknown;
  /** What `probe` must return once fixed. Must differ from `current`. */
  fixed: unknown;
}

const NS = {
  cascade: 'https://ns.cascadeprotocol.org/core/v1#',
  health: 'https://ns.cascadeprotocol.org/health/v1#',
  clinical: 'https://ns.cascadeprotocol.org/clinical/v1#',
};

/** Total merges the last batch of a scenario performed. */
function merges(o: ScenarioObservation): number {
  const s = o.importReports[o.importReports.length - 1]?.reconciliation?.summary;
  if (!s) return 0;
  return s.exactDuplicatesRemoved + s.nearDuplicatesMerged;
}

export const KNOWN_OUTCOMES: KnownOutcome[] = [
  {
    id: 'P01-one-system-two-source-labels',
    scenario: 'P01',
    currentWrongOutcome:
      'One health system occupies two rows on the pod source axis. The FHIR path derives ' +
      'clinical:sourceEHR from the registrable domain of the first absolute reference URL ' +
      '("meridianhealth.example"); the C-CDA path derives it from the custodian organization ' +
      'name ("Meridian Health System"). Both are defensible readings of their own document and ' +
      'neither knows about the other, so a patient who downloaded both transports from one ' +
      'system sees two sources.',
    expectedOnceFixed:
      'One system yields ONE label. Which label wins (organization name, endpoint domain, or a ' +
      'user-visible alias resolved from both) is the open design question; the invariant the ' +
      'harness holds is that the count of distinct labels for one system is 1, whichever is chosen.',
    probe: (o) => ({ distinctSourceEhrLabels: o.values(NS.clinical + 'sourceEHR').length }),
    current: { distinctSourceEhrLabels: 2 },
    fixed: { distinctSourceEhrLabels: 1 },
  },
  {
    id: 'P02-duplicate-source-id-collision-undetected',
    scenario: 'P02',
    currentWrongOutcome:
      'Three lab observations that share one root-only <id> mint one subject IRI, and because ' +
      'they are one subject inside a single converted document there is no second record for the ' +
      'reconciler to compare: splitIdentityCollisions only ever sees ONE parsed record. So the ' +
      'three results pile onto one subject as multi-valued testCode/testName/resultValue, the pod ' +
      'holds 2 lab records where the document stated 4, `pod conflicts` reports nothing, and the ' +
      'only trace is two SHACL maxCount violations that name the symptom rather than the cause.',
    expectedOnceFixed:
      'The four observations become four lab records with zero violations, either by minting ' +
      'distinct IRIs when a shared id is contradicted by the entry content, or by raising the ' +
      'collision as a conflict the way the reconciler already does for records that arrive ' +
      'separately. The failure mode to avoid is a fix that silences the SHACL violations without ' +
      'recovering the two lost results.',
    probe: (o) => ({
      labRecords: o.podRecordsByType['LabResultRecord'] ?? 0,
      conflicts: o.conflicts.length,
      violations: o.violations.length,
    }),
    current: { labRecords: 2, conflicts: 0, violations: 2 },
    fixed: { labRecords: 4, conflicts: 0, violations: 0 },
  },
  {
    id: 'P04-procedure-name-written-off-shape',
    scenario: 'P04',
    currentWrongOutcome:
      'The C-CDA procedures handler writes the procedure name to health:procedureName, which no ' +
      'shape targeting clinical:Procedure declares, while clinical:ProcedureShape requires ' +
      'clinical:procedureName. So the record CARRIES a name, validates as though it had none, and ' +
      'the name it carries is validated by nothing.',
    expectedOnceFixed:
      'The name lands on clinical:procedureName and the violation goes away. Moving it is a data ' +
      'change for every consumer already querying health:procedureName, which is why it wants its ' +
      'own change with its own note about what to re-query.',
    probe: (o) => ({
      violations: o.violations.filter((v) => v.property === 'procedureName').length,
      onHealth: o.valuesOn(NS.clinical + 'Procedure', NS.health + 'procedureName'),
      onClinical: o.valuesOn(NS.clinical + 'Procedure', NS.clinical + 'procedureName'),
    }),
    current: { violations: 1, onHealth: ['Colonoscopy'], onClinical: [] },
    fixed: { violations: 0, onHealth: [], onClinical: ['Colonoscopy'] },
  },
  {
    id: 'P04-lab-report-date-promoted-to-midnight',
    scenario: 'P04',
    currentWrongOutcome:
      'The lab ORGANIZER states a day ("20250703"), and the LaboratoryReport it becomes carries ' +
      'clinical:documentDate "2025-07-03T00:00:00Z"^^xsd:dateTime — a midnight, in UTC, that the ' +
      'document never gave. This is precisely the fabrication the observation-level date rule ' +
      'refuses to make: the sibling lab records from the same organizer correctly carry ' +
      '"2025-07-03"^^xsd:date. Two date paths, one document, opposite answers.',
    expectedOnceFixed:
      'The report date states the precision the source stated: "2025-07-03"^^xsd:date, through the ' +
      'same typed-date helper the observation path uses. A fabricated 00:00 is indistinguishable ' +
      'downstream from a real midnight draw, so promoting is not a harmless normalization.',
    probe: (o) => ({
      reportDates: o.valuesOn(NS.clinical + 'LaboratoryReport', NS.clinical + 'documentDate'),
      observationDates: o.valuesOn(NS.health + 'LabResultRecord', NS.health + 'performedDate'),
    }),
    current: {
      reportDates: ['2025-07-03T00:00:00Z'],
      observationDates: ['2025-07-03', '2025-07-03T14:22:15-04:00'],
    },
    fixed: {
      reportDates: ['2025-07-03'],
      observationDates: ['2025-07-03', '2025-07-03T14:22:15-04:00'],
    },
  },
  {
    id: 'P07-shared-transport-label-blocks-cross-source-dedup',
    scenario: 'P07-SHARED-LABEL',
    currentWrongOutcome:
      'The guard that stops two records from the same source being compared keys on ' +
      'cascade:sourceSystem — the IMPORT-BATCH label, set by --source-system. Give two different ' +
      "health systems' exports one batch label (the Apple Health shape, where one export carries " +
      'several connected accounts) and the guard suppresses every cross-source comparison: none of ' +
      'the four byte-identical duplicates merges, and the pod ends up holding two patient profiles ' +
      'and twelve records where the same data under distinct labels yields seven.',
    expectedOnceFixed:
      'The guard keys on the CLINICAL source (clinical:sourceEHR, or an explicit per-record source ' +
      'identity), not on how the records were transported, so the shared-label run reconciles ' +
      'identically to the distinct-label run: 7 records, 5 merges.',
    probe: (o) => ({ podRecords: o.podRecords, merges: merges(o) }),
    current: { podRecords: 12, merges: 0 },
    fixed: { podRecords: 7, merges: 5 },
  },
  {
    id: 'P10-negation-and-data-absent-sentinels-stored-as-allergens',
    scenario: 'P10',
    currentWrongOutcome:
      'A "No Known Allergies" assertion (SNOMED 716186003, a statement ABOUT the list) and a ' +
      'code-less entry (a data-absent marker) both become health:AllergyRecord with an ' +
      'health:allergen string, shape-identical to the penicillin allergy beside them. A list view ' +
      'renders the patient as allergic to "No Known Allergies" and to "Unknown Allergen".',
    expectedOnceFixed:
      'Only substances the patient is actually allergic to appear as allergens. The negation is ' +
      'carried as an assertion about the list (which is what makes "we asked and the answer was ' +
      'none" different from "nobody asked"), and the data-absent entry is marked as such rather ' +
      'than given a placeholder substance name.',
    probe: (o) => o.valuesOn(NS.health + 'AllergyRecord', NS.health + 'allergen'),
    current: ['Ibuprofen', 'No Known Allergies', 'Penicillin G', 'Unknown Allergen'],
    fixed: ['Ibuprofen', 'Penicillin G'],
  },
  {
    id: 'P11-panel-name-variants-are-never-reconciled',
    scenario: 'P11',
    currentWrongOutcome:
      'clinical:LaboratoryReport is not a reconcilable type, so it passes through untouched. One ' +
      'lipid draw reported three times under three display names stays three reports, each ' +
      'carrying the same four hasLabResult edges: 3 reports, 12 edges into 4 results. The results ' +
      'themselves are correctly stored once, which is what makes the duplication visible — the ' +
      'edges fan in.',
    expectedOnceFixed:
      'The three reports reconcile to one (same LOINC, same performed instant, identical result ' +
      'set), leaving 1 report and 4 edges. The display names are evidence for the match, not the ' +
      'match key: "Final result" is a status word appended by a delivery system and normalizing it ' +
      'away is not the same as normalizing "Profile" to "Panel".',
    probe: (o) => ({
      reports: o.podRecordsByType['LaboratoryReport'] ?? 0,
      edges: o.importReports[0].edgeResolution.totalInPod,
    }),
    current: { reports: 3, edges: 12 },
    fixed: { reports: 1, edges: 4 },
  },
  {
    id: 'P12-nullflavor-variety-collapses-to-one-absence',
    scenario: 'P12',
    currentWrongOutcome:
      'UNK ("unknown"), NAV ("temporarily unavailable") and ASKU ("asked but unknown") are three ' +
      'different statements about WHY a value is missing, and HL7 v3 separates them deliberately: ' +
      'the third one means somebody asked the patient. All three produce a lab record with no ' +
      'health:resultValue and nothing else, so the three become one indistinguishable blank and the ' +
      'reason the source took the trouble to state is discarded.',
    expectedOnceFixed:
      'The nullFlavor is carried, so "we never measured it", "the result is coming" and "we asked ' +
      'and were not told" stay three different answers. The records still carry no resultValue — ' +
      'inventing one is not the fix. BLOCKED ON VOCABULARY, deliberately: the predicate this entry ' +
      'names, health:dataAbsentReason, does not exist. No property in health, clinical or core ' +
      'carries a reason-for-absence today, and vocabulary is authored in `spec/` and synced into ' +
      'src/shapes/ — emitting a term the ontology does not define would put an unvalidatable ' +
      'predicate in every pod and is not a smaller change than adding it properly. So the CONVERTER ' +
      'fix waits on a spec addition binding health:dataAbsentReason to the HL7 v3 NullFlavor / FHIR ' +
      'data-absent-reason value set, and this entry stays open to say so rather than being answered ' +
      'with an invented term.',
    probe: (o) => ({
      labsWithoutValue: o.countMissing(NS.health + 'LabResultRecord', NS.health + 'resultValue'),
      dataAbsentReasons: o.values(NS.health + 'dataAbsentReason').length,
    }),
    current: { labsWithoutValue: 3, dataAbsentReasons: 0 },
    fixed: { labsWithoutValue: 3, dataAbsentReasons: 3 },
  },
];

/**
 * Structural checks on the ledger itself, run as a test.
 *
 * The `current` / `fixed` inequality is the load-bearing one: an entry whose two
 * states are equal can never fail in either direction, so it would sit here
 * forever asserting nothing.
 */
export function assertLedgerIsWellFormed(scenarioIds: string[]): void {
  const ids = KNOWN_OUTCOMES.map((k) => k.id);
  expect(new Set(ids).size, `duplicate KNOWN_OUTCOMES ids: ${ids.join(', ')}`).toBe(ids.length);

  for (const k of KNOWN_OUTCOMES) {
    expect(
      scenarioIds,
      `KNOWN_OUTCOMES entry "${k.id}" names scenario "${k.scenario}", which is not in the corpus`,
    ).toContain(k.scenario);
    expect(
      JSON.stringify(k.current),
      `KNOWN_OUTCOMES entry "${k.id}" has current === fixed, so it can never fail and asserts nothing`,
    ).not.toBe(JSON.stringify(k.fixed));
    expect(k.currentWrongOutcome.length, `"${k.id}" must say what is wrong today`).toBeGreaterThan(40);
    expect(k.expectedOnceFixed.length, `"${k.id}" must say what must be true once fixed`).toBeGreaterThan(40);
  }
}

/**
 * Ids the gate has actually evaluated this run.
 *
 * Without this the gate itself is unpinned: delete the
 * `assertKnownOutcomesForScenario` call from the harness and every entry in this
 * file stops being checked while the suite stays green, which is the exact
 * failure mode a ledger is supposed to prevent. `assertEveryEntryWasExercised`
 * turns that deletion into a red test.
 */
const exercised = new Set<string>();

/** Fails if any ledger entry was never evaluated. Run after all scenarios. */
export function assertEveryEntryWasExercised(): void {
  const missed = KNOWN_OUTCOMES.filter((k) => !exercised.has(k.id)).map((k) => k.id);
  expect(
    missed,
    `these KNOWN_OUTCOMES entries were never evaluated, so nothing in this run held them:\n` +
      `  ${missed.join('\n  ')}\n` +
      `Either their scenario is missing from the corpus, or the gate is no longer being called.`,
  ).toEqual([]);
}

/**
 * The gate. Run once per scenario, over the entries that name it.
 *
 * Both directions fail. That is the entire point: a ledger that only caught
 * regressions would let a fix rot the documentation, and a ledger that only
 * caught fixes would let a new defect hide behind an existing entry.
 */
export function assertKnownOutcomesForScenario(o: ScenarioObservation): void {
  for (const k of KNOWN_OUTCOMES.filter((e) => e.scenario === o.id)) {
    exercised.add(k.id);
    const actual = k.probe(o);
    const actualJson = JSON.stringify(actual);

    if (actualJson === JSON.stringify(k.fixed)) {
      throw new Error(
        `KNOWN_OUTCOMES "${k.id}" appears to be FIXED.\n\n` +
          `  Observed: ${actualJson}\n` +
          `  which is the entry's declared post-fix outcome.\n\n` +
          `  Remove the entry from tests/pathology-known-outcomes.ts and fold the corrected\n` +
          `  expectation into scenario ${k.scenario}. The ledger is allowed to shrink; it is not\n` +
          `  allowed to shrink by accident.\n\n` +
          `  What it recorded: ${k.expectedOnceFixed}`,
      );
    }

    expect(
      actual,
      `KNOWN_OUTCOMES "${k.id}" (scenario ${k.scenario}) deviated from the recorded behaviour.\n` +
        `  Recorded today: ${JSON.stringify(k.current)}\n` +
        `  Observed now:   ${actualJson}\n` +
        `  Neither matches the declared post-fix outcome ${JSON.stringify(k.fixed)}, so this is a\n` +
        `  NEW deviation, not a fix. What the entry documents:\n` +
        `  ${k.currentWrongOutcome}`,
    ).toEqual(k.current);
  }
}
