/**
 * Single resolver for the `spec` checkout, for suites that read fixtures
 * authored there (today: the CAP advisory example patches).
 *
 * Same layout and resolution order as `conformance.ts`, and CI reproduces it by
 * checking `spec` out beside this repository:
 *
 *   1. `CASCADE_SPEC_DIR`, for a checkout parked anywhere else (a spec
 *      worktree on a feature branch, say). `scripts/check-shapes-drift.mjs`
 *      honours the same variable.
 *   2. A sibling of this checkout.
 *   3. A sibling of the *main* checkout, when this is a git worktree.
 *
 * A missing checkout is a failed prerequisite, not a skip: see
 * `tests/setup/preflight.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, mainCheckoutOf } from './conformance.js';

/** Every location searched for the checkout, in order, for error messages. */
export const SPEC_CANDIDATES: readonly string[] = (() => {
  const found = [path.resolve(REPO_ROOT, '../spec')];
  const main = mainCheckoutOf(REPO_ROOT);
  if (main) found.push(path.resolve(main, '../spec'));
  return found;
})();

/** Root of the spec checkout. May not exist; see the preflight check. */
export const SPEC_ROOT: string = process.env.CASCADE_SPEC_DIR
  ? path.resolve(process.env.CASCADE_SPEC_DIR)
  : (SPEC_CANDIDATES.find((c) => fs.existsSync(c)) ?? SPEC_CANDIDATES[0]);

/** Absolute path to something inside the spec checkout. */
export function specPath(...segments: string[]): string {
  return path.resolve(SPEC_ROOT, ...segments);
}

/** The CAP advisory example patches (`*.ldpatch`) the advisory suites read. */
export const ADVISORY_EXAMPLES_DIR: string = specPath(
  'ontologies',
  'advisory',
  'v1-draft',
  'examples',
);

/** The example files the advisory suites depend on, checked by preflight. */
export const ADVISORY_EXAMPLE_FILES: readonly string[] = [
  'example-brca2-reclassification.ldpatch',
  'example-cpic-cyp2c19-warfarin.ldpatch',
];
