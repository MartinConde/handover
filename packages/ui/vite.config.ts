import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Output lands in the integration's dist. Its manifest is inlined into the site's Worker so the
// admin shell and Canvas documents can select an entry without making the other one execute.
export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  // Tests run in jsdom, so svelte must resolve to its browser build there but not in the build.
  ...(mode === 'test' ? { resolve: { conditions: ['browser'] } } : {}),
  test: { environment: 'jsdom', setupFiles: ['vitest.setup.ts'] },
  build: {
    outDir: '../astro/dist/ui',
    emptyOutDir: true,
    // A top-level name is intentional: package archives omit Vite's default hidden `.vite`
    // directory, while the Astro integration must read this manifest after installation.
    manifest: 'manifest.json',
    rolldownOptions: {
      preserveEntrySignatures: 'exports-only',
      input: {
        admin: resolve(import.meta.dirname, 'src/main.ts'),
        canvas: resolve(import.meta.dirname, 'src/canvas.ts'),
      },
      output: {
        codeSplitting: true,
        entryFileNames: '[name]-[hash].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: '[name]-[hash][extname]',
      },
    },
  },
}));
