import { entrySource, staleLocales } from '@handover/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import EntryList from '../content/EntryList.svelte';
import Editor from './Editor.svelte';
import {
  SIX,
  SIX_LANGUAGE_SOURCES,
  SIX_LANGUAGE_VARIANTS,
  sixLanguageFiles,
  sixLanguageRows,
  sixLanguages,
  sourceConflict,
} from './six-languages.fixture';

// Testing: the fixture agrees with core's resolver and stale rule, and draws. Not testing any
// six-language behaviour: M1–M12 own that.

const i18n = { locales: SIX, defaultLocale: 'en' };

let app: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

test('every variant resolves to the source it is written in', () => {
  for (const name of SIX_LANGUAGE_VARIANTS) {
    const { files } = sixLanguageFiles(name);
    expect([name, entrySource('default', i18n, files)]).toEqual([
      name,
      {
        locale: SIX_LANGUAGE_SOURCES[name],
        recorded: name !== 'legacy',
      },
    ]);
  }
});

test('every variant is stale in exactly the languages it says', async () => {
  for (const name of SIX_LANGUAGE_VARIANTS) {
    const { form, files } = sixLanguageFiles(name);
    const { entry } = sixLanguages(name);
    expect([name, await staleLocales('default', form, files, entry.sourceLocale)]).toEqual([
      name,
      entry.stale,
    ]);
  }
});

test('the conflict variant is refused by the resolver with the marks it reports', () => {
  const { files, problem } = sourceConflict();
  expect(entrySource('default', i18n, files)).toEqual({
    problem: 'conflict',
    marks: problem.marks,
  });
});

test('each call hands out its own copy', () => {
  const heading = (entry: { translations: Record<string, Record<string, unknown>> }) =>
    (entry.translations.de?.body as { heading?: string }[] | undefined)?.[0];
  const first = sixLanguages('base').entry;
  const row = heading(first);
  if (row) row.heading = 'Geändert';
  first.offered.push('nl');
  const second = sixLanguages('base').entry;
  expect(heading(second)?.heading).toBe('Über dem Hafen');
  expect(second.offered).toEqual(['en', 'de', 'fr', 'it', 'es']);
});

test('every variant opens the editor on its source file', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ held_by: null, mine: true, expires_at: null })),
  );
  const titles = {
    base: 'Harbour House',
    twoMissing: 'Harbour House',
    germanFirst: 'Haus am Hafen',
    legacy: 'Harbour House',
    partlyMarked: 'Haus am Hafen',
    machine: 'Harbour House',
    untouchedInvalid: 'Harbour House, Kiel',
    staleAndPartial: 'Harbour House',
    sourceDraft: 'Harbour House',
    structured: 'Harbour House',
  };
  for (const name of SIX_LANGUAGE_VARIANTS) {
    app = mount(Editor, {
      target: document.body,
      props: { collection: 'listings', slug: name, onchanged: () => {}, ...sixLanguages(name) },
    });
    flushSync();
    const options = Array.from(
      document.querySelectorAll<HTMLOptionElement>('#entry-locale option'),
    );
    expect([name, document.querySelector<HTMLInputElement>('#f-title')?.value]).toEqual([
      name,
      titles[name],
    ]);
    expect(options.map((o) => o.value)).toEqual(SIX);
    unmount(app);
    app = undefined;
    document.body.innerHTML = '';
  }
});

test('the list draws each row with its files, missing, stale and off languages', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ entries: sixLanguageRows(), locales: SIX, index: '/listings' }),
    ),
  );
  app = mount(EntryList, {
    target: document.body,
    props: { collection: 'listings', onchanged: () => {} },
  });
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  const chips = (id: string) => {
    const row = document.querySelector(`a[href="/admin/c/listings/${id}"]`)?.closest('.row');
    return Array.from(row?.querySelectorAll('.chips .chip') ?? [], (chip) =>
      chip.classList.contains('chip-disabled')
        ? 'off'
        : chip.classList.contains('chip-missing')
          ? 'missing'
          : chip.classList.contains('chip-stale')
            ? 'stale'
            : 'file',
    );
  };
  const rows = document.querySelectorAll('.table .row:not(.row-note)');
  expect(rows.length).toBe(11);
  // Base: four files of five offered, `es` missing, `fr` stale, `nl` off.
  expect(chips('base')).toEqual(['file', 'file', 'stale', 'file', 'missing', 'off']);
  // German-first: one file of six offered.
  expect(chips('germanFirst')).toEqual([
    'missing',
    'file',
    'missing',
    'missing',
    'missing',
    'missing',
  ]);
});
