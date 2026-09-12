import { execFile } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  type ContentFile,
  type ContentIndex,
  contentPathErrors,
  type Form,
  formOf,
  indexFrom,
  type MediaUses,
  mediaUsesFrom,
  modifiedFrom,
  parseEntry,
  redirectsText,
  refErrors,
  robotsText,
  type SitemapSite,
  schemaVersionError,
  sitemapFrom,
  sitemapIndexXml,
  sitemapXml,
  staleFrom,
  type Template,
  type TitleFields,
  templatesFrom,
  timestampErrors,
} from '@handover/core';
import type { AstroIntegration } from 'astro';
import type { ViteDevServer } from 'vite';
import { formSchema, type HandoverConfig, redirects } from './config.js';

export const NO_ADAPTER_MESSAGE =
  'astro-handover needs an SSR adapter: add `adapter: cloudflare()` from `@astrojs/cloudflare` to astro.config.';

const VIRTUAL_CONFIG = 'virtual:handover/config';
const VIRTUAL_UI = 'virtual:handover/ui';
const VIRTUAL_INDEX = 'virtual:handover/index';
const VIRTUAL_LOADERS = 'virtual:handover/loaders';

/** The one place the package reads the site's `src/`: preview calls the page's own loader. */
export function loadersModule(root: URL, collections: HandoverConfig['collections']): string {
  const names = [...new Set(Object.values(collections).flatMap((c) => (c.load ? [c.load] : [])))];
  const at = (name: string) => JSON.stringify(fileURLToPath(new URL(`src/loaders/${name}`, root)));
  return [
    ...names.map((name, i) => `import * as m${i} from ${at(name)};`),
    `export default { ${names.map((name, i) => `${JSON.stringify(name)}: m${i}`).join(', ')} };`,
  ].join('\n');
}

interface UiBuildChunk {
  file: string;
  name?: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
}

interface UiBuildManifest {
  [source: string]: UiBuildChunk;
}

async function uiAssetNames(dir: string, at = ''): Promise<string[]> {
  const names: string[] = [];
  for (const item of await readdir(join(dir, at), { withFileTypes: true })) {
    const name = at ? `${at}/${item.name}` : item.name;
    if (item.isDirectory()) {
      if (name !== '.vite') names.push(...(await uiAssetNames(dir, name)));
    } else if (/\.(js|css)$/.test(name)) names.push(name);
  }
  return names;
}

// Inlined into the Worker bundle: a Worker has no filesystem. Keep every JS/CSS output available
// to the asset route, but expose entry closures separately so a document loads only its own entry.
export async function uiAssetsModule(dir: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(dir, 'manifest.json'), 'utf8'),
  ) as UiBuildManifest;
  const names = (await uiAssetNames(dir)).sort();
  const files = await Promise.all(
    names.map(async (n) => [n, await readFile(join(dir, n), 'utf8')]),
  );
  const contents = Object.fromEntries(files) as Record<string, string>;

  for (const [source, chunk] of Object.entries(manifest)) {
    if (/\.(js|css)$/.test(chunk.file) && contents[chunk.file] === undefined)
      throw new Error(`UI manifest output is missing ${chunk.file} (${source})`);
    for (const css of chunk.css ?? [])
      if (contents[css] === undefined)
        throw new Error(`UI manifest stylesheet is missing ${css} (${source})`);
    for (const imported of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])])
      if (!manifest[imported])
        throw new Error(`UI manifest import is missing ${imported} (${source})`);
  }

  const stylesFor = (source: string, seen = new Set<string>()): string[] => {
    if (seen.has(source)) return [];
    seen.add(source);
    const chunk = manifest[source];
    if (!chunk) return [];
    return [
      ...(chunk.css ?? []),
      ...(chunk.imports ?? []).flatMap((imported) => stylesFor(imported, seen)),
    ];
  };
  const entries = Object.fromEntries(
    Object.entries(manifest)
      .filter(([, chunk]) => chunk.isEntry && chunk.name)
      .map(([source, chunk]) => [
        chunk.name as string,
        { script: chunk.file, styles: [...new Set(stylesFor(source))] },
      ]),
  );
  return `export default ${JSON.stringify({ entries, files: contents })};`;
}

// The adapter's own hook runs after this one and appends Astro's redirects to the same file.
export async function emitRedirects(root: URL, clientDir: URL, slash: boolean): Promise<number> {
  const path = 'src/content/redirects.yaml';
  const source = await readFile(new URL(path, root), 'utf8').catch(() => undefined);
  if (source === undefined) return 0;
  const parsed = redirects.safeParse(parseEntry('default', source));
  if (!parsed.success) {
    const at = (p: PropertyKey[]) =>
      p
        .map((k, i) => (typeof k === 'number' ? `[${k}]` : i ? `.${String(k)}` : String(k)))
        .join('');
    throw new Error(
      parsed.error.issues.map((i) => `${path} › ${at(i.path)}: ${i.message}`).join('\n'),
    );
  }
  await mkdir(clientDir, { recursive: true });
  await appendFile(
    new URL('_redirects', clientDir),
    redirectsText('default', parsed.data.rules, slash),
  );
  return parsed.data.rules.length;
}

/** Static files so a crawler never wakes the Worker; a `public/robots.txt` is left as it is. */
export async function emitSitemap(
  root: URL,
  clientDir: URL,
  site: SitemapSite | undefined,
): Promise<string[]> {
  await mkdir(clientDir, { recursive: true });
  const written: string[] = [];
  // The files sit beside the pages, so under a `base` they are served under it too.
  const at = (name: string) =>
    site ? new URL(`${site.i18n.base ?? ''}/${name}`, site.base).href : undefined;
  if (site) {
    const pages = sitemapFrom('default', await contentFiles(root), site, await modifiedAt(root));
    for (const locale of site.i18n.locales) {
      const name = `sitemap-${locale}.xml`;
      await writeFile(new URL(name, clientDir), sitemapXml('default', pages[locale] ?? []));
      written.push(name);
    }
    const index = new URL('sitemap-index.xml', clientDir);
    await writeFile(
      index,
      sitemapIndexXml(
        'default',
        written.map((name) => at(name) ?? name),
      ),
    );
    written.push('sitemap-index.xml');
  }
  const own = await readFile(new URL('robots.txt', clientDir), 'utf8').catch(() => undefined);
  if (own === undefined) {
    await writeFile(
      new URL('robots.txt', clientDir),
      robotsText('default', at('sitemap-index.xml')),
    );
    written.push('robots.txt');
  }
  return written;
}

/** A shallow clone gives no dates rather than wrong ones: its one commit "adds" every file. */
export async function modifiedAt(root: URL): Promise<Map<string, string>> {
  const git = (...args: string[]) =>
    promisify(execFile)('git', args, {
      cwd: fileURLToPath(root),
      maxBuffer: 64 * 1024 * 1024,
    }).then((r) => r.stdout);
  const shallow = await git('rev-parse', '--is-shallow-repository').catch(() => 'true');
  if (shallow.trim() === 'true') return new Map();
  const log = await git('log', '--format=%cI', '--name-only', '--relative', '--', 'src/content');
  return modifiedFrom('default', log);
}

/** Every `.yaml` under `src/content/`, so a misplaced file is named by the build, not missed. */
export async function contentFiles(root: URL): Promise<ContentFile[]> {
  const dir = fileURLToPath(new URL('src/content/', root));
  const found = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return Promise.all(
    found
      .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
      .map(async (e) => {
        const path = `src/content/${relative(dir, join(e.parentPath, e.name)).split(sep).join('/')}`;
        return { path, contents: await readFile(new URL(path, root), 'utf8') };
      }),
  );
}

/** Runs at `astro:config:done`: Astro's content sync would otherwise reach a bad file first. */
export async function contentErrors(
  root: URL,
  globals: Iterable<string> = [],
  defaultLocale?: string,
): Promise<string[]> {
  const files = await contentFiles(root);
  const paths = new Set(files.map((f) => f.path));
  return [
    ...contentPathErrors('default', paths),
    ...files.flatMap((f) => [
      ...timestampErrors('default', f.path, f.contents),
      ...refErrors('default', f.path, f.contents, globals),
    ]),
    // A declared global with no file is a Site settings card that opens nothing.
    ...(defaultLocale === undefined
      ? []
      : [...globals]
          .map((key) => [key, `src/content/globals/${defaultLocale}/${key}.yaml`] as const)
          .filter(([, path]) => !paths.has(path))
          .map(
            ([key, path]) =>
              `cms.config.ts › globals.${key}: declared, but ${path} does not exist — write the file the default language reads, or drop the key`,
          )),
  ];
}

/** Titles are read at build because git is slow to list. */
export async function buildIndex(root: URL, titleFields: TitleFields = {}): Promise<ContentIndex> {
  const files = await contentFiles(root);
  const errors = contentPathErrors(
    'default',
    files.map((f) => f.path),
  );
  if (errors.length) throw new Error(errors.join('\n'));
  return indexFrom('default', files, titleFields);
}

/** Read at build with everything under `src/content/`, so the admin needs no git listing. */
export async function buildTemplates(root: URL): Promise<Record<string, Template[]>> {
  return templatesFrom('default', await contentFiles(root));
}

/** Read at build so the library never reads the repository per page load. */
export async function buildMediaUses(root: URL): Promise<MediaUses> {
  return mediaUsesFrom('default', await contentFiles(root));
}

/** Built the same way in the build and the Worker; a localized `slug` stays out of the hash. */
export function entryForm(cms: HandoverConfig, collection: string, name: string): Form | undefined {
  const schema =
    (collection === 'globals' ? cms.globals?.[name] : undefined) ??
    cms.collections[collection]?.schema;
  if (!schema) return undefined;
  const form = formOf('default', formSchema(schema));
  if (!cms.collections[collection]?.localizedSlugs) return form;
  return { ...form, fields: form.fields.filter((f) => f.path[0] !== 'slug') };
}

/** Taken at build, where the files are already on disk, so the dashboard does not read git. */
export async function buildStale(
  root: URL,
  cms: HandoverConfig,
): Promise<Record<string, string[]>> {
  return staleFrom('default', await contentFiles(root), (collection, name) =>
    entryForm(cms, collection, name),
  );
}

// A locale is either the folder name or `{ path, codes }`, where the path is the folder.
type AstroI18n = {
  locales?: unknown;
  defaultLocale?: unknown;
  routing?: unknown;
};

/** A drift would put a German file under a folder Astro never builds, silently. */
function i18nErrors(
  cms: HandoverConfig['i18n'],
  astro: AstroI18n | undefined,
  base: unknown = '/',
): string[] {
  const at = (key: string) => `cms.config.ts › i18n.${key}: `;
  const is = (them: unknown, key: string) => `is not astro.config.mjs's i18n.${key} ${them}`;
  // Astro spells its base with or without the slash by `trailingSlash`; ours is written bare.
  const theirs = String(base ?? '/').replace(/\/+$/, '') || '/';
  const errors: string[] = [];
  if ((cms.base ?? '/') !== theirs)
    errors.push(
      `${at('base')}${cms.base === undefined ? 'none' : JSON.stringify(cms.base)} is not astro.config.mjs's base ${JSON.stringify(theirs)}; the two must match exactly`,
    );
  if (!astro)
    return [
      ...errors,
      `astro.config.mjs has no i18n block: cms.config.ts declares ${JSON.stringify(cms.locales)}, so astro.config.mjs needs i18n: { locales: ${JSON.stringify(cms.locales)}, defaultLocale: ${JSON.stringify(cms.defaultLocale)} }. The two must match exactly.`,
    ];
  const locales = (Array.isArray(astro.locales) ? astro.locales : []).map((l) =>
    typeof l === 'string' ? l : (l as { path?: string }).path,
  );
  if (JSON.stringify(cms.locales) !== JSON.stringify(locales))
    errors.push(
      `${at('locales')}${JSON.stringify(cms.locales)} ${is(JSON.stringify(locales), 'locales')}; the two must match exactly, in order`,
    );
  if (cms.defaultLocale !== astro.defaultLocale)
    errors.push(
      `${at('defaultLocale')}${JSON.stringify(cms.defaultLocale)} ${is(JSON.stringify(astro.defaultLocale), 'defaultLocale')}; the two must match exactly`,
    );
  const routing = astro.routing as { prefixDefaultLocale?: boolean } | 'manual' | undefined;
  const prefix = (typeof routing === 'object' ? routing.prefixDefaultLocale : false) ?? false;
  if ((cms.prefixDefaultLocale ?? false) !== prefix)
    errors.push(
      `${at('prefixDefaultLocale')}${cms.prefixDefaultLocale ?? false} ${is(prefix, 'routing.prefixDefaultLocale')}; the two must match exactly`,
    );
  return errors;
}

/** The Worker gets the same file through `virtual:handover/config`; this copy is for the build. */
export default function handover(cms: HandoverConfig): AstroIntegration {
  const titleFields = Object.fromEntries(
    Object.entries(cms.collections).flatMap(([name, c]) =>
      c.titleField ? [[name, c.titleField]] : [],
    ),
  );
  let root: URL;
  let clientDir: URL;
  let crawl: SitemapSite | undefined;
  let slash = true;
  return {
    name: 'astro-handover',
    hooks: {
      'astro:config:done': async ({ config }) => {
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
        const errors = await contentErrors(
          root,
          Object.keys(cms.globals ?? {}),
          cms.i18n.defaultLocale,
        );
        if (errors.length) throw new Error(`\n${errors.join('\n')}`);
      },
      // A migrations/ behind the package's tables is caught here, not by the first query.
      'astro:build:start': async () => {
        const marker = await readFile(new URL('migrations/handover.json', root), 'utf8').catch(
          () => undefined,
        );
        const error = schemaVersionError(marker);
        if (error) throw new Error(error);
      },
      'astro:build:done': async ({ logger }) => {
        const n = await emitRedirects(root, clientDir, slash);
        if (n) logger.info(`Wrote ${n} redirect${n === 1 ? '' : 's'} to _redirects`);
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
                  const errors = contentPathErrors(
                    'default',
                    files.map((file) => file.path),
                  );
                  if (errors.length) throw new Error(errors.join('\n'));
                  const index = indexFrom('default', files, titleFields);
                  const templates = templatesFrom('default', files);
                  const uses = mediaUsesFrom('default', files);
                  const stale = await staleFrom('default', files, (collection, name) =>
                    entryForm(cms, collection, name),
                  );
                  return `export default JSON.parse(${JSON.stringify(JSON.stringify(index))});
export const preview = ${preview};
export const site = ${JSON.stringify(String(config.site ?? '').replace(/\/$/, ''))};
export const templates = JSON.parse(${JSON.stringify(JSON.stringify(templates))});
export const uses = JSON.parse(${JSON.stringify(JSON.stringify(uses))});
export const stale = JSON.parse(${JSON.stringify(JSON.stringify(stale))});`;
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
                    ? uiAssetsModule(fileURLToPath(new URL('./ui/', import.meta.url)))
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
