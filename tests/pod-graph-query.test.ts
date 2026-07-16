/**
 * Tests for the graph query surface (root backlog 4.6, slice Q1).
 *
 * `pod query` gains a read-only graph surface over the stored forward edges:
 *   - `--neighbors <iri> [--hops N] [--edge <pred>...]` — bounded, both-directions
 *     traversal returning the typed neighborhood of a record.
 *   - `--all --edges` — an additive record-to-record edge projection.
 *
 * These lock in the JSON contract Workbench G1 and the agent consume:
 *   - a lab-report's neighborhood is exactly its member results at hop 1 (out);
 *     a member's neighborhood is its report (in); hop 2 from a member reaches
 *     its siblings through the report; `--edge` filtering works;
 *   - `--all --edges` is purely additive (existing output byte-identical);
 *   - determinism (same invocation twice = byte-identical stdout);
 *   - clean errors for an unknown seed / bad flags;
 *   - it all works through the encrypted-pod read path.
 *
 * All data is synthetic and PHI-free (test-fixtures/reference-resolution-bundle.json,
 * the same trimmed Synthea stand-in the R1 resolution tests use: one report with
 * two resolvable members, one EOB with a resolvable claim).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { expandCurie } from '../src/lib/turtle-parser.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = path.resolve(__dirname, '../test-fixtures/reference-resolution-bundle.json');

const HAS_LAB_RESULT = 'clinical:hasLabResult';
const RELATED_CLAIM = 'coverage:relatedClaim';
const HAS_LAB_RESULT_IRI = 'https://ns.cascadeprotocol.org/clinical/v1#hasLabResult';

// Real Argon2id runs on every encrypted init/import/query — allow a heavy budget.
const ENC_TIMEOUT_MS = 60_000;
const PASSPHRASE = 'graph-query-test-passphrase';

/** Build a fresh CLI program with the pod commands registered. */
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
 * Run a CLI invocation, capturing stdout (result output) and stderr (errors go
 * there in `--json` mode via `printError`). Returns both plus the exit code.
 */
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const program = buildProgram();
  const chunks: string[] = [];
  const errChunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    chunks.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errChunks.push(a.map(String).join(' '));
  });
  const writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown): boolean => {
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
  return { stdout: chunks.join('\n'), stderr: errChunks.join('\n'), exitCode };
}

let tmpDirs: string[] = [];
function mkTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-graph-q-'));
  tmpDirs.push(d);
  return d;
}

/** init + import the fixture into a fresh (optionally encrypted) pod; return its dir. */
async function makePod(encrypt = false): Promise<string> {
  const dir = path.join(mkTmpDir(), 'pod');
  await runCli(encrypt ? ['pod', 'init', dir, '--encrypt'] : ['pod', 'init', dir]);
  const imp = await runCli(['pod', 'import', dir, FIXTURE]);
  expect(imp.exitCode).toBe(0);
  return dir;
}

/** Parse the `--all --edges` projection into typed edge groups + the report IRI. */
async function readEdges(dir: string): Promise<{
  edges: Array<{ subject: string; predicate: string; object: string }>;
  reportIri: string;
  memberIris: string[];
  eobIri: string;
  claimIri: string;
}> {
  const q = await runCli(['--json', 'pod', 'query', dir, '--all', '--edges']);
  expect(q.exitCode).toBe(0);
  const parsed = JSON.parse(q.stdout);
  const edges = parsed.edges as Array<{ subject: string; predicate: string; object: string }>;
  const labEdges = edges.filter((e) => e.predicate === HAS_LAB_RESULT);
  const claimEdges = edges.filter((e) => e.predicate === RELATED_CLAIM);
  // The fixture resolves 2/3 report-to-result and 1/2 benefit-to-claim.
  expect(labEdges).toHaveLength(2);
  expect(claimEdges).toHaveLength(1);
  // Both lab edges are written on the single report.
  const reportIris = new Set(labEdges.map((e) => e.subject));
  expect(reportIris.size).toBe(1);
  return {
    edges,
    reportIri: labEdges[0].subject,
    memberIris: labEdges.map((e) => e.object).sort(),
    eobIri: claimEdges[0].subject,
    claimIri: claimEdges[0].object,
  };
}

beforeEach(() => {
  process.env.CASCADE_POD_PASSPHRASE = PASSPHRASE;
});

afterEach(() => {
  delete process.env.CASCADE_POD_PASSPHRASE;
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------

describe('expandCurie (edge-predicate resolution)', () => {
  it('expands a known Cascade CURIE', () => {
    expect(expandCurie('clinical:hasLabResult')).toBe(HAS_LAB_RESULT_IRI);
  });
  it('expands a well-known CURIE', () => {
    expect(expandCurie('prov:wasDerivedFrom')).toBe('http://www.w3.org/ns/prov#wasDerivedFrom');
  });
  it('passes a full http(s) IRI through unchanged', () => {
    expect(expandCurie(HAS_LAB_RESULT_IRI)).toBe(HAS_LAB_RESULT_IRI);
  });
  it('returns null for an unknown prefix', () => {
    expect(expandCurie('bogus:foo')).toBeNull();
  });
  it('returns null for empty / non-CURIE input', () => {
    expect(expandCurie('')).toBeNull();
    expect(expandCurie('   ')).toBeNull();
    expect(expandCurie('notacurie')).toBeNull();
  });
});

describe('pod query --all --edges (edge projection)', () => {
  it('adds a record-to-record edge array; without the flag output is byte-identical', async () => {
    const dir = await makePod();

    const plain = await runCli(['--json', 'pod', 'query', dir, '--all']);
    const withEdges = await runCli(['--json', 'pod', 'query', dir, '--all', '--edges']);
    expect(plain.exitCode).toBe(0);
    expect(withEdges.exitCode).toBe(0);

    const w = JSON.parse(withEdges.stdout);
    expect(Array.isArray(w.edges)).toBe(true);
    // Every edge is record-to-record with the {subject, predicate, object} shape.
    for (const e of w.edges) {
      expect(typeof e.subject).toBe('string');
      expect(typeof e.predicate).toBe('string');
      expect(typeof e.object).toBe('string');
    }

    // No regression: stripping `edges` reproduces the plain --all output exactly.
    const { edges: _dropped, ...rest } = w;
    expect(JSON.stringify(rest, null, 2) + '\n').toBe(plain.stdout);
  });

  it('reports exactly the resolved edges (2 hasLabResult + 1 relatedClaim)', async () => {
    const dir = await makePod();
    const { edges } = await readEdges(dir);
    expect(edges).toHaveLength(3);
  });

  it('is deterministic (same invocation twice = byte-identical stdout)', async () => {
    const dir = await makePod();
    const a = await runCli(['--json', 'pod', 'query', dir, '--all', '--edges']);
    const b = await runCli(['--json', 'pod', 'query', dir, '--all', '--edges']);
    expect(a.stdout).toBe(b.stdout);
  });

  it('errors cleanly when --edges is used without --all', async () => {
    const dir = await makePod();
    const q = await runCli(['--json', 'pod', 'query', dir, '--edges']);
    expect(q.exitCode).toBe(1);
    expect(JSON.parse(q.stderr).error).toMatch(/--all/);
  });
});

describe('pod query --neighbors (traversal)', () => {
  it("returns a report's member results at hop 1, all direction out", async () => {
    const dir = await makePod();
    const { reportIri, memberIris } = await readEdges(dir);

    const q = await runCli(['--json', 'pod', 'query', dir, '--neighbors', reportIri]);
    expect(q.exitCode).toBe(0);
    const r = JSON.parse(q.stdout);

    expect(r.seed.iri).toBe(reportIri);
    expect(r.seed.type).toBe('clinical:LaboratoryReport');
    expect(r.hops).toBe(1);
    expect(r.edgeFilters).toEqual([]);
    expect(r.neighbors).toHaveLength(2);
    expect(r.neighbors.every((n: { direction: string }) => n.direction === 'out')).toBe(true);
    expect(r.neighbors.every((n: { edge: string }) => n.edge === HAS_LAB_RESULT)).toBe(true);
    expect(r.neighbors.every((n: { hop: number }) => n.hop === 1)).toBe(true);
    expect(r.neighbors.map((n: { iri: string }) => n.iri).sort()).toEqual(memberIris);
  });

  it('returns a member\'s report at hop 1 with direction in', async () => {
    const dir = await makePod();
    const { reportIri, memberIris } = await readEdges(dir);

    const q = await runCli(['--json', 'pod', 'query', dir, '--neighbors', memberIris[0]]);
    const r = JSON.parse(q.stdout);
    expect(r.neighbors).toHaveLength(1);
    expect(r.neighbors[0].iri).toBe(reportIri);
    expect(r.neighbors[0].direction).toBe('in');
    expect(r.neighbors[0].edge).toBe(HAS_LAB_RESULT);
  });

  it('reaches a sibling result at hop 2 through the report', async () => {
    const dir = await makePod();
    const { memberIris } = await readEdges(dir);
    const [seed, sibling] = memberIris;

    const q = await runCli(['--json', 'pod', 'query', dir, '--neighbors', seed, '--hops', '2']);
    const r = JSON.parse(q.stdout);
    expect(r.hops).toBe(2);
    const hop2 = r.neighbors.filter((n: { hop: number }) => n.hop === 2).map((n: { iri: string }) => n.iri);
    expect(hop2).toContain(sibling);
    // The seed itself is never emitted as its own neighbor.
    expect(r.neighbors.map((n: { iri: string }) => n.iri)).not.toContain(seed);
  });

  it('follows an EOB to its claim (direction out)', async () => {
    const dir = await makePod();
    const { eobIri, claimIri } = await readEdges(dir);
    const q = await runCli(['--json', 'pod', 'query', dir, '--neighbors', eobIri]);
    const r = JSON.parse(q.stdout);
    expect(r.neighbors).toHaveLength(1);
    expect(r.neighbors[0].iri).toBe(claimIri);
    expect(r.neighbors[0].direction).toBe('out');
    expect(r.neighbors[0].edge).toBe(RELATED_CLAIM);
  });

  it('filters traversal by --edge (CURIE and full IRI both accepted)', async () => {
    const dir = await makePod();
    const { reportIri } = await readEdges(dir);

    const byCurie = JSON.parse(
      (await runCli(['--json', 'pod', 'query', dir, '--neighbors', reportIri, '--edge', HAS_LAB_RESULT])).stdout,
    );
    expect(byCurie.edgeFilters).toEqual([HAS_LAB_RESULT]);
    expect(byCurie.neighbors).toHaveLength(2);

    const byIri = JSON.parse(
      (await runCli(['--json', 'pod', 'query', dir, '--neighbors', reportIri, '--edge', HAS_LAB_RESULT_IRI])).stdout,
    );
    expect(byIri.neighbors).toHaveLength(2);

    // Filtering to an edge the report does not carry yields no neighbors.
    const none = JSON.parse(
      (await runCli(['--json', 'pod', 'query', dir, '--neighbors', reportIri, '--edge', RELATED_CLAIM])).stdout,
    );
    expect(none.neighbors).toHaveLength(0);
  });

  it('caps --hops at 3', async () => {
    const dir = await makePod();
    const { memberIris } = await readEdges(dir);
    const q = await runCli(['--json', 'pod', 'query', dir, '--neighbors', memberIris[0], '--hops', '99']);
    expect(JSON.parse(q.stdout).hops).toBe(3);
  });

  it('is deterministic (same neighbors invocation twice = byte-identical stdout)', async () => {
    const dir = await makePod();
    const { memberIris } = await readEdges(dir);
    const a = await runCli(['--json', 'pod', 'query', dir, '--neighbors', memberIris[0], '--hops', '3']);
    const b = await runCli(['--json', 'pod', 'query', dir, '--neighbors', memberIris[0], '--hops', '3']);
    expect(a.stdout).toBe(b.stdout);
  });

  it('errors cleanly on an unknown / absent seed IRI', async () => {
    const dir = await makePod();
    const q = await runCli(['--json', 'pod', 'query', dir, '--neighbors', 'urn:uuid:not-a-real-record']);
    expect(q.exitCode).toBe(1);
    expect(JSON.parse(q.stderr).error).toMatch(/No record found/);
  });

  it('errors cleanly on a non-integer --hops', async () => {
    const dir = await makePod();
    const { reportIri } = await readEdges(dir);
    const q = await runCli(['--json', 'pod', 'query', dir, '--neighbors', reportIri, '--hops', 'abc']);
    expect(q.exitCode).toBe(1);
    expect(JSON.parse(q.stderr).error).toMatch(/--hops/);
  });

  it('errors cleanly on an unknown --edge prefix', async () => {
    const dir = await makePod();
    const { reportIri } = await readEdges(dir);
    const q = await runCli(['--json', 'pod', 'query', dir, '--neighbors', reportIri, '--edge', 'bogus:foo']);
    expect(q.exitCode).toBe(1);
    expect(JSON.parse(q.stderr).error).toMatch(/Unknown edge predicate/);
  });
});

describe('pod query graph surface on an encrypted pod', () => {
  it('decrypts and traverses a report neighborhood', async () => {
    const dir = await makePod(true);

    // Sanity: clinical data is ciphertext on disk (no readable prefixes).
    const reportsBytes = fs.readFileSync(path.join(dir, 'clinical', 'lab-reports.ttl')).toString('utf-8');
    expect(reportsBytes).not.toContain('@prefix');

    const { reportIri, memberIris } = await readEdges(dir);
    const q = await runCli(['--json', 'pod', 'query', dir, '--neighbors', reportIri]);
    expect(q.exitCode).toBe(0);
    const r = JSON.parse(q.stdout);
    expect(r.neighbors.map((n: { iri: string }) => n.iri).sort()).toEqual(memberIris);
  }, ENC_TIMEOUT_MS);
});
