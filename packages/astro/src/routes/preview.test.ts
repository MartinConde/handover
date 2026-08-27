import { beforeEach, expect, test, vi } from 'vitest';
import { preview } from './preview.js';

// What the session is worth is proven against a real D1 in core's auth.test.ts; what this file
// tests is which requests ever get past it, what every answer carries either way, and what a
// request that is let through renders.
let session: { user: { id: string } } | null = null;
vi.mock('../auth.js', () => ({
  createAuth: () => ({ api: { getSession: async () => session } }),
}));

const { listing, rows } = await vi.hoisted(async () => {
  const { z } = await import('astro/zod');
  return {
    listing: z.object({ title: z.string() }),
    // The D1 boundary: the rows preview lays over the build, filled per test.
    rows: [] as { path: string; contents: string }[],
  };
});

vi.mock('virtual:handover/config', () => ({
  default: {
    i18n: { locales: ['en', 'de'], defaultLocale: 'en' },
    collections: {
      listings: { schema: listing, route: '/listings/[slug]', index: '/', load: 'listing' },
      pages: { schema: listing, route: '/[slug]' },
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

// The site's own loader, as `src/loaders/listing.ts`: it reads through the source it is handed,
// which is the whole point — the same function the static page calls, over the drafts.
const Page = 'Page.astro';
const Index = 'Index.astro';
let loader: Record<string, unknown> = {};
vi.mock('virtual:handover/loaders', () => ({
  get default() {
    return { listing: loader };
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

const get = (path: string) => {
  const response = { headers: new Headers() };
  return Promise.resolve(
    preview(
      {
        params: { path },
        request: new Request(`https://demo.example/_preview/${path}`),
        url: new URL(`https://demo.example/_preview/${path}`),
        response,
      },
      {
        getEntry: async (_collection: string, id: string) =>
          built[id] ? { id, data: built[id] } : undefined,
        getCollection: async () => Object.entries(built).map(([id, data]) => ({ id, data })),
      },
    ),
  ).then((result) => ({ result, response }));
};

beforeEach(() => {
  session = { user: { id: 'u1' } };
  loader = entryLoader;
  rows.length = 0;
});

test('a signed-out request never learns whether the page exists', async () => {
  session = null;
  const { result } = await get('listings/mill-house');
  expect((result as Response).status).toBe(401);
});

test('a path the site serves no page at is not found', async () => {
  expect(((await get('listings/mill-house/gallery')).result as Response).status).toBe(404);
  expect(((await get('samples/everything')).result as Response).status).toBe(404);
});

// The gate is on the refusals too: a 401 that a CDN cached, or that a stranger's page could
// frame, is the same hole as a rendered one.
test.each([
  ['signed out', null, 'listings/mill-house'],
  ['no such page', { user: { id: 'u1' } }, 'nope/nope/nope'],
])('%s carries the gate', async (_name, who, path) => {
  session = who;
  const { headers } = (await get(path)).result as Response;
  expect(headers.get('cache-control')).toBe('private, no-store');
  expect(headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
});

test('a rendered page carries the gate too', async () => {
  const { response } = await get('listings/mill-house');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
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
  });
});

test("an index renders the collection's index component with the drafts in the list", async () => {
  rows.push({ path: 'src/content/listings/en/barn.yaml', contents: 'title: "The Barn"\n' });

  expect((await get('')).result).toEqual({
    Component: Index,
    props: { listings: ['en/mill-house', 'en/barn'], locale: 'en' },
  });
});

// Tier 2: the entry has never been built, so the site has no route to it and `getEntry` on the
// build has nothing to answer with — the row is the whole page.
test('an entry the build has never seen renders from its draft alone', async () => {
  rows.push({ path: 'src/content/listings/en/barn.yaml', contents: 'title: "The Barn"\n' });

  expect((await get('listings/barn')).result).toEqual({
    Component: Page,
    props: { data: { title: 'The Barn' }, locale: 'en' },
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

// Both are the site's own mistake and only preview can see them, so they say what to write.
test('a collection with no loader says so rather than rendering nothing', async () => {
  const { result } = await get('anything');
  expect((result as Response).status).toBe(500);
  expect(await (result as Response).text()).toContain('cms.config.ts needs load:');
});

test('a loader missing the pair the page needs says which one', async () => {
  loader = { load: entryLoader.load, Page };
  const { result } = await get('');
  expect((result as Response).status).toBe(500);
  expect(await (result as Response).text()).toContain('loadIndex and Index');
});
