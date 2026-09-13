import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import LibraryLocaleFixture from './LibraryLocaleFixture.svelte';
import type { LibraryItem } from './upload.js';

const item = (id: string, filename: string, over: Partial<LibraryItem> = {}): LibraryItem => ({
  id: id.repeat(64),
  src: `media/${id.repeat(64)}.webp`,
  filename,
  url: `https://cdn.example.com/media/${id}.webp`,
  mime: 'image/webp',
  bytes: 1_572_864,
  width: 1600,
  height: 900,
  alt: 'Authored harbour alt',
  tags: ['coast'],
  archived: false,
  createdAt: 1_746_230_000_000,
  uses: [],
  ...over,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};
const q = <T extends Element>(selector: string) => {
  const element = document.body.querySelector<T>(selector);
  if (!element) throw new Error(`${selector} missing`);
  return element;
};
const change = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
};

let app: ReturnType<typeof mount>;
afterEach(() => {
  unmount(app);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  flushSync();
};

test.each([
  {
    name: 'refused read',
    answer: () => Response.json({ error: 'database diagnostic' }, { status: 503 }),
    expected: 'Die Medienbibliothek konnte nicht geladen werden (503).',
  },
  {
    name: 'uncertain read',
    answer: () =>
      new Response('lost', {
        status: 503,
        headers: {
          'x-handover-request-uncertain': 'true',
          'x-handover-error-code': 'CONNECTION_LOST',
        },
      }),
    expected: 'Die Medienbibliothek konnte nicht geladen werden (503).',
  },
  {
    name: 'malformed success',
    answer: () => Response.json({ media: [{ id: 'broken', src: 'media/x' }] }),
    expected: 'Die Antwort der Medienbibliothek konnte nicht überprüft werden.',
  },
] as const)(
  '$name keeps the selected library while offering a translated retry',
  async ({ name: caseName, answer, expected }) => {
    const garden = item('b', 'Garten am Meer.jpg');
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method) throw new Error('unexpected mutation');
        reads += 1;
        return reads === 1 ? Response.json({ media: [garden] }) : answer();
      }),
    );
    app = mount(LibraryLocaleFixture, { target: document.body });
    await settle();
    q<HTMLButtonElement>('.tile-link').click();
    flushSync();
    const panel = q<HTMLElement>('.lib-side');
    const search = q<HTMLInputElement>('#lib-q');
    change(search, 'coast');
    await settle();
    q<HTMLButtonElement>('[data-locale-switch]').click();
    flushSync();

    expect(q('.lib-side')).toBe(panel);
    expect(q('.side-title').textContent).toBe('Garten am Meer.jpg');
    expect(document.querySelector('[role="alert"]')?.textContent ?? '').toContain(expected);
    expect(document.querySelector('[role="alert"]')?.textContent ?? '').toContain(
      'Erneut versuchen',
    );
    if (caseName === 'refused read')
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'Technisches Detail: database diagnostic',
      );
  },
);

test.each([
  {
    name: 'refused metadata write',
    answer: () => Response.json({ error: 'database diagnostic' }, { status: 503 }),
    expected: 'Die Änderung wurde nicht gespeichert (503).',
  },
  {
    name: 'uncertain metadata write',
    answer: () =>
      new Response('lost', {
        status: 503,
        headers: { 'x-handover-request-uncertain': 'true' },
      }),
    expected: 'Es konnte nicht bestätigt werden, ob die Änderung gespeichert wurde.',
  },
  {
    name: 'malformed metadata success',
    answer: () => Response.json({ media: null }),
    expected: 'Die Antwort zum Speichern konnte nicht überprüft werden.',
  },
] as const)(
  '$name keeps the authored draft and safe translated recovery',
  async ({ name: caseName, answer, expected }) => {
    const garden = item('b', 'Garten am Meer.jpg');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
        init?.method === 'PATCH' ? answer() : Response.json({ media: [garden] }),
      ),
    );
    app = mount(LibraryLocaleFixture, { target: document.body });
    await settle();
    q<HTMLButtonElement>('.tile-link').click();
    flushSync();
    const alt = q<HTMLTextAreaElement>('#lib-alt');
    change(alt, 'Authored summer coast');
    await new Promise((resolve) => setTimeout(resolve));
    q<HTMLButtonElement>('[data-locale-switch]').click();
    flushSync();

    expect(q<HTMLTextAreaElement>('#lib-alt')).toBe(alt);
    expect(alt.value).toBe('Authored summer coast');
    expect(document.querySelector('.metadata-failure')?.textContent ?? '').toContain(expected);
    expect(document.querySelector('.metadata-failure')?.textContent ?? '').toContain(
      'Speichern für „Garten am Meer.jpg“ erneut versuchen',
    );
    if (caseName === 'refused metadata write')
      expect(document.querySelector('.metadata-failure')?.textContent).toContain(
        'Technisches Detail: database diagnostic',
      );
  },
);

test.each([
  {
    name: 'current content use',
    answer: () =>
      Response.json(
        { code: 'MEDIA_IN_USE', error: 'This is used in 2 places.', uses: ['a', 'b'] },
        { status: 409 },
      ),
    expected: 'Dieses Medium wird an 2 Stellen verwendet und kann nicht gelöscht werden.',
    action: undefined,
  },
  {
    name: 'published content use',
    answer: () =>
      Response.json(
        { code: 'MEDIA_PUBLISHED_IN_USE', error: 'Published use', uses: ['a'] },
        { status: 409 },
      ),
    expected: 'Die veröffentlichte Website verwendet dieses Medium noch an 1 Stelle.',
    action: undefined,
  },
  {
    name: 'storage refusal',
    answer: () =>
      Response.json(
        { code: 'MEDIA_STORAGE_UNAVAILABLE', error: 'bucket diagnostic' },
        { status: 503 },
      ),
    expected: 'Der Medienspeicher ist nicht verfügbar.',
    action: 'Löschen erneut versuchen',
  },
  {
    name: 'uncertain delete',
    answer: () =>
      new Response('lost', {
        status: 503,
        headers: { 'x-handover-request-uncertain': 'true' },
      }),
    expected: 'Es konnte nicht bestätigt werden, ob das Medium gelöscht wurde.',
    action: 'Bibliothek neu laden',
  },
  {
    name: 'malformed delete success',
    answer: () => Response.json({ deleted: 'wrong' }),
    expected: 'Die Antwort zum Löschen konnte nicht überprüft werden.',
    action: 'Bibliothek neu laden',
  },
  {
    name: 'unknown delete refusal',
    answer: () => Response.json({ error: 'gateway diagnostic' }, { status: 502 }),
    expected: 'Das Medium konnte nicht gelöscht werden (502).',
    action: 'Löschen erneut versuchen',
  },
] as const)(
  '$name keeps the asset and matches delete recovery to the outcome',
  async ({ name: caseName, answer, expected, action }) => {
    const garden = item('b', 'Garten am Meer.jpg');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
        init?.method === 'DELETE' ? answer() : Response.json({ media: [garden] }),
      ),
    );
    app = mount(LibraryLocaleFixture, { target: document.body });
    await settle();
    q<HTMLButtonElement>('.tile-link').click();
    flushSync();
    q<HTMLButtonElement>('.delete').click();
    flushSync();
    q<HTMLButtonElement>('.dialog .btn-danger').click();
    await new Promise((resolve) => setTimeout(resolve));
    q<HTMLButtonElement>('[data-locale-switch]').click();
    flushSync();

    expect(document.querySelectorAll('.tile')).toHaveLength(1);
    expect(q('.side-title').textContent).toBe('Garten am Meer.jpg');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(expected);
    if (action) expect(document.querySelector('[role="alert"]')?.textContent).toContain(action);
    if (caseName === 'unknown delete refusal')
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'Technisches Detail: gateway diagnostic',
      );
  },
);

test('live language switching keeps library work, selection, drafts and focus', async () => {
  const metadata = deferred<Response>();
  const bucket = deferred<Response>();
  let garden = item('b', 'Garten am Meer.jpg');
  const harbour = item('a', 'harbour.jpg');
  const uploaded = item('c', 'new.jpg');
  const calls: { url: string; method: string }[] = [];
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (method === 'GET') {
        reads += 1;
        return Response.json({
          media: reads < 3 ? [garden, harbour] : [uploaded, garden, harbour],
        });
      }
      if (method === 'PATCH') return metadata.promise;
      if (method === 'POST')
        return Response.json({ upload: { key: 'uploads/1/image.webp', url: 'https://bucket/1' } });
      if (url === 'https://bucket/1') return bucket.promise;
      return Response.json({ media: uploaded });
    }),
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1600, height: 900, close: vi.fn() })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done) =>
    done(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' })),
  );

  app = mount(LibraryLocaleFixture, { target: document.body });
  await settle();
  const unused = q<HTMLButtonElement>('.filters [aria-pressed]:last-child');
  unused.click();
  flushSync();
  q<HTMLButtonElement>('.tile:nth-child(1) .tile-link').click();
  flushSync();
  const page = q<HTMLElement>('.media-page');
  const tile = q<HTMLElement>('.tile:nth-child(1)');
  const panel = q<HTMLElement>('.lib-side');
  const search = q<HTMLInputElement>('#lib-q');
  change(search, 'coast');
  await settle();
  const alt = q<HTMLTextAreaElement>('#lib-alt');
  change(alt, 'Authored summer coast');
  const tag = q<HTMLInputElement>('#lib-tags');
  change(tag, 'draft-tag');
  tag.focus();
  const chooser = q<HTMLInputElement>('#lib-file');
  Object.defineProperty(chooser, 'files', {
    value: [new File([new Uint8Array([1])], 'new.jpg', { type: 'image/jpeg' })],
  });
  chooser.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(calls.some(({ url }) => url === 'https://bucket/1')).toBe(true));
  flushSync();
  const queueRow = q<HTMLElement>('.upload-row');
  const beforeSwitch = calls.map(({ method, url }) => `${method} ${url}`);

  q<HTMLButtonElement>('[data-locale-switch]').click();
  flushSync();

  expect(q('.media-page')).toBe(page);
  expect(q('.tile:nth-child(1)')).toBe(tile);
  expect(q('.lib-side')).toBe(panel);
  expect(q('#lib-q')).toBe(search);
  expect(q('#lib-alt')).toBe(alt);
  expect(q('#lib-tags')).toBe(tag);
  expect(q('.upload-row')).toBe(queueRow);
  expect(q('.filters [aria-pressed]:last-child')).toBe(unused);
  expect(unused.getAttribute('aria-pressed')).toBe('true');
  expect(unused.textContent).toBe('Unbenutzt');
  expect(document.activeElement).toBe(tag);
  expect(search.value).toBe('coast');
  expect(alt.value).toBe('Authored summer coast');
  expect(tag.value).toBe('draft-tag');
  expect(q('.side-title').textContent).toBe('Garten am Meer.jpg');
  expect(q('.side-meta').textContent).toContain('3. Mai');
  expect(q('.side-meta').textContent).toContain('1,5 MB');
  expect(q('.upload-row .name').textContent).toBe('new.jpg');
  expect(q('.upload-row .state').textContent).toBe('Wird konvertiert…');
  expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual(beforeSwitch);

  garden = item('b', 'Garten am Meer.jpg', { alt: 'Authored summer coast' });
  metadata.resolve(Response.json({ media: garden }));
  bucket.resolve(new Response(null));
  await vi.waitFor(() => expect(q('.upload-row .state').textContent).toBe('Hochgeladen'));
  flushSync();
  expect(q('.side-title').textContent).toBe('Garten am Meer.jpg');
  expect(q<HTMLTextAreaElement>('#lib-alt').value).toBe('Authored summer coast');
  expect(calls.filter(({ method }) => method === 'PATCH')).toHaveLength(1);
  expect(calls.filter(({ method }) => method === 'POST')).toHaveLength(1);
  expect(calls.filter(({ url }) => url === 'https://bucket/1')).toHaveLength(1);
  expect(calls.filter(({ method }) => method === 'PUT').length).toBe(2);
});
