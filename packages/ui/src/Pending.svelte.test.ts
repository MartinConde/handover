import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Pending from './Pending.svelte';

// Testing: the count and summary lines, one row per pending file, what Publish sends, the
// two answers it can get (published / changed in the repository) and the empty state.
// Not testing: the drawer's chrome classes or the indicator that opens it.

const FILES = [
  { path: 'src/content/pages/en/home.yaml', updated_at: 1755864000000 },
  { path: 'src/content/listings/en/mill-house.yaml', updated_at: 1755863000000 },
];

let app: ReturnType<typeof mount>;
let files = $state(FILES);
const published = vi.fn();
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
    },
  });
  flushSync();
  return document.body;
};
afterEach(() => {
  unmount(app);
  published.mockClear();
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

test('a file changed in the repository is reported and nothing is published', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('Changed in the repository since they were opened: a', {
          status: 409,
        }),
    ),
  );
  const root = show();
  q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.click();
  await tick();
  flushSync();

  expect(q(root, '[role="alert"]')?.textContent).toContain('changed in the repository');
  expect(published).not.toHaveBeenCalled();
  expect(q<HTMLButtonElement>(root, '.drawer-foot .btn-primary')?.textContent).toBe('Try again');
});

test('with nothing pending there is no Publish button to press', () => {
  const root = show([]);
  expect(q(root, '.drawer-meta')?.textContent).toBe('Nothing to publish');
  expect(q(root, '.empty h2')?.textContent).toBe('Everything is published');
  expect(q(root, '.drawer-foot')).toBeNull();
});
