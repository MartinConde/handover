import type { APIContext } from 'astro';
import { expect, test, vi } from 'vitest';
import { GET } from './admin.js';

vi.mock('virtual:handover/ui', () => ({
  default: { 'main-abc123.js': 'console.log("shell")', 'main-abc123.css': 'body{margin:0}' },
}));

const ctx = (path?: string) => ({ params: { path } }) as unknown as APIContext;

test('the shell HTML links the hashed script and stylesheet', async () => {
  const res = await GET(ctx(undefined));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  const html = await res.text();
  expect(html).toContain('<script type="module" src="/admin/_assets/main-abc123.js"></script>');
  expect(html).toContain('<link rel="stylesheet" href="/admin/_assets/main-abc123.css">');
  expect(html).toContain('<div id="app"></div>');
});

test('any non-asset path gets the same shell', async () => {
  expect(await (await GET(ctx('listings/villa'))).text()).toBe(await (await GET(ctx())).text());
});

test('hashed assets are served immutable with their content type', async () => {
  const js = await GET(ctx('_assets/main-abc123.js'));
  expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(await js.text()).toBe('console.log("shell")');
  const css = await GET(ctx('_assets/main-abc123.css'));
  expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
});

test('unknown assets are 404, not the shell', async () => {
  expect((await GET(ctx('_assets/nope.js'))).status).toBe(404);
});
