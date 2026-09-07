import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Media from './Media.svelte';
import type { MediaItem } from './upload.js';

// jsdom has no canvas, so the upload result is the one boundary faked; upload.ts is tested alone.
let uploaded: MediaItem;
vi.mock('./upload.js', async (original) => ({
  ...(await original<typeof import('./upload.js')>()),
  uploadImage: vi.fn(async () => uploaded),
}));

const item = (over: Partial<MediaItem>): MediaItem => ({
  id: 'a'.repeat(64),
  src: 'media/a.webp',
  filename: 'a.webp',
  url: 'https://cdn.example.com/media/a.webp',
  width: 2400,
  height: 1600,
  ...over,
});

let app: ReturnType<typeof mount>;
let picked: MediaItem[] | undefined;
/** Every library read the picker made, newest last. */
let asked: string[] = [];
const open = async (media: MediaItem[], preset: Record<string, unknown> = {}, many = false) => {
  picked = undefined;
  asked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url);
      return Response.json({ media });
    }),
  );
  app = mount(Media, {
    target: document.body,
    props: {
      kind: 'images',
      label: 'Hero image',
      preset,
      base: 'https://cdn.example.com',
      many,
      onpick: (m: MediaItem[]) => {
        picked = m;
      },
      onclose: () => {},
    },
  });
  await new Promise((r) => setTimeout(r));
  flushSync();
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

test('a picture too narrow for the field is shown, refused, and says both numbers', async () => {
  await open(
    [
      item({ id: 'b'.repeat(64), filename: 'winter-storm.jpg', width: 800, height: 450 }),
      item({ filename: 'front-of-house.jpg' }),
    ],
    { ratio: '16:9', max: 2400, min: 1600 },
  );
  const tiles = document.querySelectorAll('.tile');
  expect(tiles).toHaveLength(2);
  const refused = q<HTMLInputElement>(`input[value="${'b'.repeat(64)}"]`);
  // aria-disabled, not disabled: a disabled radio takes no focus and the reason is never heard.
  expect(refused.getAttribute('aria-disabled')).toBe('true');
  expect(refused.disabled).toBe(false);
  expect(q(`#${refused.getAttribute('aria-describedby')}`).textContent).toBe(
    'Too small for this field — its widest 16:9 crop is 800 px, this field needs 1600',
  );
  refused.click();
  flushSync();
  expect(q<HTMLButtonElement>('.picker-foot .btn-primary').disabled).toBe(true);
});

// The rule the floor exists for: 1600 px tall, and still only a 900 px hero.
test('a portrait photo cannot pass the floor sideways', async () => {
  await open([item({ filename: 'phone.jpg', width: 900, height: 1600 })], {
    ratio: '16:9',
    max: 2400,
    min: 1600,
  });
  expect(q('.tile .why').textContent).toBe(
    'Too small for this field — its widest 16:9 crop is 900 px, this field needs 1600',
  );
});

test('a field with no floor refuses nothing, and Insert hands back the asset', async () => {
  await open([item({ filename: 'small.jpg', width: 400, height: 300 })], { max: 2400 });
  expect(document.querySelector('.tile .why')).toBeNull();
  q<HTMLInputElement>('.tile input').click();
  flushSync();
  q<HTMLButtonElement>('.picker-foot .btn-primary').click();
  expect(picked?.map((i) => i.src)).toEqual(['media/a.webp']);
});

// Uploading is not choosing: a picture too narrow must not be inserted for arriving last.
test('a picture uploaded into a field too narrow for it is listed, not selected', async () => {
  uploaded = item({ id: 'c'.repeat(64), filename: 'small.jpg', width: 800, height: 450 });
  await open([], { ratio: '16:9', max: 2400, min: 1600 });
  const chooser = q<HTMLInputElement>('input[type="file"]');
  Object.defineProperty(chooser, 'files', {
    value: [new File([new Uint8Array([1])], 'small.jpg', { type: 'image/jpeg' })],
  });
  chooser.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r));
  flushSync();
  expect(q('.upload-row .state').textContent).toBe('Uploaded');
  expect(q('.tile .why').textContent).toContain('its widest 16:9 crop is 800 px');
  expect(q<HTMLButtonElement>('.picker-foot .btn-primary').disabled).toBe(true);
});

// Reconciliation recovers objects with no row, and a HEAD cannot say how wide a picture is.
test('a picture whose size the library does not know cannot be chosen', async () => {
  await open([item({ width: null, height: null })], { ratio: '16:9', max: 2400 });
  expect(q('.tile .why').textContent).toBe(
    'This picture’s size is not known yet, so it cannot be chosen for a field',
  );
  q<HTMLInputElement>('.tile input').click();
  flushSync();
  expect(q<HTMLButtonElement>('.picker-foot .btn-primary').disabled).toBe(true);
});

// The order is the order they were ticked, and un-ticking takes one back out.
test('a gallery field takes several pictures, in the order they were ticked', async () => {
  await open(
    [
      item({ id: 'a'.repeat(64), filename: 'harbour.jpg' }),
      item({ id: 'b'.repeat(64), src: 'media/b.webp', filename: 'garden.jpg' }),
      item({ id: 'c'.repeat(64), src: 'media/c.webp', filename: 'kitchen.jpg' }),
    ],
    { ratio: '4:3' },
    true,
  );
  const tick = (id: string) => {
    q<HTMLInputElement>(`input[value="${id.repeat(64)}"]`).click();
    flushSync();
  };
  expect(q<HTMLInputElement>('.tile input').type).toBe('checkbox');
  tick('c');
  tick('a');
  tick('b');
  expect(
    Array.from(document.querySelectorAll('.picker-side .upload-row .name'), (n) => n.textContent),
  ).toEqual(['kitchen.jpg', 'harbour.jpg', 'garden.jpg']);
  // Un-ticking is × on the row here, not hunting the tile down again in a grid of forty.
  q<HTMLButtonElement>('[aria-label="Remove harbour.jpg"]').click();
  flushSync();
  expect(q('.picker-foot .btn-primary').textContent?.trim()).toBe('Insert 2 images');
  q<HTMLButtonElement>('.picker-foot .btn-primary').click();
  expect(picked?.map((i) => i.src)).toEqual(['media/c.webp', 'media/b.webp']);
});

// The search is the table's now, so emptying the box has to ask again.
test('clearing the search asks for the whole library again', async () => {
  await open([item({})]);
  const box = q<HTMLInputElement>('#picker-q');
  const search = async (words: string) => {
    box.value = words;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    flushSync();
  };
  await search('seaview');
  expect(asked.at(-1)).toBe('/admin/api/media?kind=images&q=seaview');
  await search('');
  expect(asked.at(-1)).toBe('/admin/api/media?kind=images&q=');
});

// The mockup reused one id on two elements, which points every aria reference at the wrong one.
test('every id in the picker is unique, refused tiles included', async () => {
  await open(
    [
      item({ id: 'b'.repeat(64), filename: 'winter-storm.jpg', width: 800, height: 450 }),
      item({ id: 'c'.repeat(64), filename: 'summer-storm.jpg', width: 900, height: 500 }),
      item({ filename: 'front-of-house.jpg' }),
    ],
    { ratio: '16:9', max: 2400, min: 1600 },
  );
  const ids = Array.from(document.body.querySelectorAll('[id]'), (el) => el.id);
  expect(ids.length).toBeGreaterThan(4);
  expect(new Set(ids).size).toBe(ids.length);
  for (const el of Array.from(
    document.body.querySelectorAll('[aria-describedby], [aria-labelledby]'),
  )) {
    const ref = el.getAttribute('aria-describedby') ?? el.getAttribute('aria-labelledby');
    expect(document.body.querySelectorAll(`#${ref}`)).toHaveLength(1);
  }
});
