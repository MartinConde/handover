import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import type { z } from 'astro/zod';

export type { AstroContent, ContentEntry, ContentSource } from '@handover/core';
export { staticSource } from '@handover/core';

export interface HandoverConfig {
  collections: Record<string, { schema: z.ZodType }>;
}

export function defineConfig(config: HandoverConfig): HandoverConfig {
  return config;
}

export const NO_ADAPTER_MESSAGE =
  'astro-handover needs an SSR adapter: add `adapter: cloudflare()` from `@astrojs/cloudflare` to astro.config.';

const VIRTUAL_CONFIG = 'virtual:handover/config';
const VIRTUAL_UI = 'virtual:handover/ui';

// The pre-built SPA (packages/ui → dist/ui) is inlined into the Worker bundle because a
// Worker has no filesystem and the site's own build config must not know about it.
export async function uiAssetsModule(dir: string): Promise<string> {
  const names = (await readdir(dir)).filter((n) => /\.(js|css)$/.test(n)).sort();
  const files = await Promise.all(
    names.map(async (n) => [n, await readFile(join(dir, n), 'utf8')]),
  );
  return `export default ${JSON.stringify(Object.fromEntries(files))};`;
}

export default function handover(): AstroIntegration {
  return {
    name: 'astro-handover',
    hooks: {
      'astro:config:setup': ({ config, logger, injectRoute, updateConfig }) => {
        if (!config.adapter) throw new Error(NO_ADAPTER_MESSAGE);
        logger.info('astro-handover integration loaded');

        injectRoute({
          pattern: '/admin/[...path]',
          entrypoint: new URL('./routes/admin.js', import.meta.url),
          prerender: false,
        });
        injectRoute({
          pattern: '/admin/api/[...path]',
          entrypoint: new URL('./routes/api.js', import.meta.url),
          prerender: false,
        });

        // The site's own cms.config.ts, so the Worker holds the real Zod objects.
        const cmsConfig = fileURLToPath(new URL('./cms.config.ts', config.root));
        updateConfig({
          vite: {
            plugins: [
              {
                name: 'handover-config',
                resolveId: (id) => (id === VIRTUAL_CONFIG ? cmsConfig : undefined),
              },
              {
                name: 'handover-ui',
                resolveId: (id) => (id === VIRTUAL_UI ? `\0${VIRTUAL_UI}` : undefined),
                load: (id) =>
                  id === `\0${VIRTUAL_UI}`
                    ? uiAssetsModule(fileURLToPath(new URL('./ui/', import.meta.url)))
                    : undefined,
              },
            ],
          },
        });
      },
    },
  };
}
