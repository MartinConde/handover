import { expect, test } from 'vitest';
import {
  blobSha,
  createGitClient,
  mergeFileCommits,
  RefMovedError,
  RepoUnreachableError,
} from './git.js';

// A real key pair so the fake token endpoint can verify the JWT the client signs.
const keys = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString(
  'base64',
);
const privateKey = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----\n`;

const app = { appId: '12345', privateKey, installationId: '67890', owner: 'acme', repo: 'site' };

async function verifyJwt(header: string | null): Promise<{ iss: string; exp: number }> {
  const jwt = header?.replace(/^Bearer /, '') ?? '';
  const [h, p, s] = jwt.split('.');
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    keys.publicKey,
    Buffer.from(s ?? '', 'base64url'),
    Buffer.from(`${h}.${p}`),
  );
  if (!ok) throw new Error('bad signature');
  return JSON.parse(Buffer.from(p ?? '', 'base64url').toString());
}

// A fake GitHub: mints a token when the JWT verifies, serves one file, records every call.
// `visible: false` is a repository outside the installation — GitHub 404s every path of it,
// the repository itself included.
function fakeGitHub(
  files: Record<string, string>,
  visible = true,
  commits: Record<string, unknown> = {},
  log: Record<string, unknown[]> = {},
) {
  const calls: string[] = [];
  let minted = 0;
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const auth = new Headers(init.headers).get('authorization');
    calls.push(`${init.method ?? 'GET'} ${url}`);
    if (url === 'https://api.github.com/app/installations/67890/access_tokens') {
      const claims = await verifyJwt(auth);
      if (claims.iss !== '12345') return new Response('{}', { status: 401 });
      minted += 1;
      return Response.json(
        {
          token: `ghs_${minted}`,
          expires_at: new Date(claims.exp * 1000 + 3_000_000).toISOString(),
        },
        { status: 201 },
      );
    }
    if (auth !== `token ghs_${minted}`) return new Response('{}', { status: 401 });
    if (!visible) return new Response('{"message":"Not Found"}', { status: 404 });
    if (url === 'https://api.github.com/repos/acme/site')
      return Response.json({ full_name: 'acme/site' });
    const listed = url.match(/^https:\/\/api\.github\.com\/repos\/acme\/site\/commits\?(.+)$/)?.[1];
    if (listed) {
      const query = new URLSearchParams(listed);
      const per = Number(query.get('per_page'));
      const page = Number(query.get('page'));
      const all = (log[query.get('path') ?? ''] ?? []) as unknown[];
      return Response.json(all.slice((page - 1) * per, page * per));
    }
    const commit = url.match(/^https:\/\/api\.github\.com\/repos\/acme\/site\/commits\/(.+)$/)?.[1];
    if (commit) {
      const found = commits[commit];
      return found
        ? Response.json(found)
        : new Response('{"message":"Not Found"}', { status: 404 });
    }
    const m = url.match(
      /^https:\/\/api\.github\.com\/repos\/acme\/site\/contents\/(.+)\?ref=(.+)$/,
    );
    const name = decodeURIComponent(m?.[1] ?? '');
    const body = files[name];
    if (body === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
    return Response.json({
      sha: `sha-of-${name}`,
      encoding: 'base64',
      content: `${Buffer.from(body).toString('base64').slice(0, 10)}\n${Buffer.from(body).toString('base64').slice(10)}\n`,
    });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, minted: () => minted };
}

test('getFile returns decoded contents and the blob sha', async () => {
  const gh = fakeGitHub({ 'src/content/listings/en/mill-house.yaml': 'title: Mühlenhaus\n' });
  const git = createGitClient('default', app, { fetch: gh.fetch });

  const file = await git.getFile('src/content/listings/en/mill-house.yaml');

  expect(file).toEqual({
    contents: 'title: Mühlenhaus\n',
    blob_sha: 'sha-of-src/content/listings/en/mill-house.yaml',
  });
});

// The read a publish makes. A branch is a name the API answers from a cache, so a set of reads
// of one is not a snapshot; a commit is immutable and reading one is.
test('getFile reads the commit it is given rather than the branch', async () => {
  const gh = fakeGitHub({ 'src/content/listings/en/mill-house.yaml': 'title: Mühlenhaus\n' });
  const git = createGitClient('default', app, { fetch: gh.fetch });

  await git.getFile('src/content/listings/en/mill-house.yaml', 'a1b2c3d');

  expect(gh.calls).toContain(
    'GET https://api.github.com/repos/acme/site/contents/src/content/listings/en/mill-house.yaml?ref=a1b2c3d',
  );
});

test('getFile returns undefined for a missing path', async () => {
  const gh = fakeGitHub({});
  const git = createGitClient('default', app, { fetch: gh.fetch });

  expect(await git.getFile('nope.yaml')).toBeUndefined();
});

test('getFile names the repository when the App cannot see it', async () => {
  const gh = fakeGitHub({}, false);
  const git = createGitClient('default', app, { fetch: gh.fetch });

  await expect(git.getFile('src/content/listings/en/mill-house.yaml')).rejects.toThrow(
    new RepoUnreachableError(
      'The GitHub App cannot see acme/site. Add the repository to installation 67890, or correct the repository name.',
    ),
  );
});

test('getHead names the repository too, rather than reporting a 404', async () => {
  const gh = fakeGitHub({}, false);
  const git = createGitClient('default', app, { fetch: gh.fetch });

  await expect(git.getHead()).rejects.toBeInstanceOf(RepoUnreachableError);
});

test('the repository is asked for once, however many paths answer 404', async () => {
  const gh = fakeGitHub({}, false);
  const git = createGitClient('default', app, { fetch: gh.fetch });

  await Promise.all([
    git.getFile('a.yaml').catch(() => {}),
    git.getFile('b.yaml').catch(() => {}),
    git.getHead().catch(() => {}),
  ]);

  expect(gh.calls.filter((c) => c === 'GET https://api.github.com/repos/acme/site')).toHaveLength(
    1,
  );
});

test('getFile throws on any other GitHub error', async () => {
  const fetch = (async () =>
    new Response('{"message":"boom"}', { status: 500 })) as typeof globalThis.fetch;
  const git = createGitClient('default', app, { fetch });

  await expect(git.getFile('a.yaml')).rejects.toThrow(/500/);
});

test('the installation token is minted once and reused while valid', async () => {
  const gh = fakeGitHub({ 'a.yaml': 'a', 'b.yaml': 'b' });
  const git = createGitClient('default', app, { fetch: gh.fetch });

  await git.getFile('a.yaml');
  await git.getFile('b.yaml');

  expect(gh.minted()).toBe(1);
});

test('an expired installation token is minted again', async () => {
  const gh = fakeGitHub({ 'a.yaml': 'a' });
  let now = Date.parse('2026-08-21T10:00:00Z');
  const git = createGitClient('default', app, { fetch: gh.fetch, now: () => now });

  await git.getFile('a.yaml');
  now += 2 * 60 * 60 * 1000;
  await git.getFile('a.yaml');

  expect(gh.minted()).toBe(2);
});

// A fake Git Data API over one branch: records the ref PATCH body so a test can prove
// the update is never forced, and moves the head underneath the client when asked.
function fakeGitData(opts: { headMovesTo?: string } = {}) {
  const bodies: Record<string, unknown> = {};
  let minted = 0;
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const path = url.replace('https://api.github.com', '');
    if (path === '/app/installations/67890/access_tokens') {
      minted += 1;
      return Response.json({ token: 'ghs_1', expires_at: '2099-01-01T00:00:00Z' }, { status: 201 });
    }
    if (init.body) bodies[`${init.method} ${path}`] = JSON.parse(String(init.body));
    if (path === '/repos/acme/site/git/ref/heads%2Fmain')
      return Response.json({ object: { sha: opts.headMovesTo ?? 'commit-A' } });
    if (path === '/repos/acme/site/git/commits/commit-A')
      return Response.json({ sha: 'commit-A', tree: { sha: 'tree-A' } });
    if (path === '/repos/acme/site/git/trees')
      return Response.json({ sha: 'tree-B' }, { status: 201 });
    if (path === '/repos/acme/site/git/commits')
      return Response.json({ sha: 'commit-B' }, { status: 201 });
    if (path === '/repos/acme/site/git/refs/heads%2Fmain') {
      if (opts.headMovesTo)
        return Response.json({ message: 'Update is not a fast forward' }, { status: 422 });
      return Response.json({ object: { sha: 'commit-B' } });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, bodies, minted: () => minted };
}

test('getHead returns the branch commit sha', async () => {
  const gh = fakeGitData();
  const git = createGitClient('default', app, { fetch: gh.fetch });

  expect(await git.getHead()).toBe('commit-A');
});

test('publish builds the tree on base_tree, parents the commit on base_sha and never forces the ref', async () => {
  const gh = fakeGitData();
  const git = createGitClient('default', app, { fetch: gh.fetch });

  const result = await git.publish([{ path: 'src/content/a.yaml', contents: 'title: A\n' }], {
    base_sha: 'commit-A',
    message: 'Update A',
  });

  expect(result).toEqual({ commit_sha: 'commit-B' });
  expect(gh.bodies['POST /repos/acme/site/git/trees']).toEqual({
    base_tree: 'tree-A',
    tree: [{ path: 'src/content/a.yaml', mode: '100644', type: 'blob', content: 'title: A\n' }],
  });
  expect(gh.bodies['POST /repos/acme/site/git/commits']).toEqual({
    message: 'Update A',
    tree: 'tree-B',
    parents: ['commit-A'],
  });
  expect(gh.bodies['PATCH /repos/acme/site/git/refs/heads%2Fmain']).toEqual({
    sha: 'commit-B',
    force: false,
  });
  expect(gh.minted()).toBe(1);
});

test('publish removes a file with a null-sha tree entry', async () => {
  const gh = fakeGitData();
  const git = createGitClient('default', app, { fetch: gh.fetch });

  await git.publish([{ path: 'src/content/a.yaml', contents: null }], {
    base_sha: 'commit-A',
    message: 'Delete A',
  });

  expect(gh.bodies['POST /repos/acme/site/git/trees']).toEqual({
    base_tree: 'tree-A',
    tree: [{ path: 'src/content/a.yaml', mode: '100644', type: 'blob', sha: null }],
  });
});

test('publish throws RefMovedError when the branch moved past base_sha', async () => {
  const gh = fakeGitData({ headMovesTo: 'commit-X' });
  const git = createGitClient('default', app, { fetch: gh.fetch });

  await expect(
    git.publish([{ path: 'a.yaml', contents: 'a' }], { base_sha: 'commit-A', message: 'm' }),
  ).rejects.toBeInstanceOf(RefMovedError);
});

// Oracle: `git hash-object`. The length in the header is bytes, so `£` counts as two.
test('blobSha is the git object id of the file contents', async () => {
  expect(await blobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  expect(await blobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  expect(await blobSha('£')).toBe('3048c9ab8389e833f2b95ef09b7e305a9df2e2b6');
});

// Undoing a commit has to write every path it touched, and GitHub reports a rename as one entry
// carrying both of its names: taking `filename` alone would remove the new path and never put
// the old one back.
test('getCommit names the parent and both names of a rename', async () => {
  const gh = fakeGitHub({}, true, {
    c0ffee11: {
      sha: 'c0ffee11',
      parents: [{ sha: 'beef2233' }],
      commit: { message: 'Rename the Mill House' },
      files: [
        {
          filename: 'src/content/listings/en/mill-house.yaml',
          status: 'renamed',
          previous_filename: 'src/content/listings/en/the-mill.yaml',
        },
        { filename: 'src/content/redirects.yaml', status: 'modified' },
      ],
    },
  });
  const git = createGitClient('default', app, { fetch: gh.fetch });

  expect(await git.getCommit('c0ffee11')).toEqual({
    sha: 'c0ffee11',
    parent: 'beef2233',
    message: 'Rename the Mill House',
    paths: [
      'src/content/listings/en/mill-house.yaml',
      'src/content/listings/en/the-mill.yaml',
      'src/content/redirects.yaml',
    ],
  });
});

// A fake GraphQL endpoint that answers the nested tree query from a flat map of paths, so a
// test states the repository as paths and the walk is what is under test.
function fakeGraphQL(files: Record<string, string | null>, opts: { truncated?: string } = {}) {
  const queries: string[] = [];
  // The query asks three levels deep, so a folder below that comes back as neither — which is
  // what GraphQL answers when a node matches none of the fragments asked for.
  const tree = (prefix: string, depth = 3): unknown => {
    if (depth === 0) return {};
    const names = new Set<string>();
    for (const path of Object.keys(files))
      if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split('/')[0] ?? '');
    return {
      entries: [...names].map((name) => {
        const at = `${prefix}${name}`;
        return {
          name,
          object:
            at in files
              ? { text: files[at], isTruncated: opts.truncated === at }
              : tree(`${at}/`, depth - 1),
        };
      }),
    };
  };
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url.endsWith('/access_tokens'))
      return Response.json({ token: 'ghs_1', expires_at: '2099-01-01T00:00:00Z' }, { status: 201 });
    if (url === 'https://api.github.com/graphql') {
      queries.push(JSON.parse(String(init.body)).query);
      return Response.json({ data: { repository: { object: tree('src/content/') } } });
    }
    return new Response('{"message":"Not Found"}', { status: 404 });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, queries };
}

test('contentFiles reads every yaml under src/content in one request', async () => {
  const gh = fakeGraphQL({
    'src/content/redirects.yaml': 'rules: []\n',
    'src/content/listings/en/mill-house.yaml': 'title: The Mill House\n',
    'src/content/listings/de/mill-house.yaml': 'title: Mühlenhaus\n',
    'src/content/_templates/listings/holiday-let.yaml': 'title: New let\n',
    'src/content/schemas.ts': 'export const x = 1\n',
  });
  const git = createGitClient('default', app, { fetch: gh.fetch });

  const files = await git.contentFiles();

  expect(files.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
    { path: 'src/content/_templates/listings/holiday-let.yaml', contents: 'title: New let\n' },
    { path: 'src/content/listings/de/mill-house.yaml', contents: 'title: Mühlenhaus\n' },
    { path: 'src/content/listings/en/mill-house.yaml', contents: 'title: The Mill House\n' },
    { path: 'src/content/redirects.yaml', contents: 'rules: []\n' },
  ]);
  expect(gh.queries).toHaveLength(1);
});

// Whatever this is read for is a decision about the whole tree, so half a file is not an
// answer: it is refused rather than reported as a file that happens not to say anything.
// The build refuses a content file deeper than this, so a repository that builds has nothing
// below what the query asks for — and a folder the walk cannot see into is refused rather than
// stepped over, because a file nobody read is a file nobody counted.
test('contentFiles refuses a folder deeper than an entry may live at', async () => {
  const gh = fakeGraphQL({ 'src/content/listings/en/deeper/nope.yaml': 'title: No\n' });
  const git = createGitClient('default', app, { fetch: gh.fetch });

  await expect(git.contentFiles()).rejects.toThrow(/deeper/);
});

test('contentFiles refuses a file GitHub would only answer in part', async () => {
  const gh = fakeGraphQL(
    { 'src/content/listings/en/mill-house.yaml': 'title: The' },
    { truncated: 'src/content/listings/en/mill-house.yaml' },
  );
  const git = createGitClient('default', app, { fetch: gh.fetch });

  await expect(git.contentFiles()).rejects.toThrow(/mill-house\.yaml/);
});

const logged = (
  sha: string,
  date: string,
  message: string,
  who?: { name: string; bot?: true },
) => ({
  sha,
  commit: { message, author: { name: who?.name ?? 'handover[bot]', date } },
  author: who && !who.bot ? { type: 'User' } : { type: 'Bot' },
});

test('fileCommits reads one path of the branch and names only a person', async () => {
  const gh = fakeGitHub(
    {},
    true,
    {},
    {
      'src/content/listings/en/mill-house.yaml': [
        logged('aaa', '2026-08-30T10:00:00Z', 'Update price\n\n- one file', {
          name: 'Martin Conde',
        }),
        logged('bbb', '2026-08-29T10:00:00Z', 'Update listings/en/mill-house'),
      ],
    },
  );
  const git = createGitClient('default', app, { fetch: gh.fetch });

  const commits = await git.fileCommits('src/content/listings/en/mill-house.yaml');

  expect(commits).toEqual([
    {
      sha: 'aaa',
      date: '2026-08-30T10:00:00Z',
      message: 'Update price\n\n- one file',
      author: 'Martin Conde',
    },
    { sha: 'bbb', date: '2026-08-29T10:00:00Z', message: 'Update listings/en/mill-house' },
  ]);
  expect(gh.calls.at(-1)).toContain(
    'commits?path=src%2Fcontent%2Flistings%2Fen%2Fmill-house.yaml&sha=main&per_page=30&page=1',
  );
});

const page = (locale: string, commits: { sha: string; date: string }[], more = false) => ({
  locale,
  commits: commits.map((c) => ({ ...c, message: `Update ${c.sha}` })),
  more,
});

// One commit that wrote both language files is one version of the entry, and it says so.
test('mergeFileCommits makes one version of a commit both languages carry', () => {
  const merged = mergeFileCommits([
    page('en', [
      { sha: 'aaa', date: '2026-08-30T10:00:00Z' },
      { sha: 'ccc', date: '2026-08-28T10:00:00Z' },
    ]),
    page('de', [{ sha: 'aaa', date: '2026-08-30T10:00:00Z' }]),
  ]);

  expect(merged.versions.map((v) => [v.sha, v.locales])).toEqual([
    ['aaa', ['en', 'de']],
    ['ccc', ['en']],
  ]);
  expect(merged.more).toBe(false);
});

// The pages are read per path, so the German file's own commits are not in the English page at
// all: merging past where a still-unfinished page ends would leave a hole nobody could see.
test('mergeFileCommits cuts the list where the shallowest unfinished page ends', () => {
  const merged = mergeFileCommits([
    page(
      'en',
      [
        { sha: 'aaa', date: '2026-08-30T10:00:00Z' },
        { sha: 'bbb', date: '2026-08-20T10:00:00Z' },
      ],
      true,
    ),
    page('de', [{ sha: 'ddd', date: '2026-08-25T10:00:00Z' }], true),
  ]);

  expect(merged.versions.map((v) => v.sha)).toEqual(['aaa', 'ddd']);
  expect(merged.more).toBe(true);
});

// A German-only commit older than every English one is still this entry's history, and nothing
// is left to fetch that could push it out of place.
test('mergeFileCommits keeps a commit only one language has when every page is finished', () => {
  const merged = mergeFileCommits([
    page('en', [{ sha: 'aaa', date: '2026-08-30T10:00:00Z' }]),
    page('de', [{ sha: 'ddd', date: '2026-07-01T10:00:00Z' }]),
  ]);

  expect(merged.versions.map((v) => v.sha)).toEqual(['aaa', 'ddd']);
});
