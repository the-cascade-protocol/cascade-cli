/**
 * `cascade pod reconcile` — the verb that can clean up a pod's OWN duplicates.
 *
 * WHAT IT IS FOR
 * --------------
 * `pod import --reconcile-existing` compares arriving records against stored
 * ones and, deliberately, never compares two stored records with each other. So
 * duplicates already IN a pod were permanent: no sequence of imports would ever
 * look at them. This verb is the same reconciler pointed at pod content.
 *
 * WHAT THESE TESTS HOLD
 * ---------------------
 * Mostly the SAFETY, because the risky half of this verb is not the matching
 * (that machinery is tested to death elsewhere) but the fact that it rewrites
 * records the user did not just hand over:
 *
 *   - dry run is the DEFAULT, and a dry run leaves the pod byte-identical;
 *   - --apply is what mutates, and it only merges what the dry run reported;
 *   - an unreadable bucket refuses the WHOLE mutation, because a merged result
 *     that is missing those records would delete them if written;
 *   - conflicts go into the same queue `pod conflicts` reads;
 *   - tier-0 merges are journaled so they can be undone.
 *
 * All fixture data is synthetic and PHI-free.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Parser } from 'n3';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { readTier0Journal, TIER0_JOURNAL_RELATIVE_PATH } from '../src/lib/tier0-journal.js';

const INSTANT = '2031-05-20T09:14:00Z';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * The record SUBJECTS a bucket holds.
 *
 * Deliberately not a string search for the IRI. A merged-away subject is still
 * NAMED by the survivor's `cascade:mergedFrom` / `prov:wasDerivedFrom` lineage,
 * which is the point of that lineage and is left dangling by design — so
 * "the file contains this IRI" is true of a record that no longer exists, and a
 * containment check would read a correct merge as a failed one.
 */
function recordSubjects(bucketPath: string): string[] {
  const ttl = fs.readFileSync(bucketPath, 'utf-8');
  return [
    ...new Set(
      new Parser({ format: 'Turtle' })
        .parse(ttl)
        .filter((q) => q.predicate.value === RDF_TYPE)
        .map((q) => q.subject.value),
    ),
  ].sort();
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const program = new Command();
  program
    .name('cascade')
    .exitOverride()
    .option('--verbose', 'Verbose output', false)
    .option('--json', 'Output JSON', false);
  registerPodCommand(program);

  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.map(String).join(' '));
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    out.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  process.exitCode = 0;
  try {
    await program.parseAsync(['node', 'cascade', ...args]);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function makePod(): Promise<string> {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-pod-reconcile-'));
  dirs.push(d);
  const podDir = path.join(d, 'pod');
  const init = await runCli(['pod', 'init', podDir]);
  expect(init.exitCode).toBe(0);
  return podDir;
}

const PREFIXES = `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .
`;

interface LabOpts {
  uri: string;
  batch: string;
  origin?: string;
  performed?: string;
  value?: string;
  name?: string;
  loinc?: string;
}

function labRecord(o: LabOpts): string {
  const origin = o.origin ? `  cascade:sourceIdentity "${o.origin}" ;\n` : '';
  return `<${o.uri}> a health:LabResultRecord ;
  cascade:sourceSystem "${o.batch}" ;
${origin}  health:testCode <http://loinc.org/rdf#${o.loinc ?? '2951-2'}> ;
  health:testName "${o.name ?? 'Sodium'}" ;
  health:performedDate "${o.performed ?? INSTANT}" ;
  health:resultValue "${o.value ?? '141'}" .
`;
}

/** Write a lab bucket holding the given records. */
function writeLabs(podDir: string, records: string[]): void {
  fs.writeFileSync(
    path.join(podDir, 'clinical', 'lab-results.ttl'),
    PREFIXES + '\n' + records.join('\n'),
    'utf-8',
  );
}

/** A pod holding two cross-source copies of one draw: the tier-0 shape. */
async function podWithCrossSourceDuplicate(): Promise<string> {
  const podDir = await makePod();
  writeLabs(podDir, [
    labRecord({ uri: 'urn:uuid:lab-a', batch: 'Stonebridge export', origin: 'org:stonebridge' }),
    labRecord({ uri: 'urn:uuid:lab-b', batch: 'Larkfield export', origin: 'org:larkfield' }),
  ]);
  return podDir;
}

// ---------------------------------------------------------------------------

describe('pod reconcile: the pod-only gap it closes', () => {
  it('finds duplicates that an import can never reach', async () => {
    // The premise. `pod import --reconcile-existing` deliberately never compares
    // two stored records, so importing an unrelated file leaves the pair alone;
    // `pod reconcile` is the only thing that sees it.
    const podDir = await podWithCrossSourceDuplicate();
    const before = fs.readFileSync(path.join(podDir, 'clinical', 'lab-results.ttl'), 'utf-8');

    const unrelated = path.join(path.dirname(podDir), 'unrelated.ttl');
    fs.writeFileSync(
      unrelated,
      PREFIXES +
        '\n' +
        labRecord({ uri: 'urn:uuid:lab-other', batch: 'Other', loinc: '2160-0', name: 'Creatinine' }),
      'utf-8',
    );
    await runCli(['pod', 'import', podDir, unrelated]);
    const afterImport = fs.readFileSync(path.join(podDir, 'clinical', 'lab-results.ttl'), 'utf-8');
    expect(afterImport).toContain('lab-a');
    expect(afterImport).toContain('lab-b');

    const r = await runCli(['--json', 'pod', 'reconcile', podDir]);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as { summary: { tier0MergesApplied: number }; recordsBefore: number };
    expect(report.summary.tier0MergesApplied).toBe(1);
    expect(before.length).toBeGreaterThan(0);
  });
});

describe('pod reconcile: dry run is the default', () => {
  it('reports what WOULD merge and writes nothing', async () => {
    const podDir = await podWithCrossSourceDuplicate();
    const bucket = path.join(podDir, 'clinical', 'lab-results.ttl');
    const before = fs.readFileSync(bucket, 'utf-8');

    const r = await runCli(['--json', 'pod', 'reconcile', podDir]);
    expect(r.exitCode).toBe(0);

    const report = JSON.parse(r.stdout) as {
      applied: boolean;
      recordsBefore: number;
      recordsAfter: number;
      filesWritten: string[];
      summary: { exactDuplicatesRemoved: number };
    };
    expect(report.applied).toBe(false);
    expect(report.recordsBefore).toBe(2);
    expect(report.recordsAfter).toBe(1);
    expect(report.summary.exactDuplicatesRemoved).toBe(1);
    expect(report.filesWritten).toEqual([]);

    // THE assertion. A report-first verb that quietly wrote would be worse than
    // one that never claimed to be report-first.
    expect(fs.readFileSync(bucket, 'utf-8')).toBe(before);
    expect(fs.existsSync(path.join(podDir, TIER0_JOURNAL_RELATIVE_PATH))).toBe(false);
  });

  it('says so in words, and says how to apply', async () => {
    const podDir = await podWithCrossSourceDuplicate();
    const r = await runCli(['pod', 'reconcile', podDir]);
    expect(r.stdout).toContain('DRY RUN');
    expect(r.stdout).toContain('Nothing was written');
    expect(r.stdout).toContain('--apply');
  });

  it('counts records the same way before and after, including non-reconcilable ones', async () => {
    // The number a person reads to decide whether to run --apply is
    // "N in, M out", so a fabricated gap between them is the worst thing this
    // report can print.
    //
    // The reconciler's own `finalRecordCount` is the number of GROUPS, and only
    // reconcilable types are ever grouped. A pod's documents, reports and
    // profile pass through as subjects the matcher never sees, so reporting that
    // against a subject count of the input made a pod where NOTHING merged read
    // "3 records in, 2 records out" (measured: 4 in, 3 out on the conformance
    // fixture). Both counts are taken over record subjects in the actual Turtle.
    const podDir = await makePod();
    writeLabs(podDir, [
      labRecord({ uri: 'urn:uuid:lab-a', batch: 'b1', origin: 'org:stonebridge' }),
      labRecord({
        uri: 'urn:uuid:lab-x',
        batch: 'b1',
        origin: 'org:stonebridge',
        loinc: '2160-0',
        name: 'Creatinine',
        value: '1.1',
      }),
    ]);
    // clinical:LaboratoryReport is not a reconcilable type: it passes through.
    fs.writeFileSync(
      path.join(podDir, 'clinical', 'documents.ttl'),
      `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .

<urn:uuid:report-1> a clinical:LaboratoryReport ;
  cascade:sourceSystem "b1" ;
  clinical:documentDate "2031-05-20" .
`,
      'utf-8',
    );

    const r = await runCli(['--json', 'pod', 'reconcile', podDir]);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as { recordsBefore: number; recordsAfter: number };
    expect(report.recordsBefore).toBe(3);
    expect(report.recordsAfter).toBe(3);
  });

  it('is a clean no-op on a pod with nothing to reconcile', async () => {
    const podDir = await makePod();
    writeLabs(podDir, [
      labRecord({ uri: 'urn:uuid:lab-a', batch: 'b1', origin: 'org:stonebridge' }),
      labRecord({
        uri: 'urn:uuid:lab-x',
        batch: 'b1',
        origin: 'org:stonebridge',
        loinc: '2160-0',
        name: 'Creatinine',
        value: '1.1',
      }),
    ]);
    const r = await runCli(['--json', 'pod', 'reconcile', podDir]);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as { recordsBefore: number; recordsAfter: number };
    expect(report.recordsBefore).toBe(2);
    expect(report.recordsAfter).toBe(2);
  });
});

describe('pod reconcile --apply', () => {
  it('merges the pair the dry run reported, and only that', async () => {
    const podDir = await podWithCrossSourceDuplicate();
    const dry = JSON.parse((await runCli(['--json', 'pod', 'reconcile', podDir])).stdout) as {
      recordsAfter: number;
    };

    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--apply']);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as { applied: boolean; filesWritten: string[]; recordsAfter: number };
    expect(report.applied).toBe(true);
    expect(report.filesWritten).toContain('clinical/lab-results.ttl');
    // The apply run produced the record count the dry run promised.
    expect(report.recordsAfter).toBe(dry.recordsAfter);

    const survivors = recordSubjects(path.join(podDir, 'clinical', 'lab-results.ttl'));
    expect(survivors).toHaveLength(1);
    expect(['urn:uuid:lab-a', 'urn:uuid:lab-b']).toContain(survivors[0]);
  });

  it('journals the tier-0 merge with the discarded record, so it can be undone', async () => {
    const podDir = await podWithCrossSourceDuplicate();
    await runCli(['pod', 'reconcile', podDir, '--apply']);

    const journal = readTier0Journal(podDir);
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0].appliedBy).toBe('pod reconcile --apply');
    const merge = journal.entries[0].merges[0];
    expect(merge.origins).toEqual(['org:larkfield', 'org:stonebridge']);
    expect(merge.discarded).toHaveLength(1);

    // The retained content is complete enough to restore the record.
    const props = merge.discarded[0].properties;
    expect(props['https://ns.cascadeprotocol.org/health/v1#resultValue'][0].value).toBe('141');
    expect(props['https://ns.cascadeprotocol.org/health/v1#performedDate'][0].value).toBe(INSTANT);

    // And the record it names really is the one gone from the pod.
    const subjects = recordSubjects(path.join(podDir, 'clinical', 'lab-results.ttl'));
    expect(subjects).not.toContain(merge.discarded[0].uri);
    expect(subjects).toContain(merge.canonicalUri);
  });

  it('is idempotent: a second apply finds nothing left to merge', async () => {
    const podDir = await podWithCrossSourceDuplicate();
    await runCli(['pod', 'reconcile', podDir, '--apply']);
    const second = await runCli(['--json', 'pod', 'reconcile', podDir, '--apply']);
    const report = JSON.parse(second.stdout) as {
      recordsBefore: number;
      recordsAfter: number;
      summary: { exactDuplicatesRemoved: number; tier0MergesApplied: number };
    };
    expect(report.recordsBefore).toBe(1);
    expect(report.recordsAfter).toBe(1);
    expect(report.summary.exactDuplicatesRemoved).toBe(0);
    expect(report.summary.tier0MergesApplied).toBe(0);
    // The journal did not grow a second, empty entry.
    expect(readTier0Journal(podDir).entries).toHaveLength(1);
  });

  it('raises unmergeable disagreements through the pod conflict queue', async () => {
    const podDir = await makePod();
    // Two sources, same drug, different doses: the flagship conflict, never a
    // silent merge.
    fs.writeFileSync(
      path.join(podDir, 'clinical', 'medications.ttl'),
      `@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .
@prefix clinical: <https://ns.cascadeprotocol.org/clinical/v1#> .

<urn:uuid:med-a> a clinical:Medication ;
  cascade:sourceSystem "Stonebridge export" ;
  cascade:sourceIdentity "org:stonebridge" ;
  clinical:drugName "Lisinopril" ;
  clinical:dosage "10 mg" .

<urn:uuid:med-b> a clinical:Medication ;
  cascade:sourceSystem "Larkfield export" ;
  cascade:sourceIdentity "org:larkfield" ;
  clinical:drugName "Lisinopril" ;
  clinical:dosage "20 mg" .
`,
      'utf-8',
    );

    const dry = JSON.parse((await runCli(['--json', 'pod', 'reconcile', podDir])).stdout) as {
      summary: { conflictsUnresolved: number };
      groups: Array<{ resolved: boolean; recordType: string }>;
    };
    expect(dry.summary.conflictsUnresolved).toBe(1);
    expect(dry.groups.some((g) => !g.resolved)).toBe(true);

    await runCli(['pod', 'reconcile', podDir, '--apply']);
    const conflicts = await runCli(['pod', 'conflicts', podDir, '--format', 'json']);
    const listed = JSON.parse(conflicts.stdout) as Array<{ recordType: string }>;
    expect(listed).toHaveLength(1);

    // Both doses survive: an unresolved conflict must not lose a value.
    const after = fs.readFileSync(path.join(podDir, 'clinical', 'medications.ttl'), 'utf-8');
    expect(after).toContain('10 mg');
    expect(after).toContain('20 mg');
  });
});

describe('pod reconcile: refusing to do damage', () => {
  it('refuses the WHOLE mutation when a record file cannot be read', async () => {
    // The failure that matters most. An unreadable bucket's records are absent
    // from the merged result, so writing that result back would DELETE them.
    // Half-applying is worse than not applying.
    const podDir = await podWithCrossSourceDuplicate();
    const broken = path.join(podDir, 'clinical', 'conditions.ttl');
    fs.writeFileSync(broken, 'this is not turtle at all <<<>>> @@@\n', 'utf-8');
    const labsBefore = fs.readFileSync(path.join(podDir, 'clinical', 'lab-results.ttl'), 'utf-8');
    const brokenBefore = fs.readFileSync(broken, 'utf-8');

    const r = await runCli(['pod', 'reconcile', podDir, '--apply']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('clinical/conditions.ttl');
    expect(r.stderr).toContain('The pod is unchanged.');

    // Nothing moved. Not the readable bucket, not the broken one.
    expect(fs.readFileSync(path.join(podDir, 'clinical', 'lab-results.ttl'), 'utf-8')).toBe(labsBefore);
    expect(fs.readFileSync(broken, 'utf-8')).toBe(brokenBefore);
    expect(fs.existsSync(path.join(podDir, TIER0_JOURNAL_RELATIVE_PATH))).toBe(false);
  });

  it('refuses the DRY RUN too, because a partial read makes every count wrong', async () => {
    // Not just the write. Every number this verb prints is a claim about the
    // pod's whole record set: "these two are the only duplicates" is only true
    // if nothing unread is a third copy. A confident report over a partial read
    // is not a smaller answer, it is a wrong one.
    const podDir = await podWithCrossSourceDuplicate();
    fs.writeFileSync(path.join(podDir, 'clinical', 'conditions.ttl'), 'not turtle <<<\n', 'utf-8');
    const r = await runCli(['--json', 'pod', 'reconcile', podDir]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('clinical/conditions.ttl');
    // And it must not have printed a report that looks like an answer.
    expect(r.stdout).not.toContain('recordsBefore');
  });

  it('ignores an UNREGISTERED .ttl in a record directory entirely', async () => {
    // A pod legitimately keeps notes, analyses and literature as .ttl under
    // clinical/. This verb REPLACES the files it covers, so a stray that it read
    // would have its subjects swept into the merged result, where routing has no
    // bucket for them and files them under passthrough: the note gets relocated
    // as a side effect of reconciling records. So strays are not read, not
    // written, and not a reason to fail.
    //
    // Deliberately VALID Turtle. An unparseable stray would be skipped anyway
    // and would prove nothing about the rule; only a readable one can show that
    // the exclusion is by registration and not by accident.
    const podDir = await podWithCrossSourceDuplicate();
    const stray = path.join(podDir, 'clinical', 'field-notes.ttl');
    fs.writeFileSync(
      stray,
      '@prefix ex: <http://example.org/> .\n<urn:uuid:note-1> a ex:FieldNote ; ex:text "kept" .\n',
      'utf-8',
    );
    const strayBefore = fs.readFileSync(stray, 'utf-8');

    const r = await runCli(['--json', 'pod', 'reconcile', podDir, '--apply']);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as {
      applied: boolean;
      filesRead: string[];
      filesWritten: string[];
    };
    expect(report.applied).toBe(true);
    expect(report.filesRead).not.toContain('clinical/field-notes.ttl');
    expect(report.filesWritten).not.toContain('clinical/field-notes.ttl');

    // Byte-identical, and its subject was not relocated into any bucket.
    expect(fs.readFileSync(stray, 'utf-8')).toBe(strayBefore);
    for (const f of fs.readdirSync(path.join(podDir, 'clinical'))) {
      if (f === 'field-notes.ttl') continue;
      expect(fs.readFileSync(path.join(podDir, 'clinical', f), 'utf-8')).not.toContain('note-1');
    }
  });

  it('exits 2 when the pod cannot be opened at all', async () => {
    const r = await runCli(['pod', 'reconcile', path.join(os.tmpdir(), 'cascade-no-such-pod-xyz')]);
    expect(r.exitCode).toBe(2);
  });
});

describe('pod import applies and journals tier-0 merges too', () => {
  it('merges a batch-internal cross-source duplicate and records it', async () => {
    // Both halves of the ruling on the path that actually carries traffic.
    //
    // The two copies arrive in ONE import, into a pod that already holds an
    // unrelated record. That is precisely the shape the fast path used to drop:
    // the cross-batch pass assigned every new record before the new-against-new
    // pass could seed from any of them, so a batch's own internal duplicates
    // imported un-reconciled whenever the pod had content — which is every
    // import after the first.
    const podDir = await makePod();
    writeLabs(podDir, [
      labRecord({ uri: 'urn:uuid:lab-pre', batch: 'Earlier', loinc: '2160-0', name: 'Creatinine', value: '1.1' }),
    ]);

    const batch = path.join(path.dirname(podDir), 'cross-source-batch.ttl');
    fs.writeFileSync(
      batch,
      PREFIXES +
        '\n' +
        labRecord({ uri: 'urn:uuid:lab-a', batch: 'Household export', origin: 'org:stonebridge' }) +
        '\n' +
        labRecord({ uri: 'urn:uuid:lab-b', batch: 'Household export', origin: 'org:larkfield' }),
      'utf-8',
    );

    const imp = await runCli(['pod', 'import', podDir, batch]);
    expect(imp.exitCode).toBe(0);

    // One survivor from the pair, plus the pre-existing unrelated record.
    const subjects = recordSubjects(path.join(podDir, 'clinical', 'lab-results.ttl'));
    expect(subjects).toContain('urn:uuid:lab-pre');
    expect(subjects.filter((s) => s === 'urn:uuid:lab-a' || s === 'urn:uuid:lab-b')).toHaveLength(1);

    // Silent, but not unrecorded: warned on stderr and journaled with the
    // discarded record.
    expect(imp.stderr).toContain('merged automatically');
    const journal = readTier0Journal(podDir);
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0].appliedBy).toBe('pod import');
    expect(journal.entries[0].merges[0].discarded).toHaveLength(1);
    expect(
      journal.entries[0].merges[0].discarded[0].properties[
        'https://ns.cascadeprotocol.org/health/v1#resultValue'
      ][0].value,
    ).toBe('141');
  });
});

describe('pod reconcile: the report surface', () => {
  it('writes the same report to --report as JSON', async () => {
    const podDir = await podWithCrossSourceDuplicate();
    const reportPath = path.join(path.dirname(podDir), 'reconcile-report.json');
    await runCli(['pod', 'reconcile', podDir, '--report', reportPath]);
    const written = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as {
      applied: boolean;
      tier0Merges: Array<{ canonicalUri: string }>;
    };
    expect(written.applied).toBe(false);
    expect(written.tier0Merges).toHaveLength(1);
  });

  it('names the cross-source duplicate in human-readable output', async () => {
    const podDir = await podWithCrossSourceDuplicate();
    const r = await runCli(['pod', 'reconcile', podDir]);
    expect(r.stdout).toContain('cross-source exact lab duplicates');
    expect(r.stdout).toContain('org:larkfield');
    expect(r.stdout).toContain('org:stonebridge');
    expect(r.stdout).toContain(TIER0_JOURNAL_RELATIVE_PATH);
  });
});
