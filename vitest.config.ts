import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Keep vitest's defaults (node_modules, etc.) and also ignore:
    //   - `dist/**` — compiled build output (incl. *.test.js); vitest 4's
    //     defaults do NOT exclude it, so a stray `npm run build` would otherwise
    //     run stale duplicate tests against the compiled JS.
    //   - `.claude/**` — the agent working directory; stray git worktrees created
    //     there otherwise get scanned and inflate the test run with duplicates.
    exclude: [...configDefaults.exclude, 'dist/**', '.claude/**'],
  },
});
