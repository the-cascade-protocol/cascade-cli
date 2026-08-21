import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude git worktrees (used for parallel agent development) from test discovery
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**'],
    // Report missing prerequisites once, up front, rather than as several
    // hundred unrelated-looking failures. See tests/setup/preflight.ts.
    globalSetup: ['./tests/setup/preflight.ts'],
  },
});
