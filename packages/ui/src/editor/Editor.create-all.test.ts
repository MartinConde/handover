import { unmount } from 'svelte';
import { expect, test, vi } from 'vitest';
import { deferred } from '../test-helpers.fixture.js';
import {
  $,
  $$,
  at,
  HELD,
  isLock,
  languageChoices,
  languagePick,
  openLanguages,
  settle,
  show,
  state,
  type,
  useEditorSetup,
  wrote,
} from './editor.fixture.js';
import { sixLanguages } from './six-languages.fixture';

useEditorSetup();

// Every offered language with no file, made in one reserved go from the create pane.
const batching = (
  answer: (url: string) => Response | Promise<Response> = () => Response.json({}),
) =>
  vi.fn(async (url: string, _init?: RequestInit) => {
    if (isLock(url)) return Response.json(HELD);
    if (/^\/admin\/api\/(drafts\/listings\/\w+\/\w+|translate\/)/.test(url)) return answer(url);
    if (
      url === '/admin/api/drafts/listings/twoMissing' ||
      url === '/admin/api/drafts/listings/germanFirst'
    )
      return Response.json({ updated_at: 1755864000000, pending: true, problems: [] });
    return Response.json({});
  });
const madeOrFilled = (mock: { mock: { calls: unknown[][] } }) =>
  wrote(mock)
    .map(([url]) => String(url))
    .filter((url) => /^\/admin\/api\/(drafts\/listings\/\w+\/\w+|translate\/)/.test(url));
const openMissing = async (
  name: 'twoMissing' | 'germanFirst',
  of: string,
  over: Record<string, unknown> = {},
  translator = false,
) => {
  at(`/admin/c/listings/${name}?queue=${of}&owed=missing`);
  const opened = sixLanguages(name);
  const root = show({
    slug: name,
    entry: { ...opened.entry, ...(translator ? { translator: true } : {}) },
    ...over,
  });
  await settle();
  return root;
};
const createAll = (root: ParentNode) => $<HTMLButtonElement>(root, 'button.btn-create-all');
const fillAll = (root: ParentNode) => $<HTMLButtonElement>(root, 'button.btn-fill-all');
const reportLines = (root: ParentNode) =>
  $$(root, '.created-all li').map((li) => li.textContent?.trim());
const lost = () =>
  new Response('Connection lost', {
    status: 503,
    headers: { 'x-handover-request-uncertain': 'true', 'x-handover-error-code': 'CONNECTION_LOST' },
  });

test('Create all makes every offered missing language in order, then reloads once', async () => {
  const fetchMock = batching();
  vi.stubGlobal('fetch', fetchMock);
  const reloaded = vi.fn();
  const reported = vi.fn();
  const root = await openMissing('twoMissing', 'it', {
    onreload: reloaded,
    oncreatedall: reported,
  });

  expect(createAll(root)?.textContent?.trim()).toBe('Create all 2 missing languages');
  expect(fillAll(root)).toBeNull();
  createAll(root)?.click();
  await settle();

  expect(madeOrFilled(fetchMock)).toEqual([
    '/admin/api/drafts/listings/twoMissing/it',
    '/admin/api/drafts/listings/twoMissing/es',
  ]);
  expect(reloaded).toHaveBeenCalledOnce();
  expect(reported).toHaveBeenLastCalledWith({
    targets: ['it', 'es'],
    done: { it: 'created', es: 'created' },
  });
  vi.unstubAllGlobals();
});

test('the report of a Create all is drawn after the reload, one line per language', async () => {
  vi.stubGlobal('fetch', batching());
  const opened = sixLanguages('base');
  opened.entry.translations.es = { title: 'Casa del puerto' };
  const root = show({
    slug: 'base',
    ...opened,
    createdAll: {
      targets: ['it', 'es'],
      done: { it: 'filled', es: 'created' },
    },
  });
  await settle();

  expect(reportLines(root)).toEqual(['Italian: created and pre-filled', 'Spanish: created']);
  vi.unstubAllGlobals();
});

test('pre-fill on a German entry creates and fills English first, then each later language', async () => {
  const fetchMock = batching();
  vi.stubGlobal('fetch', fetchMock);
  const reported = vi.fn();
  const root = await openMissing(
    'germanFirst',
    'fr',
    { onreload: vi.fn(), oncreatedall: reported },
    true,
  );

  expect(fillAll(root)?.textContent?.trim()).toBe('Create all 5 and pre-fill');
  fillAll(root)?.click();
  await settle();

  expect(madeOrFilled(fetchMock)).toEqual(
    ['en', 'fr', 'it', 'es', 'nl'].flatMap((of) => [
      `/admin/api/drafts/listings/germanFirst/${of}`,
      `/admin/api/translate/listings/germanFirst/${of}`,
    ]),
  );
  // Adding English never asks for the source to move.
  expect(wrote(fetchMock).some(([url]) => String(url).endsWith('/source'))).toBe(false);
  expect(reported).toHaveBeenLastCalledWith({
    targets: ['en', 'fr', 'it', 'es', 'nl'],
    done: { en: 'filled', fr: 'filled', it: 'filled', es: 'filled', nl: 'filled' },
  });
  vi.unstubAllGlobals();
});

test('a Create all whose first save fails sends nothing and leaves editing open', async () => {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (isLock(url)) return Response.json(HELD);
    if (url === '/admin/api/entries/listings') return Response.json({ entries: [] });
    throw new TypeError('offline');
  });
  vi.stubGlobal('fetch', fetchMock);
  const reloaded = vi.fn();
  const root = await openMissing('twoMissing', 'it', { onreload: reloaded });
  type(root, 'input#f-title', 'Unsaved words');

  createAll(root)?.click();
  await settle();

  expect(madeOrFilled(fetchMock)).toEqual([]);
  expect(reloaded).not.toHaveBeenCalled();
  expect($(root, '.pane [role="alert"]')?.textContent?.trim()).toBe(
    'Your last change could not be saved. No language was created.',
  );
  expect($<HTMLFieldSetElement>(root, '.entry-body > .form > fieldset')?.disabled).toBe(false);
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Unsaved words');
  vi.unstubAllGlobals();
});

test('while Create all waits, typing, switching language and other actions are held', async () => {
  const first = deferred<Response>();
  const fetchMock = batching((url) => (url.endsWith('/it') ? first.promise : Response.json({})));
  vi.stubGlobal('fetch', fetchMock);
  const root = await openMissing('twoMissing', 'it', { onreload: vi.fn() });

  createAll(root)?.click();
  await settle();

  expect($(root, '.pane [role="status"]')?.textContent?.trim()).toBe('Creating Italian…');
  expect($<HTMLFieldSetElement>(root, '.entry-body > .form > fieldset')?.disabled).toBe(true);
  expect($<HTMLButtonElement>(root, 'button.btn-create')?.disabled).toBe(true);
  expect(createAll(root)?.disabled).toBe(true);
  openLanguages(root);
  languageChoices(root)[1]?.click();
  await settle();
  expect(languagePick(root)?.textContent).toContain('Italian');
  expect(madeOrFilled(fetchMock)).toEqual(['/admin/api/drafts/listings/twoMissing/it']);

  first.resolve(Response.json({}));
  await settle();

  expect(madeOrFilled(fetchMock)).toEqual([
    '/admin/api/drafts/listings/twoMissing/it',
    '/admin/api/drafts/listings/twoMissing/es',
  ]);
  vi.unstubAllGlobals();
});

test('a refused second language stops the batch, keeps the first and reloads once', async () => {
  const fetchMock = batching((url) =>
    url.endsWith('/fr')
      ? new Response('This entry is not offered in fr', {
          status: 409,
          headers: { 'content-type': 'text/plain' },
        })
      : Response.json({}),
  );
  vi.stubGlobal('fetch', fetchMock);
  const reloaded = vi.fn();
  const reported = vi.fn();
  const root = await openMissing('germanFirst', 'fr', {
    onreload: reloaded,
    oncreatedall: reported,
  });

  createAll(root)?.click();
  await settle();

  expect(madeOrFilled(fetchMock)).toEqual([
    '/admin/api/drafts/listings/germanFirst/en',
    '/admin/api/drafts/listings/germanFirst/fr',
  ]);
  expect(reloaded).toHaveBeenCalledOnce();
  const report = reported.mock.lastCall?.[0];
  expect(report).toMatchObject({
    targets: ['en', 'fr', 'it', 'es', 'nl'],
    done: { en: 'created' },
    failed: { locale: 'fr', step: 'create', unconfirmed: false },
  });

  unmount(state.app);
  document.body.innerHTML = '';
  const opened = sixLanguages('germanFirst');
  opened.entry.translations.en = { title: '' };
  const again = show({ slug: 'germanFirst', ...opened, createdAll: report });
  await settle();
  expect(reportLines(again)).toEqual([
    'English: created',
    'French: not created',
    'Italian: not attempted, still missing',
    'Spanish: not attempted, still missing',
    'Dutch: not attempted, still missing',
  ]);
  expect($(again, '.created-all')?.textContent).toContain('This entry is not offered in fr');
  vi.unstubAllGlobals();
});

test('a created language whose pre-fill fails stops the batch there', async () => {
  const fetchMock = batching((url) =>
    url.startsWith('/admin/api/translate/')
      ? new Response('DeepL is unavailable', {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        })
      : Response.json({}),
  );
  vi.stubGlobal('fetch', fetchMock);
  const reloaded = vi.fn();
  const reported = vi.fn();
  const root = await openMissing(
    'twoMissing',
    'it',
    { onreload: reloaded, oncreatedall: reported },
    true,
  );

  fillAll(root)?.click();
  await settle();

  expect(madeOrFilled(fetchMock)).toEqual([
    '/admin/api/drafts/listings/twoMissing/it',
    '/admin/api/translate/listings/twoMissing/it',
  ]);
  expect(reloaded).toHaveBeenCalledOnce();
  const report = reported.mock.lastCall?.[0];
  expect(report).toMatchObject({
    done: { it: 'created' },
    failed: { locale: 'it', step: 'fill', unconfirmed: false },
  });
  unmount(state.app);
  document.body.innerHTML = '';
  const again = show({ slug: 'twoMissing', ...sixLanguages('twoMissing'), createdAll: report });
  await settle();
  expect(reportLines(again)).toEqual([
    'Italian: created, not pre-filled',
    'Spanish: not attempted, still missing',
  ]);
  vi.unstubAllGlobals();
});

test('a lost answer stops the batch and reloads; the fresh read settles it and a retry skips it', async () => {
  const fetchMock = batching((url) => (url.endsWith('/en') ? lost() : Response.json({})));
  vi.stubGlobal('fetch', fetchMock);
  const reloaded = vi.fn();
  const reported = vi.fn();
  const root = await openMissing('germanFirst', 'fr', {
    onreload: reloaded,
    oncreatedall: reported,
  });

  createAll(root)?.click();
  await settle();

  expect(madeOrFilled(fetchMock)).toEqual(['/admin/api/drafts/listings/germanFirst/en']);
  expect(reloaded).toHaveBeenCalledOnce();
  const report = reported.mock.lastCall?.[0];
  expect(report).toMatchObject({ failed: { locale: 'en', step: 'create', unconfirmed: true } });
  expect($<HTMLFieldSetElement>(root, '.entry-body > .form > fieldset')?.disabled).toBe(true);

  // The English file did land: the reload is what says so.
  unmount(state.app);
  document.body.innerHTML = '';
  fetchMock.mockClear();
  const opened = sixLanguages('germanFirst');
  opened.entry.translations.en = { title: '' };
  at('/admin/c/listings/germanFirst?queue=fr&owed=missing');
  const fresh = show({ slug: 'germanFirst', ...opened, createdAll: report, onreload: vi.fn() });
  await settle();
  expect(reportLines(fresh)[0]).toBe('English: created');
  expect(createAll(fresh)?.textContent?.trim()).toBe('Create all 4 missing languages');
  createAll(fresh)?.click();
  await settle();
  expect(madeOrFilled(fetchMock)).toEqual(
    ['fr', 'it', 'es', 'nl'].map((of) => `/admin/api/drafts/listings/germanFirst/${of}`),
  );
  vi.unstubAllGlobals();
});

test('a failed reload after Create all keeps editing closed and offers Reload', async () => {
  vi.stubGlobal('fetch', batching());
  const reloaded = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const root = await openMissing('twoMissing', 'it', { onreload: reloaded });

  createAll(root)?.click();
  await settle();

  expect($(root, '.pane [role="alert"]')?.textContent?.trim()).toBe(
    'The entry could not be read again after creating languages. Reload it before you continue. Reload',
  );
  expect($<HTMLFieldSetElement>(root, '.entry-body > .form > fieldset')?.disabled).toBe(true);
  $<HTMLButtonElement>(root, '.pane [role="alert"] button')?.click();
  expect(reloaded).toHaveBeenCalledTimes(2);
  vi.unstubAllGlobals();
});

test('a first language refused outright leaves editing open and reloads nothing', async () => {
  const fetchMock = batching(
    () =>
      new Response('Somebody else is editing', {
        status: 409,
        headers: { 'content-type': 'text/plain' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const reloaded = vi.fn();
  const reported = vi.fn();
  const root = await openMissing('twoMissing', 'it', {
    onreload: reloaded,
    oncreatedall: reported,
  });

  createAll(root)?.click();
  await settle();

  expect(madeOrFilled(fetchMock)).toEqual(['/admin/api/drafts/listings/twoMissing/it']);
  expect(reloaded).not.toHaveBeenCalled();
  expect($<HTMLFieldSetElement>(root, '.entry-body > .form > fieldset')?.disabled).toBe(false);
  expect(createAll(root)?.disabled).toBe(false);
  expect(reported.mock.lastCall?.[0]).toMatchObject({
    done: {},
    failed: { locale: 'it', step: 'create', unconfirmed: false },
  });
  vi.unstubAllGlobals();
});
