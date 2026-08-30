import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Library from './Library.svelte';
import type { LibraryItem } from './upload.js';

// Testing: the search reaching the server rather than filtering what was loaded, the usage
// badge and the entries behind it, and tags written through the panel.
// Not testing: uploading through the component (jsdom has no canvas; upload.ts is unit-tested)
// or styling.

const item = (over: Partial<LibraryItem> = {}): LibraryItem => ({
  id: 'a'.repeat(64),
  src: `media/${'a'.repeat(64)}.webp`,
  filename: 'front-of-house.jpg',
  url: 'https://cdn.example.com/media/a.webp',
  mime: 'image/webp',
  bytes: 612_000,
  width: 2400,
  height: 1600,
  alt: null,
  tags: [],
  archived: false,
  createdAt: 1_746_230_000_000,
  uses: [],
  ...over,
});

let app: ReturnType<typeof mount>;
/** Every request the screen made, and what the library answers with. */
let asked: { url: string; method: string; body: unknown }[] = [];
let media: LibraryItem[] = [];
let saved: LibraryItem | undefined;

const server = () => {
  asked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      asked.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (init?.method === 'PATCH') return Response.json({ media: saved });
      return Response.json({ media });
    }),
  );
};

const show = async () => {
  server();
  app = mount(Library, { target: document.body, props: { base: 'https://cdn.example.com' } });
  await settle();
  return document.body;
};

// The screen waits before it searches, so a client typing a word spends one request on it.
const settle = async () => {
  await new Promise((r) => setTimeout(r, 250));
  flushSync();
};

afterEach(() => {
  unmount(app);
  vi.unstubAllGlobals();
  media = [];
  saved = undefined;
});

const q = <T extends Element>(sel: string) => {
  const el = document.body.querySelector<T>(sel);
  if (!el) throw new Error(`${sel} missing`);
  return el;
};
const click = (sel: string) => {
  q<HTMLElement>(sel).click();
  flushSync();
};

test('a tile says how many places its picture is used in, and none says so too', async () => {
  media = [
    item({
      uses: [
        {
          entry: 'listings/mill-house',
          title: 'The Mill House',
          href: '/admin/c/listings/mill-house',
        },
        { entry: 'pages/home', title: 'Home', href: '/admin/c/pages/home' },
      ],
    }),
    item({ id: 'b'.repeat(64), src: 'media/b.webp', filename: 'old-banner.jpg', uses: [] }),
  ];
  await show();
  expect(Array.from(document.querySelectorAll('.tile .badge'), (b) => b.textContent)).toEqual([
    'used in 2 places',
    'not used yet',
  ]);
});

test('the panel lists the entries a picture is used in, each linking to its editor', async () => {
  media = [
    item({
      uses: [
        {
          entry: 'listings/mill-house',
          title: 'The Mill House',
          href: '/admin/c/listings/mill-house',
        },
      ],
    }),
  ];
  await show();
  click('.tile .tile-link');
  const link = q<HTMLAnchorElement>('.usage-list a');
  expect(link.textContent).toBe('The Mill House');
  expect(link.getAttribute('href')).toBe('/admin/c/listings/mill-house');
  expect(q('.usage-list .where').textContent).toBe('listings');
});

// The table does the searching: a tag is not in what was loaded, and a name past the hundredth
// row would be a match nobody could find by filtering the browser's copy.
test('a search is asked of the server, with the archived shown', async () => {
  media = [item()];
  await show();
  const box = q<HTMLInputElement>('#lib-q');
  box.value = 'seaview';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  expect(asked.at(-1)?.url).toBe('/admin/api/media?kind=images&archived=1&q=seaview');
});

test('a tag typed into the panel is saved to the row and shown on it', async () => {
  media = [item()];
  saved = item({ tags: ['seaview'] });
  await show();
  click('.tile .tile-link');
  const box = q<HTMLInputElement>('#lib-tags');
  box.value = ' seaview ';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  expect(asked.at(-1)).toMatchObject({
    url: `/admin/api/media/${'a'.repeat(64)}`,
    method: 'PATCH',
    body: { tags: ['seaview'] },
  });
  expect(q('.tag-row .badge').textContent?.trim()).toBe('seaview ×');
});

// Nothing in the library destroys, and the two that will are 4.3's. They are drawn with the
// reason rather than left out, so the client can see the screen is not finished.
test('archive and delete are shown and cannot be pressed yet', async () => {
  media = [item()];
  await show();
  click('.tile .tile-link');
  const off = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.lib-side .actions button'),
  ).filter((b) => b.disabled);
  expect(off.map((b) => b.textContent?.trim())).toEqual(['Set focal point', 'Archive', 'Delete']);
});

// A row the reconciliation cron wrote: an object in the bucket that no upload ever confirmed,
// so nothing measured the picture.
test('a recovered picture is flagged and says why it is there', async () => {
  media = [item({ width: null, height: null })];
  await show();
  expect(q('.tile .flag').textContent).toBe('Recovered');
  click('.tile .tile-link');
  expect(q('.lib-side .notice').textContent).toContain('found in storage without a record');
});
