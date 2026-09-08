import node from '@astrojs/node';
import svelte from '@astrojs/svelte';
import { defineConfig } from 'astro/config';
import handover from 'astro-handover';
import cms from './cms.config.ts';

const cloudflareWorkersStub = {
  name: 'fixture-cloudflare-workers',
  enforce: 'pre',
  resolveId(id) {
    return id === 'cloudflare:workers' ? '\0fixture-cloudflare-workers' : undefined;
  },
  load(id) {
    return id === '\0fixture-cloudflare-workers' ? 'export const env = {};' : undefined;
  },
};

export default defineConfig({
  site: 'http://127.0.0.1:4329',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  session: false,
  i18n: {
    locales: ['en', 'de'],
    defaultLocale: 'en',
    routing: { prefixDefaultLocale: false },
  },
  integrations: [svelte(), handover(cms)],
  vite: {
    plugins: [cloudflareWorkersStub],
    resolve: { dedupe: ['astro', 'svelte', 'zod'] },
  },
});
