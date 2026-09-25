import type { Field } from '@handover/core';
import { flushSync, unmount } from 'svelte';
import { expect, test, vi } from 'vitest';
import { deferred } from '../test-helpers.fixture.js';
import {
  $,
  $$,
  autosaved,
  bilingual,
  HELD,
  isLint,
  isLock,
  languageChoices,
  languagePick,
  openLanguages,
  settled,
  show,
  state,
  tick,
  type,
  useEditorSetup,
  wrote,
} from './editor.fixture.js';
import { sixLanguages } from './six-languages.fixture';

useEditorSetup();

// The rule is on the config: two declared languages with no German file still draw every control.
test('a site that declares one language draws no language controls at all', () => {
  const root = show();

  expect($(root, '[aria-label="Language"]')).toBeNull();
  expect($(root, 'button.btn-sbs')).toBeNull();
});

test('a second language with nothing written in it still draws every control', () => {
  const root = show({ entry: { ...bilingual, translations: {} } });

  const seg = $(root, '[aria-label="Language"]');
  expect(Array.from(seg?.querySelectorAll('button') ?? [], (b) => b.textContent?.trim())).toEqual([
    'EN',
    'DE— not translated yet',
  ]);
  expect($(root, 'button.btn-sbs')).not.toBeNull();
});

const trilingual = {
  ...bilingual,
  locales: ['en', 'de', 'fr'],
  offered: ['en', 'de', 'fr'],
  translations: {
    ...bilingual.translations,
    fr: {
      title: 'Maison avec vue sur la mer',
      price: '£1,200 per week',
      body: [{ _type: 'hero', _id: 'k3nf9a2p', heading: 'Au-dessus du port' }],
    },
  },
};

test('a translation made from another language than the source says so to a screen reader', () => {
  const root = show({
    entry: {
      ...trilingual,
      translations: {
        ...trilingual.translations,
        de: { ...trilingual.translations.de, _i18n: { sourceLocale: 'fr' } },
        fr: { ...trilingual.translations.fr, _i18n: { sourceLocale: 'en' } },
      },
      stale: ['de', 'fr'],
    },
  });

  const seg = $(root, '[aria-label="Language"]');
  expect(Array.from(seg?.querySelectorAll('button') ?? [], (b) => b.textContent?.trim())).toEqual([
    'EN',
    'DE— translated from French, not from English',
    'FR— English changed since this was translated',
  ]);
});

// Five languages is where a row of buttons stops fitting — Sveltia's threshold.
test('with six languages each choice names its language and says what state it is in', () => {
  const root = show(sixLanguages('base'));
  openLanguages(root);

  expect($(root, '.seg[aria-label="Language"]')).toBeNull();
  expect(languagePick(root)?.getAttribute('aria-expanded')).toBe('true');
  expect(languageChoices(root).map((b) => b.textContent?.trim())).toEqual([
    'English',
    'German',
    'French— English changed since this was translated',
    'Italian— partly written, 0 of 2 texts',
    'Spanish— not translated yet',
    'Dutch— turned off for this entry',
  ]);
  expect(languageChoices(root).map((b) => b.getAttribute('aria-pressed'))).toEqual([
    'true',
    'false',
    'false',
    'false',
    'false',
    'false',
  ]);
});

test('choosing a language closes the list, switches to it and hands focus back', async () => {
  const root = show(sixLanguages('base'));
  openLanguages(root);

  languageChoices(root)[2]?.click();
  await tick();
  flushSync();

  expect($(root, '#entry-languages')).toBeNull();
  expect(languagePick(root)?.getAttribute('aria-expanded')).toBe('false');
  expect(languagePick(root)?.textContent).toContain('French');
  expect(document.activeElement).toBe(languagePick(root));
});

test('Escape closes the language list and gives focus back to its button', async () => {
  const root = show(sixLanguages('base'));
  openLanguages(root);
  languageChoices(root)[1]?.focus();

  languageChoices(root)[1]?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await tick();

  expect($(root, '#entry-languages')).toBeNull();
  expect(document.activeElement).toBe(languagePick(root));
  expect(languagePick(root)?.textContent).toContain('English');
});

// Safari does not focus a clicked button, so Escape must still reach an opened list.
test('Escape closes a language list opened by pointer', async () => {
  const root = show(sixLanguages('base'));
  openLanguages(root);

  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await tick();

  expect($(root, '#entry-languages')).toBeNull();
  expect(document.activeElement).toBe(languagePick(root));
});

test('a click outside the language list closes it without choosing', () => {
  const root = show(sixLanguages('base'));
  openLanguages(root);

  $<HTMLElement>(root, 'input#f-title')?.click();
  flushSync();

  expect($(root, '#entry-languages')).toBeNull();
  expect(languagePick(root)?.textContent).toContain('English');
});

test('a language chosen while the last edit cannot be saved is not switched to', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (isLock(url)) return Response.json(HELD);
      throw new TypeError('offline');
    }),
  );
  const root = show(sixLanguages('base'));
  type(root, 'input#f-title', 'Keep this text');
  openLanguages(root);

  languageChoices(root)[2]?.click();
  await tick();
  flushSync();

  expect(languagePick(root)?.textContent).toContain('English');
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Keep this text');
  vi.unstubAllGlobals();
});

test('side by side edits the second language and saves it to its own file', async () => {
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: bilingual });

  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  type(root, 'input#t-title', 'Seeblick-Häuschen');
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/drafts/listings/seaview-cottage/de', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      data: {
        title: 'Seeblick-Häuschen',
        price: '£1,200 per week',
        body: [{ _type: 'hero', _id: 'k3nf9a2p', heading: 'Über dem Hafen' }],
      },
      tab: 'tab-1',
    }),
  });
  vi.unstubAllGlobals();
});

test('side by side keeps source edits bound to the source after selecting another language', async () => {
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: bilingual });

  $$<HTMLButtonElement>(root, '[aria-label="Language"] button')[1]?.click();
  flushSync();
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();

  type(root, 'input#f-title', 'Seaview House');
  type(root, 'input#f-price', '£1,300 per week');
  type(root, 'input#t-title', 'Haus mit Seeblick');
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();

  const writes = wrote(fetchMock);
  expect(writes).toHaveLength(2);
  expect(writes).toEqual(
    expect.arrayContaining([
      [
        '/admin/api/drafts/listings/seaview-cottage',
        expect.objectContaining({
          body: JSON.stringify({
            data: {
              title: 'Seaview House',
              price: '£1,300 per week',
              notes: 'Saturday changeovers',
              body: [{ _type: 'hero', _id: 'k3nf9a2p', heading: 'Above the harbour' }],
            },
            tab: 'tab-1',
          }),
        }),
      ],
      [
        '/admin/api/drafts/listings/seaview-cottage/de',
        expect.objectContaining({
          body: JSON.stringify({
            data: {
              title: 'Haus mit Seeblick',
              price: '£1,300 per week',
              body: [{ _type: 'hero', _id: 'k3nf9a2p', heading: 'Über dem Hafen' }],
            },
            tab: 'tab-1',
          }),
        }),
      ],
    ]),
  );
  vi.unstubAllGlobals();
});

// Autosave is independent of rendering: the live Canvas shell must stay mounted through it.
test('a save in the second language keeps the Canvas workspace mounted', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show({
    entry: { ...bilingual, route: '/listings/[slug]', published: ['en', 'de'] },
    preview: true,
  });

  $$<HTMLButtonElement>(root, '.entry-header .seg button')[1]?.click();
  flushSync();
  const canvas = $(root, '.canvas-workspace');
  type(root, 'input#t-title', 'Seeblick-Häuschen');
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();

  expect($(root, '.canvas-workspace')).toBe(canvas);
  vi.unstubAllGlobals();
});

// The skeleton is one edit to every language, so the second column must move at once.
const twoBlocks = {
  ...bilingual,
  blocks: {
    hero: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
    cta: [{ path: ['label'], label: 'Label', type: 'text', required: true }],
  } as Record<string, Field[]>,
  data: {
    ...bilingual.data,
    body: [
      { _type: 'hero', _id: 'k3nf9a2p', heading: 'Above the harbour' },
      { _type: 'cta', _id: 'c7t2a9x1', label: 'Book a viewing' },
    ],
  },
  translations: {
    de: {
      ...bilingual.translations.de,
      body: [
        { _type: 'hero', _id: 'k3nf9a2p', heading: 'Über dem Hafen' },
        { _type: 'cta', _id: 'c7t2a9x1', label: 'Besichtigung buchen' },
      ],
    },
  },
};
const CARD = '.row-card, .block-card';
// dnd-kit reads card boxes and jsdom has none, so each card is a 100px band in document order.
const laidOut = () =>
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const found = this.closest(CARD);
    const card = found?.hasAttribute('data-dnd-placeholder') ? found.previousElementSibling : found;
    if (!card?.parentElement) return new DOMRect(0, 0, 1024, 4096);
    const cards = Array.from(card.parentElement.children).filter(
      (el) => el.matches(CARD) && !el.hasAttribute('data-dnd-placeholder'),
    );
    return new DOMRect(0, cards.indexOf(card) * 100, 400, 100);
  });
const press = async (target: Element, code: string) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 40));
  flushSync();
};
const germanBlocks = (root: ParentNode) =>
  $$<HTMLElement>(root, '.pane.is-locale .block-card .label').map((el) => el.textContent);

test('a block moved in the source column moves in the second column at once', async () => {
  laidOut();
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: twoBlocks });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  expect(germanBlocks(root)).toEqual(['Hero', 'Cta']);

  const handle = $<HTMLButtonElement>(root, '[aria-label="Reorder hero"]');
  if (!handle) throw new Error('no handle');
  await press(handle, 'Space');
  await press(document.body, 'ArrowDown');
  await press(document.body, 'Space');

  expect(germanBlocks(root)).toEqual(['Cta', 'Hero']);
  // Its words went with it: the German heading is still the hero's.
  expect($<HTMLInputElement>(root, 'input#t-body\\.1\\.heading')?.value).toBe('Über dem Hafen');
  expect(wrote(fetchMock)).toHaveLength(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('a duplicated block autosaves its scoped locale subtree and captured revisions', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (url: string) =>
    isLock(url)
      ? Response.json(HELD)
      : Response.json({
          updated_at: 1755864000000,
          pending: true,
          problems: [],
          revisions: { en: 'en-next', de: 'de-next' },
        }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show({
    entry: { ...twoBlocks, revisions: { en: 'en-opened', de: 'de-opened' } },
  });

  $<HTMLButtonElement>(root, '[aria-label="Duplicate cta"]')?.click();
  flushSync();
  await vi.advanceTimersByTimeAsync(2100);

  const [, init] = wrote(fetchMock)[0] as [string, RequestInit];
  const body = JSON.parse(String(init.body)) as {
    data: { body: { _id: string; label?: string }[] };
    structure: {
      containers: string[];
      revisions: Record<string, string>;
      seeds: Record<string, { address: string; value: { _id: string; label: string } }[]>;
    };
  };
  const copy = body.data.body[2];
  if (!copy) throw new Error('duplicated block missing');
  expect(copy).toMatchObject({ label: 'Book a viewing' });
  expect(copy._id).toMatch(/^[0-9a-z]{8}$/);
  expect(body.structure).toEqual({
    containers: ['body'],
    revisions: { en: 'en-opened', de: 'de-opened' },
    seeds: {
      de: [
        {
          address: `body[_id=${copy._id}]`,
          value: { _type: 'cta', _id: copy._id, label: 'Besichtigung buchen' },
        },
      ],
    },
  });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('a shared value typed in the source column reads in the second column as it is typed', () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show({ entry: bilingual });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();

  type(root, 'input#f-price', '£1,300 per week');

  expect($(root, '.pane.is-locale')?.textContent).toContain('£1,300 per week');
  vi.unstubAllGlobals();
});

// The mirror runs on open too; a save there would make every side-by-side look like a change.
test('opening the second column on an untouched entry writes nothing', async () => {
  vi.useFakeTimers();
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: twoBlocks });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  await vi.advanceTimersByTimeAsync(5000);

  expect(wrote(fetchMock)).toHaveLength(0);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('the second language shows a shared field without offering to change it', () => {
  const root = show({ entry: bilingual });

  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();

  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Seaview Cottage');
  expect($(root, 'input#t-price')).toBeNull();
  expect($(root, '#t-price')?.textContent).toContain('£1,200 per week');
  expect($(root, '#t-notes')).toBeNull();
});

// The second language is its own file, so its draft alone is a reason to publish.
test('an edit made only in the second language is still something to publish', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show({ entry: bilingual });

  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  type(root, 'input#t-title', 'Seeblick-Häuschen');
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();

  expect($<HTMLButtonElement>(root, 'button.btn-primary')?.disabled).toBe(false);
  vi.unstubAllGlobals();
});

// The second column holds its own copy of one language, so leaving it must store it first.
test('closing the second column stores what was typed in it', async () => {
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: bilingual });

  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  type(root, 'input#t-title', 'Seeblick-Häuschen');
  $<HTMLButtonElement>(root, 'button[aria-label="Close side by side"]')?.click();
  await tick();
  flushSync();

  expect(fetchMock).toHaveBeenCalledWith(
    '/admin/api/drafts/listings/seaview-cottage/de',
    expect.objectContaining({
      body: JSON.stringify({
        data: {
          title: 'Seeblick-Häuschen',
          price: '£1,200 per week',
          body: [{ _type: 'hero', _id: 'k3nf9a2p', heading: 'Über dem Hafen' }],
        },
        tab: 'tab-1',
      }),
    }),
  );
  vi.unstubAllGlobals();
});

test('choosing a third language draws that language and not the one before it', async () => {
  const root = show({
    entry: {
      ...bilingual,
      locales: ['en', 'de', 'fr'],
      translations: {
        ...bilingual.translations,
        fr: { title: 'Chaumière Seaview', price: '£1,200 per week' },
      },
    },
  });

  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  const buttons = Array.from(
    root.querySelectorAll<HTMLButtonElement>('[aria-label="Language"] button'),
  );
  buttons[2]?.click();
  await tick();
  flushSync();

  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Chaumière Seaview');
});

test('the second language draws a block to translate but nothing to move it with', () => {
  const root = show({ entry: bilingual });

  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();

  expect($<HTMLInputElement>(root, 'input#t-body\\.0\\.heading')?.value).toBe('Über dem Hafen');
  expect($(root, '.pane.is-locale button.add')).toBeNull();
  expect($(root, '.pane.is-locale .row-controls')).toBeNull();
});

test('what the schema still wants of the second language is marked on its own field', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        updated_at: 1755864000000,
        pending: true,
        problems: [{ path: 'title', message: 'Required' }],
      }),
    ),
  );
  const root = show({ entry: bilingual });

  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  type(root, 'input#t-title', '');
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();

  expect($(root, '#t-title-err')?.textContent).toBe('Required');
  vi.unstubAllGlobals();
});

test('a translation typed and then closed is still something to publish', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show({ entry: bilingual });

  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  type(root, 'input#t-title', 'Seeblick-Häuschen');
  $<HTMLButtonElement>(root, 'button[aria-label="Close side by side"]')?.click();
  await tick();
  flushSync();

  expect($<HTMLButtonElement>(root, 'button.btn-primary')?.disabled).toBe(false);
  vi.unstubAllGlobals();
});

// Create from English leaves a draft ahead of the repository, which is the entry's to publish.
test('a translation drafted before the screen opened is something to publish', () => {
  const root = show({ entry: { ...bilingual, pending: ['de'] } });

  expect($<HTMLButtonElement>(root, 'button.btn-primary')?.disabled).toBe(false);
});

test('switching languages keeps the pending draft attached to the locale that saved it', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (url: string) => {
    if (isLock(url)) return Response.json(HELD);
    if (isLint(url)) return Response.json({ results: [] });
    return Response.json({ pending: true, problems: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  const pending = vi.fn();
  const root = show({ entry: trilingual, onpending: pending });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();

  type(root, 'input#t-title', 'Haus mit Seeblick');
  await vi.advanceTimersByTimeAsync(2000);
  expect(pending).toHaveBeenCalledTimes(1);

  $$<HTMLButtonElement>(root, '[aria-label="Language"] button')[2]?.click();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  $<HTMLButtonElement>(root, '.entry-header button.btn-primary')?.click();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();

  expect($(root, '.dialog .publish-set')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Languages: DE The German file',
  );
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('a clean response for one translation does not clear another locale pending in this session', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (url: string) => {
    if (isLock(url)) return Response.json(HELD);
    if (isLint(url)) return Response.json({ results: [] });
    return Response.json({
      pending: !url.endsWith('/fr'),
      problems: [],
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const pending = vi.fn();
  const root = show({ entry: trilingual, onpending: pending });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();

  type(root, 'input#t-title', 'Haus mit Seeblick');
  await vi.advanceTimersByTimeAsync(2000);
  $$<HTMLButtonElement>(root, '[aria-label="Language"] button')[2]?.click();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  type(root, 'input#t-title', 'Maison au bord de la mer');
  await vi.advanceTimersByTimeAsync(2000);

  expect(pending).toHaveBeenCalledTimes(1);
  expect($<HTMLButtonElement>(root, '.entry-header button.btn-primary')?.disabled).toBe(false);
  $<HTMLButtonElement>(root, '.entry-header button.btn-primary')?.click();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect($(root, '.dialog .publish-set')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Languages: DE The German file',
  );
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// An empty form would autosave a file nobody asked for, so a missing language gets offers instead.
const missing = { ...bilingual, translations: {} };
const posted = () =>
  vi.fn(async (url: string, _init?: RequestInit) =>
    isLock(url) ? Response.json(HELD) : Response.json({}),
  );

test('a language the entry has no file in offers one made from the source language', async () => {
  const fetchMock = posted();
  vi.stubGlobal('fetch', fetchMock);
  const changed = vi.fn();
  const root = show({ entry: missing, onchanged: changed });

  $$<HTMLButtonElement>(root, '[aria-label="Language"] button')[1]?.click();
  flushSync();
  $<HTMLButtonElement>(root, 'button.btn-primary.btn-create')?.click();
  await tick();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/drafts/listings/seaview-cottage/de', {
    method: 'POST',
  });
  expect(changed).toHaveBeenCalled();
  vi.unstubAllGlobals();
});

test('turning a language off sends the ones the entry keeps', async () => {
  const fetchMock = posted();
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: missing });

  $$<HTMLButtonElement>(root, '[aria-label="Language"] button')[1]?.click();
  flushSync();
  $<HTMLButtonElement>(root, 'button.btn-link')?.click();
  await tick();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/entries/listings/seaview-cottage/locales', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ locales: ['en'] }),
  });
  vi.unstubAllGlobals();
});

// Turning off a language with a file deletes it, so it gets a delete's dialog with a redirect.
test('a language with a file is turned off from its own column, through a dialog', async () => {
  const committed = vi.fn();
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
    isLock(url)
      ? Response.json(HELD)
      : url === '/admin/api/entries/listings/seaview-cottage/locales'
        ? Response.json({ commit_sha: 'off123' })
        : Response.json({}),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show({
    entry: { ...bilingual, route: '/listings/[slug]', index: '/listings' },
    oncommitted: committed,
  });

  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.pane-head button.btn-off')?.click();
  flushSync();
  const dialog = $(root, '.dialog')?.textContent ?? '';
  expect(dialog).toContain('/de/listings/seaview-cottage');
  expect(dialog).toContain('/de/listings');
  $<HTMLButtonElement>(root, '.dialog button.btn-danger')?.click();
  await tick();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/entries/listings/seaview-cottage/locales', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ locales: ['en'], redirect: { kind: 'index' } }),
  });
  expect(committed).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

// The redirect answer rides with the turn-off rather than the route deciding on the overview.
test('turning a language off asks where its readers go and sends the answer', async () => {
  const fetchMock = posted();
  vi.stubGlobal('fetch', fetchMock);
  const root = show({
    entry: { ...bilingual, route: '/listings/[slug]', index: '/listings' },
  });

  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.pane-head button.btn-off')?.click();
  flushSync();
  $$<HTMLInputElement>(root, '.dialog input[type="radio"]').at(-1)?.click();
  await tick();
  $<HTMLButtonElement>(root, '.dialog button.btn-danger')?.click();
  await tick();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/entries/listings/seaview-cottage/locales', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ locales: ['en'], redirect: { kind: 'none' } }),
  });
  vi.unstubAllGlobals();
});

// The refusal's sentence is worth reading, so the dialog stays open and shows it.
test('a turn-off the server refuses keeps the dialog open with its reason', async () => {
  const reason =
    'Turning de off would leave this entry with no published file: publish en first, or Delete the entry';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) =>
      isLock(url)
        ? Response.json(HELD)
        : init?.method === 'POST'
          ? new Response(reason, { status: 409 })
          : Response.json({}),
    ),
  );
  const changed = vi.fn();
  const committed = vi.fn();
  const root = show({
    entry: { ...bilingual, route: '/listings/[slug]', index: '/listings' },
    onchanged: changed,
    oncommitted: committed,
  });

  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.pane-head button.btn-off')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.dialog button.btn-danger')?.click();
  await tick();
  flushSync();

  expect($(root, '.dialog [role="alert"]')?.textContent).toContain('publish en first');
  expect($<HTMLButtonElement>(root, '.dialog button.btn-danger')?.disabled).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  expect(committed).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

// Turning German off deleted its file, so the log's commit is what brings the words back.
test('a language the CMS turned off offers the words back rather than an empty form', async () => {
  const committed = vi.fn();
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
    isLock(url)
      ? Response.json(HELD)
      : url === '/admin/api/deleted/listings'
        ? Response.json({
            deleted: [
              {
                id: 'a1',
                at: Date.UTC(2026, 7, 12),
                by: 'Martin',
                slug: 'seaview-cottage',
                locales: ['de'],
                whole: false,
                commit_sha: 'off222',
              },
            ],
          })
        : url === '/admin/api/restore'
          ? Response.json({ commit_sha: 'restore123' })
          : Response.json({}),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: { ...missing, offered: ['en'] }, oncommitted: committed });
  $$<HTMLButtonElement>(root, '[aria-label="Language"] button')[1]?.click();
  flushSync();
  await tick();
  flushSync();

  $(root, '.pane button.btn-primary')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await tick();

  expect($(root, '.pane .btn-primary')?.textContent).toContain('Bring the German words back');
  expect(fetchMock).toHaveBeenCalledWith('/admin/api/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commit_sha: 'off222' }),
  });
  expect(committed).toHaveBeenCalledOnce();
  // The empty form is still there for a language the CMS never had the words for.
  expect($(root, '.pane button.btn-link')?.textContent).toContain('empty form');
  vi.unstubAllGlobals();
});

test('a language turned off is struck through and offers no way to write it', () => {
  const root = show({ entry: { ...missing, offered: ['en'] } });

  const de = $$<HTMLButtonElement>(root, '[aria-label="Language"] button')[1];
  expect(de?.className).toContain('is-off');
  de?.click();
  flushSync();
  expect($(root, 'button.btn-create')).toBeNull();
  expect($(root, '.pane h2')?.textContent).toContain('German');
  expect($(root, '.pane button.btn')?.textContent).toContain('back on');
  expect($(root, 'button.btn-link')).toBeNull();
});

// No English file was ever made, so German is where the structure is edited.
const germanOnly = {
  ...bilingual,
  sourceLocale: 'de',
  data: bilingual.translations.de as Record<string, unknown>,
  translations: {},
};

test('an entry opens on the language it is written in, not on the site default', () => {
  const root = show({ entry: germanOnly });

  const buttons = $$<HTMLButtonElement>(root, '[aria-label="Language"] button');
  expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true');
  expect($<HTMLInputElement>(root, '#f-title')?.value).toBe('Seaview Cottage');
  // English is the language with no file, so it is the offer and not the form.
  buttons[0]?.click();
  flushSync();
  expect($(root, 'button.btn-create')?.textContent?.trim()).toBe('Create from German');
});

// Machine output is badged in the column until somebody types over it.
const machine = { ...bilingual, translator: true };
const filled = (data: Record<string, unknown>) =>
  vi.fn(async () => Response.json({ data, pending: true }));

test('nothing offers a machine translation on a site with nothing to translate with', () => {
  const root = show({ entry: bilingual });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();

  expect($(root, 'button.btn-fill')).toBeNull();
  expect($(root, 'button.btn-translate')).toBeNull();
});

test('the second language offers to fill what it has nothing in', async () => {
  const fetchMock = filled({ title: 'Seaview Cottage', notes: undefined });
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: machine });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();

  $<HTMLButtonElement>(root, 'button.btn-fill')?.click();
  await tick();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/translate/listings/seaview-cottage/de', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  vi.unstubAllGlobals();
});

test('one field is translated on its own and the answer lands in the input', async () => {
  const fetchMock = filled({
    title: 'Meerblick-Häuschen',
    body: [{ _type: 'hero', _id: 'k3nf9a2p', heading: 'Über dem Hafen' }],
    _machine: ['title'],
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: machine });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();

  $<HTMLButtonElement>(root, 'button.btn-translate')?.click();
  await tick();
  flushSync();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/translate/listings/seaview-cottage/de', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: ['title'] }),
  });
  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Meerblick-Häuschen');
  expect($(root, '.badge-machine')).not.toBeNull();
  vi.unstubAllGlobals();
});

test('translation reserves preflush, freezes target and structure, then saves newer source prose', async () => {
  vi.useFakeTimers();
  const preflush = deferred<Response>();
  const translatedReply = deferred<Response>();
  let sourceWrites = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (isLock(url)) return Response.json(HELD);
    if (isLint(url)) return Response.json({ results: [] });
    if (url === '/admin/api/drafts/listings/seaview-cottage') {
      sourceWrites += 1;
      if (sourceWrites === 1) return preflush.promise;
      return Response.json({
        pending: true,
        problems: [],
        revisions: { en: 'source-3', de: 'target-2' },
      });
    }
    if (url === '/admin/api/translate/listings/seaview-cottage/de') return translatedReply.promise;
    return Response.json({ pending: true, problems: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show({
    entry: {
      ...machine,
      revisions: { en: 'source-1', de: 'target-1' },
    },
  });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  type(root, 'input#f-title', 'Source before translation');
  $<HTMLButtonElement>(root, 'button.btn-fill')?.click();
  await vi.advanceTimersByTimeAsync(0);
  flushSync();

  expect(
    fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/admin/api/translate/listings/seaview-cottage/de'),
    ),
  ).toBe(false);
  expect($<HTMLFieldSetElement>(root, '.entry-body > .form > fieldset')?.disabled).toBe(true);
  expect($<HTMLFieldSetElement>(root, '.pane.is-locale fieldset')?.disabled).toBe(true);

  preflush.resolve(
    Response.json({
      pending: true,
      problems: [],
      revisions: { en: 'source-2', de: 'target-1' },
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  flushSync();

  expect(
    fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/admin/api/translate/listings/seaview-cottage/de'),
    ),
  ).toBe(true);
  expect($<HTMLFieldSetElement>(root, '.entry-body > .form > fieldset')?.disabled).toBe(false);
  expect($<HTMLFieldSetElement>(root, '.pane.is-locale fieldset')?.disabled).toBe(true);
  expect($<HTMLButtonElement>(root, '#f-body button.add')?.disabled).toBe(true);

  type(root, 'input#f-title', 'Source typed during translation');
  await vi.advanceTimersByTimeAsync(2000);
  expect(sourceWrites).toBe(1);

  translatedReply.resolve(
    Response.json({
      data: {
        title: 'Von der Maschine',
        price: '£1,200 per week',
        body: [{ _type: 'hero', _id: 'k3nf9a2p', heading: 'Über dem Hafen' }],
        _machine: ['title'],
      },
      pending: true,
      revision: 'target-2',
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  await vi.waitFor(() => expect(sourceWrites).toBe(2));

  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Source typed during translation');
  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Von der Maschine');
  expect(
    wrote(fetchMock).filter(([url]) => url === '/admin/api/drafts/listings/seaview-cottage/de'),
  ).toHaveLength(0);
  expect($<HTMLFieldSetElement>(root, '.pane.is-locale fieldset')?.disabled).toBe(false);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('a block a machine filled is badged where the block is, not at the top', () => {
  const root = show({
    entry: {
      ...machine,
      translations: {
        de: {
          ...machine.translations.de,
          _machine: ['body[_id=k3nf9a2p].heading'],
        },
      },
    },
  });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();

  expect(
    $(root, '.field:has(> .label-row > label[for="t-body.0.heading"]) .badge-machine'),
  ).not.toBeNull();
  expect($(root, '.field:has(> .label-row > label[for="t-title"]) .badge-machine')).toBeNull();
});

test('a language with no file can be made and filled in one go', async () => {
  const fetchMock = posted();
  vi.stubGlobal('fetch', fetchMock);
  const changed = vi.fn();
  const root = show({ entry: { ...missing, translator: true }, onchanged: changed });

  $$<HTMLButtonElement>(root, '[aria-label="Language"] button')[1]?.click();
  flushSync();
  $<HTMLButtonElement>(root, 'button.btn-fill')?.click();
  await tick();

  expect(wrote(fetchMock).map((c) => c[0])).toEqual([
    '/admin/api/drafts/listings/seaview-cottage/de',
    '/admin/api/translate/listings/seaview-cottage/de',
  ]);
  expect(changed).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
});

test('typing over a machine-filled field takes its badge off there and then', () => {
  const root = show({
    entry: {
      ...machine,
      translations: { de: { ...machine.translations.de, _machine: ['title'] } },
    },
  });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  expect($(root, '.badge-machine')).not.toBeNull();

  type(root, 'input#t-title', 'Meerblick');

  expect($(root, '.badge-machine')).toBeNull();
});

// Entry-editor mockup 17: the source is changed on purpose, from the entry's own menu.
const openMenu = async (root: ParentNode) => {
  await tick();
  $<HTMLButtonElement>(root, '[aria-label="More actions"]')?.click();
  flushSync();
};
const changeSourceItem = (root: ParentNode) =>
  $$<HTMLButtonElement>(root, '[role="menuitem"]').find((b) =>
    b.textContent?.includes('Change source language'),
  );
const sourceCalls = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.filter((call) => String(call[0]).endsWith('/source'));
/** The source route answers `answer`; every other request is the autosave's. */
const sourcing = (answer: () => Response) =>
  vi.fn(async (url: string, _init?: RequestInit) =>
    isLock(url)
      ? Response.json(HELD)
      : isLint(url)
        ? Response.json({ results: [] })
        : url.endsWith('/source')
          ? answer()
          : Response.json({ updated_at: 1755864000000, pending: true, problems: [] }),
  );
const chooseSource = async (root: ParentNode) => {
  await openMenu(root);
  // A real click focuses the item, which the menu then removes.
  changeSourceItem(root)?.focus();
  changeSourceItem(root)?.click();
  await vi.waitFor(() => expect($(root, '.source-effects')).not.toBeNull());
};
const withRevisions = { ...bilingual, revisions: { en: 'rev-en', de: 'rev-de' } };

test('Change source language is offered only with two languages and two files', async () => {
  vi.stubGlobal('fetch', autosaved());
  const one = show();
  await openMenu(one);
  expect(changeSourceItem(one)).toBeUndefined();
  unmount(state.app);
  document.body.innerHTML = '';

  const single = show({ entry: { ...bilingual, translations: {} } });
  await openMenu(single);
  expect(changeSourceItem(single)).toBeUndefined();
  unmount(state.app);
  document.body.innerHTML = '';

  const two = show({ entry: bilingual });
  await openMenu(two);
  expect(changeSourceItem(two)?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Change source language… English is the source: blocks are added and moved there, and Translate works from it.',
  );
  expect(changeSourceItem(two)?.disabled).toBe(false);
  vi.unstubAllGlobals();
});

test('languages that disagree about blocks disable Change source language with the reason', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show({
    entry: {
      ...bilingual,
      drift: [
        {
          path: 'blocks[_id=z9y8x7w6]',
          type: 'quote',
          in: ['de'],
          expected: ['en', 'de'],
          values: { de: ['Ein seltener Fund.'] },
        },
      ],
    },
  });
  await openMenu(root);
  expect(changeSourceItem(root)?.disabled).toBe(true);
  expect($(root, '#change-source-sub')?.textContent).toBe(
    'The languages disagree about blocks — settle that first',
  );
  vi.unstubAllGlobals();
});

test('a save that failed first sends nothing, then disables Change source language', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    isLock(url)
      ? Response.json(HELD)
      : init?.method === 'PUT'
        ? new Response('', { status: 500 })
        : Response.json({ source: 'de' }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: withRevisions });
  type(root, 'input#f-title', 'Typed before the change');
  await chooseSource(root);
  $<HTMLButtonElement>(root, '.source-dialog .btn-primary')?.click();
  await settled();

  expect(sourceCalls(fetchMock)).toHaveLength(0);
  expect($(root, '.source-dialog [role="alert"]')?.textContent?.trim()).toBe(
    'Your last change could not be saved. Nothing was changed.',
  );
  $<HTMLButtonElement>(root, '.source-dialog .actions .btn')?.click();
  flushSync();
  await openMenu(root);
  expect(changeSourceItem(root)?.disabled).toBe(true);
  expect($(root, '#change-source-sub')?.textContent).toBe(
    'Your last change could not be saved — that has to work first',
  );
  vi.unstubAllGlobals();
});

test('a change sends the language and revisions, then reloads once and asks for the notice', async () => {
  const fetchMock = sourcing(() => Response.json({ source: 'de' }));
  vi.stubGlobal('fetch', fetchMock);
  const reloaded = vi.fn();
  const changed = vi.fn();
  const root = show({ entry: withRevisions, onreload: reloaded, onsourcechanged: changed });
  await chooseSource(root);
  expect($(root, '.source-dialog .btn-primary')?.textContent?.trim()).toBe(
    'Make German the source',
  );
  $<HTMLButtonElement>(root, '.source-dialog .btn-primary')?.click();
  await settled();

  expect(sourceCalls(fetchMock)).toEqual([
    [
      '/admin/api/entries/listings/seaview-cottage/source',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          locale: 'de',
          tab: 'tab-1',
          revisions: { en: 'rev-en', de: 'rev-de' },
        }),
      },
    ],
  ]);
  expect(changed).toHaveBeenCalledExactlyOnceWith('de');
  expect(reloaded).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

test('a concurrent change is refused with Reload and editing stays open', async () => {
  const fetchMock = sourcing(() =>
    Response.json(
      { code: 'ENTRY_SOURCE_REVISION', error: 'This entry changed since it was opened.' },
      { status: 409, headers: { 'x-handover-error-code': 'ENTRY_SOURCE_REVISION' } },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  const reloaded = vi.fn();
  const root = show({ entry: withRevisions, onreload: reloaded });
  await chooseSource(root);
  $<HTMLButtonElement>(root, '.source-dialog .btn-primary')?.click();
  await settled();

  expect(reloaded).not.toHaveBeenCalled();
  expect($(root, '.source-dialog [role="alert"]')?.textContent).toContain(
    'Somebody changed this entry while you were choosing.',
  );
  expect($<HTMLFieldSetElement>(root, '.entry-body > .form > fieldset')?.disabled).toBe(false);
  $<HTMLButtonElement>(root, '.source-dialog [role="alert"] button')?.click();
  expect(reloaded).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

test('a lost answer keeps editing closed and offers only Reload', async () => {
  const fetchMock = sourcing(
    () =>
      new Response('Connection lost', {
        status: 503,
        headers: {
          'x-handover-request-uncertain': 'true',
          'x-handover-error-code': 'CONNECTION_LOST',
        },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const reloaded = vi.fn();
  const root = show({ entry: withRevisions, onreload: reloaded });
  await chooseSource(root);
  $<HTMLButtonElement>(root, '.source-dialog .btn-primary')?.click();
  await settled();

  expect(reloaded).not.toHaveBeenCalled();
  expect($(root, '.source-dialog [role="alert"]')?.textContent?.trim()).toBe(
    'It could not be confirmed whether the source changed. Reload the entry before trying again. Reload',
  );
  expect($(root, '.source-dialog .actions')).toBeNull();
  expect($<HTMLFieldSetElement>(root, '.entry-body > .form > fieldset')?.disabled).toBe(true);
  $<HTMLButtonElement>(root, '.source-dialog [role="alert"] button')?.click();
  expect(reloaded).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

test('after the change a notice says it waits for the entry to publish', () => {
  vi.stubGlobal('fetch', autosaved());
  const german = { ...bilingual, sourceLocale: 'de', pending: ['en', 'de'] };
  const root = show({ entry: german, sourceChanged: 'de' });
  expect($(root, '.lock-banner[role="status"]')?.textContent).toBe(
    'German is now the source. It is on the site when you publish this entry — every language file carries the change.',
  );
  unmount(state.app);
  document.body.innerHTML = '';

  const published = show({ entry: { ...german, pending: [] }, sourceChanged: 'de' });
  expect($(published, '.lock-banner[role="status"]')).toBeNull();
  vi.unstubAllGlobals();
});

test('Escape closes the source dialog and gives focus back to the menu button', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show({ entry: bilingual });
  $<HTMLButtonElement>(root, '[aria-label="More actions"]')?.focus();
  await chooseSource(root);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();

  expect($(root, '.source-dialog')).toBeNull();
  expect(document.activeElement).toBe($(root, '[aria-label="More actions"]'));
  vi.unstubAllGlobals();
});

test('side by side and creating a language never ask to change the source', async () => {
  const fetchMock = posted();
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: missing });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  $$<HTMLButtonElement>(root, '[aria-label="Language"] button')[1]?.click();
  flushSync();
  $<HTMLButtonElement>(root, 'button.btn-primary.btn-create')?.click();
  await tick();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/drafts/listings/seaview-cottage/de', {
    method: 'POST',
  });
  expect(sourceCalls(fetchMock)).toHaveLength(0);
  vi.unstubAllGlobals();
});
