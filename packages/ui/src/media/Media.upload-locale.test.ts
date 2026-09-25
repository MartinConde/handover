import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { deferred, q } from '../test-helpers.fixture.js';
import MediaLocaleFixture from './MediaLocaleFixture.svelte';
import type { MediaItem } from './upload.js';

const item = (id: string, filename: string): MediaItem => ({
  id: id.repeat(64),
  src: `media/${id}.webp`,
  filename,
  url: `https://cdn.example.com/media/${id}.webp`,
  width: 1600,
  height: 900,
});
let app: ReturnType<typeof mount>;
afterEach(() => {
  unmount(app);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('live language switching preserves real pending upload work and recovery', async () => {
  const secondBucket = deferred<Response>();
  const calls: { url: string; method: string }[] = [];
  let declarations = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (method === 'GET')
        return Response.json({ media: [item('a', 'harbour.jpg'), item('b', 'garden.jpg')] });
      if (method === 'POST') {
        declarations += 1;
        return Response.json({
          upload: {
            key: `uploads/${declarations}/image.webp`,
            url: `https://bucket/${declarations}`,
          },
        });
      }
      if (url === 'https://bucket/1') throw new TypeError('bucket diagnostic');
      if (url === 'https://bucket/2') return secondBucket.promise;
      return Response.json({ media: item('c', 'new.jpg') });
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

  app = mount(MediaLocaleFixture, { target: document.body });
  await new Promise((resolve) => setTimeout(resolve));
  flushSync();
  q<HTMLInputElement>(`input[value="${'b'.repeat(64)}"]`).click();
  q<HTMLInputElement>(`input[value="${'a'.repeat(64)}"]`).click();
  const search = q<HTMLInputElement>('#picker-q');
  search.value = 'coast';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  search.focus();

  const chooser = q<HTMLInputElement>('#picker-file');
  Object.defineProperty(chooser, 'files', {
    value: [
      new File([new Uint8Array([1])], 'broken.jpg', { type: 'image/jpeg' }),
      new File([new Uint8Array([2])], 'new.jpg', { type: 'image/jpeg' }),
    ],
  });
  chooser.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(calls.filter(({ method }) => method !== 'GET')).toHaveLength(4));
  flushSync();

  const dialog = q<HTMLDialogElement>('[aria-labelledby="picker-h"]');
  const selected = Array.from(
    document.querySelectorAll('.picker-side .upload-row .name'),
    (node) => node.textContent,
  );
  expect(selected).toEqual(['garden.jpg', 'harbour.jpg']);
  const beforeSwitch = calls.map(({ method, url }) => `${method} ${url}`);
  q<HTMLButtonElement>('[data-locale-switch]').click();
  flushSync();

  expect(q('[aria-labelledby="picker-h"]')).toBe(dialog);
  expect(q('#picker-q')).toBe(search);
  expect(search.value).toBe('coast');
  expect(document.activeElement).toBe(search);
  expect(
    Array.from(
      document.querySelectorAll('.picker-side .upload-row .name'),
      (node) => node.textContent,
    ),
  ).toEqual(selected);
  expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual(beforeSwitch);
  expect(document.body.textContent).toContain(
    'Prüfe die Bibliothek, bevor du es erneut versuchst.',
  );
  expect(document.body.textContent).toContain('Technisches Detail: bucket diagnostic');
  expect(document.body.textContent).toContain('Wird hochgeladen…');
  expect(
    Array.from(
      document.querySelectorAll('.picker-main .upload-row .name'),
      (node) => node.textContent,
    ),
  ).toEqual(['broken.jpg', 'new.jpg']);

  secondBucket.resolve(new Response(null));
  await vi.waitFor(() => expect(document.body.textContent).toContain('Hochgeladen'));
  flushSync();
  expect(document.body.textContent).toContain('3 ausgewählt');
  expect(calls.filter(({ method }) => method !== 'GET')).toHaveLength(5);
});
