import { texts } from 'virtual:handover/index';
import {
  claimResource,
  DraftRevisionError,
  loadDraft,
  type PublishFile,
  RepoUnreachableError,
  ResourceLimitError,
  releaseResource,
} from '@handover/core';
import { afterEach, expect, test, vi } from 'vitest';
import { DELETE, GET, POST, PUT } from '../api.js';
import {
  beats,
  createDraft,
  ctx,
  deletedEntries,
  discardDraft,
  dropped,
  editor,
  files,
  getFile,
  heldDrafts,
  holdEntry,
  home,
  logged,
  moved,
  overlayRows,
  owner,
  pendingDrafts,
  post,
  publish,
  put,
  recordDelete,
  recordRenames,
  resetContainers,
  resetMocks,
  resetState,
  resolveDrift,
  rows,
  saveDraft,
  savedTemplates,
  saveTranslated,
  setEntryAddress,
  setEntryLocales,
  setEntryStatus,
  state,
  stored,
  taken,
  translate,
} from './harness.js';

const { workerMailerMock, configMock, indexMock, cloudflareMock, authMock, coreMock } =
  await vi.hoisted(async () => import('./harness.js'));

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

// The whole point of the section: the key the client pasted is the one that translates.
test('the key stored here is the one DeepL is called with, over the one on the Worker', async () => {
  machine();
  state.translator = undefined;
  state.deeplKey = 'env-key';
  stored.deepl = { value: 'fx-client-key', hint: '-key', updatedAt: 1, updatedBy: 'u1' };
  const calls: { init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ init });
      const sent = JSON.parse(String(init.body)) as { text: string[] };
      return Response.json({ translations: sent.text.map((t) => ({ text: `[de] ${t}` })) });
    }),
  );

  expect((await POST(post('translate/pages/home/de', ''))).status).toBe(200);
  const headers = calls[0]?.init.headers as Record<string, string> | undefined;
  expect(headers?.authorization).toBe('DeepL-Auth-Key fx-client-key');
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
  expect(body.fields).toEqual([
    { path: ['footerText'], label: 'Footer text', type: 'text', required: true },
    { path: ['phone'], label: 'Phone', type: 'text', required: false, i18n: 'duplicate' },
    // The site's SEO defaults are an ordinary group.
    {
      path: ['defaultSeo'],
      label: 'Search and sharing',
      labels: { en: 'Search and sharing', de: 'Suche und Teilen' },
      type: 'group',
      required: false,
      fields: [
        {
          path: ['titlePattern'],
          label: 'Default search title',
          labels: { en: 'Default search title', de: 'Standard-Suchtitel' },
          type: 'text',
          required: false,
        },
        { path: ['description'], label: 'Description', type: 'text', required: false },
        {
          path: ['image'],
          label: 'Default social image',
          labels: { en: 'Default social image', de: 'Standard-Social-Media-Bild' },
          type: 'image',
          required: false,
          preset: { ratio: '1.91:1', max: 1200, min: 1200 },
        },
        {
          path: ['twitter'],
          label: 'X (Twitter) handle',
          labels: { en: 'X (Twitter) handle', de: 'X-(Twitter-)Name' },
          type: 'text',
          required: false,
          i18n: 'duplicate',
        },
      ],
    },
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

// The site settings list: the cards, in cms.config.ts order.
test('the globals list names each global and the languages it has a file in', async () => {
  state.locales = ['en', 'de'];
  pendingDrafts.mockImplementationOnce(async () => []);

  const res = await GET(ctx('globals'));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    globals: [
      {
        key: 'site',
        label: 'Site details',
        labels: { en: 'Site details', de: 'Website-Angaben' },
        description: 'Contact details and footer text',
        locales: ['en'],
        pending: false,
        edited: null,
      },
    ],
    locales: ['en', 'de'],
  });
  state.locales = ['en'];
});

test('a global with a draft ahead of the repository carries the pending dot', async () => {
  state.locales = ['en', 'de'];
  const row = {
    path: 'src/content/globals/de/site.yaml',
    contents: 'footerText: "Küstenhäuser"\n',
    updatedAt: 1755864000000,
  };
  overlayRows.mockImplementationOnce(async () => [row]);
  pendingDrafts.mockImplementationOnce(async () => [row]);

  const res = await GET(ctx('globals'));

  const { globals } = (await res.json()) as {
    globals: { locales: string[]; pending: boolean }[];
  };
  const [global] = globals;
  expect(global?.pending).toBe(true);
  // The German file is a draft and has never been committed, and the card counts it all the same.
  expect(global?.locales).toEqual(['en', 'de']);
  state.locales = ['en'];
});

test('a global somebody has open says who', async () => {
  state.holders = { 'globals/site': { id: 'u2', name: 'Anna Berg' } };

  const res = await GET(ctx('globals'));

  const { globals } = (await res.json()) as { globals: { editing?: unknown }[] };
  expect(globals[0]?.editing).toEqual({ id: 'u2', name: 'Anna Berg' });
  state.holders = {};
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
    undefined,
    'opened',
  );
});

// Who typed it, which is what the dashboard's rows and the Site settings cards report.
test('an autosave carries the id of whoever typed it', async () => {
  saveDraft.mockClear();
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  await PUT(
    ctx(
      'drafts/listings/mill-house',
      new Request('https://x/admin/api/drafts/listings/mill-house', {
        method: 'PUT',
        body: JSON.stringify({ revision: 'opened', data }),
      }),
      { handover: owner },
    ),
  );

  expect((saveDraft.mock.calls[0] as unknown[])?.[6]).toBe('u1');
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
      { path: 'rooms', message: 'Required', descriptor: { code: 'FIELD_REQUIRED' } },
      { path: 'address', message: 'Required', descriptor: { code: 'FIELD_REQUIRED' } },
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
    undefined,
    'opened',
  );
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

// The `_` keys belong to the file: the server reads them off the entry.
test('reserved keys in the posted data are dropped before the draft is stored', async () => {
  saveDraft.mockClear();
  const data = { title: 'The Mill', rooms: 3, address: { street: 'Mill Lane' } };
  await PUT(
    put(
      'drafts/listings/mill-house',
      JSON.stringify({ revision: 'opened', data: { ...data, _status: 'hidden' } }),
    ),
  );
  expect(saveDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/listings/en/mill-house.yaml',
    data,
    // A site that declares one language has no other file to keep in step.
    undefined,
    undefined,
    'opened',
  );
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

test('the pending list is what the drafts hold that the repository does not', async () => {
  const res = await GET(ctx('drafts'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    defaultLocale: 'en',
    entries: [
      {
        key: 'listings/mill-house',
        title: 'The Mill House',
        collection: 'listings',
        locales: ['en'],
        files: ['src/content/listings/en/mill-house.yaml'],
        updated_at: 1755864000000,
        held_by: null,
      },
    ],
  });
});

// The landing page.
test('the dashboard lists what was edited and what was published, newest first', async () => {
  state.publishes = [{ entry: 'posts/hello', at: 1755950000000, by: 'Martin Conde' }];
  state.editors = { 'src/content/listings/en/mill-house.yaml': 'Anna Berg' };

  const res = await GET(ctx('dashboard'));

  expect(res.status).toBe(200);
  const { recent } = (await res.json()) as { recent: Record<string, unknown>[] };
  expect(recent).toEqual([
    {
      key: 'posts/hello',
      title: 'Hello',
      collection: 'posts',
      href: '/admin/c/posts/hello',
      at: 1755950000000,
      by: 'Martin Conde',
      kind: 'publish',
    },
    {
      key: 'listings/mill-house',
      title: 'The Mill House',
      collection: 'listings',
      href: '/admin/c/listings/mill-house',
      at: 1755864000000,
      // Who typed it, which is not who published it: the two rows carry different verbs.
      by: 'Anna Berg',
      kind: 'edit',
    },
  ]);
});

// The draft is what the client is looking at; the publish it was last in is behind it.
test('an entry with unpublished changes is described by the edit and not by the publish', async () => {
  state.publishes = [{ entry: 'listings/mill-house', at: 1755950000000, by: 'Martin Conde' }];
  state.holders = { 'listings/mill-house': { id: 'u2', name: 'Anna Berg' } };

  const { recent } = (await (await GET(ctx('dashboard'))).json()) as {
    recent: Record<string, unknown>[];
  };

  expect(recent).toEqual([
    expect.objectContaining({
      key: 'listings/mill-house',
      at: 1755864000000,
      kind: 'edit',
      editing: { id: 'u2', name: 'Anna Berg' },
    }),
  ]);
  state.holders = {};
});

// A global is edited at its own address, not under /admin/c/.
test('a global on the dashboard is named and addressed the way Site settings names it', async () => {
  pendingDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/globals/en/site.yaml',
      contents: 'footerText: "Coastal homes since 2009"\n',
      updatedAt: 1755864000000,
    },
  ]);

  const { recent } = (await (await GET(ctx('dashboard'))).json()) as {
    recent: Record<string, unknown>[];
  };

  expect(recent[0]).toMatchObject({
    title: 'Site details',
    labels: { en: 'Site details', de: 'Website-Angaben' },
    href: '/admin/site/site',
  });
});

test('translation health counts the languages an entry owes and the ones behind their source', async () => {
  state.locales = ['en', 'de'];

  const { translations } = (await (await GET(ctx('dashboard'))).json()) as {
    translations: { defaultLocale: string; locales: { locale: string }[] };
  };

  expect(translations).toEqual({
    defaultLocale: 'en',
    locales: [
      { locale: 'en', missing: 0, stale: 0, unfinished: 0, machine: 0, where: [] },
      // Everything the index holds but `posts/taken`, which is the one entry with two files.
      {
        locale: 'de',
        missing: 5,
        stale: 1,
        unfinished: 0,
        machine: 0,
        where: ['listings', 'presenters', 'posts'],
      },
    ],
  });
  state.locales = ['en'];
});

// The build's inventories with the drafts over them; a global counts though it has no list.
test('translation health counts unfinished and machine-written languages, drafts and globals included', async () => {
  state.locales = ['en', 'de'];
  Object.assign(texts, {
    'posts/taken': { en: { paths: ['title', 'seo.title'] }, de: { paths: ['title'] } },
    'globals/site': { en: { paths: ['footerText'] } },
  });
  overlayRows.mockImplementationOnce(async () => [
    {
      path: 'src/content/globals/de/site.yaml',
      contents: '_version: 1\n_machine: [footerText]\nfooterText: "Häuser an der Küste"\n',
    },
  ]);

  const { translations } = (await (await GET(ctx('dashboard'))).json()) as {
    translations: { locales: { locale: string }[] };
  };

  expect(translations.locales).toEqual([
    expect.objectContaining({ locale: 'en', unfinished: 0, machine: 0 }),
    expect.objectContaining({ locale: 'de', unfinished: 1, machine: 1 }),
  ]);
});

// Show opens the list filtered to what is owed, and a partly written file is owed.
test('translation health sends Show to a collection whose only debt is a partly written file', async () => {
  state.locales = ['en', 'de'];
  Object.assign(texts, { 'presenters/rosa-hale': { en: { paths: ['name', 'portrait.alt'] } } });
  overlayRows.mockImplementationOnce(async () => [
    {
      path: 'src/content/presenters/de/rosa-hale.yaml',
      contents: '_version: 1\nname: Rosa Hale\n',
    },
  ]);

  const { translations } = (await (await GET(ctx('dashboard'))).json()) as {
    translations: { locales: { locale: string; where: string[] }[] };
  };

  expect(translations.locales[1]).toMatchObject({
    locale: 'de',
    unfinished: 1,
    where: ['listings', 'presenters', 'posts'],
  });
});

test('a one-language site has nothing to report about its languages', async () => {
  const { translations } = (await (await GET(ctx('dashboard'))).json()) as { translations: null };

  expect(translations).toBe(null);
});

test('the build line names who published, and says nothing over a commit that was not one', async () => {
  const line = async () =>
    ((await (await GET(ctx('dashboard'))).json()) as { published: unknown }).published;

  expect(await line()).toEqual({ at: 1755864000000, by: 'Anna Berg' });

  state.lastCommitRow = { sha: 'def456', at: 1755864000000, kind: 'entry-rename', by: 'Anna Berg' };
  expect(await line()).toBe(null);
});

// One entry, one name, on every screen.
test('a global waiting to be published is listed under its label', async () => {
  pendingDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/globals/en/site.yaml',
      contents: 'footerText: "Coastal homes since 2009"\n',
      updatedAt: 1755864000000,
    },
  ]);

  const res = await GET(ctx('drafts'));

  expect(await res.json()).toEqual({
    defaultLocale: 'en',
    entries: [
      {
        key: 'globals/site',
        title: 'Site details',
        labels: { en: 'Site details', de: 'Website-Angaben' },
        collection: 'globals',
        locales: ['en'],
        files: ['src/content/globals/en/site.yaml'],
        updated_at: 1755864000000,
        held_by: null,
      },
    ],
  });
});

// The drawer picks entries, so the grouping is done where the titles are.
test('the pending list is one row per entry, whatever languages of it are waiting', async () => {
  state.locales = ['en', 'de'];
  pendingDrafts.mockImplementationOnce(async () => [
    { path: 'src/content/listings/de/mill-house.yaml', contents: 'x', updatedAt: 1755864000000 },
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: 'y',
      updatedAt: 1755863000000,
      pendingRedirects: [{ from: '/listings/mill', to: '/listings/mill-house' }],
    },
    { path: 'src/content/pages/en/home.yaml', contents: 'z', updatedAt: 1755862000000 },
  ]);
  heldDrafts.mockImplementationOnce(async () => ({
    'pages/home': { id: 'u2', name: 'Martin' },
  }));
  const res = await GET(ctx('drafts'));
  expect(await res.json()).toEqual({
    defaultLocale: 'en',
    entries: [
      {
        key: 'listings/mill-house',
        title: 'The Mill House',
        collection: 'listings',
        // In the order the site declares them, not the order the rows came back in.
        locales: ['en', 'de'],
        files: [
          'src/content/listings/de/mill-house.yaml',
          'src/content/listings/en/mill-house.yaml',
        ],
        // What the address change on one of its rows owes; the file itself is never a row.
        redirects: 1,
        updated_at: 1755864000000,
        held_by: null,
      },
      {
        key: 'pages/home',
        // Nothing in the index and nothing published: the file name is what there is to call it.
        title: 'home',
        collection: 'pages',
        locales: ['en'],
        files: ['src/content/pages/en/home.yaml'],
        updated_at: 1755862000000,
        // The hold is the entry's, so it is read once rather than per file.
        held_by: { id: 'u2', name: 'Martin' },
      },
    ],
  });
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

test('the entry list is the built index with the pending drafts over it', async () => {
  overlayRows.mockImplementationOnce(async () => [
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: 'title: "The Mill House, renamed"\n',
    },
  ]);
  const res = await GET(ctx('entries/listings'));
  expect(res.status).toBe(200);
  const listed = (await res.json()) as { entries: unknown; templates: unknown };
  expect(listed.entries).toEqual([
    {
      id: 'mill-house',
      locales: {
        en: {
          title: 'The Mill House, renamed',
          path: 'src/content/listings/en/mill-house.yaml',
        },
      },
      // Which rows the duplicate dialog can offer "including unpublished changes?" about.
      pending: true,
      // The draft row is the last touch; nobody is signed in on this request, so no name.
      edited: { key: 'listings/mill-house', at: 1755864000000, by: null, kind: 'edit' },
    },
    {
      id: 'seaview-cottage',
      locales: {
        en: {
          title: 'Seaview Cottage',
          path: 'src/content/listings/en/seaview-cottage.yaml',
        },
      },
      edited: null,
    },
  ]);
  // The starters the New entry dialog offers beside Blank, read at build with the index.
  expect(listed.templates).toEqual(['house']);
});

// The list's language filter narrows to the rows a language is missing or stale in.
test('a row names the languages the build marked stale', async () => {
  const { entries } = (await (await GET(ctx('entries/posts'))).json()) as {
    entries: { id: string; stale?: string[] }[];
  };

  expect(entries.map((e) => [e.id, e.stale])).toEqual([
    ['hello', undefined],
    ['taken', ['de']],
  ]);
});

// Stale is the build's and partial is counted now, so one language can be both.
test('a row carries partial and machine languages beside stale, and none of the paths', async () => {
  state.locales = ['en', 'de'];
  Object.assign(texts, {
    'posts/taken': {
      en: { paths: ['title', 'seo.title'] },
      de: { paths: ['title'], machine: true },
    },
  });

  const { entries } = (await (await GET(ctx('entries/posts'))).json()) as {
    entries: Record<string, unknown>[];
  };

  expect(entries.find((e) => e.id === 'taken')).toMatchObject({
    stale: ['de'],
    partial: { de: [1, 2] },
    machine: ['de'],
  });
  expect(JSON.stringify(entries)).not.toContain('seo.title');
});

// The dashboard's line, on every row: the draft's editor where there is a draft.
test('the entry list says who last touched each row, and whether that is out yet', async () => {
  state.publishes = [{ entry: 'listings/seaview-cottage', at: 1755950000000, by: 'Martin Conde' }];
  state.editors = { 'src/content/listings/en/mill-house.yaml': 'Anna Berg' };

  const { entries } = (await (await GET(ctx('entries/listings'))).json()) as {
    entries: { id: string; edited: unknown }[];
  };

  expect(entries.map((e) => [e.id, e.edited])).toEqual([
    [
      'mill-house',
      { key: 'listings/mill-house', at: 1755864000000, by: 'Anna Berg', kind: 'edit' },
    ],
    [
      'seaview-cottage',
      { key: 'listings/seaview-cottage', at: 1755950000000, by: 'Martin Conde', kind: 'publish' },
    ],
  ]);
  state.publishes = [];
  state.editors = {};
});

// The badge on the row: the same answer the members screen gives, seen from the entry's side.
test('the entry list says who is editing a row, and nothing on the rows nobody is in', async () => {
  state.holders = { 'listings/mill-house': { id: 'u2', name: 'Anna Berg' } };

  const res = await GET(ctx('entries/listings'));

  const { entries } = (await res.json()) as { entries: { id: string; editing?: unknown }[] };
  expect(entries.map((e) => [e.id, e.editing])).toEqual([
    ['mill-house', { id: 'u2', name: 'Anna Berg' }],
    ['seaview-cottage', undefined],
  ]);
  state.holders = {};
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
      edited: null,
    },
    {
      id: 'rosa-hale',
      locales: { en: { title: 'Rosa Hale', path: 'src/content/presenters/en/rosa-hale.yaml' } },
      edited: null,
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
    // Only the title: a required field is left absent rather than guessed at.
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

test('the language a new entry is created in is the one it is written in', async () => {
  createDraft.mockClear();
  state.locales = ['en', 'de'];

  const res = await POST(
    post('entries/listings', JSON.stringify({ title: 'Strandhaus', locale: 'de' })),
  );

  expect(res.status).toBe(200);
  expect(createDraft).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/listings/de/strandhaus.yaml',
    { _version: 1, _source: 'de', title: 'Strandhaus' },
  );
});

test('a template creates its entry in the chosen language and records it there', async () => {
  createDraft.mockClear();
  state.locales = ['en', 'de'];

  await POST(
    post(
      'entries/pages',
      JSON.stringify({ title: 'Nach Devon', template: 'landing', locale: 'de' }),
    ),
  );

  const [, , , path, values] = createDraft.mock.calls[0] as [
    string,
    unknown,
    unknown,
    string,
    Record<string, unknown>,
  ];
  expect(path).toBe('src/content/pages/de/nach-devon.yaml');
  expect(values._source).toBe('de');
  expect(values.title).toBe('Nach Devon');
});

test('a new entry in a language the site does not declare is refused whole', async () => {
  createDraft.mockClear();
  state.locales = ['en', 'de'];

  const res = await POST(
    post('entries/listings', JSON.stringify({ title: 'Strandhaus', locale: 'fr' })),
  );

  expect(res.status).toBe(400);
  expect(await res.text()).toBe('fr is not a language this site declares');
  expect(createDraft).not.toHaveBeenCalled();
});

test('the one language of a one-language site is a valid choice and records nothing', async () => {
  createDraft.mockClear();

  const res = await POST(
    post('entries/listings', JSON.stringify({ title: 'Strandhaus', locale: 'en' })),
  );

  expect(res.status).toBe(200);
  expect(createDraft.mock.calls[0]?.[4]).not.toHaveProperty('_source');
  expect(
    (await POST(post('entries/listings', JSON.stringify({ title: 'x', locale: 'de' })))).status,
  ).toBe(400);
});

test('creating in an unknown collection is 404', async () => {
  createDraft.mockClear();
  expect((await POST(post('entries/nope', JSON.stringify({ title: 'x' })))).status).toBe(404);
  expect(createDraft).not.toHaveBeenCalled();
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

// A starter is a file with no ids in it.
test('creating from a template fills the entry from it and gives its blocks ids', async () => {
  createDraft.mockClear();
  const res = await POST(
    post('entries/pages', JSON.stringify({ title: 'Move to Devon', template: 'landing' })),
  );

  expect(await res.json()).toEqual({ slug: 'move-to-devon' });
  const values = createDraft.mock.calls[0]?.[4] as Record<string, unknown>;
  const [block] = values.blocks as { _type: string; _id: string; heading: string }[];
  expect(block?._id).toMatch(/^[0-9a-z]{8}$/);
  expect(block?.heading).toBe('Move to the coast');
  // The title typed into the dialog, not the one the starter carries.
  expect(values.title).toBe('Move to Devon');
  expect(values._version).toBe(1);
});

test('a template that names a language gives a one-language entry none', async () => {
  createDraft.mockClear();
  await POST(
    post('entries/pages', JSON.stringify({ title: 'Move to Devon', template: 'landing' })),
  );

  expect(createDraft.mock.calls[0]?.[4]).not.toHaveProperty('_source');
});

test('creating from a template no collection declares is 404', async () => {
  createDraft.mockClear();
  const res = await POST(
    post('entries/listings', JSON.stringify({ title: 'Strandhaus', template: 'palace' })),
  );
  expect(res.status).toBe(404);
  expect(createDraft).not.toHaveBeenCalled();
});

// A template is the entry's own file in the language it was written in.
test('saving as a template commits one stripped file and logs it', async () => {
  publish.mockClear();
  files['src/content/pages/en/home.yaml'] =
    '_version: 1\n_i18n:\n  sourceLocale: "en"\n_status: "hidden"\nslug: "start"\ntitle: "Home"\nblocks:\n  - _type: "hero"\n    _id: "k3nf9a2p"\n    heading: "Hi"\n';

  const res = await POST(
    post('entries/pages/home/template', JSON.stringify({ to: 'Landing page' }), owner),
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ name: 'landing-page' });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledWith(
    [
      {
        path: 'src/content/_templates/pages/landing-page.yaml',
        contents: '_version: 1\ntitle: "Home"\nblocks:\n  - _type: "hero"\n    heading: "Hi"\n',
      },
    ],
    {
      base_sha: 'head789',
      message: expect.stringContaining('Save pages/home as the template landing-page'),
    },
  );
  expect(logged).toEqual([
    {
      userId: 'u1',
      kind: 'template-saved',
      subject: 'src/content/pages/en/home.yaml',
      detail: { template: 'landing-page' },
      commitSha: 'def456',
    },
  ]);
});

// The name goes through the same derivation as a new entry's.
test('a template name already taken gets the next free one', async () => {
  publish.mockClear();
  files['src/content/pages/en/home.yaml'] = '_version: 1\ntitle: "Home"\n';
  savedTemplates.mockImplementationOnce(async () => ['home']);

  const res = await POST(post('entries/pages/home/template', JSON.stringify({}), owner));

  expect(await res.json()).toEqual({ name: 'home-2' });
  expect(publish.mock.calls[0]?.[0]).toEqual([
    { path: 'src/content/_templates/pages/home-2.yaml', contents: '_version: 1\ntitle: "Home"\n' },
  ]);
});

test('an entry that was never published cannot be saved as a template', async () => {
  publish.mockClear();
  const res = await POST(
    post('entries/listings/strandhaus-nord/template', JSON.stringify({}), owner),
  );
  expect(res.status).toBe(409);
  expect(await res.text()).toBe('Publish this entry before saving it as a template');
  expect(publish).not.toHaveBeenCalled();
});

// A template shapes every entry made after it.
test('an editor cannot save a template', async () => {
  publish.mockClear();
  files['src/content/pages/en/home.yaml'] = '_version: 1\ntitle: "Home"\n';
  const res = await POST(post('entries/pages/home/template', JSON.stringify({}), editor));
  expect(res.status).toBe(403);
  expect(publish).not.toHaveBeenCalled();
});

// Until the next build the repository's own list does not have a saved template.
test('the entry list offers the saved templates beside the built ones', async () => {
  savedTemplates.mockImplementationOnce(async () => ['flat', 'house']);
  const res = await GET(ctx('entries/listings'));
  expect(((await res.json()) as { templates: string[] }).templates).toEqual(['flat', 'house']);
});

test('creating from a saved template reads its file from the repository', async () => {
  createDraft.mockClear();
  savedTemplates.mockImplementationOnce(async () => ['landing-page']);
  files['src/content/_templates/pages/landing-page.yaml'] =
    '_version: 1\ntitle: "Home"\nblocks:\n  - _type: "hero"\n    heading: "Hi"\n';

  const res = await POST(
    post('entries/pages', JSON.stringify({ title: 'Move to Devon', template: 'landing-page' })),
  );

  expect(await res.json()).toEqual({ slug: 'move-to-devon' });
  const values = createDraft.mock.calls[0]?.[4] as Record<string, unknown>;
  const [block] = values.blocks as { _id: string; heading: string }[];
  expect(block?.heading).toBe('Hi');
  expect(block?._id).toMatch(/^[0-9a-z]{8}$/);
  expect(values.title).toBe('Move to Devon');
});

test('renaming moves the entry in one commit and takes its unpublished edits with it', async () => {
  publish.mockClear();
  recordRenames.mockClear();
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
  expect(recordRenames).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    [
      {
        from: 'src/content/listings/en/mill-house.yaml',
        to: 'src/content/listings/en/the-old-mill.yaml',
        contents: 'title: The Mill House\nlocation: Bakewell\nrooms: 3\n',
      },
    ],
    'def456',
    undefined,
    expect.objectContaining({ operationId: 'operation-1', token: 'reservation' }),
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

test('deleting commits the removal with a redirect and says the file has gone', async () => {
  publish.mockClear();
  recordDelete.mockClear();
  const res = await del('entries/listings/mill-house');
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
    '',
  );
});

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

// The entry is the same entry: whoever has it open still has it, under the name it now answers to.
test('the lock follows a rename and goes with a delete', async () => {
  await POST(post('entries/listings/mill-house/rename', JSON.stringify({ to: 'The Old Mill' })));
  expect(moved).toEqual(['listings/mill-house -> listings/the-old-mill']);

  await del('entries/listings/mill-house');
  expect(dropped).toEqual(['listings/mill-house']);
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

const drifted = () => {
  state.locales = ['en', 'de'];
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

test('the entry list says which languages the site declares', async () => {
  state.locales = ['en', 'de'];

  const body = (await (await GET(ctx('entries/listings'))).json()) as {
    locales: unknown;
    defaultLocale: unknown;
  };

  expect(body.locales).toEqual(['en', 'de']);
  // Which of them a new entry is written in when nothing else is chosen.
  expect(body.defaultLocale).toBe('en');
});

// A menu can point at a collection's index, which is not an entry.
test('the picker list carries each collection with an index page, in every language', async () => {
  state.locales = ['en', 'de'];

  const body = (await (await GET(ctx('entries'))).json()) as { indexes: unknown[] };

  expect(body.indexes).toEqual([
    {
      collection: 'listings',
      index: true,
      path: 'listings',
      title: 'Listings',
      // What the site calls an unlabelled item pointing here, in each language it serves.
      titles: { en: 'Homes', de: 'Häuser' },
      // The collection's own label, capitalised for a picker row, in every interface language.
      labels: { en: 'Homes', de: 'Häuser' },
      locales: ['en', 'de'],
      urls: { en: '/listings', de: '/de/listings' },
    },
    {
      collection: 'posts',
      index: true,
      path: 'posts',
      title: 'Posts',
      titles: { en: 'Posts', de: 'Posts' },
      locales: ['en', 'de'],
      urls: { en: '/blog', de: '/de/blog' },
    },
  ]);
});

// The page picker's one read.
test('the picker list carries every collection with the address each language serves', async () => {
  state.locales = ['en', 'de'];

  const body = (await (await GET(ctx('entries'))).json()) as {
    entries: unknown[];
    locales: unknown;
  };

  expect(body.locales).toEqual(['en', 'de']);
  expect(body.entries).toEqual([
    {
      collection: 'listings',
      hidden: false,
      path: 'listings/mill-house',
      title: 'The Mill House',
      titles: { en: 'The Mill House' },
      hiddenLocales: [],
      locales: ['en'],
      urls: { en: '/listings/mill-house' },
    },
    {
      collection: 'listings',
      hidden: false,
      path: 'listings/seaview-cottage',
      title: 'Seaview Cottage',
      titles: { en: 'Seaview Cottage' },
      hiddenLocales: [],
      locales: ['en'],
      urls: { en: '/listings/seaview-cottage' },
    },
    {
      collection: 'presenters',
      hidden: false,
      path: 'presenters/rosa-hale',
      title: 'Rosa Hale',
      titles: { en: 'Rosa Hale' },
      hiddenLocales: [],
      locales: ['en'],
      urls: {},
    },
    {
      collection: 'posts',
      hidden: false,
      path: 'posts/hello',
      title: 'Hello',
      titles: { en: 'Hello' },
      hiddenLocales: [],
      locales: ['en'],
      urls: { en: '/blog/hello' },
    },
    {
      collection: 'posts',
      hidden: false,
      path: 'posts/taken',
      title: 'Taken',
      titles: { en: 'Taken', de: 'Belegt' },
      hiddenLocales: [],
      locales: ['en', 'de'],
      urls: { en: '/blog/taken', de: '/de/blog/belegt' },
    },
  ]);
});

// 3.26 listed a hidden entry with nothing to say about it.
test('the picker says which of its rows is off the site', async () => {
  overlayRows.mockResolvedValueOnce([
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: '_version: 1\n_status: "hidden"\ntitle: "The Mill House"\n',
    },
  ]);

  const body = (await (await GET(ctx('entries'))).json()) as {
    entries: { hidden: boolean; hiddenLocales: string[] }[];
  };

  expect(body.entries.map((e) => e.hidden)).toEqual([true, false, false, false, false]);
  expect(body.entries.map((e) => e.hiddenLocales)).toEqual([['en'], [], [], [], []]);
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

// An entry with no German file: the two things the editor offers there.
const untranslated = (english = home.en) => {
  state.locales = ['en', 'de'];
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
      _source: 'en',
      layout: 'wide',
      blocks: [{ _type: 'hero', _id: 'k3nf9a2p' }],
    },
    {
      'src/content/pages/en/home.yaml': undefined,
      'src/content/pages/de/home.yaml': undefined,
    },
  );
});

test('the new language is offered in the same ones the entry already is', async () => {
  state.locales = ['en', 'de', 'fr'];
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

// The site's default language is no longer a language this route refuses on sight.
test('the language an entry is written in is refused for the file it has, not for being it', async () => {
  untranslated();
  createDraft.mockClear();

  expect((await POST(post('drafts/pages/home/en', ''))).status).toBe(409);
  expect((await POST(post('drafts/pages/home/fr', ''))).status).toBe(404);
  expect(createDraft).not.toHaveBeenCalled();
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

test('turning off a language that has a file removes it in one commit, with its redirect', async () => {
  bilingualPost();
  publish.mockClear();
  recordDelete.mockClear();

  const res = await POST(post('entries/posts/taken/locales', JSON.stringify({ locales: ['en'] })));

  expect(res.status).toBe(200);
  const [written] = (publish.mock.calls[0] ?? []) as unknown as [PublishFile[]];
  expect(written.map((f) => f.path)).toEqual([
    'src/content/posts/de/taken.yaml',
    'src/content/posts/en/taken.yaml',
    'src/content/redirects.yaml',
  ]);
  expect(written[0]?.contents).toBe(null);
  expect(written[1]?.contents).toContain('_locales:\n  - "en"');
  expect(written[2]?.contents).toContain('from: "/de/blog/belegt"\n    to: "/de/blog"');
  // The list is the build's index and the build has not run yet, so something has to say so.
  expect(recordDelete).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    'src/content/posts/de/taken.yaml',
    'def456',
    '',
  );
});

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

test('creating a language is refused over a _locales naming one the site does not declare', async () => {
  state.locales = ['en', 'de'];
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
  state.locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en.replace(
    '_version: 1',
    '_version: 1\n_locales:\n  - "en"',
  );

  const body = (await (await GET(ctx('entries/pages/home'))).json()) as { offered: unknown };

  expect(body.offered).toEqual(['en']);
});

// The `translate(from, to)` hook: whatever answers.
const machine = () => {
  state.locales = ['en', 'de'];
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
  expect(translate).toHaveBeenCalledWith(
    ['Move to the coast'],
    'en',
    'de',
    expect.any(AbortSignal),
  );
  expect(saveTranslated).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/de/home.yaml',
    { 'blocks[_id=k3nf9a2p].heading': '[de] Move to the coast' },
    undefined,
    undefined,
    {
      form: expect.anything(),
      source: {
        locale: 'en',
        contents: home.en,
        blob_sha: 'blob-src/content/pages/en/home.yaml',
      },
    },
  );
});

test('a machine fill keeps the source snapshot sent before the provider round trip', async () => {
  machine();
  saveTranslated.mockClear();
  const moved = home.en.replace('Move to the coast', 'Move to the water');
  translate.mockImplementationOnce(async (texts: string[], _from: string, to: string) => {
    files['src/content/pages/en/home.yaml'] = moved;
    return texts.map((text) => `[${to}] ${text}`);
  });

  const res = await POST(post('translate/pages/home/de', ''));

  expect(res.status).toBe(200);
  expect(saveTranslated).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/de/home.yaml',
    { 'blocks[_id=k3nf9a2p].heading': '[de] Move to the coast' },
    undefined,
    undefined,
    {
      form: expect.anything(),
      source: {
        locale: 'en',
        contents: home.en,
        blob_sha: 'blob-src/content/pages/en/home.yaml',
      },
    },
  );
  expect(files['src/content/pages/en/home.yaml']).toBe(moved);
});

test('a named field is translated whether it is empty or not', async () => {
  machine();
  translate.mockClear();
  saveTranslated.mockClear();

  const res = await POST(post('translate/pages/home/de', JSON.stringify({ paths: ['title'] })));

  expect(res.status).toBe(200);
  expect(translate).toHaveBeenCalledWith(['Home'], 'en', 'de', expect.any(AbortSignal));
  expect(saveTranslated).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'src/content/pages/de/home.yaml',
    { title: '[de] Home' },
    undefined,
    undefined,
    {
      form: expect.anything(),
      source: {
        locale: 'en',
        contents: home.en,
        blob_sha: 'blob-src/content/pages/en/home.yaml',
      },
    },
  );
});

test('a translation with nothing left to fill asks no machine anything', async () => {
  machine();
  files['src/content/pages/de/home.yaml'] = home.en.replace('Home', 'Startseite');
  translate.mockClear();

  expect((await POST(post('translate/pages/home/de', ''))).status).toBe(200);
  expect(translate).not.toHaveBeenCalled();
});

// Every other test here supplies `i18n.translate`, so the fallback.
test('a site with no hook of its own translates with the DEEPL_API_KEY it holds', async () => {
  machine();
  state.translator = undefined;
  state.deeplKey = 'key-123';
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
    undefined,
    undefined,
    {
      form: expect.anything(),
      source: {
        locale: 'en',
        contents: home.en,
        blob_sha: 'blob-src/content/pages/en/home.yaml',
      },
    },
  );
});

test('a site with nothing to translate with says so rather than failing quietly', async () => {
  machine();
  state.translator = undefined;

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
  state.translator = undefined;
  expect(
    ((await (await GET(ctx('entries/pages/home'))).json()) as { translator: unknown }).translator,
  ).toBe(false);
});

// Having nothing to translate with is about the site and not about this entry.
test('nothing to translate with outranks the entry having no file in that language', async () => {
  machine();
  state.translator = undefined;
  delete files['src/content/pages/de/home.yaml'];

  expect((await POST(post('translate/pages/home/de', ''))).status).toBe(409);
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

const addressed = () => {
  state.locales = ['en', 'de'];
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

// URLs are never machine-translated.
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

// An entry with no file in the site's default language — the demo's German-only Impressum.
const germanOnly = () => {
  state.locales = ['en', 'de'];
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
    { _version: 1, _source: 'de', blocks: [{ _type: 'hero', _id: 'b7t4x1m9' }] },
    {
      'src/content/pages/en/impressum.yaml': undefined,
      'src/content/pages/de/impressum.yaml': undefined,
    },
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

test('the drawer reads the hold as the entry\u2019s, whichever of its files carries it', async () => {
  heldDrafts.mockResolvedValueOnce({
    'listings/mill-house': { id: 'u1', name: 'Anna Berg' },
  });

  const res = await GET(ctx('drafts'));

  expect(await res.json()).toEqual({
    defaultLocale: 'en',
    entries: [
      {
        key: 'listings/mill-house',
        title: 'The Mill House',
        collection: 'listings',
        locales: ['en'],
        files: ['src/content/listings/en/mill-house.yaml'],
        updated_at: 1755864000000,
        held_by: { id: 'u1', name: 'Anna Berg' },
      },
    ],
  });
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

test('a plain collection label is available to the picker without changing menu titles', async () => {
  const { default: config } = await import('virtual:handover/config');
  const collection = config.collections.listings;
  if (!collection) throw new Error('listings collection missing');
  const original = collection.label;
  try {
    collection.label = 'homes';
    const body = (await (await GET(ctx('entries'))).json()) as {
      indexes: { collection: string; title: string; labels?: unknown }[];
    };
    expect(body.indexes.find((row) => row.collection === 'listings')).toMatchObject({
      title: 'Listings',
      labels: { en: 'Homes' },
    });
  } finally {
    collection.label = original;
  }
});

test('a failed save after translation keeps the provider charge in the budget', async () => {
  machine();
  vi.mocked(releaseResource).mockClear();
  saveTranslated.mockRejectedValueOnce(new Error('revision changed after provider started'));
  await expect(POST(post('translate/pages/home/de', ''))).rejects.toThrow('revision changed');
  expect(releaseResource).not.toHaveBeenCalled();
});

test('a user budget refusal refunds the unused site reservation before calling a provider', async () => {
  machine();
  translate.mockClear();
  vi.mocked(releaseResource).mockClear();
  vi.mocked(claimResource)
    .mockResolvedValueOnce({
      subject: 'site',
      kind: 'translation-characters',
      windowAt: 0,
      cost: 17,
    })
    .mockRejectedValueOnce(new ResourceLimitError('Account limit reached'));
  const response = await POST(post('translate/pages/home/de', ''));
  expect(response.status).toBe(429);
  expect(translate).not.toHaveBeenCalled();
  expect(releaseResource).toHaveBeenCalledExactlyOnceWith('default', expect.anything(), {
    subject: 'site',
    kind: 'translation-characters',
    windowAt: 0,
    cost: 17,
  });
});
