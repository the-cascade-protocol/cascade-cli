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
import * as fs from 'node:fs';
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

/**
 * The long flag of an option, parsed out of its flags string rather than read
 * from `option.long`.
 *
 * `describeOption` uses `option.long ?? option.flags`. If the expectation here
 * used the same expression, a bug in it would appear identically on both sides
 * and the comparison would agree with itself.
 */
function longFlagOf(option: { flags: string }): string {
  return option.flags.split(/[\s,|]+/).find((token) => token.startsWith('--')) ?? option.flags;
}

/**
 * The full parameter contract of every command: the names commander will
 * accept, in order, and which of them the PARSER enforces and what it defaults.
 *
 * Names alone were not enough. Stripping every positional argument, every
 * `required: true` and every registered default from the descriptors left all
 * twenty gates green, because the old expectation walked `options` only and
 * compared names only — while `usage` kept advertising `<pod-dir>` from
 * `registeredArguments`, so the document contradicted itself and nothing said
 * so. Everything here is generated, so the expectation can be total.
 */
interface ExpectedParameter {
  name: string;
  required: boolean;
  defaultValue?: unknown;
}

function registeredParameters(): Map<string, ExpectedParameter[]> {
  const expected = new Map<string, ExpectedParameter[]>();
  const walk = (cmd: Command, prefix: string): void => {
    for (const sub of cmd.commands) {
      const full = prefix ? `${prefix} ${sub.name()}` : sub.name();
      expected.set(full, [
        ...sub.registeredArguments.map((a) => ({
          name: a.name(),
          required: a.required,
          defaultValue: a.defaultValue as unknown,
        })),
        ...sub.options.map((o) => ({
          name: longFlagOf(o),
          required: o.mandatory,
          defaultValue: o.defaultValue as unknown,
        })),
      ]);
      walk(sub, full);
    }
  };
  walk(buildProgram(), '');
  return expected;
}

/** Whether a registered default is one a reader would want stated. */
function statesADefault(value: unknown): boolean {
  if (value === undefined || value === false) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
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

  it('describes every MCP parameter with a real type, in both documents', async () => {
    // `type: "unknown"` is what this describer emits when it meets a zod
    // wrapper it cannot see through, and the damage is silent: wrapping an
    // enum in `.default(...)` — a routine, MORE correct cleanup — used to drop
    // the parameter's entire list of valid values while every test stayed
    // green. This gate covers wrappers nobody has thought of yet, which is
    // worth more than the two unwraps it was written alongside.
    const handler = registeredMcpTools().handlers.get('cascade_capabilities');
    const response = (await handler!({})) as { content: Array<{ text: string }> };
    const serverDoc = JSON.parse(response.content[0].text) as { tools: typeof capabilities.mcpTools };

    const opaque: string[] = [];
    for (const [label, tools] of [
      ['cascade capabilities', capabilities.mcpTools],
      ['cascade_capabilities', serverDoc.tools],
    ] as const) {
      for (const tool of tools) {
        for (const [param, descriptor] of Object.entries(tool.parameters)) {
          if (descriptor.type === 'unknown') opaque.push(`${label}: ${tool.name}.${param}`);
        }
      }
    }
    expect(
      opaque,
      'An MCP parameter is described as type "unknown", which means describeMcpTools met a zod ' +
        'wrapper it does not unwrap. Anything the wrapper was hiding — the enum of valid values, ' +
        'the object shape — is now absent from what the agent reads. Teach unwrapChain the ' +
        'wrapper; do not relax this.',
    ).toEqual([]);
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
  it('describes exactly the registered arguments and options, in order', () => {
    const wrong: string[] = [];
    for (const [command, expected] of registeredParameters()) {
      const descriptor = capabilities.tools.find((t) => t.name === command);
      if (!descriptor) continue; // the coverage gate above owns that failure
      const described = descriptor.parameters.map((p) => p.name);
      const wanted = expected.map((p) => p.name);
      if (JSON.stringify(described) !== JSON.stringify(wanted)) {
        wrong.push(`${command}: described [${described.join(', ')}], registered [${wanted.join(', ')}]`);
      }
    }
    expect(
      wrong,
      'A command descriptor does not match its registered parameters. The hand-written document ' +
        'listed 12 of `pod query`\'s 23 options, so an agent could not discover that this CLI ' +
        'can query claims or explanation-of-benefits at all. Positional arguments count: dropping ' +
        'them leaves `usage` still advertising `<pod-dir>` while the parameter list has lost it, ' +
        'which is a document that contradicts itself.',
    ).toEqual([]);
  });

  it('marks a parameter required exactly when the parser enforces it', () => {
    const wrong: string[] = [];
    for (const [command, expected] of registeredParameters()) {
      const descriptor = capabilities.tools.find((t) => t.name === command);
      if (!descriptor) continue;
      for (const want of expected) {
        const described = descriptor.parameters.find((p) => p.name === want.name);
        if (!described) continue; // the set gate above owns that failure
        const claims = described.required === true;
        if (claims !== want.required) {
          wrong.push(`${command} ${want.name}: document says required=${claims}, parser says ${want.required}`);
        }
      }
    }
    expect(
      wrong,
      'A parameter\'s required flag disagrees with the parser. An agent composes calls from this: ' +
        'a required parameter shown as optional produces a call that cannot run, and the reverse ' +
        'produces flags nobody needs. Note that "required" here is PARSE-time only — commands that ' +
        'enforce more in their action handler say so in their notes.',
    ).toEqual([]);
  });

  it('states every registered default', () => {
    const wrong: string[] = [];
    for (const [command, expected] of registeredParameters()) {
      const descriptor = capabilities.tools.find((t) => t.name === command);
      if (!descriptor) continue;
      for (const want of expected) {
        if (!statesADefault(want.defaultValue)) continue;
        const described = descriptor.parameters.find((p) => p.name === want.name);
        if (!described) continue;
        if (JSON.stringify(described.default) !== JSON.stringify(want.defaultValue)) {
          wrong.push(
            `${command} ${want.name}: document says ${JSON.stringify(described.default)}, ` +
              `registry says ${JSON.stringify(want.defaultValue)}`,
          );
        }
      }
    }
    expect(
      wrong,
      'A registered default is missing from or wrong in the document. Defaults are how an agent ' +
        'knows what a command does when it says nothing — `--passthrough full`, `--transport stdio`, ' +
        '`--reconcile-existing true` all change behaviour it would otherwise have to guess at.',
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

// ─── 6. The security model is a claim, so it is checked like one ──────────────

/**
 * Every file allowed to make an outbound call, and the command surface the
 * document names as the reason.
 *
 * `securityModel.networkCalls` said "zero — all operations are local" while
 * these two existed. It survived because neither verb was described in the
 * document, so the contradiction had nothing to sit next to. Both are described
 * now, so the claim has to be true.
 *
 * An entry here is a commitment that the document names this surface. If you
 * add a network call, the honest move is to add the entry AND the sentence —
 * not to widen the list quietly.
 */
const NETWORK_ALLOWLIST: ReadonlyArray<{ file: string; surface: string; why: string }> = [
  {
    file: 'lib/advisory/feed-client.ts',
    surface: 'advisory feed pull',
    why: 'fetches the advisory feed URL the user passes; the whole point of the verb',
  },
  {
    file: 'commands/pod/extract.ts',
    surface: 'pod extract',
    why: 'posts narrative text to the cascade-agent server at --agent-url, localhost by default',
  },
];

const SRC_DIR = path.resolve(HERE, '..', 'src');

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        out.push(path.relative(SRC_DIR, full).split(path.sep).join('/'));
      }
    }
  };
  walk(SRC_DIR);
  return out.sort();
}

/** Comments in this codebase quote the calls they forbid; a mention is not a call. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('capabilities: the network claim matches the code', () => {
  it('nothing outside the allowlist makes an outbound call', () => {
    const allowed = new Set(NETWORK_ALLOWLIST.map((a) => a.file));
    const offenders: string[] = [];

    for (const rel of sourceFiles()) {
      if (allowed.has(rel)) continue;
      const code = stripComments(fs.readFileSync(path.join(SRC_DIR, rel), 'utf-8'));
      if (/(^|[^.\w])fetch\s*\(/.test(code) || /\bglobalThis\.fetch\s*\(/.test(code)) {
        offenders.push(`${rel} calls fetch()`);
      }
    }

    expect(
      offenders,
      'A source file makes an outbound call that securityModel.networkCalls does not account ' +
        'for. That field is read by people deciding whether to point this CLI at a medical ' +
        'record, and it is the one claim in the document that cannot be allowed to be ' +
        'optimistic. Add the file to NETWORK_ALLOWLIST and name its surface in the ' +
        'networkCalls sentence, in the same commit as the call.',
    ).toEqual([]);
  });

  it('names every allowed surface in the security model, and claims nothing broader', () => {
    for (const entry of NETWORK_ALLOWLIST) {
      expect(
        capabilities.securityModel.networkCalls,
        `${entry.file} may call out on behalf of \`${entry.surface}\`, but the security model ` +
          'does not name that surface, so a reader cannot know it exists',
      ).toContain(entry.surface);
    }

    // The exact wording that was false for months. Nothing in this document may
    // claim the CLI as a whole makes no network calls.
    expect(
      capabilities.securityModel.networkCalls,
      'securityModel.networkCalls claims zero network calls again. Two verbs make them.',
    ).not.toMatch(/^zero/);
    expect(
      capabilities.description,
      'The top-level description claims zero network calls again.',
    ).not.toContain('zero network calls');
  });

  it('every allowlist entry names a file that exists and states a reason', () => {
    for (const entry of NETWORK_ALLOWLIST) {
      expect(fs.existsSync(path.join(SRC_DIR, entry.file)), `${entry.file} no longer exists`).toBe(true);
      expect(entry.why.length, `${entry.file} is allowlisted with no stated reason`).toBeGreaterThan(20);
    }
  });
});

// ─── 7. The verbs whose absence motivated all of this ─────────────────────────

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

  // Commands the PARSER accepts and the ACTION then refuses. `required` cannot
  // express these — it reflects parse-time enforcement only — so each one has to
  // say so in prose or the document quietly promises a call that will not run.
  // `serve` is the sharp end: generated alone, it lost the word MCP entirely and
  // advertised the flag that makes it work as optional.
  it.each([
    ['serve', /--mcp/],
    ['conformance run', /--self|--command/],
    ['pod annotate', /--text/],
    ['pod add-record', /propsJson|CASCADE_RECORD_JSON/],
  ])('%s states the requirement its action handler enforces', (name, mustMention) => {
    const descriptor = document.tools.find((t) => t.name === name);
    expect(descriptor, `${name} is absent`).toBeTruthy();
    const notes = descriptor!.notes?.join(' ') ?? '';
    expect(
      notes,
      `${name} exits nonzero on a parse-legal invocation, and the document does not say so. ` +
        'An agent composing from parameters alone will emit a call that fails.',
    ).toMatch(mustMention);
  });

  it('describes `serve` as the MCP server it is', () => {
    const serve = document.tools.find((t) => t.name === 'serve');
    expect(
      serve!.description,
      'Commander\'s one-liner for serve is "Start local agent server" — the word MCP does not ' +
        'appear, and MCP is the entire purpose. The hand-written document this replaced said ' +
        '"Start local MCP-compatible agent server" and marked --mcp required; losing both is the ' +
        'one place derivation is worse than what it replaced, so the override is pinned here.',
    ).toContain('MCP');
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
