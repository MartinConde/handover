import type { APIContext } from 'astro';
import { beforeEach, expect, test, vi } from 'vitest';
import { GET } from './preview.js';

// What the session is worth is proven against a real D1 in core's auth.test.ts; what this file
// tests is which requests ever get past it, and what every answer carries either way.
let session: { user: { id: string } } | null = null;
vi.mock('../auth.js', () => ({
  createAuth: () => ({ api: { getSession: async () => session } }),
}));
vi.mock('virtual:handover/config', () => ({
  default: {
    i18n: { locales: ['en', 'de'], defaultLocale: 'en' },
    collections: {
      listings: { route: '/listings/[slug]', index: '/' },
      samples: {},
    },
  },
}));

const get = (path: string) =>
  GET({
    params: { path },
    request: new Request('https://demo.example/_preview/'),
    url: new URL('https://demo.example/_preview/'),
  } as unknown as APIContext) as Promise<Response>;

beforeEach(() => {
  session = { user: { id: 'u1' } };
});

test('a signed-out request never learns whether the page exists', async () => {
  session = null;
  const res = await get('listings/mill-house');
  expect(res.status).toBe(401);
});

test('a path the site serves no page at is not found', async () => {
  expect((await get('listings/mill-house/gallery')).status).toBe(404);
  expect((await get('samples/everything')).status).toBe(404);
});

test('a page the site does serve is reached, and renders nothing yet', async () => {
  const res = await get('de/listings/mill-house');
  expect(res.status).toBe(204);
  expect(await res.text()).toBe('');
});

// The gate is on the refusals too: a 401 that a CDN cached, or that a stranger's page could
// frame, is the same hole as a rendered one.
test.each([
  ['signed out', null, 'listings/mill-house'],
  ['no such page', { user: { id: 'u1' } }, 'nope/nope/nope'],
  ['rendered', { user: { id: 'u1' } }, 'listings/mill-house'],
])('%s carries the gate', async (_name, who, path) => {
  session = who;
  const { headers } = await get(path);
  expect(headers.get('cache-control')).toBe('private, no-store');
  expect(headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
});
