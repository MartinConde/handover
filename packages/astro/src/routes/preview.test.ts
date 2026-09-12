import {
  type AstroContent,
  type ContentSource,
  entryAt,
  getEntryLocales,
  globalsAt,
  menusAt,
} from '@handover/core';
import { beforeEach, expect, test, vi } from 'vitest';
import { preview } from './preview.js';

// What the session is worth is proven against a real D1 in core's auth.test.ts.
let session: { user: { id: string; role?: string } } | null = null;
vi.mock('../auth.js', () => ({
  createAuth: () => ({ api: { getSession: async () => session } }),
}));

const { listing, pageSchema, globalSchemas, rows } = await vi.hoisted(async () => {
  const { z } = await import('astro/zod');
  return {
    listing: z.object({ title: z.string() }),
    pageSchema: z.object({ title: z.string(), blocks: z.array(z.unknown()).optional() }),
    globalSchemas: {
      site: z.object({ name: z.string() }),
      navigation: z.object({ menus: z.array(z.unknown()) }),
      'new-cta': z.object({ heading: z.string().transform((value) => value.toUpperCase()) }),
      'cta-newsletter': z.object({
        button: z.object({ type: z.literal('entry'), ref: z.string() }),
      }),
    },
    // The D1 boundary: the rows preview lays over the build, filled per test.
    rows: [] as { path: string; contents: string }[],
  };
});

vi.mock('virtual:handover/config', () => ({
  default: {
    i18n: { base: '/nested/site', locales: ['en', 'de'], defaultLocale: 'en' },
    globals: globalSchemas,
    collections: {
      listings: { schema: listing, route: '/listings/[slug]', index: '/', load: 'listing' },
      pages: { schema: pageSchema, route: '/[slug]', localizedSlugs: true, load: 'page' },
      unwired: { schema: listing, route: '/unwired/[slug]' },
      samples: { schema: listing },
    },
  },
}));

vi.mock('cloudflare:workers', () => ({ env: { DB: {} } }));
vi.mock('@handover/core', async (original) => ({
  ...(await original<typeof import('@handover/core')>()),
  openDb: () => ({}),
  draftFiles: async () => rows,
}));

// The site's own loader, as `src/loaders/listing.ts`.
const Page = 'Page.astro';
const Index = 'Index.astro';
let loader: Record<string, unknown> = {};
vi.mock('virtual:handover/loaders', () => ({
  get default() {
    return { listing: loader, page: pageLoader };
  },
}));

const entryLoader = {
  Page,
  Index,
  load: async (
    source: { getEntry: (c: string, id: string) => Promise<{ data: unknown } | undefined> },
    { locale, slug }: { locale: string; slug: string },
  ) => {
    const entry = await source.getEntry('listings', `${locale}/${slug}`);
    return entry && { data: entry.data, locale };
  },
  loadIndex: async (
    source: { getCollection: (c: string, l: string) => Promise<{ id: string }[]> },
    { locale }: { locale: string },
  ) => ({ listings: (await source.getCollection('listings', locale)).map((e) => e.id), locale }),
};

const built: Record<string, unknown> = {
  'en/mill-house': { title: 'Mill House' },
  'de/mill-house': { title: 'Mühlenhaus' },
};

const pagesBuilt: Record<string, unknown> = {
  'en/home': { title: 'Home' },
  'de/home': { title: 'Startseite', slug: 'startseite' },
  'de/impressum': { title: 'Impressum' },
};
const pageSite = {
  i18n: { locales: ['en', 'de'], defaultLocale: 'en' },
  collections: { pages: { route: '/[slug]', localizedSlugs: true } },
};
const globalsBuilt: Record<string, unknown> = {
  'en/site': { name: 'Handover' },
  'de/site': { name: 'Handover DE' },
  'en/navigation': {
    menus: [{ key: 'header', items: [{ link: { type: 'entry', ref: 'pages/impressum' } }] }],
  },
  'de/navigation': {
    menus: [{ key: 'header', items: [{ link: { type: 'entry', ref: 'pages/impressum' } }] }],
  },
  'en/cta-newsletter': { button: { type: 'entry', ref: 'pages/home' } },
};
// The demo's actual read pattern: page, language switcher, then shared navigation.
const pageLoader = {
  Page,
  load: async (source: ContentSource, { locale, slug }: { locale: string; slug: string }) => {
    const entry = await entryAt('default', source, pageSite, 'pages', locale, slug);
    if (!entry) return undefined;
    const globals = await globalsAt('default', source, locale, {
      required: ['site', 'navigation'],
      blocks: (entry.data as { blocks?: unknown }).blocks,
    });
    return {
      globals,
      data: entry.data,
      locales: await getEntryLocales(
        'default',
        source,
        pageSite,
        'pages',
        entry.id.slice(locale.length + 1),
      ),
      menus: await menusAt('default', source, pageSite, globals.navigation, locale),
    };
  },
};

const get = (path: string, search = '') => {
  const response = { headers: new Headers() };
  const locals: Record<string, unknown> = {};
  return Promise.resolve(
    preview(
      {
        params: { path },
        request: new Request(`https://demo.example/_preview/${path}${search}`),
        url: new URL(`https://demo.example/_preview/${path}${search}`),
        response,
        locals,
      },
      {
        getEntry: async (collection: string, id: string) => {
          const entries =
            collection === 'globals' ? globalsBuilt : collection === 'pages' ? pagesBuilt : built;
          return entries[id] ? { id, data: entries[id] } : undefined;
        },
        getCollection: async (collection: string) =>
          Object.entries(
            collection === 'globals' ? globalsBuilt : collection === 'pages' ? pagesBuilt : built,
          ).map(([id, data]) => ({
            id,
            data,
          })),
      },
    ),
  ).then((result) => ({ result, response, locals }));
};

const canvasEnvelope = (overrides: Record<string, unknown> = {}) => ({
  mode: 'canvas',
  protocol: 1,
  requestId: 'render-1',
  epoch: 'entry-session-1',
  entry: { collection: 'listings', id: 'mill-house' },
  locale: 'en',
  contentVersion: 3,
  snapshots: { en: { title: 'Unsaved title' } },
  ...overrides,
});

const post = (
  path: string,
  envelope: unknown = canvasEnvelope(),
  headers: Record<string, string> = {},
) => {
  const response = { headers: new Headers() };
  const locals: Record<string, unknown> = {};
  const url = new URL(`https://demo.example/_preview/${path}`);
  const body = new URLSearchParams({ snapshot: JSON.stringify(envelope) });
  return Promise.resolve(
    preview(
      {
        params: { path },
        request: new Request(url, {
          method: 'POST',
          headers: { origin: url.origin, ...headers },
          body,
        }),
        url,
        response,
        locals,
      },
      {
        getEntry: async (collection: string, id: string) => {
          const entries =
            collection === 'globals' ? globalsBuilt : collection === 'pages' ? pagesBuilt : built;
          return entries[id] ? { id, data: entries[id] } : undefined;
        },
        getCollection: async (collection: string) =>
          Object.entries(
            collection === 'globals' ? globalsBuilt : collection === 'pages' ? pagesBuilt : built,
          ).map(([id, data]) => ({ id, data })),
      },
    ),
  ).then((result) => ({ result, response, locals }));
};

beforeEach(() => {
  session = { user: { id: 'u1', role: 'editor' } };
  loader = entryLoader;
  rows.length = 0;
});

test.each(['editor', 'owner'])(
  'a %s can render unsaved Canvas snapshots without writing drafts',
  async (role) => {
    session = { user: { id: 'u1', role } };
    rows.push({
      path: 'src/content/listings/en/mill-house.yaml',
      contents: 'title: "Saved draft"\n',
    });
    const stored = structuredClone(rows);

    const rendered = (await post('listings/mill-house')).result as {
      Component: unknown;
      props: unknown;
      canvasManifest: string;
    };
    expect(rendered).toMatchObject({
      Component: Page,
      props: { data: { title: 'Unsaved title' }, locale: 'en' },
    });
    expect(JSON.parse(rendered.canvasManifest)).toEqual({
      mode: 'canvas',
      status: 'success',
      protocol: 1,
      requestId: 'render-1',
      epoch: 'entry-session-1',
      entry: { collection: 'listings', id: 'mill-house' },
      locale: 'en',
      contentVersion: 3,
      entryDirectory: '/nested/site/admin/api/entries',
    });
    expect(rows).toEqual(stored);
  },
);

test('Canvas validates only the locale the loader reads', async () => {
  const { result } = await post(
    'listings/mill-house',
    canvasEnvelope({
      snapshots: {
        en: { title: 'Unsaved title' },
        de: { title: 3 },
      },
    }),
  );
  expect(result).toMatchObject({ props: { data: { title: 'Unsaved title' } } });
});

test('Canvas resolves a localized address to the stable file identity carried through locals', async () => {
  const { result, locals } = await post(
    'de/startseite',
    canvasEnvelope({
      entry: { collection: 'pages', id: 'home' },
      locale: 'de',
      contentVersion: 7,
      snapshots: { de: { title: 'Ungespeichert', slug: 'startseite' } },
    }),
  );

  expect(result).toMatchObject({ Component: Page, props: { data: { title: 'Ungespeichert' } } });
  expect(locals.handoverCanvas).toEqual({
    protocol: 1,
    requestId: 'render-1',
    epoch: 'entry-session-1',
    entry: { collection: 'pages', id: 'home' },
    locale: 'de',
    contentVersion: 7,
  });
});

test.each([
  ['the wrong file', { entry: { collection: 'listings', id: 'other-house' } }],
  ['the wrong collection', { entry: { collection: 'pages', id: 'mill-house' } }],
  ['the wrong locale', { locale: 'de', snapshots: { de: { title: 'Falsch' } } }],
])('Canvas refuses an otherwise valid snapshot for %s', async (_name, override) => {
  const { result, locals } = await post('listings/mill-house', canvasEnvelope(override));
  expect((result as Response).status).toBe(409);
  expect(locals.handoverCanvas).toBeUndefined();
  const html = await (result as Response).text();
  expect(html).toContain('data-handover-canvas-manifest');
  expect(html).toContain('"status":"error"');
});

test('ordinary preview GET never creates Canvas request-local identity', async () => {
  const { result, locals } = await get('listings/mill-house', '?at=42');
  expect(result).toMatchObject({
    Component: Page,
    previewResult: {
      status: 'success',
      url: '/_preview/listings/mill-house',
      version: '42',
    },
  });
  expect(locals.handoverCanvas).toBeUndefined();
});

test('a signed-out Canvas request is unauthorized', async () => {
  session = null;
  const response = (await post('listings/mill-house')).result as Response;
  expect(response.status).toBe(401);
  expect(await response.text()).toContain('data-handover-canvas-manifest');
});

test.each([
  ['missing Origin', { origin: '' }],
  ['foreign Origin', { origin: 'https://evil.example' }],
  ['conflicting fetch metadata', { 'sec-fetch-site': 'cross-site' }],
])('Canvas rejects %s', async (_name, headers) => {
  expect(
    ((await post('listings/mill-house', canvasEnvelope(), headers)).result as Response).status,
  ).toBe(403);
});

test('Canvas rejects a malformed snapshot envelope', async () => {
  const { result } = await post('listings/mill-house', {
    ...canvasEnvelope(),
    contentVersion: -1,
  });
  expect((result as Response).status).toBe(400);
});

test('Canvas rejects an encoded body over 5 MiB even when it arrives as a stream', async () => {
  const url = new URL('https://demo.example/_preview/listings/mill-house');
  const response = { headers: new Headers() };
  const chunk = new Uint8Array(3 * 1024 * 1024).fill(97);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const request = new Request(url, {
    method: 'POST',
    headers: {
      origin: url.origin,
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': '1',
    },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  const result = await preview(
    { params: { path: 'listings/mill-house' }, request, url, response, locals: {} },
    {} as AstroContent<string>,
  );
  expect((result as Response).status).toBe(413);
  expect((result as Response).headers.get('cache-control')).toBe('private, no-store');
});

test('a signed-out request never learns whether the page exists', async () => {
  session = null;
  const { result } = await get('listings/mill-house', '?at=42');
  expect((result as Response).status).toBe(401);
  expect((result as Response).headers.get('content-type')).toContain('text/html');
  const html = await (result as Response).text();
  expect(html).toContain('data-handover-preview-result="error"');
  expect(html).toContain('data-handover-preview-url="/_preview/listings/mill-house"');
  expect(html).toContain('data-handover-preview-version="42"');
  expect(html).toContain('data-handover-preview-code="401"');
});

test('a path the site serves no page at is not found', async () => {
  expect(((await get('listings/mill-house/gallery')).result as Response).status).toBe(404);
  expect(((await get('samples/everything')).result as Response).status).toBe(404);
});

// The gate is on the refusals too: a 401 that a CDN cached, or that a stranger's page could frame.
test.each([
  ['signed out', null, 'listings/mill-house'],
  ['no such page', { user: { id: 'u1' } }, 'nope/nope/nope'],
])('%s carries the gate', async (_name, who, path) => {
  session = who;
  const { headers } = (await get(path)).result as Response;
  expect(headers.get('cache-control')).toBe('private, no-store');
  expect(headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
  // A draft page's links would otherwise tell every site they point at the preview's address.
  expect(headers.get('referrer-policy')).toBe('no-referrer');
});

test('a rendered page carries the gate too', async () => {
  const { response } = await get('listings/mill-house');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
});

// The row is what the editor has typed and not published; the build still holds "Mill House".
test('an entry renders its own component from the draft, not from the build', async () => {
  rows.push({
    path: 'src/content/listings/de/mill-house.yaml',
    contents: 'title: "Die alte Mühle"\n',
  });

  expect((await get('de/listings/mill-house')).result).toEqual({
    Component: Page,
    props: { data: { title: 'Die alte Mühle' }, locale: 'de' },
    previewResult: {
      status: 'success',
      url: '/_preview/de/listings/mill-house',
      version: '',
    },
  });
});

test("an index renders the collection's index component with the drafts in the list", async () => {
  rows.push({ path: 'src/content/listings/en/barn.yaml', contents: 'title: "The Barn"\n' });

  expect((await get('')).result).toEqual({
    Component: Index,
    props: { listings: ['en/mill-house', 'en/barn'], locale: 'en' },
    previewResult: { status: 'success', url: '/_preview/', version: '' },
  });
});

// Tier 2: the entry has never been built.
test('an entry the build has never seen renders from its draft alone', async () => {
  rows.push({ path: 'src/content/listings/en/barn.yaml', contents: 'title: "The Barn"\n' });

  expect((await get('listings/barn')).result).toEqual({
    Component: Page,
    props: { data: { title: 'The Barn' }, locale: 'en' },
    previewResult: { status: 'success', url: '/_preview/listings/barn', version: '' },
  });
});

test('an address the loader has no entry for is not found', async () => {
  expect(((await get('listings/no-such-house')).result as Response).status).toBe(404);
});

test('a draft its collection refuses is a readable failure naming the field', async () => {
  rows.push({ path: 'src/content/listings/en/mill-house.yaml', contents: 'title: 3\n' });

  const { result } = await get('listings/mill-house');
  expect((result as Response).status).toBe(422);
  expect(await (result as Response).text()).toContain(
    'src/content/listings/en/mill-house.yaml › title:',
  );
});

test('a Canvas render error returns escaped, controlled result metadata', async () => {
  rows.push({
    path: 'src/content/listings/en/mill-house.yaml',
    contents: 'title: 3\n',
  });
  const attack = '</script><img src=x onerror=alert(1)>';
  const { result } = await post(
    'listings/mill-house',
    canvasEnvelope({ requestId: attack, snapshots: { en: { title: 3 } } }),
  );

  expect((result as Response).status).toBe(422);
  expect((result as Response).headers.get('content-type')).toContain('text/html');
  const html = await (result as Response).text();
  expect(html).toContain('data-handover-canvas-manifest');
  expect(html).toContain('\\u003c/script\\u003e');
  expect(html).not.toContain(attack);
  expect(html).not.toContain('<img');
});

test.each(['home', 'de/startseite'])(
  'an incomplete English Impressum does not block the homepage at %s',
  async (path) => {
    rows.push({ path: 'src/content/pages/en/impressum.yaml', contents: 'title: null\n' });
    const { result } = await get(path);
    expect(result).toMatchObject({ Component: Page });
    expect(result).toMatchObject({
      props: {
        menus: {
          header: [
            {
              label: path === 'home' ? 'impressum' : 'Impressum',
              href: path === 'home' ? '/impressum' : '/de/impressum',
            },
          ],
        },
      },
    });
  },
);

test('localized address lookup ignores unrelated invalid drafts', async () => {
  rows.push(
    { path: 'src/content/pages/en/home.yaml', contents: 'title: Home\nslug: welcome\n' },
    { path: 'src/content/pages/en/impressum.yaml', contents: 'title: null\n' },
  );
  expect((await get('welcome')).result).toMatchObject({
    Component: Page,
    props: { data: { title: 'Home' } },
  });
  expect(((await get('missing')).result as Response).status).toBe(404);
});

test('a switcher can link an incomplete translation without blocking the current locale', async () => {
  rows.push({ path: 'src/content/pages/en/home.yaml', contents: 'title: null\n' });
  expect((await get('de/startseite')).result).toMatchObject({
    Component: Page,
    props: {
      locales: [
        { locale: 'en', url: '/home' },
        { locale: 'de', url: '/de/startseite' },
      ],
    },
  });
});

test.each(['impressum', 'legal-notice'])(
  'the incomplete page itself still fails validation at %s',
  async (path) => {
    rows.push({
      path: 'src/content/pages/en/impressum.yaml',
      contents: `title: null\n${path === 'legal-notice' ? 'slug: legal-notice\n' : ''}`,
    });
    const { result } = await get(path);
    expect((result as Response).status).toBe(422);
    expect(await (result as Response).text()).toContain(
      'src/content/pages/en/impressum.yaml › title:',
    );
  },
);

test('a collection whose contents are rendered still validates its drafts', async () => {
  rows.push({ path: 'src/content/listings/en/barn.yaml', contents: 'title: null\n' });
  expect(((await get('')).result as Response).status).toBe(422);
});

// Both are the site's own mistake and only preview can see them, so they say what to write.
test('a collection with no loader says so rather than rendering nothing', async () => {
  const { result } = await get('unwired/anything');
  expect((result as Response).status).toBe(500);
  expect(await (result as Response).text()).toContain('cms.config.ts needs load:');
});

test('a loader missing the pair the page needs says which one', async () => {
  loader = { load: entryLoader.load, Page };
  const { result } = await get('');
  expect((result as Response).status).toBe(500);
  expect(await (result as Response).text()).toContain('loadIndex and Index');
});

const invalidCta = {
  path: 'src/content/globals/en/cta-newsletter.yaml',
  contents: 'button:\n  type: entry\n',
};

test('an incomplete unused global does not block Home preview', async () => {
  rows.push(invalidCta);
  const { result } = await get('home');
  expect(result).toMatchObject({
    Component: Page,
    props: { globals: { site: { name: 'Handover' } } },
  });
  expect(result).not.toHaveProperty('props.globals.cta-newsletter');
});

test.each([
  [{ _type: 'cta', _ref: 'globals/cta-newsletter' }],
  [{ _type: 'columns', columns: [{ blocks: [{ _type: 'cta', _ref: 'globals/cta-newsletter' }] }] }],
])(
  'a referenced invalid global, at any block depth, is a 422 with the field path: %j',
  async (block) => {
    rows.push(invalidCta, {
      path: 'src/content/pages/en/home.yaml',
      contents: JSON.stringify({ title: 'Home', blocks: [block] }),
    });
    const { result } = await get('home');
    expect((result as Response).status).toBe(422);
    expect(await (result as Response).text()).toContain(
      'This draft cannot be rendered:\nsrc/content/globals/en/cta-newsletter.yaml › button.ref:',
    );
    expect((result as Response).headers.get('cache-control')).toBe('private, no-store');
    expect((result as Response).headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect((result as Response).headers.get('content-security-policy')).toBe(
      "frame-ancestors 'self'",
    );
    expect((result as Response).headers.get('referrer-policy')).toBe('no-referrer');
  },
);

test.each([
  ['site', 'name'],
  ['navigation', 'menus'],
])(
  'the layout still validates its required %s global without block references',
  async (name, field) => {
    rows.push({ path: `src/content/globals/en/${name}.yaml`, contents: '{}' });
    const { result } = await get('home');
    expect((result as Response).status).toBe(422);
    expect(await (result as Response).text()).toContain(
      `src/content/globals/en/${name}.yaml › ${field}:`,
    );
  },
);

test.each(['site', 'navigation', 'cta-newsletter'])(
  'a required global deleted in the draft is a readable 422: %s',
  async (name) => {
    rows.push(
      { path: `src/content/globals/en/${name}.yaml`, contents: '' },
      {
        path: 'src/content/pages/en/home.yaml',
        contents: JSON.stringify({
          title: 'Home',
          blocks: [{ _type: 'cta', _ref: 'globals/cta-newsletter' }],
        }),
      },
    );
    const { result } = await get('home');
    expect((result as Response).status).toBe(422);
    expect(await (result as Response).text()).toContain(
      `src/content/globals/en/${name}.yaml: No global "${name}" in this language`,
    );
  },
);

test('a nested reference renders validated draft data for a global absent from the build', async () => {
  rows.push(
    { path: 'src/content/globals/en/new-cta.yaml', contents: 'heading: New CTA\n' },
    {
      path: 'src/content/pages/en/home.yaml',
      contents: JSON.stringify({
        title: 'Home',
        blocks: [{ columns: [{ blocks: [{ _ref: 'globals/new-cta' }] }] }],
      }),
    },
  );
  expect((await get('home')).result).toMatchObject({
    Component: Page,
    props: { globals: { 'new-cta': { heading: 'NEW CTA' } } },
  });
});
