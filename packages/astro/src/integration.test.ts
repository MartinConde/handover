import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseEntry, SCHEMA_VERSION } from '@handover/core';
import type { HookParameters } from 'astro';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { beforeEach, expect, test, vi } from 'vitest';
import handover, {
  buildIndex,
  contentErrors,
  contentFiles,
  emitRedirects,
  emitSitemap,
  loadersModule,
  modifiedAt,
  NO_ADAPTER_MESSAGE,
  screensModule,
  uiAssetsModule,
  uiDir,
} from './integration.js';

type Setup = HookParameters<'astro:config:setup'>;

// The flag is read off the environment, so the suite states it rather than inheriting a shell's.
beforeEach(() => {
  delete process.env.PREVIEW_ENABLED;
});

const EN = { locales: ['en'], defaultLocale: 'en' };

function runSetup(
  adapter: unknown,
  root = new URL('file:///site/'),
  cms: Parameters<typeof handover>[0] = { collections: {}, i18n: EN },
  astro: Record<string, unknown> = { i18n: { ...EN, routing: { prefixDefaultLocale: false } } },
) {
  const info = vi.fn();
  const injectRoute = vi.fn();
  const addMiddleware = vi.fn();
  const updateConfig = vi.fn();
  const setup = handover(cms).hooks['astro:config:setup'] as (o: Setup) => void;
  setup({
    config: { adapter, root, ...astro },
    logger: { info },
    injectRoute,
    addMiddleware,
    updateConfig,
  } as unknown as Setup);
  return { info, injectRoute, addMiddleware, updateConfig };
}

test('throws the documented message when no adapter is configured', () => {
  expect(() => runSetup(undefined)).toThrow(NO_ADAPTER_MESSAGE);
});

test('logs once an adapter is present', () => {
  const { info } = runSetup({ name: 'fake-adapter', hooks: {} });
  expect(info).toHaveBeenCalledWith('astro-handover integration loaded');
});

test('injects the admin shell and API routes as SSR', () => {
  const { injectRoute } = runSetup({ name: 'fake-adapter', hooks: {} });
  const routes = injectRoute.mock.calls.map(([r]) => [r.pattern, r.prerender]);
  expect(routes).toEqual([
    ['/admin/[...path]', false],
    ['/admin/api/[...path]', false],
  ]);
});

// A site that did not ask for preview has no such route at all, not one that answers 404.
test('the preview route is injected only where the build was told to', () => {
  const patterns = () =>
    runSetup({ name: 'fake-adapter', hooks: {} }).injectRoute.mock.calls.map(([r]) => r.pattern);
  expect(patterns()).not.toContain('/_preview/[...path]');
  process.env.PREVIEW_ENABLED = '1';
  expect(patterns()).toEqual(['/admin/[...path]', '/admin/api/[...path]', '/_preview/[...path]']);
});

test.each(['', '0', 'false'])('PREVIEW_ENABLED=%o is somebody saying no', (value) => {
  process.env.PREVIEW_ENABLED = value;
  const { injectRoute } = runSetup({ name: 'fake-adapter', hooks: {} });
  expect(injectRoute.mock.calls.map(([r]) => r.pattern)).not.toContain('/_preview/[...path]');
});

// The one place the package reaches into the site's own src/: preview calls the page's loader.
test('the loaders module imports each named loader once, from the site itself', () => {
  const schema = z.object({ title: z.string() });
  const source = loadersModule(new URL('file:///site/'), {
    listings: { schema, route: '/listings/[slug]', index: '/', load: 'listing' },
    pages: { schema, route: '/[slug]', load: 'listing' },
    samples: { schema },
  });

  expect(source).toBe(
    'import * as m0 from "/site/src/loaders/listing";\nexport default { "listing": m0 };',
  );
});

// A screen is a default export the shell mounts, where a loader is a module it calls into.
test('the screens module imports each screen from the site by its own path', () => {
  const source = screensModule(new URL('file:///site/'), {
    analytics: { component: './src/admin/Analytics.svelte', label: 'Analytics' },
    board: { component: './src/admin/Board.svelte', label: { en: 'Board', de: 'Tafel' } },
  });

  expect(source).toBe(
    'import s0 from "/site/src/admin/Analytics.svelte";\nimport s1 from "/site/src/admin/Board.svelte";\nexport default { "analytics": s0, "board": s1 };',
  );
});

// Nothing is rebuilt for a site with no screens: it inlines the bundle the package shipped.
test("the admin bundle is the package's own until a site declares a screen", () => {
  expect(uiDir(new URL('file:///site/'), undefined).href).toBe(
    new URL('./ui/', import.meta.url).href,
  );
  expect(uiDir(new URL('file:///site/'), {}).href).toBe(new URL('./ui/', import.meta.url).href);
});

test('a site with a screen inlines the admin its own build wrote', () => {
  const screens = { analytics: { component: './src/admin/Analytics.svelte', label: 'A' } };
  expect(uiDir(new URL('file:///site/'), screens).href).toBe('file:///site/.astro/handover/ui/');
});

test('registers the password-gate middleware before the routes', () => {
  const { addMiddleware } = runSetup({ name: 'fake-adapter', hooks: {} });
  expect(addMiddleware).toHaveBeenCalledWith({ order: 'pre', entrypoint: expect.any(URL) });
  expect(String(addMiddleware.mock.calls[0]?.[0].entrypoint)).toMatch(/\/middleware\.js$/);
});

// Installed from a registry the package is in node_modules, where the dev optimiser stops
// looking: without this entry every route answers `module is not defined`.
test('asks Vite to pre-bundle core for the SSR environment', () => {
  const { updateConfig } = runSetup({ name: 'fake-adapter', hooks: {} });
  expect(updateConfig.mock.calls[0]?.[0].vite.ssr).toEqual({
    optimizeDeps: { include: ['astro-handover > @handover/core'] },
  });
});

// `component` is a path into the site's own src/, so only the build can see whether it is there.
test('a screen naming a file the site does not have is refused at config time', () => {
  const cms = (component: string) => ({
    collections: {},
    i18n: EN,
    admin: { screens: { analytics: { component, label: 'Analytics' } } },
  });
  const root = new URL('./', import.meta.url);
  expect(() =>
    runSetup({ name: 'fake-adapter', hooks: {} }, root, cms('./src/admin/A.svelte')),
  ).toThrow(
    'cms.config.ts › admin.screens.analytics.component: "./src/admin/A.svelte" does not exist — write the component, or drop the key',
  );
  expect(() =>
    runSetup({ name: 'fake-adapter', hooks: {} }, root, cms('./index.test.ts')),
  ).not.toThrow();
});

const adapter = { name: 'fake-adapter', hooks: {} };
const drift = (cms: unknown, i18n?: unknown) =>
  runSetup(adapter, new URL('file:///site/'), cms as Parameters<typeof handover>[0], { i18n });

test('the documented message names both files when the default locale drifts', () => {
  expect(() =>
    drift(
      { collections: {}, i18n: { locales: ['en', 'de'], defaultLocale: 'de' } },
      {
        locales: ['en', 'de'],
        defaultLocale: 'en',
        routing: { prefixDefaultLocale: false },
      },
    ),
  ).toThrow(
    'cms.config.ts › i18n.defaultLocale: "de" is not astro.config.mjs\'s i18n.defaultLocale "en"; the two must match exactly',
  );
});

test('a base in astro.config.mjs that cms.config.ts does not declare is refused', () => {
  expect(() =>
    runSetup(
      adapter,
      new URL('file:///site/'),
      { collections: {}, i18n: EN },
      {
        i18n: { ...EN, routing: { prefixDefaultLocale: false } },
        base: '/site',
      },
    ),
  ).toThrow(
    'cms.config.ts › i18n.base: none is not astro.config.mjs\'s base "/site"; the two must match exactly',
  );
});

test('a different list of locales is refused', () => {
  expect(() =>
    drift(
      { collections: {}, i18n: { locales: ['en', 'de'], defaultLocale: 'en' } },
      {
        locales: ['en', 'fr'],
        defaultLocale: 'en',
        routing: { prefixDefaultLocale: false },
      },
    ),
  ).toThrow(
    'cms.config.ts › i18n.locales: ["en","de"] is not astro.config.mjs\'s i18n.locales ["en","fr"]; the two must match exactly, in order',
  );
});

test('a different prefixDefaultLocale is refused', () => {
  expect(() =>
    drift(
      { collections: {}, i18n: { ...EN, prefixDefaultLocale: true } },
      {
        ...EN,
        routing: { prefixDefaultLocale: false },
      },
    ),
  ).toThrow(/i18n\.prefixDefaultLocale: true is not astro\.config\.mjs's/);
});

test('an astro.config.mjs with no i18n at all is refused', () => {
  expect(() => drift({ collections: {}, i18n: EN })).toThrow(
    /astro\.config\.mjs has no i18n block/,
  );
});

test('a locale astro spells as a path with codes matches that path', () => {
  expect(() =>
    drift(
      { collections: {}, i18n: { locales: ['en', 'de'], defaultLocale: 'en' } },
      {
        locales: ['en', { path: 'de', codes: ['de', 'de-AT'] }],
        defaultLocale: 'en',
        routing: { prefixDefaultLocale: false },
      },
    ),
  ).not.toThrow();
});

test('virtual:handover/config resolves to the root cms.config.ts', () => {
  const { updateConfig } = runSetup({ name: 'fake-adapter', hooks: {} });
  const plugin = updateConfig.mock.calls[0]?.[0].vite.plugins[0];
  expect(plugin.resolveId('virtual:handover/config')).toBe('/site/cms.config.ts');
  expect(plugin.resolveId('something-else')).toBeUndefined();
});

test('virtual:handover/ui inlines entry-aware assets and every served chunk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'handover-ui-'));
  await mkdir(join(dir, 'chunks'), { recursive: true });
  await writeFile(join(dir, 'admin.js'), 'admin();');
  await writeFile(join(dir, 'admin.css'), 'admin{}');
  await writeFile(join(dir, 'canvas.js'), 'canvas();');
  await writeFile(join(dir, 'chunks/shared.js'), 'shared();');
  await writeFile(join(dir, 'chunks/shared.css'), 'shared{}');
  await writeFile(join(dir, 'chunks/rich-text.js'), 'editor();');
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      'src/admin.ts': {
        file: 'admin.js',
        name: 'admin',
        src: 'src/admin.ts',
        isEntry: true,
        imports: ['_shared'],
        css: ['admin.css'],
      },
      'src/canvas.ts': {
        file: 'canvas.js',
        name: 'canvas',
        src: 'src/canvas.ts',
        isEntry: true,
        imports: ['_shared'],
        dynamicImports: ['src/canvas/rich-text.ts'],
      },
      _shared: { file: 'chunks/shared.js', css: ['chunks/shared.css'] },
      'src/canvas/rich-text.ts': {
        file: 'chunks/rich-text.js',
        src: 'src/canvas/rich-text.ts',
        isDynamicEntry: true,
      },
      'admin.css': { file: 'admin.css', src: 'admin.css' },
    }),
  );
  const { updateConfig } = runSetup({ name: 'fake-adapter', hooks: {} });
  const plugin = updateConfig.mock.calls[0]?.[0].vite.plugins[2];
  expect(plugin.resolveId('virtual:handover/ui')).toBe('\0virtual:handover/ui');
  expect(plugin.resolveId('other')).toBeUndefined();
  expect(await plugin.load('other')).toBeUndefined();
  const source = await uiAssetsModule(dir);
  const built = (
    await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  ).default;
  expect(built.entries).toEqual({
    admin: { script: 'admin.js', styles: ['admin.css', 'chunks/shared.css'] },
    canvas: { script: 'canvas.js', styles: ['chunks/shared.css'] },
  });
  expect(built.files).toEqual({
    'admin.css': 'admin{}',
    'admin.js': 'admin();',
    'canvas.js': 'canvas();',
    'chunks/rich-text.js': 'editor();',
    'chunks/shared.css': 'shared{}',
    'chunks/shared.js': 'shared();',
  });
});

const fixture = new URL('../test/fixtures/basic/', import.meta.url);

test("emitRedirects appends every rule to the client dir, in the site's form", async () => {
  const client = new URL(`${await mkdtemp(join(tmpdir(), 'handover-client-'))}/`, 'file://');
  await writeFile(new URL('_redirects', client), '/a /b 301\n');
  expect(await emitRedirects(fixture, client, true)).toBe(2);
  expect(await readFile(new URL('_redirects', client), 'utf8')).toBe(
    '/a /b 301\n/listings/seaview-cottage /listings/seaview-cottage-devon/ 301\n/listings/seaview-cottage/ /listings/seaview-cottage-devon/ 301\n/brochure https://example.com/files/brochure.pdf 301\n/brochure/ https://example.com/files/brochure.pdf 301\n',
  );
});

test('emitRedirects writes nothing for a site without redirects.yaml', async () => {
  const client = new URL(`${await mkdtemp(join(tmpdir(), 'handover-client-'))}/`, 'file://');
  expect(await emitRedirects(new URL('file:///nowhere/'), client, true)).toBe(0);
  await expect(readFile(new URL('_redirects', client), 'utf8')).rejects.toThrow();
});

test('emitRedirects fails the build on a bad rule, naming the path', async () => {
  const root = new URL(`${await mkdtemp(join(tmpdir(), 'handover-site-'))}/`, 'file://');
  await mkdir(new URL('src/content/', root), { recursive: true });
  await writeFile(
    new URL('src/content/redirects.yaml', root),
    '_version: 1\nrules:\n  - _id: "aaaaaaaa"\n    from: "old"\n    to: "/new"\n    status: 301\n    reason: "manual"\n    createdAt: "2026-01-01T00:00:00Z"\n',
  );
  await expect(emitRedirects(root, root, true)).rejects.toThrow(
    'src/content/redirects.yaml › rules[0].from: a path starting with "/"',
  );
});

test('emitRedirects rejects a rule that could add output lines', async () => {
  const root = new URL(`${await mkdtemp(join(tmpdir(), 'handover-site-'))}/`, 'file://');
  await mkdir(new URL('src/content/', root), { recursive: true });
  await writeFile(
    new URL('src/content/redirects.yaml', root),
    '_version: 1\nrules:\n  - _id: "aaaaaaaa"\n    from: "/old\\n/shadow https://outside.example 302\\n/another"\n    to: "/new"\n    status: 301\n    reason: "manual"\n    createdAt: "2026-01-01T00:00:00Z"\n',
  );
  await expect(emitRedirects(root, root, true)).rejects.toThrow(
    'src/content/redirects.yaml › rules[0].from: a path without whitespace or control characters',
  );
  await expect(readFile(new URL('_redirects', root), 'utf8')).rejects.toThrow();
});

const crawl = {
  i18n: { locales: ['en', 'de'], defaultLocale: 'en' },
  collections: { listings: { route: '/listings/[slug]', index: '/' } },
  base: 'https://coastalhomes.example',
  slash: true,
};

const clientDir = async () =>
  new URL(`${await mkdtemp(join(tmpdir(), 'handover-client-'))}/`, 'file://');

test('emitSitemap writes one sitemap per language, an index and robots.txt', async () => {
  const client = await clientDir();
  expect(await emitSitemap(fixture, client, crawl)).toEqual([
    'sitemap-en.xml',
    'sitemap-de.xml',
    'sitemap-index.xml',
    'robots.txt',
  ]);
  const read = (name: string) => readFile(new URL(name, client), 'utf8');
  expect(await read('sitemap-en.xml')).toContain(
    '<loc>https://coastalhomes.example/listings/seaview-cottage/</loc>',
  );
  // The German index is a page the site serves; the English entry has no German file.
  expect(await read('sitemap-de.xml')).toContain('<loc>https://coastalhomes.example/de/</loc>');
  expect(await read('sitemap-de.xml')).not.toContain('seaview-cottage');
  expect(await read('sitemap-index.xml')).toContain(
    '<sitemap><loc>https://coastalhomes.example/sitemap-en.xml</loc></sitemap>',
  );
  expect(await read('robots.txt')).toContain(
    'Sitemap: https://coastalhomes.example/sitemap-index.xml',
  );
});

// Workers Builds and most CI clone at depth 1, where every file is "added" by the one commit.
test('a shallow clone dates nothing, where the full history dates every file', async () => {
  const full = await mkdtemp(join(tmpdir(), 'handover-git-'));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-08-30T10:00:00+02:00',
        GIT_COMMITTER_DATE: '2026-08-30T10:00:00+02:00',
      },
    });
  git(full, 'init', '-q');
  git(full, 'config', 'user.email', 'walk@example.com');
  git(full, 'config', 'user.name', 'Walk');
  await mkdir(join(full, 'src/content/pages/en'), { recursive: true });
  await writeFile(join(full, 'src/content/pages/en/about.yaml'), 'title: "About"\n');
  git(full, 'add', '.');
  git(full, 'commit', '-q', '-m', 'Add about');
  expect(await modifiedAt(new URL(`file://${full}/`))).toEqual(
    new Map([['src/content/pages/en/about.yaml', '2026-08-30T10:00:00+02:00']]),
  );
  const shallow = join(await mkdtemp(join(tmpdir(), 'handover-git-')), 'clone');
  git(tmpdir(), 'clone', '-q', '--depth', '1', `file://${full}`, shallow);
  expect(await modifiedAt(new URL(`file://${shallow}/`))).toEqual(new Map());
});

test('a site under a base path names its pages, its sitemaps and the robots line under it', async () => {
  const client = await clientDir();
  await emitSitemap(fixture, client, { ...crawl, i18n: { ...crawl.i18n, base: '/site' } });
  const read = (name: string) => readFile(new URL(name, client), 'utf8');
  expect(await read('sitemap-en.xml')).toContain(
    '<loc>https://coastalhomes.example/site/listings/seaview-cottage/</loc>',
  );
  expect(await read('sitemap-index.xml')).toContain(
    '<sitemap><loc>https://coastalhomes.example/site/sitemap-en.xml</loc></sitemap>',
  );
  expect(await read('robots.txt')).toContain(
    'Sitemap: https://coastalhomes.example/site/sitemap-index.xml',
  );
});

test('a site that has not said where it is served gets robots.txt and no sitemap', async () => {
  const client = await clientDir();
  expect(await emitSitemap(fixture, client, undefined)).toEqual(['robots.txt']);
  expect(await readFile(new URL('robots.txt', client), 'utf8')).not.toContain('Sitemap:');
  await expect(readFile(new URL('sitemap-index.xml', client), 'utf8')).rejects.toThrow();
});

test('a robots.txt the site ships itself is left where it is', async () => {
  const client = await clientDir();
  await writeFile(new URL('robots.txt', client), 'User-agent: *\nDisallow: /\n');
  expect(await emitSitemap(fixture, client, crawl)).toEqual([
    'sitemap-en.xml',
    'sitemap-de.xml',
    'sitemap-index.xml',
  ]);
  expect(await readFile(new URL('robots.txt', client), 'utf8')).toBe(
    'User-agent: *\nDisallow: /\n',
  );
});

type Done = HookParameters<'astro:config:done'>;
type BuildDone = HookParameters<'astro:build:done'>;

// `astro:config:done` is where the site's own address and URL form are read off Astro's config.
async function runBuild(astro: Record<string, unknown> = {}) {
  const client = await clientDir();
  const cms: Parameters<typeof handover>[0] = {
    collections: {
      listings: { schema: z.object({ title: z.string() }), ...crawl.collections.listings },
    },
    i18n: crawl.i18n,
  };
  const hooks = handover(cms).hooks;
  await (hooks['astro:config:done'] as (o: Done) => Promise<void>)({
    config: {
      root: fixture,
      site: crawl.base,
      build: { client, format: 'directory' },
      ...astro,
    },
    injectTypes: vi.fn(),
  } as unknown as Done);
  const info = vi.fn();
  await (hooks['astro:build:done'] as (o: BuildDone) => Promise<void>)({
    logger: { info },
  } as unknown as BuildDone);
  return { read: (name: string) => readFile(new URL(name, client), 'utf8').catch(() => '') };
}

test('the sitemap is written in the form the site’s own pages answer at', async () => {
  const directory = await runBuild();
  expect(await directory.read('sitemap-en.xml')).toContain(
    '<loc>https://coastalhomes.example/listings/seaview-cottage/</loc>',
  );
  const never = await runBuild({ trailingSlash: 'never' });
  expect(await never.read('sitemap-en.xml')).toContain(
    '<loc>https://coastalhomes.example/listings/seaview-cottage</loc>',
  );
});

// With the per-collection base, `src/content/_templates/` is outside every collection.
test('a _templates/ file is not in the built collection', async () => {
  const store = new Map<string, { id: string }>();
  const loader = glob({ pattern: '**/*.yaml', base: './src/content/listings' });
  type Context = Parameters<typeof loader.load>[0];
  const context = {
    config: { root: fixture, srcDir: new URL('src/', fixture), prerenderConflictBehavior: 'error' },
    collection: 'listings',
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    parseData: async ({ id, data }: { id: string; data: Record<string, unknown> }) => ({
      id,
      ...data,
    }),
    generateDigest: (s: unknown) => String(s).length.toString(),
    entryTypes: new Map([
      [
        '.yaml',
        {
          getEntryInfo: async ({ contents }: { contents: string }) => ({
            data: parseEntry('default', contents),
            body: '',
          }),
        },
      ],
    ]),
    store: {
      keys: () => store.keys(),
      get: (id: string) => store.get(id),
      set: (e: { id: string }) => store.set(e.id, e) && true,
      delete: (id: string) => store.delete(id),
      addModuleImport: vi.fn(),
      addAssetImports: vi.fn(),
    },
  };
  await loader.load(context as unknown as Context);
  expect([...store.keys()]).toEqual(['en/seaview-cottage']);
});

test('buildIndex fails on a content file below the locale folder, naming it', async () => {
  const root = new URL(`${await mkdtemp(join(tmpdir(), 'handover-site-'))}/`, 'file://');
  await mkdir(new URL('src/content/listings/en/devon/', root), { recursive: true });
  await writeFile(new URL('src/content/listings/en/mill-house.yaml', root), 'title: "Mill"\n');
  await writeFile(
    new URL('src/content/listings/en/devon/seaview.yaml', root),
    'title: "Seaview"\n',
  );
  await expect(buildIndex(await contentFiles(root))).rejects.toThrow(
    'src/content/listings/en/devon/seaview.yaml: an entry is src/content/<collection>/<locale>/<name>.yaml',
  );
});

// There is no "new global": the dev declares them and the first file comes with the declaration.
test('the build names a declared global that has no file in the default language', async () => {
  const root = new URL(`${await mkdtemp(join(tmpdir(), 'handover-site-'))}/`, 'file://');
  await mkdir(new URL('src/content/globals/de/', root), { recursive: true });
  await writeFile(new URL('src/content/globals/de/site.yaml', root), 'name: "Küstenhäuser"\n');

  expect(await contentErrors(root, ['site', 'navigation'], 'en')).toEqual([
    'cms.config.ts › globals.site: declared, but src/content/globals/en/site.yaml does not exist — write the file the default language reads, or drop the key',
    'cms.config.ts › globals.navigation: declared, but src/content/globals/en/navigation.yaml does not exist — write the file the default language reads, or drop the key',
  ]);
});

// A global with no German file yet is what "Create from English" is for.
test('a global missing in a language other than the default is not a build error', async () => {
  const root = new URL(`${await mkdtemp(join(tmpdir(), 'handover-site-'))}/`, 'file://');
  await mkdir(new URL('src/content/globals/en/', root), { recursive: true });
  await writeFile(new URL('src/content/globals/en/site.yaml', root), 'name: "Coastal Homes"\n');

  expect(await contentErrors(root, ['site'], 'en')).toEqual([]);
});

// The block renders as that global's content, so an undeclared name is a hole in the page.
test('the build refuses a _ref naming a global cms.config.ts does not declare', async () => {
  const root = new URL(`${await mkdtemp(join(tmpdir(), 'handover-site-'))}/`, 'file://');
  await mkdir(new URL('src/content/pages/en/', root), { recursive: true });
  await writeFile(
    new URL('src/content/pages/en/home.yaml', root),
    'blocks:\n  - _type: "cta"\n    _id: "q7r8s9t0"\n    _ref: "globals/newsletter"\n',
  );

  expect(await contentErrors(root, ['cta-newsletter'])).toEqual([
    'src/content/pages/en/home.yaml › blocks[0]._ref: no global "newsletter" is declared in cms.config.ts — it has cta-newsletter',
  ]);
  expect(await contentErrors(root, ['newsletter'])).toEqual([]);
});

// `_templates/` is left out of the index and read as the New entry dialog's starters.
const starters = {
  listings: [
    { name: 'house', data: { _version: 1, location: 'Devon', price: 'Price on application' } },
  ],
};

test('virtual:handover/index is the built index, inlined rather than served', async () => {
  const { updateConfig } = runSetup({ name: 'fake-adapter', hooks: {} }, fixture);
  const plugin = updateConfig.mock.calls[0]?.[0].vite.plugins[1];
  expect(plugin.name).toBe('handover-index');
  expect(plugin.resolveId('virtual:handover/index')).toBe('\0virtual:handover/index');
  expect(plugin.resolveId('other')).toBeUndefined();
  expect(await plugin.load('other')).toBeUndefined();
  const module = await plugin.load('\0virtual:handover/index');
  const listed = {
    listings: [
      {
        id: 'seaview-cottage',
        locales: {
          en: { title: 'Seaview Cottage', path: 'src/content/listings/en/seaview-cottage.yaml' },
        },
      },
    ],
  };
  expect(module).toBe(
    `export default JSON.parse(${JSON.stringify(JSON.stringify(listed))});
export const preview = false;
export const site = "";
export const templates = JSON.parse(${JSON.stringify(JSON.stringify(starters))});
export const uses = JSON.parse("{}");
export const stale = JSON.parse("{}");
export const texts = JSON.parse("{}");`,
  );
});

// The admin cannot read a build flag, so the decision rides to the Worker on the index module.
test('the index module carries whether this build has a preview route', async () => {
  const source = async () => {
    const { updateConfig } = runSetup({ name: 'fake-adapter', hooks: {} }, fixture);
    return (await updateConfig.mock.calls[0]?.[0].vite.plugins[1].load(
      '\0virtual:handover/index',
    )) as string;
  };
  expect(await source()).toContain('export const preview = false;');
  process.env.PREVIEW_ENABLED = '1';
  expect(await source()).toContain('export const preview = true;');
});

test('the index is built with the title field each collection declares', async () => {
  const { updateConfig } = runSetup({ name: 'fake-adapter', hooks: {} }, fixture, {
    i18n: EN,
    collections: { listings: { schema: z.object({}), titleField: 'location' } },
  });
  const module = await updateConfig.mock.calls[0]?.[0].vite.plugins[1].load(
    '\0virtual:handover/index',
  );
  // The fixture entry has a title and no location, so it lists under its file name.
  const listed = {
    listings: [
      {
        id: 'seaview-cottage',
        locales: {
          en: { title: 'seaview-cottage', path: 'src/content/listings/en/seaview-cottage.yaml' },
        },
      },
    ],
  };
  expect(module).toBe(
    `export default JSON.parse(${JSON.stringify(JSON.stringify(listed))});
export const preview = false;
export const site = "";
export const templates = JSON.parse(${JSON.stringify(JSON.stringify(starters))});
export const uses = JSON.parse("{}");
export const stale = JSON.parse("{}");
export const texts = JSON.parse("{}");`,
  );
});

// A site's own endpoint under /admin/api/ has nothing else to read the session's type from.
test('the session type is written into the site', () => {
  const injectTypes = vi.fn();
  const hooks = handover({ collections: {}, i18n: EN }).hooks;
  (hooks['astro:config:done'] as (o: unknown) => void)({
    config: { root: fixture, build: { client: fixture } },
    injectTypes,
  });
  expect(injectTypes).toHaveBeenCalledWith({
    filename: 'locals.d.ts',
    content: expect.stringContaining("handover?: import('astro-handover').Session"),
  });
});

async function runBuildStart(root: URL) {
  const hooks = handover({ collections: {}, i18n: EN }).hooks;
  (hooks['astro:config:done'] as (o: unknown) => void)({
    config: { root, build: { client: new URL('dist/client/', root) } },
    injectTypes: vi.fn(),
  });
  await (hooks['astro:build:start'] as (o: unknown) => Promise<void>)({});
}

test('the build fails when migrations/ has no schema marker', async () => {
  const root = pathToFileURL(`${await mkdtemp(join(tmpdir(), 'handover-build-'))}/`);
  await expect(runBuildStart(root)).rejects.toThrow(
    'migrations/ has no handover.json: run `npx handover db generate` and commit migrations/',
  );
});

test('the build goes on when migrations/ records the package schema version', async () => {
  const root = pathToFileURL(`${await mkdtemp(join(tmpdir(), 'handover-build-'))}/`);
  await mkdir(new URL('migrations/', root));
  await writeFile(
    new URL('migrations/handover.json', root),
    `{ "schemaVersion": ${SCHEMA_VERSION} }`,
  );
  await expect(runBuildStart(root)).resolves.toBeUndefined();
});
