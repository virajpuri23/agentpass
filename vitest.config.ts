import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Worker sessions check out their own worktrees under .claude/; never run their copies here.
    exclude: ['**/node_modules/**', '**/.claude/**', '**/demo-project/**', '**/.next/**'],
  },
});
