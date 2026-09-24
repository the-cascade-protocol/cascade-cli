/**
 * Every read of the encryption manifest's key material goes through
 * `src/lib/pod-encryption.ts`, which reads manifest versions 1.0 and 1.1 into
 * one normalized shape.
 *
 * Version 1.0 keeps `kdfParams` at the top level and version 1.1 keeps it inside
 * each wrap. A consumer that reads `kdfParams` (or `wrappedDek`) itself is
 * reading one version's layout and will misread the other, so outside the
 * chokepoint module those names must not appear in `src/` at all.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve(__dirname, '..', 'src');
const CHOKEPOINT = path.join(SRC, 'lib', 'pod-encryption.ts');
const FORBIDDEN = /\b(kdfParams|wrappedDek)\b/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|mts|cts|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('encryption manifest chokepoint', () => {
  it('walks a non-empty source tree that includes the chokepoint module', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(CHOKEPOINT);
    expect(FORBIDDEN.test(fs.readFileSync(CHOKEPOINT, 'utf-8'))).toBe(true);
  });

  it('no file outside src/lib/pod-encryption.ts reads kdfParams or wrappedDek', () => {
    const offenders = walk(SRC)
      .filter((f) => f !== CHOKEPOINT)
      .filter((f) => FORBIDDEN.test(fs.readFileSync(f, 'utf-8')))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
