import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Library from './Library.svelte';
import { type LibraryItem, uploadFile, uploadImage } from './upload.js';

vi.mock('./upload.js', async (original) => ({
  ...(await original<typeof import('./upload.js')>()),
  uploadFile: vi.fn(),
  uploadImage: vi.fn(),
}));

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

/** The site's own shapes, as `ping` hands them to the screen; most tests need none. */
let presets: { label: string; preset: { ratio?: string; max?: number } }[] = [];
const show = async () => {
  server();
  app = mount(Library, {
    target: document.body,
    props: { base: 'https://cdn.example.com', presets },
  });
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
  vi.mocked(uploadFile).mockReset();
  vi.mocked(uploadImage).mockReset();
  media = [];
  saved = undefined;
  refusal = undefined;
  presets = [];
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

// The table does the searching: a tag is not in what was loaded.
test('a search is asked of the server, with the archived shown', async () => {
  media = [item()];
  await show();
  const box = q<HTMLInputElement>('#lib-q');
  box.value = 'seaview';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  expect(asked.at(-1)?.url).toBe('/admin/api/media?kind=images&archived=1&q=seaview');
});

test('a late older search cannot replace the latest library results', async () => {
  const reads: { url: string; answer: (response: Response) => void }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string) =>
        new Promise<Response>((answer) => {
          reads.push({ url, answer });
        }),
    ),
  );
  app = mount(Library, { target: document.body });
  await settle();
  reads[0]?.answer(Response.json({ media: [] }));
  await new Promise((r) => setTimeout(r));

  const box = q<HTMLInputElement>('#lib-q');
  box.value = 'old';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  box.value = 'new';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();

  expect(reads.map((read) => read.url)).toEqual([
    '/admin/api/media?kind=images&archived=1&q=',
    '/admin/api/media?kind=images&archived=1&q=old',
    '/admin/api/media?kind=images&archived=1&q=new',
  ]);
  reads[2]?.answer(Response.json({ media: [item({ filename: 'new.webp' })] }));
  await new Promise((r) => setTimeout(r));
  reads[1]?.answer(Response.json({ media: [item({ filename: 'old.webp' })] }));
  await new Promise((r) => setTimeout(r));
  flushSync();

  expect(names()).toEqual(['new.webp']);
});

test('a failed older tab read cannot replace the current library view', async () => {
  const reads: { url: string; answer: (response: Response) => void }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string) =>
        new Promise<Response>((answer) => {
          reads.push({ url, answer });
        }),
    ),
  );
  app = mount(Library, { target: document.body });
  await settle();
  reads[0]?.answer(Response.json({ media: [] }));
  await new Promise((r) => setTimeout(r));

  click('[role="tab"]:nth-child(2)');
  await settle();
  click('[role="tab"]:nth-child(1)');
  await settle();
  reads[2]?.answer(Response.json({ media: [item({ filename: 'current.webp' })] }));
  await new Promise((r) => setTimeout(r));
  reads[1]?.answer(new Response(null, { status: 503 }));
  await new Promise((r) => setTimeout(r));
  flushSync();

  expect(names()).toEqual(['current.webp']);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test('an upload batch keeps its starting mode and does not enter another tab', async () => {
  let finishFirst: (media: LibraryItem) => void = () => {};
  vi.mocked(uploadImage)
    .mockImplementationOnce(
      () =>
        new Promise<LibraryItem>((resolve) => {
          finishFirst = resolve;
        }),
    )
    .mockResolvedValueOnce(item({ id: 'c'.repeat(64), filename: 'second.webp' }));
  media = [];
  await show();

  const chooser = q<HTMLInputElement>('#lib-file');
  Object.defineProperty(chooser, 'files', {
    value: [
      new File([new Uint8Array([1])], 'first.jpg', { type: 'image/jpeg' }),
      new File([new Uint8Array([2])], 'second.jpg', { type: 'image/jpeg' }),
    ],
  });
  chooser.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r));
  click('[role="tab"]:nth-child(2)');
  finishFirst(item({ id: 'b'.repeat(64), filename: 'first.webp' }));
  await new Promise((r) => setTimeout(r));
  flushSync();

  expect(uploadImage).toHaveBeenCalledTimes(2);
  expect(uploadFile).not.toHaveBeenCalled();
  expect(document.querySelectorAll('.file-row')).toHaveLength(0);
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

test('consecutive tag additions and removals keep the optimistic tag list', async () => {
  const patches: {
    body: { tags: string[] };
    answer: (response: Response) => void;
  }[] = [];
  media = [item({ tags: ['spring'] })];
  server();
  vi.mocked(fetch).mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== 'PATCH') return Response.json({ media });
    return new Promise<Response>((answer) => {
      patches.push({ body: JSON.parse(String(init.body)), answer });
    });
  });
  app = mount(Library, { target: document.body });
  await settle();
  click('.tile .tile-link');

  const box = q<HTMLInputElement>('#lib-tags');
  box.value = 'garden';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  click('[aria-label="Remove tag spring"]');

  expect(
    Array.from(document.querySelectorAll('.tag-row .badge'), (el) => el.textContent?.trim()),
  ).toEqual(['garden ×']);
  expect(patches.map((patch) => patch.body)).toEqual([{ tags: ['spring', 'garden'] }]);

  patches[0]?.answer(Response.json({ media: item({ tags: ['spring', 'garden'] }) }));
  await new Promise((r) => setTimeout(r));
  expect(patches.map((patch) => patch.body)).toEqual([
    { tags: ['spring', 'garden'] },
    { tags: ['garden'] },
  ]);
  expect(
    Array.from(document.querySelectorAll('.tag-row .badge'), (el) => el.textContent?.trim()),
  ).toEqual(['garden ×']);
  patches[1]?.answer(Response.json({ media: item({ tags: ['garden'] }) }));
  await new Promise((r) => setTimeout(r));
});

test('a failed metadata save keeps later edits and offers to retry them', async () => {
  const patches: {
    body: { alt?: string; tags?: string[] };
    answer: (response: Response) => void;
  }[] = [];
  media = [item()];
  server();
  vi.mocked(fetch).mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== 'PATCH') return Response.json({ media });
    return new Promise<Response>((answer) => {
      patches.push({ body: JSON.parse(String(init.body)), answer });
    });
  });
  app = mount(Library, { target: document.body });
  await settle();
  click('.tile .tile-link');

  const tags = q<HTMLInputElement>('#lib-tags');
  tags.value = 'garden';
  tags.dispatchEvent(new Event('input', { bubbles: true }));
  tags.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const alt = q<HTMLTextAreaElement>('#lib-alt');
  alt.value = 'A summer garden';
  alt.dispatchEvent(new Event('change', { bubbles: true }));
  patches[0]?.answer(new Response(null, { status: 503 }));
  await new Promise((r) => setTimeout(r));
  flushSync();

  expect(document.body.textContent).toContain('Retry save');
  expect(q<HTMLTextAreaElement>('#lib-alt').value).toBe('A summer garden');
  click('.metadata-failure button');
  expect(patches.map((patch) => patch.body)).toEqual([{ tags: ['garden'] }, { tags: ['garden'] }]);

  patches[1]?.answer(Response.json({ media: item({ tags: ['garden'] }) }));
  await new Promise((r) => setTimeout(r));
  expect(patches.map((patch) => patch.body)).toEqual([
    { tags: ['garden'] },
    { tags: ['garden'] },
    { alt: 'A summer garden' },
  ]);
  expect(q<HTMLTextAreaElement>('#lib-alt').value).toBe('A summer garden');
  patches[2]?.answer(Response.json({ media: item({ tags: ['garden'], alt: 'A summer garden' }) }));
  await new Promise((r) => setTimeout(r));
  expect(document.querySelector('.metadata-failure')).toBeNull();
});

test('alt and focal edits are saved in order without older metadata replacing either', async () => {
  const patches: {
    body: { alt?: string; focal?: [number, number] };
    answer: (response: Response) => void;
  }[] = [];
  media = [item()];
  server();
  vi.mocked(fetch).mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== 'PATCH') return Response.json({ media });
    return new Promise<Response>((answer) => {
      patches.push({ body: JSON.parse(String(init.body)), answer });
    });
  });
  app = mount(Library, { target: document.body });
  await settle();
  click('.tile .tile-link');

  const alt = q<HTMLTextAreaElement>('#lib-alt');
  alt.value = 'Front garden in summer';
  alt.dispatchEvent(new Event('change', { bubbles: true }));
  click(setFocal);
  flushSync();
  nudge('ArrowLeft', 8);
  nudge('ArrowUp', 2, true);
  click('.focal-dialog .btn-primary');

  expect(patches.map((patch) => patch.body)).toEqual([{ alt: 'Front garden in summer' }]);
  patches[0]?.answer(Response.json({ media: item({ alt: 'Front garden in summer' }) }));
  await new Promise((r) => setTimeout(r));
  expect(patches.map((patch) => patch.body)).toEqual([
    { alt: 'Front garden in summer' },
    { focal: [0.42, 0.3] },
  ]);

  patches[1]?.answer(
    Response.json({
      media: item({ alt: 'Front garden in summer', focal: [0.42, 0.3] }),
    }),
  );
  await new Promise((r) => setTimeout(r));
  flushSync();
  expect(q<HTMLTextAreaElement>('#lib-alt').value).toBe('Front garden in summer');
  expect(q<HTMLElement>('.lib-side .preview .focal').style.left).toBe('42%');
});

test('switching assets keeps each metadata queue bound to its own asset', async () => {
  const patches: {
    url: string;
    body: { alt: string };
    answer: (response: Response) => void;
  }[] = [];
  media = [item(), item({ id: 'b'.repeat(64), src: 'media/b.webp', filename: 'back-garden.jpg' })];
  server();
  vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== 'PATCH') return Response.json({ media });
    return new Promise<Response>((answer) => {
      patches.push({ url: String(url), body: JSON.parse(String(init.body)), answer });
    });
  });
  app = mount(Library, { target: document.body });
  await settle();

  click('.tile:nth-child(1) .tile-link');
  let alt = q<HTMLTextAreaElement>('#lib-alt');
  alt.value = 'Front garden';
  alt.dispatchEvent(new Event('change', { bubbles: true }));
  click('.tile:nth-child(2) .tile-link');
  alt = q<HTMLTextAreaElement>('#lib-alt');
  alt.value = 'Back garden';
  alt.dispatchEvent(new Event('change', { bubbles: true }));

  expect(patches.map(({ url, body }) => ({ url, body }))).toEqual([
    { url: `/admin/api/media/${'a'.repeat(64)}`, body: { alt: 'Front garden' } },
    { url: `/admin/api/media/${'b'.repeat(64)}`, body: { alt: 'Back garden' } },
  ]);
  patches[0]?.answer(Response.json({ media: item({ alt: 'Front garden' }) }));
  await new Promise((r) => setTimeout(r));
  flushSync();

  expect(q('.side-title').textContent).toBe('back-garden.jpg');
  expect(q<HTMLTextAreaElement>('#lib-alt').value).toBe('Back garden');

  patches[1]?.answer(
    Response.json({
      media: item({ id: 'b'.repeat(64), filename: 'back-garden.jpg', alt: 'Back garden' }),
    }),
  );
  await new Promise((r) => setTimeout(r));
});

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

const names = () =>
  Array.from(document.body.querySelectorAll('.tile .name'), (n) => n.textContent?.trim());

// The three toggles are over what is already loaded, not the server.
test('the filters narrow the grid to the archived, the recovered and the unused', async () => {
  media = [
    item({ uses: [{ entry: 'pages/home', title: 'Home', href: '/admin/c/pages/home' }] }),
    item({ id: 'b'.repeat(64), filename: 'old-banner.jpg', archived: true }),
    item({ id: 'c'.repeat(64), filename: 'lighthouse.jpg', width: undefined, height: undefined }),
  ];
  await show();
  expect(names()).toEqual(['front-of-house.jpg', 'old-banner.jpg', 'lighthouse.jpg']);

  click('.filters [aria-pressed]:nth-of-type(1)');
  expect(q('.filters [aria-pressed]:nth-of-type(1)').getAttribute('aria-pressed')).toBe('true');
  expect(names()).toEqual(['old-banner.jpg']);
  click('.filters [aria-pressed]:nth-of-type(1)');

  click('.filters [aria-pressed]:nth-of-type(2)');
  expect(names()).toEqual(['lighthouse.jpg']);
  click('.filters [aria-pressed]:nth-of-type(2)');

  click('.filters [aria-pressed]:nth-of-type(3)');
  expect(names()).toEqual(['old-banner.jpg', 'lighthouse.jpg']);
  expect(q('.list-toolbar .count').textContent?.trim()).toBe('2 unused images');
});

// On the tile too, so clearing out the archive need not open every picture.
test('an archived tile offers Unarchive on the tile itself', async () => {
  media = [item({ archived: true })];
  saved = item({ archived: false });
  await show();
  expect(q('.tile .tile-actions button').textContent?.trim()).toBe('Unarchive front-of-house.jpg');

  click('.tile .tile-actions button');
  await settle();

  expect(asked.at(-1)).toMatchObject({
    url: `/admin/api/media/${'a'.repeat(64)}`,
    method: 'PATCH',
    body: { archived: false },
  });
  expect(document.body.querySelector('.tile.is-archived')).toBeNull();
  expect(document.body.querySelector('.tile .tile-actions')).toBeNull();
});

test('delete is off while the picture is used, and the line says by how many', async () => {
  media = [item({ uses: [{ entry: 'pages/home', title: 'Home', href: '/admin/c/pages/home' }] })];
  await show();
  click('.tile .tile-link');
  expect(q<HTMLButtonElement>('.lib-side .actions .delete').disabled).toBe(true);
  expect(q('.lib-side .delete-hint').textContent).toContain('used in 1 place');
});

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

// A recovered row is an object the cron found in the bucket, so nothing measured the picture.
test('a recovered picture is flagged and says why it is there', async () => {
  media = [item({ width: null, height: null })];
  await show();
  expect(q('.tile .flag').textContent).toBe('Recovered');
  click('.tile .tile-link');
  expect(q('.lib-side .notice').textContent).toContain('found in storage without a record');
});

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

// The focal point and the crop

const setFocal = '.lib-side .actions button:nth-child(1)';
const cropButton = '.lib-side .actions button:nth-child(2)';
const nudge = (key: string, times: number, shiftKey = false) => {
  for (let i = 0; i < times; i++) {
    q('.focal-handle').dispatchEvent(
      new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
    );
  }
  flushSync();
};

// The dot is the picture's own default, so it is written to the row and not to any file.
test('the dot moved in the dialog is saved to the row, and the panel draws it where it lands', async () => {
  media = [item()];
  saved = item({ focal: [0.42, 0.3] });
  await show();
  click('.tile .tile-link');
  click(setFocal);
  flushSync();
  // From the middle: 8 left and 20 up, a big step being ten.
  nudge('ArrowLeft', 8);
  nudge('ArrowUp', 2, true);
  click('.focal-dialog .btn-primary');
  await settle();
  expect(asked.at(-1)).toMatchObject({
    url: `/admin/api/media/${'a'.repeat(64)}`,
    method: 'PATCH',
    body: { focal: [0.42, 0.3] },
  });
  expect(q<HTMLElement>('.lib-side .preview .focal').style.left).toBe('42%');
});

// The browser's own image drag used to swallow the dot's pointer stream.
test('the picture under the dot cannot be dragged as an image', async () => {
  media = [item()];
  await show();
  click('.tile .tile-link');
  click(setFocal);
  flushSync();
  expect(q('.focal-stage img').getAttribute('draggable')).toBe('false');
});

// A phone holds a picture upright, whatever shape the site's fields crop to.
test('the previews end with a phone-shaped portrait beside the site’s own shapes', async () => {
  media = [item()];
  presets = [{ label: 'Hero image', preset: { ratio: '16:9', max: 2400 } }];
  await show();
  click('.tile .tile-link');
  click(setFocal);
  flushSync();
  const labels = Array.from(document.querySelectorAll('.ratio-item .lbl'), (el) => el.textContent);
  expect(labels).toEqual(['16:9', '9:16']);
  expect(q('.ratio-item:last-child .sub').textContent).toBe('Phone, upright');
});

// A crop is pixels and a recovered row has none; the dot is a fraction and still works.
test('a picture nobody measured cannot be cropped', async () => {
  media = [item({ width: null, height: null })];
  await show();
  click('.tile .tile-link');
  expect(q<HTMLButtonElement>(cropButton).disabled).toBe(true);
  expect(q<HTMLButtonElement>(setFocal).disabled).toBe(false);
});

test('the crop opens locked to the site’s own shape, and Free is the whole picture', async () => {
  media = [item()];
  presets = [{ label: 'Hero image', preset: { ratio: '16:9', max: 2400 } }];
  await show();
  click('.tile .tile-link');
  click(cropButton);
  flushSync();
  expect(q('.crop-meta span').textContent).toBe('2400 × 1350 px of 2400 × 1600');
  expect(q('.crop-meta code').textContent).toBe('front-of-house-crop.webp');
  click('.crop-shape button:nth-child(1)');
  expect(q('.crop-meta span').textContent).toBe('2400 × 1600 px of 2400 × 1600');
});

test('media details open on selection and can close without changing the library', async () => {
  media = [item()];
  await show();
  expect(document.querySelector('.lib-side')).toBeNull();
  click('.tile-link');
  expect(document.querySelector('.lib-body.has-selection')).not.toBeNull();
  click('[aria-label="Close media details"]');
  expect(document.querySelector('.lib-side')).toBeNull();
  expect(document.querySelectorAll('.tile')).toHaveLength(1);
  expect(asked.every((request) => request.method === 'GET')).toBe(true);
});
