import { texts } from 'virtual:handover/index';
import {
  DraftRevisionError,
  loadDraft,
  type PublishFile,
  RepoUnreachableError,
} from '@handover/core';
import { afterEach, expect, test, vi } from 'vitest';
import { DELETE, GET, POST, PUT } from '../api.js';
import {
  addressed,
  beats,
  createDraft,
  ctx,
  deletedEntries,
  discardDraft,
  drifted,
  editor,
  files,
  germanOnly,
  getFile,
  holdEntry,
  home,
  logged,
  machine,
  overlayRows,
  owner,
  pendingDrafts,
  post,
  publish,
  put,
  resetContainers,
  resetMocks,
  resetState,
  resolveDrift,
  rows,
  saveDraft,
  setEntryAddress,
  setEntryLocales,
  setEntryStatus,
  state,
  taken,
  untranslated,
} from './harness.fixture.js';

const { workerMailerMock, configMock, indexMock, cloudflareMock, authMock, coreMock } =
  await vi.hoisted(async () => import('./harness.fixture.js'));

vi.mock('worker-mailer', () => workerMailerMock());
vi.mock('virtual:handover/config', () => configMock());
vi.mock('virtual:handover/index', () => indexMock());
vi.mock('cloudflare:workers', () => cloudflareMock());
vi.mock('../../auth.js', async (original) =>
  authMock((await original()) as Record<string, unknown>),
);
vi.mock('@handover/core', async (original) =>
  coreMock((await original()) as Record<string, unknown>),
);

afterEach(() => {
  vi.unstubAllGlobals();
  resetContainers();
  resetMocks();
  resetState();
  for (const key of Object.keys(texts)) delete texts[key];
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
    revisions: {},
    pending: [],
    held: false,
    problems: [{ path: 'address', message: 'Required', descriptor: { code: 'FIELD_REQUIRED' } }],
    // On the site: `_status` is absent, so no `redirects` key comes with it either.
    hidden: false,
    locales: ['en'],
    defaultLocale: 'en',
    sourceLocale: 'en',
    offered: ['en'],
    offerProblems: [],
    drift: [],
    stale: [],
    translator: true,
    // Where the site serves it, which is what the editor builds a URL from.
    route: '/listings/[slug]',
    index: '/listings',
    prefixDefaultLocale: false,
    // Which of its languages the repository already has a file for.
    published: ['en'],
  });
});

test('an unknown collection or missing entry is 404', async () => {
  for (const path of ['entries/nope/mill-house', 'entries/listings/nope']) {
    const res = await GET(ctx(path));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not found');
    expect(res.headers.get('x-handover-error-code')).toBe('ENTRY_NOT_FOUND');
  }
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

// A global is edited through the entry path.
test('a global is served as an entry, in singleton mode and under its own label', async () => {
  files['src/content/globals/en/site.yaml'] = 'footerText: "Coastal homes since 2009"\n';

  const res = await GET(ctx('entries/globals/site'));

  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(
    (body.fields as { path: string[]; type: string }[]).map(({ path, type }) => ({ path, type })),
  ).toEqual([
    { path: ['footerText'], type: 'text' },
    { path: ['phone'], type: 'text' },
    { path: ['defaultSeo'], type: 'group' },
  ]);
  expect(body.data).toEqual({ footerText: 'Coastal homes since 2009' });
  expect(body.singleton).toBe(true);
  expect(body.label).toBe('Site details');
  // Every language's, so switching the interface language redraws the heading without a request.
  expect(body.labels).toEqual({ en: 'Site details', de: 'Website-Angaben' });
  // Nothing a collection's routes are about: a global has no page of its own to link to.
  expect(body.route).toBeUndefined();
  expect(body.localizedSlugs).toBeUndefined();
  delete files['src/content/globals/en/site.yaml'];
});

// The panel greys the site's own defaults behind an empty box, and they are per language.
test('an entry with a seo field is served the site’s defaults, per language', async () => {
  state.locales = ['en', 'de'];
  files['src/content/posts/en/hello.yaml'] = 'title: Hello\n';
  files['src/content/globals/en/site.yaml'] =
    'footerText: "x"\ndefaultSeo:\n  titlePattern: "%s · Coastal Homes"\n';
  files['src/content/globals/de/site.yaml'] =
    'footerText: "x"\ndefaultSeo:\n  titlePattern: "%s · Küstenhäuser"\n';

  const body = (await (await GET(ctx('entries/posts/hello'))).json()) as Record<string, unknown>;

  expect(body.seoDefaults).toEqual({
    en: { titlePattern: '%s · Coastal Homes' },
    de: { titlePattern: '%s · Küstenhäuser' },
  });
  delete files['src/content/posts/en/hello.yaml'];
  delete files['src/content/globals/en/site.yaml'];
  delete files['src/content/globals/de/site.yaml'];
});

// Every other entry would be paying a read of the globals for a panel it never opens.
test('an entry with no seo field is served no defaults at all', async () => {
  const body = (await (await GET(ctx('entries/listings/mill-house'))).json()) as Record<
    string,
    unknown
  >;
  expect(body.seoDefaults).toBeUndefined();
});

test('a key cms.config.ts does not declare is not a global', async () => {
  expect((await GET(ctx('entries/globals/nope'))).status).toBe(404);
});

// The subtraction from the other side.
test('a global is refused the routes that rename, address, delete or turn off an entry', async () => {
  files['src/content/globals/en/site.yaml'] = 'footerText: "Coastal homes"\n';

  expect((await POST(post('entries/globals/site/rename', '{"to":"other"}'))).status).toBe(404);
  expect((await POST(post('entries/globals/site/address/en', '{"address":"x"}'))).status).toBe(404);
  expect((await POST(post('entries/globals/site/locales', '{"locales":["en"]}'))).status).toBe(404);
  expect((await DELETE(ctx('entries/globals/site'))).status).toBe(404);

  delete files['src/content/globals/en/site.yaml'];
});

test('a global takes a draft through the same autosave as an entry', async () => {
  saveDraft.mockClear();
  files['src/content/globals/en/site.yaml'] = 'footerText: "Coastal homes"\n';

  const res = await PUT(
    put(
      'drafts/globals/site',
      JSON.stringify({ revision: 'opened', data: { footerText: 'Coastal homes since 2009' } }),
    ),
  );

  expect(res.status).toBe(200);
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/globals/en/site.yaml',
    { footerText: 'Coastal homes since 2009' },
    // One language, so nothing to keep in step — the same plain write an entry gets.
    undefined,
    // Nobody signed in on this request, so the *last edited by* line stays empty.
    undefined,
    'opened',
  );
  expect(await res.json()).toEqual({ updated_at: 1755864000000, pending: true, problems: [] });
  delete files['src/content/globals/en/site.yaml'];
});

// A file with nothing in it is still a file.
test('a language whose file is empty opens as an empty entry', async () => {
  state.locales = ['en', 'de'];
  files['src/content/listings/de/mill-house.yaml'] = '';

  const res = await GET(ctx('entries/listings/mill-house'));
  const body = (await res.json()) as { translations: unknown; published: unknown };

  expect(body.translations).toEqual({ de: {} });
  expect(body.published).toEqual(['en', 'de']);
});

test('an entry with a draft returns the draft data and reports it as pending', async () => {
  state.draft = {
    contents: 'title: "The Mill House (draft)"\nlocation: "Bakewell"\nrooms: 3\n',
    baseSha: 'head789',
    baseBlob: 'abc123',
  };
  const res = await GET(ctx('entries/listings/mill-house'));
  const body = (await res.json()) as { data: unknown; pending: unknown };
  expect(body.data).toEqual({ title: 'The Mill House (draft)', location: 'Bakewell', rooms: 3 });
  expect(body.pending).toEqual(['en']);
  state.draft = undefined;
});

test('an autosave the serialiser cannot write back is refused, with the reason', async () => {
  saveDraft.mockClear();
  saveDraft.mockImplementationOnce(async () => {
    throw new Error('Nested array at tags[0]: wrap the inner array in an object');
  });
  const res = await PUT(
    put('drafts/listings/mill-house', JSON.stringify({ revision: 'opened', data: { tags: [[]] } })),
  );
  expect(res.status).toBe(400);
  expect(await res.text()).toBe('Nested array at tags[0]: wrap the inner array in an object');
});

test('a body that is not an object, and an unknown collection, are refused', async () => {
  saveDraft.mockClear();
  const body = JSON.stringify({ revision: 'opened', data: { title: 'No rooms' } });
  expect((await PUT(put('drafts/listings/mill-house', 'not json'))).status).toBe(400);
  expect(
    (await PUT(put('drafts/listings/mill-house', JSON.stringify({ revision: 'opened', data: [] }))))
      .status,
  ).toBe(400);
  expect((await PUT(put('drafts/nope/mill-house', body))).status).toBe(404);
  expect(saveDraft).not.toHaveBeenCalled();
});

test('autosave marks localized addresses as managed by their dedicated operation', async () => {
  saveDraft.mockClear();
  const data = { title: 'Hello', slug: 'taken-address' };

  const res = await PUT(put('drafts/posts/hello', JSON.stringify({ data })));

  expect(res.status).toBe(200);
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/posts/en/hello.yaml',
    data,
    {
      form: expect.anything(),
      locale: 'en',
      siblings: {},
      translation: false,
      managed: ['slug'],
    },
    undefined,
    'opened',
  );
});

test('autosave leaves ordinary slug fields in the editable write contract', async () => {
  saveDraft.mockClear();
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' }, slug: 'mill' };

  const res = await PUT(put('drafts/listings/mill-house', JSON.stringify({ data })));

  expect(res.status).toBe(200);
  const call = saveDraft.mock.calls[0] as unknown[] | undefined;
  expect(call?.[4]).toEqual(data);
  expect(call?.[5]).toBeUndefined();
});

test('an autosave for an entry that is not in the repo is 404', async () => {
  saveDraft.mockImplementationOnce(async () => undefined);
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  expect((await PUT(put('drafts/listings/gone', JSON.stringify({ data })))).status).toBe(404);
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

test('opening an entry names the field its collection is keyed on', async () => {
  state.draft = { contents: 'name: "Rosa Hale"\n', baseSha: 'head789', baseBlob: '' };
  const keyed = (await (await GET(ctx('entries/presenters/rosa-hale'))).json()) as {
    titleField?: string;
  };
  expect(keyed.titleField).toBe('name');
  const plain = (await (await GET(ctx('entries/listings/mill-house'))).json()) as {
    titleField?: string;
  };
  expect(plain.titleField).toBeUndefined();
  state.draft = undefined;
});

test('an entry that exists only as a draft opens from it', async () => {
  state.draft = {
    contents: 'title: "Strandhaus Nord"\nrooms: 0\n',
    baseSha: 'head789',
    baseBlob: '',
  };
  const res = await GET(ctx('entries/listings/strandhaus-nord'));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: unknown; pending: unknown; published: unknown };
  expect(body.data).toEqual({ title: 'Strandhaus Nord', rooms: 0 });
  expect(body.pending).toEqual(['en']);
  // Nothing of it is in the repository, so its preview is the only place this page exists.
  expect(body.published).toEqual([]);
  state.draft = undefined;
});

// decap-cms#7371 / payload#14491 at the route.
test('duplicating drafts a hidden copy of every language, ids regenerated together', async () => {
  createDraft.mockClear();
  publish.mockClear();
  state.locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] =
    '_version: 1\n_i18n:\n  sourceLocale: "en"\ntitle: "Home"\nblocks:\n  - _type: "hero"\n    _id: "k3nf9a2p"\n    heading: "Hi"\n';
  files['src/content/pages/de/home.yaml'] =
    '_version: 1\ntitle: "Startseite"\nblocks:\n  - _type: "hero"\n    _id: "k3nf9a2p"\n    heading: "Hallo"\n';

  const res = await POST(post('entries/pages/home/duplicate', JSON.stringify({})));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ slug: 'home-copy' });
  const written = createDraft.mock.calls.map((call) => [call[3], call[4]]) as [
    string,
    Record<string, unknown>,
  ][];
  expect(written.map(([path]) => path)).toEqual([
    'src/content/pages/en/home-copy.yaml',
    'src/content/pages/de/home-copy.yaml',
  ]);
  const ids = written.map(([, values]) => (values.blocks as { _id: string }[])[0]?._id);
  expect(ids[0]).toMatch(/^[0-9a-z]{8}$/);
  expect(ids[0]).not.toBe('k3nf9a2p');
  expect(ids[1]).toBe(ids[0]);
  for (const [, values] of written) {
    expect(values._status).toBe('hidden');
    expect(values).not.toHaveProperty('_i18n');
  }
  // Nothing is in the repository until somebody publishes the copy.
  expect(publish).not.toHaveBeenCalled();
  expect(logged).toEqual([
    {
      userId: undefined,
      kind: 'entry-duplicate',
      subject: 'src/content/pages/en/home-copy.yaml',
      detail: { from: 'home' },
    },
  ]);
});

test('duplicating including unpublished changes copies the draft bytes', async () => {
  createDraft.mockClear();
  files['src/content/pages/en/home.yaml'] = '_version: 1\ntitle: "Home"\n';
  rows['src/content/pages/en/home.yaml'] = {
    contents: '_version: 1\ntitle: "Home, rewritten"\n',
    baseSha: 'head789',
    baseBlob: 'blob-src/content/pages/en/home.yaml',
  };

  await POST(post('entries/pages/home/duplicate', JSON.stringify({ drafts: true })));

  expect(createDraft.mock.calls[0]?.[4]).toEqual({
    _version: 1,
    _status: 'hidden',
    title: 'Home, rewritten',
  });
});

test('the copy takes the file name it is given, through the same derivation as a new entry', async () => {
  createDraft.mockClear();
  files['src/content/pages/en/home.yaml'] = '_version: 1\ntitle: "Home"\n';

  const res = await POST(
    post('entries/pages/home/duplicate', JSON.stringify({ to: 'Zweites Zuhause' })),
  );

  expect(await res.json()).toEqual({ slug: 'zweites-zuhause' });
  expect(createDraft.mock.calls[0]?.[3]).toBe('src/content/pages/en/zweites-zuhause.yaml');
});

// What is copied is what the repository has.
test('an entry that was never published cannot be duplicated', async () => {
  createDraft.mockClear();
  const res = await POST(post('entries/listings/strandhaus-nord/duplicate', JSON.stringify({})));
  expect(res.status).toBe(409);
  expect(await res.text()).toBe('Publish this entry before duplicating it');
  expect(createDraft).not.toHaveBeenCalled();
});

test('duplicating in an unknown collection is 404', async () => {
  expect((await POST(post('entries/nope/home/duplicate', JSON.stringify({})))).status).toBe(404);
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

const del = (path: string, body?: unknown) =>
  DELETE(
    ctx(
      path,
      new Request(`https://x/admin/api/${path}`, {
        method: 'DELETE',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  );

// Step one of the order a rename and a delete are held to.
test('renaming waits for the editor who has the entry open', async () => {
  publish.mockClear();
  state.holder = { userId: 'someone-else', name: 'Anna Berg', expiresAt: 1755864120000 };

  const res = await POST(
    post('entries/listings/mill-house/rename', JSON.stringify({ to: 'The Old Mill' })),
  );

  expect(res.status).toBe(409);
  expect(await res.text()).toBe(
    'Anna Berg is editing this entry — it can be renamed once they are done',
  );
  expect(publish).not.toHaveBeenCalled();
});

test('deleting waits for the editor who has the entry open', async () => {
  publish.mockClear();
  state.holder = { userId: 'someone-else', name: 'Anna Berg', expiresAt: 1755864120000 };

  const res = await del('entries/listings/mill-house');

  expect(res.status).toBe(409);
  expect(await res.text()).toContain('it can be deleted once they are done');
  expect(publish).not.toHaveBeenCalled();
});

// Discarding is the one thing besides a restore that throws a colleague's unpublished words away.
test("discarding an entry's changes leaves a draft-discard row naming the languages", async () => {
  const res = await DELETE(
    ctx(
      'drafts/listings/mill-house',
      new Request('https://x/admin/api/drafts/listings/mill-house', { method: 'DELETE' }),
      { handover: editor },
    ),
  );

  expect(res.status).toBe(200);
  expect(logged).toEqual([
    {
      userId: 'u2',
      kind: 'draft-discard',
      subject: 'src/content/listings/en/mill-house.yaml',
      detail: { locales: ['en'] },
    },
  ]);
});

test('discarding an entry with nothing pending writes no row', async () => {
  pendingDrafts.mockResolvedValueOnce([]);
  await del('drafts/listings/mill-house');
  expect(logged).toEqual([]);
});

// The row the deleted list is built from.
test('a delete leaves a log row naming the entry that went', async () => {
  const res = await del('entries/listings/mill-house');

  expect(res.status).toBe(200);
  expect(logged).toEqual([
    {
      userId: undefined,
      kind: 'entry-delete',
      subject: 'src/content/listings/en/mill-house.yaml',
      detail: { locales: ['en'] },
      commitSha: 'def456',
    },
  ]);
});

// The rule a rename or a delete owes is a URL on the site.
test('deleting a bilingual entry sends each language its own URL to its own index', async () => {
  state.locales = ['en', 'de'];
  files['src/content/posts/en/hello.yaml'] = '_version: 1\ntitle: "Hello"\n';
  files['src/content/posts/de/hello.yaml'] = '_version: 1\ntitle: "Hallo"\nslug: "hallo"\n';
  publish.mockClear();

  const res = await del('entries/posts/hello');

  expect(res.status).toBe(200);
  const [written] = (publish.mock.calls[0] ?? []) as unknown as [PublishFile[]];
  const rules = written.find((f) => f.path === 'src/content/redirects.yaml')?.contents ?? '';
  expect(rules).toContain('from: "/blog/hello"\n    to: "/blog"');
  expect(rules).toContain('from: "/de/blog/hallo"\n    to: "/de/blog"');
});

// The same question hide asks, and the same answer shape.
test('deleting sends each language to the page the dialog picked', async () => {
  state.locales = ['en', 'de'];
  files['src/content/posts/en/hello.yaml'] = '_version: 1\ntitle: "Hello"\nslug: "hello-world"\n';
  files['src/content/posts/de/hello.yaml'] = '_version: 1\ntitle: "Hallo"\nslug: "hallo"\n';
  publish.mockClear();

  const res = await del('entries/posts/hello', {
    redirect: { kind: 'entry', value: 'posts/taken' },
  });

  expect(res.status).toBe(200);
  const [written] = (publish.mock.calls[0] ?? []) as unknown as [PublishFile[]];
  const rules = written.find((f) => f.path === 'src/content/redirects.yaml')?.contents ?? '';
  expect(rules).toContain('from: "/blog/hello-world"\n    to: "/blog/taken"');
  expect(rules).toContain('from: "/de/blog/hallo"\n    to: "/de/blog/belegt"');
});

// "Nowhere" is an answer: the page is gone and its old links are honestly 404s.
test('deleting with "nowhere" removes the files and writes no rule', async () => {
  publish.mockClear();

  const res = await del('entries/listings/mill-house', { redirect: { kind: 'none' } });

  expect(res.status).toBe(200);
  const [written] = (publish.mock.calls[0] ?? []) as unknown as [PublishFile[]];
  expect(written.map((f) => f.path)).toEqual(['src/content/listings/en/mill-house.yaml']);
});

test('deleting an entry that was never published makes no commit', async () => {
  publish.mockClear();
  discardDraft.mockClear();
  const res = await del('entries/listings/strandhaus-nord');
  expect(res.status).toBe(200);
  expect(publish).not.toHaveBeenCalled();
  expect(discardDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    'src/content/listings/en/strandhaus-nord.yaml',
  );
});

// A language drafted from English and never published has a row and no file.
test('deleting discards the draft of a language that has no file', async () => {
  state.locales = ['en', 'de'];
  discardDraft.mockClear();
  rows['src/content/listings/de/mill-house.yaml'] = {
    contents: 'title: "Die Muehle"\n',
    baseSha: 'head789',
    baseBlob: '',
  };

  const res = await del('entries/listings/mill-house', { redirect: { kind: 'none' } });

  expect(res.status).toBe(200);
  expect(discardDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    'src/content/listings/de/mill-house.yaml',
    '',
  );
});

const alignedHome = () => {
  state.locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en;
  files['src/content/pages/de/home.yaml'] = home.de
    .replace('  - _type: "quote"\n    _id: "z9y8x7w6"\n    body: "Ein seltener Fund."\n', '')
    .replace('title: "Startseite"', 'title: "Home"');
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

// Side by side: the second language is drawn from the same response.
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
    {
      form: expect.anything(),
      locale: 'de',
      siblings: {},
      translation: true,
      source: {
        locale: 'en',
        contents: home.en,
        blob_sha: 'blob-src/content/pages/en/home.yaml',
      },
    },
    undefined,
    'opened',
  );
});

test('a structural source save passes scoped locale restoration beside filtered entry data', async () => {
  alignedHome();
  saveDraft.mockClear();
  saveDraft.mockImplementationOnce(async () => ({
    updated_at: 1755864000000,
    pending: true,
    revision: 'next-en',
    revisions: { en: 'next-en', de: 'next-de' },
  }));
  const data = {
    title: 'Home',
    _machine: ['blocks[_id=z9y8x7w6].body'],
    blocks: [
      { _type: 'hero', _id: 'k3nf9a2p', heading: 'Move to the coast' },
      { _type: 'quote', _id: 'z9y8x7w6', body: 'A rare find.' },
    ],
  };
  const seed = {
    address: 'blocks[_id=z9y8x7w6]',
    value: {
      _type: 'quote',
      _id: 'z9y8x7w6',
      body: 'Ein seltener Fund.',
      legacyTheme: 'paper',
    },
    machine: ['blocks[_id=z9y8x7w6].body'],
  };

  const res = await PUT(
    put(
      'drafts/pages/home',
      JSON.stringify({
        data,
        structure: {
          containers: ['blocks'],
          revisions: { en: 'opened', de: 'legacy' },
          seeds: { de: [seed] },
        },
      }),
    ),
  );

  expect(res.status).toBe(200);
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/en/home.yaml',
    { title: 'Home', blocks: data.blocks },
    {
      form: expect.anything(),
      locale: 'en',
      siblings: { de: 'src/content/pages/de/home.yaml' },
      translation: false,
      restoration: {
        revisions: { en: 'opened', de: 'legacy' },
        seeds: { de: [seed] },
      },
    },
    undefined,
    'opened',
  );
  expect(await res.json()).toEqual({
    updated_at: 1755864000000,
    pending: true,
    revision: 'next-en',
    revisions: { en: 'next-en', de: 'next-de' },
    problems: [],
  });
});

test('a restoration seed outside the affected container is refused', async () => {
  alignedHome();
  saveDraft.mockClear();
  const data = {
    title: 'Home',
    blocks: [
      { _type: 'hero', _id: 'k3nf9a2p', heading: 'Move to the coast' },
      { _type: 'quote', _id: 'z9y8x7w6', body: 'A rare find.' },
    ],
  };

  const res = await PUT(
    put(
      'drafts/pages/home',
      JSON.stringify({
        data,
        structure: {
          containers: ['blocks'],
          revisions: { en: 'opened', de: 'legacy' },
          seeds: {
            de: [
              {
                address: 'blocks[_id=z9y8x7w6]',
                value: { _type: 'quote', _id: 'z9y8x7w6', body: 'Ein seltener Fund.' },
                machine: ['blocks[_id=k3nf9a2p].heading'],
              },
            ],
          },
        },
      }),
    ),
  );

  expect(res.status).toBe(400);
  expect(saveDraft).not.toHaveBeenCalled();
});

test('entry metadata cannot be smuggled through a structural restoration seed', async () => {
  alignedHome();
  saveDraft.mockClear();
  const data = {
    title: 'Home',
    blocks: [
      { _type: 'hero', _id: 'k3nf9a2p', heading: 'Move to the coast' },
      { _type: 'quote', _id: 'z9y8x7w6', body: 'A rare find.' },
    ],
  };

  const res = await PUT(
    put(
      'drafts/pages/home',
      JSON.stringify({
        data,
        structure: {
          containers: ['blocks'],
          revisions: { en: 'opened', de: 'legacy' },
          seeds: {
            de: [
              {
                address: 'blocks[_id=z9y8x7w6]',
                value: {
                  _type: 'quote',
                  _id: 'z9y8x7w6',
                  _machine: ['blocks[_id=z9y8x7w6].body'],
                  body: 'Ein seltener Fund.',
                },
              },
            ],
          },
        },
      }),
    ),
  );

  expect(res.status).toBe(400);
  expect(saveDraft).not.toHaveBeenCalled();
});

test('a structural save keeps the draft revision refusal contract', async () => {
  alignedHome();
  saveDraft.mockClear();
  saveDraft.mockImplementationOnce(async () => {
    throw new DraftRevisionError();
  });
  const res = await PUT(
    put(
      'drafts/pages/home',
      JSON.stringify({
        data: { title: 'Home', blocks: [] },
        structure: {
          containers: ['blocks'],
          revisions: { en: 'opened', de: 'stale' },
          seeds: {},
        },
      }),
    ),
  );

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: new DraftRevisionError().message,
    reason: 'revision',
  });
});

test('a structural save is refused by the existing drift gate', async () => {
  drifted();
  saveDraft.mockClear();

  const res = await PUT(
    put(
      'drafts/pages/home',
      JSON.stringify({
        data: { title: 'Home', blocks: [] },
        structure: {
          containers: ['blocks'],
          revisions: { en: 'opened', de: 'legacy' },
          seeds: {},
        },
      }),
    ),
  );

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error:
      "This entry's languages disagree about which blocks it has. Reconcile them before editing.",
    reason: 'drift',
  });
  expect(saveDraft).not.toHaveBeenCalled();
});

test('a source save rechecks drift and refuses to persist over an unresolved structure', async () => {
  drifted();
  saveDraft.mockClear();

  const res = await PUT(
    put('drafts/pages/home', JSON.stringify({ data: { title: 'Home changed' } })),
  );

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error:
      "This entry's languages disagree about which blocks it has. Reconcile them before editing.",
    reason: 'drift',
  });
  expect(saveDraft).not.toHaveBeenCalled();
});

test('an intentional locale-only row does not block a source save', async () => {
  drifted();
  files['src/content/pages/de/home.yaml'] = home.de.replace(
    '    body: "Ein seltener Fund."',
    '    _locales:\n      - "de"\n    body: "Ein seltener Fund."',
  );
  saveDraft.mockClear();

  const res = await PUT(
    put('drafts/pages/home', JSON.stringify({ data: { title: 'Home changed' } })),
  );

  expect(res.status).toBe(200);
  expect(saveDraft).toHaveBeenCalledOnce();
});

test('a single-file entry has no drift gate to block its source save', async () => {
  untranslated();
  saveDraft.mockClear();

  const res = await PUT(
    put('drafts/pages/home', JSON.stringify({ data: { title: 'Home changed' } })),
  );

  expect(res.status).toBe(200);
  expect(saveDraft).toHaveBeenCalledOnce();
});

test('a save to a language the site does not declare is refused', async () => {
  drifted();
  saveDraft.mockClear();

  const res = await PUT(
    put('drafts/pages/home/fr', JSON.stringify({ revision: 'opened', data: { title: 'x' } })),
  );

  expect(res.status).toBe(404);
  expect(saveDraft).not.toHaveBeenCalled();
});

// Staleness: the German file says which English it was translated from.
test('an entry whose translation was made from an older source language says so', async () => {
  state.locales = ['en', 'de'];
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

// Reconciling that drift: the answers are the editor's.
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
    undefined,
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

// Create from English writes a draft in a language the entry's form does not draw.
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
    // Nothing goes, so an unrecorded entry is not frozen.
    undefined,
  );
});

// Turning off a language that has a file is a delete of that one file.
const bilingualPost = () => {
  state.locales = ['en', 'de'];
  files['src/content/posts/en/taken.yaml'] = '_version: 1\ntitle: "Taken"\n';
  files['src/content/posts/de/taken.yaml'] = '_version: 1\ntitle: "Belegt"\nslug: "belegt"\n';
};

// The question a hide and a delete ask, asked here too.
test('turning a language off sends its readers where the answer says', async () => {
  bilingualPost();
  publish.mockClear();

  const res = await POST(
    post(
      'entries/posts/taken/locales',
      JSON.stringify({
        locales: ['en'],
        redirect: { kind: 'entry', value: 'listings/mill-house' },
      }),
    ),
  );

  expect(res.status).toBe(200);
  const [written] = (publish.mock.calls[0] ?? []) as unknown as [PublishFile[]];
  expect(written[2]?.contents).toContain('from: "/de/blog/belegt"\n    to: "/de/listings"');
});

// The one refusal: with no other file left this is a delete of the entry.
test('turning off the last language an entry has a file in is refused', async () => {
  state.locales = ['en', 'de'];
  files['src/content/posts/en/taken.yaml'] = '_version: 1\ntitle: "Taken"\n';
  publish.mockClear();
  setEntryLocales.mockClear();

  const res = await POST(post('entries/posts/taken/locales', JSON.stringify({ locales: ['de'] })));

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    code: 'ENTRY_LOCALE_LAST_FILE',
    error: expect.stringContaining('Delete'),
    locales: ['en'],
  });
  expect(publish).not.toHaveBeenCalled();
  expect(setEntryLocales).not.toHaveBeenCalled();
});

// A draft is not a file yet: discarding it afterwards would leave the entry with nothing.
test('a language whose only other file is a draft cannot be turned off', async () => {
  untranslated();
  rows['src/content/pages/de/home.yaml'] = {
    contents: home.en.replace('Home', 'Startseite'),
    baseSha: 'head789',
    baseBlob: '',
  };
  publish.mockClear();
  setEntryLocales.mockClear();

  const res = await POST(post('entries/pages/home/locales', JSON.stringify({ locales: ['de'] })));

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    code: 'ENTRY_LOCALE_LAST_PUBLISHED',
    error: expect.stringContaining('publish de first'),
    locales: ['en'],
    remaining: ['de'],
  });
  expect(publish).not.toHaveBeenCalled();
  expect(setEntryLocales).not.toHaveBeenCalled();
});

// A collection nothing renders has nowhere to send anybody.
test('a collection with no index writes no redirect for the language that went', async () => {
  drifted();
  publish.mockClear();

  const res = await POST(post('entries/pages/home/locales', JSON.stringify({ locales: ['en'] })));

  expect(res.status).toBe(200);
  const [written] = (publish.mock.calls[0] ?? []) as unknown as [PublishFile[]];
  expect(written.map((f) => f.path)).toEqual([
    'src/content/pages/de/home.yaml',
    'src/content/pages/en/home.yaml',
  ]);
});

// Nothing of that language is in the repository.
test('turning off a language whose file is only a draft commits nothing', async () => {
  untranslated();
  rows['src/content/pages/de/home.yaml'] = {
    contents: home.en.replace('Home', 'Startseite'),
    baseSha: 'head789',
    baseBlob: '',
  };
  publish.mockClear();
  discardDraft.mockClear();
  setEntryLocales.mockClear();

  const res = await POST(post('entries/pages/home/locales', JSON.stringify({ locales: ['en'] })));

  expect(res.status).toBe(200);
  expect(publish).not.toHaveBeenCalled();
  expect(discardDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    'src/content/pages/de/home.yaml',
  );
  expect(setEntryLocales).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    ['src/content/pages/en/home.yaml'],
    ['en'],
    ['en', 'de'],
    'en',
  );
});

// A top-level `_locales` is written into every file the entry has.
test('a _locales the files contradict is reported, and the file wins', async () => {
  state.locales = ['en', 'de'];
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

test('an entry says which languages it is offered in', async () => {
  state.locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en.replace(
    '_version: 1',
    '_version: 1\n_locales:\n  - "en"',
  );

  const body = (await (await GET(ctx('entries/pages/home'))).json()) as { offered: unknown };

  expect(body.offered).toEqual(['en']);
});

test('an entry says whether there is anything to translate with', async () => {
  machine();
  expect(
    ((await (await GET(ctx('entries/pages/home'))).json()) as { translator: unknown }).translator,
  ).toBe(true);
  state.translator = undefined;
  expect(
    ((await (await GET(ctx('entries/pages/home'))).json()) as { translator: unknown }).translator,
  ).toBe(false);
});

// A collection with an address per language.
const hide = (body: Record<string, unknown>) =>
  POST(post('status/posts', JSON.stringify({ entries: ['hello'], hidden: true, ...body })));
const written = () => {
  const files = (setEntryStatus.mock.calls[0]?.[4] ?? []) as {
    path: string;
    redirect?: { from: string; to: string };
  }[];
  return files
    .filter((f) => f.redirect)
    .map((f) => [f.path.split('/')[3], f.redirect?.from, f.redirect?.to]);
};

test('hiding an entry sends each language to the overview under its own segment', async () => {
  addressed();

  expect((await hide({ redirect: { kind: 'index' } })).status).toBe(200);
  expect(setEntryStatus.mock.calls[0]?.[5]).toBe(true);
  expect(written()).toEqual([
    ['en', '/blog/hello-world', '/blog'],
    ['de', '/de/blog/hallo', '/de/blog'],
  ]);
});

// Redirects use the picked entry's address in the current language.
test('a picked page is the address that language serves it at', async () => {
  addressed();

  await hide({ redirect: { kind: 'entry', value: 'posts/taken' } });

  expect(written()).toEqual([
    ['en', '/blog/hello-world', '/blog/taken'],
    ['de', '/de/blog/hallo', '/de/blog/belegt'],
  ]);
});

// Missing translations redirect to the target collection's localized index.
test('a picked page with no half in a language falls back to that collection overview', async () => {
  addressed();

  await hide({ redirect: { kind: 'entry', value: 'listings/mill-house' } });

  expect(written()).toEqual([
    ['en', '/blog/hello-world', '/listings/mill-house'],
    ['de', '/de/blog/hallo', '/de/listings'],
  ]);
});

test('a typed web address is the one answer for every language', async () => {
  addressed();

  await hide({ redirect: { kind: 'url', value: 'https://example.com/gone' } });

  expect(written()).toEqual([
    ['en', '/blog/hello-world', 'https://example.com/gone'],
    ['de', '/de/blog/hallo', 'https://example.com/gone'],
  ]);
});

test('"nowhere" hides the entry and writes no rule at all', async () => {
  addressed();

  await hide({ redirect: { kind: 'none' } });

  expect(written()).toEqual([]);
  expect(setEntryStatus.mock.calls[0]?.[5]).toBe(true);
});

// A language whose file is only a draft has never been served.
test('a language with no file in the repository owes no redirect', async () => {
  state.locales = ['en', 'de'];
  files['src/content/posts/en/hello.yaml'] = '_version: 1\ntitle: "Hello"\nslug: "hello-world"\n';

  await hide({ redirect: { kind: 'index' } });

  expect(written()).toEqual([['en', '/blog/hello-world', '/blog']]);
});

test('showing an entry again writes the files and no rules', async () => {
  addressed();

  const res = await POST(
    post('status/posts', JSON.stringify({ entries: ['hello'], hidden: false })),
  );

  expect(res.status).toBe(200);
  expect(setEntryStatus.mock.calls[0]?.[5]).toBe(false);
  expect(written()).toEqual([]);
});

// Bulk hide asks the question once and applies that answer to every entry in the batch.
test('one answer covers every entry in a bulk hide', async () => {
  addressed();
  files['src/content/posts/en/taken.yaml'] = '_version: 1\ntitle: "Taken"\n';

  await POST(
    post(
      'status/posts',
      JSON.stringify({ entries: ['hello', 'taken'], hidden: true, redirect: { kind: 'index' } }),
    ),
  );

  expect(setEntryStatus).toHaveBeenCalledTimes(2);
  expect(
    setEntryStatus.mock.calls.map((call) =>
      (call[4] as { path: string; redirect?: { from: string } }[])
        .filter((f) => f.redirect)
        .map((f) => f.redirect?.from),
    ),
  ).toEqual([['/blog/hello-world', '/de/blog/hallo'], ['/blog/taken']]);
});

test('a collection the site does not declare has no status route', async () => {
  expect((await POST(post('status/nope', '{"entries":["x"],"hidden":true}'))).status).toBe(404);
});

test('the address is not a field of the form and comes beside it instead', async () => {
  addressed();

  const body = (await (await GET(ctx('entries/posts/hello'))).json()) as {
    fields: { path: string[] }[];
    addresses: Record<string, string>;
    localizedSlugs: boolean;
    route: string;
  };

  expect(body.fields.map((f) => f.path[0])).toEqual(['title', 'seo']);
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

test('an address that is not one is refused with the reason', async () => {
  addressed();

  const res = await POST(
    post('entries/posts/hello/address/de', JSON.stringify({ address: 'Hallo Welt' })),
  );

  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    code: 'ENTRY_ADDRESS_INVALID',
    error: expect.stringMatching(/lowercase letters, digits and single dashes/),
  });
});

test('an address another entry in that language already serves is refused', async () => {
  addressed();

  // `belegt` is another entry's address in German.
  for (const address of ['belegt', 'taken']) {
    const res = await POST(post('entries/posts/hello/address/de', JSON.stringify({ address })));
    expect([address, res.status]).toEqual([address, 409]);
    expect(await res.json()).toEqual({
      code: 'ENTRY_ADDRESS_TAKEN',
      error: expect.any(String),
      address,
      collection: 'posts',
      locale: 'de',
    });
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
    ctx(
      'entries/posts/hello/address/de',
      new Request('https://x/admin/api/entries/posts/hello/address/de', {
        method: 'POST',
        body: JSON.stringify({ address: 'servus' }),
      }),
      { handover: owner },
    ),
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
    // Who moved it, for the dashboard's *last edited by*.
    'u1',
  );
});

test('an entry with no file in the repository yet owes nothing', async () => {
  state.locales = ['en', 'de'];
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
    undefined,
  );
});

test('a collection without localized slugs has no address to set', async () => {
  const res = await POST(
    post('entries/listings/mill-house/address/en', JSON.stringify({ address: 'mill' })),
  );

  expect(res.status).toBe(404);
});

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
    undefined,
    'opened',
  );
});

const beat = (path: string, session?: unknown) =>
  POST(
    ctx(path, new Request(`https://x/admin/api/${path}`, { method: 'POST' }), {
      handover: session,
    }),
  );

test('a beat on an entry nobody is editing takes it', async () => {
  rows['src/content/listings/en/mill-house.yaml'] = {
    contents: 'title: The Mill House\n',
    baseSha: 'head789',
    baseBlob: 'abc123',
  };

  const res = await beat('locks/listings/mill-house', editor);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    held_by: null,
    mine: true,
    expires_at: 1755864120000,
  });
});

test('a beat on an entry somebody else is editing names them and takes nothing', async () => {
  state.holder = { userId: 'u1', name: 'Anna Berg', expiresAt: 1755864060000 };

  const res = await beat('locks/listings/mill-house', editor);

  expect(await res.json()).toMatchObject({
    held_by: { id: 'u1', name: 'Anna Berg' },
    mine: false,
    expires_at: 1755864060000,
  });
});

// The read the second editor polls on.
test('reading the lock never claims it', async () => {
  const res = await GET(ctx('locks/listings/mill-house', undefined, { handover: editor }));

  expect(await res.json()).toMatchObject({ held_by: null, mine: false, expires_at: null });
  expect(beats).toEqual([]);
});

test('a collection nothing declares has no lock to take', async () => {
  const res = await beat('locks/nothing/mill-house', editor);

  expect(res.status).toBe(404);
});

// Take over is what makes the lock safe to lose.
test('an autosave from somebody who does not hold the lock is refused, naming who has it', async () => {
  state.holder = { userId: 'u1', name: 'Anna Berg', expiresAt: 1755864060000 };
  saveDraft.mockClear();

  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  const res = await PUT(
    ctx(
      'drafts/listings/mill-house',
      new Request('https://x/admin/api/drafts', {
        method: 'PUT',
        body: JSON.stringify({ revision: 'opened', data }),
      }),
      { handover: editor },
    ),
  );

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    held_by: { id: 'u1', name: 'Anna Berg' },
    mine: false,
    expires_at: 1755864060000,
  });
  expect(saveDraft).not.toHaveBeenCalled();
});

test('the holder of the lock saves as they always did', async () => {
  state.holder = { userId: 'u2', name: 'Anna', expiresAt: 1755864060000 };

  const res = await PUT(
    ctx(
      'drafts/listings/mill-house',
      new Request('https://x/admin/api/drafts', {
        method: 'PUT',
        body: JSON.stringify({
          revision: 'opened',
          data: { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } },
        }),
      }),
      { handover: editor },
    ),
  );

  expect(res.status).toBe(200);
});

test('Take over transfers the entry and says so in the log', async () => {
  state.holder = { userId: 'u1', name: 'Anna Berg', expiresAt: 1755864060000 };

  const res = await POST(
    ctx(
      'locks/listings/mill-house',
      new Request('https://x/admin/api/locks', {
        method: 'POST',
        body: JSON.stringify({ take: true }),
      }),
      { handover: editor },
    ),
  );

  expect(await res.json()).toMatchObject({ held_by: null, mine: true, expires_at: 1755864120000 });
  expect(taken).toEqual(['listings/mill-house']);
  expect(logged).toEqual([
    {
      userId: 'u2',
      kind: 'lock-takeover',
      subject: 'src/content/listings/en/mill-house.yaml',
      detail: { from: 'Anna Berg' },
    },
  ]);
});

test('a beat is not a take-over, whatever else the body carries', async () => {
  state.holder = { userId: 'u1', name: 'Anna Berg', expiresAt: 1755864060000 };

  const res = await POST(
    ctx(
      'locks/listings/mill-house',
      new Request('https://x/admin/api/locks', {
        method: 'POST',
        body: JSON.stringify({ take: false }),
      }),
      { handover: editor },
    ),
  );

  expect(await res.json()).toMatchObject({ mine: false });
  expect(taken).toEqual([]);
  expect(logged).toEqual([]);
});

// The lock is the tab's: the same person opening the entry twice is told so in the second tab.
test('a second tab of the same person is refused and the first tab keeps saving', async () => {
  state.holder = { userId: 'u2', name: 'Anna', expiresAt: 1755864060000, tab: 'tab-1' };
  const save = (tab: string) =>
    PUT(
      ctx(
        'drafts/listings/mill-house',
        new Request('https://x/admin/api/drafts', {
          method: 'PUT',
          body: JSON.stringify({
            revision: 'opened',
            data: { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } },
            tab,
          }),
        }),
        { handover: editor },
      ),
    );

  const second = await POST(
    ctx(
      'locks/listings/mill-house',
      new Request('https://x/admin/api/locks', {
        method: 'POST',
        body: JSON.stringify({ tab: 'tab-2' }),
      }),
      { handover: editor },
    ),
  );
  expect(await second.json()).toMatchObject({ held_by: { id: 'u2', name: 'Anna' }, mine: false });

  expect((await save('tab-2')).status).toBe(409);
  expect((await save('tab-1')).status).toBe(200);
});

// The rest of what writes to an entry's files waits on the lock the way Rename and Delete do.
test('hiding waits for the editor who has the entry open', async () => {
  setEntryStatus.mockClear();
  state.holder = { userId: 'someone-else', name: 'Anna Berg', expiresAt: 1755864120000 };

  const res = await POST(
    post('status/listings', JSON.stringify({ entries: ['mill-house'], hidden: true })),
  );

  expect(res.status).toBe(409);
  expect(await res.text()).toBe(
    'Anna Berg is editing this entry — it can be hidden once they are done',
  );
  expect(setEntryStatus).not.toHaveBeenCalled();
});

test('a hold is written to every language the entry could have', async () => {
  state.locales = ['en', 'de'];

  const res = await POST(
    ctx(
      'hold/listings/mill-house',
      new Request('https://x/admin/api/hold', {
        method: 'POST',
        body: JSON.stringify({ hold: true }),
      }),
      { handover: editor },
    ),
  );

  expect(await res.json()).toEqual({ held: true });
  expect(holdEntry).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    ['src/content/listings/en/mill-house.yaml', 'src/content/listings/de/mill-house.yaml'],
    'u2',
  );
  expect(logged).toEqual([]);
});

// Only the way off is an event: a hold is a promise to somebody else.
test('taking a hold off clears the column and is logged', async () => {
  const res = await POST(
    ctx(
      'hold/listings/mill-house',
      new Request('https://x/admin/api/hold', {
        method: 'POST',
        body: JSON.stringify({ hold: false }),
      }),
      { handover: editor },
    ),
  );

  expect(await res.json()).toEqual({ held: false });
  expect(holdEntry).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    ['src/content/listings/en/mill-house.yaml'],
    null,
  );
  expect(logged).toEqual([
    {
      userId: 'u2',
      kind: 'hold-released',
      subject: 'src/content/listings/en/mill-house.yaml',
      detail: null,
    },
  ]);
});

// The row the Deleted view and the activity log are both built on.
test('turning a language off is a row in the log naming the languages that went', async () => {
  bilingualPost();

  await POST(post('entries/posts/taken/locales', JSON.stringify({ locales: ['en'] })));

  expect(logged.at(-1)).toMatchObject({
    kind: 'locale-off',
    subject: 'src/content/posts/en/taken.yaml',
    detail: { locales: ['de'] },
    commitSha: 'def456',
  });
});

// The same set the entry list draws, so the two screens never disagree about what exists.
test('the deleted list says which rows cannot be put back over what is there now', async () => {
  deletedEntries.mockImplementationOnce(async () => [
    {
      id: 'a2',
      at: 2,
      kind: 'locale-off',
      subject: 'src/content/listings/en/harbour-flat.yaml',
      detail: { locales: ['de'] },
      commitSha: 'off222',
      user: null,
    },
    {
      id: 'a1',
      at: 1,
      kind: 'entry-delete',
      subject: 'src/content/listings/en/mill-house.yaml',
      detail: { locales: ['en'] },
      commitSha: 'del111',
      user: { id: 'u1', name: 'Martin', email: 'm@x' },
    },
  ]);

  const body = (await (await GET(ctx('deleted/listings'))).json()) as {
    deleted: Record<string, unknown>[];
  };

  expect(body.deleted[0]).toEqual({
    id: 'a2',
    at: 2,
    by: null,
    slug: 'harbour-flat',
    locales: ['de'],
    whole: false,
    commit_sha: 'off222',
  });
  // `mill-house` is in the index and no row says it has gone.
  expect(body.deleted[1]).toMatchObject({
    slug: 'mill-house',
    by: 'Martin',
    whole: true,
    blocked:
      'There is a file at src/content/listings/en/mill-house.yaml again, so this cannot be put back over it.',
  });
});

test('the deleted list is not offered for a collection the site does not declare', async () => {
  expect((await GET(ctx('deleted/nothing'))).status).toBe(404);
});

test('lock reads, renewals and takeovers omit bases and do not read draft rows', async () => {
  vi.mocked(loadDraft).mockClear();
  const responses = [
    await GET(ctx('locks/listings/mill-house', undefined, { handover: editor })),
    await beat('locks/listings/mill-house', editor),
    await POST(post('locks/listings/mill-house', JSON.stringify({ take: true }), editor)),
  ];
  for (const res of responses) {
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object).sort()).toEqual([
      'expires_at',
      'held_by',
      'mine',
    ]);
  }
  expect(loadDraft).not.toHaveBeenCalled();
});
