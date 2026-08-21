import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// This repository is public and its `dist/` is published to npm, where a
// release cannot be withdrawn after 72 hours. Internal tracker references
// belong in the private tracker, not in shipped source. Comments survive
// compilation (tsconfig does not set removeComments), so a reference left in a
// source comment reaches the package tarball.
//
// The patterns are assembled from fragments on purpose: spelled out literally,
// this file would match its own scan, and the tempting fix for that -- skipping
// this file -- creates the one place in the repo where a reference could hide.
const NUM = String.raw`[0-9]+\.[0-9]+`;
const FORBIDDEN = [
  `${'root back' + 'log'} ${NUM}`,
  `${'root'} ${NUM}[a-z]?\\b`,
  'docs' + '/plan' + 'ning',
  'cascade' + '-work' + 'bench',
].join('|');

function scan(dir: string): string[] {
  try {
    return execFileSync('grep', ['-rlE', FORBIDDEN, dir], { cwd: repoRoot, encoding: 'utf-8' })
      .split('\n').filter(Boolean);
  } catch (err) {
    // grep exits 1 with no output when nothing matches; anything else is real
    // and must not be swallowed into a passing test.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

describe('public repo carries no internal tracker references', () => {
  // `scripts/` is scanned for the same reason as the three above even though it
  // is not in package.json `files`: it is public the moment it is pushed, and it
  // was carrying two references when this line was added. Scanning only what
  // ships confuses "not published to npm" with "not published".
  for (const dir of ['src', 'tests', 'docs', 'scripts', '.github']) {
    it(`${dir}/ is free of them`, () => {
      expect(scan(dir)).toEqual([]);
    });
  }

  it('the scan matches when a reference IS present', () => {
    // Without this, a broken regex -- or a grep that silently found nothing --
    // would make every assertion above pass while proving nothing.
    const sample = `see ${'root back' + 'log'} 9.99`;
    const hits = execFileSync('sh', ['-c', `printf '%s\\n' "${sample}" | grep -cE '${FORBIDDEN}'`], {
      encoding: 'utf-8',
    }).trim();
    expect(hits).toBe('1');
  });

  it('scans a non-empty tree, so an empty result means clean and not missing', () => {
    const files = execFileSync('sh', ['-c', 'ls src/lib/*.ts | wc -l'], {
      cwd: repoRoot, encoding: 'utf-8',
    }).trim();
    expect(Number(files)).toBeGreaterThan(0);
  });
});
