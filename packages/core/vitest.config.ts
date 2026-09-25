import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude:
      process.env.HANDOVER_LIVE_GIT_TESTS === '1'
        ? configDefaults.exclude
        : [...configDefaults.exclude, 'src/publishing/git.integration.test.ts'],
  },
});
