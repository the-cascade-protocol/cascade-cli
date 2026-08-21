/**
 * Fails the run once, with everything that is missing, instead of letting the
 * suite fail hundreds of times for reasons that have nothing to do with the
 * code under test.
 *
 * The suite has three prerequisites beyond `npm ci`: a current `dist/`, a
 * `conformance` fixture checkout, and Apache Jena's `riot` on PATH. CI
 * satisfies all three as separate workflow steps, so CI never sees what a
 * fresh clone sees. Without this check that state reads as a broken repo:
 * ~313 failures across 65 files, none of which name a prerequisite.
 *
 * Missing prerequisites fail rather than skip. This suite ratchets its skip
 * count in CI precisely so that a suite which stops running cannot pass as
 * green, and quietly skipping the fixture-backed suites here would hand a
 * contributor the same false green from the other direction.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  CONFORMANCE_CANDIDATES,
  CONFORMANCE_ROOT,
  REPO_ROOT,
  conformanceAvailable,
} from '../helpers/conformance.js';

interface MissingPrerequisite {
  what: string;
  detail: string[];
}

function checkBuild(): MissingPrerequisite | undefined {
  const entry = path.join(REPO_ROOT, 'dist', 'index.js');
  const shapes = path.join(REPO_ROOT, 'dist', 'shapes');
  if (fs.existsSync(entry) && fs.existsSync(shapes)) return undefined;
  return {
    what: 'dist/ is missing or incomplete',
    detail: [
      'Some suites spawn the built CLI (`node dist/index.js`) rather than the sources.',
      'Fix: npm run build',
      '`npm test` does this for you; running `vitest` directly does not.',
    ],
  };
}

function checkConformance(): MissingPrerequisite | undefined {
  if (conformanceAvailable()) return undefined;
  const searched = process.env.CASCADE_CONFORMANCE_DIR
    ? [`CASCADE_CONFORMANCE_DIR=${CONFORMANCE_ROOT}`]
    : CONFORMANCE_CANDIDATES.map((c) => `${c}`);
  const parent = path.dirname(CONFORMANCE_CANDIDATES[0]);
  return {
    what: 'the `conformance` fixture checkout was not found',
    detail: [
      'Searched:',
      ...searched.map((s) => `  ${s}`),
      'Fix: clone it beside this repository —',
      `  git clone https://github.com/the-cascade-protocol/conformance.git ${path.join(parent, 'conformance')}`,
      'Or: set CASCADE_CONFORMANCE_DIR to an existing checkout.',
    ],
  };
}

function checkRiot(): MissingPrerequisite | undefined {
  const probe = spawnSync('riot', ['--version'], { stdio: 'ignore' });
  if (!probe.error) return undefined;
  return {
    what: 'Apache Jena `riot` is not on PATH',
    detail: [
      'The five *-conformance suites canonicalize Turtle through `riot` for',
      'byte-equal comparison, and fail rather than skip without it.',
      'Fix: brew install jena',
      '  or download Apache Jena and add its bin/ directory to PATH.',
    ],
  };
}

export function setup(): void {
  const missing = [checkBuild(), checkConformance(), checkRiot()].filter(
    (m): m is MissingPrerequisite => m !== undefined,
  );
  if (missing.length === 0) return;

  const lines = [
    '',
    `Cannot run the test suite: ${missing.length} prerequisite${missing.length === 1 ? ' is' : 's are'} missing.`,
    '',
  ];
  for (const item of missing) {
    lines.push(`  • ${item.what}`);
    for (const line of item.detail) lines.push(`      ${line}`);
    lines.push('');
  }
  lines.push('See CONTRIBUTING.md → Development setup for the full layout.');
  lines.push('');

  // Drop the stack. It would point at whichever check ran last rather than at
  // anything the reader can act on, and a frame naming `riot` under a message
  // about `conformance` is worse than no frame at all.
  const failure = new Error(lines.join('\n'));
  failure.stack = failure.message;
  throw failure;
}
