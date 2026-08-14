/**
 * TIER 0: the one duplicate class allowed to merge without asking, and the
 * boundary around it.
 *
 * THE RULING
 * ----------
 * Cross-source EXACT lab duplication merges silently. Two organizations
 * reporting one draw is the commonest thing a multi-source pod holds, and
 * queueing a question for each one does not produce caution — it produces a
 * queue nobody finishes, with the genuinely disagreeing pairs buried in it.
 * Measured over 144 candidate groups at a 22% duplicate base rate: zero false
 * positives.
 *
 * WHAT THESE TESTS ARE FOR
 * ------------------------
 * The value of a narrow rule is entirely in the narrowness, so most of this file
 * is the NEGATIVE cases. Each one removes a single clause and asserts the class
 * closes: same day but different instants, one value different, one origin
 * unknown, both origins the same. A tier-0 test suite that only proved the happy
 * path would pass just as well against a rule that merged everything.
 *
 * And two positive obligations, which are the price of merging silently: the
 * merge is LOGGED (itemized, with IRIs) and REVERSIBLE (the discarded records'
 * full content is retained). Silent means not interrupting, not unrecorded.
 *
 * All data is synthetic and PHI-free.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Parser } from 'n3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runReconciliation } from '../src/lib/reconciler.js';
import {
  appendTier0Journal,
  readTier0Journal,
  tier0DiscardedRecords,
  TIER0_JOURNAL_RELATIVE_PATH,
} from '../src/lib/tier0-journal.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PREFIXES = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
`;

/** The exact instant both copies of the tier-0 draw state. */
const INSTANT = '2031-05-20T09:14:00Z';

interface LabOpts {
  uri: string;
  batch?: string;
  origin?: string;
  /** Defaults to the shared exact instant. Pass a bare date to leave the class. */
  performed?: string;
  value?: string;
  loinc?: string;
  provenanceClass?: string;
}

/** One lab record, parameterised on every clause of the tier-0 predicate. */
function lab(o: LabOpts): string {
  const lines = [
    `<${o.uri}> a health:LabResultRecord ;`,
    `  cascade:sourceSystem "${o.batch ?? 'Household export'}" ;`,
  ];
  if (o.origin) lines.push(`  cascade:sourceIdentity "${o.origin}" ;`);
  if (o.provenanceClass) lines.push(`  clinical:provenanceClass "${o.provenanceClass}" ;`);
  lines.push(
    `  health:testCode <http://loinc.org/rdf#${o.loinc ?? '2951-2'}> ;`,
    `  health:testName "Sodium" ;`,
    `  health:performedDate "${o.performed ?? INSTANT}" ;`,
    `  health:resultValue "${o.value ?? '141'}" .`,
  );
  return `${PREFIXES}${lines.join('\n')}\n`;
}

function recordSubjects(ttl: string): string[] {
  return [
    ...new Set(
      new Parser({ format: 'Turtle' })
        .parse(ttl)
        .filter((q) => q.predicate.value === RDF_TYPE)
        .map((q) => q.subject.value),
    ),
  ].sort();
}

/** The canonical tier-0 pair: one draw, two organizations, byte-identical. */
function tier0Pair(): Array<{ content: string; systemName: string }> {
  return [
    { content: lab({ uri: 'urn:uuid:lab-a', origin: 'org:stonebridge' }), systemName: 'Household export' },
    { content: lab({ uri: 'urn:uuid:lab-b', origin: 'org:larkfield' }), systemName: 'Household export' },
  ];
}

// ---------------------------------------------------------------------------
// The class
// ---------------------------------------------------------------------------

describe('tier 0: cross-source exact lab duplication', () => {
  it('merges the pair, reports it as tier 0, and raises no conflict', async () => {
    const r = await runReconciliation(tier0Pair());
    expect(recordSubjects(r.turtle).length).toBe(1);
    expect(r.report.summary.tier0MergesApplied).toBe(1);
    expect(r.report.summary.conflictsUnresolved).toBe(0);
  });

  it('itemizes the merge with the surviving IRI and every IRI it absorbed', async () => {
    // The LOG half of the obligation. A count alone cannot be audited: it says
    // something happened without saying to what.
    const r = await runReconciliation(tier0Pair());
    const [merge] = r.report.tier0Merges;
    expect(r.report.tier0Merges).toHaveLength(1);
    expect(['urn:uuid:lab-a', 'urn:uuid:lab-b']).toContain(merge.canonicalUri);
    expect(merge.discarded).toHaveLength(1);
    expect(merge.discarded[0].uri).not.toBe(merge.canonicalUri);
    expect(['urn:uuid:lab-a', 'urn:uuid:lab-b']).toContain(merge.discarded[0].uri);
    expect(merge.origins).toEqual(['org:larkfield', 'org:stonebridge']);
    expect(merge.matchedOn).toBe(`loinc:2951-2@${INSTANT}`);
  });

  it('retains enough of the discarded record to put it back', async () => {
    // The REVERSIBLE half. Content-complete deliberately: an undo that only works
    // if the merge rule was right is not an undo.
    const r = await runReconciliation(tier0Pair());
    const discarded = r.report.tier0Merges[0].discarded[0];
    const props = discarded.properties;
    expect(props['https://ns.cascadeprotocol.org/health/v1#resultValue'][0].value).toBe('141');
    expect(props['https://ns.cascadeprotocol.org/health/v1#performedDate'][0].value).toBe(INSTANT);
    expect(props['https://ns.cascadeprotocol.org/health/v1#testName'][0].value).toBe('Sodium');
    // The origin axis is what distinguished the two copies, so it must survive
    // the merge that collapsed them: without it the restored record cannot say
    // which organization it came from.
    expect(discarded.sourceIdentity).toMatch(/^org:(stonebridge|larkfield)$/);
    expect(discarded.type).toBe('health:LabResultRecord');
  });

  it('merges even under the conservative cross-provenance guard', async () => {
    // The clause with teeth. `allowCrossProvenanceMerge: false` exists to stop
    // silent merges ACROSS provenance classes, and two organizations reporting
    // one draw is precisely what differing provenance classes look like — so
    // under that guard every benign cross-source duplicate became a question.
    const inputs = [
      {
        content: lab({ uri: 'urn:uuid:lab-a', origin: 'org:stonebridge', provenanceClass: 'imported' }),
        systemName: 'Household export',
      },
      {
        content: lab({ uri: 'urn:uuid:lab-b', origin: 'org:larkfield', provenanceClass: 'healthKitFHIR' }),
        systemName: 'Household export',
      },
    ];
    const guarded = await runReconciliation(inputs, { allowCrossProvenanceMerge: false });
    expect(recordSubjects(guarded.turtle).length).toBe(1);
    expect(guarded.report.summary.tier0MergesApplied).toBe(1);
    expect(guarded.report.summary.conflictsUnresolved).toBe(0);
  });

  it('leaves the guard doing its job for everything that is NOT tier 0', async () => {
    // The contrast that proves the exemption is an exemption and not a removal.
    // Same two provenance classes, same two origins, but the values differ inside
    // lab tolerance: a near-duplicate, not an exact one, so the class does not
    // apply and the guard still flags.
    const inputs = [
      {
        content: lab({ uri: 'urn:uuid:lab-a', origin: 'org:stonebridge', provenanceClass: 'imported' }),
        systemName: 'Household export',
      },
      {
        content: lab({
          uri: 'urn:uuid:lab-b',
          origin: 'org:larkfield',
          provenanceClass: 'healthKitFHIR',
          value: '141.2',
        }),
        systemName: 'Household export',
      },
    ];
    const guarded = await runReconciliation(inputs, { allowCrossProvenanceMerge: false });
    expect(guarded.report.summary.tier0MergesApplied).toBe(0);
    expect(guarded.report.summary.conflictsUnresolved).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The boundary. Each case removes exactly one clause.
// ---------------------------------------------------------------------------

describe('tier 0 closes when any single clause fails', () => {
  /** Run a pair and return only what the tier-0 machinery said about it. */
  async function tier0Count(a: string, b: string): Promise<number> {
    const r = await runReconciliation([
      { content: a, systemName: 'Household export' },
      { content: b, systemName: 'Household export' },
    ]);
    return r.report.summary.tier0MergesApplied;
  }

  it('is NOT tier 0 on the same DAY at different instants', async () => {
    // The clause that costs the most and is worth the most. A same-day repeat
    // draw is a real second measurement; the day-level matcher may still group
    // these for review, but tier 0 will not merge them unasked.
    expect(
      await tier0Count(
        lab({ uri: 'urn:uuid:lab-a', origin: 'org:stonebridge', performed: '2031-05-20T09:14:00Z' }),
        lab({ uri: 'urn:uuid:lab-b', origin: 'org:larkfield', performed: '2031-05-20T16:02:00Z' }),
      ),
    ).toBe(0);
  });

  it('is NOT tier 0 when the date states only a day', async () => {
    // "Never day-level" is a property of the DATA, not only of the comparison.
    // Two records that agree on "2031-05-20" agree on a day, and a day is not an
    // instant however exactly the strings match.
    expect(
      await tier0Count(
        lab({ uri: 'urn:uuid:lab-a', origin: 'org:stonebridge', performed: '2031-05-20' }),
        lab({ uri: 'urn:uuid:lab-b', origin: 'org:larkfield', performed: '2031-05-20' }),
      ),
    ).toBe(0);
  });

  it('is NOT tier 0 when any content differs, however slightly', async () => {
    expect(
      await tier0Count(
        lab({ uri: 'urn:uuid:lab-a', origin: 'org:stonebridge', value: '141' }),
        lab({ uri: 'urn:uuid:lab-b', origin: 'org:larkfield', value: '141.2' }),
      ),
    ).toBe(0);
  });

  /**
   * Run a pair that is GUARANTEED to be compared, and return the tier-0 count.
   *
   * The batch labels differ, which matters more than it looks. `sameSourceStatement`
   * returns early on differing `cascade:sourceSystem`, so the pair is always
   * admitted to the matcher; under ONE shared label a record with an unknown
   * origin is held out by the guard and never grouped at all. A boundary test
   * written that way measures the GUARD and says nothing about the tier-0
   * predicate, and would pass with the whole known-origin clause deleted.
   * (Measured: that is exactly what happened, and the clause survived mutation.)
   */
  async function tier0CountCompared(a: string, b: string): Promise<number> {
    const r = await runReconciliation([
      { content: a, systemName: 'batch-1' },
      { content: b, systemName: 'batch-2' },
    ]);
    // The premise: they really were grouped. Without this the test can pass by
    // the records never meeting, which is the failure mode above.
    expect(recordSubjects(r.turtle).length, 'the pair was never compared').toBe(1);
    return r.report.summary.tier0MergesApplied;
  }

  it('is NOT tier 0 when one origin is absent, though the records still merge', async () => {
    // Pre-v3.5 records carry no origin at all. Two unknowns are not two
    // organizations. The pair still merges by the ordinary lab rules; what it
    // does not get is the silent, journaled tier-0 treatment.
    expect(
      await tier0CountCompared(
        lab({ uri: 'urn:uuid:lab-a', batch: 'batch-1', origin: 'org:stonebridge' }),
        lab({ uri: 'urn:uuid:lab-b', batch: 'batch-2' }),
      ),
    ).toBe(0);
  });

  it('is NOT tier 0 when an origin is a transport-tier value', async () => {
    // `transport:` is the producer saying it could not tell. Reading it as an
    // origin is the exact confusion the scheme prefix exists to prevent.
    expect(
      await tier0CountCompared(
        lab({ uri: 'urn:uuid:lab-a', batch: 'batch-1', origin: 'org:stonebridge' }),
        lab({ uri: 'urn:uuid:lab-b', batch: 'batch-2', origin: 'transport:Household export' }),
      ),
    ).toBe(0);
  });

  it('is NOT tier 0 when BOTH origins are absent', async () => {
    expect(
      await tier0CountCompared(
        lab({ uri: 'urn:uuid:lab-a', batch: 'batch-1' }),
        lab({ uri: 'urn:uuid:lab-b', batch: 'batch-2' }),
      ),
    ).toBe(0);
  });

  it('is NOT tier 0 when both copies share ONE origin', async () => {
    // One source does not restate one result twice inside one export, so two
    // identical records under one origin may be two real measurements. Different
    // origins is the whole safety argument; same origin removes it.
    expect(
      await tier0CountCompared(
        lab({ uri: 'urn:uuid:lab-a', batch: 'batch-1', origin: 'org:stonebridge' }),
        lab({ uri: 'urn:uuid:lab-b', batch: 'batch-2', origin: 'org:stonebridge' }),
      ),
    ).toBe(0);
  });

  it('is NOT tier 0 for a non-lab record type', async () => {
    const condition = (uri: string, origin: string): string =>
      `${PREFIXES}<${uri}> a health:ConditionRecord ;
  cascade:sourceSystem "Household export" ;
  cascade:sourceIdentity "${origin}" ;
  health:snomedCode <http://snomed.info/id/44054006> ;
  health:conditionName "Type 2 diabetes" .
`;
    expect(
      await tier0Count(
        condition('urn:uuid:cond-a', 'org:stonebridge'),
        condition('urn:uuid:cond-b', 'org:larkfield'),
      ),
    ).toBe(0);
  });

  it('closes for the WHOLE group when a third record that JOINED it does not qualify', async () => {
    // Group-level, not pair-level. Two qualifying records must not carry an
    // unqualified third into a silent merge on their coat-tails.
    //
    // The third record has to actually reach the group for this to measure
    // anything, and getting that wrong is easy: a record with no origin is held
    // out by the same-source guard and never compared at all, so the group would
    // be the original qualifying PAIR and would rightly stay tier 0. This third
    // copy therefore carries its own known origin (so the guard admits it) and a
    // day-only date (so the day-level lab matcher groups it, and the tier-0
    // instant clause rejects it).
    const r = await runReconciliation([
      { content: lab({ uri: 'urn:uuid:lab-a', origin: 'org:stonebridge' }), systemName: 'Household export' },
      { content: lab({ uri: 'urn:uuid:lab-b', origin: 'org:larkfield' }), systemName: 'Household export' },
      {
        content: lab({ uri: 'urn:uuid:lab-c', origin: 'org:brightwater', performed: '2031-05-20' }),
        systemName: 'Household export',
      },
    ]);
    // All three grouped, and the group is not tier 0.
    expect(recordSubjects(r.turtle).length).toBe(1);
    expect(r.report.summary.tier0MergesApplied).toBe(0);
  });

  it('does not group a record the same-source guard holds out, and stays tier 0', async () => {
    // The contrast for the case above, and the reason it is worded the way it
    // is. A third copy with NO origin is never compared with anything under the
    // shared batch label, so it is not in the group; the qualifying pair is still
    // a qualifying pair, and the unattributed record survives on its own.
    const r = await runReconciliation([
      { content: lab({ uri: 'urn:uuid:lab-a', origin: 'org:stonebridge' }), systemName: 'Household export' },
      { content: lab({ uri: 'urn:uuid:lab-b', origin: 'org:larkfield' }), systemName: 'Household export' },
      { content: lab({ uri: 'urn:uuid:lab-c' }), systemName: 'Household export' },
    ]);
    expect(recordSubjects(r.turtle).length).toBe(2);
    expect(r.report.summary.tier0MergesApplied).toBe(1);
  });

  it('reports nothing at all on a run with no tier-0 group', async () => {
    const r = await runReconciliation([
      { content: lab({ uri: 'urn:uuid:lab-a', origin: 'org:stonebridge', performed: '2031-05-20' }), systemName: 'b1' },
    ]);
    expect(r.report.summary.tier0MergesApplied).toBe(0);
    expect(r.report.tier0Merges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

describe('the tier-0 journal', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function mkPod(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-tier0-'));
    dirs.push(d);
    fs.mkdirSync(path.join(d, 'settings'), { recursive: true });
    return d;
  }

  it('does not exist on a pod that has had no tier-0 merge', () => {
    const pod = mkPod();
    expect(readTier0Journal(pod).entries).toEqual([]);
    expect(appendTier0Journal(pod, [], 'pod import')).toBe(0);
    expect(fs.existsSync(path.join(pod, TIER0_JOURNAL_RELATIVE_PATH))).toBe(false);
  });

  it('appends across runs rather than replacing', async () => {
    // An audit log that a second run overwrites is not an audit log.
    const pod = mkPod();
    const r = await runReconciliation(tier0Pair());
    appendTier0Journal(pod, r.report.tier0Merges, 'pod import');
    appendTier0Journal(pod, r.report.tier0Merges, 'pod reconcile --apply');
    const journal = readTier0Journal(pod);
    expect(journal.entries).toHaveLength(2);
    expect(journal.entries.map((e) => e.appliedBy)).toEqual(['pod import', 'pod reconcile --apply']);
    expect(journal.entries.every((e) => e.rule === 'tier-0-cross-source-exact-lab-duplicate')).toBe(true);
  });

  it('yields the discarded records back, content intact', async () => {
    const pod = mkPod();
    const r = await runReconciliation(tier0Pair());
    appendTier0Journal(pod, r.report.tier0Merges, 'pod import');
    const restorable = tier0DiscardedRecords(readTier0Journal(pod));
    expect(restorable).toHaveLength(1);
    expect(restorable[0].discardedUri).toMatch(/^urn:uuid:lab-[ab]$/);
    expect(
      restorable[0].properties['https://ns.cascadeprotocol.org/health/v1#resultValue'][0].value,
    ).toBe('141');
  });

  it('is valid JSON on disk', () => {
    // It goes through the RFC 8259 encoder like every other JSON this tool
    // writes: the journal holds record CONTENT, which is exactly where a hostile
    // literal lives.
    const pod = mkPod();
    appendTier0Journal(
      pod,
      [
        {
          canonicalUri: 'urn:uuid:kept',
          recordType: 'health:LabResultRecord',
          matchedOn: `loinc:2951-2@${INSTANT}`,
          origins: ['org:larkfield', 'org:stonebridge'],
          discarded: [
            {
              uri: 'urn:uuid:gone',
              type: 'health:LabResultRecord',
              sourceSystem: 'Household export',
              sourceIdentity: 'org:larkfield',
              properties: {
                'https://ns.cascadeprotocol.org/health/v1#testName': [
                  { value: `Sodium ${String.fromCharCode(0xd800)} draw` },
                ],
              },
            },
          ],
        },
      ],
      'pod import',
    );
    const raw = fs.readFileSync(path.join(pod, TIER0_JOURNAL_RELATIVE_PATH), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw).not.toMatch(/\\ud[89abAB][0-9a-fA-F]{2}/);
  });
});
