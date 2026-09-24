/**
 * `pod extract` reads a narrative written under any of its three spellings,
 * and a pod written with the old spellings survives a re-import.
 *
 * The C-CDA converter now writes the declared `clinical:narrativeText` only.
 * Pods from earlier releases carry the same text as `cascade:narrativeText`
 * plus a duplicate `clinical:content`, and those triples are never rewritten,
 * so a re-imported pod holds all three on one subject. Every scenario here runs
 * the built CLI in its own process against a stub extraction agent, and reads
 * the queue IDs the CLI itself wrote. Those IDs key idempotency, so if they
 * moved when the spelling changed, every block in an upgraded pod would be
 * extracted a second time.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Parser, Writer, DataFactory } from 'n3';
import type { Quad } from 'n3';

import { conformancePath } from './helpers/conformance.js';

const CLI = path.resolve(__dirname, '../dist/index.js');
const FIXTURE = conformancePath('fixtures/ccda/epic-summarization.xml');

const CLINICAL = 'https://ns.cascadeprotocol.org/clinical/v1#';
const CORE = 'https://ns.cascadeprotocol.org/core/v1#';
const NEW_SPELLING = CLINICAL + 'narrativeText';
const OLD_SPELLING = CORE + 'narrativeText';
const DUPLICATE = CLINICAL + 'content';

interface CliRun { code: number | null; stdout: string; stderr: string }

/** Async on purpose: the stub agent lives in this process and must keep serving. */
function runCli(args: string[]): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The queue ID, computed here from its definition, not by calling the CLI's helper. */
function expectedQueueId(section: string, text: string): string {
  const h = crypto.createHash('sha256');
  for (const p of [section, text]) { h.update(p); h.update('\x00'); }
  return `${section}-${h.digest('hex').slice(0, 16)}`;
}

// A stub agent: healthy, and every block yields one review-tier entity, so each
// extracted block lands in analysis/review-queue.json with its ID and its text.
const received: Array<{ section: string; narrativeText: string }> = [];
let server: http.Server;
let agentUrl: string;
let root: string;

beforeAll(async () => {
  expect(fs.existsSync(CLI), 'dist/index.js is missing; run `npm run build` first').toBe(true);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-narrative-spellings-'));
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') {
        res.end(JSON.stringify({ modelAvailable: true, modelId: 'stub' }));
        return;
      }
      if (req.url === '/extract' && req.method === 'POST') {
        received.push(JSON.parse(body));
        res.end(JSON.stringify({
          entities: [{ type: 'condition', displayName: 'Stub finding', confidence: 0.6, sourceText: 'stub' }],
          confidence: 0.6,
          modelId: 'stub-model',
          latencyMs: 1,
          requiresReview: true,
          schemaVersion: '1',
        }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  agentUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(root, { recursive: true, force: true });
});

async function newPod(name: string): Promise<string> {
  const pod = path.join(root, name);
  const init = await runCli(['pod', 'init', pod]);
  expect(init.code, init.stderr).toBe(0);
  return pod;
}

function writeDocuments(pod: string, ttl: string): void {
  fs.mkdirSync(path.join(pod, 'clinical'), { recursive: true });
  fs.writeFileSync(path.join(pod, 'clinical', 'documents.ttl'), ttl, 'utf8');
}

function readQueue(pod: string): Array<{ id: string; section: string; narrativeText: string }> {
  const p = path.join(pod, 'analysis', 'review-queue.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
}

async function extract(pod: string): Promise<CliRun> {
  return runCli(['pod', 'extract', pod, '--agent-url', agentUrl]);
}

// ---------------------------------------------------------------------------
// The read shim, one narrative subject per pod
// ---------------------------------------------------------------------------

const TEXT = 'Patient reports intermittent chest tightness on exertion.';
const OTHER = 'Superseded wording of the same section.';

function documentTtl(lines: string[]): string {
  return `@prefix cascade: <${CORE}> .
@prefix clinical: <${CLINICAL}> .

<urn:uuid:doc-0001-aaaa-bbbb-ccccddddeeee> a clinical:ClinicalDocument ;
    cascade:requiresLLMExtraction "true" ;
    cascade:sectionCode "11450-4" ;
${lines.map((l) => `    ${l} ;`).join('\n')}
    cascade:dataProvenance cascade:ClinicalGenerated .
`;
}

const SCENARIOS: Array<{ name: string; lines: string[]; expectText: string }> = [
  // The legacy fixture the pod read-conformance suite uses: old spelling only.
  { name: 'legacy-old-spelling-only', lines: [`cascade:narrativeText "${TEXT}"`], expectText: TEXT },
  // Exactly what earlier releases of the converter wrote.
  { name: 'old-writer', lines: [`cascade:narrativeText "${TEXT}"`, `clinical:content "${TEXT}"`], expectText: TEXT },
  { name: 'new-writer', lines: [`clinical:narrativeText "${TEXT}"`], expectText: TEXT },
  { name: 'duplicate-only', lines: [`clinical:content "${TEXT}"`], expectText: TEXT },
  // What a re-import of an old pod leaves: all three, same text.
  {
    name: 'mixed-agreeing',
    lines: [`clinical:narrativeText "${TEXT}"`, `cascade:narrativeText "${TEXT}"`, `clinical:content "${TEXT}"`],
    expectText: TEXT,
  },
  // Spellings that disagree: the declared one wins.
  {
    name: 'mixed-disagreeing',
    lines: [`cascade:narrativeText "${OTHER}"`, `clinical:content "${OTHER}"`, `clinical:narrativeText "${TEXT}"`],
    expectText: TEXT,
  },
  // A blank value on the declared spelling does not hide text on a legacy one.
  {
    name: 'blank-declared-falls-through',
    lines: [`clinical:narrativeText ""`, `cascade:narrativeText "${TEXT}"`],
    expectText: TEXT,
  },
];

describe('pod extract reads every narrative spelling as one block with one queue ID', () => {
  for (const { name, lines, expectText } of SCENARIOS) {
    it(name, async () => {
      const pod = await newPod(name);
      writeDocuments(pod, documentTtl(lines));

      const dry = await runCli(['pod', 'extract', pod, '--dry-run']);
      expect(dry.code, dry.stderr).toBe(0);
      expect(dry.stdout).toMatch(/1 narrative block\(s\) found/);

      const sent = received.length;
      const run = await extract(pod);
      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(received.slice(sent).map((r) => r.narrativeText)).toEqual([expectText]);

      const queue = readQueue(pod);
      expect(queue).toHaveLength(1);
      expect(queue[0].narrativeText).toBe(expectText);
      // The same ID in every scenario: it hashes the section and the text, never
      // the predicate the text was read from.
      expect(queue[0].id).toBe(expectedQueueId('conditions', TEXT));
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------
// Re-importing a pod written with the old spellings
// ---------------------------------------------------------------------------

/**
 * Put a freshly imported pod into the state earlier releases left it in: each
 * `clinical:narrativeText` becomes `cascade:narrativeText` plus a duplicate
 * `clinical:content` with the same literal, and nothing else changes.
 */
function rewriteToOldSpellings(pod: string): void {
  const file = path.join(pod, 'clinical', 'documents.ttl');
  const quads = new Parser().parse(fs.readFileSync(file, 'utf8'));
  const out: Quad[] = [];
  for (const q of quads) {
    if (q.predicate.value === NEW_SPELLING) {
      out.push(DataFactory.quad(q.subject, DataFactory.namedNode(OLD_SPELLING), q.object));
      out.push(DataFactory.quad(q.subject, DataFactory.namedNode(DUPLICATE), q.object));
    } else {
      out.push(q);
    }
  }
  const writer = new Writer({ prefixes: { cascade: CORE, clinical: CLINICAL } });
  writer.addQuads(out);
  writer.end((err, ttl) => {
    if (err) throw err;
    fs.writeFileSync(file, ttl, 'utf8');
  });
}

/** Per narrative subject, the distinct values under each spelling. */
function spellingsBySubject(pod: string): Map<string, Record<string, string[]>> {
  const quads = new Parser().parse(fs.readFileSync(path.join(pod, 'clinical', 'documents.ttl'), 'utf8'));
  const out = new Map<string, Record<string, string[]>>();
  for (const q of quads) {
    if (![NEW_SPELLING, OLD_SPELLING, DUPLICATE].includes(q.predicate.value)) continue;
    const rec = out.get(q.subject.value) ?? { [NEW_SPELLING]: [], [OLD_SPELLING]: [], [DUPLICATE]: [] };
    if (!rec[q.predicate.value].includes(q.object.value)) rec[q.predicate.value].push(q.object.value);
    out.set(q.subject.value, rec);
  }
  return out;
}

async function violationsByFile(pod: string): Promise<Record<string, number>> {
  const run = await runCli(['--json', 'validate', pod]);
  const results = JSON.parse(run.stdout) as Array<{ file: string; results: Array<{ severity: string }> }>;
  const out: Record<string, number> = {};
  for (const r of results) {
    out[path.relative(pod, r.file)] = r.results.filter((x) => x.severity === 'violation').length;
  }
  return out;
}

describe('a pod written with the old spellings, re-imported', () => {
  it('keeps both spellings, reads one block per narrative with unchanged IDs, and adds no violation', async () => {
    const pod = await newPod('reimport');
    const first = await runCli(['pod', 'import', pod, FIXTURE, '--source-system', 'epic']);
    expect(first.code, first.stderr).toBe(0);

    // The pod as an earlier release wrote it.
    rewriteToOldSpellings(pod);
    const before = spellingsBySubject(pod);
    expect(before.size).toBeGreaterThan(0);
    for (const rec of before.values()) {
      expect(rec[NEW_SPELLING]).toEqual([]);
      expect(rec[OLD_SPELLING]).toHaveLength(1);
      expect(rec[DUPLICATE]).toEqual(rec[OLD_SPELLING]);
    }
    const violationsBefore = await violationsByFile(pod);

    // Extract once against the old pod: every block is sent and recorded.
    const sent = received.length;
    const firstExtract = await extract(pod);
    expect(firstExtract.code, firstExtract.stdout + firstExtract.stderr).toBe(0);
    expect(received.length - sent).toBe(before.size);
    const queueIds = readQueue(pod).map((q) => q.id).sort();
    expect(queueIds).toHaveLength(before.size);

    // Re-import the same export with the current converter.
    const second = await runCli(['pod', 'import', pod, FIXTURE, '--source-system', 'epic']);
    expect(second.code, second.stderr).toBe(0);

    // The old triples stay (a source record is never rewritten), and the
    // declared spelling is added beside them with the same text.
    const after = spellingsBySubject(pod);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [subject, rec] of after) {
      const old = before.get(subject)!;
      expect(rec[OLD_SPELLING], subject).toEqual(old[OLD_SPELLING]);
      expect(rec[DUPLICATE], subject).toEqual(old[DUPLICATE]);
      expect(rec[NEW_SPELLING], subject).toEqual(old[OLD_SPELLING]);
    }

    // One block per narrative, not one per spelling.
    const dry = await runCli(['pod', 'extract', pod, '--dry-run']);
    expect(dry.stdout).toMatch(new RegExp(`${after.size} narrative block\\(s\\) found`));

    // The same IDs: the mixed pod is recognised as already extracted, and the
    // agent is not called again.
    const sentBeforeRerun = received.length;
    const rerun = await extract(pod);
    expect(rerun.code, rerun.stdout + rerun.stderr).toBe(0);
    expect(rerun.stdout).toMatch(/already been extracted/);
    expect(received.length).toBe(sentBeforeRerun);
    expect(readQueue(pod).map((q) => q.id).sort()).toEqual(queueIds);

    // No new violation anywhere in the pod.
    const violationsAfter = await violationsByFile(pod);
    for (const [file, n] of Object.entries(violationsAfter)) {
      expect(n, `${file}: ${n} violation(s) after re-import`).toBeLessThanOrEqual(violationsBefore[file] ?? 0);
    }
    expect(violationsAfter['clinical/documents.ttl']).toBe(0);
  }, 120_000);
});
