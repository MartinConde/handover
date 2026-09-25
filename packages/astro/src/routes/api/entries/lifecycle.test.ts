import { type PublishFile, RepoUnreachableError } from '@handover/core';
import { expect, test, vi } from 'vitest';
import { DELETE, POST } from '../../api.js';
import {
  createDraft,
  ctx,
  discardDraft,
  drifted,
  editor,
  files,
  getFile,
  logged,
  pendingDrafts,
  post,
  publish,
  rows,
  state,
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

// The subtraction from the other side.
test('a global is refused the routes that rename, address, delete or turn off an entry', async () => {
  files['src/content/globals/en/site.yaml'] = 'footerText: "Coastal homes"\n';

  expect((await POST(post('entries/globals/site/rename', '{"to":"other"}'))).status).toBe(404);
  expect((await POST(post('entries/globals/site/address/en', '{"address":"x"}'))).status).toBe(404);
  expect((await POST(post('entries/globals/site/locales', '{"locales":["en"]}'))).status).toBe(404);
  expect((await DELETE(ctx('entries/globals/site'))).status).toBe(404);

  delete files['src/content/globals/en/site.yaml'];
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

test('discarding a draft while the repository is unreachable answers 503 with its message', async () => {
  drifted();
  const message = 'The GitHub App cannot see acme/site.';
  getFile.mockImplementationOnce(async () => {
    throw new RepoUnreachableError(message);
  });

  const res = await DELETE(ctx('drafts/pages/home'));

  expect(res.status).toBe(503);
  expect(await res.text()).toBe(message);
});

test('discarding a draft of a collection that is not configured is 404', async () => {
  discardDraft.mockClear();
  expect((await DELETE(ctx('drafts/nope/mill-house'))).status).toBe(404);
  expect(discardDraft).not.toHaveBeenCalled();
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
