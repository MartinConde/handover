import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { InlineConfig, Plugin } from 'vite';

const VIRTUAL_SCREENS = 'virtual:handover/screens';

// A site's screens are compiled into the SPA by a second run of this build; the package's own
// build has none, so the map is empty and the shell renders no site routes.
function handoverScreens(screens?: string): Plugin {
  const resolved = `\0${VIRTUAL_SCREENS}`;
  return {
    name: 'handover-screens',
    resolveId: (id) => (id === VIRTUAL_SCREENS ? resolved : undefined),
    load: (id) => (id === resolved ? (screens ?? 'export default {}') : undefined),
  };
}

// Shared by the package build and the site-local rebuild when a site declares screens.
export function uiBuildConfig({
  outDir,
  screens,
}: {
  outDir: string;
  screens?: string;
}): InlineConfig {
  return {
    plugins: [svelte(), handoverScreens(screens)],
    // The bundle is served from /admin/_assets/, so preload URLs must resolve against the
    // importing module; a root base would point them at /chunks/ and 404.
    base: './',
    // A site that gets a second copy of svelte some other way would compile two runtimes into one
    // document; the site listing svelte itself is what normally keeps it to one.
    resolve: { dedupe: ['svelte'] },
    build: {
      outDir,
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
  };
}
