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
    { locale: 'en', missing: 0, stale: 0 },
    { locale: 'de', missing: 4, stale: 2 },
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
    'DE 4 missing · 2 stale',
  ]);
  expect(lines[1]?.querySelector('.chip-missing')).not.toBeNull();
});

// Every site has a locale folder; a site with one language has nothing to report about it.
test('a one-language site is drawn no translation tile at all', async () => {
  const root = show();
  await loaded();

  expect(tile(root, 'd-tr')).toBeNull();
});
