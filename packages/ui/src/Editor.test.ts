import { type Drift, type Field, LOCK_TTL } from '@handover/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Editor from './Editor.svelte';

const entry = {
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    {
      path: ['seo'],
      label: 'Seo',
      type: 'group',
      required: false,
      fields: [{ path: ['description'], label: 'Description', type: 'text', required: false }],
    },
    { path: ['photos'], label: 'Photos', type: 'unsupported' },
  ] satisfies Field[],
  blocks: {},
  data: { title: 'Seaview Cottage', seo: { description: 'Harbour view' }, photos: [] },
  pending: [] as string[],
  problems: [] as { path: string; message: string }[],
  locales: ['en'],
  defaultLocale: 'en',
  sourceLocale: 'en',
  offered: ['en'],
  translations: {} as Record<string, Record<string, unknown>>,
  stale: [] as string[],
  drift: [] as Drift[],
};

// The same entry on a site that declares two languages. `price` is the same in both, `notes`
// belongs to English alone, and the German file is the other half of the screen.
const bilingual = {
  ...entry,
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['price'], label: 'Price', type: 'text', required: true, i18n: 'duplicate' },
    { path: ['notes'], label: 'Notes', type: 'text', required: false, i18n: false },
    { path: ['body'], label: 'Body', type: 'blocks', required: true, types: ['hero'] },
  ] satisfies Field[],
  blocks: { hero: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }] },
  data: {
    title: 'Seaview Cottage',
    price: '£1,200 per week',
    notes: 'Saturday changeovers',
    body: [{ _type: 'hero', _id: 'k3nf9a2p', heading: 'Above the harbour' }],
  },
  locales: ['en', 'de'],
  offered: ['en', 'de'],
  translations: {
    de: {
      title: 'Seaview Cottage',
      price: '£1,200 per week',
      body: [{ _type: 'hero', _id: 'k3nf9a2p', heading: 'Über dem Hafen' }],
    },
  },
};

const opened = vi.fn();

let app: ReturnType<typeof mount>;
const show = (over: Record<string, unknown> = {}) => {
  app = mount(Editor, {
    target: document.body,
    props: {
      collection: 'listings',
      slug: 'seaview-cottage',
      entry,
      onpublish: opened,
      onchanged: () => {},
      ...over,
    },
  });
  return document.body;
};
afterEach(() => {
  unmount(app);
  opened.mockClear();
});

// jsdom has no layout, so nothing scrolls; the count still has to move focus.
Element.prototype.scrollIntoView = () => {};

const $ = <T extends Element>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
const $$ = <T extends Element>(root: ParentNode, sel: string) =>
  Array.from(root.querySelectorAll<T>(sel));

test('renders one labelled input per text field, filled from the entry data', () => {
  const root = show();
  expect($(root, 'label[for="f-title"]')?.textContent).toBe('Title*');
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Seaview Cottage');
  expect($(root, 'label[for="f-seo.description"]')?.textContent).toBe('Description');
  expect($<HTMLInputElement>(root, 'input#f-seo\\.description')?.value).toBe('Harbour view');
});

test('an unsupported field shows a marker instead of an input', () => {
  const root = show();
  expect($(root, 'input#f-photos')).toBeNull();
  expect($(root, 'label[for="f-photos"]')?.textContent).toBe('Photos');
  expect($(root, '#f-photos')?.textContent).toBe('Not editable here yet');
});

const type = (root: ParentNode, sel: string, value: string) => {
  const input = $<HTMLInputElement>(root, sel);
  if (!input) throw new Error(`${sel} missing`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};
const tick = () => new Promise((r) => setTimeout(r, 0));
// Every editor takes the entry's lock as it opens, so a stub answers that route too — an answer
// of any other shape reads as somebody else holding it, and the screen would go read-only.
const HELD = { held_by: null, mine: true, expires_at: 1755864120000, base: {} };
const isLock = (url: unknown) => String(url).startsWith('/admin/api/locks/');
/** The writes a test is about: the beat rides on the same fetch and is none of them. */
const wrote = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.filter((call) => !isLock(call[0]));
const autosaved = () =>
  vi.fn(async (url: string) =>
    isLock(url)
      ? Response.json(HELD)
      : Response.json({ updated_at: 1755864000000, pending: true, problems: [] }),
  );

const withProblems = (problems: { path: string; message: string }[]) => {
  app = mount(Editor, {
    target: document.body,
    props: {
      collection: 'listings',
      slug: 'seaview-cottage',
      entry: { ...entry, pending: ['en'], problems },
      onpublish: opened,
      onchanged: () => {},
    },
  });
  return document.body;
};

test('the header shows the entry title; Publish is disabled until something changes', () => {
  const root = show();
  expect($(root, 'h1')?.textContent).toBe('Seaview Cottage');
  const publish = $<HTMLButtonElement>(root, 'button.btn-primary');
  expect(publish?.textContent).toBe('Publish…');
  expect(publish?.disabled).toBe(true);
  type(root, 'input#f-title', 'Seaview House');
  expect(publish?.disabled).toBe(false);
});

test('the header shows the field the collection is keyed on', () => {
  const root = show({
    collection: 'presenters',
    slug: 'rosa-hale',
    entry: {
      fields: [{ path: ['name'], label: 'Name', type: 'text', required: true }] satisfies Field[],
      blocks: {},
      data: { name: 'Rosa Hale' },
      pending: [],
      problems: [],
      titleField: 'name',
      locales: ['en'],
      defaultLocale: 'en',
      sourceLocale: 'en',
      translations: {},
      stale: [],
      drift: [],
    },
  });
  expect($(root, 'h1')?.textContent).toBe('Rosa Hale');
});

test('Publish stores the edit as a draft before it opens the drawer', async () => {
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  type(root, 'input#f-title', 'Seaview House');
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();
  expect(fetchMock).toHaveBeenCalledWith('/admin/api/drafts/listings/seaview-cottage', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      data: { title: 'Seaview House', seo: { description: 'Harbour view' }, photos: [] },
    }),
  });
  expect(opened).toHaveBeenCalled();
  vi.unstubAllGlobals();
});

// The draft is what the browser read, not what the descriptors describe: a field renamed in
// schemas.ts before its migration is written would otherwise lose its value on the first save.
test('a key no descriptor mentions is written back, not dropped', async () => {
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show({
    entry: { ...entry, data: { ...entry.data, subtitle: 'By the harbour' } },
  });
  type(root, 'input#f-title', 'Seaview House');
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();
  expect(fetchMock).toHaveBeenCalledWith('/admin/api/drafts/listings/seaview-cottage', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      data: {
        title: 'Seaview House',
        seo: { description: 'Harbour view' },
        photos: [],
        subtitle: 'By the harbour',
      },
    }),
  });
  vi.unstubAllGlobals();
});

test('an edit that could not be stored does not open the drawer', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('nope', { status: 500 })),
  );
  const root = show();
  type(root, 'input#f-title', 'Seaview House');
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();
  expect(opened).not.toHaveBeenCalled();
  expect($(root, '.autosave')?.textContent).toBe('Not saved');
  vi.unstubAllGlobals();
});

test('editing the title input updates the title in the header', () => {
  const root = show();
  const input = $<HTMLInputElement>(root, 'input#f-title');
  if (!input) throw new Error('title input missing');
  input.value = 'Seaview House';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect($(root, 'h1')?.textContent).toBe('Seaview House');
});

test('an edit is sent as a draft two seconds after the last keystroke', async () => {
  vi.useFakeTimers();
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  type(root, 'input#f-title', 'Seaview House');

  await vi.advanceTimersByTimeAsync(2000);
  flushSync();
  expect(fetchMock).toHaveBeenCalledWith('/admin/api/drafts/listings/seaview-cottage', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      data: { title: 'Seaview House', seo: { description: 'Harbour view' }, photos: [] },
    }),
  });
  expect($(root, '.autosave')?.textContent).toBe('Saved');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('each keystroke restarts the two seconds, so one pause is one draft write', async () => {
  vi.useFakeTimers();
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  type(root, 'input#f-title', 'Seaview H');
  await vi.advanceTimersByTimeAsync(1500);
  type(root, 'input#f-title', 'Seaview House');
  await vi.advanceTimersByTimeAsync(1500);
  expect(wrote(fetchMock)).toEqual([]);

  await vi.advanceTimersByTimeAsync(500);
  expect(wrote(fetchMock)).toHaveLength(1);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('opening an entry and changing nothing writes no draft', async () => {
  vi.useFakeTimers();
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  show();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(wrote(fetchMock)).toEqual([]);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// The lock is the entry's, so what it takes away is everything that writes to any of its files.
const heldBy = (over: Record<string, unknown> = {}) =>
  vi.fn(async (url: string) =>
    isLock(url)
      ? Response.json({
          held_by: { id: 'u1', name: 'Anna Berg' },
          mine: false,
          expires_at: Date.now() + LOCK_TTL,
          base: {},
          ...over,
        })
      : Response.json({}),
  );

test('an entry somebody else is editing reads, and says who has it', async () => {
  vi.stubGlobal('fetch', heldBy());
  const root = show();
  await tick();
  flushSync();

  expect($(root, '.lock-banner')?.textContent).toContain('Being edited by Anna Berg');
  expect($(root, '.lock-banner .when')?.textContent).toContain('active a few seconds ago');
  expect($<HTMLFieldSetElement>(root, '.form > fieldset')?.disabled).toBe(true);
  expect($<HTMLButtonElement>(root, 'button.btn-primary')?.disabled).toBe(true);
  vi.unstubAllGlobals();
});

// The whole of the decision the banner is there for: a lock held by somebody who has stopped
// typing is a minute from freeing itself, and one held by somebody mid-sentence is not.
test('the banner says how long ago the holder last typed', async () => {
  vi.stubGlobal('fetch', heldBy({ expires_at: Date.now() + LOCK_TTL - 70_000 }));
  const root = show();
  await tick();
  flushSync();

  expect($(root, '.lock-banner .when')?.textContent).toContain('nothing typed for a minute');
  vi.unstubAllGlobals();
});

test('a lock that has run out leaves the screen reading, with a way back in', async () => {
  vi.stubGlobal('fetch', heldBy({ held_by: null, expires_at: null }));
  const changed = vi.fn();
  const root = show({ onchanged: changed });
  await tick();
  flushSync();

  expect($(root, '.lock-banner')?.textContent).toContain('Nobody is editing this entry any more');
  expect($<HTMLFieldSetElement>(root, '.form > fieldset')?.disabled).toBe(true);
  $<HTMLButtonElement>(root, '.lock-banner .btn-link')?.click();
  expect(changed).toHaveBeenCalled();
  vi.unstubAllGlobals();
});

test('the entry this screen opened is taken as it opens', async () => {
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  show();
  await tick();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/locks/listings/seaview-cottage', {
    method: 'POST',
  });
  vi.unstubAllGlobals();
});

test('a draft that is ahead of the published file can be published on load', () => {
  app = mount(Editor, {
    target: document.body,
    props: {
      collection: 'listings',
      slug: 'seaview-cottage',
      entry: { ...entry, pending: ['en'] },
      onpublish: opened,
      onchanged: () => {},
    },
  });
  expect($<HTMLButtonElement>(document.body, 'button.btn-primary')?.disabled).toBe(false);
});

test('a draft write that fails says so instead of claiming it is saved', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('nope', { status: 500 })),
  );
  const root = show();
  type(root, 'input#f-title', 'Seaview House');
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();
  expect($(root, '.autosave')?.textContent).toBe('Not saved');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('a draft that matches the published file again leaves nothing to publish', async () => {
  vi.useFakeTimers();
  // The server owns the answer: it compares the stored bytes against the file in git.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) =>
      Response.json({
        updated_at: 1755864000000,
        pending: !init.body.includes('"title":"Seaview Cottage"'),
        problems: [],
      }),
    ),
  );
  const root = show();
  type(root, 'input#f-title', 'Seaview House');
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();
  expect($<HTMLButtonElement>(root, 'button.btn-primary')?.disabled).toBe(false);

  type(root, 'input#f-title', 'Seaview Cottage');
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();
  expect($<HTMLButtonElement>(root, 'button.btn-primary')?.disabled).toBe(true);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// S1: a new entry whose required field has no widget yet used to say only "Not saved". The
// entry names what is missing instead, and the schema stops it at the publish.
test('what the schema is still missing is counted in the header and marked on the field', () => {
  const root = withProblems([{ path: 'title', message: 'Required' }]);
  expect($(root, '.problems')?.textContent).toBe('1 problem');
  expect($(root, 'input#f-title')?.getAttribute('aria-invalid')).toBe('true');
  expect($(root, '#f-title-err')?.textContent).toBe('Required');
});

test('two problems are counted as two, and Publish is held back until they are gone', () => {
  const root = withProblems([
    { path: 'title', message: 'Required' },
    { path: 'seo.description', message: 'Required' },
  ]);
  expect($(root, '.problems')?.textContent).toBe('2 problems');
  expect($<HTMLButtonElement>(root, 'button.btn-primary')?.disabled).toBe(true);
});

test('the problem count moves focus to the first field it is counting', () => {
  const root = withProblems([{ path: 'seo.description', message: 'Required' }]);
  $<HTMLButtonElement>(root, '.problems')?.click();
  flushSync();
  expect(document.activeElement?.id).toBe('f-seo.description');
});

test('an entry with nothing missing shows no count', () => {
  const root = show();
  expect($(root, '.problems')).toBeNull();
});

test('an autosave that stores an entry the schema refuses says so instead of Not saved', async () => {
  vi.useFakeTimers();
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
  const root = show();
  type(root, 'input#f-title', '');
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();
  expect($(root, '.autosave')?.textContent).toBe('Saved');
  expect($(root, '.problems')?.textContent).toBe('1 problem');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// State 10: the form is about a structure the languages have not agreed on, so it is not drawn.
test('an entry whose languages disagree gets the panel where its form would be', () => {
  const root = show({
    entry: {
      ...entry,
      drift: [
        {
          path: 'blocks[_id=z9y8x7w6]',
          type: 'quote',
          in: ['de'],
          expected: ['en', 'de'],
          values: { de: ['Ein seltener Fund.'] },
        },
      ],
      locales: ['en', 'de'],
    },
  });

  expect($(root, '.lock-banner.is-drift')).not.toBe(null);
  expect($(root, '.drift .block-card')).not.toBe(null);
  expect($(root, 'form.form')).toBe(null);
  expect($<HTMLButtonElement>(root, 'header button.btn-primary')?.disabled).toBe(true);
});

// F2: the list read `_locales` one way and the form another. Now the file wins and the
// disagreement is said out loud, above the form it would otherwise have decided in silence.
test('an entry whose _locales its files contradict says so', () => {
  const root = show({
    entry: {
      ...bilingual,
      offerProblems: ['_locales says this entry is not offered in de, and it has a file in de'],
    },
  });

  const banner = $(root, '.lock-banner.is-offer');
  expect(banner?.textContent).toContain('not offered in de');
  expect($(root, 'form.form')).not.toBe(null);
});

// One language declared is a CMS with no i18n in it: the controls are not drawn at all, and
// the rule is on the config rather than on the data — two languages and no German file still
// draws every one of them, because the missing German is what the client is meant to see.
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

// Five languages is where a row of buttons stops fitting, so the switcher becomes a menu —
// Sveltia's threshold, and the only other shape this control has.
test('a site with five languages picks its language from a menu', () => {
  const five = ['en', 'de', 'fr', 'es', 'it'];
  const root = show({ entry: { ...bilingual, locales: five, offered: five } });

  expect($(root, '[aria-label="Language"]')).toBeNull();
  const menu = $<HTMLSelectElement>(root, 'select#entry-locale');
  expect(Array.from(menu?.options ?? [], (o) => o.value)).toEqual(five);
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
    }),
  });
  vi.unstubAllGlobals();
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

// The second language is its own file, so its draft is its own reason to publish: the button
// cannot go back to disabled the moment that save lands.
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

// The second column is a component with its own copy of one language's file. Anything that
// takes it off the screen — closing it, choosing another language — has to store what is in it
// first, and anything that points it at another language has to give it that language's words.
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

// The other half of that: a translation already stored ahead of the repository when the screen
// opens — which is what Create from English leaves behind — is the entry's to publish, without
// anybody opening the column and typing in it.
test('a translation drafted before the screen opened is something to publish', () => {
  const root = show({ entry: { ...bilingual, pending: ['de'] } });

  expect($<HTMLButtonElement>(root, 'button.btn-primary')?.disabled).toBe(false);
});

// A language with no file: two ways out, and an empty form is neither — it would autosave a
// file nobody asked for.
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

// The other way to turn a language off: on one that has a file, which is a delete of that file.
// It is asked for where the column is — beside its close button — and through the dialog a
// delete gets, naming the URL that goes and where its readers are sent.
test('a language with a file is turned off from its own column, through a dialog', async () => {
  const fetchMock = posted();
  vi.stubGlobal('fetch', fetchMock);
  const root = show({
    entry: { ...bilingual, route: '/listings/[slug]', index: '/listings' },
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
    body: JSON.stringify({ locales: ['en'] }),
  });
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

// An entry written in a language the site does not default to: no English file was ever made,
// so German is where its structure is edited and what its English would be created from.
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

// Machine translation. Nothing is drawn without something to translate with, and what a
// machine wrote is badged in the column until somebody types over it.
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

// An address per language: its own row in the header rather than a field in the form, because
// it is validated, has to be unique and owes a redirect when a published one moves.
const addressed = {
  ...bilingual,
  localizedSlugs: true,
  addresses: { en: '', de: 'ueber-dem-hafen' },
  route: '/listings/[slug]',
};

const switchTo = (body: HTMLElement, code: string) => {
  const button = Array.from(body.querySelectorAll<HTMLButtonElement>('.seg button')).find((b) =>
    b.textContent?.includes(code),
  );
  button?.click();
  flushSync();
};

test('the address row shows the URL this language serves, and its fallback', () => {
  const body = show({ entry: addressed });

  const row = body.querySelector('.slug-row');
  expect(row?.querySelector('.url')?.textContent).toBe('/listings/seaview-cottage');
  expect(row?.querySelector('.mode')?.textContent).toBe('Same as the file name');
});

test('a collection without localized slugs has no address row', () => {
  expect(show({ entry: bilingual }).querySelector('.slug-row')).toBe(null);
});

// One language's address, not the entry's: the other languages' URLs did not move.
test('the row follows the language the switcher is on', async () => {
  const body = show({ entry: addressed });

  switchTo(body, 'DE');

  expect(body.querySelector('.slug-row .url')?.textContent).toBe('/de/listings/ueber-dem-hafen');
  expect(body.querySelector('.slug-row .mode')).toBe(null);
});

test('a language the entry has no file in has no address to edit', () => {
  const body = show({ entry: { ...addressed, translations: {}, addresses: { en: '' } } });

  switchTo(body, 'DE');

  expect(body.querySelector('.slug-row')).toBe(null);
});

test('the reason an address was refused is shown against the row', async () => {
  const body = show({ entry: addressed });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('"home" is already the web address of another entry', { status: 409 }),
    ),
  );

  (body.querySelector('.slug-row .btn-link') as HTMLButtonElement).click();
  flushSync();
  (body.querySelector('.slug-row .btn') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(body.querySelector('.slug-row .is-bad')).not.toBe(null));

  expect(body.querySelector('.slug-row .is-bad')?.textContent).toMatch(/already the web address/);
  vi.unstubAllGlobals();
});
