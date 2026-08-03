/**
 * Identity minting is a DOOR, and this test is the lock on every other way in.
 *
 * Every importer in this repo independently reached for the same shape — take
 * the source's `id`, and if there isn't one, make something up — and every one
 * of them got it wrong in a slightly different dialect: `randomUUID()` in the
 * FHIR converter, `Math.random().toString(36)` in five genomics converters,
 * `${ctx.importedAt}:${Math.random()}` in two more, and a bare
 * `doc:${importedAt}` in the C-CDA converter. The consequence in every dialect
 * is identical: re-importing one document mints a second identity for each
 * id-less record in it, so nothing reconciles and the pod duplicates on every
 * sync, silently.
 *
 * Fixing eleven sites does not end that class. The correct pattern ALREADY
 * existed in this repo, twice — `contentSeed()` in the phenopacket variation
 * descriptor and `contentHashedUri()` in the FHIR converter — and was
 * propagated neither time, so each new converter re-broke it on its first
 * commit. That is the actual root cause, and the only fix for it is a fence.
 *
 * ---------------------------------------------------------------------------
 * THE DISTINCTION THIS TEST TURNS ON
 * ---------------------------------------------------------------------------
 * `randomUUID()` is not banned. Banning a function name would be both too
 * strict and too weak: too strict because per-EVENT identifiers must be unique
 * and randomness is exactly right for them, and too weak because `importedAt`
 * and `Date.now()` are non-deterministic without containing the word "random".
 *
 * So the rule is about WHAT is being identified, not which function does it:
 *
 *   CONTENT IDENTITY — "which record is this?" Answered by the record. Two
 *                      encounters with the same source record must produce the
 *                      same IRI, forever, on any machine. Randomness, clocks
 *                      and per-run values are all disqualified.
 *
 *   EVENT IDENTITY   — "which occurrence is this?" Answered by the occurrence.
 *                      An audit entry, a user's resolution of a conflict, an
 *                      annotation someone wrote: running the verb twice IS two
 *                      events, and each is entitled to its own id. Randomness
 *                      is correct here and determinism would be a bug.
 *
 * Three checks enforce that split:
 *   1. IDENTITY_MODULES may contain no non-determinism at all, exempt or not.
 *   2. Everywhere else, each use must be in EVENT_IDENTITY_ALLOWLIST.
 *   3. No identity-minting call anywhere may take a non-deterministic argument.
 *
 * If check 1 or 3 fails on your new converter, the fix is not to widen a list:
 * it is to take the door, `identitySeed`/`identityKey` in `src/lib/identity.ts`,
 * which resolves explicit id → content hash and has no third tier.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Directories and files that mint CONTENT identity. Nothing non-deterministic
 * may appear anywhere inside them — there is no legitimate per-event id in an
 * importer, so an exemption here would always be a mistake.
 */
const IDENTITY_MODULES: readonly string[] = [
  'lib/identity.ts',
  'lib/fhir-converter/',
  'lib/fhir-genomics-converter/',
  'lib/phenopacket-converter/',
  'lib/ccda-converter/',
  'lib/vcf-converter/',
  'lib/clinvar-converter/',
  'lib/vrs-converter/',
];

/**
 * Uses of randomness that identify an EVENT rather than a record.
 *
 * Each entry is a claim that running the same operation twice legitimately
 * produces two things, so a stable id would be wrong. That claim is what is
 * being reviewed when someone adds to this list — not whether the code
 * compiles.
 */
const EVENT_IDENTITY_ALLOWLIST: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'lib/mcp/audit.ts',
    why:
      'Audit entry ids. One per audited access, and two identical accesses are two events in the ' +
      'log; collapsing them would destroy the record the audit log exists to keep.',
  },
  {
    file: 'lib/mcp/tools.ts',
    why:
      'pod_write mints the URI for a record an agent is AUTHORING. There is no source document to ' +
      'reconcile against — this is a create verb, not an import — so there is no prior identity to ' +
      'recover. (Whether repeated identical pod_write calls should dedupe is an idempotence ' +
      'question about the write surface, not an identity-minting defect; tracked separately.)',
  },
  {
    file: 'lib/annotations.ts',
    why:
      'mintUri() for overlay ACTS: annotations, amendments, retractions, tombstones, add-record. ' +
      'Each carries its own prov:generatedAtTime because each is a thing a person did at a time. ' +
      'Annotating the same record twice with the same text is two annotations, by design — unlike ' +
      'importing the same document twice, which is one document.',
  },
  {
    file: 'lib/user-resolutions.ts',
    why: 're-exports randomUUID for the resolve/import commands below; contains no call of its own.',
  },
  {
    file: 'commands/pod/import.ts',
    why:
      'The pending-conflict record URI. The conflict itself is deduped on the DETERMINISTIC ' +
      'generateConflictId(recordType, matchedOn); the urn is the id of one detection event.',
  },
  {
    file: 'commands/pod/resolve.ts',
    why: 'The user-resolution record URI: one per decision a person made, stamped with resolvedAt.',
  },
  {
    file: 'lib/advisory/applier.ts',
    why:
      'PROV activity IRIs for one advisory application. A prov:Activity is an occurrence by ' +
      'definition, and the minter is injectable so callers needing stronger uniqueness can swap it.',
  },
];

/**
 * Sources of non-determinism.
 *
 * Split into two groups, because they are not equally out of place. RANDOM has
 * no legitimate use anywhere in a converter, so it is banned outright there.
 * CLOCK values are legitimate CONTENT in a converter — `clinical:importedAt` and
 * `prov:generatedAtTime` are provenance literals every importer is supposed to
 * emit — but they are never legitimate INPUTS to an identity key. So clocks are
 * policed by where they flow, not by whether they appear.
 *
 * `importedAt` is in the clock group deliberately. It does not look random, and
 * that disguise is exactly how two of these sites survived a previous sweep of
 * this very defect: removing their visible `Math.random()` would have left them
 * keyed on a per-run timestamp and just as non-deterministic.
 */
const RANDOM = [
  { pattern: /\bMath\.random\s*\(/, name: 'Math.random()' },
  { pattern: /\brandomUUID\s*\(/, name: 'randomUUID()' },
] as const;

const CLOCK = [
  { pattern: /\bDate\.now\s*\(/, name: 'Date.now()' },
  { pattern: /\bnew Date\s*\(\s*\)/, name: 'new Date()' },
  { pattern: /\bimportedAt\b/, name: 'importedAt (a per-run timestamp)' },
] as const;

const NONDETERMINISM = [...RANDOM, ...CLOCK];

/** Calls that mint an identity. Their arguments must be deterministic. */
const IDENTITY_CALLS = ['deterministicUuid(', 'contentHashedUri(', 'identitySeed(', 'identityKey(', 'medicationUri('];

/** Every `.ts` file under `src/`, as `/`-separated paths relative to src. */
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

/** Strip line comments, block comments and string/template literals. */
function stripNonCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/**
 * Code with comments removed but template literals KEPT.
 *
 * Template literals are where identity keys are actually built
 * (`` `genomics:Variant:${sys}:${id}` ``), so a check that strips them cannot
 * see the very interpolations it is looking for.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function isUnder(file: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
}

/** Extract the argument text of every `name(...)` call, balancing parens. */
function callArguments(code: string, callName: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = code.indexOf(callName, from);
    if (start === -1) break;
    let depth = 0;
    let i = start + callName.length - 1;
    const open = i;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(code.slice(open + 1, i));
    from = start + callName.length;
  }
  return out;
}

const FILES = sourceFiles();
const CODE = new Map(FILES.map((f) => [f, fs.readFileSync(path.join(SRC_DIR, f), 'utf8')]));

describe('identity minting has exactly one door', () => {
  it('the door exists and exports the cascade', async () => {
    const mod = await import('../src/lib/identity.js');
    expect(typeof mod.identitySeed).toBe('function');
    expect(typeof mod.identityKey).toBe('function');
    // The cascade has exactly three outcomes and none of them is "random".
    expect(mod.identitySeed({ explicitId: 'abc' })).toEqual({ seed: 'abc', source: 'explicit' });
    expect(mod.identitySeed({ content: { a: 1 } }).source).toBe('content');
    expect(mod.identitySeed({}).source).toBe('empty');
  });

  it('no identity-minting module contains randomness AT ALL — no exemptions', () => {
    // An importer transcribes records that already exist. It has no events of
    // its own to identify, so there is no reading of `Math.random()` inside one
    // that is correct, and therefore no allowlist for this check.
    const offenders: string[] = [];
    for (const file of FILES) {
      if (!isUnder(file, IDENTITY_MODULES)) continue;
      const code = stripComments(CODE.get(file)!);
      for (const { pattern, name } of RANDOM) {
        if (pattern.test(code)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(
      offenders,
      'An importer has no legitimate per-event id. Route this through identitySeed() ' +
        'in src/lib/identity.ts. There is deliberately no way to exempt this.',
    ).toEqual([]);
  });

  it('every remaining use of randomness is a declared EVENT identity', () => {
    const allowed = new Set(EVENT_IDENTITY_ALLOWLIST.map((e) => e.file));
    const offenders: string[] = [];
    for (const file of FILES) {
      if (isUnder(file, IDENTITY_MODULES)) continue;  // covered by the stricter check above
      if (allowed.has(file)) continue;
      const code = stripNonCode(CODE.get(file)!);
      for (const { pattern, name } of RANDOM) {
        if (pattern.test(code)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(
      offenders,
      'If this identifies a RECORD, take the door. If it identifies an EVENT, add it to ' +
        'EVENT_IDENTITY_ALLOWLIST with the reason two runs are legitimately two things.',
    ).toEqual([]);
  });

  it('the allowlist carries no dead entries', () => {
    // A stale exemption is a hole nobody is looking at.
    const dead = EVENT_IDENTITY_ALLOWLIST.filter((e) => {
      const code = CODE.get(e.file);
      if (code === undefined) return true;
      return !/\bMath\.random\s*\(|\brandomUUID\b/.test(stripNonCode(code));
    }).map((e) => e.file);
    expect(dead).toEqual([]);
  });

  it('every allowlist entry states WHY, at length', () => {
    for (const entry of EVENT_IDENTITY_ALLOWLIST) {
      expect(entry.why.length, `${entry.file} needs a real justification`).toBeGreaterThan(60);
    }
  });

  it('no identity-minting call takes a non-deterministic argument', () => {
    // The check that would have caught observation-variant.ts and biosamples.ts,
    // where `Math.random()` was removed-adjacent but `ctx.importedAt` remained.
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file === 'lib/identity.ts') continue;  // defines the door
      const code = stripComments(CODE.get(file)!);
      for (const call of IDENTITY_CALLS) {
        for (const args of callArguments(code, call)) {
          for (const { pattern, name } of NONDETERMINISM) {
            if (pattern.test(args)) {
              offenders.push(`${file}: ${call}…) receives ${name}`);
            }
          }
        }
      }
    }
    expect(
      offenders,
      'An identity key must be a pure function of the source record. A per-run timestamp in ' +
        'the key is the same defect as a random value, and harder to see.',
    ).toEqual([]);
  });

  it('ctx.importedAt appears in no identity key anywhere', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const code = stripComments(CODE.get(file)!);
      // Any template literal that both interpolates importedAt and looks like a
      // key (contains a `:` separator) inside an identity call is caught above;
      // this is the blunter backstop for the converter tree.
      if (!isUnder(file, IDENTITY_MODULES)) continue;
      if (/importedAt/.test(code)) {
        // Converters legitimately EMIT importedAt as a provenance literal. Only
        // flag it when it is spliced into a template literal, which is how every
        // one of these defects was written.
        for (const lit of code.match(/`[^`]*`/g) ?? []) {
          if (/\$\{[^}]*importedAt[^}]*\}/.test(lit) && lit.includes(':')) {
            offenders.push(`${file}: ${lit.trim().slice(0, 80)}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
