import type { APIContext } from 'astro';
import { expect, test, vi } from 'vitest';
import { GET, POST } from './api.js';

const { listing, getFile, publish } = await vi.hoisted(async () => {
  const { z } = await import('astro/zod');
  return {
    listing: z.object({
      title: z.string(),
      location: z.string().optional(),
      rooms: z.number(),
      address: z.object({ street: z.string() }),
    }),
    // The GitHub boundary: one file in the repo, nothing else.
    getFile: vi.fn(async (path: string) =>
      path === 'src/content/listings/en/mill-house.yaml'
        ? { contents: 'title: The Mill House\nlocation: Bakewell\nrooms: 3\n', blob_sha: 'abc123' }
        : undefined,
    ),
    publish: vi.fn(async (_files: unknown, opts: { base_sha: string }) => {
      if (opts.base_sha === 'stale') {
        const { RefMovedError } = await import('@handover/core');
        throw new RefMovedError('moved');
      }
      return { commit_sha: 'def456' };
    }),
  };
});
vi.mock('virtual:handover/config', () => ({
  default: { collections: { listings: { schema: listing } } },
}));
vi.mock('cloudflare:workers', () => ({
  env: {
    ADMIN_PASSWORD: 'hunter2',
    GITHUB_APP_ID: '1',
    GITHUB_INSTALLATION_ID: '2',
    GITHUB_PRIVATE_KEY: 'key',
    GITHUB_REPO: 'acme/site',
  },
}));
vi.mock('@handover/core', async (original) => ({
  ...(await original<typeof import('@handover/core')>()),
  createGitClient: () => ({ getFile, publish }),
}));

const ctx = (path: string, request?: Request) =>
  ({ params: { path }, request }) as unknown as APIContext;
const post = (path: string, body: string) =>
  ctx(path, new Request(`https://x/admin/api/${path}`, { method: 'POST', body }));

test('ping returns the configured collection names', async () => {
  const res = await GET(ctx('ping'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, collections: ['listings'] });
});

test('unknown paths are 404', async () => {
  expect((await GET(ctx('nope'))).status).toBe(404);
  expect((await POST(post('nope', ''))).status).toBe(404);
});

test('login reads the password from the JSON body', async () => {
  expect((await POST(post('login', JSON.stringify({ password: 'hunter2' })))).status).toBe(200);
  expect((await POST(post('login', JSON.stringify({ password: 'nope' })))).status).toBe(401);
  expect((await POST(post('login', 'not json'))).status).toBe(401);
});

test('an entry returns its text fields, parsed data and blob sha', async () => {
  const res = await GET(ctx('entries/listings/mill-house'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    fields: [
      { path: ['title'], type: 'text', required: true },
      { path: ['location'], type: 'text', required: false },
      { path: ['rooms'], type: 'unsupported' },
      { path: ['address', 'street'], type: 'text', required: true },
    ],
    data: { title: 'The Mill House', location: 'Bakewell', rooms: 3 },
    blob_sha: 'abc123',
  });
});

test('an unknown collection or missing entry is 404', async () => {
  expect((await GET(ctx('entries/nope/mill-house'))).status).toBe(404);
  expect((await GET(ctx('entries/listings/nope'))).status).toBe(404);
  expect(getFile).not.toHaveBeenCalledWith(expect.stringContaining('nope/'));
});

test('publish commits the given files on base_sha and returns the commit sha', async () => {
  const body = {
    files: [{ path: 'src/content/listings/en/mill-house.yaml', contents: 'title: New\n' }],
    base_sha: 'abc123',
    message: 'Update mill-house',
  };
  const res = await POST(post('publish', JSON.stringify(body)));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ commit_sha: 'def456' });
  expect(publish).toHaveBeenCalledWith(body.files, {
    base_sha: 'abc123',
    message: 'Update mill-house',
  });
});

test('publish is 409 when the branch moved past base_sha', async () => {
  const body = { files: [{ path: 'a.yaml', contents: 'a' }], base_sha: 'stale', message: 'm' };
  expect((await POST(post('publish', JSON.stringify(body)))).status).toBe(409);
});

test('publish rejects a malformed body with 400', async () => {
  expect((await POST(post('publish', 'not json'))).status).toBe(400);
  expect(
    (await POST(post('publish', JSON.stringify({ files: [], base_sha: 'a', message: 'm' }))))
      .status,
  ).toBe(400);
  expect(
    (
      await POST(
        post('publish', JSON.stringify({ files: [{ path: 'a' }], base_sha: 'a', message: 'm' })),
      )
    ).status,
  ).toBe(400);
});
