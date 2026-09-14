import type { Field } from '@handover/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { createEntrySession } from './entry-session.svelte';
import Translation from './Translation.svelte';
import TranslationLocaleFixture from './TranslationLocaleFixture.svelte';

let localeApp: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (localeApp) {
    unmount(localeApp);
    localeApp = undefined;
  }
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('machine and stale feedback retranslate without replacing the target draft', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    url === '/admin/api/source/listings/harbour-house/de'
      ? Response.json({
          translatedAt: new Date(2026, 8, 13, 10, 15).toISOString(),
          changed: {
            title: [
              { text: 'Harbour cottage', mark: 'del' },
              { text: 'Harbour house', mark: 'ins' },
            ],
          },
        })
      : init?.method === 'POST'
        ? new Response('provider diagnostic', {
            status: 503,
            headers: { 'content-type': 'text/plain' },
          })
        : Response.json({}),
  );
  vi.stubGlobal('fetch', fetchMock);
  localeApp = mount(TranslationLocaleFixture, { target: document.body });
  await vi.waitFor(() => expect(document.querySelector('#stale-title')).not.toBeNull());
  flushSync();

  const input = document.querySelector<HTMLInputElement>('#t-title');
  if (!input) throw new Error('translation title missing');
  input.value = 'Eigener Entwurf';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dataset.localeProof = 'same-translation-field';
  document.querySelector<HTMLButtonElement>('.pane-head .btn-fill')?.click();
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
  flushSync();

  expect(document.querySelector('.pane h2')?.textContent).toBe('German');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'The translation could not be applied (503).',
  );
  document.querySelector<HTMLButtonElement>('[data-locale-switch]')?.click();
  flushSync();

  expect(document.querySelector('.pane h2')?.textContent).toBe('Deutsch');
  expect(document.querySelector('.pane .mode')?.textContent).toBe(
    'Englisch wurde seit dieser Übersetzung geändert',
  );
  expect(document.querySelector('.pane-head .btn-fill')?.textContent?.trim()).toBe(
    'Leere Felder übersetzen',
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'Die Übersetzung konnte nicht angewendet werden (503).',
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'Technisches Detail: provider diagnostic',
  );
  expect(document.querySelector('.autosave .btn-link')?.textContent).toBe(
    'Übersetzung erneut versuchen',
  );
  expect(document.querySelector<HTMLInputElement>('#t-title')).toBe(input);
  expect(input.value).toBe('Eigener Entwurf');
  expect(input.dataset.localeProof).toBe('same-translation-field');
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('an edit remains in the entry session after its locale pane is unmounted', () => {
  const fields = [
    { path: ['title'], label: 'Title', type: 'text', required: true },
  ] satisfies Field[];
  const session = createEntrySession({
    sourceLocale: 'en',
    data: { title: 'Seaview Cottage' },
    translations: { de: { title: 'Haus Seeblick' } },
    revisions: { en: 'source-revision', de: 'translation-revision' },
    form: { fields, blocks: {} },
  });
  session.configureAutosave(async () => true);
  const show = () =>
    mount(Translation, {
      target: document.body,
      props: {
        collection: 'listings',
        slug: 'seaview-cottage',
        locale: 'de',
        fields,
        blocks: {},
        session,
        data: session.snapshot('de'),
        source: 'en',
      },
    });
  let app = show();

  const title = document.querySelector<HTMLInputElement>('input#t-title');
  if (!title) throw new Error('translation title missing');
  title.value = 'Ungespeicherter Entwurf';
  title.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  unmount(app);

  app = show();
  expect(document.querySelector<HTMLInputElement>('input#t-title')?.value).toBe(
    'Ungespeicherter Entwurf',
  );
  unmount(app);
  session.closeSaveGate();
});

test('an unmounted locale still autosaves through its entry session', async () => {
  vi.useFakeTimers();
  const write = vi.fn(async () => true);
  const fields = [
    { path: ['title'], label: 'Title', type: 'text', required: true },
  ] satisfies Field[];
  const session = createEntrySession({
    sourceLocale: 'en',
    data: { title: 'Seaview Cottage' },
    translations: { de: { title: 'Haus Seeblick' } },
    revisions: { en: 'legacy', de: 'translation-revision' },
    form: { fields, blocks: {} },
  });
  session.configureAutosave(write);
  const app = mount(Translation, {
    target: document.body,
    props: {
      collection: 'listings',
      slug: 'seaview-cottage',
      locale: 'de',
      fields,
      blocks: {},
      session,
      data: session.snapshot('de'),
      source: 'en',
    },
  });
  const title = document.querySelector<HTMLInputElement>('input#t-title');
  if (!title) throw new Error('translation title missing');
  title.value = 'Bleibt gespeichert';
  title.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  unmount(app);

  await vi.advanceTimersByTimeAsync(2000);

  expect(write).toHaveBeenCalledWith(
    'de',
    JSON.stringify({ title: 'Bleibt gespeichert' }),
    'translation-revision',
    1,
  );
  expect(session.unsaved()).toBe(false);
});

test('a refused machine translation releases the target and shows the existing failure state', async () => {
  const fetchMock = vi.fn(async () => new Response('Translator unavailable', { status: 503 }));
  vi.stubGlobal('fetch', fetchMock);
  const fields = [
    { path: ['title'], label: 'Title', type: 'text', required: true },
  ] satisfies Field[];
  const session = createEntrySession({
    sourceLocale: 'en',
    data: { title: 'Seaview Cottage' },
    translations: { de: { title: 'Haus Seeblick' } },
    revisions: { en: 'source-revision', de: 'translation-revision' },
    form: { fields, blocks: {} },
  });
  session.configureAutosave(async () => true);
  const app = mount(Translation, {
    target: document.body,
    props: {
      collection: 'listings',
      slug: 'seaview-cottage',
      locale: 'de',
      fields,
      blocks: {},
      session,
      data: session.snapshot('de'),
      source: 'en',
      translator: true,
    },
  });

  document.querySelector<HTMLButtonElement>('button.btn-fill')?.click();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  flushSync();

  expect(document.querySelector('.autosave')?.textContent).toContain('Not saved');
  expect(document.querySelector<HTMLFieldSetElement>('fieldset')?.disabled).toBe(false);
  expect(session.snapshot('de').title).toBe('Haus Seeblick');
  unmount(app);
  session.closeSaveGate();
  vi.unstubAllGlobals();
});

test('a reply after the session closes does not replace the mounted target snapshot', async () => {
  const reply = deferred<Response>();
  const fetchMock = vi.fn(() => reply.promise);
  vi.stubGlobal('fetch', fetchMock);
  const fields = [
    { path: ['title'], label: 'Title', type: 'text', required: true },
  ] satisfies Field[];
  const session = createEntrySession({
    sourceLocale: 'en',
    data: { title: 'Seaview Cottage' },
    translations: { de: { title: 'Haus Seeblick' } },
    revisions: { en: 'source-revision', de: 'translation-revision' },
    form: { fields, blocks: {} },
  });
  session.configureAutosave(async () => true);
  const app = mount(Translation, {
    target: document.body,
    props: {
      collection: 'listings',
      slug: 'seaview-cottage',
      locale: 'de',
      fields,
      blocks: {},
      session,
      data: session.snapshot('de'),
      source: 'en',
      translator: true,
    },
  });

  document.querySelector<HTMLButtonElement>('button.btn-fill')?.click();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  session.closeSaveGate();
  reply.resolve(
    Response.json({
      data: { title: 'Zu spät' },
      pending: true,
      revision: 'translation-revision-2',
    }),
  );
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLInputElement>('input#t-title')?.value).toBe('Haus Seeblick'),
  );

  expect(session.snapshot('de').title).toBe('Haus Seeblick');
  unmount(app);
  vi.unstubAllGlobals();
});
