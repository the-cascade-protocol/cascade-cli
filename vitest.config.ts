import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude git worktrees (used for parallel agent development) from test discovery
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**'],
  },
});
