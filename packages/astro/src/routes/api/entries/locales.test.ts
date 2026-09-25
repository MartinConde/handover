import type { PublishFile } from '@handover/core';
import { expect, test, vi } from 'vitest';
import { POST } from '../../api.js';
import {
  addressed,
  ctx,
  discardDraft,
  drifted,
  files,
  home,
  logged,
  overlayRows,
  owner,
  post,
  publish,
  resolveDrift,
  rows,
  setEntryAddress,
  setEntryLocales,
  setEntryStatus,
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
