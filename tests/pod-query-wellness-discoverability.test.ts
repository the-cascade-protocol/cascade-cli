/**
 * The cheap way to read a wellness pod has to be findable and usable by the
 * reader who needs it most: an agent.
 *
 * WHAT WAS WRONG. `pod query` learned `--exclude-data-type` and
 * `--wellness-series`, but a clinical question still had to name six keys, and
 * the MCP `cascade_pod_query` tool took only `dataType`. An agent asking for
 * "all" on a pod holding an Apple Health import read and parsed every daily
 * wellness record it would then ignore (seconds and gigabytes on a real one).
 *
 * WHAT THIS PINS.
 *   1. The `wellness` group key expands to exactly the registry's wellness data
 *      types plus the retained-sample descriptors, and a query using it leaves
 *      every one of those files unread (asserted on the read layer).
 *   2. The MCP tool's `excludeDataTypes` and `wellnessSeries` give the same
 *      records and the same series as the CLI flags, stale flag included, and
 *      leave the same files unread.
 *   3. Both capabilities documents carry the new parameters, because both are
 *      generated from the registrations.
 *
 * Every fixture is synthetic: invented values and names, no real export.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerPodCommand } from '../src/commands/pod/index.js';
import { PodReader } from '../src/lib/pod-read.js';
import { DATA_TYPES, excludableDataFiles, wellnessGroupKeys, WELLNESS_GROUP_KEEPS } from '../src/lib/pod-data-types.js';
import { resolveExclusion } from '../src/lib/pod-query-options.js';
import { podQueryHandler, registerTools } from '../src/lib/mcp/tools.js';
import { describeMcpTools } from '../src/lib/mcp/describe.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const CLI = path.resolve(__dirname, '../dist/index.js');
const FIXTURE = path.resolve(__dirname, '../test-fixtures/apple-health-wellness');

function cli(args: string[]): string {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf-8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
}

/** Run the pod commands in this process, so the read layer can be observed. */
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const program = new Command();
  program.name('cascade').exitOverride().option('--verbose', 'Verbose output', false).option('--json', 'Output JSON', false);
  registerPodCommand(program);
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')));
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(' ')));
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

/** Pod-relative paths of every file the read layer opened during `fn`. */
async function filesRead(podDir: string, fn: () => Promise<unknown>): Promise<Set<string>> {
  const read = new Set<string>();
  const original = PodReader.prototype.readText;
  const spy = vi.spyOn(PodReader.prototype, 'readText').mockImplementation(function (this: PodReader, abs: string) {
    read.add(path.relative(podDir, abs).split(path.sep).join('/'));
    return original.call(this, abs);
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return read;
}

/** Every `.ttl` the pod holds under `wellness/`, walked on disk, the derived series view aside. */
function wellnessFilesOnDisk(podDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ttl')) out.push(path.relative(podDir, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(podDir, 'wellness'));
  return out.filter((f) => !f.startsWith('wellness/series/')).sort();
}

type McpResult = { content: Array<{ type: 'text'; text: string }> };
async function mcpQuery(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = (await (podQueryHandler as (a: Record<string, unknown>) => Promise<McpResult>)(args)) as McpResult;
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

interface Bucket {
  count: number;
  records: Array<{ id: string; type: string; properties: Record<string, string> }>;
}

/** Records per registered bucket, non-empty ones only, in a comparable form. */
function registeredBuckets(dataTypes: Record<string, Bucket>): Record<string, Array<{ id: string; type: string; properties: Record<string, string> }>> {
  const out: Record<string, Array<{ id: string; type: string; properties: Record<string, string> }>> = {};
  for (const [key, bucket] of Object.entries(dataTypes)) {
    if (!(key in DATA_TYPES) || bucket.count === 0) continue;
    out[key] = bucket.records.map((r) => ({ id: r.id, type: r.type, properties: r.properties })).sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  return out;
}

let root: string;
let podDir: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-query-discoverability-'));
  podDir = path.join(root, 'pod');
  cli(['pod', 'init', podDir]);
  cli(['pod', 'import', podDir, FIXTURE]);
}, 240_000);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// 1. The `wellness` group key
// ---------------------------------------------------------------------------

describe('the wellness group key for --exclude-data-type', () => {
  it('expands to the registry wellness data types, less the ones it keeps, plus wellness-samples', () => {
    const expected = Object.keys(DATA_TYPES).filter(
      (k) => DATA_TYPES[k].directory === 'wellness' && !WELLNESS_GROUP_KEEPS.includes(k),
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(WELLNESS_GROUP_KEEPS).toContain('supplements');
    expect(wellnessGroupKeys()).not.toContain('supplements');
    expect(wellnessGroupKeys()).toEqual([...expected, 'wellness-samples'].sort());

    // And the files it resolves to are every excludable file under wellness/.
    const resolved = resolveExclusion(podDir, ['wellness'], '--exclude-data-type');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const keptFiles = new Set(WELLNESS_GROUP_KEEPS.map((k) => `${DATA_TYPES[k].directory}/${DATA_TYPES[k].filename}`));
    const underWellness = excludableDataFiles()
      .filter((e) => e.file.startsWith('wellness/') && !keptFiles.has(e.file))
      .map((e) => path.join(podDir, ...e.file.split('/')))
      .sort();
    expect([...resolved.value.files].sort()).toEqual(underWellness);
  });

  it('leaves every wellness file on disk unread and still reads the clinical ones', async () => {
    const onDisk = wellnessFilesOnDisk(podDir);
    expect(onDisk).toContain('wellness/heart-rate.ttl');
    expect(onDisk).toContain('wellness/samples/samples.ttl');
    let payload: { dataTypes: Record<string, Bucket> } | undefined;
    const read = await filesRead(podDir, async () => {
      const r = await runCli(['--json', 'pod', 'query', podDir, '--all', '--exclude-data-type', 'wellness']);
      expect(r.exitCode, r.stderr).toBe(0);
      payload = JSON.parse(r.stdout) as { dataTypes: Record<string, Bucket> };
    });
    for (const f of onDisk) expect(read.has(f), `${f} was read`).toBe(false);
    expect(read.has('clinical/conditions.ttl')).toBe(true);
    expect(payload!.dataTypes.conditions.count).toBeGreaterThan(0);
    const types = Object.values(payload!.dataTypes).flatMap((b) => b.records.map((x) => x.type));
    expect(types).not.toContain('core:Attachment');
  });

  it('gives the same output as naming every wellness key by hand', async () => {
    const group = await runCli(['--json', 'pod', 'query', podDir, '--all', '--exclude-data-type', 'wellness']);
    const byHand = await runCli([
      '--json', 'pod', 'query', podDir, '--all',
      ...wellnessGroupKeys().flatMap((k) => ['--exclude-data-type', k]),
    ]);
    expect(group.exitCode).toBe(0);
    expect(group.stdout).toBe(byHand.stdout);
  });

  it('keeps supplements: asking for them beside the group is not a contradiction, and the group never excludes their file', async () => {
    const r = await runCli(['--json', 'pod', 'query', podDir, '--supplements', '--exclude-data-type', 'wellness']);
    expect(r.exitCode, r.stderr).toBe(0);
    const resolved = resolveExclusion(podDir, ['wellness'], '--exclude-data-type');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const supplementsFile = path.join(podDir, DATA_TYPES.supplements.directory, DATA_TYPES.supplements.filename);
    expect([...resolved.value.files]).not.toContain(supplementsFile);
  });

  it('still refuses a misspelled key, and lists wellness among the known ones', async () => {
    const r = await runCli(['--json', 'pod', 'query', podDir, '--all', '--exclude-data-type', 'wellnes']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Known: .*\bwellness\b/);
  });
});

// ---------------------------------------------------------------------------
// 2. MCP cascade_pod_query: the same options, the same answers
// ---------------------------------------------------------------------------

describe('MCP cascade_pod_query excludeDataTypes and wellnessSeries', () => {
  it('match the CLI flags on the same pod: same records, same series, same files unread', async () => {
    const onDisk = wellnessFilesOnDisk(podDir);
    const r = await runCli(['--json', 'pod', 'query', podDir, '--all', '--exclude-data-type', 'wellness', '--wellness-series']);
    expect(r.exitCode, r.stderr).toBe(0);
    const viaCli = JSON.parse(r.stdout) as { dataTypes: Record<string, Bucket>; wellnessDailySeries: unknown };

    // Unread: asserted without the series, whose freshness check hashes (never
    // parses) the wellness files it was built from, as the CLI's does.
    const read = await filesRead(podDir, async () => {
      const res = await mcpQuery({ path: podDir, dataType: 'all', excludeDataTypes: ['wellness'] });
      expect(res.error, JSON.stringify(res)).toBeUndefined();
    });
    for (const f of onDisk) expect(read.has(f), `${f} was read`).toBe(false);
    expect(read.has('clinical/conditions.ttl')).toBe(true);

    const viaMcp: Record<string, unknown> = await mcpQuery({ path: podDir, dataType: 'all', excludeDataTypes: ['wellness'], wellnessSeries: true });
    expect(viaMcp.error, JSON.stringify(viaMcp)).toBeUndefined();

    expect(registeredBuckets(viaMcp.dataTypes as Record<string, Bucket>)).toEqual(registeredBuckets(viaCli.dataTypes));
    expect(Object.keys(viaMcp.dataTypes as object)).toContain('conditions');
    expect(viaMcp.wellnessDailySeries).toEqual(viaCli.wellnessDailySeries);
    expect((viaMcp.wellnessDailySeries as { stale: boolean }).stale).toBe(false);
    expect(viaMcp.excludedDataTypes).toEqual(wellnessGroupKeys());
  });

  it('reads the series alone, with no dataType, parsing no record file', async () => {
    const viaCli = JSON.parse((await runCli(['--json', 'pod', 'query', podDir, '--wellness-series'])).stdout) as { wellnessDailySeries: unknown };
    const viaMcp = await mcpQuery({ path: podDir, wellnessSeries: true });
    expect(viaMcp.error).toBeUndefined();
    expect(viaMcp.dataTypes).toEqual({});
    expect(viaMcp.wellnessDailySeries).toEqual(viaCli.wellnessDailySeries);
  });

  it('refuses an unknown key and a contradiction, as the CLI does', async () => {
    const unknown = await mcpQuery({ path: podDir, dataType: 'all', excludeDataTypes: ['wellnes'] });
    expect(String(unknown.error)).toMatch(/Unknown data type for excludeDataTypes: wellnes\. Known: .*\bwellness\b/);
    const contradiction = await mcpQuery({ path: podDir, dataType: 'sleep', excludeDataTypes: ['wellness'] });
    expect(String(contradiction.error)).toContain('sleep (in the wellness group)');
    const neither = await mcpQuery({ path: podDir });
    expect(String(neither.error)).toContain('wellnessSeries');
  });

  it('"all" still never reads the retained-sample descriptors (only registered data types)', async () => {
    const read = await filesRead(podDir, async () => {
      const res = await mcpQuery({ path: podDir, dataType: 'all' });
      expect(res.error).toBeUndefined();
      expect((res.dataTypes as Record<string, Bucket>)['heart-rate'].count).toBeGreaterThan(0);
    });
    expect(read.has('wellness/samples/samples.ttl')).toBe(false);
    expect(read.has('wellness/heart-rate.ttl')).toBe(true);
  });

  it('returns stale: true and the reasons when the files no longer match the series', async () => {
    const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-query-discoverability-stale-'));
    try {
      const staleDir = path.join(staleRoot, 'pod');
      cli(['pod', 'init', staleDir]);
      cli(['pod', 'import', staleDir, FIXTURE]);
      // A writer that changed the bytes and did not rebuild the view.
      fs.appendFileSync(path.join(staleDir, 'wellness', 'heart-rate.ttl'), '\n# edited without a rebuild\n');
      const res = await mcpQuery({ path: staleDir, wellnessSeries: true });
      expect(res.error).toBeUndefined();
      const series = res.wellnessDailySeries as { stale: boolean; staleReasons: string[] };
      expect(series.stale).toBe(true);
      expect(series.staleReasons.join(' ')).toContain('wellness/heart-rate.ttl');
    } finally {
      fs.rmSync(staleRoot, { recursive: true, force: true });
    }
  }, 240_000);
});

// ---------------------------------------------------------------------------
// 3. Both capabilities documents carry the new parameters
// ---------------------------------------------------------------------------

describe('capabilities advertise the cheap reads', () => {
  const expectQueryParams = (tools: Array<{ name: string; description: string; parameters: Record<string, { type: string; description: string; required: boolean }> }>): void => {
    const q = tools.find((t) => t.name === 'cascade_pod_query');
    expect(q).toBeDefined();
    expect(q!.parameters.excludeDataTypes).toMatchObject({ type: 'array', required: false });
    expect(q!.parameters.excludeDataTypes.description).toContain('"wellness"');
    expect(q!.parameters.wellnessSeries).toMatchObject({ type: 'boolean', required: false });
    expect(q!.parameters.wellnessSeries.description).toContain('stale');
    expect(q!.parameters.dataType.required).toBe(false);
    expect(q!.description).toMatch(/excludeDataTypes/);
  };

  it('`cascade capabilities` (the built CLI) lists them, and the wellness key on --exclude-data-type', () => {
    const doc = JSON.parse(cli(['capabilities'])) as {
      tools: Array<{ name: string; parameters: Array<{ name: string; description: string }> }>;
      mcpTools: Parameters<typeof expectQueryParams>[0];
    };
    expectQueryParams(doc.mcpTools);
    const flag = doc.tools.find((t) => t.name === 'pod query')!.parameters.find((p) => p.name === '--exclude-data-type')!;
    expect(flag.description).toMatch(/\bwellness: every file under wellness\//);
  });

  it('the MCP server document (cascade_capabilities) lists them', async () => {
    const handlers = new Map<string, (a: Record<string, unknown>) => Promise<McpResult>>();
    registerTools({
      tool: (name: string, _d: string, _s: unknown, handler: (a: Record<string, unknown>) => Promise<McpResult>) => void handlers.set(name, handler),
    } as unknown as McpServer);
    const doc = JSON.parse((await handlers.get('cascade_capabilities')!({})).content[0].text) as { tools: Parameters<typeof expectQueryParams>[0] };
    expectQueryParams(doc.tools);
    // And the generator agrees with itself (both documents come from one walk).
    expect(doc.tools).toEqual(describeMcpTools(registerTools, (await import('../src/lib/capabilities/enrichment.js')).MCP_TOOL_ENRICHMENT));
  });
});
