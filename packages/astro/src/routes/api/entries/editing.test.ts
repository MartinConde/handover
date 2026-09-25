import { DraftRevisionError, loadDraft } from '@handover/core';
import { expect, test, vi } from 'vitest';
import { GET, POST, PUT } from '../../api.js';
import {
  beats,
  ctx,
  drifted,
  editor,
  files,
  germanOnly,
  holdEntry,
  home,
  logged,
  post,
  put,
  rows,
  saveDraft,
  state,
  taken,
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

const alignedHome = () => {
  state.locales = ['en', 'de'];
  files['src/content/pages/en/home.yaml'] = home.en;
  files['src/content/pages/de/home.yaml'] = home.de
    .replace('  - _type: "quote"\n    _id: "z9y8x7w6"\n    body: "Ein seltener Fund."\n', '')
    .replace('title: "Startseite"', 'title: "Home"');
};

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
