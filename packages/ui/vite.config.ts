import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Output lands in the integration's dist so astro-handover ships the SPA pre-built;
// flat hashed names are what routes/admin.ts serves under /admin/_assets/.
export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  // Tests mount components in jsdom, so svelte must resolve to its browser build there;
  // leave the build's default conditions alone or the bundle gets the server build too.
  ...(mode === 'test' ? { resolve: { conditions: ['browser'] } } : {}),
  test: { environment: 'jsdom' },
  build: {
    outDir: '../astro/dist/ui',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/main.ts',
      output: { entryFileNames: '[name]-[hash].js', assetFileNames: '[name]-[hash][extname]' },
    },
  },
}));
