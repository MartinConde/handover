import { texts } from 'virtual:handover/index';
import { afterEach, expect, test, vi } from 'vitest';
import { GET } from '../api.js';
import {
  ctx,
  heldDrafts,
  overlayRows,
  pendingDrafts,
  resetContainers,
  resetMocks,
  resetState,
  state,
} from './harness.js';

const { workerMailerMock, configMock, indexMock, cloudflareMock, authMock, coreMock } =
  await vi.hoisted(async () => import('./harness.js'));

vi.mock('worker-mailer', () => workerMailerMock());
vi.mock('virtual:handover/config', () => configMock());
vi.mock('virtual:handover/index', () => indexMock());
vi.mock('cloudflare:workers', () => cloudflareMock());
vi.mock('../../auth.js', async (original) =>
  authMock((await original()) as Record<string, unknown>),
);
vi.mock('@handover/core', async (original) =>
  coreMock((await original()) as Record<string, unknown>),
);

afterEach(() => {
  vi.unstubAllGlobals();
  resetContainers();
  resetMocks();
  resetState();
  for (const key of Object.keys(texts)) delete texts[key];
});

// The site settings list: the cards, in cms.config.ts order.
test('the globals list names each global and the languages it has a file in', async () => {
  state.locales = ['en', 'de'];
  pendingDrafts.mockImplementationOnce(async () => []);

  const res = await GET(ctx('globals'));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    globals: [
      {
        key: 'site',
        label: 'Site details',
        labels: { en: 'Site details', de: 'Website-Angaben' },
        description: 'Contact details and footer text',
        locales: ['en'],
        pending: false,
        edited: null,
      },
    ],
    locales: ['en', 'de'],
  });
  state.locales = ['en'];
});

test('a global with a draft ahead of the repository carries the pending dot', async () => {
  state.locales = ['en', 'de'];
  const row = {
    path: 'src/content/globals/de/site.yaml',
    contents: 'footerText: "Küstenhäuser"\n',
    updatedAt: 1755864000000,
  };
  overlayRows.mockImplementationOnce(async () => [row]);
  pendingDrafts.mockImplementationOnce(async () => [row]);

  const res = await GET(ctx('globals'));

  const { globals } = (await res.json()) as {
    globals: { locales: string[]; pending: boolean }[];
  };
  const [global] = globals;
  expect(global?.pending).toBe(true);
  // The German file is a draft and has never been committed, and the card counts it all the same.
  expect(global?.locales).toEqual(['en', 'de']);
  state.locales = ['en'];
});

test('a global somebody has open says who', async () => {
  state.holders = { 'globals/site': { id: 'u2', name: 'Anna Berg' } };

  const res = await GET(ctx('globals'));

  const { globals } = (await res.json()) as { globals: { editing?: unknown }[] };
  expect(globals[0]?.editing).toEqual({ id: 'u2', name: 'Anna Berg' });
  state.holders = {};
});

test('the pending list is what the drafts hold that the repository does not', async () => {
  const res = await GET(ctx('drafts'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    defaultLocale: 'en',
    entries: [
      {
        key: 'listings/mill-house',
        title: 'The Mill House',
        collection: 'listings',
        locales: ['en'],
        files: ['src/content/listings/en/mill-house.yaml'],
        updated_at: 1755864000000,
        held_by: null,
      },
    ],
  });
});

// The landing page.
test('the dashboard lists what was edited and what was published, newest first', async () => {
  state.publishes = [{ entry: 'posts/hello', at: 1755950000000, by: 'Martin Conde' }];
  state.editors = { 'src/content/listings/en/mill-house.yaml': 'Anna Berg' };

  const res = await GET(ctx('dashboard'));

  expect(res.status).toBe(200);
  const { recent } = (await res.json()) as { recent: Record<string, unknown>[] };
  expect(recent).toEqual([
    {
      key: 'posts/hello',
      title: 'Hello',
      collection: 'posts',
      href: '/admin/c/posts/hello',
      at: 1755950000000,
      by: 'Martin Conde',
      kind: 'publish',
    },
    {
      key: 'listings/mill-house',
      title: 'The Mill House',
      collection: 'listings',
      href: '/admin/c/listings/mill-house',
      at: 1755864000000,
      // Who typed it, which is not who published it: the two rows carry different verbs.
      by: 'Anna Berg',
      kind: 'edit',
    },
  ]);
});

// The draft is what the client is looking at; the publish it was last in is behind it.
test('an entry with unpublished changes is described by the edit and not by the publish', async () => {
  state.publishes = [{ entry: 'listings/mill-house', at: 1755950000000, by: 'Martin Conde' }];
  state.holders = { 'listings/mill-house': { id: 'u2', name: 'Anna Berg' } };

  const { recent } = (await (await GET(ctx('dashboard'))).json()) as {
    recent: Record<string, unknown>[];
  };

  expect(recent).toEqual([
    expect.objectContaining({
      key: 'listings/mill-house',
      at: 1755864000000,
      kind: 'edit',
      editing: { id: 'u2', name: 'Anna Berg' },
    }),
  ]);
  state.holders = {};
});

// A global is edited at its own address, not under /admin/c/.
test('a global on the dashboard is named and addressed the way Site settings names it', async () => {
  pendingDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/globals/en/site.yaml',
      contents: 'footerText: "Coastal homes since 2009"\n',
      updatedAt: 1755864000000,
    },
  ]);

  const { recent } = (await (await GET(ctx('dashboard'))).json()) as {
    recent: Record<string, unknown>[];
  };

  expect(recent[0]).toMatchObject({
    title: 'Site details',
    labels: { en: 'Site details', de: 'Website-Angaben' },
    href: '/admin/site/site',
  });
});

test('translation health counts the languages an entry owes and the ones behind their source', async () => {
  state.locales = ['en', 'de'];

  const { translations } = (await (await GET(ctx('dashboard'))).json()) as {
    translations: { defaultLocale: string; locales: { locale: string }[] };
  };

  expect(translations).toEqual({
    defaultLocale: 'en',
    locales: [
      { locale: 'en', missing: 0, stale: 0, unfinished: 0, machine: 0, where: [] },
      // Everything the index holds but `posts/taken`, which is the one entry with two files.
      {
        locale: 'de',
        missing: 5,
        stale: 1,
        unfinished: 0,
        machine: 0,
        where: ['listings', 'presenters', 'posts'],
      },
    ],
  });
  state.locales = ['en'];
});

// The build's inventories with the drafts over them; a global counts though it has no list.
test('translation health counts unfinished and machine-written languages, drafts and globals included', async () => {
  state.locales = ['en', 'de'];
  Object.assign(texts, {
    'posts/taken': { en: { paths: ['title', 'seo.title'] }, de: { paths: ['title'] } },
    'globals/site': { en: { paths: ['footerText'] } },
  });
  overlayRows.mockImplementationOnce(async () => [
    {
      path: 'src/content/globals/de/site.yaml',
      contents: '_version: 1\n_machine: [footerText]\nfooterText: "Häuser an der Küste"\n',
    },
  ]);

  const { translations } = (await (await GET(ctx('dashboard'))).json()) as {
    translations: { locales: { locale: string }[] };
  };

  expect(translations.locales).toEqual([
    expect.objectContaining({ locale: 'en', unfinished: 0, machine: 0 }),
    expect.objectContaining({ locale: 'de', unfinished: 1, machine: 1 }),
  ]);
});

// Show opens the list filtered to what is owed, and a partly written file is owed.
test('translation health sends Show to a collection whose only debt is a partly written file', async () => {
  state.locales = ['en', 'de'];
  Object.assign(texts, { 'presenters/rosa-hale': { en: { paths: ['name', 'portrait.alt'] } } });
  overlayRows.mockImplementationOnce(async () => [
    {
      path: 'src/content/presenters/de/rosa-hale.yaml',
      contents: '_version: 1\nname: Rosa Hale\n',
    },
  ]);

  const { translations } = (await (await GET(ctx('dashboard'))).json()) as {
    translations: { locales: { locale: string; where: string[] }[] };
  };

  expect(translations.locales[1]).toMatchObject({
    locale: 'de',
    unfinished: 1,
    where: ['listings', 'presenters', 'posts'],
  });
});

test('a one-language site has nothing to report about its languages', async () => {
  const { translations } = (await (await GET(ctx('dashboard'))).json()) as { translations: null };

  expect(translations).toBe(null);
});

test('the build line names who published, and says nothing over a commit that was not one', async () => {
  const line = async () =>
    ((await (await GET(ctx('dashboard'))).json()) as { published: unknown }).published;

  expect(await line()).toEqual({ at: 1755864000000, by: 'Anna Berg' });

  state.lastCommitRow = { sha: 'def456', at: 1755864000000, kind: 'entry-rename', by: 'Anna Berg' };
  expect(await line()).toBe(null);
});

// One entry, one name, on every screen.
test('a global waiting to be published is listed under its label', async () => {
  pendingDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/globals/en/site.yaml',
      contents: 'footerText: "Coastal homes since 2009"\n',
      updatedAt: 1755864000000,
    },
  ]);

  const res = await GET(ctx('drafts'));

  expect(await res.json()).toEqual({
    defaultLocale: 'en',
    entries: [
      {
        key: 'globals/site',
        title: 'Site details',
        labels: { en: 'Site details', de: 'Website-Angaben' },
        collection: 'globals',
        locales: ['en'],
        files: ['src/content/globals/en/site.yaml'],
        updated_at: 1755864000000,
        held_by: null,
      },
    ],
  });
});

// The drawer picks entries, so the grouping is done where the titles are.
test('the pending list is one row per entry, whatever languages of it are waiting', async () => {
  state.locales = ['en', 'de'];
  pendingDrafts.mockImplementationOnce(async () => [
    { path: 'src/content/listings/de/mill-house.yaml', contents: 'x', updatedAt: 1755864000000 },
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: 'y',
      updatedAt: 1755863000000,
      pendingRedirects: [{ from: '/listings/mill', to: '/listings/mill-house' }],
    },
    { path: 'src/content/pages/en/home.yaml', contents: 'z', updatedAt: 1755862000000 },
  ]);
  heldDrafts.mockImplementationOnce(async () => ({
    'pages/home': { id: 'u2', name: 'Martin' },
  }));
  const res = await GET(ctx('drafts'));
  expect(await res.json()).toEqual({
    defaultLocale: 'en',
    entries: [
      {
        key: 'listings/mill-house',
        title: 'The Mill House',
        collection: 'listings',
        // In the order the site declares them, not the order the rows came back in.
        locales: ['en', 'de'],
        files: [
          'src/content/listings/de/mill-house.yaml',
          'src/content/listings/en/mill-house.yaml',
        ],
        // What the address change on one of its rows owes; the file itself is never a row.
        redirects: 1,
        updated_at: 1755864000000,
        held_by: null,
      },
      {
        key: 'pages/home',
        // Nothing in the index and nothing published: the file name is what there is to call it.
        title: 'home',
        collection: 'pages',
        locales: ['en'],
        files: ['src/content/pages/en/home.yaml'],
        updated_at: 1755862000000,
        // The hold is the entry's, so it is read once rather than per file.
        held_by: { id: 'u2', name: 'Martin' },
      },
    ],
  });
});

test('the entry list is the built index with the pending drafts over it', async () => {
  overlayRows.mockImplementationOnce(async () => [
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: 'title: "The Mill House, renamed"\n',
    },
  ]);
  const res = await GET(ctx('entries/listings'));
  expect(res.status).toBe(200);
  const listed = (await res.json()) as { entries: unknown; templates: unknown };
  expect(listed.entries).toEqual([
    {
      id: 'mill-house',
      locales: {
        en: {
          title: 'The Mill House, renamed',
          path: 'src/content/listings/en/mill-house.yaml',
        },
      },
      // Which rows the duplicate dialog can offer "including unpublished changes?" about.
      pending: true,
      // The draft row is the last touch; nobody is signed in on this request, so no name.
      edited: { key: 'listings/mill-house', at: 1755864000000, by: null, kind: 'edit' },
    },
    {
      id: 'seaview-cottage',
      locales: {
        en: {
          title: 'Seaview Cottage',
          path: 'src/content/listings/en/seaview-cottage.yaml',
        },
      },
      edited: null,
    },
  ]);
  // The starters the New entry dialog offers beside Blank, read at build with the index.
  expect(listed.templates).toEqual(['house']);
});

// The list's language filter narrows to the rows a language is missing or stale in.
test('a row names the languages the build marked stale', async () => {
  const { entries } = (await (await GET(ctx('entries/posts'))).json()) as {
    entries: { id: string; stale?: string[] }[];
  };

  expect(entries.map((e) => [e.id, e.stale])).toEqual([
    ['hello', undefined],
    ['taken', ['de']],
  ]);
});

// Stale is the build's and partial is counted now, so one language can be both.
test('a row carries partial and machine languages beside stale, and none of the paths', async () => {
  state.locales = ['en', 'de'];
  Object.assign(texts, {
    'posts/taken': {
      en: { paths: ['title', 'seo.title'] },
      de: { paths: ['title'], machine: true },
    },
  });

  const { entries } = (await (await GET(ctx('entries/posts'))).json()) as {
    entries: Record<string, unknown>[];
  };

  expect(entries.find((e) => e.id === 'taken')).toMatchObject({
    stale: ['de'],
    partial: { de: [1, 2] },
    machine: ['de'],
  });
  expect(JSON.stringify(entries)).not.toContain('seo.title');
});

// The dashboard's line, on every row: the draft's editor where there is a draft.
test('the entry list says who last touched each row, and whether that is out yet', async () => {
  state.publishes = [{ entry: 'listings/seaview-cottage', at: 1755950000000, by: 'Martin Conde' }];
  state.editors = { 'src/content/listings/en/mill-house.yaml': 'Anna Berg' };

  const { entries } = (await (await GET(ctx('entries/listings'))).json()) as {
    entries: { id: string; edited: unknown }[];
  };

  expect(entries.map((e) => [e.id, e.edited])).toEqual([
    [
      'mill-house',
      { key: 'listings/mill-house', at: 1755864000000, by: 'Anna Berg', kind: 'edit' },
    ],
    [
      'seaview-cottage',
      { key: 'listings/seaview-cottage', at: 1755950000000, by: 'Martin Conde', kind: 'publish' },
    ],
  ]);
  state.publishes = [];
  state.editors = {};
});

// The badge on the row: the same answer the members screen gives, seen from the entry's side.
test('the entry list says who is editing a row, and nothing on the rows nobody is in', async () => {
  state.holders = { 'listings/mill-house': { id: 'u2', name: 'Anna Berg' } };

  const res = await GET(ctx('entries/listings'));

  const { entries } = (await res.json()) as { entries: { id: string; editing?: unknown }[] };
  expect(entries.map((e) => [e.id, e.editing])).toEqual([
    ['mill-house', { id: 'u2', name: 'Anna Berg' }],
    ['seaview-cottage', undefined],
  ]);
  state.holders = {};
});

test('a collection keyed on another field lists its drafts by that field', async () => {
  overlayRows.mockImplementationOnce(async () => [
    {
      path: 'src/content/presenters/en/ada-fenwick.yaml',
      contents: 'name: "Ada Fenwick"\n',
    },
  ]);
  const res = await GET(ctx('entries/presenters'));
  expect(((await res.json()) as { entries: unknown }).entries).toEqual([
    {
      id: 'ada-fenwick',
      locales: {
        en: { title: 'Ada Fenwick', path: 'src/content/presenters/en/ada-fenwick.yaml' },
      },
      edited: null,
    },
    {
      id: 'rosa-hale',
      locales: { en: { title: 'Rosa Hale', path: 'src/content/presenters/en/rosa-hale.yaml' } },
      edited: null,
    },
  ]);
});

test('listing an unknown collection is 404', async () => {
  expect((await GET(ctx('entries/nope'))).status).toBe(404);
});

test('the entry list says which languages the site declares', async () => {
  state.locales = ['en', 'de'];

  const body = (await (await GET(ctx('entries/listings'))).json()) as {
    locales: unknown;
    defaultLocale: unknown;
  };

  expect(body.locales).toEqual(['en', 'de']);
  // Which of them a new entry is written in when nothing else is chosen.
  expect(body.defaultLocale).toBe('en');
});

// A menu can point at a collection's index, which is not an entry.
test('the picker list carries each collection with an index page, in every language', async () => {
  state.locales = ['en', 'de'];

  const body = (await (await GET(ctx('entries'))).json()) as { indexes: unknown[] };

  expect(body.indexes).toEqual([
    {
      collection: 'listings',
      index: true,
      path: 'listings',
      title: 'Listings',
      // What the site calls an unlabelled item pointing here, in each language it serves.
      titles: { en: 'Homes', de: 'Häuser' },
      // The collection's own label, capitalised for a picker row, in every interface language.
      labels: { en: 'Homes', de: 'Häuser' },
      locales: ['en', 'de'],
      urls: { en: '/listings', de: '/de/listings' },
    },
    {
      collection: 'posts',
      index: true,
      path: 'posts',
      title: 'Posts',
      titles: { en: 'Posts', de: 'Posts' },
      locales: ['en', 'de'],
      urls: { en: '/blog', de: '/de/blog' },
    },
  ]);
});

// The page picker's one read.
test('the picker list carries every collection with the address each language serves', async () => {
  state.locales = ['en', 'de'];

  const body = (await (await GET(ctx('entries'))).json()) as {
    entries: unknown[];
    locales: unknown;
  };

  expect(body.locales).toEqual(['en', 'de']);
  expect(body.entries).toEqual([
    {
      collection: 'listings',
      hidden: false,
      path: 'listings/mill-house',
      title: 'The Mill House',
      titles: { en: 'The Mill House' },
      hiddenLocales: [],
      locales: ['en'],
      urls: { en: '/listings/mill-house' },
    },
    {
      collection: 'listings',
      hidden: false,
      path: 'listings/seaview-cottage',
      title: 'Seaview Cottage',
      titles: { en: 'Seaview Cottage' },
      hiddenLocales: [],
      locales: ['en'],
      urls: { en: '/listings/seaview-cottage' },
    },
    {
      collection: 'presenters',
      hidden: false,
      path: 'presenters/rosa-hale',
      title: 'Rosa Hale',
      titles: { en: 'Rosa Hale' },
      hiddenLocales: [],
      locales: ['en'],
      urls: {},
    },
    {
      collection: 'posts',
      hidden: false,
      path: 'posts/hello',
      title: 'Hello',
      titles: { en: 'Hello' },
      hiddenLocales: [],
      locales: ['en'],
      urls: { en: '/blog/hello' },
    },
    {
      collection: 'posts',
      hidden: false,
      path: 'posts/taken',
      title: 'Taken',
      titles: { en: 'Taken', de: 'Belegt' },
      hiddenLocales: [],
      locales: ['en', 'de'],
      urls: { en: '/blog/taken', de: '/de/blog/belegt' },
    },
  ]);
});

// 3.26 listed a hidden entry with nothing to say about it.
test('the picker says which of its rows is off the site', async () => {
  overlayRows.mockResolvedValueOnce([
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: '_version: 1\n_status: "hidden"\ntitle: "The Mill House"\n',
    },
  ]);

  const body = (await (await GET(ctx('entries'))).json()) as {
    entries: { hidden: boolean; hiddenLocales: string[] }[];
  };

  expect(body.entries.map((e) => e.hidden)).toEqual([true, false, false, false, false]);
  expect(body.entries.map((e) => e.hiddenLocales)).toEqual([['en'], [], [], [], []]);
});

test('the drawer reads the hold as the entry\u2019s, whichever of its files carries it', async () => {
  heldDrafts.mockResolvedValueOnce({
    'listings/mill-house': { id: 'u1', name: 'Anna Berg' },
  });

  const res = await GET(ctx('drafts'));

  expect(await res.json()).toEqual({
    defaultLocale: 'en',
    entries: [
      {
        key: 'listings/mill-house',
        title: 'The Mill House',
        collection: 'listings',
        locales: ['en'],
        files: ['src/content/listings/en/mill-house.yaml'],
        updated_at: 1755864000000,
        held_by: { id: 'u1', name: 'Anna Berg' },
      },
    ],
  });
});

test('a plain collection label is available to the picker without changing menu titles', async () => {
  const { default: config } = await import('virtual:handover/config');
  const collection = config.collections.listings;
  if (!collection) throw new Error('listings collection missing');
  const original = collection.label;
  try {
    collection.label = 'homes';
    const body = (await (await GET(ctx('entries'))).json()) as {
      indexes: { collection: string; title: string; labels?: unknown }[];
    };
    expect(body.indexes.find((row) => row.collection === 'listings')).toMatchObject({
      title: 'Listings',
      labels: { en: 'Homes' },
    });
  } finally {
    collection.label = original;
  }
});
