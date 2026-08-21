import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Output lands in the integration's dist so astro-handover ships the SPA pre-built;
// flat hashed names are what routes/admin.ts serves under /admin/_assets/.
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: '../astro/dist/ui',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/main.ts',
      output: { entryFileNames: '[name]-[hash].js', assetFileNames: '[name]-[hash][extname]' },
    },
  },
});
