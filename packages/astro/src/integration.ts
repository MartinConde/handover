import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  mediaUsesFrom,
  type SitemapSite,
  schemaVersionError,
  staleFrom,
  templatesFrom,
  textsFrom,
} from '@handover/core';
import type { AstroIntegration } from 'astro';
import type { ViteDevServer } from 'vite';
import {
  buildIndex,
  contentErrors,
  contentFiles,
  emitRedirects,
  emitSitemap,
  i18nErrors,
  inlineScripts,
} from './build-checks.js';
import { loadersModule, uiAssetsModule, uiBuildOptions, uiDir } from './build-modules.js';
import { entryForm, type HandoverConfig } from './config.js';

export const NO_ADAPTER_MESSAGE =
  'astro-handover needs an SSR adapter: add `adapter: cloudflare()` from `@astrojs/cloudflare` to astro.config.';

const VIRTUAL_CONFIG = 'virtual:handover/config';
const VIRTUAL_UI = 'virtual:handover/ui';
const VIRTUAL_INDEX = 'virtual:handover/index';
const VIRTUAL_LOADERS = 'virtual:handover/loaders';

/** The Worker gets the same file through `virtual:handover/config`; this copy is for the build. */
export default function handover(cms: HandoverConfig): AstroIntegration {
  const titleFields = Object.fromEntries(
    Object.entries(cms.collections).flatMap(([name, c]) =>
      c.titleField ? [[name, c.titleField]] : [],
    ),
  );
  const screens = Object.keys(cms.admin?.screens ?? {}).length ? cms.admin?.screens : undefined;
  let root: URL;
  let clientDir: URL;
  let closeUi: (() => Promise<void>) | undefined;
  let crawl: SitemapSite | undefined;
  let slash = true;
  return {
    name: 'astro-handover',
    hooks: {
      'astro:config:done': async ({ config, injectTypes }) => {
        // A site's own endpoint under /admin/api/ reads the session the middleware set.
        injectTypes({
          filename: 'locals.d.ts',
          content:
            "declare namespace App {\n  interface Locals {\n    handover?: import('astro-handover').Session;\n  }\n}\n",
        });
        root = config.root;
        clientDir = config.build.client;
        // A sitemap of URLs the asset server redirects is one more hop per page.
        slash =
          config.trailingSlash === 'always' ||
          (config.trailingSlash !== 'never' && config.build.format === 'directory');
        crawl = config.site
          ? {
              i18n: cms.i18n,
              collections: cms.collections,
              base: String(config.site),
              slash,
            }
          : undefined;
        const errors = await contentErrors(root, cms.globals, cms.i18n.defaultLocale);
        if (errors.length) throw new Error(`\n${errors.join('\n')}`);
      },
      // A migrations/ behind the package's tables is caught here, not by the first query.
      'astro:build:start': async ({ logger }) => {
        const marker = await readFile(new URL('migrations/handover.json', root), 'utf8').catch(
          () => undefined,
        );
        const error = schemaVersionError(marker);
        if (error) throw new Error(error);
        if (!screens) return;
        // Finished before the site's own build starts, so `virtual:handover/ui` reads the output.
        const { build } = await import('vite');
        logger.info("Building the admin with this site's screens");
        await build(await uiBuildOptions(root, screens)).catch((cause: Error) => {
          throw new Error(
            `the admin could not be built with this site's screens:\n${cause.message}`,
            { cause },
          );
        });
      },
      // No HMR: the screen is rebuilt into the same bundle and the browser is reloaded by hand.
      'astro:server:setup': async ({ server, logger }) => {
        if (!screens) return;
        const { build } = await import('vite');
        const options = await uiBuildOptions(root, screens);
        const built = await build({ ...options, build: { ...options.build, watch: {} } });
        const watcher = built as Extract<typeof built, { close: () => Promise<void> }>;
        closeUi = () => watcher.close();
        // The admin has to be on disk before the first request reads `virtual:handover/ui`.
        await new Promise<void>((ready) => {
          watcher.on('event', (event) => {
            if (event.code === 'ERROR')
              logger.error(
                `the admin could not be built with this site's screens:\n${event.error.message}`,
              );
            if (event.code !== 'END') return;
            const mod = server.moduleGraph.getModuleById(`\0${VIRTUAL_UI}`);
            if (mod) server.moduleGraph.invalidateModule(mod);
            ready();
          });
        });
      },
      // A watcher left running would keep writing over the next one's output.
      'astro:server:done': async () => {
        await closeUi?.();
        closeUi = undefined;
      },
      'astro:build:done': async ({ logger }) => {
        const n = await emitRedirects(root, clientDir, slash, cms.i18n.base);
        if (n) logger.info(`Wrote ${n} redirect${n === 1 ? '' : 's'} to _redirects`);
        if (cms.sitemap === false) return;
        if (!crawl)
          logger.warn(
            "No sitemap: astro.config.mjs has no `site`, so there is no address to write one in. Add site: 'https://example.com'.",
          );
        logger.info(`Wrote ${(await emitSitemap(root, clientDir, crawl)).join(', ')}`);
      },
      'astro:config:setup': ({ config, logger, injectRoute, addMiddleware, updateConfig }) => {
        if (!config.adapter) throw new Error(NO_ADAPTER_MESSAGE);
        const drift = i18nErrors(cms.i18n, config.i18n, config.base);
        if (drift.length) throw new Error(`\n${drift.join('\n')}`);
        // `defineConfig` runs in the Worker too, where there is no filesystem to ask.
        const missing = Object.entries(cms.admin?.screens ?? {})
          .filter(([, screen]) => !existsSync(new URL(screen.component, config.root)))
          .map(
            ([key, screen]) =>
              `cms.config.ts › admin.screens.${key}.component: ${JSON.stringify(screen.component)} does not exist — write the component, or drop the key`,
          );
        if (missing.length) throw new Error(`\n${missing.join('\n')}`);
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
        // Read at build so nothing downstream can turn preview on; `0` and `false` are no.
        const flag = process.env.PREVIEW_ENABLED;
        const preview = flag !== undefined && !['', '0', 'false'].includes(flag);
        if (preview)
          injectRoute({
            pattern: '/_preview/[...path]',
            entrypoint: new URL('../components/Preview.astro', import.meta.url),
            prerender: false,
          });
        addMiddleware({ order: 'pre', entrypoint: new URL('./middleware.js', import.meta.url) });

        // The site's own cms.config.ts, so the Worker holds the real Zod objects.
        const cmsConfig = fileURLToPath(new URL('./cms.config.ts', config.root));
        const contentDir = fileURLToPath(new URL('src/content/', config.root));
        updateConfig({
          vite: {
            // Under node_modules Vite skips core's CommonJS deps: "module is not defined".
            ssr: { optimizeDeps: { include: ['astro-handover > @handover/core'] } },
            plugins: [
              {
                name: 'handover-config',
                resolveId: (id) => (id === VIRTUAL_CONFIG ? cmsConfig : undefined),
              },
              // Bundled, not a static asset, which would be a public list of every title.
              {
                name: 'handover-index',
                resolveId: (id) => (id === VIRTUAL_INDEX ? `\0${VIRTUAL_INDEX}` : undefined),
                load: async (id) => {
                  if (id !== `\0${VIRTUAL_INDEX}`) return undefined;
                  // One immutable snapshot per load keeps dev invalidation explicit and makes every
                  // generated view describe the same filesystem state.
                  const files = await contentFiles(config.root);
                  const index = await buildIndex(files, titleFields);
                  // Read here so the admin never lists or reads the repository per page load.
                  const templates = templatesFrom(files);
                  const uses = mediaUsesFrom(files);
                  const formFor = (collection: string, name: string) =>
                    entryForm(cms, collection, name);
                  const stale = await staleFrom(cms.i18n, files, formFor);
                  const texts = textsFrom(cms.i18n, files, formFor);
                  const scripts = await inlineScripts(config.root);
                  return `export default JSON.parse(${JSON.stringify(JSON.stringify(index))});
export const preview = ${preview};
export const site = ${JSON.stringify(String(config.site ?? '').replace(/\/$/, ''))};
export const templates = JSON.parse(${JSON.stringify(JSON.stringify(templates))});
export const uses = JSON.parse(${JSON.stringify(JSON.stringify(uses))});
export const stale = JSON.parse(${JSON.stringify(JSON.stringify(stale))});
export const texts = JSON.parse(${JSON.stringify(JSON.stringify(texts))});
export const scripts = ${JSON.stringify(scripts)};`;
                },
                configureServer(server: ViteDevServer) {
                  server.watcher.on('all', (_event, file) => {
                    if (!file.includes(contentDir)) return;
                    const mod = server.moduleGraph.getModuleById(`\0${VIRTUAL_INDEX}`);
                    if (mod) server.moduleGraph.invalidateModule(mod);
                  });
                },
              },
              {
                name: 'handover-ui',
                resolveId: (id) => (id === VIRTUAL_UI ? `\0${VIRTUAL_UI}` : undefined),
                load: (id) =>
                  id === `\0${VIRTUAL_UI}`
                    ? uiAssetsModule(fileURLToPath(uiDir(config.root, screens)))
                    : undefined,
              },
              // Preview calls the page's own loader and renders the component it names.
              {
                name: 'handover-loaders',
                resolveId: (id) => (id === VIRTUAL_LOADERS ? `\0${VIRTUAL_LOADERS}` : undefined),
                load: (id) =>
                  id === `\0${VIRTUAL_LOADERS}`
                    ? loadersModule(config.root, cms.collections)
                    : undefined,
              },
            ],
          },
        });
      },
    },
  };
}
