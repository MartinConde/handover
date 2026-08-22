import type { APIContext } from 'astro';
import { expect, test, vi } from 'vitest';
import { GET, POST, PUT } from './api.js';

const { listing, getFile, getHead, publish, saveDraft, pendingDrafts, publishDrafts } =
  await vi.hoisted(async () => {
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
      // The D1 boundary; the real ones run against a D1 in @handover/core's own tests.
      pendingDrafts: vi.fn(async () => [
        {
          path: 'src/content/listings/en/mill-house.yaml',
          contents: 'title: "The Mill House"\n',
          updatedAt: 1755864000000,
        },
      ]),
      publishDrafts: vi.fn<() => Promise<{ commit_sha: string; paths: string[] } | undefined>>(
        async () => ({ commit_sha: 'def456', paths: ['src/content/listings/en/mill-house.yaml'] }),
      ),
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
// What the build read out of src/content/, inlined into the Worker bundle.
vi.mock('virtual:handover/index', () => ({
  default: {
    listings: [
      {
        id: 'mill-house',
        locales: {
          en: { title: 'The Mill House', path: 'src/content/listings/en/mill-house.yaml' },
        },
      },
      {
        id: 'seaview-cottage',
        locales: {
          en: {
            title: 'Seaview Cottage',
            path: 'src/content/listings/en/seaview-cottage.yaml',
          },
        },
      },
    ],
  },
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
  pendingDrafts,
  publishDrafts,
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

test('an entry returns its fields and its parsed data, and no sha', async () => {
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
  });
});

test('an unknown collection or missing entry is 404', async () => {
  expect((await GET(ctx('entries/nope/mill-house'))).status).toBe(404);
  expect((await GET(ctx('entries/listings/nope'))).status).toBe(404);
  expect(getFile).not.toHaveBeenCalledWith(expect.stringContaining('nope/'));
});

test('an entry with a draft returns the draft data and reports it as pending', async () => {
  draft = {
    contents: 'title: "The Mill House (draft)"\nlocation: "Bakewell"\nrooms: 3\n',
    baseSha: 'head789',
    baseBlob: 'abc123',
  };
  const res = await GET(ctx('entries/listings/mill-house'));
  const body = (await res.json()) as { data: unknown; pending: boolean };
  expect(body.data).toEqual({ title: 'The Mill House (draft)', location: 'Bakewell', rooms: 3 });
  expect(body.pending).toBe(true);
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

test('the pending list is what the drafts hold that the repository does not', async () => {
  const res = await GET(ctx('drafts'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    files: [{ path: 'src/content/listings/en/mill-house.yaml', updated_at: 1755864000000 }],
  });
});

test('publishing commits the stored drafts and answers with the commit', async () => {
  const res = await POST(post('publish', ''));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    commit_sha: 'def456',
    paths: ['src/content/listings/en/mill-house.yaml'],
  });
  expect(publishDrafts).toHaveBeenCalled();
});

test('publishing with nothing pending answers with no files', async () => {
  publishDrafts.mockImplementationOnce(async () => undefined);
  const res = await POST(post('publish', ''));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ paths: [] });
});

test('publishing is 409 when a file changed in the repository since the draft was loaded', async () => {
  const { DraftConflictError } = await import('@handover/core');
  publishDrafts.mockImplementationOnce(async () => {
    throw new DraftConflictError(['src/content/listings/en/mill-house.yaml']);
  });
  const res = await POST(post('publish', ''));
  expect(res.status).toBe(409);
  expect(await res.text()).toContain('src/content/listings/en/mill-house.yaml');
});

test('publishing is 409 when the branch moved under it', async () => {
  const { RefMovedError } = await import('@handover/core');
  publishDrafts.mockImplementationOnce(async () => {
    throw new RefMovedError('main moved past abc123');
  });
  expect((await POST(post('publish', ''))).status).toBe(409);
});

test('the browser cannot hand file contents to the publish endpoint', async () => {
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  expect((await PUT(put('entries/listings/mill-house', JSON.stringify({ data })))).status).toBe(
    404,
  );
  await POST(post('publish', JSON.stringify({ files: [{ path: 'evil.yaml', contents: 'x' }] })));
  expect(publish).not.toHaveBeenCalled();
});

test('the entry list is the built index with the pending drafts over it', async () => {
  pendingDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: 'title: "The Mill House, renamed"\n',
      updatedAt: 1755864000000,
    },
  ]);
  const res = await GET(ctx('entries/listings'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    entries: [
      {
        id: 'mill-house',
        locales: {
          en: {
            title: 'The Mill House, renamed',
            path: 'src/content/listings/en/mill-house.yaml',
          },
        },
      },
      {
        id: 'seaview-cottage',
        locales: {
          en: {
            title: 'Seaview Cottage',
            path: 'src/content/listings/en/seaview-cottage.yaml',
          },
        },
      },
    ],
  });
});

test('listing an unknown collection is 404', async () => {
  expect((await GET(ctx('entries/nope'))).status).toBe(404);
});
