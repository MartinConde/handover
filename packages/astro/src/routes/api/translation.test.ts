import { texts } from 'virtual:handover/index';
import { claimResource, ResourceLimitError, releaseResource } from '@handover/core';
import { afterEach, expect, test, vi } from 'vitest';
import { POST } from '../api.js';
import {
  addressed,
  createDraft,
  drifted,
  files,
  germanOnly,
  home,
  machine,
  post,
  resetContainers,
  resetMocks,
  resetState,
  saveTranslated,
  state,
  stored,
  translate,
  untranslated,
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

// Having nothing to translate with is about the site and not about this entry.
test('nothing to translate with outranks the entry having no file in that language', async () => {
  machine();
  state.translator = undefined;
  delete files['src/content/pages/de/home.yaml'];

  expect((await POST(post('translate/pages/home/de', ''))).status).toBe(409);
});

// URLs are never machine-translated.
test('a machine is never asked to translate the address', async () => {
  addressed();
  translate.mockClear();

  const res = await POST(post('translate/posts/hello/de', JSON.stringify({ paths: ['slug'] })));

  expect(res.status).toBe(200);
  expect(translate).not.toHaveBeenCalled();
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
