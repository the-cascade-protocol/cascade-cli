/**
 * A user-supplied IRI that cannot be written as Turtle must be refused, not
 * minted.
 *
 * `pod add-record --by 'https://ex.org/a b#me'` and a property CURIE whose local
 * part contains a space (`{"clinical:drug Name":"x"}`) both used to mint a
 * NamedNode containing a space, serialize it as `<https://ex.org/a b#me>`, and
 * exit 0. Turtle's IRIREF production forbids those characters, so the bucket
 * that came back was unparseable.
 *
 * That was survivable while writers rebuilt the header by text surgery. It is
 * not survivable now: every later `add-record`, `erase` and `import` on that
 * bucket refuses (correctly — an unreadable bucket must never be overwritten),
 * so one typo bricks the bucket permanently and the CLI has no repair verb. The
 * refusal has to happen BEFORE the term is minted.
 *
 * The rule under test is Turtle's own, not one this project invented:
 *   IRIREF ::= '<' ([^#x00-#x20<>"{}|^`\] | UCHAR)* '>'
 *
 * All fixtures are synthetic and PHI-free.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Parser } from 'n3';
import { registerPodCommand } from '../src/commands/pod/index.js';

const MEDS = path.join('clinical', 'medications.ttl');

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

async function runCli(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    chunks.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    chunks.push(a.map(String).join(' '));
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  process.exitCode = 0;
  try {
    await buildProgram().parseAsync(['node', 'cascade', ...args]);
  } catch {
    /* exitOverride throws; exitCode carries the failure */
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return { stdout: chunks.join('\n'), exitCode };
}

let tmpDirs: string[] = [];
function mkPodDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-iri-'));
  tmpDirs.push(d);
  return path.join(d, 'pod');
}
afterEach(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

async function initPod(): Promise<string> {
  const podDir = mkPodDir();
  expect((await runCli(['pod', 'init', podDir])).exitCode).toBe(0);
  return podDir;
}

function addRecord(podDir: string, extra: string[], json = '{"clinical:drugName":"Vitamin D"}') {
  return runCli(['pod', 'add-record', podDir, '--type', 'clinical:Medication', '--json', json, ...extra]);
}

/** Every character Turtle's IRIREF production forbids, plus the reported case. */
const ILLEGAL: Array<[string, string]> = [
  ['a space', 'https://ex.org/a b#me'],
  ['a tab', 'https://ex.org/a\tb#me'],
  ['a newline', 'https://ex.org/a\nb#me'],
  ['a NUL', 'https://ex.org/a\u0000b#me'],
  ['an angle bracket', 'https://ex.org/a<b#me'],
  ['a closing angle bracket', 'https://ex.org/a>b#me'],
  ['a double quote', 'https://ex.org/a"b#me'],
  ['a brace', 'https://ex.org/a{b}#me'],
  ['a pipe', 'https://ex.org/a|b#me'],
  ['a caret', 'https://ex.org/a^b#me'],
  ['a backtick', 'https://ex.org/a`b#me'],
  ['a backslash', 'https://ex.org/a\\b#me'],
];

describe('pod add-record --by: an unwritable IRI is refused before it is minted', () => {
  for (const [label, iri] of ILLEGAL) {
    it(`refuses --by containing ${label}`, async () => {
      const podDir = await initPod();
      const res = await addRecord(podDir, ['--by', iri]);
      expect(res.exitCode, `--by ${JSON.stringify(iri)} was accepted`).toBe(1);
    });
  }

  it('names the offending value in the error', async () => {
    const podDir = await initPod();
    const res = await addRecord(podDir, ['--by', 'https://ex.org/a b#me']);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('https://ex.org/a b#me');
    expect(res.stdout).toMatch(/--by/);
  });

  it('writes no bucket file at all', async () => {
    const podDir = await initPod();
    await addRecord(podDir, ['--by', 'https://ex.org/a b#me']);
    expect(fs.existsSync(path.join(podDir, MEDS))).toBe(false);
  });

  it('leaves an EXISTING bucket byte-identical and still parseable', async () => {
    const podDir = await initPod();
    expect((await addRecord(podDir, [])).exitCode).toBe(0);
    const before = fs.readFileSync(path.join(podDir, MEDS));

    const res = await addRecord(podDir, ['--by', 'https://ex.org/a b#me']);
    expect(res.exitCode).toBe(1);
    const after = fs.readFileSync(path.join(podDir, MEDS));
    expect(after.equals(before)).toBe(true);
    expect(() => new Parser({ format: 'Turtle' }).parse(after.toString('utf-8'))).not.toThrow();
  });

  it('does not brick the bucket: a valid add-record still works afterwards', async () => {
    // The whole reason this matters. A bucket the CLI cannot parse is a bucket
    // every later write refuses, and there is no repair verb.
    const podDir = await initPod();
    await addRecord(podDir, ['--by', 'https://ex.org/a b#me']);
    const ok = await addRecord(podDir, ['--by', 'https://ex.org/alice#me']);
    expect(ok.exitCode).toBe(0);
    const bucket = fs.readFileSync(path.join(podDir, MEDS), 'utf-8');
    expect(() => new Parser({ format: 'Turtle' }).parse(bucket)).not.toThrow();
    expect(bucket).toContain('<https://ex.org/alice#me>');
  });

  it('still accepts legal IRIs, absolute and relative', async () => {
    for (const iri of [
      'https://ex.org/alice#me',
      '/profile/card.ttl#me',
      'urn:uuid:2b3c4d5e-0000-4000-8000-000000000000',
      'https://ex.org/a%20b#me',
      'https://ex.org/café#me',
      'https://ex.org/a?q=1&r=2#me',
    ]) {
      const podDir = await initPod();
      const res = await addRecord(podDir, ['--by', iri]);
      expect(res.exitCode, `legal --by ${iri} was rejected`).toBe(0);
      const bucket = fs.readFileSync(path.join(podDir, MEDS), 'utf-8');
      expect(() => new Parser({ format: 'Turtle' }).parse(bucket)).not.toThrow();
    }
  }, 60_000);
});

describe('pod add-record property CURIEs: an unwritable local part is refused', () => {
  it('refuses a property CURIE whose local part contains a space', async () => {
    const podDir = await initPod();
    const res = await addRecord(podDir, [], '{"clinical:drug Name":"x"}');
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('clinical:drug Name');
    expect(fs.existsSync(path.join(podDir, MEDS))).toBe(false);
  });

  for (const [label, local] of [
    ['a newline', 'drug\nName'],
    ['an angle bracket', 'drug<Name'],
    ['a double quote', 'drug"Name'],
    ['a brace', 'drug{Name'],
    ['a backslash', 'drug\\Name'],
  ] as Array<[string, string]>) {
    it(`refuses a property CURIE local part containing ${label}`, async () => {
      const podDir = await initPod();
      const res = await addRecord(podDir, [], JSON.stringify({ [`clinical:${local}`]: 'x' }));
      expect(res.exitCode, `clinical:${JSON.stringify(local)} was accepted`).toBe(1);
      expect(fs.existsSync(path.join(podDir, MEDS))).toBe(false);
    });
  }

  it('refuses the whole record when ONE property of several is illegal', async () => {
    const podDir = await initPod();
    const res = await addRecord(
      podDir,
      [],
      '{"clinical:drugName":"Vitamin D","clinical:drug Name":"x","clinical:dosage":"10mg"}',
    );
    expect(res.exitCode).toBe(1);
    expect(fs.existsSync(path.join(podDir, MEDS))).toBe(false);
  });

  it('still accepts a normal property set', async () => {
    const podDir = await initPod();
    const res = await addRecord(podDir, [], '{"clinical:drugName":"Lisinopril","clinical:dosage":"10mg"}');
    expect(res.exitCode).toBe(0);
    expect(() => new Parser({ format: 'Turtle' })
      .parse(fs.readFileSync(path.join(podDir, MEDS), 'utf-8'))).not.toThrow();
  });
});

describe('overlay writers: the same rule, at the same chokepoint', () => {
  // amend / annotate / retract / erase all take a --record IRI and a --by actor
  // and mint them the same way. The guard lives in the overlay quad builder so
  // it cannot be reintroduced one command at a time.
  // These assert the message NAMES THE INPUT, not merely that the write fails.
  // The chokepoint backstop already refuses an unwritable term, so exit 1 alone
  // is satisfied without any per-input guard at all — and the error it produces
  // points at a FILE ("a term of .../amendments.ttl"), which tells the user
  // nothing about which flag they mistyped. Naming the flag or the predicate is
  // the entire value of validating at the input, so that is what is pinned.
  it('refuses pod amend --record with an unwritable IRI, naming the predicate', async () => {
    const podDir = await initPod();
    const res = await runCli([
      'pod', 'amend', podDir, '--record', 'urn:uuid:a b', '--property', 'clinical:drugName', '--value', 'x',
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('urn:uuid:a b');
    expect(res.stdout, 'the error must say WHICH input was rejected').toContain('workbench:amendsRecord');
    expect(fs.existsSync(path.join(podDir, 'annotations', 'amendments.ttl'))).toBe(false);
  });

  it('refuses pod annotate --by with an unwritable IRI, naming the flag', async () => {
    const podDir = await initPod();
    const res = await runCli([
      'pod', 'annotate', podDir, '--record', 'urn:uuid:abc', '--text', 'hi', '--by', 'https://ex.org/a b#me',
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('https://ex.org/a b#me');
    expect(res.stdout, 'the error must say WHICH input was rejected').toContain('--by');
  });

  it('refuses pod retract --superseded-by with an unwritable IRI', async () => {
    const podDir = await initPod();
    const res = await runCli([
      'pod', 'retract', podDir, '--record', 'urn:uuid:abc', '--superseded-by', 'urn:uuid:k ept',
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('urn:uuid:k ept');
    expect(res.stdout).toContain('workbench:supersededBy');
  });

  it('still accepts a well-formed amend', async () => {
    const podDir = await initPod();
    const add = await addRecord(podDir, []);
    expect(add.exitCode).toBe(0);
    const recordUri = (fs.readFileSync(path.join(podDir, MEDS), 'utf-8').match(/urn:uuid:[0-9a-f-]+/) ?? [])[0];
    expect(recordUri).toBeTruthy();
    const res = await runCli([
      'pod', 'amend', podDir, '--record', recordUri!, '--property', 'clinical:drugName', '--value', 'Vitamin D3',
    ]);
    expect(res.exitCode).toBe(0);
  });
});
