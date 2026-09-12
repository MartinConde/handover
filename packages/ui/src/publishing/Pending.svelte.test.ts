import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Pending from './Pending.svelte';

// Not testing Select all / none: they set the same state a checkbox does.

const ENTRIES = [
  {
    key: 'pages/home',
    title: 'Home',
    collection: 'pages',
    locales: ['en', 'de'],
    files: ['src/content/pages/en/home.yaml', 'src/content/pages/de/home.yaml'],
    updated_at: 1755864000000,
  },
  {
    key: 'listings/mill-house',
    title: 'The Mill House',
    collection: 'listings',
    locales: ['en'],
    files: ['src/content/listings/en/mill-house.yaml'],
    // redirects.yaml is never a row: it is assembled at publish from the entries going out.
    redirects: 1,
    updated_at: 1755863000000,
  },
];

let app: ReturnType<typeof mount>;
let entries = $state(ENTRIES);
const published = vi.fn();
const discarded = vi.fn();
const reverted = vi.fn();
let build = $state<{
  commit_sha: string;
  state: 'building' | 'live' | 'failed';
  started_at?: number;
  committed_at?: number;
} | null>(null);
const show = (initial = ENTRIES, defaultLocale = '') => {
  entries = initial;
  app = mount(Pending, {
    target: document.body,
    props: {
      defaultLocale,
      get entries() {
        return entries;
      },
      get build() {
        return build;
      },
      onclose: () => {},
      onpublished: published,
      onrevert: reverted,
      ondiscarded: discarded,
    },
  });
  flushSync();
  return document.body;
};
afterEach(() => {
  unmount(app);
  published.mockClear();
  discarded.mockClear();
  reverted.mockClear();
  build = null;
  vi.unstubAllGlobals();
});

const q = <T extends Element>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
const boxes = (root: ParentNode) =>
  Array.from(root.querySelectorAll<HTMLInputElement>('.change-row .lead input'));
const tick = () => new Promise((r) => setTimeout(r, 0));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

test('the drawer counts the pending entries and lists one row per entry', () => {
  const root = show();
  expect(q(root, '.drawer-meta')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    '2 changes · 2 selected',
  );
  expect(q(root, '.drawer-meta.is-summary')?.textContent).toBe('1 page · 1 listing · +1 redirect');
  expect(Array.from(root.querySelectorAll('.change-row .name'), (n) => n.textContent)).toEqual([
    'Home',
    'The Mill House',
  ]);
  // The entry is the row, so its languages are chips on it and its files are a count under it.
  expect(Array.from(root.querySelectorAll('.change-row .chip'), (n) => n.textContent)).toEqual([
    'EN',
    'DE',
    'EN',
  ]);
  expect(q(root, '.change-row .change-sub')?.textContent?.replace(/\s+/g, ' ')).toContain(
    '2 files',
  );
  // A shared file rides along on the entry that produced the rule, rather than being listed.
  expect(q(root, '.change-row .badge-accent')?.textContent).toBe('+1 redirect');
});

test('Publish commits the checked entries by key and then reports what went out', async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({ commit_sha: 'def4567890', paths: ENTRIES.flatMap((e) => e.files) }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  const button = q<HTMLButtonElement>(root, '.drawer-foot .btn-primary');
  expect(button?.textContent).toBe('Publish 2 changes');
  button?.click();
  await tick();
  entries = [];
  flushSync();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: ['pages/home', 'listings/mill-house'] }),
  });
  expect(published).toHaveBeenCalled();
  // Entries, not the five files behind them: the drawer counts what the client picked.
  expect(q(root, '.empty h2')?.textContent).toBe('Published 2 changes');
  expect(q(root, '.drawer-foot')).toBeNull();
});

test('unchecking an entry leaves it out of the publish and out of the count', async () => {
  const fetchMock = vi.fn(async () => Response.json({ commit_sha: 'def4567890', paths: [] }));
  vi.stubGlobal('fetch', fetchMock);
  const root = show();

  boxes(root)[1]?.click();
  flushSync();

  expect(q(root, '.drawer-meta')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    '2 changes · 1 selected',
  );
  const button = q<HTMLButtonElement>(root, '.drawer-foot .btn-primary');
  expect(button?.textContent).toBe('Publish 1 change');
  button?.click();
  await tick();

  expect(fetchMock).toHaveBeenCalledWith(
    '/admin/api/publish',
    expect.objectContaining({ body: JSON.stringify({ entries: ['pages/home'] }) }),
  );
});

test('with nothing checked there is nothing to publish and the button says so', () => {
  const fetchMock = vi.fn(async () => Response.json({ results: [] }));
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  for (const box of boxes(root)) box.click();
  flushSync();

  const button = q<HTMLButtonElement>(root, '.drawer-foot .btn-primary');
  expect(button?.disabled).toBe(true);
  expect(button?.textContent?.trim()).toBe('Publish');
  expect(q(root, '.drawer-foot .foot-note')?.textContent?.trim()).toBe(
    'Nothing is selected. Check what you want to publish.',
  );
  // One pass on open and none for the empty set: there is nothing for the checks to read.
  expect(fetchMock.mock.calls.flat()).toEqual(['/admin/api/publish/checks', expect.anything()]);
});

const CONFLICT = Response.json(
  {
    error: 'src/content/listings/en/mill-house.yaml changed in the repository after it was opened',
    paths: ['src/content/listings/en/mill-house.yaml'],
  },
  { status: 409 },
);

const refused = async (root: ParentNode) => {
  q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.click();
  await tick();
  flushSync();
};

test('an entry changed in the repository takes itself out and the rest still publish', async () => {
  const fetchMock = vi.fn(async (_url: string) => CONFLICT.clone());
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await refused(root);

  expect(q(root, '[role="alert"]')?.textContent).toBe(
    'Nothing was published. One entry changed in the repository after you opened it. Resolve it to keep what you wrote, or discard your changes to take what is there now.',
  );
  const row = q(root, '.change-row.is-blocked');
  expect(q(row as ParentNode, '.name')?.textContent).toBe('The Mill House');
  expect(q(row as ParentNode, '.badge-danger')?.textContent).toBe(
    'Changed in the repository since you opened it',
  );
  // Blocked, so it is off whatever the client had checked — and pressing again sends the rest.
  expect(q<HTMLInputElement>(row as ParentNode, '.lead input')?.checked).toBe(false);
  expect(q<HTMLInputElement>(row as ParentNode, '.lead input')?.disabled).toBe(true);
  const button = q<HTMLButtonElement>(root, '.drawer-foot .btn-primary');
  expect(button?.disabled).toBe(false);
  expect(button?.textContent).toBe('Publish 1 change');

  // The checks pass precedes the publish, so answer URL by URL from here.
  fetchMock.mockImplementation(async (url: string) =>
    url === '/admin/api/publish'
      ? Response.json({ commit_sha: 'def4567890', paths: ENTRIES[0]?.files })
      : Response.json({ results: [] }),
  );
  button?.click();
  await tick();

  expect(fetchMock).toHaveBeenCalledWith(
    '/admin/api/publish',
    expect.objectContaining({ body: JSON.stringify({ entries: ['pages/home'] }) }),
  );
  expect(published).toHaveBeenCalled();
});

test('discarding the conflicted entry asks first, then drops that draft alone', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'DELETE' ? Response.json({}) : CONFLICT.clone(),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await refused(root);

  q<HTMLButtonElement>(root, '.change-row.is-blocked .change-actions .btn')?.click();
  flushSync();
  expect(q(root, '.dialog h2')?.textContent).toBe('Discard your changes to The Mill House?');
  q<HTMLButtonElement>(root, '.dialog .btn-danger')?.click();
  await tick();
  flushSync();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/drafts/listings/mill-house', {
    method: 'DELETE',
  });
  expect(discarded).toHaveBeenCalled();
  expect(q(root, '.dialog')).toBeNull();
  expect(q(root, '.change-row.is-blocked')).toBeNull();
});

test('Escape closes only the nested confirmation and returns to the drawer', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'DELETE' ? Response.json({}) : CONFLICT.clone(),
    ),
  );
  const root = show();
  await refused(root);
  const discard = q<HTMLButtonElement>(root, '.change-row.is-blocked .change-actions .btn');
  discard?.focus();
  discard?.click();
  flushSync();
  expect(root.querySelectorAll('dialog.modal-host[open]')).toHaveLength(2);

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  flushSync();

  expect(q(root, '#discard-h')).toBeNull();
  expect(q(root, '.drawer')).not.toBeNull();
  expect(document.activeElement).toBe(discard);
});

test('a branch that moved under the publish is reported in the words the server used', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('main moved past abc123', { status: 409 })),
  );
  const root = show();
  await refused(root);

  expect(q(root, '[role="alert"]')?.textContent).toBe(
    'Nothing was published. main moved past abc123',
  );
  // Nothing was named, so nothing unchecked itself and the same set is what a retry sends.
  const button = q<HTMLButtonElement>(root, '.drawer-foot .btn-primary');
  expect(button?.textContent).toBe('Publish 2 changes');
  expect(button?.disabled).toBe(false);
});

test('with nothing pending there is no Publish button to press', () => {
  const root = show([]);
  expect(q(root, '.drawer-meta')?.textContent).toBe('Nothing to publish');
  expect(q(root, '.empty h2')?.textContent).toBe('Everything is published');
  expect(q(root, '.drawer-foot')).toBeNull();
});

test('discarding one of two conflicted entries leaves the other named and says so', async () => {
  let release: (() => void) | undefined;
  const paused = new Promise<void>((r) => (release = r));
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'DELETE')
      return Response.json(
        { error: 'refused', paths: ENTRIES.flatMap((e) => e.files) },
        { status: 409 },
      );
    await paused;
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await refused(root);

  expect(q(root, '[role="alert"]')?.textContent).toBe(
    'Nothing was published. 2 entries changed in the repository after you opened them. Resolve them to keep what you wrote, or discard your changes to take what is there now.',
  );
  root
    .querySelectorAll<HTMLButtonElement>('.change-row.is-blocked .change-actions .btn')[0]
    ?.click();
  flushSync();
  q<HTMLButtonElement>(root, '.dialog .btn-danger')?.click();
  await tick();
  flushSync();

  // A discard in flight is not a publish in flight: neither the button nor the live region says so.
  expect(q(root, '.drawer-foot .btn-primary')?.textContent?.trim()).not.toContain('Publishing');
  expect(q(root, '.drawer-foot [role="status"]')).toBeNull();

  release?.();
  await tick();
  flushSync();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/drafts/pages/home', { method: 'DELETE' });
  expect(q(root, '[role="alert"]')?.textContent).toBe(
    'Nothing was published. One entry changed in the repository after you opened it. Resolve it to keep what you wrote, or discard your changes to take what is there now.',
  );
  expect(root.querySelectorAll('.change-row.is-blocked').length).toBe(1);
});

// A blank new entry's file is rejected by the schema, so the commit is refused whole.
test('an entry the schema is not done with is named on its row and takes itself out', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        {
          error: 'src/content/listings/en/mill-house.yaml is missing something the schema needs',
          paths: ['src/content/listings/en/mill-house.yaml'],
        },
        { status: 422 },
      ),
    ),
  );
  const root = show();
  await refused(root);

  expect(q(root, '[role="alert"]')?.textContent).toBe(
    'Nothing was published. One entry is not finished — open it to see what is missing. Delete it if it cannot be filled in yet.',
  );
  expect(q(root, '.change-row.is-blocked .badge-danger')?.textContent).toBe('Not ready to publish');
  const button = q<HTMLButtonElement>(root, '.drawer-foot .btn-primary');
  expect(button?.textContent).toBe('Publish 1 change');
  expect(published).not.toHaveBeenCalled();
});

// A refusal that leaves nothing selected is not "check something": every checkbox is disabled.
test('a refusal that blocks the only entry says so instead of asking for a checkbox', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => CONFLICT.clone()),
  );
  const root = show([ENTRIES[1] as (typeof ENTRIES)[number]]);
  await refused(root);

  expect(q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.disabled).toBe(true);
  expect(q(root, '.drawer-foot .foot-note')?.textContent?.trim()).toBe(
    'Nothing can go out: every entry here is held back by what is marked on its row.',
  );
});

test('Discard names the entry it would throw away, for anybody who cannot see the row', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => CONFLICT.clone()),
  );
  const root = show();
  await refused(root);

  expect(q(root, '.change-row.is-blocked .change-actions .btn')?.getAttribute('aria-label')).toBe(
    'Discard your changes to The Mill House',
  );
});

// Drift is settled in the editor, not here, so the row says that and offers no Discard.
test('an entry whose languages have drifted apart is named on its row as that', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        {
          error:
            "src/content/listings/en/mill-house.yaml has drifted apart from the entry's other languages — resolve it in the editor",
          paths: ['src/content/listings/en/mill-house.yaml'],
          reason: 'drift',
        },
        { status: 409 },
      ),
    ),
  );
  const root = show();
  await refused(root);

  expect(q(root, '[role="alert"]')?.textContent).toBe(
    "Nothing was published. One entry's languages disagree about which blocks it has — the files have to agree before it can go out.",
  );
  expect(q(root, '.change-row.is-blocked .badge-danger')?.textContent).toBe('Languages disagree');
  // Discard is the way out of a conflict, not of drift.
  expect(q(root, '.change-row.is-blocked .change-actions .btn-sm')).toBe(null);
  expect(published).not.toHaveBeenCalled();
});

// A hold is a promise between colleagues, so the drawer says what it kept back before Publish.
const HELD = [
  ENTRIES[0] as (typeof ENTRIES)[number],
  { ...(ENTRIES[1] as (typeof ENTRIES)[number]), held_by: { id: 'u1', name: 'Martin' } },
];

// The age is calendar days from when the hold was set, the way the log's *Yesterday* is.
test('a hold set yesterday says how long the entry has been held back', () => {
  const yesterday = [
    ENTRIES[0] as (typeof ENTRIES)[number],
    {
      ...(ENTRIES[1] as (typeof ENTRIES)[number]),
      held_by: { id: 'u1', name: 'Martin', since: Date.now() - 86_400_000 },
    },
  ];
  const root = show(yesterday);

  expect(q(root, '.change-group .badge-warn')?.textContent).toBe('On hold · Martin · 1 day');
});

test('an entry on hold is listed apart, unchecked and out of what Publish commits', () => {
  const root = show(HELD);

  expect(q(root, '.change-group .group-title')?.textContent).toBe('On hold');
  const row = q(root, '.change-group .change-row');
  expect(row?.classList.contains('is-held')).toBe(true);
  expect(q(root, '.change-group .badge-warn')?.textContent).toBe('On hold · Martin');
  expect(q<HTMLInputElement>(row as ParentNode, '.lead input')?.checked).toBe(false);
  expect(q(root, '.drawer-foot .btn-primary')?.textContent).toBe('Publish 1 change');
  expect(q(root, '.drawer-meta')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    '2 changes · 1 selected · 1 on hold',
  );
});

// The hold is a courtesy, not a permission, so the drawer says what including it does first.
test('checking an entry on hold puts it in the publish and says the hold comes off', async () => {
  const fetchMock = vi.fn(async () => Response.json({ commit_sha: 'def4567890', paths: [] }));
  vi.stubGlobal('fetch', fetchMock);
  const root = show(HELD);

  q<HTMLInputElement>(root, '.change-group .change-row .lead input')?.click();
  flushSync();

  expect(q(root, '.change-group .notice-warn')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Publishing this releases the hold. It is logged, and whoever set it sees it in the activity log.',
  );
  expect(q(root, '.drawer-meta')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    '2 changes · 2 selected · 0 on hold',
  );
  q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.click();
  await tick();

  expect(fetchMock).toHaveBeenCalledWith(
    '/admin/api/publish',
    expect.objectContaining({
      body: JSON.stringify({ entries: ['pages/home', 'listings/mill-house'] }),
    }),
  );
});

test('a set that is entirely on hold has nothing to publish and says why', () => {
  const root = show([HELD[1] as (typeof HELD)[number]]);

  const button = q<HTMLButtonElement>(root, '.drawer-foot .btn-primary');
  expect(button?.disabled).toBe(true);
  expect(button?.textContent?.trim()).toBe('Publish');
  expect(q(root, '.drawer-foot .foot-note')?.textContent).toContain('on hold');
});

// Selection is per publish, so what a publish leaves behind is checked as a fresh drawer would.
test('what a publish leaves behind starts from the defaults again', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ commit_sha: 'def4567890', paths: ENTRIES[0]?.files })),
  );
  const root = show();
  boxes(root)[1]?.click();
  flushSync();
  expect(q(root, '.drawer-foot .btn-primary')?.textContent).toBe('Publish 1 change');
  q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.click();
  await tick();
  entries = ENTRIES.slice(1);
  flushSync();

  expect(q<HTMLInputElement>(root, '.change-row .lead input')?.checked).toBe(true);
  expect(q(root, '.drawer-foot .btn-primary')?.textContent).toBe('Publish 1 change');
});

test('a publish that left a hold behind still says what it published', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ commit_sha: 'def4567890', paths: ENTRIES[0]?.files })),
  );
  const root = show(HELD);

  q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.click();
  await tick();
  // What the shell hands back once the published rows have gone: the hold, on its own.
  entries = HELD.slice(1);
  flushSync();

  expect(q(root, '.publish-result h3')?.textContent).toBe('Published 1 change');
  expect(q(root, '.change-group .group-title')?.textContent).toBe('Still on hold');
  expect(published).toHaveBeenCalled();
});

// The result panel is neutral rather than green: the commit landed, the site has not.
const publishing = (body: Record<string, unknown>) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(body)),
  );

test('the panel a publish leaves behind offers a revert of that commit', async () => {
  publishing({ commit_sha: 'c0ffee11', paths: ENTRIES[0]?.files ?? [] });
  const root = show();
  q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.click();
  await tick();
  flushSync();

  const revert = q<HTMLButtonElement>(root, '.publish-result .result-actions .btn-link');
  expect(revert?.textContent?.trim()).toBe('Revert this publish');
  revert?.click();
  expect(reverted).toHaveBeenCalledWith('c0ffee11');
});

test('the build of that commit is shown beside it, in words as well as colour', async () => {
  publishing({ commit_sha: 'c0ffee11', paths: ENTRIES[0]?.files ?? [] });
  const root = show();
  q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.click();
  await tick();
  // No `started_at`: the Builds API has no build for the commit for the first half-minute.
  build = { commit_sha: 'c0ffee11', state: 'building', committed_at: Date.now() - 45_000 };
  flushSync();

  const pill = q(root, '.publish-result .pill');
  // The shell's pill and this one are the same component, so they cannot disagree again.
  expect(pill?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Building… 0m 45s');
  expect(pill?.className).toContain('pill-building');
});

// The panel is about the commit this drawer made, not whatever moved the shell's pill.
test('a build of some other commit is not shown as this publish’s', async () => {
  publishing({ commit_sha: 'c0ffee11', paths: ENTRIES[0]?.files ?? [] });
  const root = show();
  q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.click();
  await tick();
  build = { commit_sha: 'deadbeef', state: 'building' };
  flushSync();

  expect(q(root, '.publish-result .pill')).toBeNull();
  expect(q(root, '.publish-result .result-actions .btn-link')).not.toBeNull();
});

// The diff itself is `Diff.svelte`'s; the drawer owes asking for the entry and the rules on top.
test('opening a row shows what would go out and the redirect riding along', async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({
      groups: [
        {
          locale: 'en',
          changes: [
            { path: 'price', label: 'Price', kind: 'value', before: '450000', after: '435000' },
          ],
        },
      ],
      redirects: [{ from: '/listings/mill', to: '/listings/mill-house' }],
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  const open = Array.from(root.querySelectorAll<HTMLButtonElement>('.change-actions .btn-icon'));
  open[1]?.click();
  await tick();
  flushSync();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/diff/listings/mill-house');
  expect(open[1]?.getAttribute('aria-expanded')).toBe('true');
  expect(q(root, '.change-diff .diff .row')?.textContent?.replace(/\s+/g, ' ')).toContain(
    '450000 → 435000',
  );
  expect(q(root, '.change-diff .row.is-block')?.textContent?.replace(/\s+/g, ' ')).toContain(
    '/listings/mill → /listings/mill-house',
  );
});

// Nothing publishes while a conflict is open: the other entries would go out in the same commit.
test('Resolve opens the three-way view in place of the list, and publishing waits', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url.startsWith('/admin/api/conflict')
      ? Response.json({ head: 'a1c9f2b', questions: [], merged: [] })
      : CONFLICT.clone(),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await refused(root);

  q<HTMLButtonElement>(root, '.change-row.is-blocked .change-title .btn-sm')?.click();
  await tick();
  flushSync();

  expect(q(root, '.resolve h3')?.textContent).toBe('Resolve The Mill House');
  expect(q(root, '.change-list')).toBe(null);
  expect(q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.disabled).toBe(true);
  expect(q(root, '.drawer-foot .foot-note')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Publishing waits while a conflict is open: the rest would go out in the same commit, and this entry is not ready to be in it.',
  );
});

test('a resolved entry loses the badge and is read again wherever it is open', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    url.startsWith('/admin/api/conflict')
      ? Response.json(init?.method === 'POST' ? {} : { head: 'a1c9f2b', questions: [], merged: [] })
      : CONFLICT.clone(),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await refused(root);
  q<HTMLButtonElement>(root, '.change-row.is-blocked .change-title .btn-sm')?.click();
  await tick();
  flushSync();

  q<HTMLButtonElement>(root, '.resolve .actions .btn-primary')?.click();
  await tick();
  flushSync();

  expect(q(root, '.resolve')).toBe(null);
  expect(q(root, '.badge-danger')).toBe(null);
  expect(discarded).toHaveBeenCalled();
  expect(boxes(root)[1]?.disabled).toBe(false);
  expect(q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.disabled).toBe(false);
});

// The panel stays a div so it is not a nested landmark; the native dialog owns modality.
test('the drawer panel sits inside the shared native modal boundary', () => {
  const root = show();

  expect(root.querySelector('.drawer')?.tagName).toBe('DIV');
  expect(
    root.querySelector('dialog[aria-labelledby="pending-h"]')?.getAttribute('aria-modal'),
  ).toBe('true');
});

// Pre-publish checks: the rules are the server's; the drawer groups them and lets errors block.

const CHECKS = {
  results: [
    {
      check: 'seo-description',
      entry: 'pages/home',
      path: 'src/content/pages/en/home.yaml',
      fieldPath: 'seo.description',
      severity: 'info',
      message: 'No search description — a search engine will quote whatever sentence it likes',
    },
    {
      check: 'image-alt',
      entry: 'pages/home',
      path: 'src/content/pages/de/home.yaml',
      fieldPath: 'photo.alt',
      severity: 'warn',
      message: 'Photo has no alt text — a reader using a screen reader is told nothing',
    },
    {
      check: 'media-missing',
      entry: 'listings/mill-house',
      path: 'src/content/listings/en/mill-house.yaml',
      fieldPath: 'photo.src',
      severity: 'error',
      message: 'Photo has nothing behind it any more — the page would show a broken image',
    },
  ],
};

/** The checks answer, and whatever the publish that follows it should get. */
const checking = (publishing: () => Response = () => Response.json({ paths: [] })) =>
  vi.fn(async (url: string) =>
    url === '/admin/api/publish/checks' ? Response.json(CHECKS) : publishing(),
  );

const settled = async () => {
  await tick();
  flushSync();
};

const messages = (root: ParentNode) =>
  Array.from(root.querySelectorAll('.check-group .notice .msg'), (n) => n.textContent);

// A merged line links to the default language, not whichever file the checks listed first.
test('a merged check line links to the default language, not the first it lists', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        results: [
          {
            check: 'image-alt',
            entry: 'pages/home',
            path: 'src/content/pages/de/home.yaml',
            fieldPath: 'photo.alt',
            severity: 'warn',
            message: 'Photo has no alt text',
          },
          {
            check: 'image-alt',
            entry: 'pages/home',
            path: 'src/content/pages/en/home.yaml',
            fieldPath: 'photo.alt',
            severity: 'warn',
            message: 'Photo has no alt text',
          },
        ],
      }),
    ),
  );
  const root = show([ENTRIES[0] as (typeof ENTRIES)[0]], 'en');
  await settled();

  const link = q<HTMLAnchorElement>(root, '.check-group .notice a');
  expect(link?.getAttribute('href')).toBe('/admin/c/pages/home?field=photo.alt&locale=en');
});

test('the checks are grouped under the entry they are about, worst first', async () => {
  vi.stubGlobal('fetch', checking());
  const root = show();
  await settled();

  expect(
    Array.from(root.querySelectorAll('.check-group h4'), (n) => n.textContent?.trim()),
  ).toEqual(['The Mill House Listings', 'Home Pages']);
  expect(messages(root)).toEqual([
    'Photo has nothing behind it any more — the page would show a broken image',
    'Photo has no alt text — a reader using a screen reader is told nothing',
    'No search description — a search engine will quote whatever sentence it likes',
  ]);
  expect(Array.from(root.querySelectorAll('.check-group .sev'), (n) => n.textContent)).toEqual([
    'Error',
    'Warning',
    'Note',
  ]);
  expect(q(root, '.checks-sum')?.textContent?.replace(/\s+/g, ' ')).toBe(
    '1 error · 1 warning · 1 note. The error has to go first. Checked over the 2 entries you have selected, and again when you press Publish.',
  );
  // A search field opens on the SEO panel, with the field's address and language for landing.
  expect(
    Array.from(root.querySelectorAll('.check-group .notice a'), (a) => a.getAttribute('href')),
  ).toEqual([
    '/admin/c/listings/mill-house?field=photo.src&locale=en',
    '/admin/c/pages/home?field=photo.alt&locale=de',
    '/admin/c/pages/home/seo?field=seo.description&locale=en',
  ]);
});

// A site with no SEO defaults gets two notes per entry, so notes fold under a count.
test('notes fold under a count while errors and warnings stay listed', async () => {
  vi.stubGlobal('fetch', checking());
  const root = show();
  await settled();

  expect(
    Array.from(root.querySelectorAll('.check-group > .notice .sev'), (n) => n.textContent),
  ).toEqual(['Error', 'Warning']);
  const fold = q<HTMLDetailsElement>(root, '.check-group details.check-notes');
  expect(fold?.open).toBe(false);
  expect(fold?.querySelector('summary')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('1 note');
  expect(fold?.querySelectorAll('.notice-info')).toHaveLength(1);
});

test('an error stops the publish and warnings never do', async () => {
  const fetchMock = checking();
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await settled();

  const button = q<HTMLButtonElement>(root, '.drawer-foot .btn-primary');
  expect(button?.disabled).toBe(true);
  expect(button?.textContent?.trim()).toBe('Fix 1 error to publish');

  // Unchecking the entry takes its checks with it; a warning and a note publish anyway.
  boxes(root)[1]?.click();
  await settled();

  expect(messages(root)).toEqual([
    'Photo has no alt text — a reader using a screen reader is told nothing',
    'No search description — a search engine will quote whatever sentence it likes',
  ]);
  expect(button?.disabled).toBe(false);
  expect(button?.textContent?.trim()).toBe('Publish anyway (1 warning)');
  expect(fetchMock).toHaveBeenLastCalledWith('/admin/api/publish/checks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: ['pages/home'] }),
  });
});

// A shared picture is one problem; two identical lines would send readers hunting a difference.
test('the same problem in two languages is one line naming both', async () => {
  const both = {
    results: [{ ...CHECKS.results[1], path: 'src/content/pages/en/home.yaml' }, CHECKS.results[1]],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/admin/api/publish/checks' ? Response.json(both) : Response.json({ paths: [] }),
    ),
  );
  const root = show();
  await settled();

  expect(messages(root)).toEqual([
    'Photo has no alt text — a reader using a screen reader is told nothing',
  ]);
  expect(
    Array.from(root.querySelectorAll('.check-group .notice .chip'), (n) => n.textContent),
  ).toEqual(['EN', 'DE']);
  // And it is counted the way it is read: one problem, not two files.
  expect(q(root, '.checks-sum')?.textContent?.replace(/\s+/g, ' ')).toContain('1 warning');
});

// The picture may have been deleted in another tab since, so the earlier all-clear is stale.
test('Publish runs the checks again and an error stops the commit', async () => {
  let answer = { results: [] as (typeof CHECKS)['results'] };
  const fetchMock = vi.fn(async (url: string) =>
    url === '/admin/api/publish/checks'
      ? Response.json(answer)
      : Response.json({ commit_sha: 'def4567890', paths: [] }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await settled();
  expect(q(root, '.checks')).toBeNull();

  answer = CHECKS;
  q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.click();
  await settled();

  expect(fetchMock).toHaveBeenLastCalledWith('/admin/api/publish/checks', expect.anything());
  expect(published).not.toHaveBeenCalled();
  expect(q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.textContent?.trim()).toBe(
    'Fix 1 error to publish',
  );
  // A button that goes disabled says nothing and drops the focus that pressed it.
  expect(q(root, '[role="alert"]')?.textContent).toBe(
    'Nothing was published. The checks found something in the way just now — it is listed above.',
  );
  expect(document.activeElement).toBe(q(root, '.drawer'));
});

test('final checks freeze their selected set and block its publish on an error', async () => {
  const finalChecks = deferred<void>();
  let holdFinalChecks = false;
  const fetchMock = vi.fn(async (url: string) => {
    if (url !== '/admin/api/publish') {
      if (holdFinalChecks) {
        await finalChecks.promise;
        return Response.json({
          results: [
            {
              ...CHECKS.results[2],
              entry: 'pages/home',
              path: 'src/content/pages/en/home.yaml',
            },
          ],
        });
      }
      return Response.json({ results: [] });
    }
    return Response.json({ commit_sha: 'def4567890', paths: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await settled();
  boxes(root)[1]?.click();
  await settled();

  holdFinalChecks = true;
  q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.click();
  flushSync();
  expect(boxes(root).every((box) => box.disabled)).toBe(true);
  expect(
    Array.from(root.querySelectorAll<HTMLButtonElement>('.drawer-tools button')).every(
      (button) => button.disabled,
    ),
  ).toBe(true);

  boxes(root)[0]?.click();
  finalChecks.resolve();
  await settled();

  expect(fetchMock.mock.calls.filter(([url]) => url === '/admin/api/publish')).toHaveLength(0);
  expect(q(root, '[role="alert"]')?.textContent).toContain('checks found something in the way');
});

test('an obsolete check response cannot replace the latest A to B to A result', async () => {
  const requests = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
  let request = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => requests[request++]?.promise ?? Response.json({ results: [] })),
  );
  const root = show();
  flushSync();

  boxes(root)[1]?.click();
  flushSync();
  boxes(root)[1]?.click();
  flushSync();

  requests[2]?.resolve(Response.json({ results: [] }));
  await settled();
  requests[1]?.resolve(Response.json({ results: [] }));
  await settled();
  requests[0]?.resolve(Response.json({ results: [CHECKS.results[2]] }));
  await settled();

  expect(q(root, '.checks')).toBeNull();
  expect(q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.textContent?.trim()).toBe(
    'Publish 2 changes',
  );
});

// The checks pass is a round trip, so a live button through it would commit the same set twice.
test('a second press while the checks are running commits nothing twice', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url === '/admin/api/publish/checks'
      ? Response.json({ results: [] })
      : Response.json({ commit_sha: 'def4567890', paths: [] }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await settled();

  const button = q<HTMLButtonElement>(root, '.drawer-foot .btn-primary');
  button?.click();
  flushSync();
  expect(button?.disabled).toBe(true);
  button?.click();
  await settled();

  expect(fetchMock.mock.calls.filter(([url]) => url === '/admin/api/publish')).toHaveLength(1);
});

// A lint that cannot be run is not a refusal.
test('checks that could not be run leave the publish where it was', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url === '/admin/api/publish/checks'
      ? new Response('nope', { status: 500 })
      : Response.json({ commit_sha: 'def4567890', paths: [] }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await settled();

  expect(q(root, '.checks-sum')?.textContent).toBe(
    'The checks could not be run this time, so nothing on this list has been looked at.',
  );
  const button = q<HTMLButtonElement>(root, '.drawer-foot .btn-primary');
  expect(button?.disabled).toBe(false);
  button?.click();
  await settled();

  expect(published).toHaveBeenCalled();
});

// The daily hidden check's note has no entry row to sit under, so it gets a group of its own.
test('a note about a page outside the set is listed under its own heading', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        results: [
          CHECKS.results[0],
          {
            check: 'hidden-long',
            entry: 'listings/old-barn',
            path: 'src/content/listings/en/old-barn.yaml',
            fieldPath: '',
            severity: 'info',
            message: 'The Old Barn has been hidden for over 4 months — long enough to decide',
          },
        ],
      }),
    ),
  );
  const root = show();
  await settled();

  expect(
    Array.from(root.querySelectorAll('.check-group h4'), (n) => n.textContent?.trim()),
  ).toEqual(['Home Pages', 'Elsewhere on the site']);
  expect(messages(root)).toEqual([
    'No search description — a search engine will quote whatever sentence it likes',
    'The Old Barn has been hidden for over 4 months — long enough to decide',
  ]);
  expect(q(root, '.checks-sum')?.textContent?.replace(/\s+/g, ' ')).toBe(
    '1 note — nothing is in the way. Checked over the 2 entries you have selected, and again when you press Publish.',
  );
  expect(root.querySelectorAll('.check-group .notice a')).toHaveLength(1);
});
