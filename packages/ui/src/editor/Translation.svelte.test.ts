import type { Field } from '@handover/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { createEntrySession } from './entry-session.svelte';
import Translation from './Translation.svelte';

afterEach(() => vi.useRealTimers());

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
