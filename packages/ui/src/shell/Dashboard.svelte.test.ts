import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import type { UiLocale } from '../i18n.js';
import { settle } from '../test-helpers.fixture.js';
import Dashboard from './Dashboard.svelte';

// Testing: each tile's two states, buttons deferring to the shell; not the grid or activity lines.

// Relative times count calendar days from local midnight, so an afternoon is pinned for CI.
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date('2026-08-25T14:00:00'));

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
  uiLocale: UiLocale = 'en',
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
      uiLocale,
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
const tile = (root: ParentNode, id: string) =>
  root.querySelector(`.dtile[aria-labelledby="${id}"]`);

test('the unpublished tile counts the changes, the holds and the age of the oldest', async () => {
  const root = show(undefined, {
    pending: [pendingEntry('listings/mill-house'), pendingEntry('pages/home', 'Anna Berg')],
  });
  await settle();

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
  await settle();

  const waiting = tile(root, 'd-pending');
  expect(waiting?.querySelector('.big')?.textContent?.trim()).toBe('Everything is published');
  expect(waiting?.querySelector('button')).toBeNull();
  expect(waiting?.classList.contains('is-lit')).toBe(false);
});

test('Review and publish opens the drawer rather than publishing anything', async () => {
  const root = show(undefined, { pending: [pendingEntry('listings/mill-house')] });
  await settle();

  tile(root, 'd-pending')?.querySelector<HTMLButtonElement>('button')?.click();

  expect(reviewed).toHaveLength(1);
});

test('the build tile names who published and hands a revert back to the shell', async () => {
  const root = show(
    { recent: [], published: { at: Date.now() - 3600_000, by: 'Anna Berg' }, translations: null },
    { build: { state: 'live', commit_sha: 'def456', live_at: Date.now() - 3600_000 } },
  );
  await settle();

  const built = tile(root, 'd-build');
  expect(built?.querySelector('.pill-live')).not.toBeNull();
  expect(built?.querySelector('.line')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Last published by Anna Berg 1 hr ago',
  );
  built?.querySelector<HTMLButtonElement>('.tile-actions button')?.click();

  expect(reverted).toEqual(['def456']);
});

// A build naming no commit is the worker's newest, not this admin's publish: nothing to take back.
test('a build this admin did not commit is not offered a revert', async () => {
  const root = show(
    { recent: [], published: { at: Date.now() - 3600_000, by: 'Anna Berg' }, translations: null },
    { build: { state: 'live', live_at: Date.now() } },
  );
  await settle();

  expect(tile(root, 'd-build')?.querySelector('.tile-actions')).toBeNull();
});

test('a recently edited row is named, addressed and says who and when', async () => {
  const root = show();
  await settle();

  const rows = all(tile(root, 'd-recent') as ParentNode, '.recent li');
  expect(rows.map((li) => li.querySelector('a')?.getAttribute('href'))).toEqual([
    '/admin/c/listings/mill-house',
    '/admin/site/site',
  ]);
  expect(rows[0]?.querySelector('.lock')?.textContent).toBe('Anna Berg is editing');
  expect(rows[0]?.querySelector('.sub')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Edited by Anna Berg · 2 hr ago',
  );
  // The verb is the difference: a publish names the person who published, not who typed it.
  expect(rows[1]?.querySelector('.sub')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Published by Martin Conde · yesterday',
  );
  expect(rows[1]?.querySelector('.lock')).toBeNull();
});

test('the translation tile counts what is missing and what is behind its source', async () => {
  const root = show({ recent: [], published: null, translations: HEALTH });
  await settle();

  const lines = all(tile(root, 'd-tr') as ParentNode, '.locale-line');
  expect(lines.map((line) => line.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
    'EN Up to date',
    'DE 4 missing · 2 stale Show',
  ]);
  expect(lines[1]?.querySelector('.chip-missing')).not.toBeNull();
});

// The categories overlap, so each is its own count and nothing adds them up.
test('the translation tile counts partly written and machine translated beside the rest', async () => {
  const health = {
    defaultLocale: 'en',
    locales: [
      { locale: 'en', missing: 0, stale: 0, unfinished: 0, machine: 1, where: [] },
      { locale: 'de', missing: 4, stale: 2, unfinished: 3, machine: 5, where: ['listings'] },
      { locale: 'fr', missing: 0, stale: 0, unfinished: 1, machine: 0, where: ['listings'] },
      { locale: 'it', missing: 0, stale: 0, unfinished: 0, machine: 2, where: [] },
    ],
  };
  const root = show({ recent: [], published: null, translations: health });
  await settle();

  const lines = all(tile(root, 'd-tr') as ParentNode, '.locale-line');
  expect(lines.map((line) => line.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
    'EN Up to date · 1 machine translated',
    'DE 4 missing · 3 partly written · 2 stale · 5 machine translated Show',
    'FR 1 partly written Show',
    'IT Up to date · 2 machine translated',
  ]);
  expect(tile(root, 'd-tr')?.querySelector('.line')?.textContent?.trim()).toBe(
    'Missing, partly written and machine translated include unpublished changes. ' +
      'Stale means the language it was translated from has changed since; that count is the ' +
      "last build's, so a translation you have fixed but not published is still in it. " +
      'One entry can be in several counts.',
  );
});

// One collection is *Show*; several are named, since a list is one collection's.
test("the translation tile's Show lands on the list filtered to the language", async () => {
  const root = show({ recent: [], published: null, translations: HEALTH });
  await settle();

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
  await settle();

  const line = all(tile(root, 'd-tr') as ParentNode, '.locale-line')[1];
  expect(Array.from(line?.querySelectorAll('a') ?? [], (a) => a.textContent)).toEqual([
    'Show listings',
    'Show pages',
  ]);
});

// The mockup's quick actions: the same New entry dialog the list opens, one button a collection.
test('a quick action opens the New entry dialog for that collection', async () => {
  const root = show(undefined, { collections: ['pages', 'listings'] });
  await settle();

  expect(all(root, '.quick .btn').map((b) => b.textContent?.trim())).toEqual([
    'New page',
    'New listing',
  ]);
  (all(root, '.quick .btn')[1] as HTMLButtonElement).click();
  await settle();

  expect(root.querySelector('.dialog h2')?.textContent).toBe('New listing');
  expect(root.querySelector<HTMLInputElement>('.dialog input#new-title')).not.toBeNull();
  expect(fetch).toHaveBeenCalledWith('/admin/api/entries/listings');
});

// No list filter behind it, so the dashboard's dialog starts in the language the site declares.
test('a quick action creates in the site default language', async () => {
  const root = show(
    { recent: [], published: null, translations: null, locales: ['en', 'de'], defaultLocale: 'de' },
    { collections: ['listings'] },
  );
  await settle();

  (all(root, '.quick .btn')[0] as HTMLButtonElement).click();
  await settle();

  expect(root.querySelector<HTMLSelectElement>('.dialog select#new-locale')?.value).toBe('de');
});

// Every site has a locale folder; a site with one language has nothing to report about it.
test('a one-language site is drawn no translation tile at all', async () => {
  const root = show();
  await settle();

  expect(tile(root, 'd-tr')).toBeNull();
});

// The mockup gave its six tile headings one id, which breaks every `aria-labelledby`.
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
  await settle();

  const ids = all(root, '[id]').map((el) => el.id);
  expect(ids.length).toBeGreaterThan(4);
  expect(new Set(ids).size).toBe(ids.length);
  for (const tile of all(root, '[aria-labelledby]'))
    expect(root.querySelector(`#${tile.getAttribute('aria-labelledby')}`)).not.toBeNull();
});

test('failed dashboard reads are unavailable rather than empty and retry recovers', async () => {
  let dashboardAttempts = 0;
  let activityAttempts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/admin/api/dashboard') {
        dashboardAttempts += 1;
        return dashboardAttempts === 1
          ? new Response('unavailable', { status: 503 })
          : Response.json({ recent: RECENT, published: null, translations: null });
      }
      activityAttempts += 1;
      return activityAttempts === 1
        ? new Response('unavailable', { status: 503 })
        : Response.json({ events: [] });
    }),
  );
  app = mount(Dashboard, {
    target: document.body,
    props: {
      pending: [],
      pendingStatus: 'ready',
      build: null,
      buildStatus: 'ready',
      collections: [],
      onreview: () => {},
      onrevert: () => {},
      onretryPending: () => {},
      onretryBuild: () => {},
    },
  });
  await settle();

  expect(tile(document.body, 'd-recent')?.textContent).toContain('Recently edited is unavailable');
  expect(tile(document.body, 'd-recent')?.textContent).not.toContain('Nothing has been edited yet');
  expect(tile(document.body, 'd-act')?.textContent).toContain('Recent activity is unavailable');

  tile(document.body, 'd-recent')?.querySelector<HTMLButtonElement>('button')?.click();
  tile(document.body, 'd-act')?.querySelector<HTMLButtonElement>('button')?.click();
  await settle();

  expect(tile(document.body, 'd-recent')?.textContent).toContain('The Mill House');
  expect(tile(document.body, 'd-act')?.textContent).toContain('Nothing has been recorded yet');
});

test('malformed dashboard reads use the same retained error states', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('not json', { status: 200 })),
  );
  app = mount(Dashboard, {
    target: document.body,
    props: {
      pending: [],
      build: null,
      collections: [],
      onreview: () => {},
      onrevert: () => {},
    },
  });

  await vi.waitFor(() =>
    expect(tile(document.body, 'd-recent')?.querySelector('[role="alert"]')).not.toBeNull(),
  );
  expect(tile(document.body, 'd-act')?.querySelector('[role="alert"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain('Nothing has been edited yet');
});

test.each([
  ['null dashboard', '/admin/api/dashboard', null],
  ['non-array recent entries', '/admin/api/dashboard', { recent: {} }],
  ['null activity', '/admin/api/activity', null],
  ['non-array activity events', '/admin/api/activity', { events: {} }],
] as const)(
  '%s keep dashboard collections unknown and retryable',
  async (_label, malformedUrl, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === malformedUrl) return Response.json(body);
        if (url === '/admin/api/dashboard')
          return Response.json({ recent: RECENT, published: null, translations: null });
        return Response.json({ events: [] });
      }),
    );
    app = mount(Dashboard, {
      target: document.body,
      props: {
        pending: [],
        build: null,
        collections: [],
        onreview: () => {},
        onrevert: () => {},
      },
    });

    if (malformedUrl.endsWith('/dashboard')) {
      await vi.waitFor(() =>
        expect(tile(document.body, 'd-recent')?.querySelector('[role="alert"]')).not.toBeNull(),
      );
      expect(tile(document.body, 'd-act')?.textContent).toContain('Nothing has been recorded yet');
    } else {
      await vi.waitFor(() =>
        expect(tile(document.body, 'd-act')?.querySelector('[role="alert"]')).not.toBeNull(),
      );
      expect(tile(document.body, 'd-recent')?.textContent).toContain('The Mill House');
    }
  },
);

test('the dashboard switches its live chrome and dates without rereading data', async () => {
  const root = show(
    {
      recent: RECENT,
      published: { at: Date.now() - 3600_000, by: 'Anna Berg' },
      translations: HEALTH,
    },
    {
      pending: [pendingEntry('listings/mill-house'), pendingEntry('pages/home', 'Anna Berg')],
      build: { state: 'live', commit_sha: 'def456', live_at: Date.now() - 3600_000 },
      collections: ['ferienhaeuser'],
    },
    'de',
  );
  await settle();

  expect(root.querySelector('h1')?.textContent).toBe('Übersicht');
  expect(tile(root, 'd-pending')?.textContent?.replace(/\s+/g, ' ')).toContain('2 Änderungen');
  expect(tile(root, 'd-build')?.textContent?.replace(/\s+/g, ' ')).toContain(
    'Zuletzt veröffentlicht von Anna Berg vor 1 Std.',
  );
  expect(root.querySelector('.quick .btn')?.textContent?.trim()).toBe('Neu: ferienhaeuser');
  expect(root.textContent).toContain('The Mill House');
  expect(root.textContent).toContain('listings');
  expect(fetch).toHaveBeenCalledTimes(2);
});

// Record source languages: the owner-only tile over GET and POST /admin/api/sources.
const UNRECORDED = {
  base: 'b1',
  entries: [
    {
      key: 'pages/home',
      collection: 'pages',
      title: 'Home',
      href: '/admin/c/pages/home',
      source: 'en',
      locales: ['en', 'de', 'fr'],
      drafts: true,
      stale: [{ locale: 'fr', from: 'de' }],
    },
    {
      key: 'pages/about',
      collection: 'pages',
      title: 'About',
      href: '/admin/c/pages/about',
      source: 'en',
      locales: ['en', 'de'],
      drafts: false,
      stale: [],
    },
    {
      key: 'listings/muehle',
      collection: 'listings',
      title: 'Mühlenhaus',
      href: '/admin/c/listings/muehle',
      source: 'de',
      locales: ['de', 'en'],
      drafts: false,
      stale: [],
    },
  ],
};
const committed = vi.fn();
const showSources = (
  listings: unknown[],
  post: () => Promise<Response> = async () => Response.json({}),
  props: Record<string, unknown> = { role: 'owner' },
) => {
  const reads = [...listings];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/admin/api/activity')) return Response.json({ events: [] });
      if (url === '/admin/api/sources')
        return init?.method === 'POST' ? post() : Response.json(reads.shift() ?? listings.at(-1));
      return Response.json({ recent: [], published: null, translations: null });
    }),
  );
  committed.mockReset();
  // Filled in place, so a `$state` object passed by a test stays the live props.
  const defaults = { pending: [], build: null, collections: [], oncommitted: committed };
  for (const [key, value] of Object.entries(defaults)) if (!(key in props)) props[key] = value;
  props.onreview ??= () => {};
  props.onrevert ??= () => {};
  app = mount(Dashboard, { target: document.body, props: props as never });
  flushSync();
  return document.body;
};
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const sourceCalls = () =>
  vi.mocked(fetch).mock.calls.filter(([url]) => url === '/admin/api/sources');
const openSources = async (root: HTMLElement) => {
  await settle();
  tile(root, 'd-src')?.querySelector<HTMLButtonElement>('.btn-primary')?.click();
  flushSync();
  return root.querySelector('.source-dialog');
};
const confirm = async (root: HTMLElement) => {
  root.querySelector<HTMLButtonElement>('.source-dialog button[type="submit"]')?.click();
  await settle();
  await settle();
};

test("an editor's dashboard neither asks about nor draws source languages", async () => {
  const root = showSources([UNRECORDED], undefined, { role: 'editor' });
  await settle();

  expect(sourceCalls()).toEqual([]);
  expect(tile(root, 'd-src')).toBeNull();
});

test('an owner with nothing left to record is drawn no tile', async () => {
  const root = showSources([{ base: 'b1', entries: [] }]);
  await settle();

  expect(sourceCalls()).toHaveLength(1);
  expect(tile(root, 'd-src')).toBeNull();
});

test('the dialog counts what gets recorded, what will need a look and the drafts it keeps', async () => {
  const root = showSources([UNRECORDED]);
  expect(text(tile(root, 'd-src'))).toBe('');
  const dialog = await openSources(root);

  expect(text(tile(root, 'd-src'))).toContain('3 entries don’t yet record which language');
  expect(all(dialog ?? root, '.source-effects li').map(text)).toEqual([
    '2 entries — English, as now',
    '1 entry — German, as now',
  ]);
  expect(text(dialog?.querySelector('.source-list summary'))).toBe('Show the 3 entries');
  expect(all(dialog ?? root, '.source-files .desc').map(text)).toEqual([
    'pages · English, German, French',
    'pages · English, German',
    'listings · German, English',
  ]);
  expect(text(dialog?.querySelector('.notice-warn'))).toBe(
    '1 translation into French was made from German, not from its entry’s source, English. It will show as needing a look against English. Its words don’t change.',
  );
  expect(text(dialog?.querySelector('.hint'))).toContain(
    '1 of these entries has unpublished changes',
  );
  expect(text(dialog?.querySelector('button[type="submit"]'))).toBe('Record for 3 entries');
});

test('recording sends the base once, reports the result and hands the commit to the shell', async () => {
  const post = vi.fn(async () => Response.json({ commit_sha: 'c1', entries: 3, stale: 1 }));
  const root = showSources([UNRECORDED], post);
  await openSources(root);

  await confirm(root);

  expect(post).toHaveBeenCalledTimes(1);
  expect(sourceCalls().find(([, init]) => init?.method === 'POST')?.[1]?.body).toBe(
    JSON.stringify({ base: 'b1' }),
  );
  expect(root.querySelector('.source-dialog')).toBeNull();
  expect(text(tile(root, 'd-src')?.querySelector('[role="status"]'))).toBe(
    'Recorded for 3 entries in one commit. 1 translation now shows as needing a look against its source.',
  );
  expect(committed).toHaveBeenCalledTimes(1);
});

test('a moved repository refuses, and Review again reads the list afresh', async () => {
  const root = showSources([UNRECORDED, { ...UNRECORDED, base: 'b2' }], async () =>
    Response.json({ code: 'SOURCES_CHANGED', error: 'moved' }, { status: 409 }),
  );
  await openSources(root);

  await confirm(root);

  const alert = root.querySelector('.source-dialog [role="alert"]');
  expect(text(alert)).toContain(
    'The repository changed while this was open. Nothing was recorded — review it again.',
  );
  expect(
    root.querySelector<HTMLButtonElement>('.source-dialog button[type="submit"]')?.disabled,
  ).toBe(true);
  alert?.querySelector<HTMLButtonElement>('button')?.click();
  await settle();

  expect(sourceCalls().filter(([, init]) => init?.method !== 'POST')).toHaveLength(2);
  expect(root.querySelector('.source-dialog [role="alert"]')).toBeNull();
  expect(committed).not.toHaveBeenCalled();
});

test('a lock names who is editing and records nothing', async () => {
  const root = showSources([UNRECORDED], async () =>
    Response.json(
      { code: 'SOURCES_LOCKED', held: [{ key: 'pages/home', name: 'Anna Berg' }] },
      { status: 409 },
    ),
  );
  await openSources(root);

  await confirm(root);

  expect(text(root.querySelector('.source-dialog [role="alert"]'))).toContain(
    'Anna Berg is editing an entry this would record.',
  );
  expect(committed).not.toHaveBeenCalled();
});

test('a lost response asks for a reload instead of claiming either outcome', async () => {
  const root = showSources([UNRECORDED], async () => {
    throw new TypeError('network');
  });
  await openSources(root);

  await confirm(root);

  expect(text(root.querySelector('.source-dialog [role="alert"]'))).toContain(
    'It could not be confirmed whether the languages were recorded. Reload before trying again.',
  );
  expect(tile(root, 'd-src')?.querySelector('[role="status"]')).toBeNull();
  expect(committed).not.toHaveBeenCalled();
});

test('switching the interface language keeps the dialog open without rereading', async () => {
  const props = $state<Record<string, unknown>>({ role: 'owner', uiLocale: 'en' });
  const root = showSources([UNRECORDED], undefined, props);
  await openSources(root);

  props.uiLocale = 'de';
  flushSync();

  expect(text(root.querySelector('.source-dialog h2'))).toBe('Ausgangssprachen festhalten');
  expect(text(root.querySelector('.source-dialog button[type="submit"]'))).toBe(
    'Für 3 Einträge festhalten',
  );
  expect(sourceCalls()).toHaveLength(1);
});
