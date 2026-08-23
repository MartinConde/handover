import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fieldsFrom, formOf, type JsonSchema, parseEntry, SCHEMA_VERSION } from '@handover/core';
import type { HookParameters } from 'astro';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { expect, expectTypeOf, test, vi } from 'vitest';
import handover, {
  type Block,
  type BlockRegistry,
  blocks,
  buildIndex,
  defineBlock,
  defineConfig,
  embed,
  emitRedirects,
  file,
  formSchema,
  image,
  link,
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

test('link accepts url and ref shapes and rejects a mismatched pair', () => {
  expect(link.safeParse({ type: 'url', href: '/contact', newTab: true }).success).toBe(true);
  expect(link.safeParse({ type: 'page', ref: 'pages/impressum' }).success).toBe(true);
  expect(link.safeParse({ type: 'url', ref: 'pages/impressum' }).success).toBe(false);
});

test('the structured field types are detected from real Zod output', () => {
  const schema = z.object({
    hero: image,
    brochure: file.optional(),
    video: embed,
    seo: seo.optional(),
    agent: reference('agents'),
  });
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchema;
  expect(fieldsFrom('default', json)).toEqual([
    { path: ['hero'], label: 'Hero', type: 'image', required: true },
    { path: ['brochure'], label: 'Brochure', type: 'file', required: false },
    { path: ['video'], label: 'Video', type: 'embed', required: true },
    { path: ['seo'], label: 'Seo', type: 'seo', required: false },
    { path: ['agent'], label: 'Agent', type: 'reference', required: true, collection: 'agents' },
  ]);
});

test('image and file take media keys, never URLs', () => {
  const hero = { src: 'media/9f3a2c7e.webp', width: 2400, height: 1600 };
  expect(image.safeParse(hero).success).toBe(true);
  expect(image.safeParse({ ...hero, src: 'https://cdn.example.com/9f3a.webp' }).success).toBe(
    false,
  );
  const doc = {
    src: 'files/3e8a1b9c.pdf',
    name: 'Brochure.pdf',
    bytes: 1,
    mime: 'application/pdf',
  };
  expect(file.safeParse(doc).success).toBe(true);
  expect(file.safeParse({ ...doc, src: 'media/3e8a1b9c.pdf' }).success).toBe(false);
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
  hero: defineBlock('hero', { heading: z.string(), image: image.optional() }),
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
  expect(file({ ...rule, status: 302 })).toBe(false);
  expect(file({ ...rule, reason: 'moved' })).toBe(false);
});

const fixture = new URL('../test/fixture/', import.meta.url);

test('emitRedirects appends one _redirects line per rule to the client dir', async () => {
  const client = new URL(`${await mkdtemp(join(tmpdir(), 'handover-client-'))}/`, 'file://');
  await writeFile(new URL('_redirects', client), '/a /b 301\n');
  expect(await emitRedirects(fixture, client)).toBe(2);
  expect(await readFile(new URL('_redirects', client), 'utf8')).toBe(
    '/a /b 301\n/listings/seaview-cottage /listings/seaview-cottage-devon 301\n/brochure https://example.com/files/brochure.pdf 301\n',
  );
});

test('emitRedirects writes nothing for a site without redirects.yaml', async () => {
  const client = new URL(`${await mkdtemp(join(tmpdir(), 'handover-client-'))}/`, 'file://');
  expect(await emitRedirects(new URL('file:///nowhere/'), client)).toBe(0);
  await expect(readFile(new URL('_redirects', client), 'utf8')).rejects.toThrow();
});

test('emitRedirects fails the build on a bad rule, naming the path', async () => {
  const root = new URL(`${await mkdtemp(join(tmpdir(), 'handover-site-'))}/`, 'file://');
  await mkdir(new URL('src/content/', root), { recursive: true });
  await writeFile(
    new URL('src/content/redirects.yaml', root),
    '_version: 1\nrules:\n  - _id: "aaaaaaaa"\n    from: "old"\n    to: "/new"\n    status: 301\n    reason: "manual"\n    createdAt: "2026-01-01T00:00:00Z"\n',
  );
  await expect(emitRedirects(root, root)).rejects.toThrow(
    'src/content/redirects.yaml › rules[0].from: a path starting with "/"',
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

test('virtual:handover/index is the built index, inlined rather than served', async () => {
  const { updateConfig } = runSetup({ name: 'fake-adapter', hooks: {} }, fixture);
  const plugin = updateConfig.mock.calls[0]?.[0].vite.plugins[1];
  expect(plugin.name).toBe('handover-index');
  expect(plugin.resolveId('virtual:handover/index')).toBe('\0virtual:handover/index');
  expect(plugin.resolveId('other')).toBeUndefined();
  expect(await plugin.load('other')).toBeUndefined();
  const module = await plugin.load('\0virtual:handover/index');
  expect(module).toBe(
    `export default JSON.parse(${JSON.stringify(JSON.stringify(await buildIndex(fixture)))});`,
  );
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
  expect(module).toBe(`export default JSON.parse(${JSON.stringify(JSON.stringify(listed))});`);
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
  const hero = defineBlock('hero', { heading: z.string(), image: image.optional() });
  const textSection = defineBlock('textSection', { body: z.string() });
  const cta = defineBlock('cta', { heading: z.string(), button: link });
  const columns = defineBlock('columns', {
    columns: z.array(z.object({ _id: z.string(), blocks: blocks(() => registry) })),
  });
  const registry: BlockRegistry = { hero, textSection, cta, columns };
  const page = z.object({ title: z.string(), blocks: blocks(() => registry) });
  const listing = z.object({
    title: z.string(),
    location: z.string(),
    price: z.string(),
    summary: z.string(),
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
