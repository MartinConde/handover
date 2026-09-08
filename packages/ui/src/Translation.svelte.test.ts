import type { Field } from '@handover/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { createEntrySession } from './entry-session.svelte';
import Translation from './Translation.svelte';

afterEach(() => vi.useRealTimers());

test('an edit remains in the entry session after its locale pane is unmounted', () => {
  const session = createEntrySession({
    sourceLocale: 'en',
    data: { title: 'Seaview Cottage' },
    translations: { de: { title: 'Haus Seeblick' } },
    revisions: { en: 'source-revision', de: 'translation-revision' },
  });
  session.configureAutosave(async () => true);
  const show = () =>
    mount(Translation, {
      target: document.body,
      props: {
        collection: 'listings',
        slug: 'seaview-cottage',
        locale: 'de',
        fields: [
          { path: ['title'], label: 'Title', type: 'text', required: true },
        ] satisfies Field[],
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
  const session = createEntrySession({
    sourceLocale: 'en',
    data: { title: 'Seaview Cottage' },
    translations: { de: { title: 'Haus Seeblick' } },
    revisions: { en: 'legacy', de: 'translation-revision' },
  });
  session.configureAutosave(write);
  const app = mount(Translation, {
    target: document.body,
    props: {
      collection: 'listings',
      slug: 'seaview-cottage',
      locale: 'de',
      fields: [{ path: ['title'], label: 'Title', type: 'text', required: true }] satisfies Field[],
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
  );
  expect(session.unsaved()).toBe(false);
});
