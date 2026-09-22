import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { uiBuildConfig } from './build.js';

// Output lands in the integration's dist. Its manifest is inlined into the site's Worker so the
// admin shell and Canvas documents can select an entry without making the other one execute.
export default defineConfig(({ mode }) => {
  const config = uiBuildConfig({ outDir: resolve(import.meta.dirname, '../astro/dist/ui') });
  return {
    ...config,
    // Tests run in jsdom, so svelte must resolve to its browser build there but not in the build.
    ...(mode === 'test' ? { resolve: { ...config.resolve, conditions: ['browser'] } } : {}),
    test: { environment: 'jsdom', setupFiles: ['vitest.setup.ts'] },
  };
});
