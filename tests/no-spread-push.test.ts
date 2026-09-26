/**
 * No `array.push(...items)` in src/.
 *
 * A spread push hands every item to `push` as its own call argument, and V8
 * keeps call arguments on the stack: past roughly a hundred thousand items it
 * throws `RangeError: Maximum call stack size exceeded`. One daily wellness
 * bucket holds hundreds of thousands of quads, so a spread push that had run
 * for years over clinical files crashed `pod import` and `pod reconcile` the
 * first time a real wellness export was in the pod. Which arrays are
 * "unbounded" is a judgement that goes stale as pods grow, so the rule is
 * blanket: append with `appendAll` (src/lib/append-all.ts), which loops.
 *
 * The scan walks the TypeScript AST, so comments and strings never match and
 * a call split across lines never slips through.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function spreadPushes(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'push' &&
      n.arguments.some(ts.isSpreadElement)
    ) {
      hits.push(`${path.relative(srcRoot, file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

describe('no spread push in src/', () => {
  const files = walk(srcRoot);

  it('scans a plausible number of source files', () => {
    // An empty or truncated walk must not read as a pass.
    expect(files.length).toBeGreaterThan(100);
  });

  it('appends with appendAll, never push(...items)', () => {
    const hits = files.flatMap(spreadPushes);
    expect(hits).toEqual([]);
  });

  it('the scan itself catches a spread push', () => {
    const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spread-probe-')), 'probe.ts');
    fs.writeFileSync(probe, 'const a: number[] = [];\nconst b = [1, 2];\na.push(\n  ...b,\n);\n');
    try {
      expect(spreadPushes(probe)).toHaveLength(1);
    } finally {
      fs.rmSync(path.dirname(probe), { recursive: true, force: true });
    }
  });
});

