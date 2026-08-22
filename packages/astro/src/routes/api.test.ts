import type { APIContext } from 'astro';
import { expect, test, vi } from 'vitest';
import { GET, POST, PUT } from './api.js';

const { listing, getFile, getHead, publish, saveDraft } = await vi.hoisted(async () => {
  const { z } = await import('astro/zod');
  return {
    listing: z.object({
      title: z.string(),
      location: z.string().optional(),
      rooms: z.number(),
      address: z.object({ street: z.string() }),
    }),
    // The GitHub boundary: one file in the repo, nothing else.
    getFile: vi.fn(async (path: string) => {
      if (path === 'src/content/listings/en/mill-house.yaml')
        return {
          contents: 'title: The Mill House\nlocation: Bakewell\nrooms: 3\n',
          blob_sha: 'abc123',
        };
      if (path === 'src/content/listings/en/hidden-barn.yaml')
        return {
          contents: '_version: 1\n_status: "hidden"\ntitle: "Hidden Barn"\nrooms: 2\n',
          blob_sha: 'bcd234',
        };
      return undefined;
    }),
    getHead: vi.fn(async () => 'head789'),
    publish: vi.fn(async (_files: unknown, opts: { base_sha: string }) => {
      if (opts.base_sha === 'stale') {
        const { RefMovedError } = await import('@handover/core');
        throw new RefMovedError('moved');
      }
      return { commit_sha: 'def456' };
    }),
    // The D1 boundary; the real saveDraft runs against a D1 in @handover/core's own tests.
    saveDraft: vi.fn<() => Promise<{ updated_at: number; pending: boolean } | undefined>>(
      async () => ({ updated_at: 1755864000000, pending: true }),
    ),
  };
});

// The row GET should overlay, set per test.
let draft: { contents: string; baseSha: string; baseBlob: string } | undefined;
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
    DB: {},
  },
}));
vi.mock('@handover/core', async (original) => ({
  ...(await original<typeof import('@handover/core')>()),
  createGitClient: () => ({ getFile, getHead, publish }),
  openDb: () => ({}),
  loadDraft: async () => draft,
  saveDraft,
}));

const ctx = (path: string, request?: Request) =>
  ({ params: { path }, request }) as unknown as APIContext;
const post = (path: string, body: string) =>
  ctx(path, new Request(`https://x/admin/api/${path}`, { method: 'POST', body }));
const put = (path: string, body: string) =>
  ctx(path, new Request(`https://x/admin/api/${path}`, { method: 'PUT', body }));

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

test('an entry returns its fields, parsed data, blob sha and head sha', async () => {
  const res = await GET(ctx('entries/listings/mill-house'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    fields: [
      { path: ['title'], type: 'text', required: true },
      { path: ['location'], type: 'text', required: false },
      { path: ['rooms'], type: 'number', required: true },
      {
        path: ['address'],
        type: 'group',
        required: true,
        fields: [{ path: ['street'], type: 'text', required: true }],
      },
    ],
    blocks: {},
    data: { title: 'The Mill House', location: 'Bakewell', rooms: 3 },
    pending: false,
    blob_sha: 'abc123',
    head_sha: 'head789',
  });
});

test('saving an entry validates it, writes its YAML file on base_sha and returns the commit', async () => {
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  const res = await PUT(
    put('entries/listings/mill-house', JSON.stringify({ data, base_sha: 'head789' })),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ commit_sha: 'def456' });
  expect(publish).toHaveBeenCalledWith(
    [
      {
        path: 'src/content/listings/en/mill-house.yaml',
        contents: 'title: "The Mill"\nrooms: 3\naddress:\n  street: "Mill Lane"\n',
      },
    ],
    { base_sha: 'head789', message: 'Update listings/mill-house' },
  );
});

test('saving an entry that fails the collection schema is 400 and writes nothing', async () => {
  publish.mockClear();
  const body = JSON.stringify({ data: { title: 'No rooms' }, base_sha: 'head789' });
  expect((await PUT(put('entries/listings/mill-house', body))).status).toBe(400);
  expect((await PUT(put('entries/listings/mill-house', 'not json'))).status).toBe(400);
  expect((await PUT(put('entries/nope/mill-house', body))).status).toBe(404);
  expect(publish).not.toHaveBeenCalled();
});

test('saving an entry is 409 when the branch moved past base_sha', async () => {
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  const body = JSON.stringify({ data, base_sha: 'stale' });
  expect((await PUT(put('entries/listings/mill-house', body))).status).toBe(409);
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

test('an entry with a draft returns the draft data and reports it as pending', async () => {
  draft = {
    contents: 'title: "The Mill House (draft)"\nlocation: "Bakewell"\nrooms: 3\n',
    baseSha: 'head789',
    baseBlob: 'abc123',
  };
  const res = await GET(ctx('entries/listings/mill-house'));
  const body = (await res.json()) as { data: unknown; pending: boolean; blob_sha: string };
  expect(body.data).toEqual({ title: 'The Mill House (draft)', location: 'Bakewell', rooms: 3 });
  expect(body.pending).toBe(true);
  expect(body.blob_sha).toBe('abc123');
  draft = undefined;
});

test('autosaving a draft validates it and stores it under the entry path', async () => {
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  const res = await PUT(put('drafts/listings/mill-house', JSON.stringify({ data })));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ updated_at: 1755864000000, pending: true });
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/listings/en/mill-house.yaml',
    data,
  );
});

test('autosaving never publishes, whatever the form holds', async () => {
  publish.mockClear();
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  await PUT(put('drafts/listings/mill-house', JSON.stringify({ data })));
  expect(publish).not.toHaveBeenCalled();
});

test('an autosave that fails the collection schema is 400 and stores nothing', async () => {
  saveDraft.mockClear();
  const body = JSON.stringify({ data: { title: 'No rooms' } });
  expect((await PUT(put('drafts/listings/mill-house', body))).status).toBe(400);
  expect((await PUT(put('drafts/listings/mill-house', 'not json'))).status).toBe(400);
  expect((await PUT(put('drafts/nope/mill-house', body))).status).toBe(404);
  expect(saveDraft).not.toHaveBeenCalled();
});

test('an autosave for an entry that is not in the repo is 404', async () => {
  saveDraft.mockImplementationOnce(async () => undefined);
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  expect((await PUT(put('drafts/listings/gone', JSON.stringify({ data })))).status).toBe(404);
});

test('publishing keeps the reserved keys no collection schema declares', async () => {
  const data = { title: 'Hidden Barn', rooms: 2, address: { street: 'Barn Lane' } };
  const res = await PUT(
    put('entries/listings/hidden-barn', JSON.stringify({ data, base_sha: 'head789' })),
  );
  expect(res.status).toBe(200);
  expect(publish).toHaveBeenCalledWith(
    [
      {
        path: 'src/content/listings/en/hidden-barn.yaml',
        contents:
          '_version: 1\n_status: "hidden"\ntitle: "Hidden Barn"\nrooms: 2\naddress:\n  street: "Barn Lane"\n',
      },
    ],
    { base_sha: 'head789', message: 'Update listings/hidden-barn' },
  );
});
