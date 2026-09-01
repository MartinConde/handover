import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  fieldsFrom,
  formOf,
  type JsonSchema,
  parseEntry,
  SCHEMA_VERSION,
  syncLocale,
} from '@handover/core';
import type { HookParameters } from 'astro';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { beforeEach, expect, expectTypeOf, test, vi } from 'vitest';
import handover, {
  type Block,
  type BlockRegistry,
  blocks,
  buildIndex,
  buildMediaUses,
  buildTemplates,
  contentErrors,
  defineBlock,
  defineConfig,
  embed,
  emitRedirects,
  emitSitemap,
  file,
  formSchema,
  image,
  link,
  loadersModule,
  NO_ADAPTER_MESSAGE,
  navigation,
  redirects,
  reference,
  richtext,
  seo,
  uiAssetsModule,
} from './index.js';

test('the scalar field types are detected from real Zod output', () => {
  const schema = z.object({
    title: z.string(),
    area: z.number(),
    sold: z.boolean(),
    from: z.iso.date(),
    status: z.enum(['sale', 'rent']),
    button: link.optional(),
  });
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchema;
  expect(fieldsFrom('default', json).map((f) => [f.path.join('.'), f.type])).toEqual([
    ['title', 'text'],
    ['area', 'number'],
    ['sold', 'boolean'],
    ['from', 'date'],
    ['status', 'select'],
    ['button', 'link'],
  ]);
});

test('a link field refuses a target that would run code', () => {
  const parsed = link.safeParse({ type: 'url', href: 'javascript:alert(1)' });
  expect(parsed.success).toBe(false);
  expect(parsed.error?.issues[0]?.message).toBe('javascript: links are not allowed');
  expect(link.safeParse({ type: 'url', href: 'mailto:hello@example.com' }).success).toBe(true);
});

// The canonical box took any string: a `javascript:` one would have gone into a <link> tag.
test('a seo canonical refuses a target that would run code', () => {
  const parsed = seo.safeParse({ canonical: 'javascript:alert(1)' });
  expect(parsed.success).toBe(false);
  expect(parsed.error?.issues[0]?.message).toBe('javascript: links are not allowed');
  expect(seo.safeParse({ canonical: 'https://example.com/about/' }).success).toBe(true);
});

test('link accepts url and ref shapes and rejects a mismatched pair', () => {
  expect(link.safeParse({ type: 'url', href: '/contact', newTab: true }).success).toBe(true);
  expect(link.safeParse({ type: 'page', ref: 'pages/impressum' }).success).toBe(true);
  expect(link.safeParse({ type: 'url', ref: 'pages/impressum' }).success).toBe(false);
});

test('the structured field types are detected from real Zod output', () => {
  const schema = z.object({
    hero: image({ ratio: '16:9', max: 2400, min: 1600 }),
    brochure: file().optional(),
    video: embed,
    seo: seo.optional(),
    agent: reference('agents'),
  });
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchema;
  expect(fieldsFrom('default', json)).toEqual([
    {
      path: ['hero'],
      label: 'Hero',
      type: 'image',
      required: true,
      preset: { ratio: '16:9', max: 2400, min: 1600 },
    },
    {
      path: ['brochure'],
      label: 'Brochure',
      type: 'file',
      required: false,
      accept: ['application/pdf'],
    },
    { path: ['video'], label: 'Video', type: 'embed', required: true },
    { path: ['seo'], label: 'Seo', type: 'seo', required: false },
    { path: ['agent'], label: 'Agent', type: 'reference', required: true, collection: 'agents' },
  ]);
});

test('image and file take media keys, never URLs', () => {
  const hero = { src: 'media/9f3a2c7e.webp', width: 2400, height: 1600 };
  expect(image().safeParse(hero).success).toBe(true);
  expect(image().safeParse({ ...hero, src: 'https://cdn.example.com/9f3a.webp' }).success).toBe(
    false,
  );
  const doc = {
    src: 'files/3e8a1b9c.pdf',
    name: 'Brochure.pdf',
    bytes: 1,
    mime: 'application/pdf',
  };
  expect(file().safeParse(doc).success).toBe(true);
  // The display name is the translatable half, so a language that has not typed one yet still
  // has a valid file: a source language adding a PDF must not block that language's publish.
  expect(file().safeParse({ ...doc, name: undefined }).success).toBe(true);
  expect(file().safeParse({ ...doc, src: 'media/3e8a1b9c.pdf' }).success).toBe(false);
});

test('embed takes an allow-listed provider and rejects raw HTML', () => {
  expect(embed.safeParse({ provider: 'vimeo', id: '76979871', start: 10 }).success).toBe(true);
  expect(embed.safeParse({ provider: 'tiktok', id: '76979871' }).success).toBe(false);
  const iframe = '<iframe src="https://evil.example/x"></iframe>';
  expect(embed.safeParse({ provider: 'youtube', id: iframe }).success).toBe(false);
  expect(embed.safeParse({ provider: 'youtube', id: 'x', html: iframe }).success).toBe(false);
});

test('reference is a collection/slug string', () => {
  expect(reference('agents').safeParse('agents/jane-doe').success).toBe(true);
  expect(reference('agents').safeParse('jane-doe').success).toBe(false);
  expect(reference('agents').safeParse('https://example.com/agents/jane').success).toBe(false);
});

// The 1.5 golden's registry: `columns` holds `blocks` again, so the union is recursive.
const registry: BlockRegistry = {
  hero: defineBlock('hero', { heading: z.string(), image: image().optional() }),
  textSection: defineBlock('textSection', { body: z.string() }),
  cta: defineBlock('cta', { heading: z.string(), button: link }),
  columns: defineBlock('columns', {
    columns: z.array(z.object({ _id: z.string(), blocks: blocks(() => registry) })),
  }),
};
const page = z.object({ title: z.string(), blocks: blocks(() => registry) });

test('the Block type recursion compiles: a page of blocks infers to Block[]', () => {
  expectTypeOf<z.infer<typeof page>['blocks']>().toEqualTypeOf<Block[]>();
});

test('the 1.5 golden parses through the registry, three levels deep', async () => {
  const yaml = await readFile(
    new URL('../../core/test/golden/blocks.yaml', import.meta.url),
    'utf8',
  );
  const data = parseEntry('default', yaml);
  expect(page.safeParse(data).success).toBe(true);
});

test('a block with _ref needs nothing but _type and _id; without it the fields are required', () => {
  const ref = { _type: 'cta', _id: 'q7r8s9t0', _ref: 'globals/cta-newsletter' };
  expect(page.safeParse({ title: 'x', blocks: [ref] }).success).toBe(true);
  expect(page.safeParse({ title: 'x', blocks: [{ _type: 'cta', _id: 'q7r8s9t0' }] }).success).toBe(
    false,
  );
  expect(page.safeParse({ title: 'x', blocks: [{ ...ref, _ref: 'cta-newsletter' }] }).success).toBe(
    false,
  );
});

test('an unregistered block type is rejected', () => {
  expect(
    page.safeParse({ title: 'x', blocks: [{ _type: 'video', _id: 'q7r8s9t0' }] }).success,
  ).toBe(false);
});

test('group, array and blocks are detected from real Zod output', () => {
  const schema = z.object({
    address: z.object({ street: z.string(), town: z.string().optional() }),
    rooms: z.array(z.object({ _id: z.string(), name: z.string(), area: z.number() })),
    tags: z.array(z.string()).optional(),
    blocks: blocks(() => registry),
  });
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchema;
  expect(fieldsFrom('default', json)).toEqual([
    {
      path: ['address'],
      label: 'Address',
      type: 'group',
      required: true,
      fields: [
        { path: ['street'], label: 'Street', type: 'text', required: true },
        { path: ['town'], label: 'Town', type: 'text', required: false },
      ],
    },
    {
      path: ['rooms'],
      label: 'Rooms',
      type: 'array',
      required: true,
      item: [
        { path: ['name'], label: 'Name', type: 'text', required: true },
        { path: ['area'], label: 'Area', type: 'number', required: true },
      ],
    },
    {
      path: ['tags'],
      label: 'Tags',
      type: 'array',
      required: false,
      item: [{ path: [], label: '', type: 'text', required: true }],
    },
    {
      path: ['blocks'],
      label: 'Blocks',
      type: 'blocks',
      required: true,
      types: ['hero', 'textSection', 'cta', 'columns'],
    },
  ]);
});

type Setup = HookParameters<'astro:config:setup'>;

// The flag is read off the environment at build, so the suite states it rather than inheriting
// whatever shell it was launched from.
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

// Preview renders draft content on the client's own domain, so the site that did not ask for
// it has no such route to reach at all — not a route that answers 404.
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

test('registers the password-gate middleware before the routes', () => {
  const { addMiddleware } = runSetup({ name: 'fake-adapter', hooks: {} });
  expect(addMiddleware).toHaveBeenCalledWith({ order: 'pre', entrypoint: expect.any(URL) });
  expect(String(addMiddleware.mock.calls[0]?.[0].entrypoint)).toMatch(/\/middleware\.js$/);
});

const adapter = { name: 'fake-adapter', hooks: {} };
const drift = (cms: unknown, i18n?: unknown) =>
  runSetup(adapter, new URL('file:///site/'), cms as Parameters<typeof handover>[0], { i18n });

test('a cms.config.ts without an i18n block is refused before the build', () => {
  expect(() => defineConfig({ collections: {} } as Parameters<typeof defineConfig>[0])).toThrow(
    /^cms\.config\.ts › i18n: required/,
  );
});

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

test('virtual:handover/ui inlines every file in dist/ui', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'handover-ui-'));
  await writeFile(join(dir, 'main-abc.js'), 'js();');
  await writeFile(join(dir, 'main-abc.css'), 'b{}');
  const { updateConfig } = runSetup({ name: 'fake-adapter', hooks: {} });
  const plugin = updateConfig.mock.calls[0]?.[0].vite.plugins[2];
  expect(plugin.resolveId('virtual:handover/ui')).toBe('\0virtual:handover/ui');
  expect(plugin.resolveId('other')).toBeUndefined();
  expect(await plugin.load('other')).toBeUndefined();
  expect(await uiAssetsModule(dir)).toBe(
    `export default ${JSON.stringify({ 'main-abc.css': 'b{}', 'main-abc.js': 'js();' })};`,
  );
});

test('richtext is detected with its tier, basic by default', () => {
  const schema = z.object({ body: richtext('full'), note: richtext().optional() });
  expect(fieldsFrom('default', z.toJSONSchema(schema) as JsonSchema)).toEqual([
    { path: ['body'], label: 'Body', type: 'richtext', required: true, tier: 'full' },
    { path: ['note'], label: 'Note', type: 'richtext', required: false, tier: 'basic' },
  ]);
});

test('richtext rejects a construct outside its tier and names it', () => {
  expect(richtext().safeParse('A **bold** [link](https://x.y).').success).toBe(true);
  expect(richtext('full').safeParse('## Heading\n\n> Quote').success).toBe(true);
  const basic = richtext().safeParse('## Heading');
  expect(basic.success).toBe(false);
  expect(basic.error?.issues[0]?.message).toBe('heading needs richtext: full (line 1)');
  const html = richtext('full').safeParse('<script>alert(1)</script>');
  expect(html.success).toBe(false);
  expect(html.error?.issues[0]?.message).toBe('html is not allowed (line 1)');
});

test('defineConfig fails on a bad route with a message naming the key', () => {
  expect(() =>
    defineConfig({ i18n: EN, collections: { posts: { schema: z.object({}), route: '/blog' } } }),
  ).toThrow(/cms\.config\.ts › collections\.posts\.route: expected a path .*"\/blog"/);
});

test('defineConfig fails when titleField is not a text field of the schema', () => {
  const presenter = z.object({ name: z.string(), bio: richtext() });
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { presenters: { schema: presenter, titleField: 'nmae' } },
    }),
  ).toThrow(
    'cms.config.ts › collections.presenters.titleField: "nmae" is not a text field of this collection\'s schema',
  );
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { presenters: { schema: presenter, titleField: 'bio' } },
    }),
  ).toThrow(/collections\.presenters\.titleField/);
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { presenters: { schema: presenter, titleField: 'name' } },
    }),
  ).not.toThrow();
});

// The twin of the titleField check: the site's own route reads the field, so a collection
// promising an address per language without one would fail at the first page rather than here.
test('defineConfig fails when localizedSlugs has no optional slug field to read', () => {
  const bare = z.object({ title: z.string() });
  expect(() =>
    defineConfig({ i18n: EN, collections: { pages: { schema: bare, localizedSlugs: true } } }),
  ).toThrow(
    'cms.config.ts › collections.pages.localizedSlugs: this collection\'s schema has no optional "slug" text field — add slug: z.string().optional() to it, since the site\'s own route reads it',
  );
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { pages: { schema: z.object({ slug: z.string() }), localizedSlugs: true } },
    }),
  ).toThrow(/"slug" is required in this collection's schema/);
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: {
        pages: {
          schema: z.object({ slug: z.string().optional() }),
          route: '/[slug]',
          localizedSlugs: true,
        },
      },
    }),
  ).not.toThrow();
  // Nothing renders the collection, so an address is a segment of nothing.
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: {
        pages: { schema: z.object({ slug: z.string().optional() }), localizedSlugs: true },
      },
    }),
  ).toThrow(/has no route, so an address has nothing to be a segment of/);
  // Without the flag a `slug` is an ordinary field and nothing is asked of it.
  expect(() => defineConfig({ i18n: EN, collections: { pages: { schema: bare } } })).not.toThrow();
});

test('defineConfig returns a valid config unchanged', () => {
  const config = {
    i18n: EN,
    collections: { posts: { schema: z.object({}), route: '/blog/[slug]', index: '/blog' } },
  };
  expect(defineConfig(config)).toBe(config);
});

const golden = (name: string) =>
  readFile(new URL(`../../core/test/golden/${name}.yaml`, import.meta.url), 'utf8').then((y) =>
    parseEntry('default', y),
  );

test('the navigation golden parses: menus[].items[] nest through children', async () => {
  const result = navigation.safeParse(await golden('navigation'));
  expect(result.success).toBe(true);
  expect(result.data?.menus[0]?.items[0]?.children?.[0]?.label).toBe('For sale');
});

test('the navigation global is one menus field: the walker stops at the shape it owns', () => {
  const { fields } = formOf('default', formSchema(navigation));
  expect(fields).toEqual([
    { path: ['menus'], label: 'Menus', type: 'menus', required: true, i18n: 'duplicate' },
  ]);
});

// The tree is one skeleton and the labels are per language, so a row reaches a language
// before anybody has typed its word for it — and that file still has to parse.
test('an item synced into another language before it is translated is a valid file', () => {
  const form = formOf('default', formSchema(navigation));
  const en = {
    menus: [
      {
        _id: '7h2kq9sd',
        key: 'header',
        items: [{ _id: 'a1b2c3d4', label: 'Listings', link: { type: 'url', href: '/listings' } }],
      },
    ],
  };

  const de = syncLocale('default', form, 'de', { before: { menus: [] }, after: en }, {});

  expect(de.menus).toEqual([
    {
      _id: '7h2kq9sd',
      key: 'header',
      items: [{ _id: 'a1b2c3d4', link: { type: 'url', href: '/listings' } }],
    },
  ]);
  const parsed = navigation.safeParse(de);
  expect(parsed.success).toBe(true);
  expect(parsed.data?.menus[0]?.items[0]?.label).toBe('');
});

// The walkers read a menu item through fields that name themselves under `children`. That
// description is theirs alone: the form is JSON on its way to the browser, and a cycle in it
// has no end.
test('the form a browser is handed carries no cycle', () => {
  expect(() => JSON.stringify(formOf('default', formSchema(navigation)))).not.toThrow();
});

test('a menu item link is a bare target: no label or newTab inside it', () => {
  const item = { _id: 'a1b2c3d4', label: 'Listings', link: { type: 'url', href: '/listings' } };
  const menu = (i: unknown) => ({ menus: [{ _id: '7h2kq9sd', key: 'header', items: [i] }] });
  expect(navigation.safeParse(menu(item)).success).toBe(true);
  expect(
    navigation.safeParse(menu({ ...item, link: { ...item.link, newTab: true } })).success,
  ).toBe(false);
  expect(navigation.safeParse(menu({ ...item, link: { type: 'entry', href: '/x' } })).success).toBe(
    false,
  );
  // A menu item is the most-clicked link on a site; it takes the same targets as any other.
  expect(
    navigation.safeParse(menu({ ...item, link: { type: 'url', href: 'javascript:alert(1)' } }))
      .success,
  ).toBe(false);
});

test('the redirects golden parses; from must be a path and to a path or absolute URL', async () => {
  expect(redirects.safeParse(await golden('redirects')).success).toBe(true);
  const rule = {
    _id: 'aaaaaaaa',
    from: '/old',
    to: '/new',
    status: 301,
    reason: 'manual',
    createdAt: '2026-01-01T00:00:00Z',
  };
  const file = (r: unknown) => redirects.safeParse({ rules: [r] }).success;
  expect(file(rule)).toBe(true);
  expect(file({ ...rule, to: 'https://example.com/new' })).toBe(true);
  expect(file({ ...rule, from: 'https://example.com/old' })).toBe(false);
  expect(file({ ...rule, from: 'old' })).toBe(false);
  expect(file({ ...rule, to: 'new' })).toBe(false);
  // 302 is the manual rule's "just for now"; nothing else is a code this format has.
  expect(file({ ...rule, status: 302 })).toBe(true);
  expect(file({ ...rule, status: 307 })).toBe(false);
  expect(file({ ...rule, reason: 'moved' })).toBe(false);
});

const fixture = new URL('../test/fixture/', import.meta.url);

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

// The two hooks that write the crawler's files, against the fixture project: `astro:config:done`
// is where the site's own address and URL form are read off Astro's resolved config.
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

// The real glob loader on the fixture project: with the documented per-collection base,
// `src/content/_templates/` is outside every collection and never becomes an entry.
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

test('buildIndex lists an entry per locale file and leaves _templates/ out', async () => {
  expect(await buildIndex(fixture)).toEqual({
    listings: [
      {
        id: 'seaview-cottage',
        locales: {
          en: {
            title: 'Seaview Cottage',
            path: 'src/content/listings/en/seaview-cottage.yaml',
          },
        },
      },
    ],
  });
});

// The same file the loader and the index both skip is the one the New entry dialog offers,
// which is why it is read here rather than listed out of git at run time.
test('buildTemplates reads the starters the site ships', async () => {
  expect(await buildTemplates(fixture)).toEqual({
    listings: [
      { name: 'house', data: { _version: 1, location: 'Devon', price: 'Price on application' } },
    ],
  });
});

test('buildIndex titles an entry by the field its collection declares', async () => {
  const root = new URL(`${await mkdtemp(join(tmpdir(), 'handover-site-'))}/`, 'file://');
  await mkdir(new URL('src/content/presenters/en/', root), { recursive: true });
  await writeFile(new URL('src/content/presenters/en/rosa-hale.yaml', root), 'name: "Rosa Hale"\n');
  expect(await buildIndex(root, { presenters: 'name' })).toEqual({
    presenters: [
      {
        id: 'rosa-hale',
        locales: {
          en: { title: 'Rosa Hale', path: 'src/content/presenters/en/rosa-hale.yaml' },
        },
      },
    ],
  });
});

test('buildIndex fails on a content file below the locale folder, naming it', async () => {
  const root = new URL(`${await mkdtemp(join(tmpdir(), 'handover-site-'))}/`, 'file://');
  await mkdir(new URL('src/content/listings/en/devon/', root), { recursive: true });
  await writeFile(new URL('src/content/listings/en/mill-house.yaml', root), 'title: "Mill"\n');
  await writeFile(
    new URL('src/content/listings/en/devon/seaview.yaml', root),
    'title: "Seaview"\n',
  );
  await expect(buildIndex(root)).rejects.toThrow(
    'src/content/listings/en/devon/seaview.yaml: an entry is src/content/<collection>/<locale>/<name>.yaml',
  );
});

// A global the site declares and never writes would be a card in Site settings that opens
// nothing: the admin edits the file a language has, and there is no "new global" — the dev
// declares them and the first file comes with the declaration.
test('the build names a declared global that has no file in the default language', async () => {
  const root = new URL(`${await mkdtemp(join(tmpdir(), 'handover-site-'))}/`, 'file://');
  await mkdir(new URL('src/content/globals/de/', root), { recursive: true });
  await writeFile(new URL('src/content/globals/de/site.yaml', root), 'name: "Küstenhäuser"\n');

  expect(await contentErrors(root, ['site', 'navigation'], 'en')).toEqual([
    'cms.config.ts › globals.site: declared, but src/content/globals/en/site.yaml does not exist — write the file the default language reads, or drop the key',
    'cms.config.ts › globals.navigation: declared, but src/content/globals/en/navigation.yaml does not exist — write the file the default language reads, or drop the key',
  ]);
});

// Only the default language: a global with no German file yet is what "Create from English"
// is for, and the site renders the language it has.
test('a global missing in a language other than the default is not a build error', async () => {
  const root = new URL(`${await mkdtemp(join(tmpdir(), 'handover-site-'))}/`, 'file://');
  await mkdir(new URL('src/content/globals/en/', root), { recursive: true });
  await writeFile(new URL('src/content/globals/en/site.yaml', root), 'name: "Coastal Homes"\n');

  expect(await contentErrors(root, ['site'], 'en')).toEqual([]);
});

// The build-time half of `_ref`: an unregistered `_type` is refused by the block union at
// content sync, and a name no global answers to has to be refused in the same pass — the block
// renders as that global's content, so this is a hole in the page, not an empty field.
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

test('virtual:handover/index is the built index, inlined rather than served', async () => {
  const { updateConfig } = runSetup({ name: 'fake-adapter', hooks: {} }, fixture);
  const plugin = updateConfig.mock.calls[0]?.[0].vite.plugins[1];
  expect(plugin.name).toBe('handover-index');
  expect(plugin.resolveId('virtual:handover/index')).toBe('\0virtual:handover/index');
  expect(plugin.resolveId('other')).toBeUndefined();
  expect(await plugin.load('other')).toBeUndefined();
  const module = await plugin.load('\0virtual:handover/index');
  expect(module).toBe(
    `export default JSON.parse(${JSON.stringify(JSON.stringify(await buildIndex(fixture)))});
export const preview = false;
export const site = "";
export const templates = JSON.parse(${JSON.stringify(JSON.stringify(await buildTemplates(fixture)))});
export const uses = JSON.parse(${JSON.stringify(JSON.stringify(await buildMediaUses(fixture)))});
export const stale = JSON.parse("{}");`,
  );
});

// The admin cannot read a build flag, and a Preview button that opens a 404 is worse than one
// that says why it is not there — so the same read that decides the route rides to the Worker
// on the one module the build already hands it.
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
  // The fixture entry has a title and no location, so it lists under its file name: the
  // declared field is the only one read.
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
export const templates = JSON.parse(${JSON.stringify(JSON.stringify(await buildTemplates(fixture)))});
export const uses = JSON.parse(${JSON.stringify(JSON.stringify(await buildMediaUses(fixture)))});
export const stale = JSON.parse("{}");`,
  );
});

test('formSchema maps z.date() to a date field and a transform to its input type', () => {
  const schema = z.object({
    when: z.date(),
    slug: z.string().transform((s) => s.toLowerCase()),
    tag: z.custom<string>(() => true).meta({ handover: 'text' }),
  });
  expect(fieldsFrom('default', formSchema(schema))).toEqual([
    { path: ['when'], label: 'When', type: 'date', required: true },
    { path: ['slug'], label: 'Slug', type: 'text', required: true },
    { path: ['tag'], label: 'Tag', type: 'text', required: true },
  ]);
});

test('a label names the field, on a plain type and on top of a helper', () => {
  const schema = z.object({
    availableFrom: z.iso.date(),
    seo: seo.meta({ label: 'SEO' }).optional(),
  });
  expect(fieldsFrom('default', formSchema(schema)).map((f) => [f.type, f.label])).toEqual([
    ['date', 'Available from'],
    ['seo', 'SEO'],
  ]);
});

// Mirror of handover-demo/src/content/schemas.ts: the snapshot is the descriptor tree the
// admin form is built from, and it must hold no unsupported marker.
test('the demo schema produces a full descriptor tree', () => {
  const hero = defineBlock('hero', {
    heading: z.string(),
    image: image({ ratio: '16:9', max: 2400 }).optional(),
  });
  const textSection = defineBlock('textSection', { body: z.string() });
  const cta = defineBlock('cta', { heading: z.string(), button: link });
  const columns = defineBlock('columns', {
    columns: z.array(z.object({ _id: z.string(), blocks: blocks(() => registry) })),
  });
  const registry: BlockRegistry = { hero, textSection, cta, columns };
  const page = z.object({ title: z.string(), blocks: blocks(() => registry) });
  const listing = z.object({
    slug: z.string().optional(),
    title: z.string(),
    location: z.string(),
    price: z.string(),
    summary: z.string(),
    photo: image({ ratio: '3:2', max: 2400, min: 1200 }).optional(),
    brochure: file().optional(),
    phone: z.string().optional().meta({ i18n: 'duplicate' }),
    internalNote: z.string().optional().meta({ i18n: false }),
  });
  const form = {
    listings: formOf('default', formSchema(listing)),
    pages: formOf('default', formSchema(page)),
  };
  expect(JSON.stringify(form)).not.toContain('unsupported');
  expect(form).toMatchSnapshot();
});

async function runBuildStart(root: URL) {
  const hooks = handover({ collections: {}, i18n: EN }).hooks;
  (hooks['astro:config:done'] as (o: unknown) => void)({
    config: { root, build: { client: new URL('dist/client/', root) } },
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

test('a field says how it translates through .meta({ i18n })', () => {
  const schema = z.object({
    title: z.string(),
    price: z.number().meta({ i18n: 'duplicate' }),
    notes: z.string().optional().meta({ i18n: false }),
    hero: image({ ratio: '16:9' }).meta({ i18n: 'duplicate' }).optional(),
  });
  expect(fieldsFrom('default', formSchema(schema)).map((f) => [f.path[0], f.i18n])).toEqual([
    ['title', undefined],
    ['price', 'duplicate'],
    ['notes', false],
    ['hero', 'duplicate'],
  ]);
});

// A typo in checks.ignore is a check the site thinks it turned off and did not, which nothing
// else would ever say out loud.
// `mailer()` treated an unrecognised provider as resend, so a JS site with a typo was told
// RESEND_API_KEY was missing.
test('defineConfig fails when mailer.provider names no provider', () => {
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { posts: { schema: z.object({}) } },
      mailer: { provider: 'sendgrid', from: 'Site <hi@example.com>' } as never,
    }),
  ).toThrow(
    'cms.config.ts › mailer.provider: "sendgrid" is not one of the providers — resend, smtp, cloudflare',
  );
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { posts: { schema: z.object({}) } },
      mailer: { provider: 'smtp', from: 'Site <hi@example.com>', host: 'smtp.example.com' },
    }),
  ).not.toThrow();
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { posts: { schema: z.object({}) } },
      mailer: async () => ({ id: '1' }),
    }),
  ).not.toThrow();
});

test('defineConfig fails when checks.ignore names no check', () => {
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { posts: { schema: z.object({}) } },
      checks: { ignore: ['seo-descriptions'] as never },
    }),
  ).toThrow(
    'cms.config.ts › checks.ignore: "seo-descriptions" is not one of the checks — media-missing, link-target, link-locale, media-archived, image-alt, menu-target, translation-empty, translation-stale, translation-machine, seo-title, seo-description, seo-image',
  );
  expect(() =>
    defineConfig({
      i18n: EN,
      collections: { posts: { schema: z.object({}) } },
      checks: { ignore: ['seo-description'] },
    }),
  ).not.toThrow();
});
