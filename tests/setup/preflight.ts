/**
 * Fails the run once, with everything that is missing, instead of letting the
 * suite fail hundreds of times for reasons that have nothing to do with the
 * code under test.
 *
 * The suite has four prerequisites beyond `npm ci`: a current `dist/`, a
 * `conformance` fixture checkout, a `spec` checkout carrying the CAP advisory
 * example patches, and Apache Jena's `riot` on PATH. CI satisfies all four as
 * separate workflow steps, so CI never sees what a
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
import {
  ADVISORY_EXAMPLES_DIR,
  ADVISORY_EXAMPLE_FILES,
  SPEC_CANDIDATES,
  SPEC_ROOT,
} from '../helpers/spec.js';

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

function checkSpec(): MissingPrerequisite | undefined {
  const absent = ADVISORY_EXAMPLE_FILES.filter(
    (f) => !fs.existsSync(path.join(ADVISORY_EXAMPLES_DIR, f)),
  );
  if (absent.length === 0) return undefined;
  const parent = path.dirname(SPEC_CANDIDATES[0]);
  const found = fs.existsSync(SPEC_ROOT);
  const detail = found
    ? [
        `Found a spec checkout at ${SPEC_ROOT}, but it lacks:`,
        ...absent.map((f) => `  ontologies/advisory/v1-draft/examples/${f}`),
        'The CAP advisory suites read these example patches.',
        'Fix: update that checkout (git pull on main),',
        '  or set CASCADE_SPEC_DIR to a checkout that has them.',
      ]
    : [
        'Searched:',
        ...(process.env.CASCADE_SPEC_DIR
          ? [`  CASCADE_SPEC_DIR=${SPEC_ROOT}`]
          : SPEC_CANDIDATES.map((c) => `  ${c}`)),
        'The CAP advisory suites read example patches from it.',
        'Fix: clone it beside this repository:',
        `  git clone https://github.com/the-cascade-protocol/spec.git ${path.join(parent, 'spec')}`,
        'Or: set CASCADE_SPEC_DIR to an existing checkout.',
      ];
  const what = found
    ? 'the `spec` checkout lacks the CAP advisory example patches'
    : 'the `spec` checkout was not found';
  return { what, detail };
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
  const missing = [checkBuild(), checkConformance(), checkSpec(), checkRiot()].filter(
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
