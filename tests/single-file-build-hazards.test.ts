/**
 * Two hazards that only show up when the CLI is bundled into one file (for
 * example a Bun-compiled executable) and that no unbundled test run can see.
 *
 * 1. Data read relative to the module's own URL. In a single-file build every
 *    bundled module reports the same virtual URL, so `join(__dirname, ...)`
 *    points at nothing. The RxNorm name table was read that way and its
 *    try/catch turned the miss into an empty table, which changed the
 *    content-derived identifier of a medication named only by its RxNorm code.
 *    The test bundles the lookup module into a temporary directory (where no
 *    data file sits beside it) and asserts the lookup still answers.
 *
 * 2. `console.log` with a large payload. In a Bun-compiled binary one
 *    `console.log` call larger than 64 KiB is cut to 65,536 bytes when stdout is
 *    a pipe, and the process still exits 0. Payloads go through `writeStdout`
 *    (src/lib/output.ts). Node does not truncate, so this cannot be reproduced
 *    here; the test is a source guard over the call shapes that print payloads.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';
import { lookupRxNormName } from '../src/lib/ccda-converter/rxnorm-lookup.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('RxNorm name table', () => {
  it('is populated and answers a known ingredient', () => {
    const table = JSON.parse(
      readFileSync(join(ROOT, 'src', 'data', 'rxnorm-names.json'), 'utf8'),
    ) as Record<string, string>;
    // An emptied table must fail here, not degrade silently at runtime.
    expect(Object.keys(table).length).toBeGreaterThan(10_000);
    expect(lookupRxNormName('44')).toBe(table['44']);
    expect(lookupRxNormName('44')).toBe('mesna');
  });

  it('does not answer for inherited object keys', () => {
    expect(lookupRxNormName('toString')).toBeUndefined();
    expect(lookupRxNormName('__proto__')).toBeUndefined();
  });

  it('still answers when bundled into a single file with no data directory beside it', async () => {
    const { build } = await import('esbuild');
    const out = mkdtempSync(join(tmpdir(), 'cascade-rxnorm-bundle-'));
    try {
      const outfile = join(out, 'nested', 'bundle.mjs');
      await build({
        entryPoints: [join(ROOT, 'src', 'lib', 'ccda-converter', 'rxnorm-lookup.ts')],
        bundle: true,
        format: 'esm',
        platform: 'node',
        outfile,
        logLevel: 'silent',
      });
      const mod = (await import(pathToFileURL(outfile).href)) as {
        lookupRxNormName: (rxcui: string) => string | undefined;
      };
      expect(mod.lookupRxNormName('44')).toBe('mesna');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('payload output', () => {
  // A `console.log(` whose first argument is one of these prints a document of
  // unbounded size. Short status lines are fine and are not matched.
  const PAYLOAD_LOG =
    /console\.log\(\s*(toJsonText\(|quadsToTurtle\(|formatResultHuman\(|result\.output\b|result\.turtle\b)/g;

  function tsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : [];
    });
  }

  it('never goes through console.log', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(PAYLOAD_LOG)) {
        const line = text.slice(0, m.index).split('\n').length;
        offenders.push(`${relative(ROOT, file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
