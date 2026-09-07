import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Output lands in the integration's dist; flat hashed names are what routes/admin.ts serves.
export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  // Tests run in jsdom, so svelte must resolve to its browser build there but not in the build.
  ...(mode === 'test' ? { resolve: { conditions: ['browser'] } } : {}),
  test: { environment: 'jsdom', setupFiles: ['vitest.setup.ts'] },
  build: {
    outDir: '../astro/dist/ui',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/main.ts',
      output: { entryFileNames: '[name]-[hash].js', assetFileNames: '[name]-[hash][extname]' },
    },
  },
}));
