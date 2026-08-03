/**
 * The C-CDA importer mints identity through ONE door, and this is the lock on
 * every other way in.
 *
 * WHAT IS BEING PROTECTED, STATED SO THE NEXT READER DOES NOT HAVE TO GUESS
 * ------------------------------------------------------------------------
 * Every C-CDA section handler independently wrote the same call:
 *
 *     contentHashedUri('X', { patient: patientUri, … }, sourceId || undefined, entry)
 *
 * It reads as "identify by content, and fall back to the source's id". It is
 * not. `contentHashedUri` consults `fallbackId` ONLY when every content field is
 * empty, and `patient` was always a non-empty `urn:uuid:`, so the id was not a
 * fallback — it was DEAD, at all ten identity sites, unconditionally. Two
 * records the source had deliberately kept apart minted one IRI and one of them
 * was overwritten.
 *
 * A comment does not hold that shut. The lab section already carried a "subject
 * minting is FROZEN" comment, and the freeze is a large part of why the defect
 * survived long enough to ship in two importers at once; the note left in its
 * place says that a test states which property is protected instead of asking
 * the next reader to guess. This is that test.
 *
 * THE THREE RULES
 * ---------------
 *   1. Nothing under `lib/ccda-converter/` may call `contentHashedUri` or
 *      `medicationUri` except the door itself. One place decides, so there is
 *      one place to review when the rule changes.
 *   2. The door's own calls pass `undefined` in the fallbackId slot. That is the
 *      dead-`fallbackId` shape, made unrepresentable rather than discouraged.
 *   3. No C-CDA identity key contains a patient component. It merged records the
 *      source kept apart and split records that were the same; a field that is
 *      constant within a pod cannot tell two of that pod's records apart.
 *
 * WHAT THESE WOULD DO IF THE FIX WERE ABSENT: rules 1 and 2 both FAIL against
 * `main` at 51a4089 — there is no door there, and ten call sites pass a live
 * `sourceId` in the third argument. Rule 3 fails there too, on ten `patient:`
 * key entries.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const CCDA_DIR = 'lib/ccda-converter/';

/** The one module allowed to mint. */
const DOOR = 'lib/ccda-converter/record-identity.ts';

/** Identity primitives whose fallbackId slot is the shape being banned. */
const GUARDED: ReadonlyArray<{ call: string; fallbackArgIndex: number }> = [
  { call: 'contentHashedUri(', fallbackArgIndex: 2 },
  { call: 'medicationUri(', fallbackArgIndex: 1 },
];

function ccdaSourceFiles(): string[] {
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
  walk(path.join(SRC_DIR, 'lib', 'ccda-converter'));
  return out.sort();
}

/** Strip line and block comments; keep template literals and strings. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The argument text of every `name(…)` call, balancing parens. */
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

/** Split an argument list on TOP-LEVEL commas only. */
function topLevelArgs(argText: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of argText) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim());
}

const FILES = ccdaSourceFiles();
const CODE = new Map(FILES.map((f) => [f, fs.readFileSync(path.join(SRC_DIR, f), 'utf8')]));

describe('C-CDA identity minting has exactly one door', () => {
  it('the door exists and applies id -> content -> loud collapse', async () => {
    const mod = await import('../src/lib/ccda-converter/record-identity.js');
    expect(typeof mod.ccdaRecordUri).toBe('function');
    expect(typeof mod.ccdaSourceId).toBe('function');
    expect(typeof mod.ccdaMedicationRecordUri).toBe('function');

    // Tier 1: the id decides, and nothing else is consulted.
    const withId = (content: Record<string, string | undefined>) =>
      mod.ccdaRecordUri({ type: 'Condition', sourceId: '1.2.3:A', content });
    expect(withId({ conditionName: 'diabetes' })).toBe(withId({ conditionName: 'asthma' }));

    // Tier 2: no id, so the content separates.
    const noId = (content: Record<string, string | undefined>) =>
      mod.ccdaRecordUri({ type: 'Condition', content });
    expect(noId({ conditionName: 'diabetes' })).not.toBe(noId({ conditionName: 'asthma' }));

    // Tier 4: nothing at all, and it is not silent.
    const warnings: string[] = [];
    mod.ccdaRecordUri({ type: 'Condition', content: {}, source: {}, warnings, label: 'C-CDA problem' });
    expect(warnings.length, 'an identity collapse must never be silent').toBe(1);
    expect(warnings[0]).toContain('C-CDA problem');
  });

  it('nothing in the C-CDA converter mints identity except the door', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file === DOOR) continue;
      const code = stripComments(CODE.get(file)!);
      for (const { call } of GUARDED) {
        if (callArguments(code, call).length > 0) {
          offenders.push(`${file}: calls ${call}…)`);
        }
      }
    }
    expect(
      offenders,
      `Mint through ccdaRecordUri()/ccdaMedicationRecordUri() in ${DOOR}. A second mint site is ` +
        'how the id tier came to be dead at ten call sites at once.',
    ).toEqual([]);
  });

  it('the door never passes a live fallbackId — the shape that killed the id tier', () => {
    const code = stripComments(CODE.get(DOOR)!);
    const offenders: string[] = [];
    for (const { call, fallbackArgIndex } of GUARDED) {
      for (const args of callArguments(code, call)) {
        const parts = topLevelArgs(args);
        const slot = parts[fallbackArgIndex];
        if (slot === undefined) continue;   // called with fewer args: no fallbackId at all
        if (slot !== 'undefined') {
          offenders.push(`${DOOR}: ${call}…) argument ${fallbackArgIndex + 1} is \`${slot}\`, not \`undefined\``);
        }
      }
    }
    expect(
      offenders,
      'contentHashedUri consults fallbackId ONLY when every content field is empty, so an id ' +
        'passed there is not a fallback, it is discarded. Route the id through the tier-1 branch.',
    ).toEqual([]);
  });

  it('no C-CDA identity key carries a patient component', () => {
    // The derived patient IRI is gone from every key AND from every section
    // signature. Both halves matter: while it was a parameter, the next key
    // written would have reached for it.
    const offenders: string[] = [];
    for (const file of FILES) {
      const code = stripComments(CODE.get(file)!);
      if (/\bpatientUri\b/.test(code)) {
        // `patient.ts` legitimately names its own return value.
        if (file !== 'lib/ccda-converter/sections/patient.ts') {
          offenders.push(`${file}: mentions patientUri`);
        }
      }
      for (const args of callArguments(code, 'ccdaRecordUri(')) {
        if (/(^|[^A-Za-z])patient\s*:/.test(args)) {
          offenders.push(`${file}: an identity key contains a \`patient:\` entry`);
        }
      }
    }
    expect(
      offenders,
      'Within a pod the patient component is either constant — telling no two records apart — or ' +
        'varying, in which case each variation is a spurious split of the same person. See the ' +
        `header of ${DOOR}.`,
    ).toEqual([]);
  });

  it('every C-CDA section handler routes through the door', () => {
    // A section that mints nothing (social-history) is fine; a section that
    // mints without importing the door is not.
    const sections = FILES.filter((f) => f.startsWith(`${CCDA_DIR}sections/`));
    expect(sections.length, 'section handlers not found — has the tree moved?').toBeGreaterThan(8);

    const offenders: string[] = [];
    for (const file of sections) {
      const code = stripComments(CODE.get(file)!);
      const mints = /urn:uuid:|namedNode\(uri\)|namedNode\(patientUri\)/.test(code);
      const takesDoor = /from '\.\.\/record-identity\.js'/.test(code);
      if (mints && !takesDoor) offenders.push(`${file}: mints a subject without importing the door`);
    }
    expect(offenders).toEqual([]);
  });
});
