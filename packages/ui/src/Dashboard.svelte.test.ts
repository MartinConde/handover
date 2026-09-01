import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Dashboard from './Dashboard.svelte';

// Testing: what each tile says in the two states that differ — changes waiting or nothing
// waiting, a language behind or none to report — and that the two buttons hand back to the
// shell rather than doing anything themselves.
// Not testing: the tile grid, the sidebar link that routes here, or the sentences an activity
// row reads as, which are `activity-line`'s and are covered on the activity screen.

const RECENT = [
  {
    key: 'listings/mill-house',
    title: 'The Mill House',
    collection: 'listings',
    href: '/admin/c/listings/mill-house',
    at: Date.now() - 2 * 60 * 60 * 1000,
    by: 'Anna Berg',
    kind: 'edit' as const,
    editing: { id: 'u2', name: 'Anna Berg' },
  },
  {
    key: 'globals/site',
    title: 'Site details',
    collection: 'globals',
    href: '/admin/site/site',
    at: Date.now() - 26 * 60 * 60 * 1000,
    by: 'Martin Conde',
    kind: 'publish' as const,
  },
];
const HEALTH = {
  defaultLocale: 'en',
  locales: [
    { locale: 'en', missing: 0, stale: 0, where: [] },
    { locale: 'de', missing: 4, stale: 2, where: ['listings'] },
  ],
};
const pendingEntry = (key: string, held?: string) => ({
  key,
  updated_at: Date.now() - 3 * 24 * 60 * 60 * 1000,
  held_by: held ? { id: 'u2', name: held } : null,
});

let app: ReturnType<typeof mount>;
const reviewed: number[] = [];
const reverted: string[] = [];
const show = (
  body: Record<string, unknown> = { recent: RECENT, published: null, translations: null },
  props: Record<string, unknown> = {},
) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.startsWith('/admin/api/activity')
        ? Response.json({ events: [], cursor: null })
        : Response.json(body),
    ),
  );
  app = mount(Dashboard, {
    target: document.body,
    props: {
      pending: [],
      build: null,
      collections: [],
      onreview: () => reviewed.push(1),
      onrevert: (sha: string) => reverted.push(sha),
      ...props,
    },
  });
  flushSync();
  return document.body;
};
afterEach(() => {
  unmount(app);
  reviewed.length = 0;
  reverted.length = 0;
  vi.unstubAllGlobals();
});

const all = (root: ParentNode, sel: string) => Array.from(root.querySelectorAll(sel));
const loaded = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
const tile = (root: ParentNode, id: string) =>
  root.querySelector(`.dtile[aria-labelledby="${id}"]`);

test('the unpublished tile counts the changes, the holds and the age of the oldest', async () => {
  const root = show(undefined, {
    pending: [pendingEntry('listings/mill-house'), pendingEntry('pages/home', 'Anna Berg')],
  });
  await loaded();

  const waiting = tile(root, 'd-pending');
  expect(waiting?.querySelector('.big')?.textContent?.trim()).toBe('2 changes');
  expect(waiting?.querySelector('.line')?.textContent?.trim()).toBe(
    '1 on hold · oldest 3 days ago',
  );
  expect(waiting?.classList.contains('is-lit')).toBe(true);
});

// The calm state: it should read as finished rather than as an empty box.
test('with nothing waiting the tile says so and offers no button', async () => {
  const root = show();
  await loaded();

  const waiting = tile(root, 'd-pending');
  expect(waiting?.querySelector('.big')?.textContent?.trim()).toBe('Everything is published');
  expect(waiting?.querySelector('button')).toBeNull();
  expect(waiting?.classList.contains('is-lit')).toBe(false);
});

test('Review and publish opens the drawer rather than publishing anything', async () => {
  const root = show(undefined, { pending: [pendingEntry('listings/mill-house')] });
  await loaded();

  tile(root, 'd-pending')?.querySelector<HTMLButtonElement>('button')?.click();

  expect(reviewed).toHaveLength(1);
});

test('the build tile names who published and hands a revert back to the shell', async () => {
  const root = show(
    { recent: [], published: { at: Date.now() - 3600_000, by: 'Anna Berg' }, translations: null },
    { build: { state: 'live', commit_sha: 'def456', live_at: Date.now() - 3600_000 } },
  );
  await loaded();

  const built = tile(root, 'd-build');
  expect(built?.querySelector('.pill-live')).not.toBeNull();
  expect(built?.querySelector('.line')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Last published by Anna Berg 1h ago',
  );
  built?.querySelector<HTMLButtonElement>('.tile-actions button')?.click();

  expect(reverted).toEqual(['def456']);
});

// A build with no commit named is the worker's newest, not this admin's publish — the pill in
// the top bar makes the same distinction, and there is nothing here to take back.
test('a build this admin did not commit is not offered a revert', async () => {
  const root = show(
    { recent: [], published: { at: Date.now() - 3600_000, by: 'Anna Berg' }, translations: null },
    { build: { state: 'live', live_at: Date.now() } },
  );
  await loaded();

  expect(tile(root, 'd-build')?.querySelector('.tile-actions')).toBeNull();
});

test('a recently edited row is named, addressed and says who and when', async () => {
  const root = show();
  await loaded();

  const rows = all(tile(root, 'd-recent') as ParentNode, '.recent li');
  expect(rows.map((li) => li.querySelector('a')?.getAttribute('href'))).toEqual([
    '/admin/c/listings/mill-house',
    '/admin/site/site',
  ]);
  expect(rows[0]?.querySelector('.lock')?.textContent).toBe('Anna Berg is editing');
  expect(rows[0]?.querySelector('.sub')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Edited by Anna Berg · 2h ago',
  );
  // The verb is the difference: a publish names the person who published, not who typed it.
  expect(rows[1]?.querySelector('.sub')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Published by Martin Conde · yesterday',
  );
  expect(rows[1]?.querySelector('.lock')).toBeNull();
});

test('the translation tile counts what is missing and what is behind its source', async () => {
  const root = show({ recent: [], published: null, translations: HEALTH });
  await loaded();

  const lines = all(tile(root, 'd-tr') as ParentNode, '.locale-line');
  expect(lines.map((line) => line.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
    'EN Source language',
    'DE 4 missing · 2 stale Show',
  ]);
  expect(lines[1]?.querySelector('.chip-missing')).not.toBeNull();
});

// The link the tile has waited for since 4.15: the list, filtered to the language it is owed
// in. One collection is *Show*; several are named, since a list is one collection's.
test("the translation tile's Show lands on the list filtered to the language", async () => {
  const root = show({ recent: [], published: null, translations: HEALTH });
  await loaded();

  const lines = all(tile(root, 'd-tr') as ParentNode, '.locale-line');
  expect(lines[0]?.querySelector('a')).toBeNull();
  expect(
    Array.from(lines[1]?.querySelectorAll('a') ?? [], (a) => [
      a.textContent,
      a.getAttribute('href'),
    ]),
  ).toEqual([['Show', '/admin/c/listings?locale=de']]);
});

test('a language owed in several collections gets a link per list', async () => {
  const health = {
    ...HEALTH,
    locales: [HEALTH.locales[0], { ...HEALTH.locales[1], where: ['listings', 'pages'] }],
  };
  const root = show({ recent: [], published: null, translations: health });
  await loaded();

  const line = all(tile(root, 'd-tr') as ParentNode, '.locale-line')[1];
  expect(Array.from(line?.querySelectorAll('a') ?? [], (a) => a.textContent)).toEqual([
    'Show listings',
    'Show pages',
  ]);
});

// The mockup's quick actions: the same New entry dialog the list opens, one button a collection.
test('a quick action opens the New entry dialog for that collection', async () => {
  const root = show(undefined, { collections: ['pages', 'listings'] });
  await loaded();

  expect(all(root, '.quick .btn').map((b) => b.textContent?.trim())).toEqual([
    'New page',
    'New listing',
  ]);
  (all(root, '.quick .btn')[1] as HTMLButtonElement).click();
  await loaded();

  expect(root.querySelector('.dialog h2')?.textContent).toBe('New listing');
  expect(root.querySelector<HTMLInputElement>('.dialog input#new-title')).not.toBeNull();
  expect(fetch).toHaveBeenCalledWith('/admin/api/entries/listings');
});

// Every site has a locale folder; a site with one language has nothing to report about it.
test('a one-language site is drawn no translation tile at all', async () => {
  const root = show();
  await loaded();

  expect(tile(root, 'd-tr')).toBeNull();
});

// The mockup gave its six tile headings one id between them, which breaks every
// `aria-labelledby` on the page; the ported tiles each carry their own.
test('every id on the filled dashboard is unique', async () => {
  const root = show(
    {
      recent: RECENT,
      published: { by: 'Martin Conde', at: Date.now() - 7_200_000, commit_sha: 'c0ffee11' },
      translations: HEALTH,
    },
    {
      pending: [pendingEntry('listings/mill-house')],
      build: { commit_sha: 'c0ffee11', state: 'live', live_at: Date.now() - 7_000_000 },
    },
  );
  await loaded();

  const ids = all(root, '[id]').map((el) => el.id);
  expect(ids.length).toBeGreaterThan(4);
  expect(new Set(ids).size).toBe(ids.length);
  for (const tile of all(root, '[aria-labelledby]'))
    expect(root.querySelector(`#${tile.getAttribute('aria-labelledby')}`)).not.toBeNull();
});
