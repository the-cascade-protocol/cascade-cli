/**
 * The capabilities gates: the document an agent reads must equal the registry
 * the CLI parses with.
 *
 * `cascade capabilities` is not documentation. cascade-agent shells out to it at
 * startup and splices the raw output into its system prompt verbatim, so this
 * document IS the CLI as far as an agent is concerned. When it was a hand-
 * written list it described 12 of 34 invocable commands — every write verb and
 * every recovery verb invisible, including `pod doctor`, which exists precisely
 * for the moment an agent finds damage — while advertising an MCP tool,
 * `cascade_pod_import`, that has never been registered anywhere in `src/`. An
 * omission hides a capability; an invention hands the agent a tool it will call
 * and cannot reach.
 *
 * The descriptors are now generated from the commander registry, so these gates
 * exist to keep them that way. They follow the shape proven in
 * `pod-read-conformance.test.ts`: walk the registry HERE, independently of the
 * code under test, and assert the document covers it. A gate that asked the
 * generator what it generated would pass no matter what the generator did.
 *
 * If one of these fails, the fix is never to edit an expected list — it is
 * either to register the command or to stop advertising it.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildProgram } from '../src/program.js';
import { buildCapabilities } from '../src/commands/capabilities.js';
import { COMMAND_ENRICHMENT, MCP_TOOL_ENRICHMENT } from '../src/lib/capabilities/enrichment.js';
import { registerTools } from '../src/lib/mcp/tools.js';
import { describeMcpTools } from '../src/lib/mcp/describe.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string; name: string };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'dist', 'index.js');

/**
 * Every command path commander knows about, walked here rather than borrowed
 * from `descriptors.ts`. This is the independent side of the comparison: if the
 * generator's own walk is wrong, or if someone replaces generation with a
 * hardcoded array, this list is unaffected and the gate fails.
 */
function registeredCommandPaths(): string[] {
  const paths: string[] = [];
  const walk = (cmd: Command, prefix: string): void => {
    for (const sub of cmd.commands) {
      const full = prefix ? `${prefix} ${sub.name()}` : sub.name();
      paths.push(full);
      walk(sub, full);
    }
  };
  walk(buildProgram(), '');
  return paths.sort();
}

/** The registered option long flags of one command path, walked the same way. */
function registeredOptionFlags(): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  const walk = (cmd: Command, prefix: string): void => {
    for (const sub of cmd.commands) {
      const full = prefix ? `${prefix} ${sub.name()}` : sub.name();
      flags.set(full, sub.options.map((o) => o.long ?? o.flags));
      walk(sub, full);
    }
  };
  walk(buildProgram(), '');
  return flags;
}

/**
 * What `registerTools` actually registers, captured with a local stand-in
 * server rather than by asking the describer.
 */
function registeredMcpTools(): { names: string[]; handlers: Map<string, (args: unknown) => Promise<unknown>> } {
  const names: string[] = [];
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const recorder = {
    tool(...args: unknown[]) {
      names.push(args[0] as string);
      const handler = args[args.length - 1];
      if (typeof handler === 'function') {
        handlers.set(args[0] as string, handler as (a: unknown) => Promise<unknown>);
      }
    },
  };
  registerTools(recorder as unknown as McpServer);
  return { names, handlers };
}

const capabilities = buildCapabilities(buildProgram());
const describedNames = capabilities.tools.map((t) => t.name).sort();

// ─── 1. Coverage ──────────────────────────────────────────────────────────────

describe('capabilities: the document covers the registry', () => {
  it('describes every registered command', () => {
    const missing = registeredCommandPaths().filter((p) => !describedNames.includes(p));
    expect(
      missing,
      'A registered command is missing from `cascade capabilities`. An agent reads that ' +
        'document as the definition of this CLI, so a command absent from it does not exist ' +
        'as far as the agent is concerned — which is how every write verb and every recovery ' +
        'verb stayed invisible for months. Descriptors are generated from the registry: if ' +
        'this fails, generation has been replaced by a hand-written list somewhere. Restore ' +
        'the generation rather than adding the missing names.',
    ).toEqual([]);
  });

  it('describes the groups as well as the leaves', () => {
    for (const group of ['pod', 'advisory', 'advisory feed', 'conformance', 'pod profile', 'agent']) {
      const descriptor = capabilities.tools.find((t) => t.name === group);
      expect(descriptor, `the ${group} command family is not described`).toBeTruthy();
      expect(
        descriptor!.subcommands?.length ?? 0,
        `${group} is described without its subcommand names, so an agent cannot see what is in it`,
      ).toBeGreaterThan(0);
    }
  });
});

// ─── 2. No phantoms ───────────────────────────────────────────────────────────

describe('capabilities: nothing is advertised that does not exist', () => {
  it('every described command resolves to a registered one', () => {
    const registered = registeredCommandPaths();
    const phantoms = describedNames.filter((n) => !registered.includes(n));
    expect(
      phantoms,
      'The document advertises a command the CLI does not register. This is worse than an ' +
        'omission: an agent will try to call it. `cascade_pod_import` was advertised this ' +
        'way for months.',
    ).toEqual([]);
  });

  it('every command enrichment key resolves to a registered command', () => {
    const registered = registeredCommandPaths();
    const stale = Object.keys(COMMAND_ENRICHMENT).filter((k) => !registered.includes(k));
    expect(
      stale,
      'COMMAND_ENRICHMENT has a key that is not a registered command path. The entry ' +
        'decorates nothing, which means its examples and safety notes are silently absent ' +
        'from the document — most likely the command was renamed. Rename the key to match, ' +
        'or delete the entry.',
    ).toEqual([]);
  });

  it('every MCP enrichment key resolves to a registered MCP tool', () => {
    const { names } = registeredMcpTools();
    const stale = Object.keys(MCP_TOOL_ENRICHMENT).filter((k) => !names.includes(k));
    expect(
      stale,
      'MCP_TOOL_ENRICHMENT has a key that no registered tool answers to. Enrichment cannot ' +
        'create a tool, so this entry decorates nothing.',
    ).toEqual([]);
  });
});

// ─── 3. MCP parity ────────────────────────────────────────────────────────────

describe('capabilities: both documents advertise exactly the registered MCP tools', () => {
  const registered = registeredMcpTools();

  it('the CLI document matches registerTools', () => {
    expect(
      capabilities.mcpTools.map((t) => t.name).sort(),
      '`cascade capabilities` advertises a different MCP tool set than the server registers. ' +
        'These were two hand-maintained lists and they disagreed: the CLI one offered ' +
        'cascade_pod_import, which is not registered anywhere.',
    ).toEqual([...registered.names].sort());
  });

  it('the MCP server document matches registerTools', async () => {
    const handler = registered.handlers.get('cascade_capabilities');
    expect(handler, 'cascade_capabilities is not registered').toBeTruthy();

    const response = (await handler!({})) as { content: Array<{ text: string }> };
    const doc = JSON.parse(response.content[0].text) as { tools: Array<{ name: string }>; version: string };

    expect(
      doc.tools.map((t) => t.name).sort(),
      'The `cascade_capabilities` tool describes a different tool set than the server ' +
        'registers. Both documents are generated from registerTools; if this fails, one of ' +
        'them has been hand-written again.',
    ).toEqual([...registered.names].sort());
  });

  it('refuses to describe a tool registered without a description and schema', () => {
    // Both documents are generated from the registration, so a tool registered
    // through one of server.tool's shorter overloads would reach agents with no
    // usable description. That fails loudly here rather than shipping quietly.
    expect(() =>
      describeMcpTools((server) => {
        (server as unknown as { tool: (...a: unknown[]) => void }).tool('cascade_undescribed', async () => ({}));
      }),
    ).toThrow(/cascade_undescribed/);
  });

  it('advertises no tool the server cannot answer', () => {
    // The failure that motivated this file: a name in the document with no
    // handler behind it.
    for (const tool of capabilities.mcpTools) {
      expect(
        registered.handlers.has(tool.name),
        `${tool.name} is advertised but has no registered handler`,
      ).toBe(true);
    }
  });
});

// ─── 4. Parameter fidelity ────────────────────────────────────────────────────

describe('capabilities: every registered option is described', () => {
  it('lists every long flag of every command', () => {
    const missing: string[] = [];
    for (const [command, flags] of registeredOptionFlags()) {
      const descriptor = capabilities.tools.find((t) => t.name === command);
      if (!descriptor) continue; // coverage gate above owns this failure
      const described = descriptor.parameters.map((p) => p.name);
      for (const flag of flags) {
        if (!described.includes(flag)) missing.push(`${command} ${flag}`);
      }
    }
    expect(
      missing,
      'A registered option is missing from its command descriptor. The hand-written document ' +
        'listed 12 of `pod query`\'s 23 options, so an agent could not discover that this CLI ' +
        'can query claims or explanation-of-benefits at all.',
    ).toEqual([]);
  });

  it('hoists the global options instead of repeating them per command', () => {
    const globals = capabilities.globalOptions.options.map((o) => o.name);
    expect(globals, 'the root --json / --verbose options are not described').toEqual(
      expect.arrayContaining(['--json', '--verbose']),
    );

    const repeated = capabilities.tools.filter((t) =>
      t.parameters.some((p) => p.name === '--json' || p.name === '--verbose'),
    );
    expect(
      repeated.map((t) => t.name),
      'A command descriptor repeats a global option. They are declared on the root command ' +
        'only; repeating them per command is what produced usage strings implying --json was ' +
        'a per-command flag with a required position.',
    ).toEqual([]);
  });

  it('states the position rule that the CLI actually implements', () => {
    // The document tells agents these flags work in any position. That claim is
    // pinned here, because the previous document claimed the opposite for
    // `pod doctor` ("place it before pod") and it was simply untrue.
    const before = execFileSync('node', [CLI, '--json', 'capabilities'], { encoding: 'utf-8' });
    const after = execFileSync('node', [CLI, 'capabilities', '--json'], { encoding: 'utf-8' });
    expect(
      after,
      'A global option is no longer accepted after the subcommand, but globalOptions.position ' +
        'still tells agents it is. Fix the note or the parser — do not leave them disagreeing.',
    ).toBe(before);
    expect(capabilities.globalOptions.position).toContain('any position');
  });
});

// ─── 5. Version honesty ───────────────────────────────────────────────────────

describe('capabilities: versions are read, never written', () => {
  it('the CLI document reports the package version', () => {
    expect(capabilities.version).toBe(pkg.version);
    expect(capabilities.name).toBe(pkg.name);
  });

  it('the MCP document reports the package version', async () => {
    const handler = registeredMcpTools().handlers.get('cascade_capabilities');
    const response = (await handler!({})) as { content: Array<{ text: string }> };
    const doc = JSON.parse(response.content[0].text) as { version: string };
    expect(
      doc.version,
      'The MCP capabilities document carried a hardcoded `version: "0.2.0"` while the package ' +
        'was on 0.13.0. Read the version from package.json; never restate it.',
    ).toBe(pkg.version);
  });

  it('neither document contains a version string that is not the package version', async () => {
    const handler = registeredMcpTools().handlers.get('cascade_capabilities');
    const response = (await handler!({})) as { content: Array<{ text: string }> };

    for (const [label, json] of [
      ['cascade capabilities', JSON.stringify(capabilities)],
      ['cascade_capabilities', response.content[0].text],
    ] as const) {
      const versions = [...json.matchAll(/"version"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
      for (const version of versions) {
        expect(version, `${label} states a version that is not package.json's`).toBe(pkg.version);
      }
    }
  });
});

// ─── 6. The verbs whose absence motivated all of this ─────────────────────────

describe('capabilities: the write and recovery verbs are reachable through the real CLI', () => {
  // Through `node dist/index.js`, not in process: the point is that what an
  // agent actually receives on stdout contains these, after the whole tree —
  // including the externally-supplied `agent` command — has registered.
  const stdout = execFileSync('node', [CLI, 'capabilities'], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  const document = JSON.parse(stdout) as ReturnType<typeof buildCapabilities>;

  // Named one at a time and on purpose. These three are why entry 3.161 was
  // filed; pinning them by name keeps that intent legible if the generic gates
  // above are ever refactored.
  it.each([
    ['pod doctor', '--write'],
    ['pod add-record', '--type'],
    ['pod erase', '--confirm'],
  ])('%s is named, described and invocable', (name, flag) => {
    const descriptor = document.tools.find((t) => t.name === name);
    expect(descriptor, `${name} is absent from the capabilities output`).toBeTruthy();
    expect(descriptor!.description.length, `${name} has no usable description`).toBeGreaterThan(20);
    expect(descriptor!.usage, `${name} has no usage line`).toContain(`cascade ${name}`);
    expect(
      descriptor!.parameters.map((p) => p.name),
      `${name} is described without ${flag}, which is how it is driven`,
    ).toContain(flag);
  });

  it('keeps the hand-authored guidance that shapes agent behaviour', () => {
    const query = document.tools.find((t) => t.name === 'pod query');
    const schema = query?.outputSchema as Record<string, unknown> | undefined;
    expect(schema, 'pod query lost its output schema').toBeTruthy();
    expect((schema!.jqExamples as string[]).length, 'pod query lost its jq examples').toBeGreaterThan(0);
    expect(schema!.shellQuotingNote, 'pod query lost its shell-quoting note').toBeTruthy();

    const doctor = document.tools.find((t) => t.name === 'pod doctor');
    expect(
      doctor!.description,
      'pod doctor lost the safety semantics of its description. Commander\'s one-liner cannot ' +
        'say that the verb only ever prepends and never rewrites existing bytes, and an agent ' +
        'reaching for it is by definition looking at a damaged pod.',
    ).toContain('never rewrites existing bytes');

    const erase = document.tools.find((t) => t.name === 'pod erase');
    expect(erase!.notes?.join(' '), 'pod erase is described without saying it is irreversible').toMatch(
      /not reversible|irreversible/i,
    );
  });

  it('stays within the system-prompt budget it is injected into', () => {
    // cascade-agent splices this whole document into its system prompt on every
    // session, so bytes here are tokens on every turn. 22,336 before this was
    // generated, 44,733 after (2.9x the commands, 2.0x the bytes). The ceiling
    // is deliberately loose; it exists so that a large jump is noticed rather
    // than shipped. If a real need pushes past it, add a --brief mode instead
    // of dropping commands: omission is the defect this file exists to prevent.
    expect(
      Buffer.byteLength(stdout, 'utf-8'),
      'The capabilities document has grown past its budget. It is injected verbatim into ' +
        'cascade-agent\'s system prompt every session. Trim generated prose or add a --brief ' +
        'mode — never drop a command.',
    ).toBeLessThan(55_000);
  });
});
