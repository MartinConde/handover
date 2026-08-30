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
let refusal: { status: number; body: unknown } | undefined;

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
      if (init?.method === 'DELETE')
        return refusal
          ? Response.json(refusal.body, { status: refusal.status })
          : Response.json({ deleted: 'a' });
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
  refusal = undefined;
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

// Archiving is the answer to "get rid of it": it is never gated, and the same button takes it
// back out again.
test('archiving is one button, and an archived picture is offered the way back', async () => {
  media = [item()];
  saved = item({ archived: true });
  await show();
  click('.tile .tile-link');
  expect(q('.lib-side .actions .archive').textContent?.trim()).toBe('Archive');

  click('.lib-side .actions .archive');
  await settle();

  expect(asked.at(-1)).toMatchObject({
    url: `/admin/api/media/${'a'.repeat(64)}`,
    method: 'PATCH',
    body: { archived: true },
  });
  expect(q('.lib-side .actions .archive').textContent?.trim()).toBe('Unarchive');
});

test('delete is off while the picture is used, and the line says by how many', async () => {
  media = [item({ uses: [{ entry: 'pages/home', title: 'Home', href: '/admin/c/pages/home' }] })];
  await show();
  click('.tile .tile-link');
  expect(q<HTMLButtonElement>('.lib-side .actions .delete').disabled).toBe(true);
  expect(q('.lib-side .delete-hint').textContent).toContain('used in 1 place');
});

// The dialog is the *only* way to the request, and it says what deleting is rather than asking
// whether the client is sure.
test('deleting a picture nothing uses asks first, then takes the tile away', async () => {
  media = [item(), item({ id: 'b'.repeat(64), filename: 'old-banner.jpg' })];
  await show();
  click('.tile .tile-link');
  click('.lib-side .actions .delete');
  expect(q('.dialog h2').textContent).toContain('front-of-house.jpg');

  click('.dialog .btn-danger');
  await settle();

  expect(asked.at(-1)).toMatchObject({
    url: `/admin/api/media/${'a'.repeat(64)}`,
    method: 'DELETE',
  });
  expect(document.querySelector('.dialog')).toBeNull();
  expect(Array.from(document.querySelectorAll('.tile .name'), (n) => n.textContent)).toEqual([
    'old-banner.jpg',
  ]);
});

// The gate is the server's, and the browser's copy of the count can be a build behind it.
test('a delete the server refuses says so and leaves the picture where it is', async () => {
  media = [item()];
  refusal = { status: 409, body: { error: 'This is used in 2 places and cannot be deleted.' } };
  await show();
  click('.tile .tile-link');
  click('.lib-side .actions .delete');
  click('.dialog .btn-danger');
  await settle();

  expect(q('[role="alert"]').textContent).toContain('used in 2 places');
  expect(document.querySelectorAll('.tile')).toHaveLength(1);
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

// axe sees none of this: a dialog that opens takes focus, and cancelling gives it back to the
// button that opened it.
test('the delete dialog takes focus and hands it back on cancel', async () => {
  media = [item()];
  await show();
  click('.tile .tile-link');
  const del = q<HTMLButtonElement>('.lib-side .actions .delete');
  del.focus();
  del.click();
  flushSync();

  expect(document.activeElement?.textContent).toBe('Cancel');
  click('.dialog .btn');
  expect(document.activeElement).toBe(del);
});
