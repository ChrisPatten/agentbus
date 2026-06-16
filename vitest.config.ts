import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Keep vitest's defaults (node_modules, dist, etc.) and also ignore the
    // `.claude/` agent working directory — stray git worktrees created there
    // otherwise get scanned and inflate the test run with duplicate copies.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
