/**
 * No TypeScript source may contain a raw NUL byte.
 *
 * `src/lib/reconciler.ts` used NUL as a key delimiter and wrote it as a LITERAL
 * byte inside three template literals rather than as a backslash-u escape. The
 * two spell the same string, TypeScript compiles either, and every test passed —
 * but `file(1)` reclassifies the source as binary data, and grep and ripgrep
 * skip binary files silently. The result was that 1,339 lines of the core
 * merge-and-drop logic answered "no matches" to strings it demonstrably
 * contained:
 *
 *     grep -rn "resolveGroup" src/   # exit 1, no output, 5 occurrences present
 *     rg -n  "defaultTrust"  src/    # exit 1, no output
 *
 * A file that reports a clean result for a string it contains is worse than an
 * unaudited file, because a clean result is what an audit is looking for. Every
 * sweep of this repo — human or automated — starts with a content search, and
 * this is the mechanism by which the very defect the sibling test file covers
 * survived earlier sweeps of exactly its own defect class.
 *
 * Repairing the three sites is a one-character-per-site change; this test is the
 * part that keeps it repaired, since the bug is reintroduced by pasting.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('every TypeScript source is greppable text', () => {
  it('contains no raw NUL byte anywhere under src/', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const bytes = fs.readFileSync(file);
      const at = bytes.indexOf(0);
      if (at !== -1) {
        const line = bytes.subarray(0, at).toString('utf8').split('\n').length;
        offenders.push(`${path.relative(SRC_DIR, file)}:${line}`);
      }
    }
    expect(
      offenders,
      'Write the delimiter as the escape `\\u0000`. A raw NUL makes grep and ripgrep ' +
        'skip the whole file without saying so, which turns every future audit of it into ' +
        'a false clean.',
    ).toEqual([]);
  });

  it('finds the symbols a content search must be able to find', () => {
    // The concrete symptom, pinned so a regression is recognizable rather than
    // merely counted: these symbols exist in the file that carried the NULs.
    const reconciler = fs.readFileSync(path.join(SRC_DIR, 'lib', 'reconciler.ts'));
    expect(reconciler.indexOf(0)).toBe(-1);
    const text = reconciler.toString('utf8');
    for (const symbol of ['resolveGroup', 'defaultTrust', 'splitIdentityCollisions']) {
      expect(text, `${symbol} must be findable`).toContain(symbol);
    }
  });
});
