/**
 * `cascade pod doctor` — the recovery path for a pod the write verbs refuse.
 *
 * Every safety property this verb claims has a test here, and every test was
 * built by DAMAGING a real pod the way the shipped defect damaged one (strip the
 * `@prefix` lines an importer wrote, leave the CURIEs that used them) rather
 * than by hand-writing a convenient fixture.
 *
 * The properties under test, in the order they matter:
 *   1. dry run by default — `--write` is required to change a byte
 *   2. ONLY EVER PREPENDS — the original content is a strict suffix of the result
 *   3. the repaired text parses BEFORE anything is written
 *   4. the original is backed up before the write
 *   5. a prefix outside the registry is a refusal, never a guessed namespace
 *   6. idempotent — a second run has nothing to do
 *   7. (encrypted-pod transparency lives in pod-doctor-encrypted.test.ts, which
 *      is split out because the Argon2id KDF makes it slow)
 *
 * Plus the two that guard the SCOPE of the verb: a healthy pod is byte-identical
 * after `--write`, and a repaired `settings/publicTypeIndex.ttl` keeps its
 * load-bearing comments verbatim — the property that makes it safe to point this
 * at human-curated scaffolding at all.
 *
 * All fixtures are synthetic and PHI-free.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Parser } from 'n3';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { KNOWN_PREFIXES } from '../src/lib/bucket-write.js';
import {
  DOCTOR_PREFIXES,
  REPAIR_ONLY_PREFIXES,
  BACKUP_SUFFIX,
  planPrefixRepair,
  diagnoseText,
  declaredPrefixes,
  strictParseTurtle,
  assertPrependOnly,
  doctorExitCode,
  type DoctorReport,
} from '../src/lib/pod-doctor.js';

const TEST_TIMEOUT_MS = 60_000;

function buildProgram(): Command {
  const program = new Command();
  program
    .name('cascade')
    .exitOverride()
    .option('--verbose', 'Verbose output', false)
    .option('--json', 'Output JSON', false);
  registerPodCommand(program);
  return program;
}

/**
 * Streams are kept APART. Doctor prints its report on stdout and shouts about
 * files it could not read on stderr, and a harness that merges them cannot tell
 * the two claims apart — nor parse the report.
 */
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const program = buildProgram();
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
  } catch {
    /* exitOverride throws; exitCode carries the failure */
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
}

/** Run doctor in `--json` mode and return the parsed report. */
async function doctorJson(
  args: string[],
): Promise<{ report: DoctorReport; stderr: string; exitCode: number }> {
  const r = await runCli(['--json', 'pod', 'doctor', ...args]);
  const start = r.stdout.indexOf('{');
  expect(start, `no JSON in doctor output: ${r.stdout}`).toBeGreaterThanOrEqual(0);
  return {
    report: JSON.parse(r.stdout.slice(start, r.stdout.lastIndexOf('}') + 1)) as DoctorReport,
    stderr: r.stderr,
    exitCode: r.exitCode,
  };
}

let tmpDirs: string[] = [];
function mkTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-doctor-'));
  tmpDirs.push(d);
  return d;
}

beforeEach(() => {
  tmpDirs = [];
});
afterEach(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs = [];
});

/** One medication whose only code is RxNorm, so the bucket really declares `rxnorm:`. */
const RXNORM_BUNDLE = {
  resourceType: 'Bundle',
  type: 'collection',
  entry: [
    {
      resource: {
        resourceType: 'MedicationStatement',
        id: 'm1',
        status: 'active',
        medicationCodeableConcept: {
          coding: [
            {
              system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
              code: '860975',
              display: 'Metformin 500 MG',
            },
          ],
        },
        subject: { reference: 'Patient/p1' },
      },
    },
  ],
};

/** The strict parse the whole-pod read performs, and that a damaged bucket fails. */
function parses(file: string): boolean {
  try {
    new Parser({ format: 'Turtle' }).parse(fs.readFileSync(file, 'utf-8'));
    return true;
  } catch {
    return false;
  }
}

/** Init a pod and import the RxNorm bundle, so its bucket carries importer-only prefixes. */
async function importedPod(): Promise<{ podDir: string; medsPath: string }> {
  const base = mkTmpDir();
  const podDir = path.join(base, 'pod');
  const bundle = path.join(base, 'bundle.json');
  fs.writeFileSync(bundle, JSON.stringify(RXNORM_BUNDLE), 'utf-8');

  expect((await runCli(['pod', 'init', podDir])).exitCode).toBe(0);
  expect((await runCli(['pod', 'import', podDir, bundle])).exitCode).toBe(0);

  const medsPath = path.join(podDir, 'clinical', 'medications.ttl');
  expect(fs.readFileSync(medsPath, 'utf-8')).toContain('rxnorm:860975');
  return { podDir, medsPath };
}

/**
 * Damage a file exactly the way the shipped defect did: delete the `@prefix`
 * block, keep the body that uses it.
 */
function stripPrefixHeader(file: string): Buffer {
  const text = fs.readFileSync(file, 'utf-8');
  const body = text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('@prefix'))
    .join('\n');
  fs.writeFileSync(file, body, 'utf-8');
  // The fixture must actually create the hazard, or every assertion is vacuous.
  expect(parses(file), 'the fixture is not actually damaged').toBe(false);
  return fs.readFileSync(file);
}

/** Every file under `dir`, pod-relative, with its bytes. */
function snapshot(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.set(path.relative(dir, full), fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

function expectUnchanged(before: Map<string, Buffer>, dir: string): void {
  const after = snapshot(dir);
  expect([...after.keys()].sort(), 'files appeared or vanished').toEqual([...before.keys()].sort());
  for (const [rel, bytes] of before) {
    expect(after.get(rel)!.equals(bytes), `${rel} was modified`).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// The repair the verb exists for
// ---------------------------------------------------------------------------

describe('repairing the damage the real bug produced', () => {
  it('repairs the bucket and the pod reads again through the real CLI', async () => {
    const { podDir, medsPath } = await importedPod();
    stripPrefixHeader(medsPath);

    // The pod really is unreadable first, or "it reads afterwards" proves nothing.
    expect((await runCli(['--json', 'pod', 'query', podDir, '--medications'])).exitCode).not.toBe(0);

    const fixed = await doctorJson([podDir, '--write']);
    expect(fixed.exitCode).toBe(0);
    expect(fixed.report.repaired).toBe(1);
    expect(fixed.report.findings[0].file).toBe('clinical/medications.ttl');
    expect(fixed.report.findings[0].missingPrefixes).toContain('rxnorm');

    expect(parses(medsPath)).toBe(true);
    const q = await runCli(['--json', 'pod', 'query', podDir, '--medications']);
    expect(q.exitCode).toBe(0);
    expect(q.stdout).toContain('Metformin 500 MG');
  }, TEST_TIMEOUT_MS);

  it('is idempotent: a second --write has nothing to do', async () => {
    const { podDir, medsPath } = await importedPod();
    stripPrefixHeader(medsPath);
    expect((await doctorJson([podDir, '--write'])).report.repaired).toBe(1);

    const after = snapshot(podDir);
    const second = await doctorJson([podDir, '--write']);
    expect(second.exitCode).toBe(0);
    expect(second.report.repaired).toBe(0);
    expect(second.report.findings).toEqual([]);
    expectUnchanged(after, podDir);
  }, TEST_TIMEOUT_MS);

  it('adds every declaration the body uses and NOT ONE MORE', async () => {
    const { podDir, medsPath } = await importedPod();
    const before = fs.readFileSync(medsPath, 'utf-8');
    const declaredBefore = declaredPrefixes(before);
    stripPrefixHeader(medsPath);

    await runCli(['pod', 'doctor', podDir, '--write']);

    const after = fs.readFileSync(medsPath, 'utf-8');
    // A declaration the body does not use is not a repair, it is noise the user
    // did not ask for in a file holding their health record.
    for (const p of declaredPrefixes(after)) {
      expect(declaredBefore.has(p), `doctor authored an unused declaration: ${p}:`).toBe(true);
      expect(after.includes(`${p}:`), `${p}: was declared but is unused`).toBe(true);
    }
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Property 1: dry run by default
// ---------------------------------------------------------------------------

describe('dry run is the default', () => {
  it('changes nothing at all, and writes no backup, on a damaged pod', async () => {
    const { podDir, medsPath } = await importedPod();
    stripPrefixHeader(medsPath);
    const before = snapshot(podDir);

    const dry = await doctorJson([podDir]);
    expect(dry.exitCode).toBe(1);
    expect(dry.report.mode).toBe('dry-run');
    expect(dry.report.repairable).toBe(1);
    expect(dry.report.repaired).toBe(0);

    expectUnchanged(before, podDir);
    expect(fs.existsSync(medsPath + BACKUP_SUFFIX), 'a dry run wrote a backup').toBe(false);
  }, TEST_TIMEOUT_MS);

  it('leaves a HEALTHY pod byte-identical even under --write', async () => {
    // The zero-change guarantee. A repair tool that reformats a file it had no
    // business touching is a repair tool nobody can be told to run.
    const { podDir } = await importedPod();
    const before = snapshot(podDir);

    const r = await doctorJson([podDir, '--write']);
    expect(r.exitCode).toBe(0);
    expect(r.report.findings).toEqual([]);
    expect(r.report.healthy).toBe(r.report.scanned);
    expect(r.report.scanned).toBeGreaterThan(0);

    expectUnchanged(before, podDir);
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Property 2: only ever prepends
// ---------------------------------------------------------------------------

describe('a repair is a pure prepend', () => {
  it('leaves the original content as an exact suffix of the repaired file', async () => {
    const { podDir, medsPath } = await importedPod();
    const damaged = stripPrefixHeader(medsPath).toString('utf-8');

    await runCli(['pod', 'doctor', podDir, '--write']);

    const repaired = fs.readFileSync(medsPath, 'utf-8');
    expect(repaired.endsWith(damaged), 'the original bytes did not survive verbatim').toBe(true);
    expect(repaired.indexOf(damaged)).toBe(repaired.length - damaged.length);
    expect(repaired.length).toBeGreaterThan(damaged.length);
  }, TEST_TIMEOUT_MS);

  it('backs the original up, and the backup is the damaged bytes exactly', async () => {
    const { podDir, medsPath } = await importedPod();
    const damaged = stripPrefixHeader(medsPath);

    const r = await doctorJson([podDir, '--write']);
    expect(r.report.findings[0].backup).toBe('clinical/medications.ttl' + BACKUP_SUFFIX);
    expect(fs.readFileSync(medsPath + BACKUP_SUFFIX).equals(damaged)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('assertPrependOnly rejects anything that is not a pure prepend', () => {
    // The invariant, tested directly, because it is the guard that would fire if
    // a future change ever made doctor re-serialize instead of prepend.
    expect(() => assertPrependOnly('body', 'HDR\nbody', 'HDR\n')).not.toThrow();
    expect(() => assertPrependOnly('body', 'HDR\nbodyX', 'HDR\n')).toThrow(/pure prepend/);
    expect(() => assertPrependOnly('body', 'HDR\nBODY', 'HDR\n')).toThrow(/pure prepend/);
    expect(() => assertPrependOnly('body', 'body', 'HDR\n')).toThrow(/pure prepend/);
  });
});

// ---------------------------------------------------------------------------
// The scaffolding boundary — why prepend-only is what makes this safe
// ---------------------------------------------------------------------------

describe('human-curated scaffolding is repaired without losing a comment', () => {
  it('keeps publicTypeIndex.ttl\'s comment anchors verbatim through a repair', async () => {
    // These files are deliberately NOT routed through the bucket chokepoint,
    // because re-serializing them drops their comments — and `extended.ttl`
    // regex-anchors PHI population on a literal comment line. Doctor scans them
    // anyway (archived backlog 1.6 was exactly this defect in this exact file),
    // and it is safe ONLY because it prepends. If this goes red, doctor has
    // started rewriting instead of prepending.
    const { podDir } = await importedPod();
    const indexPath = path.join(podDir, 'settings', 'publicTypeIndex.ttl');

    const original = fs.readFileSync(indexPath, 'utf-8');
    const anchors = original
      .split('\n')
      .filter((l) => l.trimStart().startsWith('#') && l.trim().length > 2);
    expect(anchors.length, 'the fixture carries no comments to lose').toBeGreaterThan(3);

    stripPrefixHeader(indexPath);
    const r = await doctorJson([podDir, '--write']);
    expect(r.exitCode).toBe(0);
    expect(r.report.repaired).toBe(1);
    expect(r.report.findings[0].file).toBe('settings/publicTypeIndex.ttl');

    const repaired = fs.readFileSync(indexPath, 'utf-8');
    expect(parses(indexPath)).toBe(true);
    for (const anchor of anchors) {
      expect(repaired, `lost the comment line: ${anchor}`).toContain(anchor);
    }
    // And the triples the index carries are still there, in their original text.
    expect(repaired).toContain('<> a solid:TypeIndex');
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Property 5: never invent a namespace
// ---------------------------------------------------------------------------

describe('a prefix outside the registry is a refusal', () => {
  it('refuses, names the prefix, exits non-zero and leaves the file byte-identical', async () => {
    const { podDir, medsPath } = await importedPod();
    // Damage it the usual way, then re-point one CURIE at a prefix nobody knows.
    fs.writeFileSync(
      medsPath,
      fs.readFileSync(medsPath, 'utf-8').replace(/rxnorm:/g, 'mysteryvocab:'),
      'utf-8',
    );
    const damaged = stripPrefixHeader(medsPath);
    const before = snapshot(podDir);

    const r = await doctorJson([podDir, '--write']);
    expect(r.exitCode).toBe(1);
    expect(r.report.repaired).toBe(0);
    expect(r.report.refused).toBe(1);
    const finding = r.report.findings[0];
    expect(finding.status).toBe('refused');
    expect(finding.damage).toBe('unknown-prefix');
    expect(finding.reason).toContain('mysteryvocab:');

    expect(fs.readFileSync(medsPath).equals(damaged)).toBe(true);
    expect(fs.existsSync(medsPath + BACKUP_SUFFIX), 'a refusal wrote a backup').toBe(false);
    expectUnchanged(before, podDir);
  }, TEST_TIMEOUT_MS);

  it('refuses the WHOLE file even though some of its prefixes are known', () => {
    // Partial repair is the trap: healing `clinical:` and stopping at the
    // unknown one would leave a file that still does not parse AND has been
    // rewritten. It is all or nothing.
    const plan = planPrefixRepair('clinical:s a mysteryvocab:Thing .\n');
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.damage).toBe('unknown-prefix');
    expect(plan.reason).toContain('mysteryvocab');
  });
});

// ---------------------------------------------------------------------------
// Discovery comes from the parser, not from a regex over the text
// ---------------------------------------------------------------------------

describe('missing prefixes are discovered from the parser, not by pattern-matching', () => {
  it('ignores colons in comments, string literals and absolute IRIs', () => {
    // Every one of these would make a regex-based implementation author a
    // declaration the document never asked for. Only `health:` is really used.
    const doc = [
      '# see rxnorm:860975 and loinc:2345-7 for details',
      'health:s health:p "sct:73211009 was recorded" .',
      'health:s health:q <http://example.org/thing#pots:x> .',
    ].join('\n');

    const plan = planPrefixRepair(doc);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.added).toEqual(['health']);
    expect(plan.header).not.toContain('rxnorm');
    expect(plan.header).not.toContain('loinc');
    expect(plan.header).not.toContain('sct:');
    expect(plan.header).not.toContain('pots');
  });

  it('refuses a prefix bound BELOW its first use rather than prepending a second binding', () => {
    // The parser really does report this as an undefined prefix. Prepending
    // would make it parse while silently re-pointing every CURIE above the
    // existing declaration at whichever namespace doctor chose.
    const doc = 'health:s health:p "x" .\n@prefix health: <https://example.org/other#> .\n';
    const plan = planPrefixRepair(doc);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.damage).toBe('prefix-bound-late');
  });

  it('n3 still words an undefined prefix the way the repair reads it', () => {
    // The whole repair hangs off ONE string in a third-party parser's error
    // message. An n3 upgrade that reworded it would not break a build or fail a
    // type check: doctor would simply stop recognising the defect it exists to
    // fix, refuse every damaged bucket as "unparseable", and nobody would find
    // out until a user with a broken pod did. That is a silent capability loss,
    // so the dependency is stated here rather than left implicit.
    const err = strictParseTurtle('<urn:a> rxnorm:p <urn:b> .');
    expect(err.ok).toBe(false);
    if (err.ok) return;
    expect(
      err.error,
      'n3 changed its undefined-prefix message; update UNDEFINED_PREFIX in pod-doctor.ts',
    ).toMatch(/Undefined prefix "rxnorm:"/);
  });

  it('honours the registry it is handed, so the refusal path is not registry-dependent', () => {
    const doc = 'health:s health:p "x" .\n';
    expect(planPrefixRepair(doc, { health: 'https://ns.cascadeprotocol.org/health/v1#' }).ok).toBe(true);
    const empty = planPrefixRepair(doc, {});
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.damage).toBe('unknown-prefix');
  });
});

// ---------------------------------------------------------------------------
// Report, do not repair
// ---------------------------------------------------------------------------

describe('the damage shapes doctor reports instead of repairing', () => {
  it('reports an EMPTY bucket rather than calling it healthy', async () => {
    // An empty file PARSES, as zero triples. `writeResource` is not atomic, so
    // an interrupted write is exactly how a bucket ends up holding nothing —
    // and "no records" must not be the answer to "your records are gone".
    const { podDir, medsPath } = await importedPod();
    fs.writeFileSync(medsPath, '', 'utf-8');
    const before = snapshot(podDir);

    const r = await doctorJson([podDir, '--write']);
    expect(r.exitCode).toBe(1);
    expect(r.report.findings[0].damage).toBe('empty');
    expect(r.report.findings[0].status).toBe('refused');
    expect(r.report.findings[0].nextStep).toBeTruthy();
    expectUnchanged(before, podDir);
  }, TEST_TIMEOUT_MS);

  it('reports a TRUNCATED bucket', async () => {
    const { podDir, medsPath } = await importedPod();
    const text = fs.readFileSync(medsPath, 'utf-8');
    // Cut immediately after a `;`, so the document ends owing a predicate. That
    // is the deterministic form of "the write was interrupted".
    fs.writeFileSync(medsPath, text.slice(0, text.indexOf(';') + 1) + '\n', 'utf-8');
    expect(parses(medsPath)).toBe(false);
    const before = snapshot(podDir);

    const r = await doctorJson([podDir, '--write']);
    expect(r.exitCode).toBe(1);
    expect(r.report.findings[0].damage).toBe('truncated');
    expect(r.report.findings[0].status).toBe('refused');
    expectUnchanged(before, podDir);
  }, TEST_TIMEOUT_MS);

  it('reports a cut that lands MID-TOKEN as truncated too, not as a mystery', () => {
    // The parser only says "eof" when the cut falls between tokens. A cut
    // through the middle of a literal is the same damage from the same cause,
    // and reporting it as a generic syntax error sends the user hunting for a
    // typo they did not make.
    const whole = [
      '@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .',
      'health:s health:p "a complete value" .',
      'health:s health:q "an interrupted val',
    ].join('\n');
    const d = diagnoseText(whole);
    expect(d.kind).toBe('refused');
    if (d.kind !== 'refused') return;
    expect(d.damage).toBe('truncated');
  });

  it('does not call a break in the MIDDLE of a file a truncation', () => {
    // The other direction: the heuristic must not relabel every syntax error.
    const d = diagnoseText(
      [
        '@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .',
        'health:s health:p } { .',
        'health:s health:q "fine" .',
      ].join('\n'),
    );
    expect(d.kind).toBe('refused');
    if (d.kind !== 'refused') return;
    expect(d.damage).toBe('unparseable');
  });

  it('reports an IRI holding a character Turtle forbids, and names the code point', async () => {
    // The pre-fix `add-record` accepted a `--by` value containing a space and
    // wrote a bucket nothing could parse. Input validation closed that, but pods
    // damaged before it exist.
    const { podDir, medsPath } = await importedPod();
    fs.writeFileSync(
      medsPath,
      '@prefix prov: <http://www.w3.org/ns/prov#> .\n' +
        '<urn:uuid:a> prov:wasAttributedTo <https://example.org/Dr Who#me> .\n',
      'utf-8',
    );
    expect(parses(medsPath)).toBe(false);
    const before = snapshot(podDir);

    const r = await doctorJson([podDir, '--write']);
    expect(r.exitCode).toBe(1);
    expect(r.report.findings[0].damage).toBe('illegal-iri');
    expect(r.report.findings[0].reason).toContain('U+0020');
    expectUnchanged(before, podDir);
  }, TEST_TIMEOUT_MS);

  it('reports Turtle that is broken in no recognised way, with a next step', () => {
    const d = diagnoseText(
      '@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .\n}{ ;;\nhealth:s health:p "ok" .\n',
    );
    expect(d.kind).toBe('refused');
    if (d.kind !== 'refused') return;
    expect(d.damage).toBe('unparseable');
    expect(d.nextStep).toBeTruthy();
    // The raw parser message survives, because it names the line.
    expect(d.reason).toMatch(/line 2/);
  });
});

// ---------------------------------------------------------------------------
// Exit codes and the JSON envelope
// ---------------------------------------------------------------------------

describe('exit codes and JSON', () => {
  it('exits 1 with a clear message when there is no pod at that path', async () => {
    const r = await runCli(['pod', 'doctor', path.join(mkTmpDir(), 'nope')]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Pod not found/);
  }, TEST_TIMEOUT_MS);

  it('distinguishes repaired, repairable and refused in one report', async () => {
    const { podDir, medsPath } = await importedPod();
    // Two damaged files: one repairable, one refused.
    stripPrefixHeader(medsPath);
    const conditions = path.join(podDir, 'clinical', 'conditions.ttl');
    fs.writeFileSync(conditions, '<urn:uuid:c> a mysteryvocab:Condition .\n', 'utf-8');

    const dry = await doctorJson([podDir]);
    expect(dry.exitCode).toBe(1);
    expect(dry.report.repairable).toBe(1);
    expect(dry.report.refused).toBe(1);
    expect(dry.report.findings.map((f) => f.status).sort()).toEqual(['refused', 'repairable']);
    for (const f of dry.report.findings) expect(f.reason.length).toBeGreaterThan(0);

    const written = await doctorJson([podDir, '--write']);
    // Damage REMAINS (the refusal), so this must not exit 0.
    expect(written.exitCode).toBe(1);
    expect(written.report.repaired).toBe(1);
    expect(written.report.refused).toBe(1);
    expect(written.report.repairable).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('separates "this pod is damaged" (1) from "I could not read it" (2)', () => {
    const base: DoctorReport = {
      pod: '/p',
      encrypted: false,
      mode: 'write',
      scanned: 1,
      healthy: 1,
      repaired: 0,
      repairable: 0,
      refused: 0,
      unreadable: 0,
      findings: [],
    };
    expect(doctorExitCode(base)).toBe(0);
    expect(doctorExitCode({ ...base, repaired: 3 })).toBe(0);
    expect(doctorExitCode({ ...base, repairable: 1 })).toBe(1);
    expect(doctorExitCode({ ...base, refused: 1 })).toBe(1);
    // Unreadable outranks: a partial look must not be reported as a full one.
    expect(doctorExitCode({ ...base, unreadable: 1 })).toBe(2);
    expect(doctorExitCode({ ...base, refused: 4, unreadable: 1 })).toBe(2);
  });

  it('reports a pod whose encryption manifest is gone, instead of calling it corrupt', async () => {
    // Ciphertext read without a key comes back as replacement characters, and
    // Node's UTF-8 read never fails — so this used to look like "every file in
    // your pod is corrupt Turtle". It is not: the data is intact and the KEY is
    // missing, which is the one diagnosis that changes what the user should do.
    const { podDir, medsPath } = await importedPod();
    // Longer than a GCM envelope's floor (nonce + tag), and not valid UTF-8 —
    // i.e. indistinguishable from a sealed resource, which is the point.
    fs.writeFileSync(medsPath, Buffer.alloc(64, 0x8a));
    const before = snapshot(podDir);

    const r = await doctorJson([podDir, '--write']);
    expect(r.exitCode, 'an unreadable file must not read as mere damage').toBe(2);
    expect(r.report.unreadable).toBe(1);
    const finding = r.report.findings[0];
    expect(finding.damage).toBe('not-text');
    expect(finding.reason).toMatch(/encryption\.json/);
    // And it is said out loud, not buried in a JSON body nobody printed.
    expect(r.stderr).toContain('clinical/medications.ttl');
    expect(r.stderr).toMatch(/NOT the same as those files being healthy/);
    expectUnchanged(before, podDir);
  }, TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// The registry cannot drift from the writers' one
// ---------------------------------------------------------------------------

describe('the doctor prefix registry', () => {
  it('agrees with KNOWN_PREFIXES on every entry, name and namespace', () => {
    // Doctor DERIVES its registry from KNOWN_PREFIXES rather than retyping it,
    // because a second hand-maintained prefix table is precisely the mistake
    // that caused this whole defect family. Derivation makes "an entry is
    // missing" impossible; what this test closes is the one gap left, a
    // repair-only entry SHADOWING a known one with a different namespace.
    for (const [prefix, namespace] of Object.entries(KNOWN_PREFIXES)) {
      expect(DOCTOR_PREFIXES[prefix], `doctor lost or re-pointed ${prefix}:`).toBe(namespace);
    }
    expect(Object.keys(KNOWN_PREFIXES).length).toBeGreaterThan(10);
  });

  it('carries the repair-only extension the record writers do not need', () => {
    // `core:` is the one real damaged pods in the field contain: the pre-fix
    // add-record accepted it as an input CURIE and never declared it.
    expect(DOCTOR_PREFIXES.core).toBe(KNOWN_PREFIXES.cascade);
    // The scaffolding templates' namespaces, which the record writers never emit.
    for (const p of ['rdfs', 'foaf', 'solid', 'ldp', 'dcterms', 'pim', 'rdf']) {
      expect(DOCTOR_PREFIXES[p], `missing scaffolding prefix ${p}:`).toBeTruthy();
    }
    // `dct:` and `dcterms:` are two names for one namespace; they must not drift.
    expect(REPAIR_ONLY_PREFIXES.dcterms).toBe(KNOWN_PREFIXES.dct);
  });

  it('every namespace it will author is an absolute IRI', () => {
    for (const [prefix, ns] of Object.entries(DOCTOR_PREFIXES)) {
      expect(ns, `${prefix}: is not absolute`).toMatch(/^https?:\/\/\S+$/);
      expect(ns, `${prefix}: has whitespace`).not.toMatch(/\s/);
    }
  });
});
