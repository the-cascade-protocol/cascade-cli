/**
 * cascade advisory <subcommand>
 *
 * Wires together the TASK-4.1–4.8 advisory pipeline behind a Commander
 * subcommand surface (TASK-4.9).
 *
 * Subcommands:
 *   validate <patch.ldpatch>
 *       Parse + profile-validate a CAP file. Human-readable report or JSON
 *       with --json. No filesystem mutation.
 *
 *   apply <patch.ldpatch> --pod <dir> --signature <jws> [--key <hex>]
 *       JWS verify (TASK-4.3) → selector eval (TASK-4.4) → applier (TASK-4.5).
 *       Mutates the pod. Records an AdvisoryApplicationActivity per match.
 *
 *   list --pod <dir> [--pending|--applied|--declined]
 *       List advisory cache records for a pod.
 *
 *   revert --pod <dir> --advisory <id>
 *       Roll back inserted triples for a previously-applied advisory using
 *       the activity log as the source of truth.
 *
 *   feed pull <url> --pod <dir>
 *       Fetch an advisory feed (TASK-4.6) and cache new entries.
 *
 *   dry-run <patch.ldpatch> --pod <dir>
 *       Run the full applier pipeline INCLUDING selector eval but DO NOT
 *       mutate the pod. Outputs the triples that WOULD be inserted.
 *
 * Implementation note: the orchestrator-owned `src/index.ts` registers this
 * command via `registerAdvisoryCommand(program)` (additive — no existing
 * registrations are touched).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { Store, DataFactory, Writer } from 'n3';

import { parseCap } from '../lib/advisory/ldpatch-parser.js';
import { validateCap } from '../lib/advisory/profile-validator.js';
import {
  parseDetachedJwsCompact,
  verifyDetachedJws,
} from '../lib/advisory/jws-verifier.js';
import { evaluateSelector } from '../lib/advisory/selector.js';
import { applyCap } from '../lib/advisory/applier.js';
import {
  pullFeed,
  listCacheRecords,
  updateCacheStatus,
  type AdvisoryCacheStatus,
} from '../lib/advisory/feed-client.js';
import { parseTurtle } from '../lib/turtle-parser.js';

const { namedNode } = DataFactory;

const PROV_USED = 'http://www.w3.org/ns/prov#used';

/* ────────────────────────────────────────────────────────────────────────── */
/* Entry point                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

export function registerAdvisoryCommand(program: Command): void {
  const advisory = program
    .command('advisory')
    .description('Cascade Advisory Patch (CAP) — validate, apply, list, revert, feed, dry-run');

  // ── validate ────────────────────────────────────────────────────────
  advisory
    .command('validate')
    .description('Parse + profile-validate a CAP advisory (.ldpatch). No pod mutation.')
    .argument('<patch>', 'Path to the .ldpatch advisory file')
    .action(async (patchPath: string) => {
      await runValidate(program, patchPath);
    });

  // ── apply ───────────────────────────────────────────────────────────
  advisory
    .command('apply')
    .description('Verify JWS, evaluate selector, apply CAP advisory to a pod')
    .argument('<patch>', 'Path to the .ldpatch advisory file')
    .requiredOption('--pod <dir>', 'Pod directory')
    .requiredOption('--signature <jws>', 'Path to the detached JWS file (header..signature)')
    .option(
      '--key <hex>',
      'Trusted issuer Ed25519 public key as hex (32 bytes). Repeatable for key rotation.',
      collectMany,
      [] as string[],
    )
    .action(async (patchPath: string, options: ApplyOptions) => {
      await runApply(program, patchPath, options);
    });

  // ── list ────────────────────────────────────────────────────────────
  advisory
    .command('list')
    .description('List CAP advisories cached in a pod, optionally filtered by status')
    .requiredOption('--pod <dir>', 'Pod directory')
    .option('--pending', 'Show only pending advisories')
    .option('--applied', 'Show only applied advisories')
    .option('--declined', 'Show only declined advisories')
    .action(async (options: ListOptions) => {
      await runList(program, options);
    });

  // ── revert ──────────────────────────────────────────────────────────
  advisory
    .command('revert')
    .description('Roll back a previously-applied CAP advisory using its activity log')
    .requiredOption('--pod <dir>', 'Pod directory')
    .requiredOption('--advisory <id>', 'Advisory IRI to revert')
    .action(async (options: RevertOptions) => {
      await runRevert(program, options);
    });

  // ── feed pull ───────────────────────────────────────────────────────
  const feed = advisory.command('feed').description('Manage advisory feeds');
  feed
    .command('pull')
    .description('Pull an advisory feed and cache new entries')
    .argument('<url>', 'Feed URL (typically <issuer>/feed.jsonld)')
    .requiredOption('--pod <dir>', 'Pod directory')
    .action(async (url: string, options: { pod: string }) => {
      await runFeedPull(program, url, options);
    });

  // ── dry-run ─────────────────────────────────────────────────────────
  advisory
    .command('dry-run')
    .description('Apply a CAP advisory to a clone of the pod and print the would-be triples')
    .argument('<patch>', 'Path to the .ldpatch advisory file')
    .requiredOption('--pod <dir>', 'Pod directory')
    .action(async (patchPath: string, options: { pod: string }) => {
      await runDryRun(program, patchPath, options);
    });

  advisory.addHelpText(
    'after',
    `
Examples:
  cascade advisory validate advisory.ldpatch
  cascade advisory apply advisory.ldpatch --pod ./my-pod --signature advisory.jws --key <hex>
  cascade advisory list --pod ./my-pod --pending
  cascade advisory feed pull https://clingen.org/advisories/feed.jsonld --pod ./my-pod
  cascade advisory dry-run advisory.ldpatch --pod ./my-pod
  cascade advisory revert --pod ./my-pod --advisory urn:advisory:clingen-hbop-2026-05-04-001
`,
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Subcommand implementations                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

interface ApplyOptions {
  pod: string;
  signature: string;
  key: string[];
}
interface ListOptions {
  pod: string;
  pending?: boolean;
  applied?: boolean;
  declined?: boolean;
}
interface RevertOptions {
  pod: string;
  advisory: string;
}

interface GlobalOptions {
  json?: boolean;
  verbose?: boolean;
}

function globalOpts(program: Command): GlobalOptions {
  return program.opts() as GlobalOptions;
}

async function runValidate(program: Command, patchPath: string): Promise<void> {
  const opts = globalOpts(program);
  const src = readOrFail(patchPath);
  if (src == null) {
    process.exitCode = 2;
    return;
  }
  const parseResult = parseCap(src);
  if (!parseResult.ast) {
    if (opts.json) {
      console.log(JSON.stringify({ valid: false, parseErrors: parseResult.errors }, null, 2));
    } else {
      console.error(`Parse failed for ${patchPath}:`);
      for (const e of parseResult.errors) {
        console.error(`  line ${e.line}, col ${e.col}: ${e.message}${e.code ? ` [${e.code}]` : ''}`);
      }
    }
    process.exitCode = 1;
    return;
  }
  const validation = validateCap(parseResult.ast);
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          valid: validation.valid,
          violations: validation.violations,
          envelope: parseResult.ast.envelope,
        },
        null,
        2,
      ),
    );
  } else {
    if (validation.valid) {
      console.log(`PASS ${patchPath}`);
      console.log(`  advisoryClass: ${parseResult.ast.envelope.advisoryClass ?? '(none)'}`);
      console.log(`  issuer:        ${parseResult.ast.envelope.issuer ?? '(none)'}`);
      console.log(`  triples to insert: ${parseResult.ast.adds.reduce((n, a) => n + a.triples.length, 0)} per match`);
    } else {
      console.error(`FAIL ${patchPath}`);
      for (const v of validation.violations) {
        console.error(`  [${v.code}] ${v.message}`);
      }
    }
  }
  process.exitCode = validation.valid ? 0 : 1;
}

async function runApply(
  program: Command,
  patchPath: string,
  options: ApplyOptions,
): Promise<void> {
  const opts = globalOpts(program);
  const src = readOrFail(patchPath);
  if (src == null) {
    process.exitCode = 2;
    return;
  }

  // 1. Parse + validate
  const parseResult = parseCap(src);
  if (!parseResult.ast) {
    console.error(`Parse failed; refusing to apply.`);
    for (const e of parseResult.errors) {
      console.error(`  line ${e.line}, col ${e.col}: ${e.message}`);
    }
    process.exitCode = 1;
    return;
  }
  const validation = validateCap(parseResult.ast);
  if (!validation.valid) {
    console.error(`Profile validation failed; refusing to apply.`);
    for (const v of validation.violations) {
      console.error(`  [${v.code}] ${v.message}`);
    }
    process.exitCode = 1;
    return;
  }

  // 2. Verify JWS
  const sigText = readOrFail(options.signature);
  if (sigText == null) {
    process.exitCode = 2;
    return;
  }
  const parsedJws = parseDetachedJwsCompact(sigText.trim());
  if (!parsedJws) {
    console.error(
      'Signature file is not a valid detached JWS compact form (expected `<header>..<signature>`).',
    );
    process.exitCode = 1;
    return;
  }
  const keys = options.key.map((hex) => hexToBytes(hex));
  const result = verifyDetachedJws(src, parsedJws.header, parsedJws.signature, keys);
  if (!result.valid) {
    console.error(`JWS verification failed [${result.code}]: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  // 3. Selector eval
  const podStore = loadPodStore(options.pod);
  if (podStore == null) {
    process.exitCode = 2;
    return;
  }
  const bindings = evaluateSelector(parseResult.ast, podStore);
  if (bindings.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ applied: 0, reason: 'inapplicable' }, null, 2));
    } else {
      console.log(`Advisory not applicable to this pod (zero selector matches).`);
    }
    process.exitCode = 0;
    return;
  }

  // 4. Apply
  const advisoryIri =
    parseResult.ast.envelope.advisoryId ??
    `urn:cascade:advisory:${path.basename(patchPath, '.ldpatch')}`;
  const applyResult = applyCap(parseResult.ast, bindings, podStore, advisoryIri);

  // Persist updated pod (write back to a snapshot file in the pod).
  await writePodSnapshot(options.pod, podStore);

  // Mark cache record applied if the advisory ID is in the cache.
  updateCacheStatus(options.pod, advisoryIri, {
    status: 'applied',
    appliedAt: new Date().toISOString(),
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          applied: applyResult.matchesApplied,
          activityIris: applyResult.activityIris,
          matchedRecordIris: applyResult.matchedRecordIris,
          insertedTriples: applyResult.insertedQuads.length,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Applied advisory ${advisoryIri} to ${applyResult.matchesApplied} match(es).`);
    console.log(`Inserted ${applyResult.insertedQuads.length} triples (incl. activity records).`);
    for (let i = 0; i < applyResult.matchesApplied; i++) {
      console.log(`  match ${i + 1}: ${applyResult.matchedRecordIris[i]}`);
      console.log(`    activity: ${applyResult.activityIris[i]}`);
    }
  }
}

async function runList(program: Command, options: ListOptions): Promise<void> {
  const opts = globalOpts(program);
  const filter = options.pending
    ? 'pending'
    : options.applied
      ? 'applied'
      : options.declined
        ? 'declined'
        : undefined;
  const records = listCacheRecords(options.pod, filter as AdvisoryCacheStatus | undefined);
  if (opts.json) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }
  if (records.length === 0) {
    console.log(`No advisories${filter ? ` with status '${filter}'` : ''} in ${options.pod}.`);
    return;
  }
  for (const r of records) {
    console.log(`[${r.status}] ${r.entry.id}`);
    console.log(`  class:   ${r.entry.advisoryClass}`);
    console.log(`  issuer:  ${r.entry.issuer}`);
    console.log(`  fetched: ${r.fetchedAt}`);
    if (r.appliedAt) console.log(`  applied: ${r.appliedAt}`);
    if (r.declinedAt) console.log(`  declined: ${r.declinedAt}${r.declineReason ? ` — ${r.declineReason}` : ''}`);
    console.log(`  summary: ${r.entry.humanSummary}`);
  }
}

async function runRevert(program: Command, options: RevertOptions): Promise<void> {
  const opts = globalOpts(program);
  const podStore = loadPodStore(options.pod);
  if (podStore == null) {
    process.exitCode = 2;
    return;
  }

  // Find the activity record whose prov:used == advisory IRI.
  const advisoryNode = namedNode(options.advisory);
  const activitySubjects = new Set<string>();
  for (const qq of podStore.match(null, namedNode(PROV_USED), advisoryNode)) {
    if (qq.subject.termType === 'NamedNode') activitySubjects.add(qq.subject.value);
  }
  if (activitySubjects.size === 0) {
    console.error(`No applied activity found for advisory ${options.advisory}; nothing to revert.`);
    process.exitCode = 1;
    return;
  }

  // For each activity, remove all triples whose prov:wasGeneratedBy points at it,
  // plus the activity's own triples. NOTE: revert removes inserted triples but
  // CANNOT un-supersede a previously-revised record — the prior record was
  // never modified in the first place. Revert effectively undoes the additive
  // revision; the prior remains as it was.
  const PROV_WAS_GENERATED_BY = 'http://www.w3.org/ns/prov#wasGeneratedBy';
  let removedCount = 0;
  for (const actIri of activitySubjects) {
    const actNode = namedNode(actIri);
    // Subjects generated by this activity:
    const generatedSubjects = new Set<string>();
    for (const qq of podStore.match(null, namedNode(PROV_WAS_GENERATED_BY), actNode)) {
      if (qq.subject.termType === 'NamedNode') generatedSubjects.add(qq.subject.value);
    }
    // Remove all triples for those generated subjects
    for (const subj of generatedSubjects) {
      const subjNode = namedNode(subj);
      for (const qq of podStore.getQuads(subjNode, null, null, null)) {
        podStore.removeQuad(qq);
        removedCount += 1;
      }
    }
    // Remove the activity's own triples
    for (const qq of podStore.getQuads(actNode, null, null, null)) {
      podStore.removeQuad(qq);
      removedCount += 1;
    }
  }

  await writePodSnapshot(options.pod, podStore);
  updateCacheStatus(options.pod, options.advisory, {
    status: 'declined',
    declinedAt: new Date().toISOString(),
    declineReason: 'reverted by user',
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        { reverted: options.advisory, activitiesRemoved: activitySubjects.size, triplesRemoved: removedCount },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Reverted ${options.advisory}: removed ${activitySubjects.size} activity record(s) ` +
        `and ${removedCount} total triple(s). The prior record (if any) was never modified ` +
        `by the original application, so no un-supersession is needed.`,
    );
  }
}

async function runFeedPull(
  program: Command,
  url: string,
  options: { pod: string },
): Promise<void> {
  const opts = globalOpts(program);
  const result = await pullFeed(url, options.pod);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(`Feed pull failed: ${result.reason}`);
  } else {
    console.log(`Feed pull from ${url}:`);
    console.log(`  new entries:    ${result.newEntries.length}`);
    for (const id of result.newEntries) console.log(`    + ${id}`);
    console.log(`  skipped:        ${result.skippedEntries.length}`);
    if (result.bodyFailures.length > 0) {
      console.log(`  body failures:  ${result.bodyFailures.length}`);
      for (const f of result.bodyFailures) console.log(`    ! ${f.id}: ${f.reason}`);
    }
  }
  if (!result.ok) process.exitCode = 1;
}

async function runDryRun(
  program: Command,
  patchPath: string,
  options: { pod: string },
): Promise<void> {
  const opts = globalOpts(program);
  const src = readOrFail(patchPath);
  if (src == null) {
    process.exitCode = 2;
    return;
  }
  const parseResult = parseCap(src);
  if (!parseResult.ast) {
    console.error(`Parse failed; cannot dry-run.`);
    for (const e of parseResult.errors) {
      console.error(`  line ${e.line}, col ${e.col}: ${e.message}`);
    }
    process.exitCode = 1;
    return;
  }
  const validation = validateCap(parseResult.ast);
  if (!validation.valid) {
    console.error(`Profile validation failed; cannot dry-run.`);
    for (const v of validation.violations) console.error(`  [${v.code}] ${v.message}`);
    process.exitCode = 1;
    return;
  }
  const podStore = loadPodStore(options.pod);
  if (podStore == null) {
    process.exitCode = 2;
    return;
  }
  // Clone: we want the bindings + would-be inserts, but no mutation.
  const cloneStore = new Store();
  for (const qq of podStore.getQuads(null, null, null, null)) cloneStore.addQuad(qq);

  const bindings = evaluateSelector(parseResult.ast, cloneStore);
  if (bindings.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ matches: 0, wouldInsert: 0 }, null, 2));
    } else {
      console.log(`Advisory inapplicable to this pod (zero matches). No triples would be inserted.`);
    }
    return;
  }

  const advisoryIri =
    parseResult.ast.envelope.advisoryId ??
    `urn:cascade:advisory:${path.basename(patchPath, '.ldpatch')}`;
  const result = applyCap(parseResult.ast, bindings, cloneStore, advisoryIri, {
    suppressActivityLinks: true,
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          matches: bindings.length,
          wouldInsert: result.insertedQuads.length,
          activityIris: result.activityIris,
          matchedRecordIris: result.matchedRecordIris,
          turtle: quadsToTurtle(result.insertedQuads),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Dry-run: ${bindings.length} match(es), would insert ${result.insertedQuads.length} triple(s).`,
    );
    console.log('--- would-insert ---');
    console.log(quadsToTurtle(result.insertedQuads));
    console.log('--- end dry-run ---');
    console.log(`Pod state unchanged.`);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

function collectMany(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function readOrFail(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    console.error(`Cannot read ${p}: ${(e as Error).message}`);
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`hex key must be even-length, got ${clean.length}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Load a pod's RDF state into an n3 Store. We follow a simple convention:
 * read every .ttl under `<pod>/data/` if present, else assume the pod is
 * a directory of .ttl files at the top level. Returns null + logs on error.
 *
 * For the v0.1 advisory pipeline, the source-of-truth is the most recent
 * snapshot at `<pod>/state.ttl` if present, otherwise the union of .ttl files.
 */
function loadPodStore(podDir: string): Store | null {
  if (!fs.existsSync(podDir)) {
    console.error(`Pod directory not found: ${podDir}`);
    return null;
  }
  const store = new Store();
  const snapshot = path.join(podDir, 'state.ttl');
  if (fs.existsSync(snapshot)) {
    const ttl = fs.readFileSync(snapshot, 'utf8');
    const parsed = parseTurtle(ttl);
    if (!parsed.success) {
      console.error(`Pod snapshot ${snapshot} is malformed Turtle`);
      return null;
    }
    for (const qq of parsed.quads) store.addQuad(qq);
    return store;
  }
  // Fall back: collect all .ttl files in the pod directory tree.
  for (const f of walk(podDir)) {
    if (!f.endsWith('.ttl')) continue;
    if (f.includes(path.sep + 'policies' + path.sep)) continue; // policies are read separately
    const ttl = fs.readFileSync(f, 'utf8');
    const parsed = parseTurtle(ttl);
    if (parsed.success) for (const qq of parsed.quads) store.addQuad(qq);
  }
  return store;
}

async function writePodSnapshot(podDir: string, store: Store): Promise<void> {
  const writer = new Writer();
  for (const qq of store.getQuads(null, null, null, null)) writer.addQuad(qq);
  const ttl = await new Promise<string>((resolve, reject) => {
    writer.end((err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
  fs.writeFileSync(path.join(podDir, 'state.ttl'), ttl, 'utf8');
}

function quadsToTurtle(quads: ReadonlyArray<{ subject: { value: string; termType: string }; predicate: { value: string }; object: { value: string; termType: string; datatype?: { value: string } } }>): string {
  // Minimal Turtle dump for the dry-run human-readable output.
  // We use n3 Writer for correctness.
  const writer = new Writer({ prefixes: {} });
  for (const qq of quads) {
    writer.addQuad(
      qq as unknown as Parameters<typeof writer.addQuad>[0],
    );
  }
  let out = '';
  writer.end((_err, result) => {
    out = result ?? '';
  });
  return out;
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}
