import { expect, test, vi } from 'vitest';
import {
  draftSource,
  entryAt,
  getEntryLocales,
  globalsAt,
  menusAt,
  refErrors,
  staticSource,
} from './content.js';

const entries = [
  { id: 'en/mill-house', data: { title: 'Mill House' } },
  { id: 'de/mill-house', data: { title: 'Mühlenhaus' } },
  { id: 'english/not-a-locale', data: { title: 'Trap' } },
];

const source = staticSource<{ listings: { title: string } }>('default', {
  getEntry: async (_c, id) => entries.find((e) => e.id === id),
  getCollection: async () => entries,
});

test('getCollection keeps only entries under the locale folder', async () => {
  const got = await source.getCollection('listings', 'en');
  expect(got).toEqual([{ id: 'en/mill-house', data: { title: 'Mill House' } }]);
});

test('getEntry returns undefined for a missing id', async () => {
  expect(await source.getEntry('listings', 'fr/mill-house')).toBeUndefined();
});

test('the globals of one language are keyed by file name, without the locale folder', async () => {
  const globals = staticSource<{ globals: unknown }>('default', {
    getEntry: async () => undefined,
    getCollection: async () => [
      { id: 'en/site', data: { name: 'Coastal Homes' } },
      { id: 'en/cta-newsletter', data: { heading: 'Ready to move?' } },
      { id: 'de/site', data: { name: 'Coastal Homes GmbH' } },
    ],
  });

  expect(await globalsAt('default', globals, 'de')).toEqual({
    site: { name: 'Coastal Homes GmbH' },
  });
});

test('selected globals read each required name once, including nested block references', async () => {
  const getEntry = vi.fn(async (_collection: string, id: string) => ({ id, data: { id } }));
  const getCollection = vi.fn(async () => []);
  const globals = await globalsAt('default', { getEntry, getCollection }, 'de', {
    required: ['site', 'globals/site', 'navigation'],
    blocks: [
      { _ref: 'globals/cta-newsletter' },
      { columns: [{ blocks: [{ _ref: 'cta-newsletter' }, { _ref: 'footer' }] }] },
    ],
  });
  expect(globals).toEqual({
    site: { id: 'de/site' },
    navigation: { id: 'de/navigation' },
    'cta-newsletter': { id: 'de/cta-newsletter' },
    footer: { id: 'de/footer' },
  });
  expect(getEntry.mock.calls).toEqual([
    ['globals', 'de/site'],
    ['globals', 'de/navigation'],
    ['globals', 'de/cta-newsletter'],
    ['globals', 'de/footer'],
  ]);
  expect(getCollection).not.toHaveBeenCalled();
});

test('an empty global selection reads no content', async () => {
  const getEntry = vi.fn(async () => undefined);
  const getCollection = vi.fn(async () => [{ id: 'en/unused', data: {} }]);
  expect(await globalsAt('default', { getEntry, getCollection }, 'en', {})).toEqual({});
  expect(getEntry).not.toHaveBeenCalled();
  expect(getCollection).not.toHaveBeenCalled();
});

test('global discovery follows Blocks: values and a ref replacement are not walked', async () => {
  const getEntry = vi.fn(async (_collection: string, id: string) => ({
    id,
    data: { _ref: 'globals/not-recursive' },
  }));
  const getCollection = vi.fn(async () => []);
  const date = Object.assign(new Date('2026-01-01'), { _ref: 'globals/not-a-block' });
  expect(
    await globalsAt('default', { getEntry, getCollection }, 'en', {
      blocks: [null, 'text', date, { _ref: 'globals/cta', child: { _ref: 'not-walked' } }],
    }),
  ).toEqual({ cta: { _ref: 'globals/not-recursive' } });
  expect(getEntry.mock.calls).toEqual([['globals', 'en/cta']]);
});

test.each([undefined, ''])(
  'a required global absent from the build or deleted in a draft names its locale and file',
  async (contents) => {
    const source = draftSource(
      'default',
      {
        getEntry: async () => undefined,
        getCollection: async () => [],
      },
      contents === undefined ? [] : [{ path: 'src/content/globals/de/site.yaml', contents }],
      (_collection, data) => data,
    );
    await expect(globalsAt('default', source, 'de', { required: ['site'] })).rejects.toThrow(
      'src/content/globals/de/site.yaml: No global "site" in this language',
    );
  },
);

// Without `generateId` Astro's glob loader files an entry under its `slug` (F7 in 02-i18n.md).
test('an entry filed under its address rather than its path names the loader option', async () => {
  const misfiled = staticSource<{ pages: unknown }>('default', {
    getEntry: async () => undefined,
    getCollection: async () => [
      { id: 'en/home', data: {} },
      { id: 'startseite', data: {} },
    ],
  });

  await expect(misfiled.getCollection('pages', 'de')).rejects.toThrow(
    'Collection "pages" has an entry filed under "startseite" rather than "<locale>/<name>": its glob loader in src/content.config.ts needs generateId: ({ entry }) => entry.replace(/\\.ya?ml$/, \'\')',
  );
});

const refs = (body: string) =>
  refErrors('default', 'src/content/pages/en/home.yaml', body, ['site', 'cta-newsletter']);

test('a _ref naming a global the site does not declare is named with its file and its path', () => {
  expect(
    refs('blocks:\n  - _type: "cta"\n    _id: "q7r8s9t0"\n    _ref: "globals/newsletter"\n'),
  ).toEqual([
    'src/content/pages/en/home.yaml › blocks[0]._ref: no global "newsletter" is declared in cms.config.ts — it has site, cta-newsletter',
  ]);
});

test('a _ref naming a declared global passes, however deep it sits', () => {
  expect(
    refs(
      'blocks:\n  - _type: "columns"\n    _id: "a1b2c3d4"\n    columns:\n      - _id: "m3n4o5p6"\n        blocks:\n          - _type: "cta"\n            _id: "q7r8s9t0"\n            _ref: "globals/cta-newsletter"\n',
    ),
  ).toEqual([]);
});

// The switcher's own read: which languages an entry can be followed to from the page it is on.
const site = {
  i18n: { locales: ['en', 'de', 'fr'], defaultLocale: 'en' },
  collections: {
    listings: { route: '/listings/[slug]', index: '/listings' },
    samples: {},
    pages: { route: '/[slug]', localizedSlugs: true },
  },
};
const files: Record<string, unknown> = {
  // A `slug` in a collection that did not opt in is an ordinary field of its schema.
  'en/coast': { slug: 'kueste', title: 'Coast' },
  'de/coast': { title: 'Küste' },
  'en/hidden': { _status: 'hidden', title: 'Hidden' },
  'de/hidden': { title: 'Versteckt' },
  'en/offer': { _locales: ['en'], title: 'Offer' },
  'de/offer': { _locales: ['en'], title: 'Angebot' },
  'en/home': { title: 'Home' },
  'de/home': { slug: 'startseite', title: 'Startseite' },
};
const switcherSource = staticSource<{ listings: unknown; samples: unknown; pages: unknown }>(
  'default',
  {
    getEntry: async (_c, id) => (files[id] ? { id, data: files[id] } : undefined),
    getCollection: async () => Object.entries(files).map(([id, data]) => ({ id, data })),
  },
);

// Astro's `getEntry` logs every miss, so the switcher asks which ids exist instead of probing.
test('the switcher never asks by name for a language the entry has no file in', async () => {
  const asked: string[] = [];
  const source = staticSource<{ listings: unknown }>('default', {
    getEntry: async (_c, id) => {
      asked.push(id);
      return files[id] ? { id, data: files[id] } : undefined;
    },
    getCollection: async () => Object.entries(files).map(([id, data]) => ({ id, data })),
  });

  expect(await getEntryLocales('default', source, site, 'listings', 'coast')).toEqual([
    { locale: 'en', url: '/listings/coast' },
    { locale: 'de', url: '/de/listings/coast' },
  ]);
  expect(asked).toEqual(['en/coast', 'de/coast']);
});

test('a hidden file is skipped', async () => {
  expect(await getEntryLocales('default', switcherSource, site, 'listings', 'hidden')).toEqual([
    { locale: 'de', url: '/de/listings/hidden' },
  ]);
});

// A mark contradicting the files is for the CMS to report, not a page to hide.
test('a _locales the files contradict does not take a page out of the switcher', async () => {
  expect(await getEntryLocales('default', switcherSource, site, 'listings', 'offer')).toEqual([
    { locale: 'en', url: '/listings/offer' },
    { locale: 'de', url: '/de/listings/offer' },
  ]);
});

test('a collection nothing renders has nowhere to link', async () => {
  expect(await getEntryLocales('default', switcherSource, site, 'samples', 'coast')).toEqual([]);
});

test('a collection without localized slugs is addressed by the file name', async () => {
  const found = await entryAt('default', switcherSource, site, 'listings', 'en', 'coast');

  expect(found?.id).toBe('en/coast');
  // Its `slug` is a field like any other: nothing is served under it and no link points there.
  expect(await entryAt('default', switcherSource, site, 'listings', 'en', 'kueste')).toBe(
    undefined,
  );
  expect(await getEntryLocales('default', switcherSource, site, 'listings', 'coast')).toEqual([
    { locale: 'en', url: '/listings/coast' },
    { locale: 'de', url: '/de/listings/coast' },
  ]);
});

test('a file with no slug of its own is served under its name', async () => {
  const found = await entryAt('default', switcherSource, site, 'pages', 'en', 'home');

  expect(found?.id).toBe('en/home');
});

// The old file name is a redirect the publish wrote, not a second live page.
test('a file name a slug has moved off does not serve that address', async () => {
  expect(await entryAt('default', switcherSource, site, 'pages', 'de', 'home')).toBe(undefined);
});

test('the address finds the file whose slug it is', async () => {
  const found = await entryAt('default', switcherSource, site, 'pages', 'de', 'startseite');

  expect(found?.id).toBe('de/home');
});

test('an address no file in that language has is nothing', async () => {
  expect(await entryAt('default', switcherSource, site, 'pages', 'en', 'startseite')).toBe(
    undefined,
  );
});

test('the switcher links each language at the address that language serves', async () => {
  expect(await getEntryLocales('default', switcherSource, site, 'pages', 'home')).toEqual([
    { locale: 'en', url: '/home' },
    { locale: 'de', url: '/de/startseite' },
  ]);
});

// The bytes go through the collection's own schema, the site's, so `validate` is passed in.
const built = staticSource<{ listings: { title: string } }>('default', {
  getEntry: async (_c, id) =>
    [
      { id: 'en/mill-house', data: { title: 'Mill House' } },
      { id: 'en/coast', data: { title: 'Coast' } },
      { id: 'de/mill-house', data: { title: 'Mühlenhaus' } },
    ].find((e) => e.id === id),
  getCollection: async () => [
    { id: 'en/mill-house', data: { title: 'Mill House' } },
    { id: 'en/coast', data: { title: 'Coast' } },
    { id: 'de/mill-house', data: { title: 'Mühlenhaus' } },
  ],
});

const drafted = (rows: { path: string; contents: string }[]) =>
  draftSource('default', built, rows, (_collection, data) => data);

test('a drafted entry is read from its row and not from the build', async () => {
  const source = drafted([
    { path: 'src/content/listings/en/mill-house.yaml', contents: 'title: The Mill\n' },
  ]);

  expect(await source.getEntry('listings', 'en/mill-house')).toEqual({
    id: 'en/mill-house',
    data: { title: 'The Mill' },
  });
});

test('an entry no row mentions is the one the build holds', async () => {
  const source = drafted([
    { path: 'src/content/listings/en/mill-house.yaml', contents: 'title: The Mill\n' },
  ]);

  expect(await source.getEntry('listings', 'en/coast')).toEqual({
    id: 'en/coast',
    data: { title: 'Coast' },
  });
});

// An emptied row is how a delete is written down before the build catches up.
test('an emptied row is an entry that has gone', async () => {
  const source = drafted([{ path: 'src/content/listings/en/coast.yaml', contents: '' }]);

  expect(await source.getEntry('listings', 'en/coast')).toBe(undefined);
  expect((await source.getCollection('listings', 'en')).map((e) => e.id)).toEqual([
    'en/mill-house',
  ]);
});

test('a drafted entry keeps its place in the collection and a new one is appended', async () => {
  const source = drafted([
    { path: 'src/content/listings/en/mill-house.yaml', contents: 'title: The Mill\n' },
    { path: 'src/content/listings/en/barn.yaml', contents: 'title: The Barn\n' },
  ]);

  expect(await source.getCollection('listings', 'en')).toEqual([
    { id: 'en/mill-house', data: { title: 'The Mill' } },
    { id: 'en/coast', data: { title: 'Coast' } },
    { id: 'en/barn', data: { title: 'The Barn' } },
  ]);
});

test('rows for another language, another collection or another site file are not this list', async () => {
  const source = drafted([
    { path: 'src/content/listings/de/barn.yaml', contents: 'title: Die Scheune\n' },
    { path: 'src/content/pages/en/barn.yaml', contents: 'title: A page\n' },
    { path: 'src/content/redirects.yaml', contents: 'rules: []\n' },
  ]);

  expect((await source.getCollection('listings', 'en')).map((e) => e.id)).toEqual([
    'en/mill-house',
    'en/coast',
  ]);
});

test('a draft the collection refuses is the schema error and not half an entry', async () => {
  const source = draftSource(
    'default',
    built,
    [{ path: 'src/content/listings/en/mill-house.yaml', contents: 'title: 3\n' }],
    (collection, _data, path) => {
      throw new Error(`${path}: ${collection} wants a string title`);
    },
  );

  await expect(source.getEntry('listings', 'en/mill-house')).rejects.toThrow(
    'src/content/listings/en/mill-house.yaml: listings wants a string title',
  );
});

test('metadata overlays draft edits, additions and deletions without validating page bodies', async () => {
  const source = draftSource(
    'default',
    built,
    [
      {
        path: 'src/content/listings/en/mill-house.yaml',
        contents: 'title: null\nslug: old-mill\n',
      },
      { path: 'src/content/listings/en/coast.yaml', contents: '' },
      { path: 'src/content/listings/en/barn.yaml', contents: 'title: null\n' },
      { path: 'src/content/listings/de/barn.yaml', contents: 'title: null\n' },
    ],
    () => {
      throw new Error('Invalid body');
    },
  );

  expect(await source.getEntryMetadata?.('listings', 'en/mill-house')).toEqual({
    id: 'en/mill-house',
    data: { title: null, slug: 'old-mill' },
  });
  expect(await source.getEntryMetadata?.('listings', 'en/coast')).toBeUndefined();
  expect(await source.getCollectionMetadata?.('listings', 'en')).toEqual([
    { id: 'en/mill-house', data: { title: null, slug: 'old-mill' } },
    { id: 'en/barn', data: { title: null } },
  ]);
  await expect(source.getEntry('listings', 'en/mill-house')).rejects.toThrow('Invalid body');
  await expect(source.getCollection('listings', 'en')).rejects.toThrow('Invalid body');
});

test('one draft source parses and validates each changed path once while keeping metadata raw', async () => {
  const validate = vi.fn((_collection: string, data: unknown) => {
    (data as Record<string, unknown>).checked = true;
    return data;
  });
  const rows = [{ path: 'src/content/listings/en/mill-house.yaml', contents: 'title: The Mill\n' }];
  const first = draftSource('default', built, rows, validate);

  expect(await first.getEntry('listings', 'en/mill-house')).toEqual({
    id: 'en/mill-house',
    data: { title: 'The Mill', checked: true },
  });
  expect(await first.getEntryMetadata?.('listings', 'en/mill-house')).toEqual({
    id: 'en/mill-house',
    data: { title: 'The Mill' },
  });
  expect(await first.getCollection('listings', 'en')).toContainEqual({
    id: 'en/mill-house',
    data: { title: 'The Mill', checked: true },
  });
  expect(validate).toHaveBeenCalledTimes(1);

  const second = draftSource(
    'default',
    built,
    [
      {
        path: 'src/content/listings/en/mill-house.yaml',
        contents: 'title: The Mill House\n',
      },
    ],
    validate,
  );
  expect(await second.getEntry('listings', 'en/mill-house')).toEqual({
    id: 'en/mill-house',
    data: { title: 'The Mill House', checked: true },
  });
  expect(validate).toHaveBeenCalledTimes(2);
});

test.each(['_status: hidden\ntitle: null\n', ''])(
  'metadata links still omit hidden or deleted draft entries',
  async (contents) => {
    const source = draftSource(
      'default',
      switcherSource,
      [{ path: 'src/content/pages/en/home.yaml', contents }],
      () => {
        throw new Error('Invalid body');
      },
    );
    expect(await getEntryLocales('default', source, site, 'pages', 'home')).toEqual([
      { locale: 'de', url: '/de/startseite' },
    ]);
    expect(
      await menusAt(
        'default',
        source,
        site,
        {
          menus: [{ key: 'header', items: [{ link: { type: 'entry', ref: 'pages/home' } }] }],
        },
        'en',
      ),
    ).toEqual({ header: [] });
  },
);

// The menu is resolved through the site's own routes, dropping what the language cannot show.
const menu = (items: unknown[]) => ({ menus: [{ _id: 'm1', key: 'header', items }] });
const item = (over: Record<string, unknown>) => ({ _id: 'i1', label: '', ...over });
const resolved = (nav: unknown, locale: string) =>
  menusAt('default', switcherSource, site, nav, locale);

test('a menu item points at the address its own language serves', async () => {
  const nav = menu([
    item({ label: 'Start', link: { type: 'page', ref: 'pages/home' } }),
    item({
      _id: 'i2',
      label: '',
      link: { type: 'url', href: 'https://example.com' },
      newTab: true,
    }),
  ]);

  expect(await resolved(nav, 'en')).toEqual({
    header: [
      { label: 'Start', href: '/home', children: [] },
      { label: 'https://example.com', href: 'https://example.com', newTab: true, children: [] },
    ],
  });
  // `pages` has localized slugs, so the German menu links the address German serves.
  expect((await resolved(nav, 'de')).header?.[0]).toEqual({
    label: 'Start',
    href: '/de/startseite',
    children: [],
  });
});

test('an item with no label of its own is named by the page it points at', async () => {
  const nav = menu([item({ link: { type: 'entry', ref: 'listings/coast' } })]);

  expect((await resolved(nav, 'en')).header?.[0]?.label).toBe('Coast');
  expect((await resolved(nav, 'de')).header?.[0]?.label).toBe('Küste');
});

test('a page this language does not have takes its children with it', async () => {
  const nav = menu([
    item({
      label: 'Offers',
      link: { type: 'entry', ref: 'listings/nothing' },
      children: [item({ _id: 'i2', label: 'Under it', link: { type: 'url', href: '/under' } })],
    }),
    item({ _id: 'i3', label: 'Hidden', link: { type: 'entry', ref: 'listings/hidden' } }),
    item({
      _id: 'i4',
      label: 'German only',
      link: { type: 'url', href: '/de/x' },
      _locales: ['de'],
    }),
    item({ _id: 'i5', label: 'Kept', link: { type: 'url', href: '/kept' } }),
  ]);

  expect(await resolved(nav, 'en')).toEqual({
    header: [{ label: 'Kept', href: '/kept', children: [] }],
  });
});

test('the tree keeps its shape: children are resolved under their parent', async () => {
  const nav = menu([
    item({
      label: 'Listings',
      link: { type: 'url', href: '/listings' },
      children: [
        item({ _id: 'i2', label: 'Coast', link: { type: 'entry', ref: 'listings/coast' } }),
        item({ _id: 'i3', label: 'Sold', link: { type: 'url', href: '/sold' } }),
      ],
    }),
  ]);

  expect((await resolved(nav, 'en')).header?.[0]?.children).toEqual([
    { label: 'Coast', href: '/listings/coast', children: [] },
    { label: 'Sold', href: '/sold', children: [] },
  ]);
});

// A collection's index is not an entry, so the item names the collection instead of a file.
test("an index item points at the language's own index page, named by the collection", async () => {
  const nav = menu([item({ link: { type: 'index', collection: 'listings' } })]);

  expect((await resolved(nav, 'en')).header).toEqual([
    { label: 'Listings', href: '/listings', children: [] },
  ]);
  expect((await resolved(nav, 'de')).header?.[0]?.href).toBe('/de/listings');
  // A collection with no index page has nowhere to link.
  expect(
    (await resolved(menu([item({ link: { type: 'index', collection: 'samples' } })]), 'en')).header,
  ).toEqual([]);
});

test("an unlabelled index item takes the collection's label in the visitor's language", async () => {
  const labelled = {
    ...site,
    collections: {
      ...site.collections,
      listings: { ...site.collections.listings, label: { en: 'homes', de: 'Häuser' } },
    },
  };
  const nav = menu([item({ link: { type: 'index', collection: 'listings' } })]);
  const name = async (locale: string) =>
    (await menusAt('default', switcherSource, labelled, nav, locale)).header?.[0]?.label;

  expect(await name('en')).toBe('Homes');
  expect(await name('de')).toBe('Häuser');
  // No label written for this language: the key, as before.
  expect(await name('fr')).toBe('Listings');
});

test('a site with no navigation global renders no menus rather than throwing', async () => {
  expect(await resolved(undefined, 'en')).toEqual({});
});

test.each(['en', 'de'])(
  'public entry reads hide both named and localized pages in %s',
  async (locale) => {
    const entries = [{ id: `${locale}/home`, data: { _status: 'hidden', slug: 'welcome' } }];
    const source = staticSource('default', {
      getEntry: async () => entries[0],
      getCollection: async () => entries,
    });
    expect(await entryAt('default', source, site, 'listings', locale, 'home')).toBeUndefined();
    expect(await entryAt('default', source, site, 'pages', locale, 'welcome')).toBeUndefined();
    const preview = draftSource('default', source, [], (_collection, data) => data);
    expect((await entryAt('default', preview, site, 'pages', locale, 'welcome'))?.id).toBe(
      `${locale}/home`,
    );
  },
);
