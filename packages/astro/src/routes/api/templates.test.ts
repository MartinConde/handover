import { texts } from 'virtual:handover/index';
import { afterEach, expect, test, vi } from 'vitest';
import { GET, POST } from '../api.js';
import {
  createDraft,
  ctx,
  editor,
  files,
  logged,
  overlayRows,
  owner,
  post,
  publish,
  resetContainers,
  resetMocks,
  resetState,
  savedTemplates,
  state,
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
