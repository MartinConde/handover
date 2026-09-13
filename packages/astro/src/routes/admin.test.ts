import type { APIContext } from 'astro';
import { expect, test, vi } from 'vitest';
import { GET } from './admin.js';

vi.mock('virtual:handover/ui', () => ({
  default: {
    entries: {
      admin: { script: 'admin.js', styles: ['admin.css', 'shared.css'] },
      canvas: { script: 'canvas.js', styles: ['canvas.css', 'shared.css'] },
    },
    files: {
      'admin.js': 'console.log("shell")',
      'admin.css': 'body{margin:0}',
      'canvas.js': 'console.log("canvas")',
      'canvas.css': '.canvas{}',
      'shared.css': ':root{}',
      'chunks/editor.js': 'export {}',
    },
  },
}));
// The shell reads the same env the login is mounted from; a site with none is the default here.
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
  default: { i18n: {}, mailer: async () => ({ id: 'x' }) },
}));

const ctx = (path?: string, headers: Record<string, string> = {}) =>
  ({
    params: { path },
    request: new Request(`https://x/admin/${path ?? ''}`, { headers }),
  }) as unknown as APIContext;

test('the shell HTML links only the admin entry and its stylesheet closure', async () => {
  const res = await GET(ctx(undefined));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  const html = await res.text();
  expect(html).toContain('<script type="module" src="/admin/_assets/admin.js"></script>');
  expect(html).toContain('<link rel="stylesheet" href="/admin/_assets/admin.css">');
  expect(html).toContain('<link rel="stylesheet" href="/admin/_assets/shared.css">');
  expect(html).not.toContain('canvas.js');
  expect(html).not.toContain('canvas.css');
  expect(html).not.toContain('chunks/editor.js');
  expect(html).toContain(
    `<div id="app" data-base='' data-methods='{"emailLink":false,"github":false}'></div>`,
  );
});

test('any non-asset path gets the same shell', async () => {
  expect(await (await GET(ctx('listings/villa'))).text()).toBe(await (await GET(ctx())).text());
});

test('the private shell uses its validated cookie before weighted browser languages', async () => {
  const res = await GET(
    ctx(undefined, {
      cookie: 'handover_ui_locale=de',
      'accept-language': 'en-GB;q=1, de-DE;q=0.8',
    }),
  );
  expect(await res.text()).toContain('<html lang="de">');
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  expect(res.headers.get('vary')).toBe('Cookie, Accept-Language');
});

test('weighted language negotiation respects regional tags, order, exclusions, and malformed hints', async () => {
  expect(
    await (await GET(ctx(undefined, { 'accept-language': 'en;q=0, de-AT;q=0.7' }))).text(),
  ).toContain('<html lang="de">');
  expect(
    await (
      await GET(
        ctx(undefined, {
          cookie: 'handover_ui_locale=fr',
          'accept-language': 'fr, en-GB;q=0.4, de-DE;q=0.9',
        }),
      )
    ).text(),
  ).toContain('<html lang="de">');
  expect(await (await GET(ctx(undefined, { 'accept-language': 'de;q=wat' }))).text()).toContain(
    '<html lang="en">',
  );
  expect(
    await (await GET(ctx(undefined, { 'accept-language': 'en;q=0, *;q=1' }))).text(),
  ).toContain('<html lang="de">');
  expect(
    await (await GET(ctx(undefined, { 'accept-language': 'de-@@;q=1, en;q=0.5' }))).text(),
  ).toContain('<html lang="en">');
});

test('entry, shared, Canvas, and lazy assets are served immutable with their content type', async () => {
  const js = await GET(ctx('_assets/admin.js'));
  expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(js.headers.get('vary')).toBeNull();
  expect(await js.text()).toBe('console.log("shell")');
  const css = await GET(ctx('_assets/shared.css'));
  expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
  expect((await GET(ctx('_assets/canvas.js'))).status).toBe(200);
  expect((await GET(ctx('_assets/chunks/editor.js'))).status).toBe(200);
});

test('unknown assets are 404, not the shell', async () => {
  expect((await GET(ctx('_assets/nope.js'))).status).toBe(404);
});

// The login has no session, so the shell itself must say which ways in `createAuth` mounts.
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
