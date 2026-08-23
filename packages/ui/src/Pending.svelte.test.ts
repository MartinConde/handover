import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Pending from './Pending.svelte';

// Testing: the count and summary lines, one row per pending file, what Publish sends, the
// three answers it can get (published / a file changed under it / the branch moved), the way
// out of the first of those, and the empty state.
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
