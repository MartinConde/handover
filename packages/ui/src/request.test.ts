import { afterEach, expect, test, vi } from 'vitest';
import { localPath, previewPath, request, sitePath, uncertainResponse } from './request.js';

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
test('nested-base API, navigation, and preview paths stay within the site', async () => {
  document.body.innerHTML = '<div id="app" data-base="/nested/site"></div>';
  const fetch = vi.fn(async () => Response.json({}));
  vi.stubGlobal('fetch', fetch);
  await request('/admin/api/ping');
  expect(fetch).toHaveBeenCalledWith('/nested/site/admin/api/ping');
  expect(sitePath('/admin/c/pages/home')).toBe('/nested/site/admin/c/pages/home');
  expect(sitePath('/nested/site/admin')).toBe('/nested/site/admin');
  expect(localPath('/nested/site/admin')).toBe('/admin');
  expect(previewPath('/nested/site/de/home')).toBe('/nested/site/_preview/de/home');
  expect(sitePath('https://example.com')).toBe('https://example.com');
});
test('a disconnected API request becomes a retryable refusal; a retry can succeed', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(Response.json({ ok: true })),
  );
  const response = await request('/admin/api/publish', { method: 'POST' });
  expect(response.status).toBe(503);
  expect(uncertainResponse(response)).toBe(true);
  expect(await response.text()).toContain('try again');
  const retry = await request('/admin/api/publish', { method: 'POST' });
  expect(retry.ok).toBe(true);
  expect(uncertainResponse(retry)).toBe(false);
});

test('a response body disconnected after headers also reports failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('stream disconnected'));
            },
          }),
        ),
    ),
  );
  const response = await request('/admin/api/drafts/pages/home', { method: 'PUT' });
  expect(response.status).toBe(503);
  expect(uncertainResponse(response)).toBe(true);
});

test('a base beginning with admin is not added twice to navigation', () => {
  document.body.innerHTML = '<div id="app" data-base="/admin"></div>';
  expect(sitePath('/admin/c/pages/home')).toBe('/admin/admin/c/pages/home');
  expect(sitePath('/admin/admin/c/pages/home')).toBe('/admin/admin/c/pages/home');
});
