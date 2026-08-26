import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Pending from './Pending.svelte';

// Testing: the count line, one row per entry, which entries are checked to begin with and what
// Publish sends, a hold going out only when somebody checks it, the four answers a publish can
// get (published / an entry changed under it / the branch moved / an entry the schema is not
// done with), a refused entry taking itself out of the set so the rest still publish, the way
// out of a conflict, and the empty state.
// Not testing: Select all / none, which set the same state a checkbox does, and the drawer's
// chrome classes.

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
    // Its web address moved, so redirects.yaml owes it a rule. The file itself is never a row:
    // it is assembled at publish out of the entries that are going out.
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
} | null>(null);
const show = (initial = ENTRIES) => {
  entries = initial;
  app = mount(Pending, {
    target: document.body,
    props: {
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
  const root = show();
  for (const box of boxes(root)) box.click();
  flushSync();

  const button = q<HTMLButtonElement>(root, '.drawer-foot .btn-primary');
  expect(button?.disabled).toBe(true);
  expect(button?.textContent?.trim()).toBe('Publish');
  expect(q(root, '.drawer-foot .foot-note')?.textContent?.trim()).toBe(
    'Nothing is selected. Check what you want to publish.',
  );
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
  const fetchMock = vi.fn(async () => CONFLICT.clone());
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await refused(root);

  expect(q(root, '[role="alert"]')?.textContent).toBe(
    'Nothing was published. One entry changed in the repository after you opened it. Discard your changes to it to take what is there now.',
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

  fetchMock.mockImplementationOnce(async () =>
    Response.json({ commit_sha: 'def4567890', paths: ENTRIES[0]?.files }),
  );
  button?.click();
  await tick();

  expect(fetchMock).toHaveBeenLastCalledWith(
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

  expect(fetchMock).toHaveBeenLastCalledWith('/admin/api/drafts/listings/mill-house', {
    method: 'DELETE',
  });
  expect(discarded).toHaveBeenCalled();
  expect(q(root, '.dialog')).toBeNull();
  expect(q(root, '.change-row.is-blocked')).toBeNull();
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
    'Nothing was published. 2 entries changed in the repository after you opened them. Discard your changes to them to take what is there now.',
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

  expect(fetchMock).toHaveBeenLastCalledWith('/admin/api/drafts/pages/home', { method: 'DELETE' });
  expect(q(root, '[role="alert"]')?.textContent).toBe(
    'Nothing was published. One entry changed in the repository after you opened it. Discard your changes to it to take what is there now.',
  );
  expect(root.querySelectorAll('.change-row.is-blocked').length).toBe(1);
});

// S1: a blank new entry is a publishable row whose file the site's own schema rejects. The
// commit is refused whole and the rows that are not ready say which they are.
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

// The footer has to say which nothing this is: a refusal that leaves nothing selected is not
// "check something" — every checkbox in the drawer is disabled.
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

// The other blocking refusal: the entry's own files disagree about which blocks it has, which
// is settled in the editor and not here — so the row says that rather than "changed in the
// repository", and Discard is not offered for it.
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
  expect(q(root, '.change-row.is-blocked .change-actions')).toBe(null);
  expect(published).not.toHaveBeenCalled();
});

// A hold is a promise between colleagues, so the drawer has to say what it kept back before
// anybody presses Publish — a count that quietly went down is not a reason anybody can read.
const HELD = [
  ENTRIES[0] as (typeof ENTRIES)[number],
  { ...(ENTRIES[1] as (typeof ENTRIES)[number]), held_by: { id: 'u1', name: 'Martin' } },
];

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

// The hold is a courtesy, not a permission: anybody may include it, and the drawer says what
// including it does before they press the button rather than after.
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

// A publish that leaves something behind does not empty the drawer, so the empty state cannot
// be where it says what went out: a client who sees the list still standing has been told
// nothing about their commit.
// Selection is per publish and not stored, so what a publish leaves behind is checked the way
// a freshly opened drawer would have it — not the way the last press happened to leave it.
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

// The panel a publish leaves behind is where the build and the way back live — p7d of the
// mockup. It is neutral rather than green: the commit landed, the site has not.
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
  build = { commit_sha: 'c0ffee11', state: 'building', started_at: Date.now() - 45_000 };
  flushSync();

  const pill = q(root, '.publish-result .pill');
  // With the elapsed time, the way the mockup's fourth frame reads it — the shell's pill and
  // this one are the same component, so they cannot say different things again.
  expect(pill?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Building… 0m 45s');
  expect(pill?.className).toContain('pill-building');
});

// A colleague publishing something else moves the shell's pill on; this panel is about the
// commit this drawer made and nothing else.
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
