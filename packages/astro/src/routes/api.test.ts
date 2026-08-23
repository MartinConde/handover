import { type PublishFile, RepoUnreachableError } from '@handover/core';
import type { APIContext } from 'astro';
import { expect, test, vi } from 'vitest';
import { DELETE, GET, POST, PUT } from './api.js';

const {
  listing,
  presenter,
  getFile,
  getHead,
  publish,
  saveDraft,
  createDraft,
  recordRename,
  recordDelete,
  discardDraft,
  overlayRows,
  pendingDrafts,
  publishDrafts,
} = await vi.hoisted(async () => {
  const { z } = await import('astro/zod');
  return {
    listing: z.object({
      title: z.string(),
      location: z.string().optional(),
      rooms: z.number(),
      address: z.object({ street: z.string() }),
    }),
    // A collection keyed on something other than `title`.
    presenter: z.object({ name: z.string() }),
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
        contents: 'title: "The Mill House"\nrooms: 3\naddress:\n  street: "Mill Lane"\n',
        updatedAt: 1755864000000,
      },
    ]),
    publishDrafts: vi.fn<() => Promise<{ commit_sha: string; paths: string[] } | undefined>>(
      async () => ({ commit_sha: 'def456', paths: ['src/content/listings/en/mill-house.yaml'] }),
    ),
    saveDraft: vi.fn<() => Promise<{ updated_at: number; pending: boolean } | undefined>>(
      async () => ({ updated_at: 1755864000000, pending: true }),
    ),
    createDraft: vi.fn(async () => ({ updated_at: 1755864000000 })),
    recordRename: vi.fn(async () => {}),
    recordDelete: vi.fn(async () => {}),
    discardDraft: vi.fn(async () => {}),
    // What the entry list lays over the index: the pending drafts plus what a commit left.
    overlayRows: vi.fn(async () => [] as { path: string; contents: string }[]),
  };
});

// The row GET should overlay, set per test.
let draft: { contents: string; baseSha: string; baseBlob: string } | undefined;
vi.mock('virtual:handover/config', () => ({
  default: {
    i18n: { locales: ['en'], defaultLocale: 'en' },
    collections: {
      listings: { schema: listing, route: '/listings/[slug]', index: '/listings' },
      presenters: { schema: presenter, titleField: 'name' },
    },
  },
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
    presenters: [
      {
        id: 'rosa-hale',
        locales: { en: { title: 'Rosa Hale', path: 'src/content/presenters/en/rosa-hale.yaml' } },
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
  createDraft,
  recordRename,
  recordDelete,
  discardDraft,
  overlayRows,
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
  expect(await res.json()).toEqual({ ok: true, collections: ['listings', 'presenters'] });
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
      { path: ['title'], label: 'Title', type: 'text', required: true },
      { path: ['location'], label: 'Location', type: 'text', required: false },
      { path: ['rooms'], label: 'Rooms', type: 'number', required: true },
      {
        path: ['address'],
        label: 'Address',
        type: 'group',
        required: true,
        fields: [{ path: ['street'], label: 'Street', type: 'text', required: true }],
      },
    ],
    blocks: {},
    data: { title: 'The Mill House', location: 'Bakewell', rooms: 3 },
    pending: false,
    problems: [{ path: 'address', message: 'Required' }],
  });
});

test('an unknown collection or missing entry is 404', async () => {
  expect((await GET(ctx('entries/nope/mill-house'))).status).toBe(404);
  expect((await GET(ctx('entries/listings/nope'))).status).toBe(404);
  expect(getFile).not.toHaveBeenCalledWith(expect.stringContaining('nope/'));
});

test('an entry the App cannot reach names the repository rather than the entry', async () => {
  const message =
    'The GitHub App cannot see acme/site. Add the repository to installation 2, or correct the repository name.';
  getFile.mockImplementationOnce(async () => {
    throw new RepoUnreachableError(message);
  });

  const res = await GET(ctx('entries/listings/mill-house'));

  expect(res.status).toBe(503);
  expect(await res.text()).toBe(message);
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

test('autosaving a draft stores it under the entry path with nothing to report', async () => {
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  const res = await PUT(put('drafts/listings/mill-house', JSON.stringify({ data })));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ updated_at: 1755864000000, pending: true, problems: [] });
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/listings/en/mill-house.yaml',
    data,
    // A site that declares one language has no other file to keep in step.
    undefined,
  );
});

test('autosaving never publishes, whatever the form holds', async () => {
  publish.mockClear();
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  await PUT(put('drafts/listings/mill-house', JSON.stringify({ data })));
  expect(publish).not.toHaveBeenCalled();
});

test('an autosave the schema refuses is stored anyway, with what is missing named', async () => {
  saveDraft.mockClear();
  const data = { title: 'No rooms yet' };
  const res = await PUT(put('drafts/listings/mill-house', JSON.stringify({ data })));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    updated_at: 1755864000000,
    pending: true,
    problems: [
      { path: 'rooms', message: 'Required' },
      { path: 'address', message: 'Required' },
    ],
  });
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/listings/en/mill-house.yaml',
    data,
    // A site that declares one language has no other file to keep in step.
    undefined,
  );
});

test('an autosave the serialiser cannot write back is refused, with the reason', async () => {
  saveDraft.mockClear();
  saveDraft.mockImplementationOnce(async () => {
    throw new Error('Nested array at tags[0]: wrap the inner array in an object');
  });
  const res = await PUT(
    put('drafts/listings/mill-house', JSON.stringify({ data: { tags: [[]] } })),
  );
  expect(res.status).toBe(400);
  expect(await res.text()).toBe('Nested array at tags[0]: wrap the inner array in an object');
});

test('a body that is not an object, and an unknown collection, are refused', async () => {
  saveDraft.mockClear();
  const body = JSON.stringify({ data: { title: 'No rooms' } });
  expect((await PUT(put('drafts/listings/mill-house', 'not json'))).status).toBe(400);
  expect((await PUT(put('drafts/listings/mill-house', JSON.stringify({ data: [] })))).status).toBe(
    400,
  );
  expect((await PUT(put('drafts/nope/mill-house', body))).status).toBe(404);
  expect(saveDraft).not.toHaveBeenCalled();
});

// The `_` keys belong to the file: the server reads them off the entry, so a browser cannot
// set `_version` or `_status` by posting one.
test('reserved keys in the posted data are dropped before the draft is stored', async () => {
  saveDraft.mockClear();
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  await PUT(
    put('drafts/listings/mill-house', JSON.stringify({ data: { ...data, _status: 'hidden' } })),
  );
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/listings/en/mill-house.yaml',
    data,
    // A site that declares one language has no other file to keep in step.
    undefined,
  );
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
  // The drawer badges the rows it names, so the paths come back as data, not only as prose.
  expect(await res.json()).toEqual({
    error: 'src/content/listings/en/mill-house.yaml changed in the repository after it was opened',
    paths: ['src/content/listings/en/mill-house.yaml'],
  });
});

test('publishing is refused when a stored draft is not everything the schema needs', async () => {
  publishDrafts.mockClear();
  pendingDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: 'title: "The Mill House"\n',
      updatedAt: 1755864000000,
    },
  ]);
  const res = await POST(post('publish', ''));
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    error: 'src/content/listings/en/mill-house.yaml is missing something the schema needs',
    paths: ['src/content/listings/en/mill-house.yaml'],
  });
  expect(publishDrafts).not.toHaveBeenCalled();
});

// redirects.yaml and the globals share the prefix and belong to no collection; holding them
// to a schema nobody declared would block every publish for good.
test('a pending file no collection owns is not held to a collection schema', async () => {
  publishDrafts.mockClear();
  pendingDrafts.mockImplementationOnce(async () => [
    { path: 'src/content/redirects.yaml', contents: 'rules: []\n', updatedAt: 1755864000000 },
  ]);
  expect((await POST(post('publish', ''))).status).toBe(200);
  expect(publishDrafts).toHaveBeenCalled();
});

test('discarding a draft drops the row and commits nothing', async () => {
  discardDraft.mockClear();
  publish.mockClear();
  const res = await DELETE(ctx('drafts/listings/mill-house'));
  expect(res.status).toBe(200);
  expect(discardDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    'src/content/listings/en/mill-house.yaml',
  );
  expect(publish).not.toHaveBeenCalled();
});

test('discarding a draft of a collection that is not configured is 404', async () => {
  discardDraft.mockClear();
  expect((await DELETE(ctx('drafts/nope/mill-house'))).status).toBe(404);
  expect(discardDraft).not.toHaveBeenCalled();
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
  overlayRows.mockImplementationOnce(async () => [
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: 'title: "The Mill House, renamed"\n',
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

test('opening an entry names the field its collection is keyed on', async () => {
  draft = { contents: 'name: "Rosa Hale"\n', baseSha: 'head789', baseBlob: '' };
  const keyed = (await (await GET(ctx('entries/presenters/rosa-hale'))).json()) as {
    titleField?: string;
  };
  expect(keyed.titleField).toBe('name');
  const plain = (await (await GET(ctx('entries/listings/mill-house'))).json()) as {
    titleField?: string;
  };
  expect(plain.titleField).toBeUndefined();
  draft = undefined;
});

test('a collection keyed on another field lists its drafts by that field', async () => {
  overlayRows.mockImplementationOnce(async () => [
    {
      path: 'src/content/presenters/en/ada-fenwick.yaml',
      contents: 'name: "Ada Fenwick"\n',
    },
  ]);
  const res = await GET(ctx('entries/presenters'));
  expect(await res.json()).toEqual({
    entries: [
      {
        id: 'ada-fenwick',
        locales: {
          en: { title: 'Ada Fenwick', path: 'src/content/presenters/en/ada-fenwick.yaml' },
        },
      },
      {
        id: 'rosa-hale',
        locales: { en: { title: 'Rosa Hale', path: 'src/content/presenters/en/rosa-hale.yaml' } },
      },
    ],
  });
});

test('listing an unknown collection is 404', async () => {
  expect((await GET(ctx('entries/nope'))).status).toBe(404);
});

test('creating an entry derives its file name and stores it as a draft, uncommitted', async () => {
  createDraft.mockClear();
  publish.mockClear();
  const res = await POST(post('entries/listings', JSON.stringify({ title: 'Café & Bar / 2026' })));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ slug: 'cafe-bar-2026' });
  expect(createDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/listings/en/cafe-bar-2026.yaml',
    // Only the title: a required field is left absent rather than guessed at, and the editor
    // is shown what is still missing.
    { _version: 1, title: 'Café & Bar / 2026' },
  );
  expect(publish).not.toHaveBeenCalled();
});

test('a new entry keeps the title that named its file, under the declared field', async () => {
  createDraft.mockClear();
  const res = await POST(post('entries/presenters', JSON.stringify({ title: 'Ada Fenwick' })));
  expect(await res.json()).toEqual({ slug: 'ada-fenwick' });
  expect(createDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/presenters/en/ada-fenwick.yaml',
    { _version: 1, name: 'Ada Fenwick' },
  );
});

test('a title already used in the collection gets the collision suffix', async () => {
  const res = await POST(post('entries/listings', JSON.stringify({ title: 'Seaview Cottage' })));
  expect(await res.json()).toEqual({ slug: 'seaview-cottage-2' });
});

test('a name already taken by an unpublished entry counts as taken too', async () => {
  overlayRows.mockImplementationOnce(async () => [
    {
      path: 'src/content/listings/en/strandhaus-nord.yaml',
      contents: 'title: "Strandhaus Nord"\n',
    },
  ]);
  const res = await POST(post('entries/listings', JSON.stringify({ title: 'Strandhaus Nord' })));
  expect(await res.json()).toEqual({ slug: 'strandhaus-nord-2' });
});

test('creating in an unknown collection is 404', async () => {
  createDraft.mockClear();
  expect((await POST(post('entries/nope', JSON.stringify({ title: 'x' })))).status).toBe(404);
  expect(createDraft).not.toHaveBeenCalled();
});

test('an entry that exists only as a draft opens from it', async () => {
  draft = { contents: 'title: "Strandhaus Nord"\nrooms: 0\n', baseSha: 'head789', baseBlob: '' };
  const res = await GET(ctx('entries/listings/strandhaus-nord'));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: unknown; pending: boolean };
  expect(body.data).toEqual({ title: 'Strandhaus Nord', rooms: 0 });
  expect(body.pending).toBe(true);
  draft = undefined;
});

test('renaming moves the entry in one commit and takes its unpublished edits with it', async () => {
  publish.mockClear();
  recordRename.mockClear();
  const res = await POST(
    post('entries/listings/mill-house/rename', JSON.stringify({ to: 'The Old Mill' })),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ slug: 'the-old-mill', commit_sha: 'def456' });
  expect(publish).toHaveBeenCalledTimes(1);
  const [files] = (publish.mock.calls[0] ?? []) as unknown as [PublishFile[]];
  expect(files.map((f) => f.path)).toEqual([
    'src/content/listings/en/mill-house.yaml',
    'src/content/listings/en/the-old-mill.yaml',
    'src/content/redirects.yaml',
  ]);
  expect(files[0]?.contents).toBe(null);
  expect(files[2]?.contents).toContain('from: "/listings/mill-house"');
  expect(recordRename).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    'src/content/listings/en/mill-house.yaml',
    'src/content/listings/en/the-old-mill.yaml',
    'title: The Mill House\nlocation: Bakewell\nrooms: 3\n',
    'def456',
  );
});

test('renaming an entry that has never been published says so rather than failing', async () => {
  publish.mockClear();
  const res = await POST(
    post('entries/listings/strandhaus-nord/rename', JSON.stringify({ to: 'x' })),
  );
  expect(res.status).toBe(409);
  expect(await res.text()).toContain('Publish');
  expect(publish).not.toHaveBeenCalled();
});

test('deleting commits the removal with a redirect and says the file has gone', async () => {
  publish.mockClear();
  recordDelete.mockClear();
  const res = await DELETE(ctx('entries/listings/mill-house'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ commit_sha: 'def456' });
  const [files] = (publish.mock.calls[0] ?? []) as unknown as [PublishFile[]];
  expect(files.map((f) => f.path)).toEqual([
    'src/content/listings/en/mill-house.yaml',
    'src/content/redirects.yaml',
  ]);
  expect(files[1]?.contents).toContain('reason: "deleted"');
  // The list is the build's index and the build has not run yet, so something has to say so.
  expect(recordDelete).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    'src/content/listings/en/mill-house.yaml',
    'def456',
  );
});

test('deleting an entry that was never published makes no commit', async () => {
  publish.mockClear();
  discardDraft.mockClear();
  const res = await DELETE(ctx('entries/listings/strandhaus-nord'));
  expect(res.status).toBe(200);
  expect(publish).not.toHaveBeenCalled();
  expect(discardDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    'src/content/listings/en/strandhaus-nord.yaml',
  );
});
