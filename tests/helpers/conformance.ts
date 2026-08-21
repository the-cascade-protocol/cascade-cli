/**
 * Single resolver for the `conformance` fixture checkout.
 *
 * Fixtures live in a separate repository (the-cascade-protocol/conformance)
 * that is expected to sit beside this one, and CI reproduces that layout.
 * Resolution order:
 *
 *   1. `CASCADE_CONFORMANCE_DIR`, for a checkout parked anywhere else — a
 *      conformance worktree on a feature branch, say, when the oracle for a
 *      fixture is not on `main` yet.
 *   2. A sibling of this checkout.
 *   3. A sibling of the *main* checkout, when this is a git worktree.
 *
 * Step 3 is the one worth explaining. A worktree under `.claude/worktrees/`
 * has no sibling `conformance` of its own, so resolving only against the
 * worktree root looks for fixtures inside `.claude/worktrees/` and misses a
 * checkout that was cloned exactly as documented. Every suite went through
 * `path.resolve(__dirname, '../../conformance/...')` before this helper
 * existed, which is why working in a worktree used to mean symlinking the
 * fixtures into place by hand.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Root of this checkout — the worktree's own root when run from a worktree. */
export const REPO_ROOT = path.resolve(HELPERS_DIR, '../..');

/**
 * Root of the main checkout when `root` is a git worktree, else undefined.
 * A worktree's `.git` is a file holding `gitdir: <main>/.git/worktrees/<name>`.
 */
function mainCheckoutOf(root: string): string | undefined {
  const dotGit = path.join(root, '.git');
  let pointer: string;
  try {
    if (!fs.statSync(dotGit).isFile()) return undefined;
    pointer = fs.readFileSync(dotGit, 'utf-8');
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return undefined;
  const gitDir = path.resolve(root, match[1].trim());
  const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const cut = gitDir.lastIndexOf(marker);
  return cut === -1 ? undefined : gitDir.slice(0, cut);
}

/** Every location searched for the fixtures, in order, for error messages. */
export const CONFORMANCE_CANDIDATES: readonly string[] = (() => {
  const found = [path.resolve(REPO_ROOT, '../conformance')];
  const main = mainCheckoutOf(REPO_ROOT);
  if (main) found.push(path.resolve(main, '../conformance'));
  return found;
})();

/** Root of the conformance checkout. May not exist; see `conformanceAvailable`. */
export const CONFORMANCE_ROOT: string = process.env.CASCADE_CONFORMANCE_DIR
  ? path.resolve(process.env.CASCADE_CONFORMANCE_DIR)
  : (CONFORMANCE_CANDIDATES.find((c) => fs.existsSync(c)) ??
    CONFORMANCE_CANDIDATES[0]);

/** Absolute path to something inside the conformance checkout. */
export function conformancePath(...segments: string[]): string {
  return path.resolve(CONFORMANCE_ROOT, ...segments);
}

export function conformanceAvailable(): boolean {
  return fs.existsSync(CONFORMANCE_ROOT);
}
