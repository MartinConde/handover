import { texts } from 'virtual:handover/index';
import { RepoUnreachableError } from '@handover/core';
import type { APIContext } from 'astro';
import { afterEach, expect, test, vi } from 'vitest';
import { GET, POST } from '../api.js';
import {
  blobs,
  commitLog,
  committedBy,
  ctx,
  editor,
  entryConflict,
  fileCommits,
  files,
  getCommit,
  getFile,
  getHead,
  home,
  logged,
  owner,
  pendingDrafts,
  post,
  resetContainers,
  resetMocks,
  resetState,
  resolveConflict,
  restoreCommit,
  restoreDraft,
  revertCommit,
  rows,
  setEntryLocales,
  state,
  translated,
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

// Per-field staleness: the entry response says *which* languages are behind.
test('the fields a translation is behind on are read from the source it was made from', async () => {
  state.locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en.replace(
    'Move to the coast',
    'Move to the Cornish coast',
  );
  files['src/content/pages/de/home.yaml'] = translated;
  blobs.deadbeef = home.en;

  const body = (await (await GET(ctx('source/pages/home/de'))).json()) as {
    from: string;
    translatedAt: string;
    changed: Record<string, unknown>;
  };

  expect(body.from).toBe('en');
  expect(body.translatedAt).toBe('2026-08-20T10:14:00Z');
  expect(body.changed).toEqual({
    'blocks[_id=k3nf9a2p].heading': [
      { text: 'Move to the ' },
      { text: 'Cornish ', mark: 'ins' },
      { text: 'coast' },
    ],
  });
});

// Nothing to compare against is not an error: the marker is simply not drawn.
test('a language with no translation mark has no fields to mark', async () => {
  state.locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en;
  files['src/content/pages/de/home.yaml'] = home.de;

  expect(await (await GET(ctx('source/pages/home/de'))).json()).toEqual({ changed: {} });
});

test('a source blob git no longer holds leaves the fields unmarked', async () => {
  state.locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en;
  files['src/content/pages/de/home.yaml'] = translated;

  expect(await (await GET(ctx('source/pages/home/de'))).json()).toEqual({ changed: {} });
});

test('the source of an entry no collection has is not found', async () => {
  expect((await GET(ctx('source/nope/home/de'))).status).toBe(404);
});

// The drawer's expanded row: what one entry would put in the next commit.
test('the expanded row is the draft against the file at HEAD, redirects riding along', async () => {
  rows['src/content/listings/en/mill-house.yaml'] = {
    contents: '_version: 1\ntitle: "The Mill House"\nlocation: "Bakewell"\nrooms: 4\n',
    baseSha: 'def456',
    baseBlob: 'abc123',
    pendingRedirects: [{ from: '/listings/mill', to: '/listings/mill-house' }],
  };

  const res = await GET(ctx('diff/listings/mill-house'));

  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    groups: { locale?: string; changes: { label: string }[] }[];
    redirects: { from: string; to: string }[];
  };
  expect(body.groups.map((g) => g.locale)).toEqual(['en']);
  expect(body.groups[0]?.changes.map((c) => c.label)).toEqual(['Rooms']);
  expect(body.redirects).toEqual([{ from: '/listings/mill', to: '/listings/mill-house' }]);
});

// The three-way view behind Resolve.
test('the three-way view asks about every language of the entry', async () => {
  state.locales = ['en', 'de'];
  entryConflict.mockResolvedValue({
    head: 'commit-B',
    version: 'report-version',
    sides: {},
    conflicted: { en: { path: 'src/content/listings/en/mill-house.yaml', blob: 'b1' } },
    questions: [{ path: 'rooms', label: 'Rooms', locale: 'en', base: '3' }],
    merged: [{ label: 'Location', side: 'theirs' }],
  });

  const res = await GET(ctx('conflict/listings/mill-house'));

  expect(res.status).toBe(200);
  expect(entryConflict).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ fields: expect.anything() }),
    {
      en: 'src/content/listings/en/mill-house.yaml',
      de: 'src/content/listings/de/mill-house.yaml',
    },
  );
  expect(await res.json()).toEqual({
    head: 'commit-B',
    version: 'report-version',
    questions: [{ path: 'rooms', label: 'Rooms', locale: 'en', base: '3' }],
    merged: [{ label: 'Location', side: 'theirs' }],
    files: ['src/content/listings/en/mill-house.yaml'],
  });
});

test('a conflict somebody has already settled is refused rather than drawn', async () => {
  const res = await GET(ctx('conflict/listings/mill-house'));

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    code: 'CONFLICT_SETTLED',
    error: 'This entry has not changed in the repository since it was opened',
  });
  expect((await GET(ctx('conflict/nothing/at-all'))).status).toBe(404);
});

test('an unreachable conflict report has a stable recovery code', async () => {
  entryConflict.mockRejectedValue(new RepoUnreachableError('GitHub did not answer'));

  const res = await GET(ctx('conflict/listings/mill-house'));

  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({
    code: 'CONFLICT_REPOSITORY_UNAVAILABLE',
    error: 'GitHub did not answer',
  });
});

// Every question or none: written half-answered.
const conflicted = () => {
  entryConflict.mockResolvedValue({
    head: 'commit-B',
    version: 'report-version',
    sides: {},
    conflicted: { en: { path: 'src/content/listings/en/mill-house.yaml', blob: 'b1' } },
    questions: [
      { path: 'rooms', label: 'Rooms', locale: 'en' },
      { path: 'location', label: 'Location', locale: 'en' },
    ],
    merged: [],
  });
};
const answers = (list: unknown) =>
  post(
    'conflict/listings/mill-house',
    JSON.stringify({ answers: list, version: 'report-version' }),
  );

test('the answers to a conflict are written for the entry', async () => {
  conflicted();
  const list = [
    { path: 'rooms', locale: 'en', side: 'ours' },
    { path: 'location', locale: 'en', side: 'theirs' },
  ];

  const res = await POST(answers(list));

  expect(res.status).toBe(200);
  expect(resolveConflict).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.objectContaining({ fields: expect.anything() }),
    expect.objectContaining({ head: 'commit-B' }),
    list,
  );
});

test('a half-answered conflict is refused and nothing is written', async () => {
  conflicted();

  const res = await POST(answers([{ path: 'rooms', locale: 'en', side: 'ours' }]));

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    code: 'CONFLICT_ANSWERS_INVALID',
    error: 'Those are not the fields this entry disagrees about',
  });
  expect(resolveConflict).not.toHaveBeenCalled();
  expect(
    (
      await POST(
        answers([
          { path: 'nothing', locale: 'en', side: 'ours' },
          { path: 'rooms', locale: 'en', side: 'ours' },
        ]),
      )
    ).status,
  ).toBe(409);
  expect(resolveConflict).not.toHaveBeenCalled();
});

test('answers to an older conflict report are identified separately', async () => {
  conflicted();

  const res = await POST(
    post('conflict/listings/mill-house', JSON.stringify({ version: 'older-version', answers: [] })),
  );

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    code: 'CONFLICT_CHANGED',
    error: 'This conflict changed. Reload it and review the new values.',
  });
  expect(resolveConflict).not.toHaveBeenCalled();
});

// The query is on the url rather than in the path, so these build their context by hand.
const history = (path: string, query = '') =>
  ({
    params: { path },
    request: undefined,
    url: new URL(`https://x/admin/api/${path}${query}`),
    locals: {},
  }) as unknown as APIContext;

const EN = 'src/content/listings/en/mill-house.yaml';
const DE = 'src/content/listings/de/mill-house.yaml';

// The entry is one thing to the client even where it is a file per language.
test('history merges the language files into one list and names who published', async () => {
  state.locales = ['en', 'de'];
  commitLog[EN] = [
    { sha: 'aaa111', date: '2026-08-30T10:00:00Z', message: 'Update price\n\n- two files' },
    { sha: 'ccc333', date: '2026-08-20T10:00:00Z', message: 'Create The Mill House' },
  ];
  commitLog[DE] = [
    { sha: 'aaa111', date: '2026-08-30T10:00:00Z', message: 'Update price\n\n- two files' },
    { sha: 'bbb222', date: '2026-08-25T10:00:00Z', message: 'Translate', author: 'Martin Conde' },
  ];
  committedBy.aaa111 = 'Anna Weber';

  const res = await GET(history('history/listings/mill-house'));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    versions: [
      {
        sha: 'aaa111',
        date: '2026-08-30T10:00:00Z',
        summary: 'Update price',
        locales: ['en', 'de'],
        author: 'Anna Weber',
      },
      {
        sha: 'bbb222',
        date: '2026-08-25T10:00:00Z',
        summary: 'Translate',
        locales: ['de'],
        author: 'Martin Conde',
      },
      {
        sha: 'ccc333',
        date: '2026-08-20T10:00:00Z',
        summary: 'Create The Mill House',
        locales: ['en'],
      },
    ],
    more: false,
  });
});

// Nothing published is not an error: it is the sentence the tab says while it waits.
test('an entry with no commits has an empty history', async () => {
  const res = await GET(history('history/listings/mill-house'));

  expect(await res.json()).toEqual({ versions: [], more: false });
});

test('history refuses a collection the site does not declare', async () => {
  expect((await GET(history('history/nope/mill-house'))).status).toBe(404);
});

// A page is one request per language file, and the page after it is read from the top again.
test('a second page of history reads both files twice and reaches the older commit', async () => {
  commitLog[EN] = Array.from({ length: 31 }, (_, i) => ({
    sha: `en${i}`,
    date: new Date(Date.UTC(2026, 7, 31, 0, 0, 0) - i * 3_600_000).toISOString(),
    message: `Edit ${i}`,
  }));

  const first = (await (await GET(history('history/listings/mill-house'))).json()) as {
    versions: { sha: string }[];
    more: boolean;
  };
  expect(first.versions).toHaveLength(30);
  expect(first.more).toBe(true);

  const second = (await (await GET(history('history/listings/mill-house', '?page=2'))).json()) as {
    versions: { sha: string }[];
    more: boolean;
  };
  expect(second.versions).toHaveLength(31);
  expect(second.more).toBe(false);
  expect(fileCommits).toHaveBeenCalledWith(EN, { perPage: 30, page: 2 });
});

const OLD = 'src/content/listings/en/old-mill.yaml';

// The commit that starts a file's log is the rename that made it, when there was one.
test('history follows a rename back to the commits under the old name', async () => {
  commitLog[EN] = [
    { sha: 'aaa111', date: '2026-08-30T10:00:00Z', message: 'Update price' },
    {
      sha: 'rrr000',
      date: '2026-08-25T10:00:00Z',
      message: 'Rename listings/old-mill to mill-house',
    },
  ];
  commitLog[OLD] = [
    {
      sha: 'rrr000',
      date: '2026-08-25T10:00:00Z',
      message: 'Rename listings/old-mill to mill-house',
    },
    { sha: 'ooo999', date: '2026-08-20T10:00:00Z', message: 'Create The Old Mill' },
  ];

  const body = (await (await GET(history('history/listings/mill-house'))).json()) as {
    versions: { sha: string; locales: string[]; name?: string }[];
    more: boolean;
  };

  expect(body.versions.map((v) => [v.sha, v.locales, v.name])).toEqual([
    ['aaa111', ['en'], undefined],
    ['rrr000', ['en'], undefined],
    ['ooo999', ['en'], 'old-mill'],
  ]);
  expect(body.more).toBe(false);
});

test('a version from before a rename is diffed from the files under its old name', async () => {
  files[`abc1234:${OLD}`] = 'title: The Old Mill\nlocation: Bakewell\nrooms: 3\n';

  const res = await GET(history('history/listings/mill-house/diff', '?to=abc1234&name=old-mill'));

  expect(res.status).toBe(200);
  const { groups } = (await res.json()) as { groups: { changes: { path: string }[] }[] };
  expect(groups.flatMap((g) => g.changes.map((c) => c.path))).toEqual(['title']);
  expect(getFile).toHaveBeenCalledWith(OLD, 'abc1234');
});

test('a diff refuses a name that is not one', async () => {
  const res = await GET(history('history/listings/mill-house/diff', '?to=abc1234&name=../etc'));

  expect(res.status).toBe(400);
});

// What is marked is what restoring this version would change.
test('a version is diffed against what is live now', async () => {
  files[`abc1234:${EN}`] = 'title: The Mill House\nlocation: Bakewell\nrooms: 2\n';
  files[EN] = 'title: The Mill House\nlocation: Bakewell\nrooms: 3\n';

  const res = await GET(history('history/listings/mill-house/diff', '?to=abc1234'));

  expect(res.status).toBe(200);
  const { groups } = (await res.json()) as {
    groups: { locale?: string; changes: { label: string; before?: string; after?: string }[] }[];
  };
  expect(groups.flatMap((g) => g.changes)).toEqual([
    { path: 'rooms', label: 'Rooms', kind: 'value', before: '3', after: '2' },
  ]);
  expect(getFile).toHaveBeenCalledWith(EN, 'head789');
});

test('two versions are diffed against each other rather than against the branch', async () => {
  getHead.mockClear();
  files[`abc1234:${EN}`] = 'title: The Mill House\nlocation: Bakewell\nrooms: 2\n';
  files[`def5678:${EN}`] = 'title: The Mill House\nlocation: Bakewell\nrooms: 4\n';

  const res = await GET(history('history/listings/mill-house/diff', '?from=abc1234&to=def5678'));

  const { groups } = (await res.json()) as { groups: { changes: { after?: string }[] }[] };
  expect(groups.flatMap((g) => g.changes.map((c) => c.after))).toEqual(['4']);
  expect(getHead).not.toHaveBeenCalled();
});

// The log's publish row, opened: the commit against the commit it was made on, one entry at a time.
test('a publish is diffed against its parent, one entry at a time', async () => {
  getCommit.mockResolvedValueOnce({
    sha: 'def5678',
    parent: 'abc1234',
    message: 'Update listings/en/mill-house',
    paths: [EN, 'src/content/redirects.yaml'],
  });
  files[`abc1234:${EN}`] = 'title: The Mill House\nlocation: Bakewell\nrooms: 2\n';
  files[`def5678:${EN}`] = 'title: The Mill House\nlocation: Bakewell\nrooms: 4\n';

  const res = await activityDiff('?sha=def5678', owner);

  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    entries: { key: string; groups: { changes: unknown[] }[] }[];
    more: number;
  };
  expect(body.entries.map((e) => e.key)).toEqual(['listings/mill-house']);
  expect(body.entries[0]?.groups.flatMap((g) => g.changes)).toEqual([
    { path: 'rooms', label: 'Rooms', kind: 'value', before: '2', after: '4' },
  ]);
  expect(body.more).toBe(0);
  expect(getFile).toHaveBeenCalledWith(EN, 'abc1234');
  expect(getFile).toHaveBeenCalledWith(EN, 'def5678');
});

test('a publish diff needs a session and a commit', async () => {
  expect((await activityDiff('?sha=def5678')).status).toBe(401);
  expect((await activityDiff('?sha=../../etc', owner)).status).toBe(400);
});

const activityDiff = (query: string, session?: unknown) =>
  GET({
    params: { path: 'activity/diff' },
    request: undefined,
    url: new URL(`https://x/admin/api/activity/diff${query}`),
    locals: { handover: session },
  } as unknown as APIContext);

test('a version diff of something that is not a commit is refused', async () => {
  const res = await GET(history('history/listings/mill-house/diff', '?to=../../etc'));

  expect(res.status).toBe(400);
});

// Restoring is a draft write and never a rewrite of git.
const restoring = (path: string, body: unknown, session: unknown = editor) =>
  POST(
    ctx(
      path,
      new Request(`https://x/admin/api/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      { handover: session },
    ),
  );

test('restoring a version hands core the entry as that commit had it, language by language', async () => {
  state.locales = ['en', 'de'];
  files[`abc1234:${EN}`] = 'title: The Mill House\nlocation: Bakewell\nrooms: 2\n';
  files[`abc1234:${DE}`] = 'title: Das Mühlenhaus\nrooms: 2\n';
  restoreDraft.mockResolvedValueOnce({ paths: [EN, DE] });

  const res = await restoring('history/listings/mill-house/restore', { commit_sha: 'abc1234' });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ paths: [EN, DE] });
  expect(restoreDraft.mock.calls[0]?.[4]).toEqual([
    { path: EN, entry: { _version: 1, title: 'The Mill House', location: 'Bakewell', rooms: 2 } },
    { path: DE, entry: { _version: 1, title: 'Das Mühlenhaus', rooms: 2 } },
  ]);
});

// Restoring across a rename keeps the entry's current name.
test('restoring a version from before a rename reads the old name and writes the current one', async () => {
  files[`abc1234:${OLD}`] = 'title: The Old Mill\nrooms: 2\n';
  restoreDraft.mockResolvedValueOnce({ paths: [EN] });

  const res = await restoring('history/listings/mill-house/restore', {
    commit_sha: 'abc1234',
    name: 'old-mill',
  });

  expect(res.status).toBe(200);
  expect(restoreDraft.mock.calls[0]?.[4]).toEqual([
    { path: EN, entry: { _version: 1, title: 'The Old Mill', rooms: 2 } },
  ]);
});

test('a restore refuses a name that is not one', async () => {
  const res = await restoring('history/listings/mill-house/restore', {
    commit_sha: 'abc1234',
    name: '../etc',
  });

  expect(res.status).toBe(400);
  expect(restoreDraft).not.toHaveBeenCalled();
});

// A restore writes over whatever unpublished changes the entry had.
test('restoring a version over unpublished changes leaves a draft-discard row', async () => {
  files[`abc1234:${EN}`] = 'title: The Mill House\n';
  restoreDraft.mockResolvedValueOnce({ paths: [EN] });

  await restoring('history/listings/mill-house/restore', { commit_sha: 'abc1234' });

  expect(logged).toEqual([
    {
      userId: 'u2',
      kind: 'draft-discard',
      subject: EN,
      detail: { locales: ['en'], restore: 'abc1234' },
    },
  ]);
});

test('restoring a version over nothing pending writes no row', async () => {
  files[`abc1234:${EN}`] = 'title: The Mill House\n';
  pendingDrafts.mockResolvedValueOnce([]);
  restoreDraft.mockResolvedValueOnce({ paths: [EN] });

  await restoring('history/listings/mill-house/restore', { commit_sha: 'abc1234' });

  expect(logged).toEqual([]);
});

// A language the version has no file for is not in the hand-over at all.
test('a language the version has no file for is not restored', async () => {
  state.locales = ['en', 'de'];
  files[`abc1234:${EN}`] = 'title: The Mill House\nrooms: 2\n';

  await restoring('history/listings/mill-house/restore', { commit_sha: 'abc1234' });

  expect(restoreDraft.mock.calls[0]?.[4]).toEqual([
    { path: EN, entry: { _version: 1, title: 'The Mill House', rooms: 2 } },
  ]);
});

test('restoring a version of an entry that commit does not have is refused', async () => {
  const res = await restoring('history/listings/barn/restore', { commit_sha: 'abc1234' });

  expect(res.status).toBe(409);
  expect(restoreDraft).not.toHaveBeenCalled();
});

test('a restore of something that is not a commit is refused', async () => {
  const res = await restoring('history/listings/mill-house/restore', { commit_sha: '../../etc' });

  expect(res.status).toBe(400);
  expect(restoreDraft).not.toHaveBeenCalled();
});

// The one write on this screen, so it owes the same refusal every other entry-wide write gives.
test('a restore is refused while somebody else has the entry open', async () => {
  files[`abc1234:${EN}`] = 'title: The Mill House\nrooms: 2\n';
  state.holder = { userId: 'u9', name: 'Anna', expiresAt: 1755864120000 };

  const res = await restoring('history/listings/mill-house/restore', { commit_sha: 'abc1234' });

  expect(res.status).toBe(409);
  expect(await res.text()).toBe(
    'Anna is editing this entry — it can be restored once they are done',
  );
  expect(restoreDraft).not.toHaveBeenCalled();
});

// A file written by a newer package than this one is migrated forward by nobody.
test('a version this package cannot read is refused with the reason', async () => {
  files[`abc1234:${EN}`] = '_version: 99\ntitle: The Mill House\nrooms: 2\n';

  const res = await restoring('history/listings/mill-house/restore', { commit_sha: 'abc1234' });

  expect(res.status).toBe(409);
  expect(await res.text()).toContain('newer than this package knows');
  expect(restoreDraft).not.toHaveBeenCalled();
});

// `formFor` takes the address out of the form the client types into.
test('a restore writes the address where the schema puts it', async () => {
  files['abc1234:src/content/posts/en/hello.yaml'] = 'title: Hello\nslug: hallo\n';

  await restoring('history/posts/hello/restore', { commit_sha: 'abc1234' });

  const form = restoreDraft.mock.calls[0]?.[3] as { fields: { path: string[] }[] };
  expect(form.fields.map((f) => f.path[0])).toEqual(['title', 'slug', 'seo']);
});

test('a restore of a collection the site does not declare is a 404', async () => {
  expect(
    (await restoring('history/nope/mill-house/restore', { commit_sha: 'abc1234' })).status,
  ).toBe(404);
});

test('restoring waits for the editor who has the entry open', async () => {
  restoreCommit.mockClear();
  state.holder = { userId: 'someone-else', name: 'Anna Berg', expiresAt: 1755864120000 };

  const res = await POST(post('restore', JSON.stringify({ commit_sha: 'del111' })));

  expect(res.status).toBe(409);
  expect(await res.text()).toBe(
    'Anna Berg is editing this entry — it can be restored once they are done',
  );
  expect(restoreCommit).not.toHaveBeenCalled();
});

test('revert undoes the commit the body names and logs it', async () => {
  const session = { user: { id: 'u1', name: 'Anna', email: 'a@x' }, role: 'editor' };
  const res = await POST(
    ctx(
      'revert',
      new Request('https://x/admin/api/revert', {
        method: 'POST',
        body: JSON.stringify({ commit_sha: 'def456' }),
      }),
      { handover: session },
    ),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    commit_sha: 'rev999',
    paths: ['src/content/listings/en/mill-house.yaml'],
  });
  expect(revertCommit).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'def456',
    expect.any(Function),
    false,
    { userId: 'u1' },
  );
  expect(logged.at(-1)).toMatchObject({
    kind: 'revert',
    commitSha: 'rev999',
    detail: { of: 'def456' },
  });
});

test('restore undoes the commit the body names and says so in the log', async () => {
  const res = await POST(post('restore', JSON.stringify({ commit_sha: 'del111' })));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    commit_sha: 'res888',
    paths: ['src/content/listings/en/mill-house.yaml'],
  });
  expect(restoreCommit).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    'del111',
    expect.any(Function),
    { userId: undefined },
  );
  // The same kind a revert writes — it is the same inverse commit — with what it was over.
  expect(logged.at(-1)).toMatchObject({
    kind: 'revert',
    subject: 'src/content/listings/en/mill-house.yaml',
    detail: { of: 'del111', restore: true },
    commitSha: 'res888',
  });
});

// A language that stays and has only a draft behind it was never in the turn-off commit.
test('restoring writes the offer back into a language that has only a draft', async () => {
  state.locales = ['en', 'de', 'fr'];
  files['src/content/listings/de/mill-house.yaml'] = '_version: 1\ntitle: "Die Muehle"\n';
  rows['src/content/listings/fr/mill-house.yaml'] = {
    contents: '_version: 1\n_locales:\n  - "en"\n  - "fr"\ntitle: "Le Moulin"\n',
    baseSha: 'head789',
    baseBlob: '',
  };
  setEntryLocales.mockClear();

  await POST(post('restore', JSON.stringify({ commit_sha: 'off222' })));

  // The restored files say every language is offered again, and the draft is brought into line.
  expect(setEntryLocales).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    ['src/content/listings/fr/mill-house.yaml'],
    ['en', 'de', 'fr'],
    ['en', 'de', 'fr'],
  );
});

test('restore with no commit named is refused', async () => {
  const res = await POST(post('restore', '{}'));
  expect(res.status).toBe(400);
  expect(restoreCommit).not.toHaveBeenCalled();
});

test('revert with no commit named is refused', async () => {
  const res = await POST(post('revert', '{}'));
  expect(res.status).toBe(400);
  expect(revertCommit).not.toHaveBeenCalled();
});

// The one thing an inverse composed against HEAD cannot decide on its own.
test('revert is 409 naming the file that has moved on since', async () => {
  const { RevertConflictError } = await import('@handover/core');
  revertCommit.mockImplementationOnce(async () => {
    throw new RevertConflictError(['src/content/listings/en/mill-house.yaml']);
  });
  const res = await POST(post('revert', JSON.stringify({ commit_sha: 'def456' })));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error:
      'src/content/listings/en/mill-house.yaml has changed since that commit, so it cannot be put back',
    paths: ['src/content/listings/en/mill-house.yaml'],
  });
});
