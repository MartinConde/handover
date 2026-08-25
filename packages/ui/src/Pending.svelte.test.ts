import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Pending from './Pending.svelte';

// Testing: the count and summary lines, one row per pending file, the files a hold keeps out
// of the publish, what Publish sends, the four answers it can get (published / a file changed
// under it / the branch moved / a file the schema is not done with), the way out of the first
// of those, and the empty state.
// Not testing: the drawer's chrome classes or the indicator that opens it.

const FILES = [
  { path: 'src/content/pages/en/home.yaml', updated_at: 1755864000000 },
  { path: 'src/content/listings/en/mill-house.yaml', updated_at: 1755863000000 },
];

let app: ReturnType<typeof mount>;
let files = $state(FILES);
const published = vi.fn();
const discarded = vi.fn();
const show = (initial = FILES) => {
  files = initial;
  app = mount(Pending, {
    target: document.body,
    props: {
      get files() {
        return files;
      },
      onclose: () => {},
      onpublished: published,
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
  vi.unstubAllGlobals();
});

const q = <T extends Element>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
const tick = () => new Promise((r) => setTimeout(r, 0));

test('the drawer counts the pending files and lists one row per file', () => {
  const root = show();
  expect(q(root, '.drawer-meta .count')?.textContent).toBe('2 files');
  expect(q(root, '.drawer-meta.is-summary')?.textContent).toBe('1 page · 1 listing');
  expect(Array.from(root.querySelectorAll('.change-row .name'), (n) => n.textContent)).toEqual([
    'pages/en/home.yaml',
    'listings/en/mill-house.yaml',
  ]);
});

test('Publish commits the whole set and then reports what went out', async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({ commit_sha: 'def4567890', paths: FILES.map((f) => f.path) }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  const button = q<HTMLButtonElement>(root, '.drawer-foot .btn-primary');
  expect(button?.textContent).toBe('Publish 2 files');
  button?.click();
  await tick();
  files = [];
  flushSync();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/publish', { method: 'POST' });
  expect(published).toHaveBeenCalled();
  expect(q(root, '.empty h2')?.textContent).toBe('Published 2 files');
  expect(q(root, '.drawer-foot')).toBeNull();
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

test('a file changed in the repository is named on its own row and blocks the publish', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => CONFLICT.clone()),
  );
  const root = show();
  await refused(root);

  expect(q(root, '[role="alert"]')?.textContent).toBe(
    'Nothing was published. One file changed in the repository after you opened it. Discard your changes to it to take what is there now.',
  );
  expect(q(root, '.change-row.is-blocked .name')?.textContent).toBe('listings/en/mill-house.yaml');
  const button = q<HTMLButtonElement>(root, '.drawer-foot .btn-primary');
  // Retrying can only be refused again: the way out is the row's, not the footer's.
  expect(button?.textContent).toBe('Publish 2 files');
  expect(button?.disabled).toBe(true);
  expect(published).not.toHaveBeenCalled();
});

test('discarding the conflicted file asks first, then drops that draft alone', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'DELETE' ? Response.json({}) : CONFLICT.clone(),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await refused(root);

  q<HTMLButtonElement>(root, '.change-row.is-blocked .change-actions .btn')?.click();
  flushSync();
  expect(q(root, '.dialog h2')?.textContent).toBe(
    'Discard your changes to listings/en/mill-house.yaml?',
  );
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
  const button = q<HTMLButtonElement>(root, '.drawer-foot .btn-primary');
  expect(button?.textContent).toBe('Try again');
  expect(button?.disabled).toBe(false);
});

test('with nothing pending there is no Publish button to press', () => {
  const root = show([]);
  expect(q(root, '.drawer-meta')?.textContent).toBe('Nothing to publish');
  expect(q(root, '.empty h2')?.textContent).toBe('Everything is published');
  expect(q(root, '.drawer-foot')).toBeNull();
});

test('discarding one of two conflicted files leaves the other named and says so', async () => {
  let release: (() => void) | undefined;
  const paused = new Promise<void>((r) => (release = r));
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'DELETE')
      return Response.json({ error: 'refused', paths: FILES.map((f) => f.path) }, { status: 409 });
    await paused;
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await refused(root);

  expect(q(root, '[role="alert"]')?.textContent).toBe(
    'Nothing was published. 2 files changed in the repository after you opened them. Discard your changes to them to take what is there now.',
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
    'Nothing was published. One file changed in the repository after you opened it. Discard your changes to it to take what is there now.',
  );
  expect(root.querySelectorAll('.change-row.is-blocked').length).toBe(1);
});

// S1: a blank new entry is a publishable row whose file the site's own schema rejects. The
// commit is refused whole and the rows that are not ready say which they are.
test('a file the schema is not done with is named on its row and blocks the publish', async () => {
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
    'Nothing was published. One file is not finished — open it to see what is missing. Delete the entry if it cannot be filled in yet.',
  );
  expect(q(root, '.change-row.is-blocked .badge-danger')?.textContent).toBe('Not ready to publish');
  // Unlike a conflict, this one can come right: finish the entry, come back, press again.
  const button = q<HTMLButtonElement>(root, '.drawer-foot .btn-primary');
  expect(button?.textContent).toBe('Try again');
  expect(button?.disabled).toBe(false);
  expect(published).not.toHaveBeenCalled();
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
    'Nothing was published. One file belongs to an entry whose languages disagree about which blocks it has — the files have to agree before it can go out.',
  );
  expect(q(root, '.change-row.is-blocked .badge-danger')?.textContent).toBe('Languages disagree');
  expect(q(root, '.change-row.is-blocked .change-actions')).toBe(null);
  expect(published).not.toHaveBeenCalled();
});

// A hold is a promise between colleagues, so the drawer has to say what it kept back before
// anybody presses Publish — a count that quietly went down is not a reason anybody can read.
const HELD = [
  { path: 'src/content/pages/en/home.yaml', updated_at: 1755864000000 },
  {
    path: 'src/content/listings/en/mill-house.yaml',
    updated_at: 1755863000000,
    held_by: { id: 'u1', name: 'Martin' },
  },
];

test('a file on hold is listed apart, named and out of what Publish commits', () => {
  const root = show(HELD);

  expect(q(root, '.change-group .group-title')?.textContent).toBe('On hold');
  const row = q(root, '.change-group .change-row');
  expect(row?.classList.contains('is-held')).toBe(true);
  expect(q(root, '.change-group .badge-warn')?.textContent).toBe('On hold · Martin');
  expect(q(root, '.drawer-foot .btn-primary')?.textContent).toBe('Publish 1 file');
  expect(q(root, '.drawer-meta.is-summary')?.textContent).toBe('1 page · 1 listing · 1 on hold');
});

test('a set that is entirely on hold has nothing to publish and says why', () => {
  const root = show([{ ...HELD[1] }] as typeof HELD);

  const button = q<HTMLButtonElement>(root, '.drawer-foot .btn-primary');
  expect(button?.disabled).toBe(true);
  expect(button?.textContent?.trim()).toBe('Publish');
  expect(q(root, '.drawer-foot .foot-note')?.textContent).toContain('on hold');
});

// A publish that leaves something behind does not empty the drawer, so the empty state cannot
// be where it says what went out: a client who sees the list still standing has been told
// nothing about their commit.
test('a publish that left a hold behind still says what it published', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ commit_sha: 'def4567890', paths: [HELD[0]?.path] })),
  );
  const root = show(HELD);

  q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.click();
  await tick();
  // What the shell hands back once the published row has gone: the hold, on its own.
  files = HELD.slice(1);
  flushSync();

  expect(q(root, '.publish-result h3')?.textContent).toBe('Published 1 file');
  expect(q(root, '.change-group .group-title')?.textContent).toBe('Still on hold');
  expect(published).toHaveBeenCalled();
});
