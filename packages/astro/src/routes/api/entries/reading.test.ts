import { RepoUnreachableError } from '@handover/core';
import { expect, test, vi } from 'vitest';
import { GET } from '../../api.js';
import {
  addressed,
  ctx,
  deletedEntries,
  drifted,
  files,
  germanOnly,
  getFile,
  home,
  machine,
  rows,
  state,
  untranslated,
} from '../harness.fixture.js';

const { workerMailerMock, configMock, indexMock, cloudflareMock, authMock, coreMock } =
  await vi.hoisted(async () => import('../harness.fixture.js'));

vi.mock('worker-mailer', () => workerMailerMock());
vi.mock('virtual:handover/config', () => configMock());
vi.mock('virtual:handover/index', () => indexMock());
vi.mock('cloudflare:workers', () => cloudflareMock());
vi.mock('../../../auth.js', async (original) =>
  authMock((await original()) as Record<string, unknown>),
);
vi.mock('@handover/core', async (original) =>
  coreMock((await original()) as Record<string, unknown>),
);

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
