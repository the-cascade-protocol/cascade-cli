/**
 * The pod's identifier: `cascade:podIdentifier` on `<#me>` in the owner-only
 * `profile/extended.ttl` (core v3.11).
 *
 * The properties under test:
 *   1. `pod init` mints exactly one, well-formed, plain and encrypted, and two
 *      pods never share one.
 *   2. It is read back, never recomputed: a second call returns the same value
 *      and leaves the file byte-identical.
 *   3. A pod created without one gets one on first need, WRITTEN before the
 *      value is returned, with every existing byte of the profile kept.
 *   4. Two values, a malformed value, or a profile that does not parse is a
 *      typed refusal, and nothing is written.
 *   5. It never appears in `card.ttl`, and never in a FHIR export.
 *   6. `pod doctor` reports a missing one as a notice (and mints it under
 *      `--write`), and refuses two values, a malformed one, or one on the card.
 *
 * All fixtures are synthetic and PHI-free.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { resolveDek, readResource, writeResource } from '../src/lib/pod-encryption.js';
import {
  ensurePodIdentifier,
  readPodIdentifier,
  readUsablePodIdentifier,
  PodIdentifierError,
  POD_IDENTIFIER_FORM,
  POD_IDENTIFIER_IRI,
} from '../src/lib/pod-identifier.js';
import { convertCascadeToFhir } from '../src/lib/fhir-converter/cascade-to-fhir.js';
import type { DoctorReport } from '../src/lib/pod-doctor.js';

const TEST_TIMEOUT_MS = 60_000;
const PASSPHRASE = 'pod-identifier-test-passphrase';

function buildProgram(): Command {
  const program = new Command();
  program.name('cascade').exitOverride().option('--verbose', 'Verbose output', false).option('--json', 'Output JSON', false);
  registerPodCommand(program);
  return program;
}

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

async function doctorJson(args: string[]): Promise<{ report: DoctorReport; exitCode: number }> {
  const r = await runCli(['--json', 'pod', 'doctor', ...args]);
  const start = r.stdout.indexOf('{');
  expect(start, `no JSON in doctor output: ${r.stdout}`).toBeGreaterThanOrEqual(0);
  return { report: JSON.parse(r.stdout.slice(start, r.stdout.lastIndexOf('}') + 1)) as DoctorReport, exitCode: r.exitCode };
}

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-pod-id-'));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.CASCADE_POD_PASSPHRASE;
});

let seq = 0;
async function initPod(encrypt = false): Promise<string> {
  const dir = path.join(root, `pod-${++seq}`);
  if (encrypt) process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;
  const r = await runCli(['pod', 'init', dir, ...(encrypt ? ['--encrypt'] : [])]);
  delete process.env.CASCADE_POD_PASSPHRASE;
  expect(r.exitCode, r.stderr).toBe(0);
  return dir;
}

const ext = (pod: string): string => path.join(pod, 'profile', 'extended.ttl');
const card = (pod: string): string => path.join(pod, 'profile', 'card.ttl');

/** Occurrences of the predicate as it is written (full IRI or CURIE). */
function statementCount(text: string): number {
  return (text.match(/podIdentifier/g) ?? []).length - (text.match(/#\s[^\n]*podIdentifier/g) ?? []).length;
}

/** Turn a freshly initialised pod into one created before the identifier existed. */
function stripIdentifier(pod: string, dek?: Buffer): string {
  const text = readResource(pod, ext(pod), dek);
  const legacy = text.slice(0, text.indexOf("\n# The pod's identifier"));
  expect(legacy).not.toContain('podIdentifier');
  writeResource(pod, ext(pod), legacy, dek);
  return legacy;
}

describe('pod init mints the identifier', () => {
  it('writes exactly one well-formed value, on <#me> in extended.ttl, and none in card.ttl', async () => {
    const pod = await initPod();
    const state = readPodIdentifier(pod);
    expect(state.status).toBe('present');
    const value = (state as { value: string }).value;
    expect(value).toMatch(POD_IDENTIFIER_FORM);

    const text = fs.readFileSync(ext(pod), 'utf-8');
    expect(statementCount(text)).toBe(1);
    expect(text.split(value).length - 1).toBe(1);
    expect(text).toContain(`^^<http://www.w3.org/2001/XMLSchema#anyURI>`);
    expect(fs.readFileSync(card(pod), 'utf-8')).not.toContain('podIdentifier');
    expect(fs.readFileSync(card(pod), 'utf-8')).not.toContain(value);
    // Owner-only on disk.
    expect(fs.statSync(ext(pod)).mode & 0o077).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('gives two pods two different identifiers', async () => {
    const a = readPodIdentifier(await initPod());
    const b = readPodIdentifier(await initPod());
    expect(a.status).toBe('present');
    expect(b.status).toBe('present');
    expect((a as { value: string }).value).not.toBe((b as { value: string }).value);
  }, TEST_TIMEOUT_MS);
});

describe('ensurePodIdentifier', () => {
  it('reads the value back and writes nothing on a second call (byte-identical)', async () => {
    const pod = await initPod();
    const before = fs.readFileSync(ext(pod));
    const cardBefore = fs.readFileSync(card(pod));
    const first = ensurePodIdentifier(pod);
    const second = ensurePodIdentifier(pod);
    expect(first).toEqual({ value: (readPodIdentifier(pod) as { value: string }).value, minted: false });
    expect(second).toEqual(first);
    expect(fs.readFileSync(ext(pod)).equals(before)).toBe(true);
    expect(fs.readFileSync(card(pod)).equals(cardBefore)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('mints one for a pod created without it, keeping every existing byte of the profile', async () => {
    const pod = await initPod();
    const legacy = stripIdentifier(pod);
    expect(readPodIdentifier(pod)).toEqual({ status: 'absent', file: 'present' });
    // Reading for a dry run writes nothing and has nothing to name from.
    expect(readUsablePodIdentifier(pod)).toBeUndefined();
    expect(fs.readFileSync(ext(pod), 'utf-8')).toBe(legacy);

    const got = ensurePodIdentifier(pod);
    expect(got.minted).toBe(true);
    expect(got.value).toMatch(POD_IDENTIFIER_FORM);

    const after = fs.readFileSync(ext(pod), 'utf-8');
    expect(after.startsWith(legacy)).toBe(true);
    expect(readPodIdentifier(pod)).toEqual({ status: 'present', value: got.value });
    // And from then on it is only read.
    expect(ensurePodIdentifier(pod)).toEqual({ value: got.value, minted: false });
  }, TEST_TIMEOUT_MS);

  it('creates extended.ttl and the card link when the pod has no extended profile', async () => {
    const pod = await initPod();
    fs.rmSync(ext(pod));
    // A card with no link to the extended profile, as a hand-built pod may have.
    const cardText = fs.readFileSync(card(pod), 'utf-8').replace('    rdfs:seeAlso </profile/extended.ttl> ;\n', '');
    fs.writeFileSync(card(pod), cardText);
    expect(readPodIdentifier(pod)).toEqual({ status: 'absent', file: 'missing' });

    const got = ensurePodIdentifier(pod);
    expect(got.minted).toBe(true);
    expect(readPodIdentifier(pod)).toEqual({ status: 'present', value: got.value });

    const cardAfter = fs.readFileSync(card(pod), 'utf-8');
    expect(cardAfter.startsWith(cardText)).toBe(true);
    expect(cardAfter).toContain('<http://www.w3.org/2000/01/rdf-schema#seeAlso> </profile/extended.ttl>');
    expect(cardAfter).not.toContain('podIdentifier');
    expect(cardAfter).not.toContain(got.value);
  }, TEST_TIMEOUT_MS);

  describe('refuses, and writes nothing, when the profile cannot give one answer', () => {
    const PREFIXES =
      '@prefix cascade: <https://ns.cascadeprotocol.org/core/v1#> .\n' +
      '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n';
    const A = 'urn:uuid:0b6a4c1e-2f3d-4a5b-8c7d-9e0f1a2b3c4d';
    const B = 'urn:uuid:1c7b5d2f-3e4a-4b6c-9d8e-0f1a2b3c4d5e';
    const cases: Array<[string, string, string]> = [
      ['two values', `<#me> cascade:podIdentifier "${A}"^^xsd:anyURI, "${B}"^^xsd:anyURI .\n`, 'duplicate'],
      ['upper case', `<#me> cascade:podIdentifier "${A.toUpperCase().replace('URN:UUID:', 'urn:uuid:')}"^^xsd:anyURI .\n`, 'malformed'],
      ['not version 4', `<#me> cascade:podIdentifier "urn:uuid:0b6a4c1e-2f3d-1a5b-8c7d-9e0f1a2b3c4d"^^xsd:anyURI .\n`, 'malformed'],
      ['untyped literal', `<#me> cascade:podIdentifier "${A}" .\n`, 'malformed'],
      ['an IRI, not a literal', `<#me> cascade:podIdentifier <${A}> .\n`, 'malformed'],
      ['not on <#me>', `<#pod> cascade:podIdentifier "${A}"^^xsd:anyURI .\n`, 'malformed'],
      ['unparseable', `<#me> cascade:podIdentifier "${A}"^^xsd:anyURI ;\n`, 'unparseable'],
    ];
    for (const [name, body, reason] of cases) {
      it(name, async () => {
        const pod = await initPod();
        fs.writeFileSync(ext(pod), PREFIXES + body);
        const before = fs.readFileSync(ext(pod));
        let caught: unknown;
        try {
          ensurePodIdentifier(pod);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(PodIdentifierError);
        expect((caught as PodIdentifierError).reason).toBe(reason);
        // The read-only door refuses the same way.
        expect(() => readUsablePodIdentifier(pod)).toThrow(PodIdentifierError);
        // No value is echoed into the message.
        expect((caught as Error).message).not.toContain(A);
        expect(fs.readFileSync(ext(pod)).equals(before)).toBe(true);
      }, TEST_TIMEOUT_MS);
    }

    it('an identical statement written twice is one triple, not two values', async () => {
      const pod = await initPod();
      const line = `<#me> cascade:podIdentifier "${A}"^^xsd:anyURI .\n`;
      fs.writeFileSync(ext(pod), PREFIXES + line + line);
      expect(ensurePodIdentifier(pod)).toEqual({ value: A, minted: false });
    }, TEST_TIMEOUT_MS);
  });

  it('round-trips on an encrypted pod: sealed on disk, the same value read back', async () => {
    const pod = await initPod(true);
    const dek = resolveDek(pod, PASSPHRASE);
    try {
      const raw = fs.readFileSync(ext(pod));
      expect(raw.includes(Buffer.from('podIdentifier'))).toBe(false);
      expect(raw.includes(Buffer.from('urn:uuid:'))).toBe(false);

      const state = readPodIdentifier(pod, dek);
      expect(state.status).toBe('present');
      const value = (state as { value: string }).value;
      expect(ensurePodIdentifier(pod, dek)).toEqual({ value, minted: false });
      expect(readResource(pod, card(pod), dek)).not.toContain('podIdentifier');

      // A sealed pod created before the identifier gets one, sealed.
      stripIdentifier(pod, dek);
      const minted = ensurePodIdentifier(pod, dek);
      expect(minted.minted).toBe(true);
      expect(minted.value).not.toBe(value);
      expect(fs.readFileSync(ext(pod)).includes(Buffer.from(minted.value))).toBe(false);
      expect(readPodIdentifier(pod, dek)).toEqual({ status: 'present', value: minted.value });
    } finally {
      dek.fill(0);
    }
  }, TEST_TIMEOUT_MS);
});

describe('pod doctor and the identifier', () => {
  it('a pod with none: a notice on a dry run (exit 0), minted under --write', async () => {
    const pod = await initPod();
    stripIdentifier(pod);

    const dry = await doctorJson([pod]);
    expect(dry.exitCode).toBe(0);
    expect(dry.report.notices).toBe(1);
    expect(dry.report.findings).toEqual([
      expect.objectContaining({ file: 'profile/extended.ttl', status: 'notice', damage: 'pod-identifier-missing' }),
    ]);
    expect(readPodIdentifier(pod).status).toBe('absent');

    const written = await doctorJson([pod, '--write']);
    expect(written.exitCode).toBe(0);
    expect(written.report.findings).toEqual([
      expect.objectContaining({ status: 'repaired', damage: 'pod-identifier-missing' }),
    ]);
    expect(readPodIdentifier(pod).status).toBe('present');
    expect((await doctorJson([pod])).report.findings).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('two values: refused (exit 1), and --write does not touch them', async () => {
    const pod = await initPod();
    const text = fs.readFileSync(ext(pod), 'utf-8');
    fs.writeFileSync(
      ext(pod),
      text + `<#me> <${POD_IDENTIFIER_IRI}> "urn:uuid:1c7b5d2f-3e4a-4b6c-9d8e-0f1a2b3c4d5e"^^<http://www.w3.org/2001/XMLSchema#anyURI> .\n`,
    );
    const before = fs.readFileSync(ext(pod));
    for (const args of [[pod], [pod, '--write']]) {
      const r = await doctorJson(args);
      expect(r.exitCode).toBe(1);
      expect(r.report.findings).toEqual([
        expect.objectContaining({ status: 'refused', damage: 'pod-identifier-duplicate' }),
      ]);
    }
    expect(fs.readFileSync(ext(pod)).equals(before)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('a malformed value, and one stated on the public card, are refused', async () => {
    const pod = await initPod();
    const text = fs.readFileSync(ext(pod), 'utf-8');
    const value = (readPodIdentifier(pod) as { value: string }).value;
    fs.writeFileSync(ext(pod), text.replace(value, value.toUpperCase().replace('URN:UUID:', 'urn:uuid:')));
    fs.appendFileSync(card(pod), `\n<#me> <${POD_IDENTIFIER_IRI}> "${value}"^^<http://www.w3.org/2001/XMLSchema#anyURI> .\n`);
    const r = await doctorJson([pod]);
    expect(r.exitCode).toBe(1);
    expect(r.report.findings.map((f) => [f.file, f.damage]).sort()).toEqual([
      ['profile/card.ttl', 'pod-identifier-public'],
      ['profile/extended.ttl', 'pod-identifier-malformed'],
    ]);
  }, TEST_TIMEOUT_MS);
});

describe('the identifier never leaves the pod', () => {
  const BUNDLE = JSON.stringify({
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'Patient',
          id: 'p1',
          name: [{ given: ['Test'], family: 'Person' }],
          birthDate: '1970-01-01',
          gender: 'female',
        },
      },
      {
        resource: {
          resourceType: 'Condition',
          id: 'c1',
          code: { coding: [{ system: 'http://snomed.info/sct', code: '38341003', display: 'Hypertension' }] },
          subject: { reference: 'Patient/p1' },
        },
      },
    ],
  });

  it('no FHIR export of any pod resource carries it, even a graph that puts it on the patient', async () => {
    const pod = await initPod();
    const bundle = path.join(root, `bundle-${++seq}.json`);
    fs.writeFileSync(bundle, BUNDLE);
    expect((await runCli(['pod', 'import', pod, bundle])).exitCode).toBe(0);
    const value = (readPodIdentifier(pod) as { value: string }).value;

    const ttlFiles: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ttl')) ttlFiles.push(p);
      }
    };
    walk(pod);
    expect(ttlFiles.map((f) => path.relative(pod, f))).toContain('profile/extended.ttl');

    let resources = 0;
    for (const f of ttlFiles) {
      const out = await convertCascadeToFhir(fs.readFileSync(f, 'utf-8'));
      resources += out.resources.length;
      expect(JSON.stringify(out), path.relative(pod, f)).not.toContain(value);
      expect(JSON.stringify(out)).not.toContain('podIdentifier');
    }
    expect(resources).toBeGreaterThan(0);

    // Worst case: a merged graph in which the patient record itself carries it.
    const profile = fs.readFileSync(path.join(pod, 'clinical', 'patient-profile.ttl'), 'utf-8');
    const subject = /^(<[^>]+>|\S+:\S+)\s+a\s+cascade:PatientProfile/m.exec(profile)?.[1];
    expect(subject, 'the import wrote a PatientProfile').toBeDefined();
    const merged =
      profile + `\n${subject} <${POD_IDENTIFIER_IRI}> "${value}"^^<http://www.w3.org/2001/XMLSchema#anyURI> .\n`;
    const out = await convertCascadeToFhir(merged);
    expect(out.resources.some((r: { resourceType?: string }) => r.resourceType === 'Patient')).toBe(true);
    expect(JSON.stringify(out)).not.toContain(value);
  }, TEST_TIMEOUT_MS);

  it('a whole-pod copy (pod export) keeps it only in extended.ttl, so a restore keeps every name', async () => {
    const pod = await initPod();
    const value = (readPodIdentifier(pod) as { value: string }).value;
    const out = path.join(root, `export-${++seq}`);
    expect((await runCli(['pod', 'export', pod, '--format', 'directory', '--output', out])).exitCode).toBe(0);
    const holders: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (fs.readFileSync(p, 'utf-8').includes(value)) holders.push(path.relative(out, p));
      }
    };
    walk(out);
    expect(holders).toEqual(['profile/extended.ttl']);
    expect(readPodIdentifier(out)).toEqual({ status: 'present', value });
  }, TEST_TIMEOUT_MS);
});
