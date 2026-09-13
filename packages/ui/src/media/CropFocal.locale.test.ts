import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import CropFocalLocaleFixture from './CropFocalLocaleFixture.svelte';

const q = <T extends Element>(selector: string) => {
  const element = document.body.querySelector<T>(selector);
  if (!element) throw new Error(`${selector} missing`);
  return element;
};
const click = (selector: string) => {
  q<HTMLButtonElement>(selector).click();
  flushSync();
};
const nudge = (key: string, times: number, shiftKey = false) => {
  for (let i = 0; i < times; i++) {
    q<HTMLButtonElement>('.focal-handle').dispatchEvent(
      new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
    );
  }
  flushSync();
};
const input = (selector: string, value: string) => {
  const control = q<HTMLInputElement>(selector);
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  return control;
};

let app: ReturnType<typeof mount>;
afterEach(() => {
  unmount(app);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

test('live language switching preserves focal and real crop work', async () => {
  const source = { close: vi.fn() };
  const drawImage = vi.fn();
  const render = vi.fn((done: BlobCallback) =>
    done(new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/webp' })),
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => source),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(render);

  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${url}`);
      if (url === 'https://cdn.example.com/original.webp') return new Response('source');
      if (method === 'POST') {
        return Response.json({ upload: { key: 'media/crop.webp', url: 'https://bucket/crop' } });
      }
      if (url === 'https://bucket/crop') return new Response(null, { status: 507 });
      throw new Error(`unexpected request: ${method} ${url}`);
    }),
  );

  app = mount(CropFocalLocaleFixture, { target: document.body });
  flushSync();

  nudge('ArrowLeft', 8);
  nudge('ArrowUp', 2, true);
  const focalDialog = q<HTMLDialogElement>('[aria-labelledby="focal-h"]');
  const focalHandle = q<HTMLButtonElement>('.focal-handle');
  focalHandle.focus();
  expect(focalHandle.getAttribute('aria-label')).toBe('Focal point, 42% across, 30% down');
  expect(document.body.textContent).toContain('Homepage hero');
  click('[data-locale-switch]');

  expect(q('[aria-labelledby="focal-h"]')).toBe(focalDialog);
  expect(q('.focal-handle')).toBe(focalHandle);
  expect(document.activeElement).toBe(focalHandle);
  expect(focalHandle.style.left).toBe('42%');
  expect(focalHandle.style.top).toBe('30%');
  expect(focalHandle.getAttribute('aria-label')).toBe('Fokuspunkt, 42 % von links, 30 % von oben');
  expect(document.body.textContent).toContain('Harbour original.jpg');
  expect(document.body.textContent).toContain('Homepage hero');
  expect(q('[data-focal-saves]').textContent).toBe('[]');
  expect(requests).toEqual([]);

  click('.focal-dialog .btn-primary');
  expect(q('[data-focal-saves]').textContent).toBe('[[0.42,0.3]]');
  click('[data-open-crop]');
  click('[data-locale-switch]');
  const cropDialog = q<HTMLDialogElement>('[aria-labelledby="crop-h"]');
  const cropStage = q<HTMLElement>('.crop-dialog .focal-stage');
  const width = input('#crop-w', '1600');
  input('#crop-x', '250');
  width.focus();
  const cropBoxStyle = q<HTMLElement>('.crop-box').getAttribute('style');

  click('[data-locale-switch]');
  expect(q('[aria-labelledby="crop-h"]')).toBe(cropDialog);
  expect(q('.crop-dialog .focal-stage')).toBe(cropStage);
  expect(q('#crop-w')).toBe(width);
  expect(document.activeElement).toBe(width);
  expect(q<HTMLInputElement>('#crop-w').value).toBe('1600');
  expect(q<HTMLInputElement>('#crop-x').value).toBe('250');
  expect(q<HTMLElement>('.crop-box').getAttribute('style')).toBe(cropBoxStyle);
  expect(q('.crop-meta [aria-live]').textContent).toBe('1600 × 900 px von 2400 × 1600');
  expect(q('[aria-labelledby="crop-shape-h"] button:nth-child(2)').textContent).toBe('16:9');
  expect(document.body.textContent).toContain('Harbour original.jpg');
  expect(requests).toEqual([]);
  expect(drawImage).not.toHaveBeenCalled();
  expect(q('[data-made-count]').textContent).toBe('0');

  click('.crop-dialog .btn-primary');
  await vi.waitFor(() =>
    expect(q('[role="alert"]').textContent).toContain(
      'Der Upload wurde vom Speicher abgelehnt (507).',
    ),
  );
  expect(requests).toEqual([
    'GET https://cdn.example.com/original.webp',
    'POST /admin/api/media',
    'PUT https://bucket/crop',
  ]);
  expect(drawImage).toHaveBeenCalledOnce();
  expect(render).toHaveBeenCalledOnce();
  expect(source.close).toHaveBeenCalledOnce();
  expect(q('[data-made-count]').textContent).toBe('0');

  click('[data-locale-switch]');
  expect(q('[role="alert"]').textContent).toContain('Storage refused the upload (507).');
  expect(requests).toHaveLength(3);
  expect(drawImage).toHaveBeenCalledOnce();
  expect(render).toHaveBeenCalledOnce();
  expect(q<HTMLInputElement>('#crop-w').value).toBe('1600');
  expect(q<HTMLInputElement>('#crop-x').value).toBe('250');
  expect(q('[data-made-count]').textContent).toBe('0');
});
