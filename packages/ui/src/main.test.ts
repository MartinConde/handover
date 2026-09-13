import { afterEach, expect, test, vi } from 'vitest';

const { mount, request } = vi.hoisted(() => ({
  mount: vi.fn(),
  request: vi.fn(),
}));

vi.mock('svelte', () => ({ mount }));
vi.mock('./App.svelte', () => ({ default: {} }));
vi.mock('./request.js', () => ({
  localPath: (path: string) => path,
  request,
  siteBase: () => '',
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  mount.mockReset();
  request.mockReset();
  document.body.innerHTML = '';
  document.documentElement.lang = '';
});

test('bootstrap mounts with the saved preference when cookie reads are blocked', async () => {
  document.body.innerHTML = `<div id="app" data-methods="{}"></div>`;
  request.mockResolvedValue(
    Response.json({
      collections: [],
      role: 'owner',
      user: { id: 'u1', name: 'Martin', email: 'martin@example.com', uiLocale: 'de' },
    }),
  );
  const read = vi.spyOn(document, 'cookie', 'get').mockImplementation(() => {
    throw new DOMException('Cookies disabled', 'SecurityError');
  });

  await import('./main.js');

  expect(document.documentElement.lang).toBe('de');
  expect(mount).toHaveBeenCalledOnce();
  expect(mount.mock.calls[0]?.[1]?.props).toMatchObject({ initialUiLocale: 'de' });
  read.mockRestore();
});
