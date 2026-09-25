import { parseEntry } from '@handover/core';
import { expect, test, vi } from 'vitest';
import { DELETE, GET, POST, PUT } from '../api.js';
import { ctx, files, logged, owner, pendingDrafts, post, publish, put } from './harness.fixture.js';

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

// Manual redirect rules use redirects.yaml.

const RULES = (...rules: string[]) => `_version: 1\nrules:\n${rules.join('')}`;
const yamlRule = (id: string, from: string, to: string, reason = 'manual', entry?: string) =>
  `  - _id: "${id}"\n    from: "${from}"\n    to: "${to}"\n    status: 301\n    reason: "${reason}"\n${entry ? `    entry: "${entry}"\n` : ''}    createdAt: "2026-01-01T00:00:00Z"\n`;
const committed = () =>
  parseEntry(
    'default',
    ((publish.mock.calls.at(-1)?.[0] ?? []) as { path: string; contents: string }[]).find(
      (f) => f.path === 'src/content/redirects.yaml',
    )?.contents ?? '',
  ) as { rules: { _id: string; from: string; to: string; status: number }[] };

test('the redirects table is the file, and a rule waiting on a draft is flagged', async () => {
  files['src/content/redirects.yaml'] = RULES(
    yamlRule('aaaaaaaa', '/old-mill', '/listings/mill-house', 'slug-change', 'listings/mill-house'),
  );
  pendingDrafts.mockImplementationOnce(async () => [
    {
      path: 'src/content/listings/en/mill-house.yaml',
      contents: '',
      updatedAt: 1,
      pendingRedirects: [
        {
          _id: 'bbbbbbbb',
          from: '/listings/mill-house',
          to: '/listings',
          status: 301,
          reason: 'hidden',
          entry: 'listings/mill-house',
          createdAt: '2026-08-30T00:00:00Z',
        },
      ],
    },
  ]);

  const res = await GET(ctx('redirects', undefined, { handover: owner }));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    rules: [
      {
        _id: 'aaaaaaaa',
        from: '/old-mill',
        to: '/listings/mill-house',
        status: 301,
        reason: 'slug-change',
        entry: 'listings/mill-house',
        createdAt: '2026-01-01T00:00:00Z',
        // Resolve titles here because only the build index has them.
        title: 'The Mill House',
      },
      {
        _id: 'bbbbbbbb',
        from: '/listings/mill-house',
        to: '/listings',
        status: 301,
        reason: 'hidden',
        entry: 'listings/mill-house',
        createdAt: '2026-08-30T00:00:00Z',
        title: 'The Mill House',
        pending: true,
      },
    ],
  });
});

test('a manual rule is committed as it is added, on its own', async () => {
  files['src/content/redirects.yaml'] = RULES(yamlRule('aaaaaaaa', '/old', '/new'));

  const res = await POST(
    post('redirects', JSON.stringify({ from: '/summer-offer', to: '/listings', status: 302 })),
  );

  expect(res.status).toBe(200);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish.mock.calls[0]?.[1]).toEqual({
    base_sha: 'head789',
    message: expect.stringContaining('Add redirect /summer-offer'),
  });
  expect(((publish.mock.calls[0]?.[0] ?? []) as { path: string }[]).map((f) => f.path)).toEqual([
    'src/content/redirects.yaml',
  ]);
  expect(committed().rules.at(-1)).toEqual({
    _id: expect.stringMatching(/^[0-9a-z]{8}$/),
    from: '/summer-offer',
    to: '/listings',
    status: 302,
    reason: 'manual',
    createdAt: expect.stringMatching(/Z$/),
  });
});

test('a manual rule cannot inject another redirects line', async () => {
  const res = await POST(
    post(
      'redirects',
      JSON.stringify({
        from: '/old\n/shadow https://outside.example 302\n/another',
        to: '/new',
      }),
    ),
  );

  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    field: 'from',
    message: 'An old address cannot contain spaces or control characters.',
    descriptor: { code: 'REDIRECT_FROM_WHITESPACE' },
  });
  expect(publish).not.toHaveBeenCalled();
});

// The refusal that matters: a redirect over a page that exists takes that page off the site.
test('a rule over a page the site serves is refused by the page it would hide', async () => {
  const res = await POST(
    post('redirects', JSON.stringify({ from: '/listings/mill-house', to: '/listings' })),
  );

  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    field: 'from',
    message: 'This is a real page. A redirect here would hide The Mill House from visitors.',
    descriptor: { code: 'REDIRECT_SHADOWS_PAGE', page: 'The Mill House' },
  });
  expect(publish).not.toHaveBeenCalled();
});

test("a rule over a collection's index is refused by the index it would hide", async () => {
  const res = await POST(post('redirects', JSON.stringify({ from: '/listings', to: '/' })));

  expect(res.status).toBe(422);
  expect(((await res.json()) as { message: string }).message).toBe(
    'This is a real page. A redirect here would hide the listings index from visitors.',
  );
});

test('adding a rule from an address that already forwards points the old rule at the new one', async () => {
  files['src/content/redirects.yaml'] = RULES(yamlRule('aaaaaaaa', '/a', '/b'));

  expect((await POST(post('redirects', JSON.stringify({ from: '/b', to: '/c' })))).status).toBe(
    200,
  );

  expect(committed().rules.map((r) => [r._id, r.from, r.to])).toEqual([
    ['aaaaaaaa', '/a', '/c'],
    [expect.stringMatching(/^[0-9a-z]{8}$/), '/b', '/c'],
  ]);
});

test('adding a rule to an address that already forwards lands where that forwards, and says so', async () => {
  files['src/content/redirects.yaml'] = RULES(yamlRule('aaaaaaaa', '/b', '/c'));

  const res = await POST(post('redirects', JSON.stringify({ from: '/a', to: '/b' })));

  expect(res.status).toBe(200);
  expect(((await res.json()) as { rule: { to: string } }).rule.to).toBe('/c');
  expect(committed().rules.map((r) => [r._id, r.from, r.to])).toEqual([
    ['aaaaaaaa', '/b', '/c'],
    [expect.stringMatching(/^[0-9a-z]{8}$/), '/a', '/c'],
  ]);
});

test('editing a rule collapses the chain again, both ways', async () => {
  files['src/content/redirects.yaml'] = RULES(
    yamlRule('aaaaaaaa', '/p', '/old'),
    yamlRule('bbbbbbbb', '/old', '/new'),
    yamlRule('cccccccc', '/x', '/y'),
  );

  const res = await PUT(
    put('redirects/bbbbbbbb', JSON.stringify({ from: '/old', to: '/x', status: 301 })),
  );

  expect(res.status).toBe(200);
  expect(committed().rules.map((r) => [r._id, r.from, r.to])).toEqual([
    ['aaaaaaaa', '/p', '/y'],
    ['bbbbbbbb', '/old', '/y'],
    ['cccccccc', '/x', '/y'],
  ]);
});

test('a rule is edited in place and the commit says which one', async () => {
  files['src/content/redirects.yaml'] = RULES(yamlRule('aaaaaaaa', '/old', '/new'));

  const res = await PUT(
    put('redirects/aaaaaaaa', JSON.stringify({ from: '/old', to: '/newer', status: 302 })),
  );

  expect(res.status).toBe(200);
  expect(publish.mock.calls[0]?.[1]).toEqual({
    base_sha: 'head789',
    message: expect.stringContaining('Edit redirect /old'),
  });
  expect(committed().rules).toEqual([
    {
      _id: 'aaaaaaaa',
      from: '/old',
      to: '/newer',
      status: 302,
      reason: 'manual',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ]);
});

test('a rule is deleted and the deletion is logged against the commit', async () => {
  files['src/content/redirects.yaml'] = RULES(
    yamlRule('aaaaaaaa', '/old', '/new'),
    yamlRule('bbbbbbbb', '/gone', '/'),
  );

  const res = await DELETE(ctx('redirects/bbbbbbbb', undefined, { handover: owner }));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ deleted: 'bbbbbbbb' });
  expect(committed().rules.map((r) => r._id)).toEqual(['aaaaaaaa']);
  expect(logged).toEqual([
    {
      userId: 'u1',
      kind: 'redirect-deleted',
      subject: 'bbbbbbbb',
      commitSha: 'def456',
      detail: { from: '/gone', to: '/' },
    },
  ]);
});

// Unhiding the entry removes its rule in the same commit.
test('a hidden entry’s rule is not deleted from this screen', async () => {
  files['src/content/redirects.yaml'] = RULES(
    yamlRule('cccccccc', '/listings/mill-house', '/listings', 'hidden', 'listings/mill-house'),
  );

  const res = await DELETE(ctx('redirects/cccccccc', undefined, { handover: owner }));

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    code: 'REDIRECT_MANAGED',
    error:
      'This redirect belongs to the entry that is hidden. Show that entry again and the redirect goes with it.',
  });
  expect(publish).not.toHaveBeenCalled();
});

test('a hidden entry’s rule is not edited from this screen either', async () => {
  files['src/content/redirects.yaml'] = RULES(
    yamlRule('cccccccc', '/listings/mill-house', '/listings', 'hidden', 'listings/mill-house'),
  );

  const res = await PUT(
    put('redirects/cccccccc', JSON.stringify({ from: '/listings/mill-house', to: '/' })),
  );

  expect(res.status).toBe(409);
  expect(publish).not.toHaveBeenCalled();
});

test('a rule that is not in the file is a 404 rather than a commit', async () => {
  expect((await DELETE(ctx('redirects/nosuchid', undefined, { handover: owner }))).status).toBe(
    404,
  );
  expect(publish).not.toHaveBeenCalled();
});
