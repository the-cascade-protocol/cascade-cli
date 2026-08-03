/**
 * The read layer is a DOOR, and this test is the lock on every other way in.
 *
 * Encryption was retrofitted onto a CLI whose read verbs each walked the pod's
 * files and parsed them independently. Every verb had to be taught about the
 * DEK one incident at a time, and each one that had not yet been taught shipped
 * the same lie: an encrypted pod reported as an empty one. Fixing the verbs one
 * by one does not end that class — a NEW verb written next month can reach for
 * the same plaintext primitives and reintroduce it on its first commit.
 *
 * So the primitives are fenced. `parseTurtleFile` and `parseDataFile` read a
 * file and parse it with no notion of a key; composing `readResource` with a
 * parser by hand is the same thing spelled longhand. Both are legal only inside
 * the read layer and inside the parser module that defines them. Everywhere
 * else, a record read goes through `openPod()` and the `PodReader` it returns.
 *
 * If this test fails on your new code, the fix is not to widen the allowlist:
 * it is to take the reader. `openPod()` resolves the DEK once and every read
 * hangs off it, which is the only arrangement in which forgetting the key is
 * not an option.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Files permitted to call the plaintext read primitives, each with the reason.
 * An entry here is a claim that the file cannot get the DEK wrong — usually
 * because it IS the layer that holds it.
 */
const PRIMITIVE_ALLOWLIST: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'lib/turtle-parser.ts',
    why: 'defines parseTurtle / parseTurtleFile; the primitives themselves',
  },
  {
    file: 'lib/pod-read.ts',
    why: 'the read layer: resolves the DEK once and owns every record read',
  },
];

/**
 * Files permitted to compose a `readResource` call with a parser.
 *
 * These are WRITE paths doing read-merge-write on a file they are about to
 * overwrite: they already hold a DEK obtained through the shared resolution,
 * and they need the raw text rather than a record view. They are listed rather
 * than blanket-permitted so that a new READ verb cannot quietly join them.
 */
const COMPOSITION_ALLOWLIST: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'lib/pod-read.ts',
    why: 'the read layer',
  },
  {
    file: 'commands/pod/import.ts',
    why: 'read-merge-write of bucket files it is about to re-seal with the same DEK',
  },
];

/** Every `.ts` file under `src/`, as pod-relative-ish paths with / separators. */
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

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC_DIR, rel), 'utf-8');
}

/**
 * Strip block and line comments so a doc comment that NAMES a primitive (this
 * codebase explains why rules exist, and those explanations quote the banned
 * calls) is not mistaken for a call to it.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the read layer is the only door', () => {
  it('nothing outside the read layer calls the plaintext parse primitives', () => {
    const allowed = new Set(PRIMITIVE_ALLOWLIST.map((a) => a.file));
    const offenders: string[] = [];

    for (const rel of sourceFiles()) {
      if (allowed.has(rel)) continue;
      const code = stripComments(read(rel));
      // A call, not a mention: `parseTurtleFile(` / `parseDataFile(`.
      for (const primitive of ['parseTurtleFile', 'parseDataFile']) {
        if (new RegExp(`\\b${primitive}\\s*\\(`).test(code)) {
          offenders.push(`${rel} calls ${primitive}()`);
        }
      }
    }

    expect(
      offenders,
      'These files read pod resources without the pod read layer, which is how an ' +
        'encrypted pod ends up reported as an empty one. Take a PodReader from ' +
        'openPod() instead of calling the plaintext primitives.',
    ).toEqual([]);
  });

  it('nothing outside the allowlist hand-composes readResource with a parser', () => {
    const allowed = new Set(COMPOSITION_ALLOWLIST.map((a) => a.file));
    const offenders: string[] = [];

    for (const rel of sourceFiles()) {
      if (allowed.has(rel)) continue;
      const code = stripComments(read(rel));
      // `parseX(readResource(...))` in any spelling, including via a local
      // helper: the tell is a parse call wrapping a readResource call.
      if (/\bparse\w*\s*\(\s*(await\s+)?readResource\s*\(/.test(code)) {
        offenders.push(`${rel} parses the result of readResource() directly`);
      }
    }

    expect(
      offenders,
      'A raw readResource-then-parse is a record read that bypasses the read layer. ' +
        'Use PodReader.parseFile() / PodReader.readRecords().',
    ).toEqual([]);
  });

  it('every allowlist entry names a file that exists and a reason', () => {
    // An allowlist that rots into stale paths stops being a fence.
    for (const entry of [...PRIMITIVE_ALLOWLIST, ...COMPOSITION_ALLOWLIST]) {
      expect(fs.existsSync(path.join(SRC_DIR, entry.file)), `${entry.file} is gone`).toBe(true);
      expect(entry.why.length, `${entry.file} has no stated reason`).toBeGreaterThan(10);
    }
  });

  it('the read layer exports the door every verb is supposed to use', () => {
    const layer = read('lib/pod-read.ts');
    for (const symbol of [
      'export async function openPod',
      'export class PodReader',
      'export class PodReadLedger',
      'export class PodUnreadableError',
      'export class PodFilesUnreadableError',
    ]) {
      expect(layer, `pod-read.ts no longer has: ${symbol}`).toContain(symbol);
    }
  });
});
