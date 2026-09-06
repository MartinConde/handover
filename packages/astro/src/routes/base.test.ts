import type { APIContext } from 'astro';
import { expect, test, vi } from 'vitest';
import { onRequest } from '../middleware.js';
import { GET } from './admin.js';
import { preview } from './preview.js';

vi.mock('virtual:handover/config', () => ({
  default: {
    i18n: { base: '/nested/site', defaultLocale: 'en', locales: ['en', 'de'] },
    collections: { pages: { route: '/[slug]', index: '/', load: 'page' } },
  },
}));
vi.mock('virtual:handover/ui', () => ({
  default: { 'main.js': 'export {}', 'main.css': 'body{}' },
}));
vi.mock('../auth.js', () => ({
  loginMethods: () => ({ emailLink: false, github: false }),
  createAuth: () => ({ api: { getSession: async () => null } }),
}));
vi.mock('virtual:handover/loaders', () => ({ default: {} }));
vi.mock('cloudflare:workers', () => ({ env: { DB: {} } }));
const ctx = (path: string, params = '') => {
  const url = new URL(path, 'https://example.com');
  return {
    url,
    request: new Request(url),
    params: { path: params },
    locals: {},
  } as unknown as APIContext;
};

test('nested-base shell loads assets and supplies the same base to the browser', async () => {
  const html = await (await GET(ctx('/nested/site/admin'))).text();
  expect(html).toContain('src="/nested/site/admin/_assets/main.js"');
  expect(html).toContain('href="/nested/site/admin/_assets/main.css"');
  expect(html).toContain("data-base='/nested/site'");
  expect((await GET(ctx('/nested/site/admin/_assets/main.js', '_assets/main.js'))).status).toBe(
    200,
  );
});

test('nested-base API calls require a session and login endpoints remain reachable', async () => {
  const next = vi.fn(async () => new Response('next'));
  const response = await onRequest(ctx('/nested/site/admin/api/drafts'), next);
  expect(response?.status).toBe(401);
  expect(next).not.toHaveBeenCalled();
  expect((await onRequest(ctx('/nested/site/admin/api/auth/sign-in/email'), next))?.status).toBe(
    200,
  );
  expect(
    await preview(ctx('/nested/site/_preview/home', 'home') as never, {} as never),
  ).toMatchObject({ status: 401 });
});

test('preview links retain the base exactly once and leave outside-base paths alone', async () => {
  const html =
    '<a href="/nested/site/de/home">Home</a><a href="/nested/site/_preview/home">Preview</a><a href="/elsewhere">Elsewhere</a>';
  const response = await onRequest(
    ctx('/nested/site/_preview/de/home'),
    async () => new Response(html, { headers: { 'content-type': 'text/html' } }),
  );
  expect(await response?.text()).toBe(
    '<a href="/nested/site/_preview/de/home">Home</a><a href="/nested/site/_preview/home">Preview</a><a href="/elsewhere">Elsewhere</a>',
  );
});
