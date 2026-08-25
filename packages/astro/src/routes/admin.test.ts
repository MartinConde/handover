import type { APIContext } from 'astro';
import { expect, test, vi } from 'vitest';
import { GET } from './admin.js';

vi.mock('virtual:handover/ui', () => ({
  default: { 'main-abc123.js': 'console.log("shell")', 'main-abc123.css': 'body{margin:0}' },
}));
// The shell says which ways in the site has, so it reads the same env the login is mounted
// from. What a site with none of them looks like is the default here.
let baseUrl: string | undefined;
let clientId: string | undefined;
vi.mock('cloudflare:workers', () => ({
  env: {
    get HANDOVER_BASE_URL() {
      return baseUrl;
    },
    get GITHUB_CLIENT_ID() {
      return clientId;
    },
    GITHUB_CLIENT_SECRET: 'gh_secret',
  },
}));
vi.mock('virtual:handover/config', () => ({
  default: { mailer: async () => ({ id: 'x' }) },
}));

const ctx = (path?: string) => ({ params: { path } }) as unknown as APIContext;

test('the shell HTML links the hashed script and stylesheet', async () => {
  const res = await GET(ctx(undefined));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  const html = await res.text();
  expect(html).toContain('<script type="module" src="/admin/_assets/main-abc123.js"></script>');
  expect(html).toContain('<link rel="stylesheet" href="/admin/_assets/main-abc123.css">');
  expect(html).toContain(`<div id="app" data-methods='{"emailLink":false,"github":false}'></div>`);
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

// The login is the one screen with no session, so it cannot ask an endpoint behind one which
// ways in exist. What the shell says has to be what `createAuth` actually mounts.
test('the shell tells the login which ways in this site has', async () => {
  baseUrl = 'https://demo.example';
  clientId = 'gh_id';

  const html = await (await GET(ctx(undefined))).text();

  expect(html).toContain(`data-methods='{"emailLink":true,"github":true}'`);
});

test('a site with a mailer but no base URL is offered neither', async () => {
  baseUrl = undefined;
  clientId = 'gh_id';

  const html = await (await GET(ctx(undefined))).text();

  expect(html).toContain(`data-methods='{"emailLink":false,"github":false}'`);
});
