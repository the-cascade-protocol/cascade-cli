/**
 * The JSON boundary is a GUARANTEE, not a passthrough.
 *
 * MEASURED, on a real pod: `pod query --all --edges --json` wrote 3.7 MB to
 * stdout, exited 0, wrote nothing to stderr, and `jq` refused to parse a byte of
 * it. A synthetic pod through the same binary was pure, so the emitter looked
 * fine and the defect looked like the user's.
 *
 * The cause is one code unit. Turtle admits `\uXXXX` escapes, so a pod literal
 * may hold an UNPAIRED surrogate; nothing on the read path rejects it, and
 * `JSON.stringify` (well-formed, ES2019) faithfully re-emits it as the escape
 * `\ud800`. That text is accepted by `JSON.parse` and by Python's `json`, and
 * REJECTED by jq:
 *
 *     jq: parse error: Invalid \uXXXX\uXXXX surrogate pair escape
 *
 * So "we round-tripped it through JSON.stringify" is not a guarantee that the
 * bytes are readable by the tools people actually pipe this into. The guarantee
 * has to be stated and tested against those tools, which is what this file is:
 * every JSON-emitting surface, over a fixture built to contain every hostile
 * class we know of, checked with jq AND python AND JSON.parse. One parser
 * accepting is not the bar; a lone surrogate passes two of the three.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toJsonText, sanitizeForJson } from '../src/lib/json-output.js';
import { formatOutput } from '../src/lib/output.js';
import { registerPodCommand } from '../src/commands/pod/index.js';

/** Run one CLI invocation in-process, capturing stdout and the exit code. */
async function runCli(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const program = new Command();
  program
    .name('cascade')
    .exitOverride()
    .option('--verbose', 'Verbose output', false)
    .option('--json', 'Output JSON', false);
  registerPodCommand(program);

  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    chunks.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
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
  return { stdout: chunks.join('\n'), exitCode };
}

// ---------------------------------------------------------------------------
// The hostile fixture
// ---------------------------------------------------------------------------

const LONE_HIGH = String.fromCharCode(0xd800);
const LONE_LOW = String.fromCharCode(0xdfff);
/** A low surrogate BEFORE a high one: two code units, no valid pair. */
const REVERSED_PAIR = String.fromCharCode(0xdfff) + String.fromCharCode(0xd800);
/** A well-formed pair (U+1F9EC, DNA). Must survive intact. */
const VALID_PAIR = '\u{1F9EC}';
/** C0 controls, plus DEL, which is not C0 and is emitted raw. */
const CONTROLS = 'a' + String.fromCharCode(0x00, 0x01, 0x1f) + 'b' + String.fromCharCode(0x7f) + 'c';
/** What invalid UTF-8 input bytes become once Node decodes them as utf-8. */
const DECODED_INVALID_UTF8 = Buffer.from([0xff, 0xfe, 0x80, 0x41]).toString('utf-8');

/** Every hostile class in one value, including in an object KEY. */
function hostileFixture(): unknown {
  return {
    records: [
      { iri: 'urn:uuid:a', value: `lab result ${LONE_HIGH} truncated` },
      { iri: 'urn:uuid:b', value: `${LONE_LOW}${REVERSED_PAIR}` },
      { iri: 'urn:uuid:c', value: CONTROLS },
      { iri: 'urn:uuid:d', value: DECODED_INVALID_UTF8 },
      { iri: 'urn:uuid:e', value: `keep ${VALID_PAIR} intact` },
    ],
    // A hostile OBJECT KEY. A value-only sanitizer misses this entirely.
    [`edge${LONE_HIGH}key`]: ['urn:uuid:a'],
    counts: { total: 5, nested: { deep: [{ s: LONE_HIGH }] } },
  };
}

// ---------------------------------------------------------------------------
// The three parsers
// ---------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'cascade-json-purity-'));
let fixtureSeq = 0;

/** Write `text` to a file and return its path (each call gets a fresh path). */
function toFile(text: string): string {
  const p = join(tmp, `payload-${fixtureSeq++}.json`);
  writeFileSync(p, text, 'utf-8');
  return p;
}

function jqAccepts(text: string): { ok: boolean; detail: string } {
  try {
    execFileSync('jq', ['-e', '.', toFile(text)], { stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true, detail: '' };
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer; status?: number };
    // `jq -e .` exits 1 for a valid document whose result is null/false. That is
    // not a parse failure, and this fixture is an object, so treat only a real
    // error as a rejection.
    return { ok: false, detail: err.stderr?.toString() ?? String(e) };
  }
}

function pythonAccepts(text: string): { ok: boolean; detail: string } {
  try {
    execFileSync('python3', ['-c', 'import json,sys; json.load(open(sys.argv[1]))', toFile(text)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return { ok: true, detail: '' };
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer };
    return { ok: false, detail: err.stderr?.toString() ?? String(e) };
  }
}

function jsonParseAccepts(text: string): { ok: boolean; detail: string } {
  try {
    JSON.parse(text);
    return { ok: true, detail: '' };
  } catch (e: unknown) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** All three, as one assertion, so a single-parser pass cannot look like a pass. */
function assertEveryParserAccepts(text: string, what: string): void {
  const jq = jqAccepts(text);
  const py = pythonAccepts(text);
  const js = jsonParseAccepts(text);
  expect(
    { jq: jq.ok, python: py.ok, jsonParse: js.ok },
    `${what} was not accepted by every JSON parser.\n` +
      `  jq:         ${jq.ok ? 'ok' : jq.detail.trim()}\n` +
      `  python3:    ${py.ok ? 'ok' : py.detail.trim()}\n` +
      `  JSON.parse: ${js.ok ? 'ok' : js.detail.trim()}`,
  ).toEqual({ jq: true, python: true, jsonParse: true });
}

// ---------------------------------------------------------------------------

describe('the JSON encoder guarantee', () => {
  it('is measurably needed: raw JSON.stringify of the fixture is rejected by jq', () => {
    // The premise. If this ever stops being true the guarantee is still wanted,
    // but the reason recorded above has changed and a person should know.
    const raw = JSON.stringify(hostileFixture(), null, 2);
    const jq = jqAccepts(raw);
    expect(jq.ok, 'plain JSON.stringify is now accepted by jq; the recorded defect has changed shape').toBe(false);
    expect(jq.detail).toMatch(/surrogate/i);
    // ...and the other two accept it, which is why this was invisible.
    expect(jsonParseAccepts(raw).ok).toBe(true);
    expect(pythonAccepts(raw).ok).toBe(true);
  });

  it('toJsonText output is accepted by jq AND python AND JSON.parse', () => {
    assertEveryParserAccepts(toJsonText(hostileFixture()), 'toJsonText');
  });

  it('formatOutput --json output is accepted by all three', () => {
    const text = formatOutput(hostileFixture(), { json: true, verbose: false });
    assertEveryParserAccepts(text, 'formatOutput({json:true})');
  });

  it('replaces every lone surrogate with U+FFFD, in values AND in keys', () => {
    const out = JSON.parse(toJsonText(hostileFixture())) as {
      records: Array<{ value: string }>;
      counts: { nested: { deep: Array<{ s: string }> } };
      [k: string]: unknown;
    };
    expect(out.records[0].value).toBe('lab result � truncated');
    expect(out.records[1].value).toBe('���');
    expect(out.counts.nested.deep[0].s).toBe('�');
    expect(Object.keys(out)).toContain('edge�key');
  });

  it('leaves well-formed content byte-identical to JSON.stringify', () => {
    // The guarantee is a repair, not a re-encoding. Anything already valid must
    // come out unchanged, or every consumer of every --json surface sees churn.
    const clean = { a: 1, b: 'plain', c: [true, null, 'emoji \u{1F9EC}'], 'ünïcode': { d: 'é' } };
    expect(toJsonText(clean)).toBe(JSON.stringify(clean, null, 2));
  });

  it('preserves valid surrogate pairs, C0 escapes and decoded-invalid-UTF-8 sentinels', () => {
    const out = JSON.parse(toJsonText(hostileFixture())) as { records: Array<{ value: string }> };
    expect(out.records[4].value).toBe(`keep ${VALID_PAIR} intact`);
    expect(out.records[2].value).toBe(CONTROLS);
    expect(out.records[3].value).toBe(DECODED_INVALID_UTF8);
  });

  it('emits well-formed UTF-8 bytes: no unpaired surrogate survives the encode', () => {
    // The byte-level statement of the same guarantee. A lone surrogate has NO
    // UTF-8 encoding, so a text that still contains one cannot be written to a
    // file or a socket without the runtime substituting something.
    const text = toJsonText(hostileFixture());
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false);
    expect(Buffer.from(text, 'utf-8').toString('utf-8')).toBe(text);
  });

  it('sanitizeForJson is a no-op on data that needs no repair', () => {
    const clean = { a: [1, 'x', null], b: { c: true } };
    expect(sanitizeForJson(clean)).toEqual(clean);
  });
});

// ---------------------------------------------------------------------------
// End to end, on the surface the defect was measured on
// ---------------------------------------------------------------------------
//
// The unit tests above pin the encoder. This one pins that `pod query` REACHES
// it, over a pod whose Turtle carries the hostile literal — which is the whole
// chain, and the only version of this test that would have caught the original
// defect. Turtle admits `\uXXXX` escapes and N3 decodes `\uD800` into a live
// unpaired surrogate (verified), so the pod below is a faithful small copy of
// the real one, and every byte of it is synthetic.

describe('pod query --all --edges --json over a pod holding hostile literals', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it('emits output every JSON parser accepts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cascade-hostile-pod-'));
    tmpDirs.push(dir);
    const podDir = join(dir, 'pod');

    const init = await runCli(['pod', 'init', podDir]);
    expect(init.exitCode).toBe(0);

    // A lab bucket whose literals carry a lone surrogate (both halves, and a
    // reversed pair), a DEL, and a well-formed astral pair that must survive.
    writeFileSync(
      join(podDir, 'clinical', 'lab-results.ttl'),
      [
        '@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .',
        '@prefix health: <https://ns.cascadeprotocol.org/health/v1#> .',
        '',
        '<urn:uuid:hostile-lab-1> a health:LabResultRecord ;',
        '    health:testName "Sodium \\uD800 truncated" ;',
        '    health:testCode <http://loinc.org/rdf#2951-2> ;',
        '    health:performedDate "2031-05-20" ;',
        '    health:resultValue "141.0" ;',
        '    cascade:sourceSystem "hostile-batch" .',
        '',
        '<urn:uuid:hostile-lab-2> a health:LabResultRecord ;',
        '    health:testName "Potassium \\uDFFF\\uD800 reversed \\u007F \\uD83E\\uDDEC" ;',
        '    health:testCode <http://loinc.org/rdf#2823-3> ;',
        '    health:performedDate "2031-05-20" ;',
        '    health:resultValue "4.1" ;',
        '    cascade:sourceSystem "hostile-batch" .',
        '',
      ].join('\n'),
      'utf-8',
    );

    const q = await runCli(['--json', 'pod', 'query', podDir, '--all', '--edges']);
    expect(q.exitCode).toBe(0);
    expect(q.stdout.length).toBeGreaterThan(0);
    assertEveryParserAccepts(q.stdout, 'pod query --all --edges --json');

    // The record is still THERE and still readable. Repairing must not be a
    // quiet way of dropping the record that carried the damage.
    const parsed = JSON.parse(q.stdout) as Record<string, unknown>;
    const flat = JSON.stringify(parsed);
    expect(flat).toContain('Sodium');
    expect(flat).toContain('Potassium');
    // The valid astral pair survived; the broken halves became U+FFFD.
    expect(flat).toContain(VALID_PAIR);
    expect(flat).toContain('�');
  });
});
