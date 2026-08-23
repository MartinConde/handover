import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import EntryList from './EntryList.svelte';

// Testing: one row per entry with the title the API returned, the derived file name the new
// entry dialog shows, what create / rename / delete send, and the empty state.
// Not testing: which collection the sidebar routed here, or the shell around the list.

const ENTRIES = [
  {
    id: 'mill-house',
    locales: { en: { title: 'The Mill House', path: 'src/content/listings/en/mill-house.yaml' } },
  },
  {
    id: 'seaview-cottage',
    locales: {
      en: { title: 'Seaview Cottage', path: 'src/content/listings/en/seaview-cottage.yaml' },
    },
  },
];

let app: ReturnType<typeof mount>;
const changed = vi.fn();
// Loading the list is a bare GET; every action carries an init, which is what tells them apart.
const api = (entries: unknown[], reply: Record<string, unknown> = {}, locales = ['en']) => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    init ? Response.json(reply) : Response.json({ entries, locales }),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};

const show = () => {
  app = mount(EntryList, {
    target: document.body,
    props: { collection: 'listings', onchanged: changed },
  });
  flushSync();
  return document.body;
};
afterEach(() => {
  unmount(app);
  changed.mockClear();
  vi.unstubAllGlobals();
});

const q = <T extends Element>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
const tick = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
const click = async (root: ParentNode, sel: string) => {
  q<HTMLButtonElement>(root, sel)?.click();
  await tick();
};
const input = (root: ParentNode, sel: string) => {
  const found = q<HTMLInputElement>(root, sel);
  if (!found) throw new Error(`no input matching ${sel}`);
  return found;
};
const type = (root: ParentNode, sel: string, value: string) => {
  const found = input(root, sel);
  found.value = value;
  found.dispatchEvent(new Event('input'));
  flushSync();
};

test('the list is one row per entry, titled and linked by file name', async () => {
  api(ENTRIES);
  const root = show();
  await tick();
  expect(q(root, '.list-toolbar .count')?.textContent).toBe('2');
  expect(Array.from(root.querySelectorAll('.row .td.title a'), (a) => a.textContent)).toEqual([
    'The Mill House',
    'Seaview Cottage',
  ]);
  expect(q<HTMLAnchorElement>(root, '.row .td.title a')?.getAttribute('href')).toBe(
    '/admin/c/listings/mill-house',
  );
});

test('a collection with no entries offers the one action that makes sense', async () => {
  api([]);
  const root = show();
  await tick();
  expect(root.querySelectorAll('.row').length).toBe(0);
  expect(q(root, '.empty h2')?.textContent).toBe('No listings yet');
  expect(q(root, '.empty .btn-primary')?.textContent?.trim()).toBe('New listing');
});

test('the new entry dialog shows the file name the title will produce', async () => {
  api(ENTRIES);
  const root = show();
  await tick();
  await click(root, '.list-toolbar .btn-primary');
  type(root, '.dialog input#new-title', 'Café & Bar / 2026');
  expect(q(root, '.dialog .filename')?.textContent).toBe('cafe-bar-2026');
});

test('a title already used in the collection previews the collision suffix', async () => {
  api(ENTRIES);
  const root = show();
  await tick();
  await click(root, '.list-toolbar .btn-primary');
  type(root, '.dialog input#new-title', 'Seaview Cottage');
  expect(q(root, '.dialog .filename')?.textContent).toBe('seaview-cottage-2');
});

test('creating sends the title and opens the entry the server named', async () => {
  const fetcher = api(ENTRIES, { slug: 'cafe-bar-2026' });
  const root = show();
  await tick();
  await click(root, '.list-toolbar .btn-primary');
  type(root, '.dialog input#new-title', 'Café & Bar / 2026');
  await click(root, '.dialog .btn-primary');

  expect(fetcher).toHaveBeenCalledWith('/admin/api/entries/listings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Café & Bar / 2026' }),
  });
});

test('renaming sends the new file name and reloads the list', async () => {
  const fetcher = api(ENTRIES, { slug: 'the-old-mill' });
  const root = show();
  await tick();
  await click(root, '.row [aria-label="Rename The Mill House"]');
  expect(input(root, '.dialog input#rename-to').value).toBe('mill-house');
  type(root, '.dialog input#rename-to', 'The Old Mill');
  await click(root, '.dialog .btn-primary');

  expect(fetcher).toHaveBeenCalledWith('/admin/api/entries/listings/mill-house/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'The Old Mill' }),
  });
  expect(changed).toHaveBeenCalled();
  expect(q(root, '.dialog')).toBeNull();
});

test('deleting names the entry it is about and sends one DELETE', async () => {
  const fetcher = api(ENTRIES);
  const root = show();
  await tick();
  await click(root, '.row [aria-label="Delete The Mill House"]');
  expect(q(root, '.dialog h2')?.textContent).toBe('Delete The Mill House?');
  await click(root, '.dialog .btn-danger');

  expect(fetcher).toHaveBeenCalledWith('/admin/api/entries/listings/mill-house', {
    method: 'DELETE',
  });
  expect(changed).toHaveBeenCalled();
});

test('a refused rename says so and keeps the dialog open', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init
        ? new Response('Publish this entry before renaming it', { status: 409 })
        : Response.json({ entries: ENTRIES }),
    ),
  );
  const root = show();
  await tick();
  await click(root, '.row [aria-label="Rename The Mill House"]');
  await click(root, '.dialog .btn-primary');

  expect(q(root, '.dialog [role="alert"]')?.textContent).toContain('Publish this entry');
  expect(q(root, '.dialog')).not.toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

// Which languages an entry has a file in, one chip each in the order the site declares them.
// One language declared and the column is not drawn at all — nor emptied, nor always 1/1.
test('a row says which languages it has been written in', async () => {
  api(
    [
      ENTRIES[0],
      { id: 'impressum', locales: { de: { title: 'Impressum', path: 'x/de/impressum.yaml' } } },
    ],
    {},
    ['en', 'de'],
  );
  const root = show();
  await tick();

  expect(
    Array.from(root.querySelectorAll('.row'), (row) =>
      Array.from(
        row.querySelectorAll('.chips .chip'),
        (chip) =>
          `${chip.textContent?.trim()}${chip.classList.contains('chip-missing') ? '?' : ''}`,
      ),
    ),
  ).toEqual([
    ['EN', 'DE?'],
    ['EN?', 'DE'],
  ]);
});

test('a site that declares one language has no languages column', async () => {
  api(ENTRIES);
  const root = show();
  await tick();

  expect(q(root, '.chips')).toBeNull();
  expect(Array.from(root.querySelectorAll('.th'), (th) => th.textContent)).not.toContain(
    'Languages',
  );
});

test('an entry written only in a second language is listed by the words it has', async () => {
  api(
    [{ id: 'impressum', locales: { de: { title: 'Impressum', path: 'x/de/impressum.yaml' } } }],
    {},
    ['en', 'de'],
  );
  const root = show();
  await tick();

  expect(q(root, '.row .td.title a')?.textContent).toBe('Impressum');
});
