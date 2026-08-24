import {
  applyDrift,
  formOf,
  type PublishFile,
  parseEntry,
  RepoUnreachableError,
  stringifyEntry,
} from '@handover/core';
import type { APIContext } from 'astro';
import { afterEach, expect, test, vi } from 'vitest';
import { formSchema } from '../index.js';
import { DELETE, GET, POST, PUT } from './api.js';

const {
  listing,
  presenter,
  page,
  article,
  files,
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
  resolveDrift,
  saveTranslated,
  setEntryAddress,
  setEntryLocales,
  translate,
} = await vi.hoisted(async () => {
  const { z } = await import('astro/zod');
  const { blocks, defineBlock } = await import('../index.js');
  // Every file the repository holds beyond the one below, path → contents; filled per test.
  const files: Record<string, string> = {};
  return {
    files,
    // A collection with blocks in it: what two languages of one entry can disagree about.
    page: z.object({
      title: z.string(),
      // A field with the same value in every language: what Create from English carries over.
      layout: z.string().optional().meta({ i18n: 'duplicate' }),
      blocks: blocks(() => ({
        hero: defineBlock('hero', { heading: z.string() }),
        quote: defineBlock('quote', { body: z.string() }),
      })),
    }),
    listing: z.object({
      title: z.string(),
      location: z.string().optional(),
      rooms: z.number(),
      address: z.object({ street: z.string() }),
    }),
    // A collection keyed on something other than `title`.
    presenter: z.object({ name: z.string() }),
    // A collection whose languages each serve their entries at an address of their own.
    article: z.object({ title: z.string(), slug: z.string().optional() }),
    // The GitHub boundary: one file in the repo, nothing else.
    getFile: vi.fn(async (path: string) => {
      const stored = files[path];
      if (stored !== undefined) return { contents: stored, blob_sha: `blob-${path}` };
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
    publishDrafts: vi.fn<
      (...args: unknown[]) => Promise<{ commit_sha: string; paths: string[] } | undefined>
    >(async () => ({ commit_sha: 'def456', paths: ['src/content/listings/en/mill-house.yaml'] })),
    saveDraft: vi.fn<() => Promise<{ updated_at: number; pending: boolean } | undefined>>(
      async () => ({ updated_at: 1755864000000, pending: true }),
    ),
    createDraft: vi.fn<(...args: unknown[]) => Promise<{ updated_at: number }>>(async () => ({
      updated_at: 1755864000000,
    })),
    resolveDrift: vi.fn(async () => {}),
    saveTranslated: vi.fn(async () => ({ updated_at: 1755864000000, pending: true })),
    setEntryLocales: vi.fn(async () => {}),
    setEntryAddress: vi.fn(async () => ({ updated_at: 1755864000000, pending: true })),
    // The provider behind the hook: whatever the site configured, seen from the route.
    translate: vi.fn(async (texts: string[], _from: string, to: string) =>
      texts.map((t) => `[${to}] ${t}`),
    ),
    recordRename: vi.fn(async () => {}),
    recordDelete: vi.fn(async () => {}),
    discardDraft: vi.fn(async () => {}),
    // What the entry list lays over the index: the pending drafts plus what a commit left.
    overlayRows: vi.fn(async () => [] as { path: string; contents: string }[]),
  };
});

// The row GET should overlay, set per test. `rows` is the same thing keyed by path, for an
// entry whose languages are not all in the same state.
type Row = { contents: string; baseSha: string; baseBlob: string };
let draft: Row | undefined;
const rows: Record<string, Row> = {};
// The languages the site declares, likewise: one and several are different code paths.
let locales = ['en'];
// What the site translates with: its own hook, or nothing at all.
let translator: typeof translate | undefined = translate;
// And what the Worker holds when the site has no hook of its own.
let deeplKey: string | undefined;
vi.mock('virtual:handover/config', () => ({
  default: {
    i18n: {
      get locales() {
        return locales;
      },
      defaultLocale: 'en',
      get translate() {
        return translator;
      },
    },
    collections: {
      listings: { schema: listing, route: '/listings/[slug]', index: '/listings' },
      presenters: { schema: presenter, titleField: 'name' },
      pages: { schema: page },
      posts: { schema: article, route: '/blog/[slug]', index: '/blog', localizedSlugs: true },
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
    posts: [
      {
        id: 'hello',
        locales: { en: { title: 'Hello', path: 'src/content/posts/en/hello.yaml' } },
      },
      {
        id: 'taken',
        locales: {
          en: { title: 'Taken', path: 'src/content/posts/en/taken.yaml' },
          de: { title: 'Belegt', path: 'src/content/posts/de/taken.yaml', slug: 'belegt' },
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
    get DEEPL_API_KEY() {
      return deeplKey;
    },
    DB: {},
  },
}));
vi.mock('@handover/core', async (original) => ({
  ...(await original<typeof import('@handover/core')>()),
  createGitClient: () => ({ getFile, getHead, publish }),
  openDb: () => ({}),
  loadDraft: async (_site: string, _db: unknown, path: string) => rows[path] ?? draft,
  saveDraft,
  createDraft,
  recordRename,
  recordDelete,
  discardDraft,
  overlayRows,
  pendingDrafts,
  publishDrafts,
  resolveDrift,
  saveTranslated,
  setEntryAddress,
  setEntryLocales,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  draft = undefined;
  locales = ['en'];
  translator = translate;
  deeplKey = undefined;
  for (const path of Object.keys(files)) delete files[path];
  for (const path of Object.keys(rows)) delete rows[path];
});

const ctx = (path: string, request?: Request) =>
  ({ params: { path }, request }) as unknown as APIContext;
const post = (path: string, body: string) =>
  ctx(path, new Request(`https://x/admin/api/${path}`, { method: 'POST', body }));
const put = (path: string, body: string) =>
  ctx(path, new Request(`https://x/admin/api/${path}`, { method: 'PUT', body }));

test('ping returns the configured collection names', async () => {
  const res = await GET(ctx('ping'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true,
    collections: ['listings', 'presenters', 'pages', 'posts'],
  });
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
    translations: {},
    pending: [],
    problems: [{ path: 'address', message: 'Required' }],
    locales: ['en'],
    defaultLocale: 'en',
    sourceLocale: 'en',
    offered: ['en'],
    offerProblems: [],
    drift: [],
    stale: [],
    translator: true,
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
  const body = (await res.json()) as { data: unknown; pending: unknown };
  expect(body.data).toEqual({ title: 'The Mill House (draft)', location: 'Bakewell', rooms: 3 });
  expect(body.pending).toEqual(['en']);
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
  expect(((await res.json()) as { entries: unknown }).entries).toEqual([
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
  ]);
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
  expect(((await res.json()) as { entries: unknown }).entries).toEqual([
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
  ]);
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
  const body = (await res.json()) as { data: unknown; pending: unknown };
  expect(body.data).toEqual({ title: 'Strandhaus Nord', rooms: 0 });
  expect(body.pending).toEqual(['en']);
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

// The rule a rename or a delete owes is a URL on the site: it carries the language's segment,
// and on a collection with localized slugs the address that language actually served rather
// than the file name every language shares (F5 in 02-i18n.md).
test('deleting a bilingual entry sends each language its own URL to its own index', async () => {
  locales = ['en', 'de'];
  files['src/content/posts/en/hello.yaml'] = '_version: 1\ntitle: "Hello"\n';
  files['src/content/posts/de/hello.yaml'] = '_version: 1\ntitle: "Hallo"\nslug: "hallo"\n';
  publish.mockClear();

  const res = await DELETE(ctx('entries/posts/hello'));

  expect(res.status).toBe(200);
  const [written] = (publish.mock.calls[0] ?? []) as unknown as [PublishFile[]];
  const rules = written.find((f) => f.path === 'src/content/redirects.yaml')?.contents ?? '';
  expect(rules).toContain('from: "/blog/hello"\n    to: "/blog"');
  expect(rules).toContain('from: "/de/blog/hallo"\n    to: "/de/blog"');
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

// One entry in two languages, with a block only the German file has and nothing saying it is
// German-only: the fixture pair from @handover/core, through the routes the admin calls.
const home = {
  en: [
    '_version: 1',
    'title: "Home"',
    'blocks:',
    '  - _type: "hero"',
    '    _id: "k3nf9a2p"',
    '    heading: "Move to the coast"',
    '',
  ].join('\n'),
  de: [
    '_version: 1',
    'title: "Startseite"',
    'blocks:',
    '  - _type: "hero"',
    '    _id: "k3nf9a2p"',
    '    heading: "Zieh an die Küste"',
    '  - _type: "quote"',
    '    _id: "z9y8x7w6"',
    '    body: "Ein seltener Fund."',
    '',
  ].join('\n'),
};

const drifted = () => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en;
  files['src/content/pages/de/home.yaml'] = home.de;
};

test('opening an entry reports the blocks its languages disagree about', async () => {
  drifted();

  const body = (await (await GET(ctx('entries/pages/home'))).json()) as { drift: unknown };

  expect(body.drift).toEqual([
    {
      path: 'blocks[_id=z9y8x7w6]',
      type: 'quote',
      in: ['de'],
      expected: ['en', 'de'],
      values: { de: ['Ein seltener Fund.'] },
    },
  ]);
});

// Side by side: the second language is drawn from the same response, so opening an entry is
// still one read per language and the browser never asks for a file of its own.
test('an entry carries the languages it has a file in beside the one it opens on', async () => {
  drifted();

  const body = (await (await GET(ctx('entries/pages/home'))).json()) as {
    translations: Record<string, unknown>;
  };

  expect(body.translations).toEqual({
    de: {
      _version: 1,
      title: 'Startseite',
      blocks: [
        { _type: 'hero', _id: 'k3nf9a2p', heading: 'Zieh an die Küste' },
        { _type: 'quote', _id: 'z9y8x7w6', body: 'Ein seltener Fund.' },
      ],
    },
  });
});

test('the entry list says which languages the site declares', async () => {
  locales = ['en', 'de'];

  const body = (await (await GET(ctx('entries/listings'))).json()) as { locales: unknown };

  expect(body.locales).toEqual(['en', 'de']);
});

test('a save of a translation goes to that language and takes only the words it owns', async () => {
  drifted();
  saveDraft.mockClear();
  const data = { title: 'Startseite!' };

  const res = await PUT(put('drafts/pages/home/de', JSON.stringify({ data })));

  expect(res.status).toBe(200);
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/de/home.yaml',
    data,
    { form: expect.anything(), locale: 'de', siblings: {}, translation: true },
  );
});

test('a save to a language the site does not declare is refused', async () => {
  drifted();
  saveDraft.mockClear();

  const res = await PUT(put('drafts/pages/home/fr', JSON.stringify({ data: { title: 'x' } })));

  expect(res.status).toBe(404);
  expect(saveDraft).not.toHaveBeenCalled();
});

test('publishing an entry whose languages have drifted apart is refused', async () => {
  drifted();
  publishDrafts.mockClear();
  pendingDrafts.mockImplementationOnce(async () => [
    { path: 'src/content/pages/en/home.yaml', contents: home.en, updatedAt: 1755864000000 },
  ]);

  const res = await POST(post('publish', ''));

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error:
      "src/content/pages/en/home.yaml has drifted apart from the entry's other languages — resolve it in the editor",
    paths: ['src/content/pages/en/home.yaml'],
    // Which 409 it is: the drawer offers Discard for a conflict and the editor for this.
    reason: 'drift',
  });
  expect(publishDrafts).not.toHaveBeenCalled();
});

test('an entry whose languages agree publishes, drift or no drift elsewhere', async () => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en;
  files['src/content/pages/de/home.yaml'] = home.en.replace('Home', 'Startseite');
  publishDrafts.mockClear();
  pendingDrafts.mockImplementationOnce(async () => [
    { path: 'src/content/pages/en/home.yaml', contents: home.en, updatedAt: 1755864000000 },
  ]);

  expect((await POST(post('publish', ''))).status).toBe(200);
  expect(publishDrafts).toHaveBeenCalled();
});

// Staleness: the German file says which English it was translated from, and the entry says
// whether that is still the English it has. A warning and never a refusal.
test('an entry whose translation was made from an older source language says so', async () => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en;
  files['src/content/pages/de/home.yaml'] = home.en
    .replace('Home', 'Startseite')
    .replace('Move to the coast', 'Zieh an die Küste')
    .replace(
      '_version: 1\n',
      [
        '_version: 1',
        '_i18n:',
        '  sourceLocale: "en"',
        '  sourceBlob: "3f9c2e1a7b8d4c6e0a2f5b7c9d1e3a5b7c9d1e3a"',
        '  sourceHash: "0000000000000000"',
        '  translatedAt: "2026-08-20T10:14:00Z"',
        '',
      ].join('\n'),
    );

  const body = (await (await GET(ctx('entries/pages/home'))).json()) as {
    stale: unknown;
    drift: unknown;
  };

  expect(body.stale).toEqual(['de']);
  expect(body.drift).toEqual([]);
});

// It reads the entry rather than the path: which language a file was translated from is the
// entry's answer, and an entry with no English file has not been translated from English.
test('a publish names the language each translation it commits was made from', async () => {
  drifted();
  publishDrafts.mockClear();

  await POST(post('publish', ''));

  const sourceOf = publishDrafts.mock.calls[0]?.[3] as (
    path: string,
  ) => Promise<{ locale: string; path: string } | undefined>;
  expect(await sourceOf('src/content/pages/de/home.yaml')).toMatchObject({
    locale: 'en',
    path: 'src/content/pages/en/home.yaml',
  });
  expect(await sourceOf('src/content/pages/en/home.yaml')).toBe(undefined);
  expect(await sourceOf('src/content/redirects.yaml')).toBe(undefined);
});

// A site with one language has no second file to compare against and never reads for one:
// opening an entry is the one request it always was, and publishing reads nothing extra.
test('a one-language site is not asked for a second language of anything', async () => {
  getFile.mockClear();

  const body = (await (await GET(ctx('entries/listings/mill-house'))).json()) as { drift: unknown };

  expect(body.drift).toEqual([]);
  expect(getFile).toHaveBeenCalledTimes(1);

  getFile.mockClear();
  await POST(post('publish', ''));

  expect(getFile).not.toHaveBeenCalled();
});

// Reconciling that drift: the answers are the editor's, and every language of the entry is
// written behind them. The entry is read again afterwards, so nothing is marked resolved.
const answer = (choices: unknown) => post('drift/pages/home', JSON.stringify({ choices }));

test("the answers to an entry's drift go to every language it has a file in", async () => {
  drifted();
  const choices = [{ path: 'blocks[_id=z9y8x7w6]', locales: ['de'] }];

  const res = await POST(answer(choices));

  expect(res.status).toBe(200);
  expect(resolveDrift).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ blocks: expect.anything() }),
    ['en', 'de'],
    {
      en: 'src/content/pages/en/home.yaml',
      de: 'src/content/pages/de/home.yaml',
    },
    choices,
  );
});

test('an answer about a block the languages agree on is refused rather than written', async () => {
  drifted();
  resolveDrift.mockClear();

  const res = await POST(answer([{ path: 'blocks[_id=k3nf9a2p]', locales: ['de'] }]));

  expect(res.status).toBe(409);
  expect(resolveDrift).not.toHaveBeenCalled();
  expect((await POST(answer([]))).status).toBe(409);
});

// The two ends of the done-when: the state an answer leaves behind is one that publishes, and
// the answer that puts a block into English leaves the schema's own complaint, not a refusal.
const resolved = (locales: string[]) => {
  drifted();
  const form = formOf('default', formSchema(page));
  const applied = applyDrift(
    'default',
    form,
    ['en', 'de'],
    { en: parseEntry('default', home.en), de: parseEntry('default', home.de) },
    [{ path: 'blocks[_id=z9y8x7w6]', locales }],
  );
  const written = Object.entries(applied).map(([locale, data]) => ({
    path: `src/content/pages/${locale}/home.yaml`,
    contents: stringifyEntry('default', data),
    updatedAt: 1755864000000,
  }));
  for (const row of written) files[row.path] = row.contents;
  pendingDrafts.mockImplementationOnce(async () => written);
  return written;
};

test('an entry answered German-only publishes', async () => {
  publishDrafts.mockClear();
  resolved(['de']);

  expect((await POST(post('publish', ''))).status).toBe(200);
  expect(publishDrafts).toHaveBeenCalled();
});

test('a block answered into English is refused for what its schema needs, not for drift', async () => {
  publishDrafts.mockClear();
  resolved(['en', 'de']);

  const res = await POST(post('publish', ''));

  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    error: 'src/content/pages/en/home.yaml is missing something the schema needs',
    paths: ['src/content/pages/en/home.yaml'],
  });
  expect(publishDrafts).not.toHaveBeenCalled();
});

// An entry with no German file: the two things the editor offers there — make one from the
// English, or say this entry is not offered in German at all.
const untranslated = (english = home.en) => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = english;
};

test('creating a language copies the structure and the shared values, not the words', async () => {
  untranslated(home.en.replace('title: "Home"', 'title: "Home"\nlayout: "wide"'));
  createDraft.mockClear();

  const res = await POST(post('drafts/pages/home/de', ''));

  expect(res.status).toBe(200);
  expect(createDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/de/home.yaml',
    {
      _version: 1,
      layout: 'wide',
      blocks: [{ _type: 'hero', _id: 'k3nf9a2p' }],
    },
  );
});

test('the new language is offered in the same ones the entry already is', async () => {
  locales = ['en', 'de', 'fr'];
  files['src/content/pages/en/home.yaml'] = home.en.replace(
    '_version: 1',
    '_version: 1\n_locales:\n  - "en"\n  - "de"',
  );
  createDraft.mockClear();

  await POST(post('drafts/pages/home/de', ''));

  expect(createDraft.mock.calls[0]?.[4]).toMatchObject({ _locales: ['en', 'de'] });
});

test('creating a language the entry already has is refused', async () => {
  drifted();
  createDraft.mockClear();

  const res = await POST(post('drafts/pages/home/de', ''));

  expect(res.status).toBe(409);
  expect(createDraft).not.toHaveBeenCalled();
});

// The site's default language is no longer a language this route refuses on sight: an entry
// with no file in it is exactly what it is for. What refuses it here is the file this entry
// has — the same rule every other language is held to.
test('the language an entry is written in is refused for the file it has, not for being it', async () => {
  untranslated();
  createDraft.mockClear();

  expect((await POST(post('drafts/pages/home/en', ''))).status).toBe(409);
  expect((await POST(post('drafts/pages/home/fr', ''))).status).toBe(404);
  expect(createDraft).not.toHaveBeenCalled();
});

// Create from English writes a draft in a language the entry's form does not draw, so the
// response has to name it: the editor offers Publish on any language being ahead, not on the
// one it happens to be showing.
test('an entry names every language whose draft is ahead of the repository', async () => {
  untranslated();
  rows['src/content/pages/de/home.yaml'] = {
    contents: home.en.replace('Home', 'Startseite'),
    baseSha: 'head789',
    baseBlob: '',
  };

  const body = (await (await GET(ctx('entries/pages/home'))).json()) as { pending: unknown };

  expect(body.pending).toEqual(['de']);
});

test('turning a language off writes the ones it keeps into every file the entry has', async () => {
  untranslated();
  setEntryLocales.mockClear();

  const res = await POST(post('entries/pages/home/locales', JSON.stringify({ locales: ['en'] })));

  expect(res.status).toBe(200);
  expect(setEntryLocales).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    ['src/content/pages/en/home.yaml'],
    ['en'],
    ['en', 'de'],
  );
});

test('turning off a language the entry has a file in is refused', async () => {
  drifted();
  setEntryLocales.mockClear();

  const res = await POST(post('entries/pages/home/locales', JSON.stringify({ locales: ['en'] })));

  expect(res.status).toBe(409);
  expect(setEntryLocales).not.toHaveBeenCalled();
});

// A top-level `_locales` is written into every file the entry has, so one that names fewer
// languages than the entry has files is a hand edit or a bad merge: the list struck the
// language through while the editor let somebody type in it, and neither said why.
test('a _locales the files contradict is reported, and the file wins', async () => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en.replace(
    '_version: 1',
    '_version: 1\n_locales:\n  - "en"',
  );
  files['src/content/pages/de/home.yaml'] = home.de;

  const body = (await (await GET(ctx('entries/pages/home'))).json()) as {
    offered: unknown;
    offerProblems: unknown;
  };

  expect(body.offered).toEqual(['en', 'de']);
  expect(body.offerProblems).toEqual([
    '_locales says this entry is not offered in de, and it has a file in de',
  ]);
});

test('creating a language is refused over a _locales naming one the site does not declare', async () => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en.replace(
    '_version: 1',
    '_version: 1\n_locales:\n  - "en"\n  - "fr"',
  );
  createDraft.mockClear();

  const res = await POST(post('drafts/pages/home/de', ''));

  expect(res.status).toBe(409);
  expect(await res.text()).toContain('"fr"');
  expect(createDraft).not.toHaveBeenCalled();
});

test('an entry says which languages it is offered in', async () => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en.replace(
    '_version: 1',
    '_version: 1\n_locales:\n  - "en"',
  );

  const body = (await (await GET(ctx('entries/pages/home'))).json()) as { offered: unknown };

  expect(body.offered).toEqual(['en']);
});

// The `translate(from, to)` hook: whatever answers, the route asks it for prose and writes
// the answers into the translation's own draft with `_machine` naming them.
const machine = () => {
  locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en;
  files['src/content/pages/de/home.yaml'] = [
    '_version: 1',
    'title: "Startseite"',
    'blocks:',
    '  - _type: "hero"',
    '    _id: "k3nf9a2p"',
    '',
  ].join('\n');
};

test('a machine is asked for the fields the translation has not got, and no others', async () => {
  machine();
  translate.mockClear();
  saveTranslated.mockClear();

  const res = await POST(post('translate/pages/home/de', ''));

  expect(res.status).toBe(200);
  // `title` is there in German already; the hero's heading is the gap.
  expect(translate).toHaveBeenCalledWith(['Move to the coast'], 'en', 'de');
  expect(saveTranslated).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/de/home.yaml',
    { 'blocks[_id=k3nf9a2p].heading': '[de] Move to the coast' },
  );
});

test('a named field is translated whether it is empty or not', async () => {
  machine();
  translate.mockClear();
  saveTranslated.mockClear();

  const res = await POST(post('translate/pages/home/de', JSON.stringify({ paths: ['title'] })));

  expect(res.status).toBe(200);
  expect(translate).toHaveBeenCalledWith(['Home'], 'en', 'de');
  expect(saveTranslated).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/de/home.yaml',
    { title: '[de] Home' },
  );
});

test('a translation with nothing left to fill asks no machine anything', async () => {
  machine();
  files['src/content/pages/de/home.yaml'] = home.en.replace('Home', 'Startseite');
  translate.mockClear();

  expect((await POST(post('translate/pages/home/de', ''))).status).toBe(200);
  expect(translate).not.toHaveBeenCalled();
});

// Every other test here supplies `i18n.translate`, so the fallback — and which DeepL the key
// then reaches — is the one wiring none of them walks.
test('a site with no hook of its own translates with the DEEPL_API_KEY it holds', async () => {
  machine();
  translator = undefined;
  deeplKey = 'key-123';
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const sent = JSON.parse(String(init.body)) as { text: string[] };
      return Response.json({ translations: sent.text.map((t) => ({ text: `[de] ${t}` })) });
    }),
  );
  saveTranslated.mockClear();

  const res = await POST(post('translate/pages/home/de', ''));

  expect(res.status).toBe(200);
  expect(calls[0]?.url).toBe('https://api.deepl.com/v2/translate');
  const headers = calls[0]?.init.headers as Record<string, string> | undefined;
  expect(headers?.authorization).toBe('DeepL-Auth-Key key-123');
  expect(saveTranslated).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/de/home.yaml',
    { 'blocks[_id=k3nf9a2p].heading': '[de] Move to the coast' },
  );
});

test('a site with nothing to translate with says so rather than failing quietly', async () => {
  machine();
  translator = undefined;

  const res = await POST(post('translate/pages/home/de', ''));

  expect(res.status).toBe(409);
  expect(await res.text()).toContain('DEEPL_API_KEY');
});

test('the default language and a language with no file are both refused', async () => {
  machine();

  expect((await POST(post('translate/pages/home/en', ''))).status).toBe(404);
  expect((await POST(post('translate/pages/home/fr', ''))).status).toBe(404);
  delete files['src/content/pages/de/home.yaml'];
  expect((await POST(post('translate/pages/home/de', ''))).status).toBe(404);
});

test('an entry says whether there is anything to translate with', async () => {
  machine();
  expect(
    ((await (await GET(ctx('entries/pages/home'))).json()) as { translator: unknown }).translator,
  ).toBe(true);
  translator = undefined;
  expect(
    ((await (await GET(ctx('entries/pages/home'))).json()) as { translator: unknown }).translator,
  ).toBe(false);
});

// Having nothing to translate with is about the site and not about this entry, so it is the
// answer even when the entry would have been refused for its own reasons.
test('nothing to translate with outranks the entry having no file in that language', async () => {
  machine();
  translator = undefined;
  delete files['src/content/pages/de/home.yaml'];

  expect((await POST(post('translate/pages/home/de', ''))).status).toBe(409);
});

// A collection with an address per language. The file name stays the entry's id across them;
// the address is only what a URL is built from.
const addressed = () => {
  locales = ['en', 'de'];
  files['src/content/posts/en/hello.yaml'] = '_version: 1\ntitle: "Hello"\nslug: "hello-world"\n';
  files['src/content/posts/de/hello.yaml'] = '_version: 1\ntitle: "Hallo"\nslug: "hallo"\n';
};

test('the address is not a field of the form and comes beside it instead', async () => {
  addressed();

  const body = (await (await GET(ctx('entries/posts/hello'))).json()) as {
    fields: { path: string[] }[];
    addresses: Record<string, string>;
    localizedSlugs: boolean;
    route: string;
  };

  expect(body.fields.map((f) => f.path[0])).toEqual(['title']);
  expect(body.addresses).toEqual({ en: 'hello-world', de: 'hallo' });
  expect(body.localizedSlugs).toBe(true);
  expect(body.route).toBe('/blog/[slug]');
});

test('a collection without localized slugs draws no address at all', async () => {
  files['src/content/listings/en/mill-house.yaml'] = 'title: "The Mill House"\nrooms: 3\n';

  const body = (await (await GET(ctx('entries/listings/mill-house'))).json()) as {
    addresses?: unknown;
    localizedSlugs?: unknown;
  };

  expect(body.localizedSlugs).toBe(undefined);
  expect(body.addresses).toBe(undefined);
});

// It is a URL, not prose: a machine's guess at one is not a word anybody can read in the form
// and correct, and it would not survive the address rules anyway.
test('a machine is never asked to translate the address', async () => {
  addressed();
  translate.mockClear();

  const res = await POST(post('translate/posts/hello/de', JSON.stringify({ paths: ['slug'] })));

  expect(res.status).toBe(200);
  expect(translate).not.toHaveBeenCalled();
});

test('an address that is not one is refused with the reason', async () => {
  addressed();

  const res = await POST(
    post('entries/posts/hello/address/de', JSON.stringify({ address: 'Hallo Welt' })),
  );

  expect(res.status).toBe(422);
  expect(await res.text()).toMatch(/lowercase letters, digits and single dashes/);
});

test('an address another entry in that language already serves is refused', async () => {
  addressed();

  // `belegt` is another entry's address in German; `taken` is its file name, which is what it
  // would fall back to the moment somebody cleared that address.
  for (const address of ['belegt', 'taken']) {
    const res = await POST(post('entries/posts/hello/address/de', JSON.stringify({ address })));
    expect([address, res.status]).toEqual([address, 409]);
  }
});

// The same rule a file name follows: an entry nobody has published yet still holds its address.
test('an address an unpublished draft already claims is refused', async () => {
  addressed();
  overlayRows.mockResolvedValueOnce([
    {
      path: 'src/content/posts/de/fresh.yaml',
      contents: '_version: 1\ntitle: "Frisch"\nslug: "frisch"\n',
    },
  ]);

  const res = await POST(
    post('entries/posts/hello/address/de', JSON.stringify({ address: 'frisch' })),
  );

  expect(res.status).toBe(409);
});

test('an entry keeping the address it already has is not a clash with itself', async () => {
  addressed();
  setEntryAddress.mockClear();

  const res = await POST(
    post('entries/posts/hello/address/de', JSON.stringify({ address: 'hallo' })),
  );

  expect(res.status).toBe(200);
  expect(setEntryAddress).toHaveBeenCalled();
});

test('moving a published address owes a redirect from where it was, in that language alone', async () => {
  addressed();
  setEntryAddress.mockClear();

  const res = await POST(
    post('entries/posts/hello/address/de', JSON.stringify({ address: 'servus' })),
  );

  expect(res.status).toBe(200);
  expect(setEntryAddress).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      fields: expect.arrayContaining([expect.objectContaining({ path: ['slug'] })]),
    }),
    'src/content/posts/de/hello.yaml',
    'servus',
    { from: '/de/blog/hallo', to: '/de/blog/servus', entry: 'posts/hello' },
  );
});

test('an entry with no file in the repository yet owes nothing', async () => {
  locales = ['en', 'de'];
  rows['src/content/posts/de/hello.yaml'] = {
    contents: '_version: 1\ntitle: "Hallo"\n',
    baseSha: 'head789',
    baseBlob: '',
  };
  setEntryAddress.mockClear();

  const res = await POST(
    post('entries/posts/hello/address/de', JSON.stringify({ address: 'hallo' })),
  );

  expect(res.status).toBe(200);
  expect(setEntryAddress).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      fields: expect.arrayContaining([expect.objectContaining({ path: ['slug'] })]),
    }),
    'src/content/posts/de/hello.yaml',
    'hallo',
    undefined,
  );
});

test('a collection without localized slugs has no address to set', async () => {
  const res = await POST(
    post('entries/listings/mill-house/address/en', JSON.stringify({ address: 'mill' })),
  );

  expect(res.status).toBe(404);
});

// An entry with no file in the site's default language — the demo's German-only Impressum.
// Its structure is German's, because that is the only language anybody wrote it in.
const germanOnly = () => {
  locales = ['en', 'de'];
  files['src/content/pages/de/impressum.yaml'] = [
    '_version: 1',
    'title: "Impressum"',
    'blocks:',
    '  - _type: "hero"',
    '    _id: "b7t4x1m9"',
    '    heading: "Impressum"',
    '',
  ].join('\n');
};

test('an entry with no file in the site default opens on the language it has', async () => {
  germanOnly();

  const res = await GET(ctx('entries/pages/impressum'));

  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    sourceLocale: string;
    data: unknown;
    translations: unknown;
    offered: string[];
  };
  expect(body.sourceLocale).toBe('de');
  expect(body.data).toEqual({
    _version: 1,
    title: 'Impressum',
    blocks: [{ _type: 'hero', _id: 'b7t4x1m9', heading: 'Impressum' }],
  });
  // The language it is written in is the form, not a translation of something else.
  expect(body.translations).toEqual({});
  // No `_locales`, so English is a gap somebody can fill and not a decision.
  expect(body.offered).toEqual(['en', 'de']);
});

test('the missing default language is created from the language the entry has', async () => {
  germanOnly();
  createDraft.mockClear();

  const res = await POST(post('drafts/pages/impressum/en', ''));

  expect(res.status).toBe(200);
  expect(createDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/en/impressum.yaml',
    { _version: 1, blocks: [{ _type: 'hero', _id: 'b7t4x1m9' }] },
  );
});

test("a save of the entry's own language carries the structure, whichever language it is", async () => {
  germanOnly();
  saveDraft.mockClear();
  const data = { title: 'Impressum!' };

  const res = await PUT(put('drafts/pages/impressum', JSON.stringify({ data })));

  expect(res.status).toBe(200);
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/de/impressum.yaml',
    data,
    {
      form: expect.anything(),
      locale: 'de',
      siblings: { en: 'src/content/pages/en/impressum.yaml' },
      translation: false,
    },
  );
});

test('a publish marks a translation from the language the entry is written in', async () => {
  locales = ['en', 'de', 'fr'];
  files['src/content/pages/de/impressum.yaml'] = home.de;
  files['src/content/pages/fr/impressum.yaml'] = home.de;
  publishDrafts.mockClear();

  await POST(post('publish', ''));

  const sourceOf = publishDrafts.mock.calls[0]?.[3] as (
    path: string,
  ) => Promise<{ locale: string; path: string } | undefined>;
  // German, not English: the entry has no English file, so nothing was translated from one.
  expect(await sourceOf('src/content/pages/fr/impressum.yaml')).toMatchObject({
    locale: 'de',
    path: 'src/content/pages/de/impressum.yaml',
  });
  expect(await sourceOf('src/content/pages/de/impressum.yaml')).toBe(undefined);
});
