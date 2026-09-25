import { texts } from 'virtual:handover/index';
import {
  applyDrift,
  formOf,
  parseEntry,
  RepoUnreachableError,
  stringifyEntry,
} from '@handover/core';
import { afterEach, expect, test, vi } from 'vitest';
import { formSchema } from '../../index.js';
import { GET, POST } from '../api.js';
import {
  clearPublished,
  commitBuild,
  ctx,
  files,
  getHead,
  heldDrafts,
  home,
  logged,
  owner,
  page,
  pendingDrafts,
  post,
  publishDrafts,
  readyDrafts,
  resetContainers,
  resetMocks,
  resetState,
  state,
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

// The publish holds every file to a schema, and a global's is its own.
test('publishing is refused when a global is missing something its schema needs', async () => {
  publishDrafts.mockClear();
  readyDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/globals/en/site.yaml',
      contents: 'phone: "0100"\n',
      updatedAt: 1755864000000,
    },
  ]);

  const res = await POST(post('publish', ''));

  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    code: 'PUBLISH_INCOMPLETE',
    error: 'src/content/globals/en/site.yaml is missing something the schema needs',
    paths: ['src/content/globals/en/site.yaml'],
  });
  expect(publishDrafts).not.toHaveBeenCalled();
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
    code: 'PUBLISH_CONFLICT',
    error: 'src/content/listings/en/mill-house.yaml changed in the repository after it was opened',
    paths: ['src/content/listings/en/mill-house.yaml'],
  });
});

test('publishing is refused when a stored draft is not everything the schema needs', async () => {
  publishDrafts.mockClear();
  readyDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: 'title: "The Mill House"\n',
      updatedAt: 1755864000000,
    },
  ]);
  const res = await POST(post('publish', ''));
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    code: 'PUBLISH_INCOMPLETE',
    error: 'src/content/listings/en/mill-house.yaml is missing something the schema needs',
    paths: ['src/content/listings/en/mill-house.yaml'],
  });
  expect(publishDrafts).not.toHaveBeenCalled();
});

// redirects.yaml and the globals share the prefix and belong to no collection.
test('a pending file no collection owns is not held to a collection schema', async () => {
  publishDrafts.mockClear();
  readyDrafts.mockImplementationOnce(async () => [
    { path: 'src/content/redirects.yaml', contents: 'rules: []\n', updatedAt: 1755864000000 },
  ]);
  expect((await POST(post('publish', ''))).status).toBe(200);
  expect(publishDrafts).toHaveBeenCalled();
});

test('publishing is 409 when the branch moved under it', async () => {
  const { RefMovedError } = await import('@handover/core');
  publishDrafts.mockImplementationOnce(async () => {
    throw new RefMovedError('main moved past abc123');
  });
  const res = await POST(post('publish', ''));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ code: 'PUBLISH_REF_MOVED', error: 'main moved past abc123' });
});

test('publish and pre-publish repository failures carry operation-specific codes', async () => {
  const message = 'The GitHub App cannot see acme/site.';
  readyDrafts.mockImplementationOnce(async () => {
    throw new RepoUnreachableError(message);
  });
  const publishRes = await POST(post('publish', ''));
  expect(publishRes.status).toBe(503);
  expect(await publishRes.json()).toEqual({
    code: 'PUBLISH_REPOSITORY_UNAVAILABLE',
    error: message,
  });

  readyDrafts.mockImplementationOnce(async () => {
    throw new RepoUnreachableError(message);
  });
  const checksRes = await POST(post('publish/checks', JSON.stringify({ entries: [] })));
  expect(checksRes.status).toBe(503);
  expect(await checksRes.json()).toEqual({ code: 'PUBLISH_CHECKS_FAILED', error: message });
});

test('a publish awaiting database finalization carries a stable recovery code', async () => {
  const { OperationFinalizationError } = await import('@handover/core');
  publishDrafts.mockImplementationOnce(async () => {
    throw new OperationFinalizationError('publish-operation', 'def4567890');
  });

  const res = await POST(post('publish', ''));

  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({
    code: 'PUBLISH_FINALIZATION_PENDING',
    error: 'The commit succeeded, but its database finalization still needs to be retried.',
    reason: 'needs-finalization',
    operation_id: 'publish-operation',
    commit_sha: 'def4567890',
  });
});

const drifted = () => {
  state.locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en;
  files['src/content/pages/de/home.yaml'] = home.de;
};

test('publishing an entry whose languages have drifted apart is refused', async () => {
  drifted();
  publishDrafts.mockClear();
  readyDrafts.mockImplementationOnce(async () => [
    { path: 'src/content/pages/en/home.yaml', contents: home.en, updatedAt: 1755864000000 },
  ]);

  const res = await POST(post('publish', ''));

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    code: 'PUBLISH_DRIFT',
    error:
      "src/content/pages/en/home.yaml has drifted apart from the entry's other languages — resolve it in the editor",
    paths: ['src/content/pages/en/home.yaml'],
    // Which 409 it is: the drawer offers Discard for a conflict and the editor for this.
    reason: 'drift',
  });
  expect(publishDrafts).not.toHaveBeenCalled();
});

test('an entry whose languages agree publishes, drift or no drift elsewhere', async () => {
  state.locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en;
  files['src/content/pages/de/home.yaml'] = home.en.replace('Home', 'Startseite');
  publishDrafts.mockClear();
  readyDrafts.mockImplementationOnce(async () => [
    { path: 'src/content/pages/en/home.yaml', contents: home.en, updatedAt: 1755864000000 },
  ]);

  expect((await POST(post('publish', ''))).status).toBe(200);
  expect(publishDrafts).toHaveBeenCalled();
});

// It reads the entry rather than the path.
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

// The two ends of the done-when: the state an answer leaves behind is one that publishes.
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
  readyDrafts.mockImplementationOnce(async () => written);
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
    code: 'PUBLISH_INCOMPLETE',
    error: 'src/content/pages/en/home.yaml is missing something the schema needs',
    paths: ['src/content/pages/en/home.yaml'],
  });
  expect(publishDrafts).not.toHaveBeenCalled();
});

test('a publish marks a translation from the language the entry is written in', async () => {
  state.locales = ['en', 'de', 'fr'];
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

test('a publish is a publish event carrying the commit, the count and the entries', async () => {
  await POST(
    ctx('publish', new Request('https://x/admin/api/publish', { method: 'POST' }), {
      handover: owner,
    }),
  );

  expect(logged).toEqual([
    {
      userId: 'u1',
      kind: 'publish',
      subject: 'src/content/listings/en/mill-house.yaml',
      detail: {
        files: 1,
        entries: ['listings/mill-house'],
        paths: ['src/content/listings/en/mill-house.yaml'],
      },
      commitSha: 'def456',
    },
  ]);
});

// The draft rows go once the build carrying them is live.
test('a batch publish records the entries it carried, one each and capped', async () => {
  const paths = Array.from(
    { length: 10 },
    (_, i) => `src/content/listings/${i % 2 ? 'de' : 'en'}/house-${Math.floor(i / 2)}.yaml`,
  );
  publishDrafts.mockImplementationOnce(async () => ({ commit_sha: 'def456', paths }));

  await POST(publishing(''));

  expect(logged[0]).toMatchObject({
    kind: 'publish',
    subject: null,
    detail: {
      files: 10,
      entries: [
        'listings/house-0',
        'listings/house-1',
        'listings/house-2',
        'listings/house-3',
        'listings/house-4',
      ],
    },
  });
});

// Hazard 4: a Publish click with nothing pending must not spend a write.
test('a publish that commits nothing writes no event', async () => {
  publishDrafts.mockImplementationOnce(async () => undefined);

  await POST(
    ctx('publish', new Request('https://x/admin/api/publish', { method: 'POST' }), {
      handover: owner,
    }),
  );

  expect(logged).toEqual([]);
});

test('a publish the schema refused writes no event', async () => {
  readyDrafts.mockImplementationOnce(async () => [
    { path: 'src/content/listings/en/mill-house.yaml', contents: 'rooms: 3\n', updatedAt: 1 },
  ]);

  const res = await POST(
    ctx('publish', new Request('https://x/admin/api/publish', { method: 'POST' }), {
      handover: owner,
    }),
  );

  expect(res.status).toBe(422);
  expect(logged).toEqual([]);
});

// The checks a publish runs are about the files it is going to write.
test('a publish is checked against the files it will write, not the ones on hold', async () => {
  pendingDrafts.mockResolvedValueOnce([
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: 'title: "Half written"\n',
      updatedAt: 1755864000000,
    },
  ]);

  const res = await POST(post('publish', ''));

  expect(res.status).toBe(200);
  expect(publishDrafts).toHaveBeenCalled();
});

// Selective publish.
const publishing = (body: string, session: Record<string, unknown> = owner) =>
  ctx('publish', new Request('https://x/admin/api/publish', { method: 'POST', body }), {
    handover: session,
  });

test('a publish of a chosen set reads and commits exactly those entries', async () => {
  publishDrafts.mockClear();
  readyDrafts.mockClear();

  const res = await POST(publishing(JSON.stringify({ entries: ['listings/mill-house'] })));

  expect(res.status).toBe(200);
  expect(readyDrafts).toHaveBeenCalledWith('default', expect.anything(), ['listings/mill-house']);
  expect(publishDrafts.mock.calls[0]?.[4]).toEqual(['listings/mill-house']);
});

// What the drawer sends: a POST with no body at all.
test('a publish with no body is still every entry that is ready', async () => {
  publishDrafts.mockClear();
  readyDrafts.mockClear();

  const res = await POST(
    ctx('publish', new Request('https://x/admin/api/publish', { method: 'POST' }), {
      handover: owner,
    }),
  );

  expect(res.status).toBe(200);

  expect(readyDrafts).toHaveBeenCalledWith('default', expect.anything(), undefined);
  expect(publishDrafts.mock.calls[0]?.[4]).toBe(undefined);
});

test('a publish that released a hold logs it against the person who set it', async () => {
  heldDrafts.mockResolvedValueOnce({ 'listings/mill-house': { id: 'u2', name: 'Anna Berg' } });
  publishDrafts.mockImplementationOnce(async () => ({
    commit_sha: 'def456',
    paths: ['src/content/listings/en/mill-house.yaml'],
    released: ['listings/mill-house'],
  }));

  await POST(publishing(JSON.stringify({ entries: ['listings/mill-house'] })));

  expect(logged).toEqual([
    {
      userId: 'u1',
      kind: 'hold-released',
      subject: 'src/content/listings/en/mill-house.yaml',
      detail: { from: 'Anna Berg' },
    },
    {
      userId: 'u1',
      kind: 'publish',
      subject: 'src/content/listings/en/mill-house.yaml',
      detail: {
        files: 1,
        entries: ['listings/mill-house'],
        paths: ['src/content/listings/en/mill-house.yaml'],
      },
      commitSha: 'def456',
    },
  ]);
});

// The two refusals that are somebody else's work rather than the clicker's own drafts.
test('a file that changed in the repository is logged as a conflict', async () => {
  const { DraftConflictError } = await import('@handover/core');
  publishDrafts.mockImplementationOnce(async () => {
    throw new DraftConflictError(['src/content/listings/en/mill-house.yaml']);
  });

  const res = await POST(publishing(''));

  expect(res.status).toBe(409);
  expect(logged).toEqual([
    {
      userId: 'u1',
      kind: 'publish-conflict',
      subject: 'src/content/listings/en/mill-house.yaml',
      detail: { files: 1 },
    },
  ]);
});

test('a branch that moved under the commit is logged as a failed publish', async () => {
  const { RefMovedError } = await import('@handover/core');
  publishDrafts.mockImplementationOnce(async () => {
    throw new RefMovedError('main moved past abc123');
  });

  const res = await POST(publishing(''));

  expect(res.status).toBe(409);
  expect(logged).toEqual([
    {
      userId: 'u1',
      kind: 'publish-failed',
      subject: null,
      detail: { files: 1, reason: 'ref-moved' },
    },
  ]);
});

test('the build endpoint answers where the last commit has got to', async () => {
  const res = await GET(ctx('build'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    commit_sha: 'def456',
    state: 'building',
    started_at: 1755864100000,
    committed_at: 1755864000000,
  });
});

// Rule 3 of "your own publish must not look like a conflict".
test('the rows a live build carries are cleared when it reports live', async () => {
  commitBuild.mockImplementationOnce(
    async (_cfg: unknown, commit: { sha: string } | undefined) => ({
      commit_sha: commit?.sha,
      deployed_sha: 'live123',
      state: 'live',
      started_at: 1755864100000,
    }),
  );
  await GET(ctx('build'));
  expect(clearPublished).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    'live123',
    expect.anything(),
  );
});

// `committed_at` is what the pill's counter runs from.
test('an answer that names no commit carries no committed_at', async () => {
  commitBuild.mockImplementationOnce(async () => ({
    state: 'live',
    started_at: 1755864100000,
    live_at: 1755864200000,
  }));
  expect(await (await GET(ctx('build'))).json()).toEqual({
    state: 'live',
    started_at: 1755864100000,
    live_at: 1755864200000,
  });
});

test('a build that is still running clears nothing', async () => {
  await GET(ctx('build'));
  expect(clearPublished).not.toHaveBeenCalled();
});

test('a site with no Cloudflare token draws no build status at all', async () => {
  state.cloudflareToken = undefined;
  const res = await GET(ctx('build'));
  expect(await res.json()).toEqual({});
  expect(commitBuild).not.toHaveBeenCalled();
});

// No commit of ours to ask about, but the site is serving something.
test("a site that has published nothing reads the worker's newest build", async () => {
  state.lastCommitRow = undefined;
  expect(await (await GET(ctx('build'))).json()).toEqual({
    state: 'building',
    started_at: 1755864100000,
  });
  expect(commitBuild).toHaveBeenCalledWith(expect.anything(), undefined);
  expect(clearPublished).not.toHaveBeenCalled();
});

// An API that cannot be asked is the site's configuration rather than a state the site is in.
test('an unreachable Workers Builds API answers as no build status', async () => {
  commitBuild.mockImplementationOnce(async () => {
    throw new Error('Cloudflare builds failed: 403');
  });
  const res = await GET(ctx('build'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});
});

// Pre-publish checks: the lint the drawer runs over the set it is about to commit.

const checking = (entries?: string[]) =>
  POST(
    ctx(
      'publish/checks',
      new Request('https://x/admin/api/publish/checks', {
        method: 'POST',
        ...(entries ? { body: JSON.stringify({ entries }) } : {}),
      }),
      { handover: owner },
    ),
  );

const results = async (res: Response) =>
  ((await res.json()) as { results: { check: string; entry: string; message: string }[] }).results;

test('a link to a page this site has none of is reported, named by its entry', async () => {
  readyDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/notices/en/opening.yaml',
      contents: 'title: Opening times\ncta:\n  type: url\n  href: /listings/no-such-house\n',
      updatedAt: 1755864000000,
    },
  ]);

  const found = await results(await checking(['notices/opening']));

  expect(found).toEqual([
    {
      check: 'link-target',
      entry: 'notices/opening',
      path: 'src/content/notices/en/opening.yaml',
      fieldPath: 'cta.href',
      severity: 'warn',
      message:
        'Cta links to /listings/no-such-house, where this site has no page — the link is a 404',
    },
  ]);
});

// The whole reason the selection is sent rather than filtered in the browser.
test('a link to a page only an unselected draft would create is reported', async () => {
  const drafts = [
    {
      path: 'src/content/notices/en/opening.yaml',
      contents: 'title: Opening times\ncta:\n  type: url\n  href: /listings/new-barn\n',
      updatedAt: 1755864000000,
    },
    {
      path: 'src/content/listings/en/new-barn.yaml',
      contents: 'title: The New Barn\nrooms: 2\naddress:\n  street: Barn Lane\n',
      updatedAt: 1755864000000,
    },
  ];
  readyDrafts.mockImplementationOnce(async (...args: unknown[]) => {
    const chosen = args[2] as string[] | undefined;
    return drafts.filter((d) => chosen?.some((key) => d.path.includes(key.split('/')[1] ?? '')));
  });

  expect(await results(await checking(['notices/opening']))).toHaveLength(1);

  readyDrafts.mockImplementationOnce(async () => drafts);

  expect(await results(await checking(['notices/opening', 'listings/new-barn']))).toEqual([]);
});

test('a check the site turned off is not reported', async () => {
  readyDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/notices/en/opening.yaml',
      contents: 'title: Opening times\ncta:\n  type: url\n  href: /listings/no-such-house\n',
      updatedAt: 1755864000000,
    },
  ]);
  state.siteChecks = { ignore: ['link-target'] };

  expect(await results(await checking(['notices/opening']))).toEqual([]);
});

// A language that is not going out is still read.
test('the languages going out are the ones reported on', async () => {
  state.locales = ['en', 'de'];
  files['src/content/listings/de/mill-house.yaml'] = 'title: ""\nrooms: 3\naddress:\n  street: x\n';
  readyDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: 'title: The Mill House\nrooms: 3\naddress:\n  street: Mill Lane\n',
      updatedAt: 1755864000000,
    },
  ]);

  expect(await results(await checking(['listings/mill-house']))).toEqual([]);
});

// A rename and a delete write an empty row at the path they took the file from.
test('a file this publish removes is not linted', async () => {
  readyDrafts.mockImplementationOnce(async () => [
    { path: 'src/content/posts/en/hello.yaml', contents: '', updatedAt: 1755864000000 },
  ]);

  expect(await results(await checking(['posts/hello']))).toEqual([]);
});

// The one check that is about the whole site.
test("a page the daily job found hidden too long is a note beside the set's own", async () => {
  state.hiddenLong = [
    { path: 'src/content/listings/en/seaview-cottage.yaml', since: '2026-04-01T09:00:00Z' },
  ];
  readyDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/listings/en/seaview-cottage.yaml',
      contents:
        '_status: hidden\ntitle: Seaview Cottage\nrooms: 3\naddress:\n  street: Cliff Road\n',
      updatedAt: 1755864000000,
    },
  ]);

  const found = await results(await checking(['listings/seaview-cottage']));

  expect(found.map((r) => `${r.check} ${r.entry}`)).toEqual([
    'hidden-long listings/seaview-cottage',
  ]);
  expect(found[0]?.message).toMatch(/^Seaview Cottage has been hidden for over \d+ months — /);
});

test.each([
  '{',
  'null',
  '[]',
  '{}',
  ' ',
  '{"entries":"pages/home"}',
  '{"entries":["pages/home",null]}',
  '{"entries":["../code"]}',
  '{"entries":["pages/home"],"all":true}',
])('malformed publish body %s is refused before selecting drafts', async (body) => {
  readyDrafts.mockClear();
  publishDrafts.mockClear();
  const res = await POST(post('publish', body));
  expect(res.status).toBe(400);
  expect(readyDrafts).not.toHaveBeenCalled();
  expect(publishDrafts).not.toHaveBeenCalled();
});

// Publishing an entry without a language that is not ready yet.

const MILL_EN = 'src/content/listings/en/mill-house.yaml';
const MILL_DE = 'src/content/listings/de/mill-house.yaml';
const millDrafts = (held: string | null = null) => [
  {
    path: MILL_EN,
    contents: 'title: The Mill House\nrooms: 4\naddress:\n  street: Mill Lane\n',
    updatedAt: 1755864000000,
    revision: 'r-en',
    heldBy: held,
  },
  // Created from English and never typed into: only the title came across.
  {
    path: MILL_DE,
    contents: 'title: ""\n',
    updatedAt: 1755864000000,
    revision: 'r-de',
    heldBy: held,
  },
];
const selecting = (route: 'publish' | 'publish/checks', body: unknown) =>
  POST(post(route, typeof body === 'string' ? body : JSON.stringify(body), owner));
// A plain-text refusal carries no code, which is what these tests reject.
const code = async (res: Response) =>
  ((await res.json().catch(() => ({}))) as { code?: string }).code;

test.each([
  ['an unknown property', { entries: ['listings/mill-house'], also: 1 }],
  ['a without that is not a list', { entries: ['listings/mill-house'], without: MILL_DE }],
  ['a without with no entries', { without: ['listings/mill-house:de'] }],
  ['an item that is not a file key', { entries: ['listings/mill-house'], without: ['de'] }],
  [
    'an entry the selection does not name',
    { entries: ['listings/mill-house'], without: ['listings/barn:de'] },
  ],
  [
    'a language the site does not declare',
    { entries: ['listings/mill-house'], without: ['listings/mill-house:fr'] },
  ],
])('%s is refused by both publish routes before any draft is read', async (_, body) => {
  state.locales = ['en', 'de'];
  readyDrafts.mockClear();

  for (const route of ['publish', 'publish/checks'] as const) {
    const res = await selecting(route, body);
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('PUBLISH_SELECTION_INVALID');
  }
  expect(readyDrafts).not.toHaveBeenCalled();
});

test('leaving out a language with nothing waiting is refused', async () => {
  state.locales = ['en', 'de'];
  readyDrafts.mockImplementationOnce(async () => millDrafts().slice(0, 1));

  const res = await selecting('publish', {
    entries: ['listings/mill-house'],
    without: ['listings/mill-house:de'],
  });

  expect(res.status).toBe(400);
  expect(await code(res)).toBe('PUBLISH_EXCLUDE_NOT_PENDING');
});

test('a language the repository already has cannot be left out', async () => {
  state.locales = ['en', 'de'];
  files[MILL_DE] = 'title: Das Mühlenhaus\nrooms: 3\naddress:\n  street: Mühlweg\n';
  readyDrafts.mockImplementationOnce(async () => millDrafts());
  publishDrafts.mockClear();

  const res = await selecting('publish', {
    entries: ['listings/mill-house'],
    without: ['listings/mill-house:de'],
  });

  expect(res.status).toBe(422);
  expect(await code(res)).toBe('PUBLISH_EXCLUDE_PUBLISHED');
  expect(publishDrafts).not.toHaveBeenCalled();
  delete files[MILL_DE];
});

// A file the dialog saw absent may have been committed since: the publish's own head decides.
test('a language committed since the dialog read it is judged at the head the publish uses', async () => {
  state.locales = ['en', 'de'];
  getHead.mockResolvedValueOnce('head790');
  files[`head790:${MILL_DE}`] = 'title: Das Mühlenhaus\nrooms: 3\naddress:\n  street: Mühlweg\n';
  readyDrafts.mockImplementationOnce(async () => millDrafts());

  const res = await selecting('publish', {
    entries: ['listings/mill-house'],
    without: ['listings/mill-house:de'],
  });

  expect(res.status).toBe(422);
  expect(await code(res)).toBe('PUBLISH_EXCLUDE_PUBLISHED');
  delete files[`head790:${MILL_DE}`];
});

test('the language the entry is written in cannot be left out, even when it is new', async () => {
  state.locales = ['en', 'de'];
  readyDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/listings/de/new-barn.yaml',
      contents: '_source: de\ntitle: Die neue Scheune\nrooms: 2\naddress:\n  street: Feldweg\n',
      updatedAt: 1755864000000,
    },
    {
      path: 'src/content/listings/en/new-barn.yaml',
      contents: '_source: de\ntitle: ""\n',
      updatedAt: 1755864000000,
    },
  ]);

  const res = await selecting('publish', {
    entries: ['listings/new-barn'],
    without: ['listings/new-barn:de'],
  });

  expect(res.status).toBe(422);
  expect(await code(res)).toBe('PUBLISH_EXCLUDE_SOURCE');
});

test('leaving out every file that is waiting is refused rather than publishing nothing', async () => {
  state.locales = ['en', 'de'];
  readyDrafts.mockImplementationOnce(async () => millDrafts().slice(1));

  const res = await selecting('publish', {
    entries: ['listings/mill-house'],
    without: ['listings/mill-house:de'],
  });

  expect(res.status).toBe(400);
  expect(await code(res)).toBe('PUBLISH_EXCLUDE_ALL');
});

test('an unfinished new language waits while the rest of the entry publishes on the head it was judged at', async () => {
  state.locales = ['en', 'de'];
  readyDrafts.mockImplementationOnce(async () => millDrafts());
  publishDrafts.mockClear();
  publishDrafts.mockImplementationOnce(async () => ({ commit_sha: 'def456', paths: [MILL_EN] }));

  const res = await selecting('publish', {
    entries: ['listings/mill-house'],
    without: ['listings/mill-house:de'],
  });

  expect(res.status).toBe(200);
  expect(publishDrafts.mock.calls[0]?.[5]).toEqual([expect.objectContaining({ path: MILL_EN })]);
  expect(publishDrafts.mock.calls[0]?.[6]).toEqual({ userId: 'u1', baseSha: 'head789' });
  expect(logged).toMatchObject([{ kind: 'publish', detail: { files: 1, paths: [MILL_EN] } }]);
});

// The German draft keeps its hold, so the entry still reads held and nothing says it was let go.
test('a hold stays on an entry whose held language was left out', async () => {
  state.locales = ['en', 'de'];
  heldDrafts.mockResolvedValueOnce({ 'listings/mill-house': { id: 'u2', name: 'Anna Berg' } });
  readyDrafts.mockImplementationOnce(async () => millDrafts('u2'));
  publishDrafts.mockImplementationOnce(async () => ({
    commit_sha: 'def456',
    paths: [MILL_EN],
    released: ['listings/mill-house'],
  }));

  const res = await selecting('publish', {
    entries: ['listings/mill-house'],
    without: ['listings/mill-house:de'],
  });

  expect(((await res.json().catch(() => ({}))) as { released?: string[] }).released).toEqual([]);
  expect(logged.map((event) => event.kind)).toEqual(['publish']);
});

type Readiness = Record<
  string,
  Record<string, { excludable: boolean; reason?: string; revision?: string; problems: unknown[] }>
>;
const readinessOf = async (res: Response) =>
  ((await res.json()) as { readiness: Readiness }).readiness;

// An untouched translation has no cached problems in the browser; the server reads its draft.
test('readiness names what the schema wants of an untouched translation and whether it can wait', async () => {
  state.locales = ['en', 'de'];
  readyDrafts.mockImplementationOnce(async () => millDrafts());

  const readiness = await readinessOf(
    await selecting('publish/checks', { entries: ['listings/mill-house'] }),
  );

  expect(readiness).toEqual({
    'listings/mill-house': {
      en: { revision: 'r-en', problems: [], excludable: false, reason: 'published' },
      de: {
        revision: 'r-de',
        problems: [
          expect.objectContaining({ path: 'rooms' }),
          expect.objectContaining({ path: 'address' }),
        ],
        excludable: true,
      },
    },
  });
});

test("readiness carries the site schema's own refinements", async () => {
  state.locales = ['en', 'de'];
  readyDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/notices/en/opening.yaml',
      contents: 'title: TBD\n',
      updatedAt: 1755864000000,
      revision: 'r-en',
    },
  ]);

  const readiness = await readinessOf(
    await selecting('publish/checks', { entries: ['notices/opening'] }),
  );

  expect(readiness?.['notices/opening']?.en?.problems).toEqual([
    expect.objectContaining({ path: 'title', message: 'Replace the placeholder title' }),
  ]);
});

test('a language left out is not linted and is no destination for the links that stay', async () => {
  state.locales = ['en', 'de'];
  const drafts = [
    {
      path: 'src/content/notices/en/opening.yaml',
      contents: 'title: Opening times\ncta:\n  type: url\n  href: /de/listings/new-barn\n',
      updatedAt: 1755864000000,
    },
    {
      path: 'src/content/listings/en/new-barn.yaml',
      contents: '_source: en\ntitle: The New Barn\nrooms: 2\naddress:\n  street: Barn Lane\n',
      updatedAt: 1755864000000,
    },
    {
      path: 'src/content/listings/de/new-barn.yaml',
      contents: '_source: en\ntitle: Die neue Scheune\nrooms: 2\naddress:\n  street: Feldweg\n',
      updatedAt: 1755864000000,
    },
  ];
  const entries = ['notices/opening', 'listings/new-barn'];
  readyDrafts.mockImplementationOnce(async () => drafts);
  readyDrafts.mockImplementationOnce(async () => drafts);

  const whole = await results(await selecting('publish/checks', { entries }));
  const without = await results(
    await selecting('publish/checks', { entries, without: ['listings/new-barn:de'] }),
  );

  expect(whole).toEqual([]);
  expect(without).toEqual([
    expect.objectContaining({
      check: 'link-locale',
      path: 'src/content/notices/en/opening.yaml',
      fieldPath: 'cta.href',
    }),
  ]);
});
