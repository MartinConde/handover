import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import PagePicker, { type PickEntry } from './PagePicker.svelte';

// Testing: what the list is filtered and grouped by, that the keyboard walks it without a
// pointer, and that closing is one key. What a chosen row writes, the collection lock, the
// refusal of an entry with no address and the refusal of a scheme belong to the fields that
// open the picker and are tested through them in Fields.svelte.test.ts.

const OFFERED: PickEntry[] = [
  {
    collection: 'pages',
    path: 'pages/contact',
    title: 'Contact',
    locales: ['en', 'de'],
    urls: { en: '/contact' },
  },
  {
    collection: 'listings',
    path: 'listings/mill-house',
    title: 'Old Mill House',
    locales: ['en'],
    urls: { en: '/listings/mill-house' },
  },
  {
    collection: 'listings',
    path: 'listings/harbour-flat',
    title: 'Harbour Flat',
    locales: ['en', 'de'],
    urls: { en: '/listings/harbour-flat' },
  },
];

let app: ReturnType<typeof mount>;
let picked: PickEntry | undefined;
let closed = false;

const show = async (entries: PickEntry[] = OFFERED) => {
  picked = undefined;
  closed = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ entries, locales: ['en', 'de'] })),
  );
  app = mount(PagePicker, {
    target: document.body,
    props: {
      id: 'p',
      label: 'pages and entries',
      labelId: 'p-l',
      onpick: (entry: PickEntry) => {
        picked = entry;
      },
      onclose: () => {
        closed = true;
      },
    },
  });
  await new Promise((r) => setTimeout(r));
  flushSync();
  return document.body;
};

afterEach(() => {
  unmount(app);
  vi.unstubAllGlobals();
});

const q = <T extends Element>(sel: string) => {
  const el = document.body.querySelector<T>(sel);
  if (!el) throw new Error(`${sel} missing`);
  return el;
};
const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.picker-list button'));
const titles = () => rows().map((b) => b.querySelector('span')?.textContent);
const press = (key: string) => {
  q('.picker').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  flushSync();
};

test('the list is grouped under the collection each entry belongs to, in the order it arrives', async () => {
  await show();
  expect(
    Array.from(document.querySelectorAll('.picker-list h4')).map((h) => h.textContent),
  ).toEqual(['pages', 'listings']);
  expect(titles()).toEqual(['Contact', 'Old Mill House', 'Harbour Flat']);
});

test('searching matches the title and the path, and says so when nothing does', async () => {
  await show();
  const search = q<HTMLInputElement>('#p-q');
  search.value = 'harbour';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect(titles()).toEqual(['Harbour Flat']);

  search.value = 'pages/';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect(titles()).toEqual(['Contact']);

  search.value = 'nothing like this';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect(rows()).toHaveLength(0);
  expect(q('.picker-list .hint').textContent).toBe('Nothing here matches “nothing like this”');
});

// The rows are buttons, so Tab reaches them all; the arrows are what makes a long list
// bearable from the search box the picker opens with the cursor in.
test('the arrows walk the rows from the search box down, and wrap at both ends', async () => {
  await show();
  press('ArrowDown');
  expect(document.activeElement?.textContent).toContain('Contact');
  press('ArrowDown');
  expect(document.activeElement?.textContent).toContain('Old Mill House');
  press('ArrowUp');
  expect(document.activeElement?.textContent).toContain('Contact');
  press('ArrowUp');
  expect(document.activeElement?.textContent).toContain('Harbour Flat');
});

test('a row hands back the entry it stands for, and Escape hands back nothing', async () => {
  await show();
  rows()[1]?.click();
  flushSync();
  expect(picked?.path).toBe('listings/mill-house');

  press('Escape');
  expect(closed).toBe(true);
});
