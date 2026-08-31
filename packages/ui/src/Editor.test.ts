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
  published: ['en'],
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

// Singleton mode is a subtraction and nothing else: what a global cannot have is what a
// collection's routes are about, and everything that makes it editable content stays.
test('a global is drawn without the status chip, the overflow menu or the tab bar', () => {
  const root = show({
    collection: 'globals',
    slug: 'site',
    entry: { ...entry, singleton: true, label: 'Site details' },
  });

  expect($(root, '.status')).toBeNull();
  expect($(root, '[aria-label="More actions"]')).toBeNull();
  expect($(root, '[role="tablist"]')).toBeNull();
  // What stays: the hold toggle and the entry's own Publish.
  expect($(root, '.hold-toggle')).not.toBeNull();
  expect($(root, '.btn-primary')?.textContent).toContain('Publish this entry');
});

test("a global is named by the dev's label, under Site settings", () => {
  const root = show({
    collection: 'globals',
    slug: 'site',
    entry: { ...entry, singleton: true, label: 'Site details' },
  });

  expect($(root, 'h1')?.textContent).toBe('Site details');
  expect($(root, '.crumbs')?.textContent).toContain('Site settings');
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
// The token the editor sends with every beat and save is per browser tab and kept in session
// storage, so pinning it there is what makes the bodies below literal.
sessionStorage.setItem('handover-tab', 'tab-1');
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

// Preview is a page on the site, so an entry nothing renders — every global, and any collection
// without a route — has nowhere to open and is not offered the button.
test('Preview is offered only where the site has a page to show', () => {
  expect($(show(), 'button.btn-preview')).toBeNull();
  unmount(app);
  const root = show({ entry: { ...entry, route: '/listings/[slug]' } });
  expect($<HTMLButtonElement>(root, 'button.btn-preview')?.getAttribute('aria-pressed')).toBe(
    'false',
  );
});

test('pressing Preview puts the page beside the form, at the address this language serves it', () => {
  const root = show({
    entry: { ...entry, route: '/listings/[slug]', published: [] },
    preview: true,
  });

  $<HTMLButtonElement>(root, 'button.btn-preview')?.click();
  flushSync();

  expect($<HTMLIFrameElement>(root, '.pane.is-preview iframe')?.getAttribute('src')).toContain(
    '/_preview/listings/seaview-cottage',
  );
  // The entry has never been published, so the pane says the address is one it will get.
  expect($(root, '.preview-banner')?.textContent).toContain('Not published yet');
  // And the form it is beside is still there: previewing is not a second screen.
  expect($(root, 'input#f-title')).not.toBeNull();
});

test('the header shows the entry title; Publish is disabled until something changes', () => {
  const root = show();
  expect($(root, 'h1')?.textContent).toBe('Seaview Cottage');
  const publish = $<HTMLButtonElement>(root, 'button.btn-primary');
  expect(publish?.textContent).toBe('Publish this entry');
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

test('Publish stores the edit as a draft before it asks to commit it', async () => {
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
      tab: 'tab-1',
    }),
  });
  // The title it names is the one that was just typed, not the one the entry was loaded with.
  expect($(root, '.dialog h2')?.textContent).toBe('Publish Seaview House?');
  vi.unstubAllGlobals();
});

test('Escape closes the publish dialog and gives focus back to the button', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show({ entry: { ...entry, pending: ['en'] } });
  const button = $<HTMLButtonElement>(root, 'button.btn-primary');
  button?.focus();
  button?.click();
  await tick();
  flushSync();
  expect($(root, '.dialog')).not.toBeNull();

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  flushSync();

  expect($(root, '.dialog')).toBeNull();
  expect(document.activeElement).toBe(button);
  vi.unstubAllGlobals();
});

// An entry you were holding back publishes like any other, and the hold goes with the draft:
// the button is not blocked by it, and what comes back has the toggle off.
test('an entry on hold can still be published from its own header', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show({ entry: { ...entry, pending: ['en'], held: true } });
  const button = $<HTMLButtonElement>(root, 'button.btn-primary');
  expect(button?.disabled).toBe(false);
  expect($(root, '.hold-toggle')?.getAttribute('aria-pressed')).toBe('true');
  button?.click();
  await tick();
  flushSync();
  expect($(root, '.dialog h2')?.textContent).toBe('Publish Seaview Cottage?');
  vi.unstubAllGlobals();
});

// The one-entry half of publishing: it commits, so it confirms, and it names everything that
// goes with the entry — every language file, since they are written together.
test('Publish this entry names the language files it is about to commit', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show({ entry: { ...bilingual, pending: ['en', 'de'] } });
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();

  expect($(root, '.dialog h2')?.textContent).toBe('Publish Seaview Cottage?');
  expect($(root, '.dialog .publish-set')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'ENDE All 2 language files',
  );
  vi.unstubAllGlobals();
});

test('confirming publishes this entry alone and reads the screen again', async () => {
  const changed = vi.fn();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    isLock(url)
      ? Response.json(HELD)
      : init?.method === 'POST' && url === '/admin/api/publish'
        ? Response.json({ commit_sha: 'def4567890', paths: ['src/content/x.yaml'] })
        : Response.json({ updated_at: 1755864000000, pending: true, problems: [] }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: { ...entry, pending: ['en'] }, onchanged: changed });
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();
  $<HTMLButtonElement>(root, '.dialog .btn-primary')?.click();
  await tick();
  flushSync();

  expect(fetchMock).toHaveBeenLastCalledWith('/admin/api/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: ['listings/seaview-cottage'] }),
  });
  expect(changed).toHaveBeenCalled();
  expect($(root, '.dialog')).toBeNull();
  vi.unstubAllGlobals();
});

// Detection, not resolution: the header says the entry is stale and the drawer's Discard is
// the way out. Choosing field by field is the three-way view, which is not built yet.
test('a file somebody changed in the repository badges the header and names the drawer', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      isLock(url)
        ? Response.json(HELD)
        : url === '/admin/api/publish'
          ? Response.json({ error: 'moved', paths: ['src/content/x.yaml'] }, { status: 409 })
          : Response.json({ updated_at: 1755864000000, pending: true, problems: [] }),
    ),
  );
  const root = show({ entry: { ...entry, pending: ['en'] } });
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();
  $<HTMLButtonElement>(root, '.dialog .btn-primary')?.click();
  await tick();
  flushSync();

  expect($(root, '.dialog')).toBeNull();
  expect($(root, '.entry-header .badge-danger')?.textContent).toBe(
    'Changed in the repository since you opened it',
  );
  expect($(root, '.entry-header .subline')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Somebody changed this in the repository after you opened it. Open Unpublished changes to resolve it field by field, or to discard yours and take what is there now.',
  );
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
      tab: 'tab-1',
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
      tab: 'tab-1',
    }),
  });
  expect($(root, '.autosave')?.textContent).toBe('Saved');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// The drawer counts entries, not keystrokes: it is stale only while an entry it does not know
// about has become pending, so the shell is told when that flips and not on every save.
test('the first save that makes an entry pending tells the shell; the next does not', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', autosaved());
  const pending = vi.fn();
  const root = show({ onpending: pending });

  type(root, 'input#f-title', 'Seaview House');
  await vi.advanceTimersByTimeAsync(2000);
  expect(pending).toHaveBeenCalledTimes(1);

  type(root, 'input#f-title', 'Seaview Cottage House');
  await vi.advanceTimersByTimeAsync(2000);
  expect(pending).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// An entry already ahead of the repository when it opened is already counted, so a save of it
// tells the shell nothing it does not know.
test('a save of an entry that was already pending tells the shell nothing', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', autosaved());
  const pending = vi.fn();
  const root = show({ entry: { ...entry, pending: ['en'] }, onpending: pending });

  type(root, 'input#f-title', 'Seaview House');
  await vi.advanceTimersByTimeAsync(2000);

  expect(pending).not.toHaveBeenCalled();
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

// The lock is the tab's, so the same person's second tab is refused too — and told it is their
// own other tab rather than "Being edited by" themselves.
test('the same person in a second tab is told it is open in another tab', async () => {
  vi.stubGlobal('fetch', heldBy({ held_by: { id: 'u2', name: 'Anna' } }));
  const root = show({ userId: 'u2' });
  await tick();
  flushSync();

  expect($(root, '.lock-banner')?.textContent).toContain('You have this open in another tab');
  expect($(root, '.lock-banner')?.textContent).not.toContain('Being edited by');
  expect($<HTMLFieldSetElement>(root, '.form > fieldset')?.disabled).toBe(true);
  vi.unstubAllGlobals();
});

// What tells the tabs apart: a token this tab made up, on every beat and on every save.
test('the beat and the save carry the same tab token', async () => {
  vi.useFakeTimers();
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  type(root, 'input#f-title', 'Seaview House');
  await vi.advanceTimersByTimeAsync(2000);

  const sent = (call: unknown[]) =>
    (JSON.parse((call[1] as { body: string }).body) as { tab?: string }).tab;
  const beat = fetchMock.mock.calls.find((call) => isLock(call[0]));
  const save = wrote(fetchMock)[0];
  expect(sent(beat ?? [])).toMatch(/\S/);
  expect(sent(save ?? [])).toBe(sent(beat ?? []));
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

  expect(fetchMock).toHaveBeenCalledWith(
    '/admin/api/locks/listings/seaview-cottage',
    expect.objectContaining({ method: 'POST', body: expect.stringContaining('"tab":') }),
  );
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
    vi.fn(async (url: string, init: { body: string }) =>
      isLock(url)
        ? Response.json(HELD)
        : Response.json({
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
      tab: 'tab-1',
    }),
  });
  vi.unstubAllGlobals();
});

// The pane renders what is stored, and the second column stores its own file: a save there is
// as much a reason to draw the page again as a save on this one.
test('a save in the second language asks the preview for the page again', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show({
    entry: { ...bilingual, route: '/listings/[slug]', published: ['en', 'de'] },
    preview: true,
  });

  $$<HTMLButtonElement>(root, '.entry-header .seg button')[1]?.click();
  flushSync();
  $<HTMLButtonElement>(root, 'button.btn-preview')?.click();
  flushSync();
  const before = $<HTMLIFrameElement>(root, '.pane.is-preview iframe')?.getAttribute('src');
  type(root, 'input#t-title', 'Seeblick-Häuschen');
  // Publishing flushes the column's draft, which is the settled save without waiting two seconds.
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();

  expect($<HTMLIFrameElement>(root, '.pane.is-preview iframe')?.getAttribute('src')).not.toBe(
    before,
  );
  vi.unstubAllGlobals();
});

// The skeleton is one edit to every language. The server has always mirrored a move into the
// other language's stored row; the second column used to keep the copy it was opened with and
// show the new order on the next open — Phase 3's W1.
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
// dnd-kit reads the cards' boxes to know where a key press lands; jsdom has none, so each card
// is a 100px band in the order it sits in — the same stub the Fields tests use.
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
  expect(germanBlocks(root)).toEqual(['hero', 'cta']);

  const handle = $<HTMLButtonElement>(root, '[aria-label="Reorder hero"]');
  if (!handle) throw new Error('no handle');
  await press(handle, 'Space');
  await press(document.body, 'ArrowDown');
  await press(document.body, 'Space');

  expect(germanBlocks(root)).toEqual(['cta', 'hero']);
  // Its words went with it: the German heading is still the hero's.
  expect($<HTMLInputElement>(root, 'input#t-body\\.1\\.heading')?.value).toBe('Über dem Hafen');
  expect(wrote(fetchMock)).toHaveLength(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

// The mirror runs as the column opens too, so it has to agree that nothing has moved: a save
// on open would make every side-by-side look an unpublished change.
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

// The server refuses a turn-off that would leave the entry with no published file, and the
// sentence it refuses with is the one worth reading: the dialog stays open and shows it.
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
  const root = show({
    entry: { ...bilingual, route: '/listings/[slug]', index: '/listings' },
    onchanged: changed,
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
  vi.unstubAllGlobals();
});

// Turning German off deletes the German file, so *Turn German back on* alone hands over an
// empty form and the words are only in the repository. Where the CMS is what turned it off, the
// log knows which commit to undo and the offer is to bring them back.
test('a language the CMS turned off offers the words back rather than an empty form', async () => {
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
        : Response.json({}),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: { ...missing, offered: ['en'] } });
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

// The other half of a take-over, from the tab that lost the entry: it finds out because the
// save it makes next comes back refused, and everything about the screen follows from that.
const refused = () =>
  vi.fn(async (url: string) =>
    isLock(url)
      ? Response.json(HELD)
      : Response.json(
          {
            held_by: { id: 'u1', name: 'Anna Berg' },
            mine: false,
            expires_at: Date.now() + LOCK_TTL,
          },
          { status: 409 },
        ),
  );

test('a save refused by a take-over says where the work went and stops the tab', async () => {
  vi.useFakeTimers();
  const fetchMock = refused();
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  type(root, 'input#f-title', 'Seaview House');

  await vi.advanceTimersByTimeAsync(2000);
  flushSync();

  expect($(root, '.lock-banner.is-lost')?.textContent).toContain('Anna Berg took over this entry');
  expect($<HTMLFieldSetElement>(root, '.form > fieldset')?.disabled).toBe(true);
  expect($<HTMLButtonElement>(root, 'button.btn-primary')?.disabled).toBe(true);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// 3.9 beat on every save, refused or not. Once a refusal means "you lost it", that beat would
// push the lock the entry no longer has back out.
test('a refused save does not push the lock back out', async () => {
  vi.useFakeTimers();
  const fetchMock = refused();
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  // Past the three quarters of a lifetime that says the next save also beats.
  await vi.advanceTimersByTimeAsync(50_000);
  const before = fetchMock.mock.calls.filter((call) => isLock(call[0])).length;
  type(root, 'input#f-title', 'Seaview House');

  await vi.advanceTimersByTimeAsync(2000);
  flushSync();

  expect(fetchMock.mock.calls.filter((call) => isLock(call[0])).length).toBe(before);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Sitting still was the one way never to find out: the holder's tab only heard of a take-over
// from the save it made next. Now it asks on its own, and again when it comes back to the front.
const takenMeanwhile = () =>
  vi.fn(async (url: string, init?: RequestInit) =>
    !isLock(url)
      ? Response.json({})
      : init?.method === 'POST'
        ? Response.json(HELD)
        : Response.json({
            held_by: { id: 'u1', name: 'Anna Berg' },
            mine: false,
            expires_at: Date.now() + LOCK_TTL,
          }),
  );

test('a holder who types nothing still learns of a take-over within the poll', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', takenMeanwhile());
  const root = show();
  await vi.advanceTimersByTimeAsync(1000);
  flushSync();
  expect($(root, '.lock-banner')).toBeNull();

  await vi.advanceTimersByTimeAsync(15_000);
  flushSync();

  expect($(root, '.lock-banner.is-lost')?.textContent).toContain('Anna Berg took over this entry');
  expect($<HTMLFieldSetElement>(root, '.form > fieldset')?.disabled).toBe(true);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('a tab coming back to the front asks about its lock at once', async () => {
  vi.useFakeTimers();
  const fetchMock = takenMeanwhile();
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await vi.advanceTimersByTimeAsync(1000);
  const reads = () =>
    fetchMock.mock.calls.filter((call) => isLock(call[0]) && call[1]?.method !== 'POST').length;
  expect(reads()).toBe(0);

  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  flushSync();

  expect(reads()).toBe(1);
  expect($(root, '.lock-banner.is-lost')).not.toBeNull();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// A lock that lapsed with nobody after it is not a take-over: the tab is still here, so it takes
// its own lock back rather than telling the person somebody else has the entry.
test('a lapsed lock nobody took is claimed again by the tab that had it', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    !isLock(url)
      ? Response.json({})
      : init?.method === 'POST'
        ? Response.json(HELD)
        : Response.json({ held_by: null, mine: false, expires_at: null }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await vi.advanceTimersByTimeAsync(16_000);
  flushSync();

  const claims = fetchMock.mock.calls.filter((c) => isLock(c[0]) && c[1]?.method === 'POST');
  expect(claims).toHaveLength(2);
  expect($(root, '.lock-banner')).toBeNull();
  expect($<HTMLFieldSetElement>(root, '.form > fieldset')?.disabled).toBe(false);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('Take over asks first, and reads the entry again once it is yours', async () => {
  const fetchMock = heldBy();
  vi.stubGlobal('fetch', fetchMock);
  const changed = vi.fn();
  const root = show({ onchanged: changed });
  await tick();
  flushSync();

  $<HTMLButtonElement>(root, '.lock-banner .btn-link')?.click();
  flushSync();
  expect($(root, '.dialog')?.textContent).toContain('Take over editing from Anna Berg?');
  expect(changed).not.toHaveBeenCalled();

  $<HTMLButtonElement>(root, '.dialog .btn-primary')?.click();
  await tick();
  flushSync();
  expect(fetchMock).toHaveBeenCalledWith(
    '/admin/api/locks/listings/seaview-cottage',
    expect.objectContaining({ method: 'POST', body: expect.stringContaining('"take":true') }),
  );
  expect(changed).toHaveBeenCalled();
  vi.unstubAllGlobals();
});

// The hold is stored on the draft rows, so whatever is in the form goes first — otherwise the
// entry is held back and the words that made somebody hold it are still in the browser.
test('Not ready yet stores the edit, then holds the entry', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (isLock(url)) return Response.json(HELD);
    if (String(url).startsWith('/admin/api/hold/'))
      return Response.json({ held: (JSON.parse(String(init?.body)) as { hold: boolean }).hold });
    return Response.json({ updated_at: 1755864000000, pending: true, problems: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  type(root, 'input#f-title', 'Seaview House');

  $<HTMLButtonElement>(root, '.hold-toggle')?.click();
  await tick();
  await tick();
  flushSync();

  expect(wrote(fetchMock).map((call) => call[0])).toEqual([
    '/admin/api/drafts/listings/seaview-cottage',
    '/admin/api/hold/listings/seaview-cottage',
  ]);
  expect(wrote(fetchMock)[1]?.[1]).toMatchObject({ body: JSON.stringify({ hold: true }) });
  expect($(root, '.hold-toggle')?.getAttribute('aria-pressed')).toBe('true');
  expect($(root, '.entry-header')?.classList.contains('is-held')).toBe(true);
  vi.unstubAllGlobals();
});

test('an entry with nothing unpublished has nothing to hold back', () => {
  const root = show();
  expect($<HTMLButtonElement>(root, '.hold-toggle')?.disabled).toBe(true);
});

test('an entry somebody is already holding back opens with the toggle on', () => {
  const root = show({ entry: { ...entry, pending: ['en'], held: true } });
  expect($(root, '.hold-toggle')?.getAttribute('aria-pressed')).toBe('true');
});

// The lock is the entry's, so the second language surrenders on the same refusal — otherwise a
// tab that lost the entry keeps typing German at a draft row it no longer holds.
test('a refused save in the second language loses the entry too', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', refused());
  const root = show({ entry: bilingual });

  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  type(root, 'input#t-title', 'Seeblick-Häuschen');
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();

  expect($(root, '.lock-banner.is-lost')?.textContent).toContain('Anna Berg took over this entry');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('the take-over confirm closes on Escape and hands focus back', async () => {
  vi.stubGlobal('fetch', heldBy());
  const root = show();
  await tick();
  flushSync();
  const trigger = $<HTMLButtonElement>(root, '.lock-banner .btn-link');
  trigger?.focus();
  trigger?.click();
  flushSync();

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();

  expect($(root, '.dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  vi.unstubAllGlobals();
});

// The header's status control. What one answer becomes — a rule per language — is the route's,
// and api.test.ts holds it to each of the four; what the header owes is asking before it hides
// and not asking when it shows.
const status = () =>
  vi.fn(async (url: string) =>
    isLock(url)
      ? Response.json(HELD)
      : Response.json({ updated_at: 1755864000000, pending: true, problems: [] }),
  );

test('hiding from the header asks where its readers go before it writes', async () => {
  const fetcher = status();
  vi.stubGlobal('fetch', fetcher);
  const root = show({ entry: { ...entry, route: '/listings/[slug]', index: '/listings' } });

  $<HTMLButtonElement>(root, '.status')?.click();
  flushSync();
  $$<HTMLButtonElement>(root, '.status-menu button')[1]?.click();
  flushSync();
  expect($(root, '.dialog h2')?.textContent).toBe('Where should visitors to this page go now?');
  $<HTMLButtonElement>(root, '.dialog .btn-primary')?.click();
  await tick();

  expect(wrote(fetcher).at(-1)).toEqual([
    '/admin/api/status/listings',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entries: ['seaview-cottage'],
        hidden: true,
        redirect: { kind: 'index' },
      }),
    },
  ]);
  vi.unstubAllGlobals();
});

test('a hidden entry says in the header where it sends its readers', () => {
  const root = show({
    entry: { ...entry, hidden: true, redirects: { en: '/listings' } },
  });

  expect($(root, '.status')?.textContent).toContain('Hidden');
  expect($(root, '.subline')?.textContent?.trim()).toBe('Redirecting to /listings while hidden');
});

// "Nowhere" is an answer, not a gap, and the header says what it means for a visitor.
test('a hidden entry with no rule says so rather than naming nothing', () => {
  const root = show({ entry: { ...entry, hidden: true } });

  expect($(root, '.subline')?.textContent?.trim()).toBe(
    'Off the site — visitors to its old address see “page not found”',
  );
});

// The header's overflow menu: what the list row offers, from inside the entry. Hide comes
// before Delete because it is the answer the delete dialog leads with.
const menuItems = (root: ParentNode) =>
  $$(root, '[role="menu"][aria-label="More actions"] [role="menuitem"]').map((b) =>
    b.textContent?.trim(),
  );

test('the header menu offers Rename, Hide and Delete, in that order', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show();
  await tick();
  $<HTMLButtonElement>(root, '[aria-label="More actions"]')?.click();
  flushSync();

  expect(menuItems(root)).toEqual(['Rename', 'Hide', 'Delete']);
  vi.unstubAllGlobals();
});

test('renaming from the header sends the new file name', async () => {
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await tick();
  $<HTMLButtonElement>(root, '[aria-label="More actions"]')?.click();
  flushSync();
  $$<HTMLButtonElement>(root, '[role="menuitem"]')
    .find((b) => b.textContent?.trim() === 'Rename')
    ?.click();
  flushSync();

  expect($(root, '.dialog h2')?.textContent).toBe('Rename Seaview Cottage');
  expect($<HTMLInputElement>(root, '.dialog input#rename-to')?.value).toBe('seaview-cottage');
  type(root, '.dialog input#rename-to', 'Seaview House');
  $<HTMLButtonElement>(root, '.dialog .btn-primary')?.click();
  await tick();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/entries/listings/seaview-cottage/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'Seaview House' }),
  });
  vi.unstubAllGlobals();
});

test('deleting from the header leads with Hide it instead?, and Hide instead asks the hide question', async () => {
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await tick();
  $<HTMLButtonElement>(root, '[aria-label="More actions"]')?.click();
  flushSync();
  $$<HTMLButtonElement>(root, '[role="menuitem"]')
    .find((b) => b.textContent?.trim() === 'Delete')
    ?.click();
  flushSync();

  expect($(root, '.dialog p')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Hide it instead? Hidden entries come off the site but can be brought back.',
  );
  $$<HTMLButtonElement>(root, '.dialog button')
    .find((b) => b.textContent?.trim() === 'Hide instead')
    ?.click();
  flushSync();

  expect($(root, '.dialog p')?.textContent).not.toContain('Hide it instead?');
  expect($(root, '.dialog .btn-primary')?.textContent?.trim()).toBe('Hide this listing');
  expect(wrote(fetchMock).some((call) => (call[1] as RequestInit)?.method === 'DELETE')).toBe(
    false,
  );
  vi.unstubAllGlobals();
});

test('a delete from the header sends where its readers go with the DELETE', async () => {
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await tick();
  $<HTMLButtonElement>(root, '[aria-label="More actions"]')?.click();
  flushSync();
  $$<HTMLButtonElement>(root, '[role="menuitem"]')
    .find((b) => b.textContent?.trim() === 'Delete')
    ?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.dialog .btn-danger')?.click();
  await tick();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/entries/listings/seaview-cottage', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect: { kind: 'none' } }),
  });
  vi.unstubAllGlobals();
});

test('the header menu is closed while somebody else holds the entry', async () => {
  vi.stubGlobal('fetch', heldBy());
  const root = show();
  await tick();
  flushSync();

  expect($<HTMLButtonElement>(root, '[aria-label="More actions"]')?.disabled).toBe(true);
  vi.unstubAllGlobals();
});

// The SEO panel is a tab of its own: the field is drawn there and nowhere else, so one screen
// never carries two boxes with the same id.
const withSeo = {
  ...entry,
  fields: [
    { path: ['title'], label: 'Title', type: 'text', required: true },
    { path: ['seo'], label: 'SEO', type: 'seo', required: false },
  ] satisfies Field[],
  data: { title: 'Seaview Cottage', seo: {} },
  seoDefaults: { en: { titlePattern: '%s · Coastal Homes' } },
};

test('an entry with no seo field gets no SEO tab', () => {
  const root = show();
  expect($$(root, '.tabs a, .tabs button').map((t) => t.textContent)).toEqual([
    'Content',
    'History',
  ]);
});

test('the SEO tab is an address, and its field is off the Content form', () => {
  const root = show({ entry: withSeo });
  expect($(root, '.tabs a[href="/admin/c/listings/seaview-cottage/seo"]')?.textContent).toBe('SEO');
  expect($(root, 'input#f-title')).not.toBeNull();
  expect($(root, 'input#f-seo\\.title')).toBeNull();
});

test('the SEO tab draws the panel and nothing the Content tab draws', () => {
  const root = show({ entry: withSeo, section: 'seo' });
  expect($(root, '.tabs a[aria-current="page"]')?.textContent).toBe('SEO');
  expect($(root, 'input#f-seo\\.title')).not.toBeNull();
  expect($(root, 'input#f-title')).toBeNull();
});

// The site's pattern resolved by the same function the build runs, so the greyed value a client
// types against is the tag the page will really carry.
test('the panel greys the site\u2019s own default behind an empty search title', () => {
  const root = show({ entry: withSeo, section: 'seo' });
  expect($(root, 'input#f-seo\\.title')?.getAttribute('placeholder')).toBe(
    'Seaview Cottage · Coastal Homes',
  );
});

// A count that names a field on the other tab has to take the reader there, or the jump lands
// nowhere and reads as a broken button.
test('the problem count jumps to the SEO tab for a problem the panel owns', async () => {
  const root = show({
    entry: { ...withSeo, problems: [{ path: 'seo.title', message: 'Required' }] },
  });
  expect($(root, 'input#f-seo\\.title')).toBeNull();

  $<HTMLButtonElement>(root, 'button.problems')?.click();
  await tick();
  flushSync();

  expect(location.pathname).toBe('/admin/c/listings/seaview-cottage/seo');
});
