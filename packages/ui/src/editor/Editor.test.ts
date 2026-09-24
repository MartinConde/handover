import { type Drift, type Field, LOCK_TTL } from '@handover/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Editor from './Editor.svelte';
import { SIX, sixLanguageRows, sixLanguages } from './six-languages.fixture';

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

// Two languages: `price` is shared, `notes` is English-only, the German file is the second column.
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
  localStorage.clear();
  document.body.innerHTML = '';
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

test('a global is drawn without the status chip, the overflow menu or the tab bar', () => {
  const root = show({
    collection: 'globals',
    slug: 'site',
    entry: { ...entry, singleton: true, label: 'Site details' },
  });

  expect($(root, '.status')).toBeNull();
  expect($(root, '[aria-label="More actions"]')).toBeNull();
  expect($(root, '[role="tablist"]')).toBeNull();
  expect($(root, '.hold-toggle')).not.toBeNull();
  expect($(root, '.btn-primary')?.textContent).toContain('Publish this entry');
});

test('a global keeps its title state and publishing controls in one header row', () => {
  const root = show({
    collection: 'globals',
    slug: 'site',
    entry: { ...bilingual, singleton: true, label: 'Site details' },
  });

  const row = $(root, '.entry-header > .heading-row');
  expect(row?.querySelector('h1')?.textContent).toBe('Site details');
  expect(row?.querySelector('.hold-toggle')).not.toBeNull();
  expect(root.querySelector('.workspace-toolbar .seg[aria-label="Language"]')).not.toBeNull();
  expect(row?.querySelector('.btn-primary')?.textContent).toContain('Publish this entry');
});

test('fields and block types labelled per language are named in the interface language', () => {
  const root = show({
    uiLocale: 'de',
    entry: {
      ...entry,
      fields: [
        { path: ['title'], label: 'Title', labels: { de: 'Titel' }, type: 'text', required: true },
        { path: ['body'], label: 'Body', type: 'blocks', required: false, types: ['hero'] },
      ] satisfies Field[],
      blocks: { hero: [] },
      blockLabels: { hero: { en: 'Hero', de: 'Bühne' } },
      data: { title: 'Seaview Cottage', body: [] },
    },
  });

  expect($(root, 'label[for="f-title"]')?.textContent).toBe('Titel*');
  $<HTMLButtonElement>(root, '.pop-anchor .add')?.click();
  flushSync();
  expect($$(root, '.block-picker .type-card').map((b) => b.textContent)).toEqual(['Bühne']);
});

test('a global labelled per language is named in the interface language', () => {
  const root = show({
    collection: 'globals',
    slug: 'site',
    uiLocale: 'de',
    entry: {
      ...entry,
      singleton: true,
      label: 'Site details',
      labels: { en: 'Site details', de: 'Website-Angaben' },
    },
  });

  expect($(root, 'h1')?.textContent).toBe('Website-Angaben');
});

test("a global is named by the dev's label", () => {
  const root = show({
    collection: 'globals',
    slug: 'site',
    entry: { ...entry, singleton: true, label: 'Site details' },
  });

  expect($(root, 'h1')?.textContent).toBe('Site details');
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
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
// The tab token lives in session storage, so pinning it makes the request bodies below literal.
sessionStorage.setItem('handover-tab', 'tab-1');
// Every editor takes the lock on open; any other answer shape reads as somebody else holding it.
const HELD = { held_by: null, mine: true, expires_at: 1755864120000 };
const isLock = (url: unknown) => String(url).startsWith('/admin/api/locks/');
/** The checks pass a save that left a draft asks for; it rides on the same fetch as the save. */
const isLint = (url: unknown) => url === '/admin/api/publish/checks';
/** The writes a test is about, with the lock beats and lint passes filtered out. */
const wrote = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.filter((call) => !isLock(call[0]) && !isLint(call[0]));
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

const beside = (root: ParentNode) =>
  $$<HTMLButtonElement>(root, '[aria-label="Beside the form"] button');
const pressed = (root: ParentNode) =>
  $(root, '[aria-label="Beside the form"] [aria-pressed="true"]')?.textContent;

// Canvas needs both the injected preview route and a page address to POST into.
test('the page and Canvas are offered only where the site has a page to show', () => {
  const none = show({ entry: bilingual, preview: true });
  expect(beside(none).map((b) => b.textContent)).toEqual(['Translate']);
  expect($(none, '.canvas-open')).toBeNull();
  unmount(app);
  const root = show({ entry: { ...entry, route: '/listings/[slug]' }, preview: true });
  expect(beside(root).map((b) => b.textContent)).toEqual(['Live preview']);
  expect($<HTMLButtonElement>(root, '.canvas-open')?.disabled).toBe(false);
});

test('the page beside the form is the address this language serves, with only page controls', () => {
  const root = show({
    entry: { ...entry, route: '/listings/[slug]', published: [] },
    preview: true,
  });
  flushSync();

  expect(
    $<HTMLAnchorElement>(root, '.canvas-workspace a[target="_blank"]')?.getAttribute('href'),
  ).toContain('/_preview/listings/seaview-cottage');
  expect($(root, 'input#f-title')).not.toBeNull();
  // The form beside it is the inspector, so the rail keeps only what is about the page.
  expect($(root, '.canvas-rail .canvas-address')?.textContent).toBe('/listings/seaview-cottage');
  expect($$(root, '.canvas-rail .canvas-widths button')).toHaveLength(3);
  expect($(root, '.canvas-rail .canvas-panel-toggle')).toBeNull();
  expect($(root, '.canvas-rail [aria-label="Undo"]')).toBeNull();
  expect($(root, '.canvas-rail [aria-label="Canvas interaction"]')).toBeNull();
});

test('an entry with a page opens with the page beside the form', () => {
  const root = show({ entry: { ...entry, route: '/listings/[slug]' }, preview: true });
  flushSync();

  expect(pressed(root)).toBe('Live preview');
  expect($(root, '.entry-body.has-pane > .canvas-workspace:not(.is-inactive)')).not.toBeNull();
});

test('without a preview, the default form has no mode choice or outline', () => {
  const key = 'handover:editor-view:v3:/:u1';
  const long = [1, 2, 3, 4, 5, 6].map(
    (n) => ({ path: [`f${n}`], label: `Field ${n}`, type: 'text', required: false }) as Field,
  );
  const root = show({
    entry: { ...bilingual, fields: [...entry.fields, ...long], route: '/listings/[slug]' },
    preview: false,
    userId: 'u1',
  });

  // The form is the default; Translate is the only optional pane.
  flushSync();

  expect(pressed(root)).toBeUndefined();
  expect($(root, '.entry-body.has-pane')).toBeNull();
  expect($(root, '.editor-outline')).toBeNull();
  expect(localStorage.getItem(key)).toBeNull();
});

test('the saved view is scoped to the site base and signed-in user', () => {
  document.body.innerHTML = '<div id="app" data-base="/coastal"></div>';
  const key = 'handover:editor-view:v3:/coastal:u1';
  localStorage.setItem(key, 'canvas');
  const root = show({
    entry: { ...entry, route: '/listings/[slug]' },
    preview: true,
    userId: 'u1',
  });
  flushSync();

  expect($(root, '.canvas-workspace.is-fullscreen')).not.toBeNull();
  $<HTMLButtonElement>(root, '.canvas-back')?.click();
  flushSync();
  expect($(root, '.canvas-workspace.is-fullscreen')).toBeNull();
  expect(pressed(root)).toBe('Live preview');
  expect(localStorage.getItem(key)).toBe('page');
});

test('an unsupported preference falls back without being overwritten, an invalid one to Page', () => {
  document.body.innerHTML = '<div id="app" data-base="/coastal/"></div>';
  const key = 'handover:editor-view:v3:/coastal:u1';
  localStorage.setItem(key, 'canvas');
  const root = show({
    entry: { ...bilingual, route: '/listings/[slug]' },
    preview: false,
    userId: 'u1',
  });

  expect($(root, '.canvas-workspace')).toBeNull();
  expect(pressed(root)).toBeUndefined();
  expect(localStorage.getItem(key)).toBe('canvas');

  unmount(app);
  localStorage.setItem(key, 'anything-else');
  const invalid = show({
    entry: { ...entry, route: '/listings/[slug]' },
    preview: true,
    userId: 'u1',
  });
  flushSync();
  expect(pressed(invalid)).toBe('Live preview');
  expect($(invalid, '.canvas-workspace:not(.is-inactive)')).not.toBeNull();
  expect(localStorage.getItem(key)).toBe('anything-else');
});

test('opening and leaving Canvas keeps unsaved field state in the same entry session', () => {
  const root = show({
    entry: { ...entry, route: '/listings/[slug]' },
    preview: true,
    userId: 'u1',
  });
  type(root, 'input#f-title', 'Unsaved harbour edit');

  $<HTMLButtonElement>(root, '.canvas-open')?.click();
  flushSync();
  expect($(root, '.canvas-workspace.is-fullscreen')).not.toBeNull();
  expect($(root, 'input#f-title')).toBeNull();

  $<HTMLButtonElement>(root, '.canvas-back')?.click();
  flushSync();
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Unsaved harbour edit');
});

test('Side by side takes the page’s place and Page brings it back, keeping the translation', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show({
    entry: { ...bilingual, route: '/listings/[slug]' },
    preview: true,
    userId: 'u1',
  });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  type(root, 'input#t-title', 'Ungespeicherte Hätte');
  expect($(root, '.canvas-workspace:not(.is-inactive)')).toBeNull();

  beside(root)[0]?.click();
  await vi.waitFor(() => expect($(root, '.canvas-workspace:not(.is-inactive)')).not.toBeNull());
  expect($(root, 'input#t-title')).toBeNull();

  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  await vi.waitFor(() =>
    expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Ungespeicherte Hätte'),
  );
  vi.unstubAllGlobals();
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

test('final confirmation saves source and translation edits made after the dialog opened', async () => {
  const order: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (isLock(url)) return Response.json(HELD);
    if (isLint(url)) {
      order.push('checks');
      return Response.json({ results: [] });
    }
    if (init?.method === 'PUT') {
      order.push(url);
      return Response.json({ pending: true, problems: [] });
    }
    if (url === '/admin/api/publish') {
      order.push('publish');
      return Response.json({ commit_sha: 'def4567890', paths: [] });
    }
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: { ...bilingual, pending: ['en', 'de'] } });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.entry-header button.btn-primary')?.click();
  await settled();

  type(root, 'input#f-title', 'Source after confirmation opened');
  type(root, 'input#t-title', 'Ziel nach dem Öffnen');
  $<HTMLButtonElement>(root, '.dialog .btn-primary')?.click();
  await settled();

  const finalChecks = order.lastIndexOf('checks');
  const sourceSave = order.lastIndexOf('/admin/api/drafts/listings/seaview-cottage');
  const translationSave = order.lastIndexOf('/admin/api/drafts/listings/seaview-cottage/de');
  expect(sourceSave).toBeGreaterThan(-1);
  expect(translationSave).toBeGreaterThan(sourceSave);
  expect(finalChecks).toBeGreaterThan(translationSave);
  expect(order.at(-1)).toBe('publish');
  expect(fetchMock).toHaveBeenCalledWith(
    '/admin/api/drafts/listings/seaview-cottage',
    expect.objectContaining({
      body: expect.stringContaining('Source after confirmation opened'),
    }),
  );
  expect(fetchMock).toHaveBeenCalledWith(
    '/admin/api/drafts/listings/seaview-cottage/de',
    expect.objectContaining({
      body: expect.stringContaining('Ziel nach dem Öffnen'),
    }),
  );
  vi.unstubAllGlobals();
});

test('a failed final save prevents publish and releases the editor for another attempt', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (isLock(url)) return Response.json(HELD);
    if (isLint(url)) return Response.json({ results: [] });
    if (init?.method === 'PUT') return new Response('', { status: 500 });
    if (url === '/admin/api/publish')
      return Response.json({ commit_sha: 'must-not-publish', paths: [] });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: { ...entry, pending: ['en'] } });
  $<HTMLButtonElement>(root, '.entry-header button.btn-primary')?.click();
  await settled();
  type(root, 'input#f-title', 'Unsaved final words');

  $<HTMLButtonElement>(root, '.dialog .btn-primary')?.click();
  await settled();

  expect(publishCalls(fetchMock)).toHaveLength(0);
  expect($(root, '.dialog [role="alert"]')?.textContent).toContain(
    'Your latest changes could not be saved',
  );
  expect($<HTMLFieldSetElement>(root, '.entry-body > .form > fieldset')?.disabled).toBe(false);
  type(root, 'input#f-title', 'Editing is available again');
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Editing is available again');
  vi.unstubAllGlobals();
});

test('final checks freeze every locale and a refusal releases them', async () => {
  const finalCheck = deferred<Response>();
  let checks = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (isLock(url)) return Response.json(HELD);
    if (isLint(url)) {
      checks += 1;
      return checks < 3 ? Response.json({ results: [] }) : finalCheck.promise;
    }
    if (url === '/admin/api/publish')
      return Response.json({ commit_sha: 'must-not-publish', paths: [] });
    return Response.json({ pending: true, problems: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: { ...bilingual, pending: ['en', 'de'] } });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.entry-header button.btn-primary')?.click();
  await settled();
  $<HTMLButtonElement>(root, '.dialog .btn-primary')?.click();
  await tick();
  flushSync();

  expect($<HTMLFieldSetElement>(root, '.entry-body > .form > fieldset')?.disabled).toBe(true);
  expect($<HTMLFieldSetElement>(root, '.pane.is-locale fieldset')?.disabled).toBe(true);
  expect($<HTMLButtonElement>(root, '.dialog .actions .btn')?.disabled).toBe(true);

  finalCheck.resolve(Response.json({ results: [BROKEN] }));
  await settled();

  expect(publishCalls(fetchMock)).toHaveLength(0);
  expect($<HTMLFieldSetElement>(root, '.entry-body > .form > fieldset')?.disabled).toBe(false);
  expect($<HTMLFieldSetElement>(root, '.pane.is-locale fieldset')?.disabled).toBe(false);
  expect($<HTMLButtonElement>(root, '.dialog .actions .btn')?.disabled).toBe(false);
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

// The hold goes with the draft, so it never blocks the entry's own publish.
test('an entry on hold can still be published from its own header', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show({ entry: { ...entry, pending: ['en'], held: true } });
  const button = $<HTMLButtonElement>(root, 'button.btn-primary');
  expect(button?.disabled).toBe(false);
  expect($(root, '.hold-toggle')?.getAttribute('aria-checked')).toBe('false');
  button?.click();
  await tick();
  flushSync();
  expect($(root, '.dialog h2')?.textContent).toBe('Publish Seaview Cottage?');
  vi.unstubAllGlobals();
});

// Language files are written together, so the confirm names every one of them.
test('Publish this entry names the language files it is about to commit', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show({ entry: { ...bilingual, pending: ['en', 'de'] } });
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();

  expect($(root, '.dialog h2')?.textContent).toBe('Publish Seaview Cottage?');
  expect($(root, '.dialog .publish-set')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Languages: ENDE All 2 language files',
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

test('an uncertain entry publish reloads before offering another attempt', async () => {
  const reloaded = vi.fn();
  const fetchMock = vi.fn(async (url: string) => {
    if (isLock(url)) return Response.json(HELD);
    if (isLint(url)) return Response.json({ results: [] });
    if (url === '/admin/api/publish')
      return new Response('Connection lost', {
        status: 503,
        headers: {
          'x-handover-request-uncertain': 'true',
          'x-handover-error-code': 'CONNECTION_LOST',
        },
      });
    return Response.json({ updated_at: 1755864000000, pending: true, problems: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show({
    entry: { ...entry, pending: ['en'] },
    onreload: reloaded,
  });
  $<HTMLButtonElement>(root, '.entry-header button.btn-primary')?.click();
  await settled();
  $<HTMLButtonElement>(root, '.dialog .btn-primary')?.click();
  await settled();

  expect(reloaded).toHaveBeenCalledOnce();
  expect($(root, '.dialog [role="alert"]')?.textContent).toContain(
    'The publish response was lost, so this entry is being reloaded before you continue.',
  );
  vi.unstubAllGlobals();
});

// The pass runs again on the press, so a picture deleted since the dialog opened is still caught.
const BROKEN = {
  check: 'media-missing',
  entry: 'listings/seaview-cottage',
  path: 'src/content/listings/en/seaview-cottage.yaml',
  fieldPath: 'photo.src',
  severity: 'error',
  message: 'Photo has nothing behind it any more — the page would show a broken image',
};
/** Each checks pass answers the next of `passes`; the publish answers a commit. */
const checking = (passes: (unknown[] | number)[]) =>
  vi.fn(async (url: string) => {
    if (isLock(url)) return Response.json(HELD);
    if (url === '/admin/api/publish/checks') {
      const pass = passes.length > 1 ? passes.shift() : passes[0];
      return typeof pass === 'number'
        ? new Response('', { status: pass })
        : Response.json({ results: pass });
    }
    if (url === '/admin/api/publish') return Response.json({ commit_sha: 'def4567890', paths: [] });
    return Response.json({ updated_at: 1755864000000, pending: true, problems: [] });
  });
const settled = async () => {
  await tick();
  await tick();
  flushSync();
};
const publishCalls = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.filter((call) => call[0] === '/admin/api/publish');

test('Publish this entry lists what the checks found and an error disables the button', async () => {
  const fetchMock = checking([[BROKEN]]);
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: { ...entry, pending: ['en'] } });
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await settled();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/publish/checks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: ['listings/seaview-cottage'] }),
  });
  expect($(root, '.dialog .checks .notice-danger .msg')?.textContent).toBe(BROKEN.message);
  expect($(root, '.dialog .checks-sum')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    '1 error. The error has to go first.',
  );
  const button = $<HTMLButtonElement>(root, '.dialog .actions .btn-primary');
  expect(button?.disabled).toBe(true);
  expect(button?.textContent?.trim()).toBe('Fix 1 error to publish');
  vi.unstubAllGlobals();
});

test('an error found on the press refuses with the drawer’s sentence and commits nothing', async () => {
  // Three passes: the entry opening, the dialog opening, the press.
  const fetchMock = checking([[], [], [BROKEN]]);
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: { ...entry, pending: ['en'] } });
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await settled();
  $<HTMLButtonElement>(root, '.dialog .actions .btn-primary')?.click();
  await settled();

  expect($(root, '.dialog [role="alert"]')?.textContent).toBe(
    'Nothing was published. The checks found something in the way just now — it is listed above.',
  );
  expect(publishCalls(fetchMock)).toHaveLength(0);
  expect($(root, '.dialog .actions .btn-primary')?.textContent?.trim()).toBe(
    'Fix 1 error to publish',
  );
  vi.unstubAllGlobals();
});

test('warnings read Publish anyway and never stop the entry going out', async () => {
  const fetchMock = checking([[{ ...BROKEN, check: 'image-alt', severity: 'warn' }]]);
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: { ...entry, pending: ['en'] } });
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await settled();

  const button = $<HTMLButtonElement>(root, '.dialog .actions .btn-primary');
  expect(button?.disabled).toBe(false);
  expect(button?.textContent?.trim()).toBe('Publish anyway (1 warning)');
  button?.click();
  await settled();
  expect(publishCalls(fetchMock)).toHaveLength(1);
  vi.unstubAllGlobals();
});

test('a pass that could not be run says so and holds nothing back', async () => {
  const fetchMock = checking([500]);
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: { ...entry, pending: ['en'] } });
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await settled();

  expect(
    $(root, '.dialog .checks-sum[role="status"]')?.textContent?.replace(/\s+/g, ' ').trim(),
  ).toBe('The checks could not be run this time, so nothing here has been looked at.');
  const button = $<HTMLButtonElement>(root, '.dialog .actions .btn-primary');
  expect(button?.disabled).toBe(false);
  expect(button?.textContent?.trim()).toBe('Publish this entry');
  button?.click();
  await settled();
  expect(publishCalls(fetchMock)).toHaveLength(1);
  vi.unstubAllGlobals();
});

// A check error blocks a publish like a schema problem, so it is counted before the dialog is up.
const pictured = {
  ...entry,
  fields: [
    ...entry.fields,
    { path: ['photo'], label: 'Photo', type: 'image', required: false, preset: { max: 2400 } },
  ] satisfies Field[],
  data: { ...entry.data, photo: { src: 'media/9f3a2c7e.webp', width: 2400, height: 1600 } },
  pending: ['en'],
};

test('a check error is counted as a problem and marks the widget its field is drawn in', async () => {
  vi.stubGlobal('fetch', checking([[BROKEN]]));
  const root = show({ entry: pictured });
  await settled();

  expect($(root, '.problems')?.textContent).toBe('1 problem');
  expect($(root, '#f-photo')?.closest('.field')?.classList.contains('is-invalid')).toBe(true);
  expect($(root, '#f-photo-err')?.textContent).toBe(BROKEN.message);
  // `photo.src` has no control of its own, so the jump lands on the picture's card.
  $<HTMLButtonElement>(root, '.problems')?.click();
  flushSync();
  expect(document.activeElement?.id).toBe('f-photo');
  vi.unstubAllGlobals();
});

test('the checks run again after a save and the count follows what they find', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', checking([[BROKEN], []]));
  const root = show({ entry: pictured });
  // Svelte's own tick never settles under fake timers; an empty advance drains the same queue.
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect($(root, '.problems')?.textContent).toBe('1 problem');

  type(root, 'input#f-title', 'Seaview');
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();
  expect($(root, '.problems')).toBeNull();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('an entry with nothing pending asks the checks nothing when it opens', async () => {
  const fetchMock = checking([[BROKEN]]);
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: { ...pictured, pending: [] } });
  await settled();

  expect(fetchMock.mock.calls.some((call) => call[0] === '/admin/api/publish/checks')).toBe(false);
  expect($(root, '.problems')).toBeNull();
  vi.unstubAllGlobals();
});

// English is published and German is a new, untouched draft: both wait to publish.
const withGerman = { ...bilingual, pending: ['en', 'de'], published: ['en'] };
const KEY = 'listings/seaview-cottage';
const GERMAN_ERROR = {
  ...BROKEN,
  path: 'src/content/listings/de/seaview-cottage.yaml',
  fieldPath: 'title',
};
const ENGLISH_READY = { revision: 'r-en', problems: [], excludable: false, reason: 'published' };
const GERMAN_UNFINISHED = {
  revision: 'r-de',
  problems: [{ path: 'title', message: 'Required' }],
  excludable: true,
};
const readiness = (results: unknown[] = [], de: unknown = GERMAN_UNFINISHED) => ({
  results,
  readiness: { [KEY]: { en: ENGLISH_READY, de } },
});
type Pass = object | number | Promise<object>;
/** Each checks pass answers the next of `passes`, the last one repeating. */
const answering = (
  passes: Pass[],
  published: () => Response = () => Response.json({ commit_sha: 'def4567890', paths: [] }),
) =>
  vi.fn(async (url: string) => {
    if (isLock(url)) return Response.json(HELD);
    if (url === '/admin/api/publish/checks') {
      const pass = await (passes.length > 1 ? passes.shift() : passes[0]);
      return typeof pass === 'number' ? new Response('', { status: pass }) : Response.json(pass);
    }
    if (url === '/admin/api/publish') return published();
    return Response.json({ updated_at: 1755864000000, pending: true, problems: [] });
  });
const checksBodies = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls
    .filter((call) => call[0] === '/admin/api/publish/checks')
    .map((call) => JSON.parse(String((call[1] as RequestInit).body)));
const headerPublish = (root: ParentNode) =>
  $<HTMLButtonElement>(root, '.entry-header .actions .btn-primary');
const later = (root: ParentNode) => $<HTMLInputElement>(root, '.dialog input[type="checkbox"]');

test('a check error only in a translation leaves the header Publish enabled', async () => {
  vi.stubGlobal(
    'fetch',
    answering([readiness([GERMAN_ERROR], { ...GERMAN_UNFINISHED, problems: [] })]),
  );
  const root = show({ entry: withGerman });
  await settled();

  expect($(root, '.problems')).toBeNull();
  expect(headerPublish(root)?.disabled).toBe(false);
  vi.unstubAllGlobals();
});

test('a source error disables the header Publish and offers nothing to leave out', async () => {
  vi.stubGlobal('fetch', answering([readiness([{ ...BROKEN, fieldPath: 'title' }])]));
  const root = show({ entry: withGerman });
  await settled();

  expect($(root, '.problems')?.textContent).toBe('1 problem');
  expect(headerPublish(root)?.disabled).toBe(true);
  headerPublish(root)?.click();
  await settled();
  expect(later(root)).toBeNull();
  vi.unstubAllGlobals();
});

test('an untouched German can be left out while English publishes', async () => {
  const fetchMock = answering([readiness()]);
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: withGerman });
  headerPublish(root)?.click();
  await settled();

  const button = $<HTMLButtonElement>(root, '.dialog .actions .btn-primary');
  expect(button?.disabled).toBe(true);
  expect(button?.textContent?.trim()).toBe('Finish or leave out 1 language to publish');
  expect($(root, '.dialog .publish-later label')?.textContent?.trim()).toBe('Publish German later');
  later(root)?.click();
  await settled();

  expect(checksBodies(fetchMock).at(-1)).toEqual({ entries: [KEY], without: [`${KEY}:de`] });
  expect($$(root, '.dialog .publish-set li:first-child .chip').map((c) => c.textContent)).toEqual([
    'EN',
  ]);
  expect(button?.disabled).toBe(false);
  expect(button?.textContent?.trim()).toBe('Publish this entry');
  button?.click();
  await settled();
  expect(
    JSON.parse(String((publishCalls(fetchMock)[0]?.[1] as RequestInit | undefined)?.body)),
  ).toEqual({
    entries: [KEY],
    without: [`${KEY}:de`],
  });
  vi.unstubAllGlobals();
});

test('a leave-out the server refuses is explained from its code', async () => {
  const fetchMock = answering([readiness()], () =>
    Response.json(
      { code: 'PUBLISH_EXCLUDE_PUBLISHED', error: 'already published', paths: [] },
      { status: 422, headers: { 'x-handover-error-code': 'PUBLISH_EXCLUDE_PUBLISHED' } },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: withGerman });
  headerPublish(root)?.click();
  await settled();
  later(root)?.click();
  await settled();
  $<HTMLButtonElement>(root, '.dialog .actions .btn-primary')?.click();
  await settled();

  expect($(root, '.dialog [role="alert"]')?.textContent).toBe(
    'Nothing was published. A language you chose to publish later is already published, so it goes out with the entry.',
  );
  vi.unstubAllGlobals();
});

// Leaving the only language with changes out would publish nothing; the server refuses that.
test('a new language that is the only one going is not offered to wait', async () => {
  vi.stubGlobal(
    'fetch',
    answering([{ results: [], readiness: { [KEY]: { de: GERMAN_UNFINISHED } } }]),
  );
  const root = show({ entry: { ...withGerman, pending: ['de'] } });
  headerPublish(root)?.click();
  await settled();

  expect(later(root)).toBeNull();
  expect($(root, '.dialog .publish-later .hint')?.textContent).toBe(
    'Nothing else in this entry is waiting to publish, so it cannot wait. Finish it first.',
  );
  const button = $<HTMLButtonElement>(root, '.dialog .actions .btn-primary');
  expect(button?.disabled).toBe(true);
  expect(button?.textContent?.trim()).toBe('Finish 1 language to publish');
  vi.unstubAllGlobals();
});

test('a refused leave-out drops the choice instead of asking again and again', async () => {
  const fetchMock = answering([
    readiness(),
    readiness(),
    400,
    readiness(),
    new Promise<never>(() => {}),
  ]);
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: withGerman });
  headerPublish(root)?.click();
  await settled();
  later(root)?.click();
  await settled();
  await settled();

  expect(checksBodies(fetchMock)).toHaveLength(4);
  expect(later(root)?.checked).toBe(false);
  vi.unstubAllGlobals();
});

test('readiness that could not be read offers a retry and nothing to leave out', async () => {
  const fetchMock = answering([500, 500, readiness()]);
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: withGerman });
  headerPublish(root)?.click();
  await settled();

  expect(later(root)).toBeNull();
  expect($<HTMLButtonElement>(root, '.dialog .actions .btn-primary')?.disabled).toBe(false);
  const retry = $<HTMLButtonElement>(root, '.dialog .checks button');
  expect(retry?.textContent).toBe('Run the checks again');
  retry?.click();
  await settled();
  expect(later(root)).not.toBeNull();
  vi.unstubAllGlobals();
});

test('a changed selection discards the older check answer', async () => {
  const late = deferred<ReturnType<typeof readiness>>();
  // Nothing may be asked after the newer answer; if something is, it never answers.
  const fetchMock = answering([
    readiness(),
    readiness(),
    late.promise,
    readiness(),
    new Promise<never>(() => {}),
  ]);
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: withGerman });
  headerPublish(root)?.click();
  await settled();
  later(root)?.click();
  await settled();
  later(root)?.click();
  await settled();
  late.resolve(readiness([{ ...BROKEN, fieldPath: 'title' }]));
  await settled();

  expect($(root, '.dialog .checks .notice-danger')).toBeNull();
  expect(later(root)?.checked).toBe(false);
  vi.unstubAllGlobals();
});

test('a save discards the older check answer', async () => {
  const late = deferred<ReturnType<typeof readiness>>();
  vi.stubGlobal('fetch', answering([late.promise, readiness()]));
  const root = show({ entry: pictured });
  type(root, 'input#f-title', 'Seaview');
  // Publish flushes the typing first, and that save asks the checks again.
  headerPublish(root)?.click();
  await settled();
  late.resolve(readiness([BROKEN]));
  await settled();

  expect($(root, '.problems')).toBeNull();
  expect($(root, '.dialog .checks .notice-danger')).toBeNull();
  vi.unstubAllGlobals();
});

// Detection only: field-by-field resolution is the three-way view, not built yet.
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

// A field renamed in schemas.ts before its migration would otherwise lose its value on first save.
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

// The drawer counts entries, not keystrokes, so the shell hears only when pending flips.
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

// The restore is over before the form draws, so the banner is the only trace of it.
test('a restored version is announced until it is published', () => {
  const root = show({
    restored: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    entry: { ...entry, pending: ['en'] },
  });

  expect($(root, '.lock-banner')?.textContent).toContain('Restored the version from 3 days ago.');
  expect($(root, '.lock-banner')?.textContent).toContain('nothing is live until you publish');
});

test('a restored version already published is not announced', () => {
  const root = show({ restored: new Date().toISOString() });

  expect($(root, '.lock-banner')).toBeNull();
});

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

// The lock belongs to the tab, so the same person's second tab is refused too.
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

// A holder who stopped typing is a minute from losing the lock; one mid-sentence is not.
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

// Regression: a required field with no widget yet used to say only "Not saved".
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

test('applying drift answers reloads the entry instead of reopening an old locale snapshot', async () => {
  const changed = vi.fn(async () => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/admin/api/drift/')
        ? Response.json({})
        : Response.json({ held_by: null, mine: true, expires_at: null }),
    ),
  );
  const root = show({
    onchanged: changed,
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

  $<HTMLInputElement>(root, '.drift .choice input')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.drift .actions .btn-primary')?.click();
  await tick();

  expect(changed).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

// The file wins over `_locales`, and the disagreement is said above the form.
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
const languagePick = (root: ParentNode) => $<HTMLButtonElement>(root, '.language-pick > button');
const languageChoices = (root: ParentNode) =>
  $$<HTMLButtonElement>(root, '#entry-languages button');
const openLanguages = (root: ParentNode) => {
  languagePick(root)?.click();
  flushSync();
};

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

const paneLanguagePick = (root: ParentNode) =>
  $<HTMLButtonElement>(root, '.pane-head .language-pick > h2 > button');
const paneChoices = (root: ParentNode) => $$<HTMLButtonElement>(root, '#pane-languages button');
const sideBySide = (root: ParentNode) => {
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
};
const choosePaneLanguage = async (root: ParentNode, index: number) => {
  paneLanguagePick(root)?.click();
  flushSync();
  paneChoices(root)[index]?.click();
  await tick();
  flushSync();
};

test('side by side lists the languages other than the source in the pane head, with their state', () => {
  const root = show(sixLanguages('base'));
  sideBySide(root);
  paneLanguagePick(root)?.click();
  flushSync();

  expect(paneLanguagePick(root)?.textContent?.trim()).toBe('Language beside English: German');
  expect(paneChoices(root).map((b) => b.textContent?.trim())).toEqual([
    'German',
    'French— English changed since this was translated',
    'Italian— partly written, 0 of 2 texts',
    'Spanish— not translated yet',
    'Dutch— turned off for this entry',
  ]);
  expect(paneChoices(root).map((b) => b.getAttribute('aria-pressed'))).toEqual([
    'true',
    'false',
    'false',
    'false',
    'false',
  ]);
});

test('choosing French in the pane swaps only the second column', async () => {
  const root = show(sixLanguages('base'));
  sideBySide(root);

  await choosePaneLanguage(root, 1);

  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Maison du port');
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Harbour House');
  expect($(root, '.editor-form-heading h2')?.textContent).toBe('English');
  expect($(root, '#pane-languages')).toBeNull();
  expect(document.activeElement).toBe(paneLanguagePick(root));
  // The pane's language is the entry's chosen language, so the header follows it.
  expect(languagePick(root)?.textContent).toContain('French');
});

const answered = (root: ParentNode) => $(root, '.pane-head .answered')?.textContent;

// The base source owes two texts: its title and the hero heading. Price and notes are not the pane's.
test('the pane head says how much of the source text the language beside it answers', async () => {
  const root = show(sixLanguages('base'));
  sideBySide(root);
  expect(answered(root)).toBe('2 of 2 texts written');

  await choosePaneLanguage(root, 2);

  expect(answered(root)).toBe('0 of 2 texts written');
});

test('typing in either column recounts at once, without a save or a fresh pane', async () => {
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show(sixLanguages('base'));
  sideBySide(root);
  await choosePaneLanguage(root, 2);
  const input = $<HTMLInputElement>(root, 'input#t-title');
  const reads = fetchMock.mock.calls.length;

  type(root, 'input#t-title', 'Casa sul porto');
  expect(answered(root)).toBe('1 of 2 texts written');
  type(root, 'input#f-subtitle', 'Sleeps six, dogs welcome');

  expect(answered(root)).toBe('1 of 3 texts written');
  expect(languagePick(root)?.textContent?.trim()).toBe(
    'Language: Italian— partly written, 1 of 3 texts',
  );
  expect($(root, 'input#t-title')).toBe(input);
  expect(fetchMock.mock.calls.length).toBe(reads);
  vi.unstubAllGlobals();
});

test('a stale translation that is also partly written is marked stale, and still counted', async () => {
  const root = show(sixLanguages('staleAndPartial'));
  sideBySide(root);
  paneLanguagePick(root)?.click();
  flushSync();

  expect(paneChoices(root)[1]?.textContent?.trim()).toBe(
    'French— English changed since this was translated',
  );
  paneChoices(root)[1]?.click();
  await tick();
  flushSync();

  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Maison du port');
  expect(answered(root)).toBe('1 of 2 texts written');
});

test('a file with no source text to answer says so, and a language with no file stays missing', async () => {
  const opened = sixLanguages('base');
  opened.entry.data = {
    ...opened.entry.data,
    title: ' ',
    body: [{ _type: 'hero', _id: 'hero0001' }],
  };
  const root = show(opened);
  sideBySide(root);
  await choosePaneLanguage(root, 2);
  paneLanguagePick(root)?.click();
  flushSync();

  expect(answered(root)).toBe('No source text to translate');
  expect(paneChoices(root).map((b) => b.textContent?.trim())).toEqual([
    'German',
    'French— English changed since this was translated',
    'Italian',
    'Spanish— not translated yet',
    'Dutch— turned off for this entry',
  ]);
});

test("Canvas's language select names a partly written file as well", () => {
  const opened = sixLanguages('base');
  const root = show({ entry: { ...opened.entry, route: '/listings/[slug]' }, preview: true });
  $<HTMLButtonElement>(root, '.canvas-open')?.click();
  flushSync();

  expect(
    $$<HTMLOptionElement>(root, 'select.canvas-locale option').map((o) => o.textContent),
  ).toEqual(['EN', 'DE', 'FR · Changed', 'IT · Partly written', 'ES · New', 'NL · Off']);
});

test('with four languages the buttons carry the partial mark too', () => {
  const opened = sixLanguages('base');
  opened.entry.locales = ['en', 'de', 'fr', 'it'];
  opened.entry.offered = ['en', 'de', 'fr', 'it'];
  const root = show(opened);

  expect($$(root, '.seg[aria-label="Language"] button').map((b) => b.textContent?.trim())).toEqual([
    'EN',
    'DE',
    'FR— English changed since this was translated',
    'IT— partly written, 0 of 2 texts',
  ]);
});

test('with one other language the pane head stays a plain heading', () => {
  const root = show({ entry: bilingual });
  sideBySide(root);

  expect($(root, '.pane-head .language-pick')).toBeNull();
  expect($(root, '.pane-head h2')?.textContent).toBe('German');
});

test('German typed in the pane is saved before French replaces it, and is there on return', async () => {
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  const root = show(sixLanguages('base'));
  sideBySide(root);
  type(root, 'input#t-title', 'Hafenhaus');

  await choosePaneLanguage(root, 1);
  // French is stale, so its pane also reads what changed in English; only the saves matter here.
  const saves = wrote(fetchMock).filter((call) => (call[1] as RequestInit)?.method === 'PUT');
  expect(saves.map((call) => call[0])).toEqual(['/admin/api/drafts/listings/seaview-cottage/de']);
  expect(JSON.parse(String((saves[0]?.[1] as RequestInit | undefined)?.body)).data.title).toBe(
    'Hafenhaus',
  );
  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Maison du port');

  await choosePaneLanguage(root, 0);
  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Hafenhaus');
  expect($(root, '.pane-head .autosave')?.textContent?.trim()).toBe('Saved');
  vi.unstubAllGlobals();
});

test('a pane language chosen while German cannot be saved is not switched to', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (isLock(url)) return Response.json(HELD);
      throw new TypeError('offline');
    }),
  );
  const root = show(sixLanguages('base'));
  sideBySide(root);
  type(root, 'input#t-title', 'Hafenhaus');

  await choosePaneLanguage(root, 1);

  expect(paneLanguagePick(root)?.textContent).toContain('German');
  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Hafenhaus');
  vi.unstubAllGlobals();
});

test('the pane goes to a missing or turned-off language and back from its empty pane', async () => {
  const root = show(sixLanguages('base'));
  sideBySide(root);

  await choosePaneLanguage(root, 3);
  expect(paneLanguagePick(root)?.textContent).toContain('Spanish');
  expect($(root, '.pane-head')?.parentElement?.querySelector('.btn-create')).not.toBeNull();

  await choosePaneLanguage(root, 4);
  expect(paneLanguagePick(root)?.textContent).toContain('Dutch');
  expect($(root, '.empty')?.textContent).toContain('This entry is not offered in Dutch.');

  await choosePaneLanguage(root, 0);
  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Haus am Hafen');
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Harbour House');
});

test('Escape closes the pane list and gives focus back to the pane button', async () => {
  const root = show(sixLanguages('base'));
  sideBySide(root);
  paneLanguagePick(root)?.click();
  flushSync();
  paneChoices(root)[2]?.focus();

  paneChoices(root)[2]?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await tick();

  expect($(root, '#pane-languages')).toBeNull();
  expect(document.activeElement).toBe(paneLanguagePick(root));
});

test('a click outside the pane list closes it without choosing', () => {
  const root = show(sixLanguages('base'));
  sideBySide(root);
  paneLanguagePick(root)?.click();
  flushSync();

  $<HTMLElement>(root, 'input#f-title')?.click();
  flushSync();

  expect($(root, '#pane-languages')).toBeNull();
  expect(paneLanguagePick(root)?.textContent).toContain('German');
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

// An address is validated, unique and owes a redirect when it moves, so it is not a form field.
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

test('the inline address editor focuses its value and Escape returns focus to the slug', async () => {
  const body = show({ entry: addressed });
  const trigger = body.querySelector<HTMLButtonElement>('.slug-edit');

  trigger?.click();
  await tick();

  const input = body.querySelector<HTMLInputElement>('#entry-address');
  expect(input).not.toBeNull();
  expect(input?.classList.contains('input')).toBe(false);
  expect(document.activeElement).toBe(input);
  expect(body.querySelector('.slug-actions')).not.toBeNull();

  input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();

  expect(body.querySelector('#entry-address')).toBeNull();
  expect(document.activeElement).toBe(body.querySelector('.slug-edit'));
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

// The losing tab finds out from the refused save it makes next.
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

// Somebody who opened the entry while this tab's lock had lapsed is named on the next edit.
test('a lapsed lock somebody else took is named on the next edit and nothing is saved', async () => {
  vi.useFakeTimers();
  let claimed = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!isLock(url)) return Response.json({ pending: true, problems: [] });
    if (init?.method !== 'POST')
      return Response.json({ held_by: null, mine: false, expires_at: null });
    if (claimed)
      return Response.json({
        held_by: { id: 'u1', name: 'Anna Berg' },
        mine: false,
        expires_at: Date.now() + LOCK_TTL,
      });
    claimed = true;
    return Response.json({ held_by: null, mine: true, expires_at: Date.now() + LOCK_TTL });
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  await vi.advanceTimersByTimeAsync(LOCK_TTL + 16_000);

  type(root, 'input#f-title', 'Seaview House');
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();

  expect($(root, '.lock-banner.is-lost')?.textContent).toContain('Anna Berg took over this entry');
  expect(wrote(fetchMock)).toHaveLength(0);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('lock loss before the debounce cancels the pending save', async () => {
  vi.useFakeTimers();
  let taken = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!isLock(url))
      return Response.json({ pending: true, problems: [], revisions: { en: 'next' } });
    if (init?.method === 'POST' || !taken) return Response.json(HELD);
    return Response.json({
      held_by: { id: 'u2', name: 'Anna Berg' },
      mine: false,
      expires_at: Date.now() + LOCK_TTL,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: { ...entry, revisions: { en: 'legacy' } } });
  await vi.advanceTimersByTimeAsync(0);
  type(root, 'input#f-title', 'Keep this locally');
  taken = true;
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(3000);
  flushSync();

  expect(wrote(fetchMock)).toHaveLength(0);
  expect($(root, '.lock-banner.is-lost')).not.toBeNull();
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Keep this locally');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('lock loss stops a queued locale save from dispatching', async () => {
  vi.useFakeTimers();
  const source = deferred<Response>();
  let taken = false;
  const drafts: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (isLock(url)) {
      if (init?.method === 'POST' || !taken) return Response.json(HELD);
      return Response.json({
        held_by: { id: 'u2', name: 'Anna Berg' },
        mine: false,
        expires_at: Date.now() + LOCK_TTL,
      });
    }
    if (isLint(url)) return Response.json({ results: [] });
    drafts.push(String(url));
    return drafts.length === 1
      ? source.promise
      : Response.json({ pending: true, problems: [], revision: 'de-next' });
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show({
    entry: { ...bilingual, revisions: { en: 'legacy', de: 'de-opened' } },
  });
  await vi.advanceTimersByTimeAsync(0);
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  type(root, 'input#f-title', 'Source edit');
  type(root, 'input#t-title', 'German edit');
  await vi.advanceTimersByTimeAsync(2000);
  expect(drafts).toEqual(['/admin/api/drafts/listings/seaview-cottage']);

  taken = true;
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  source.resolve(
    Response.json({
      pending: true,
      problems: [],
      revisions: { en: 'en-next', de: 'de-synced' },
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  flushSync();

  expect(drafts).toEqual(['/admin/api/drafts/listings/seaview-cottage']);
  expect($(root, '.lock-banner.is-lost')).not.toBeNull();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('lock loss during a request acknowledges its sent version without draining a later edit', async () => {
  vi.useFakeTimers();
  const response = deferred<Response>();
  let taken = false;
  const bodies: { data: { title: string }; revision: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (isLock(url)) {
      if (init?.method === 'POST' || !taken) return Response.json(HELD);
      return Response.json({
        held_by: { id: 'u2', name: 'Anna Berg' },
        mine: false,
        expires_at: Date.now() + LOCK_TTL,
      });
    }
    if (isLint(url)) return Response.json({ results: [] });
    bodies.push(JSON.parse(String(init?.body)));
    return response.promise;
  });
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ entry: { ...entry, revisions: { en: 'legacy' } } });
  await vi.advanceTimersByTimeAsync(0);
  type(root, 'input#f-title', 'Sent version');
  await vi.advanceTimersByTimeAsync(2000);
  type(root, 'input#f-title', 'Still local');
  taken = true;
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  response.resolve(Response.json({ pending: true, problems: [], revisions: { en: 'after-sent' } }));
  await vi.advanceTimersByTimeAsync(3000);
  flushSync();

  expect(bodies.map((body) => [body.data.title, body.revision])).toEqual([
    ['Sent version', 'legacy'],
  ]);
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Still local');
  expect($(root, '.lock-banner.is-lost')).not.toBeNull();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// The holder polls on its own and on refocus, rather than learning of a take-over only on save.
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

// Stopping to read is not losing the entry: an idle lock lapses quietly and typing takes it back.
test('a lapsed idle lock stays released without a banner until the next save claims it', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    !isLock(url)
      ? Response.json({ pending: true, problems: [] })
      : init?.method === 'POST'
        ? Response.json({ held_by: null, mine: true, expires_at: Date.now() + LOCK_TTL })
        : Response.json({ held_by: null, mine: false, expires_at: null }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  const claims = () =>
    fetchMock.mock.calls.filter((c) => isLock(c[0]) && c[1]?.method === 'POST').length;
  await vi.advanceTimersByTimeAsync(LOCK_TTL + 16_000);
  flushSync();

  expect(claims()).toBe(1);
  expect($(root, '.lock-banner')).toBeNull();
  expect($<HTMLFieldSetElement>(root, '.form > fieldset')?.disabled).toBe(false);

  type(root, 'input#f-title', 'Seaview House');
  await vi.advanceTimersByTimeAsync(2000);
  flushSync();

  expect(wrote(fetchMock)).toHaveLength(1);
  expect(claims()).toBe(2);
  expect($(root, '.lock-banner')).toBeNull();
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

// The hold is stored on the draft rows, so the form's words have to be saved first.
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
  expect($(root, '.hold-toggle')?.getAttribute('aria-checked')).toBe('false');
  expect($(root, '.entry-header')?.classList.contains('is-held')).toBe(true);
  vi.unstubAllGlobals();
});

test('an entry with nothing unpublished has nothing to hold back', () => {
  const root = show();
  expect($<HTMLButtonElement>(root, '.hold-toggle')?.disabled).toBe(true);
});

test('an entry somebody is already holding back opens with the toggle on', () => {
  const root = show({ entry: { ...entry, pending: ['en'], held: true } });
  expect($(root, '.hold-toggle')?.getAttribute('aria-checked')).toBe('false');
});

// The lock is the entry's, so a refusal in the second language surrenders the whole tab.
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

// The per-language rule is the route's (api.test.ts); the header only owes asking before it hides.
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

// Hide comes before Delete because it is the answer the delete dialog leads with.
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
  const committed = vi.fn();
  const fetchMock = vi.fn(async (url: string) =>
    isLock(url)
      ? Response.json(HELD)
      : url === '/admin/api/entries/listings/seaview-cottage/rename'
        ? Response.json({ slug: 'seaview-house', commit_sha: 'rename123' })
        : Response.json({ updated_at: 1755864000000, pending: true, problems: [] }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ oncommitted: committed });
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
  expect(committed).toHaveBeenCalledOnce();
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
  const committed = vi.fn();
  const fetchMock = vi.fn(async (url: string) =>
    isLock(url)
      ? Response.json(HELD)
      : url === '/admin/api/entries/listings/seaview-cottage'
        ? Response.json({ commit_sha: 'delete123' })
        : Response.json({ updated_at: 1755864000000, pending: true, problems: [] }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show({ oncommitted: committed });
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
  expect(committed).toHaveBeenCalledOnce();
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
  unmount(app);
  document.body.innerHTML = '';

  const single = show({ entry: { ...bilingual, translations: {} } });
  await openMenu(single);
  expect(changeSourceItem(single)).toBeUndefined();
  unmount(app);
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
  unmount(app);
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

// The SEO field is drawn on its own tab only, so no screen carries two boxes with one id.
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

// The pattern is resolved by the build's own function, so the greyed value is the real tag.
test('the panel greys the site\u2019s own default behind an empty search title', () => {
  const root = show({ entry: withSeo, section: 'seo' });
  expect($(root, 'input#f-seo\\.title')?.getAttribute('placeholder')).toBe(
    'Seaview Cottage · Coastal Homes',
  );
});

// A count naming a field on the other tab has to take the reader there.
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

// The German column shows the German address, not the English one with a flag on it.
test('the SEO previews carry the address each language serves this entry at', async () => {
  const root = show({
    entry: {
      ...withSeo,
      locales: ['en', 'de'],
      offered: ['en', 'de'],
      translations: { de: { title: 'Seeblick-Häuschen', seo: {} } },
      seoDefaults: {
        en: { titlePattern: '%s · Coastal Homes' },
        de: { titlePattern: '%s · Coastal Homes' },
      },
      localizedSlugs: true,
      addresses: { en: '', de: 'seeblick-haeuschen' },
      route: '/listings/[slug]',
    },
    section: 'seo',
    site: 'https://coastalhomes.example',
  });
  $$<HTMLButtonElement>(root, '[aria-label="Language"] button')[1]?.click();
  flushSync();
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  await tick();
  flushSync();

  expect($$(root, '.snippet .crumbs').map((c) => c.textContent)).toEqual([
    'coastalhomes.example › listings › seaview-cottage',
    'coastalhomes.example › de › listings › seeblick-haeuschen',
  ]);
});

// The address names the field by row ids, as `_machine` does, so it still lands after a move.
const movedBlock = {
  ...bilingual,
  data: {
    ...bilingual.data,
    body: [
      { _type: 'hero', _id: 'a1b2c3d4', heading: 'First' },
      { _type: 'hero', _id: 'k3nf9a2p', heading: 'Above the harbour' },
    ],
  },
};
const at = (address: string) => history.replaceState({}, '', address);
afterEach(() => at('/admin/c/listings/seaview-cottage'));

test('the field the address names is focused when the entry opens, wherever its row now sits', async () => {
  at('/admin/c/listings/seaview-cottage?field=body%5B_id%3Dk3nf9a2p%5D.heading');
  show({ entry: movedBlock });
  await tick();
  flushSync();

  expect(document.activeElement?.id).toBe('f-body.1.heading');
});

test('a result about another language opens that language beside the form and lands in it', async () => {
  at('/admin/c/listings/seaview-cottage?field=body%5B_id%3Dk3nf9a2p%5D.heading&locale=de');
  const root = show({ entry: movedBlock });
  await tick();
  flushSync();

  expect($(root, 'input#f-title')).not.toBeNull();
  expect(document.activeElement?.id).toBe('t-body.0.heading');
});

test('a Canvas entry navigation opens the localized session even without a field target', async () => {
  at('/admin/c/listings/seaview-cottage?locale=de');
  const root = show({ entry: movedBlock });
  await tick();
  flushSync();

  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Seaview Cottage');
  expect($(root, 'input#f-title')).not.toBeNull();
});

test('the field is landed on when the address changes under an open entry', async () => {
  show({ entry: movedBlock });
  await tick();
  expect(document.activeElement?.id).not.toBe('f-title');

  history.pushState({}, '', '/admin/c/listings/seaview-cottage?field=title');
  dispatchEvent(new PopStateEvent('popstate'));
  await tick();
  flushSync();

  expect(document.activeElement?.id).toBe('f-title');
});

// The list the queue reads is the collection's own, in its order, with the last build's marks.
const queueList = (rows: unknown[] | (() => Promise<Response>) = sixLanguageRows()) => {
  const fetchMock = vi.fn(async (url: string) => {
    if (isLock(url)) return Response.json(HELD);
    if (url === '/admin/api/entries/listings')
      return typeof rows === 'function' ? rows() : Response.json({ entries: rows, locales: SIX });
    if (String(url).startsWith('/admin/api/source/')) return Response.json({ changed: {} });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const listReads = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.filter((call) => call[0] === '/admin/api/entries/listings').length;
const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await tick();
    flushSync();
  }
};
const queueNext = (root: ParentNode) => $(root, '.pane-head .queue-next');
const nextLink = (root: ParentNode) => $<HTMLAnchorElement>(root, '.pane-head .queue-next a');

test('a queue opens its language beside the source and Next skips to the next row owing it', async () => {
  queueList();
  at('/admin/c/listings/twoMissing?queue=fr&owed=stale');
  const root = show({ slug: 'twoMissing', ...sixLanguages('twoMissing') });
  await settle();

  expect($(root, '.editor-form-heading h2')?.textContent).toBe('English');
  expect($(root, '#pane-fr')?.textContent).toContain('French');
  expect(nextLink(root)?.textContent?.trim()).toBe('Next in French');
  // germanFirst and legacy have no French file and partlyMarked's is current.
  expect(nextLink(root)?.getAttribute('href')).toBe(
    '/admin/c/listings/machine?queue=fr&owed=stale',
  );
  vi.unstubAllGlobals();
});

// A link opens a language for this visit; the view the person chose stays theirs.
test('opening a queue or a language link leaves the saved view as it was', async () => {
  const key = 'handover:editor-view:v3:/:u1';
  localStorage.setItem(key, 'none');
  queueList();
  at('/admin/c/listings/twoMissing?queue=fr&owed=stale');
  const root = show({ slug: 'twoMissing', userId: 'u1', ...sixLanguages('twoMissing') });
  await settle();
  expect($(root, '#pane-fr')).not.toBeNull();
  expect(localStorage.getItem(key)).toBe('none');
  unmount(app);

  at('/admin/c/listings/twoMissing?locale=de');
  const again = show({ slug: 'twoMissing', userId: 'u1', ...sixLanguages('twoMissing') });
  await settle();
  expect($(again, '#pane-de')).not.toBeNull();
  expect(localStorage.getItem(key)).toBe('none');
  vi.unstubAllGlobals();
});

test('a queue for a language with no file opens its create pane, with Next in the pane head', async () => {
  queueList();
  at('/admin/c/listings/twoMissing?queue=es&owed=missing');
  const root = show({ slug: 'twoMissing', ...sixLanguages('twoMissing') });
  await settle();

  expect($(root, '#pane-es')?.textContent).toContain('Spanish');
  expect($(root, '.btn-create')).not.toBeNull();
  expect(nextLink(root)?.getAttribute('href')).toBe(
    '/admin/c/listings/germanFirst?queue=es&owed=missing',
  );
  vi.unstubAllGlobals();
});

// After the Spanish file is created the editor remounts; this entry no longer owes it.
test('the queue keeps its place from an entry that is no longer owed the language', async () => {
  const rows = sixLanguageRows();
  const base = rows[0] as (typeof rows)[number];
  base.locales.es = { title: 'Casa del puerto', path: 'src/content/listings/es/base.yaml' };
  queueList(rows);
  at('/admin/c/listings/base?queue=es&owed=missing');
  const opened = sixLanguages('base');
  opened.entry.translations.es = { title: 'Casa del puerto' };
  const root = show({ slug: 'base', ...opened });
  await settle();

  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Casa del puerto');
  expect(nextLink(root)?.getAttribute('href')).toBe(
    '/admin/c/listings/twoMissing?queue=es&owed=missing',
  );
  vi.unstubAllGlobals();
});

test('a queue for everything owed stops at a partly written file, stale or not, once', async () => {
  queueList();
  at('/admin/c/listings/untouchedInvalid?queue=it&owed=owed');
  const root = show({ slug: 'untouchedInvalid', ...sixLanguages('untouchedInvalid') });
  await settle();

  // Its Italian file answers none of the two texts English has.
  expect(nextLink(root)?.getAttribute('href')).toBe(
    '/admin/c/listings/staleAndPartial?queue=it&owed=owed',
  );
  unmount(app);
  document.body.innerHTML = '';
  at('/admin/c/listings/staleAndPartial?queue=fr&owed=owed');
  const again = show({ slug: 'staleAndPartial', ...sixLanguages('staleAndPartial') });
  await settle();

  // French there is both stale and partly written; the queue moves past it all the same.
  expect(nextLink(again)?.getAttribute('href')).toBe(
    '/admin/c/listings/sourceDraft?queue=fr&owed=owed',
  );
  vi.unstubAllGlobals();
});

test('the last row owing the language says the queue ends, not that nothing is owed', async () => {
  // Without the conflict row, which never opens in the editor, `structured` is the last one.
  queueList(sixLanguageRows().filter((row) => row.id !== 'sourceConflict'));
  at('/admin/c/listings/structured?queue=es&owed=owed');
  const root = show({ slug: 'structured', ...sixLanguages('structured') });
  await settle();

  expect(nextLink(root)).toBeNull();
  expect(queueNext(root)?.textContent).toContain('End of this queue');
  vi.unstubAllGlobals();
});

test('an entry the list does not have cannot continue the queue', async () => {
  queueList();
  at('/admin/c/listings/gone?queue=es&owed=owed');
  const root = show({ slug: 'gone', ...sixLanguages('base') });
  await settle();

  expect(nextLink(root)).toBeNull();
  expect(queueNext(root)?.textContent).toContain('This entry is not in the list');
  expect(queueNext(root)?.textContent).not.toContain('End of this queue');
  vi.unstubAllGlobals();
});

test('a queue in a language the site does not declare is no queue at all', async () => {
  const fetchMock = queueList();
  at('/admin/c/listings/base?queue=xx&owed=missing');
  const root = show({ slug: 'base', ...sixLanguages('base') });
  await settle();

  expect($(root, '.pane-head')).toBeNull();
  expect(queueNext(root)).toBeNull();
  expect(listReads(fetchMock)).toBe(0);
  vi.unstubAllGlobals();
});

test('an entry opened directly has no queue and does not read the list', async () => {
  const fetchMock = queueList();
  const root = show({ slug: 'base', ...sixLanguages('base') });
  sideBySide(root);
  await settle();

  expect($(root, '#pane-de')).not.toBeNull();
  expect(queueNext(root)).toBeNull();
  expect(listReads(fetchMock)).toBe(0);
  vi.unstubAllGlobals();
});

test('a failed queue read offers a retry instead of saying the queue ended', async () => {
  let offline = true;
  const fetchMock = queueList(async () => {
    if (offline) throw new TypeError('offline');
    return Response.json({ entries: sixLanguageRows(), locales: SIX });
  });
  at('/admin/c/listings/twoMissing?queue=fr&owed=stale');
  const root = show({ slug: 'twoMissing', ...sixLanguages('twoMissing') });
  await settle();

  expect(queueNext(root)?.textContent).toContain('Could not find the next entry.');
  expect(queueNext(root)?.textContent).not.toContain('End of this queue');
  offline = false;
  $<HTMLButtonElement>(root, '.queue-next button')?.click();
  await settle();

  expect(listReads(fetchMock)).toBe(2);
  expect(nextLink(root)?.getAttribute('href')).toBe(
    '/admin/c/listings/machine?queue=fr&owed=stale',
  );
  vi.unstubAllGlobals();
});

test('the Content, SEO and History links keep the queue', async () => {
  queueList();
  at('/admin/c/listings/structured?queue=fr&owed=stale');
  const root = show({ slug: 'structured', ...sixLanguages('structured') });
  await settle();

  expect(
    $$<HTMLAnchorElement>(root, '.editor-sections a').map((a) => a.getAttribute('href')),
  ).toEqual([
    '/admin/c/listings/structured?queue=fr&owed=stale',
    '/admin/c/listings/structured/seo?queue=fr&owed=stale',
    '/admin/c/listings/structured/history?queue=fr&owed=stale',
  ]);
  vi.unstubAllGlobals();
});

test('choosing another pane language leaves the queue on its own language', async () => {
  queueList();
  at('/admin/c/listings/twoMissing?queue=fr&owed=stale');
  const root = show({ slug: 'twoMissing', ...sixLanguages('twoMissing') });
  await settle();

  await choosePaneLanguage(root, 0);

  expect(paneLanguagePick(root)?.textContent).toContain('German');
  expect(nextLink(root)?.textContent?.trim()).toBe('Next in French');
  expect(nextLink(root)?.getAttribute('href')).toBe(
    '/admin/c/listings/machine?queue=fr&owed=stale',
  );
  vi.unstubAllGlobals();
});

test('the take-over dialog exposes the modal boundary it now enforces', async () => {
  vi.stubGlobal('fetch', heldBy());
  const root = show();
  await tick();
  flushSync();

  $<HTMLButtonElement>(root, '.lock-banner .btn-link')?.click();
  flushSync();
  const dialog = $(root, '[aria-labelledby="take-h"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.getAttribute('aria-modal')).toBe('true');
  vi.unstubAllGlobals();
});

// The shell's notice names the entry, and only this screen knows what it is called.
test('a header publish tells the shell what was published', async () => {
  const published = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) =>
      isLock(url)
        ? Response.json(HELD)
        : init?.method === 'POST' && url === '/admin/api/publish'
          ? Response.json({ commit_sha: 'def4567890', paths: ['src/content/x.yaml'] })
          : Response.json({ updated_at: 1755864000000, pending: true, problems: [] }),
    ),
  );
  const root = show({ entry: { ...entry, pending: ['en'] }, onpublished: published });
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();
  $<HTMLButtonElement>(root, '.dialog .btn-primary')?.click();
  await tick();
  flushSync();

  expect(published).toHaveBeenCalledWith('Seaview Cottage');
  vi.unstubAllGlobals();
});

// F05–F07: the mounted editor must keep the actual form, not merely report a failed helper.
test.each([500, 409])(
  'a refused translation flush (%i) keeps its pane and blocks hold/address/status',
  async (status) => {
    const changed = vi.fn();
    const requests = vi.fn(async (url: string, init?: RequestInit) =>
      isLock(url)
        ? Response.json(HELD)
        : init?.method === 'PUT'
          ? Response.json({ reason: 'revision' }, { status })
          : Response.json({}),
    );
    vi.stubGlobal('fetch', requests);
    const root = show({ entry: { ...addressed, hidden: true }, onchanged: changed });
    $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
    flushSync();
    type(root, 'input#t-title', 'Unsaved German');
    $<HTMLButtonElement>(root, '[aria-label="Close side by side"]')?.click();
    await tick();
    flushSync();
    expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Unsaved German');
    expect($(root, '.pane .autosave')?.textContent).toContain('Not saved');
    $<HTMLButtonElement>(root, '.hold-toggle')?.click();
    await tick();
    $<HTMLButtonElement>(root, '.slug-row .btn-link')?.click();
    flushSync();
    $<HTMLButtonElement>(root, '.slug-row .btn')?.click();
    await tick();
    $<HTMLButtonElement>(root, '.status')?.click();
    flushSync();
    $$<HTMLButtonElement>(root, '.status-menu button')[0]?.click();
    await tick();
    expect(wrote(requests).every((c) => (c[1] as RequestInit).method === 'PUT')).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  },
);

test('a slow save drains the latest source edit with the returned revision before flush finishes', async () => {
  const { flushNavigation } = await import('../navigate');
  let release!: (response: Response) => void;
  const calls: { data: { title: string }; revision: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (isLock(url)) return Response.json(HELD);
      if (isLint(url)) return Response.json({ results: [] });
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 1)
        return new Promise<Response>((r) => {
          release = r;
        });
      return Response.json({ pending: true, problems: [], revisions: { en: 'third' } });
    }),
  );
  const root = show({ entry: { ...entry, revisions: { en: 'first' } } });
  type(root, 'input#f-title', 'First edit');
  const flushing = flushNavigation();
  await tick();
  type(root, 'input#f-title', 'Seaview Cottage');
  const again = flushNavigation();
  await tick();
  expect(calls).toHaveLength(1);
  const unloading = new Event('beforeunload', { cancelable: true });
  dispatchEvent(unloading);
  expect(unloading.defaultPrevented).toBe(true);
  release(Response.json({ pending: true, problems: [], revisions: { en: 'second' } }));
  expect(await flushing).toBe(true);
  expect(await again).toBe(true);
  flushSync();
  expect(calls.map((c) => [c.data.title, c.revision])).toEqual([
    ['First edit', 'first'],
    ['Seaview Cottage', 'second'],
  ]);
  expect(
    $(root, '.editor-header .autosave')?.textContent ?? $(root, '.autosave')?.textContent,
  ).toContain('Saved');
  vi.unstubAllGlobals();
});

test('a rejected network save settles, preserves the edit, warns on unload, and can retry', async () => {
  const { flushNavigation } = await import('../navigate');
  let offline = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (isLock(url)) return Response.json(HELD);
      if (offline) throw new TypeError('offline');
      return Response.json({ pending: true, problems: [], revisions: { en: 'next' } });
    }),
  );
  const root = show({ entry: { ...entry, revisions: { en: 'opened' } } });
  type(root, 'input#f-title', 'Keep this text');
  expect(await flushNavigation()).toBe(false);
  flushSync();
  expect($(root, '.autosave')?.textContent).toContain('Not saved');
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Keep this text');
  const unloading = new Event('beforeunload', { cancelable: true });
  dispatchEvent(unloading);
  expect(unloading.defaultPrevented).toBe(true);
  offline = false;
  expect(await flushNavigation()).toBe(true);
  flushSync();
  const savedUnload = new Event('beforeunload', { cancelable: true });
  dispatchEvent(savedUnload);
  expect(savedUnload.defaultPrevented).toBe(false);
  vi.unstubAllGlobals();
});

test.each([500, 409])(
  'a source save failure (%i) prevents status and turn-off mutations',
  async (status) => {
    const changed = vi.fn();
    const requests = vi.fn(async (url: string, init?: RequestInit) =>
      isLock(url)
        ? Response.json(HELD)
        : init?.method === 'PUT'
          ? Response.json({ reason: 'revision' }, { status })
          : Response.json({}),
    );
    vi.stubGlobal('fetch', requests);
    const root = show({ entry: { ...addressed, hidden: true }, onchanged: changed });
    $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
    flushSync();
    type(root, 'input#f-title', 'Keep the source edit');
    $<HTMLButtonElement>(root, '.status')?.click();
    flushSync();
    $$<HTMLButtonElement>(root, '.status-menu button')[0]?.click();
    await tick();
    $<HTMLButtonElement>(root, '.pane-head button.btn-off')?.click();
    flushSync();
    $<HTMLButtonElement>(root, '.dialog button.btn-danger')?.click();
    await tick();
    expect(wrote(requests).length).toBeGreaterThan(0);
    expect(wrote(requests).every((c) => (c[1] as RequestInit).method === 'PUT')).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Keep the source edit');
    vi.unstubAllGlobals();
  },
);

test('the source and translation share a save lane and propagate sibling revisions', async () => {
  const { flushNavigation } = await import('../navigate');
  let release: ((response: Response) => void) | undefined;
  const calls: { url: string; revision: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (isLock(url)) return Response.json(HELD);
      if (isLint(url)) return Response.json({ results: [] });
      calls.push({ url, revision: JSON.parse(String(init?.body)).revision });
      if (calls.length === 1)
        return new Promise<Response>((r) => {
          release = r;
        });
      return Response.json({ pending: true, problems: [], revision: 'de-next' });
    }),
  );
  const root = show({ entry: { ...bilingual, revisions: { en: 'en-opened', de: 'de-opened' } } });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  type(root, 'input#f-price', 'New shared price');
  const flushing = flushNavigation();
  await tick();
  type(root, 'input#t-title', 'New German words');
  const again = flushNavigation();
  await tick();
  expect(calls).toHaveLength(1);
  if (!release) throw new Error('Source save did not start');
  release(
    Response.json({ pending: true, problems: [], revisions: { en: 'en-next', de: 'de-synced' } }),
  );
  expect(await flushing).toBe(true);
  expect(await again).toBe(true);
  expect(calls).toEqual([
    { url: '/admin/api/drafts/listings/seaview-cottage', revision: 'en-opened' },
    { url: '/admin/api/drafts/listings/seaview-cottage/de', revision: 'de-synced' },
  ]);
  vi.unstubAllGlobals();
});

test.each(['source', 'translation'])(
  '%s activity renews a lease despite frequent read polls',
  async (column) => {
    vi.useFakeTimers();
    let expiry = Date.now() + 120000;
    const requests = vi.fn(async (url: string, init?: RequestInit) => {
      if (isLock(url)) {
        if (init?.method === 'POST') expiry = Date.now() + 120000;
        return Response.json({ ...HELD, expires_at: expiry });
      }
      return Response.json({ pending: true, problems: [] });
    });
    vi.stubGlobal('fetch', requests);
    try {
      const root = show({ entry: bilingual });
      if (column === 'translation') {
        $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
        flushSync();
      }
      await vi.advanceTimersByTimeAsync(46000);
      type(root, column === 'source' ? 'input#f-title' : 'input#t-title', 'Activity renews');
      await vi.advanceTimersByTimeAsync(2100);
      flushSync();
      const claims = () =>
        requests.mock.calls.filter(([url, init]) => isLock(url) && init?.method === 'POST');
      expect(claims()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(46000);
      flushSync();
      expect(claims()).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  },
);

test.each(['source', 'translation'])(
  'a rejected %s save settles and retains data for retry',
  async (column) => {
    const { flushNavigation } = await import('../navigate');
    let offline = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (isLock(url)) return Response.json(HELD);
        if (offline) throw new TypeError('Network disconnected');
        return Response.json({ pending: true, problems: [] });
      }),
    );
    const root = show({ entry: bilingual });
    if (column === 'translation') {
      $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
      flushSync();
    }
    const field = column === 'source' ? 'input#f-title' : 'input#t-title';
    type(root, field, 'Keep offline words');
    expect(await flushNavigation()).toBe(false);
    flushSync();
    expect(root.textContent).toContain('Not saved');
    expect(root.textContent).not.toContain('Saving…');
    expect($<HTMLInputElement>(root, field)?.value).toBe('Keep offline words');
    offline = false;
    expect(await flushNavigation()).toBe(true);
    flushSync();
    expect(root.textContent).not.toContain('Not saved');
    vi.unstubAllGlobals();
  },
);

test('a rejected status action becomes retryable without discarding the editor', async () => {
  const changed = vi.fn();
  let offline = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (isLock(url)) return Response.json(HELD);
      if (offline) throw new TypeError('offline');
      return Response.json({});
    }),
  );
  const root = show({ entry: { ...entry, hidden: true }, onchanged: changed });
  const clickStatus = () => {
    $<HTMLButtonElement>(root, '.status')?.click();
    flushSync();
    $$<HTMLButtonElement>(root, '.status-menu button')[0]?.click();
  };
  clickStatus();
  await tick();
  flushSync();
  expect(changed).not.toHaveBeenCalled();
  expect(root.textContent).toContain('Connection lost');
  offline = false;
  clickStatus();
  await tick();
  flushSync();
  expect(changed).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

test('the editor starts focused and opens its second pane only when requested', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show({ entry: { ...bilingual, route: '/listings/[slug]' } });
  expect($(root, '.entry-body.has-pane')).toBeNull();
  expect($(root, '[aria-label="Right pane"]')).toBeNull();
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  expect($(root, '.entry-body.has-pane .pane.is-locale')).not.toBeNull();
  $$<HTMLButtonElement>(root, '[aria-label="Beside the form"] button')[0]?.click();
  flushSync();
  expect($(root, '.entry-body.has-pane')).toBeNull();
  vi.unstubAllGlobals();
});

test('a short settings form stays single-column without an outline', () => {
  const fields: Field[] = [
    ...entry.fields,
    { path: ['phone'], label: 'Phone', type: 'text', required: false },
    { path: ['email'], label: 'Email', type: 'text', required: false },
  ];
  const root = show({
    collection: 'globals',
    slug: 'site',
    entry: { ...entry, fields, singleton: true, label: 'Site details' },
  });

  expect($(root, '.entry-body.has-outline')).toBeNull();
  expect($(root, '.editor-outline')).toBeNull();
});

test('Canvas exposes validation problems with a working jump to the affected field', async () => {
  const root = show({
    entry: {
      ...entry,
      route: '/listings/[slug]',
      problems: [{ path: 'title', message: 'Required' }],
    },
    preview: true,
    userId: 'u1',
  });
  $<HTMLButtonElement>(root, '.canvas-open')?.click();
  flushSync();
  expect($(root, '.canvas-workspace.is-fullscreen')).not.toBeNull();
  expect($(root, '.canvas-validation')?.textContent).toContain('1 field needs attention');
  expect($(root, '.canvas-validation')?.textContent).toContain('Required');
  $<HTMLButtonElement>(root, '.canvas-validation button')?.click();
  await vi.waitFor(() => expect(document.activeElement?.id).toBe('canvas-inspector-title'));
  expect($(root, '#canvas-inspector input[aria-invalid="true"]')).not.toBeNull();
  expect($(root, '.canvas-workspace.is-fullscreen')).not.toBeNull();
});

test('the mobile translation switch keeps both language forms mounted and changes the visible pane', () => {
  const root = show({ entry: bilingual });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  const source = $(root, 'input#f-title');
  const translation = $(root, 'input#t-title');
  const switches = $$<HTMLButtonElement>(root, '.canvas-mobile-tabs button');
  expect(switches.map((button) => button.textContent)).toEqual(['English', 'German']);
  expect($(root, '.canvas-form-surface')?.classList.contains('is-mobile-hidden')).toBe(true);
  switches[1]?.click();
  flushSync();
  expect($(root, '.entry-body > .form')?.classList.contains('is-mobile-hidden')).toBe(true);
  expect($(root, '.canvas-form-surface')?.classList.contains('is-mobile-hidden')).toBe(false);
  expect($(root, 'input#f-title')).toBe(source);
  expect($(root, 'input#t-title')).toBe(translation);
});

test('opening Canvas from Translate removes the mobile language tabs', () => {
  const root = show({ entry: { ...bilingual, route: '/listings/[slug]' }, preview: true });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  expect($(root, '.canvas-mobile-tabs')).not.toBeNull();
  $<HTMLButtonElement>(root, '.canvas-open')?.click();
  flushSync();
  expect($(root, '.canvas-workspace.is-fullscreen')).not.toBeNull();
  expect($(root, '.canvas-mobile-tabs')).toBeNull();
});

test('a saved Write preference yields to live preview when a page is available', () => {
  localStorage.setItem('handover:editor-view:v3:/:u1', 'none');
  const root = show({
    entry: { ...bilingual, route: '/listings/[slug]' },
    preview: true,
    userId: 'u1',
  });
  flushSync();
  expect(beside(root).map((button) => button.textContent)).toEqual(['Live preview', 'Translate']);
  expect(pressed(root)).toBe('Live preview');
  expect($(root, '.canvas-workspace:not(.is-inactive)')).not.toBeNull();
});

test('closing Translate returns to live preview when a page is available', async () => {
  const root = show({
    entry: { ...bilingual, route: '/listings/[slug]' },
    preview: true,
    userId: 'u1',
  });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.pane-head button[aria-label]')?.click();
  await vi.waitFor(() => expect(pressed(root)).toBe('Live preview'));
  expect(localStorage.getItem('handover:editor-view:v3:/:u1')).toBe('page');
});

test('pressing Live preview again folds the page away for a full-width form, and it stays folded', () => {
  const page = { entry: { ...entry, route: '/listings/[slug]' }, preview: true, userId: 'u1' };
  const root = show(page);
  flushSync();
  beside(root)[0]?.click();
  flushSync();

  expect(pressed(root)).toBeUndefined();
  expect($(root, '.canvas-workspace:not(.is-inactive)')).toBeNull();
  expect($(root, '.entry-body.is-full:not(.has-pane) > .form')).not.toBeNull();

  unmount(app);
  const again = show(page);
  flushSync();
  expect(pressed(again)).toBeUndefined();
  beside(again)[0]?.click();
  flushSync();
  expect(pressed(again)).toBe('Live preview');
  expect($(again, '.entry-body.has-pane > .canvas-workspace:not(.is-inactive)')).not.toBeNull();
});

test('without preview, Translate toggles the comparison pane without a Write option', async () => {
  const root = show({ entry: bilingual });
  expect(beside(root).map((button) => button.textContent)).toEqual(['Translate']);
  beside(root)[0]?.click();
  flushSync();
  expect($(root, 'input#t-title')).not.toBeNull();
  beside(root)[0]?.click();
  await vi.waitFor(() => expect($(root, 'input#t-title')).toBeNull());
  expect($(root, 'input#f-title')).not.toBeNull();
});

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

  unmount(app);
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
  unmount(app);
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
  unmount(app);
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

// Reference language: a third language read under each field of the pane.
const referencePick = (root: ParentNode) =>
  $<HTMLButtonElement>(root, '.pane-head .reference-pick > button');
const referenceChoices = (root: ParentNode) =>
  $$<HTMLButtonElement>(root, '#reference-languages button');
const chooseReference = (root: ParentNode, name: string) => {
  referencePick(root)?.click();
  flushSync();
  referenceChoices(root)
    .find((b) => b.textContent?.startsWith(name))
    ?.click();
  flushSync();
};
const peek = (root: ParentNode, field: string) =>
  $(root, `#t-${field}-field .reference-peek`)?.textContent?.trim();
// `structured` with a French file whose rooms run in the other order from the German one.
const structuredWithFrench = () => {
  const six = sixLanguages('structured');
  const german = six.entry.translations.de as Record<string, unknown>;
  six.entry.translations.fr = {
    ...structuredClone(german),
    title: 'Maison du port',
    rooms: [
      { _id: 'room0001', name: 'Chambre du port' },
      { _id: 'room0002', name: 'Chambre jardin' },
    ],
  };
  return six;
};
const frenchBesideEnglish = async (root: ParentNode) => {
  sideBySide(root);
  paneLanguagePick(root)?.click();
  flushSync();
  paneChoices(root)
    .find((b) => b.textContent?.startsWith('French'))
    ?.click();
  await tick();
  flushSync();
};

test('German reads under the French title, rich text and a field inside a block', async () => {
  const root = show(structuredWithFrench());
  await frenchBesideEnglish(root);

  chooseReference(root, 'German');

  expect(peek(root, 'title')).toBe('German Haus am Hafen');
  expect($(root, '#t-title-field .reference-peek [lang="de"]')?.textContent).toBe('Haus am Hafen');
  expect($(root, '#t-summary-field .reference-peek [lang="de"]')?.innerHTML).toBe(
    '<p><strong>Ruhige</strong> Zimmer über dem Hafen.</p>',
  );
  expect(peek(root, 'body\\.0\\.heading')).toBe('German Jetzt buchen');
  expect(peek(root, 'body\\.0\\.button')).toBe('German Buchen');
});

test('a French row in another order still peeks at the German row with its id', async () => {
  const root = show(structuredWithFrench());
  await frenchBesideEnglish(root);

  chooseReference(root, 'German');

  expect($<HTMLInputElement>(root, '#t-rooms\\.0\\.name')?.value).toBe('Chambre du port');
  expect(peek(root, 'rooms\\.0\\.name')).toBe('German Hafenzimmer');
  expect(peek(root, 'rooms\\.1\\.name')).toBe('German Gartenzimmer');
});

test('an empty German value and a row German lacks say so instead of drawing nothing', async () => {
  const six = structuredWithFrench();
  const german = six.entry.translations.de as Record<string, unknown>;
  german.title = '';
  german.rooms = [{ _id: 'room0002', name: 'Gartenzimmer' }];
  const root = show(six);
  await frenchBesideEnglish(root);

  chooseReference(root, 'German');

  expect(peek(root, 'title')).toBe('German Not written in German yet');
  expect(peek(root, 'rooms\\.0\\.name')).toBe('German This row is not in German');
  expect(peek(root, 'rooms\\.1\\.name')).toBe('German Gartenzimmer');
});

test('a shared or source-only field gets no peek', async () => {
  const root = show(sixLanguages('base'));
  await frenchBesideEnglish(root);

  chooseReference(root, 'German');

  expect(peek(root, 'title')).toBe('German Haus am Hafen');
  expect($(root, '#t-price-field')).not.toBeNull();
  expect($(root, '#t-price-field .reference-peek')).toBeNull();
  expect($(root, '#t-notes-field')).toBeNull();
});

test('beside English, French offers None, German and Italian — never source, target, missing or off', async () => {
  const root = show(sixLanguages('base'));
  await frenchBesideEnglish(root);

  referencePick(root)?.click();
  flushSync();

  expect(referencePick(root)?.textContent?.trim()).toBe('Beside each field: None');
  expect(referenceChoices(root).map((b) => b.textContent?.trim())).toEqual([
    'None',
    'German',
    'Italian— partly written, 0 of 2 texts',
  ]);
  expect(referenceChoices(root).map((b) => b.getAttribute('aria-pressed'))).toEqual([
    'true',
    'false',
    'false',
  ]);
});

test('with files only for the source and the language beside it there is no reference control', () => {
  const root = show(sixLanguages('legacy'));
  sideBySide(root);

  expect($(root, '.pane-head h2')?.textContent).toContain('German');
  expect(referencePick(root)).toBeNull();
});

test('the chosen reference is stored per site and user and comes back on the next entry', async () => {
  const key = 'handover:editor-reference:v1:/:u1';
  const first = show({ ...sixLanguages('base'), userId: 'u1' });
  await frenchBesideEnglish(first);
  chooseReference(first, 'German');
  expect(localStorage.getItem(key)).toBe('de');
  unmount(app);
  document.body.innerHTML = '';
  localStorage.removeItem('handover:editor-view:v3:/:u1');

  const root = show({ ...sixLanguages('base'), userId: 'u1' });
  await frenchBesideEnglish(root);

  expect(referencePick(root)?.textContent?.trim()).toBe('Beside each field: German');
  expect(peek(root, 'title')).toBe('German Haus am Hafen');
});

test('a stored reference that is now the target shows None, stays stored and returns', async () => {
  const key = 'handover:editor-reference:v1:/:u1';
  localStorage.setItem(key, 'de');
  const root = show({ ...sixLanguages('base'), userId: 'u1' });
  sideBySide(root);

  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Haus am Hafen');
  expect(referencePick(root)?.textContent?.trim()).toBe('Beside each field: None');
  expect($(root, '.reference-peek')).toBeNull();
  expect(localStorage.getItem(key)).toBe('de');

  await choosePaneLanguage(root, 1);

  expect(referencePick(root)?.textContent?.trim()).toBe('Beside each field: German');
  expect(peek(root, 'title')).toBe('German Haus am Hafen');
});

test('a browser that refuses storage still lets the reference be chosen and drawn', async () => {
  const refuse = () => {
    throw new DOMException('blocked', 'SecurityError');
  };
  const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse);
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse);
  const root = show(sixLanguages('base'));
  await frenchBesideEnglish(root);

  chooseReference(root, 'German');

  expect(peek(root, 'title')).toBe('German Haus am Hafen');
  expect(write).toHaveBeenCalledWith('handover:editor-reference:v1:/:', 'de');
  read.mockRestore();
  write.mockRestore();
});

test('the peek is not an input, not a tab stop, and choosing it leaves nothing to save', async () => {
  const six = structuredWithFrench();
  (six.entry.translations.de as Record<string, unknown>).summary =
    'Ruhige Zimmer über dem [Hafen](https://example.com/hafen).';
  const root = show(six);
  await frenchBesideEnglish(root);

  chooseReference(root, 'German');

  const peeks = $$<HTMLElement>(root, '.reference-peek');
  expect(peeks.length).toBeGreaterThan(0);
  for (const node of peeks) {
    expect(
      node.querySelector('input, textarea, button, select, a[href], [tabindex], [contenteditable]'),
    ).toBeNull();
    expect(node.hasAttribute('tabindex')).toBe(false);
    expect(node.id).toBe('');
  }
  expect($(root, '[aria-describedby*="reference"]')).toBeNull();
  expect($(root, '.pane-head .autosave')?.textContent?.trim()).toBe('Saved');
});

test('Escape closes the reference choice and gives focus back to its button', async () => {
  const root = show(sixLanguages('base'));
  await frenchBesideEnglish(root);
  referencePick(root)?.click();
  flushSync();
  expect($(root, '#reference-languages')).not.toBeNull();

  referenceChoices(root)[1]?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  flushSync();

  expect($(root, '#reference-languages')).toBeNull();
  expect(document.activeElement).toBe(referencePick(root));
});

test('Translate what’s empty still asks for the target alone with a reference chosen', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    isLock(url) ? Response.json(HELD) : Response.json({ data: {}, pending: true }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const root = show(sixLanguages('machine'));
  await frenchBesideEnglish(root);
  chooseReference(root, 'German');

  $<HTMLButtonElement>(root, 'button.btn-fill')?.click();
  await tick();

  expect(fetchMock).toHaveBeenCalledWith('/admin/api/translate/listings/seaview-cottage/fr', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  vi.unstubAllGlobals();
});

// M12 — the pane's run through what its language still owes.
const todoNext = (root: ParentNode) => $<HTMLButtonElement>(root, '.pane-head .btn-todo');
const announced = (root: ParentNode) => $(root, '.pane-head [role="status"]')?.textContent;
const runTodo = async (root: ParentNode) => {
  todoNext(root)?.click();
  await settle();
};
const staleSource = (changed: Record<string, unknown>) => {
  const fetchMock = vi.fn(async (url: string) =>
    isLock(url)
      ? Response.json(HELD)
      : String(url).startsWith('/admin/api/source/')
        ? Response.json({ changed, translatedAt: '2026-09-01T09:00:00.000Z' })
        : Response.json({ updated_at: 1755864000000, pending: true, problems: [] }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const CHANGED_TITLE = {
  title: [{ text: 'Harbour ' }, { text: 'House', mark: 'del' }, { text: 'Cottage', mark: 'ins' }],
};
/** French owes the source's drafted subtitle and its lost heading, and its title is behind. */
const owing = () => {
  const opened = sixLanguages('sourceDraft');
  (opened.entry.translations.fr as { body: Record<string, unknown>[] }).body = [
    { _type: 'hero', _id: 'hero0001' },
  ];
  return opened;
};

test('a press visits each empty and stale field in turn, and the last one wraps', async () => {
  staleSource(CHANGED_TITLE);
  const root = show(owing());
  await frenchBesideEnglish(root);
  await settle();

  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-title');
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-subtitle');
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-body.0.heading');
  // Reading a field is not answering it: the run comes round again.
  expect(announced(root)).toBe('');

  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-title');
  expect(announced(root)).toBe('Back to the first field');
  vi.unstubAllGlobals();
});

test('an answered field drops out of the run as it is typed', async () => {
  staleSource(CHANGED_TITLE);
  const root = show(owing());
  await frenchBesideEnglish(root);
  await settle();

  await runTodo(root);
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-subtitle');
  type(root, 'input#t-subtitle', 'Six personnes, chiens bienvenus');
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-body.0.heading');

  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-title');
  vi.unstubAllGlobals();
});

test('a dismissed marker leaves the run with the empty fields it left behind', async () => {
  staleSource(CHANGED_TITLE);
  const root = show(owing());
  await frenchBesideEnglish(root);
  await settle();

  $<HTMLButtonElement>(root, '.pane .stale')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.pane .popover .actions button:last-of-type')?.click();
  await settle();

  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-subtitle');
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-body.0.heading');
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-subtitle');
  expect(announced(root)).toBe('Back to the first field');
  vi.unstubAllGlobals();
});

test('only a language with nothing outstanding is told there is nothing left to do', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show(sixLanguages('base'));
  sideBySide(root);
  await settle();

  await runTodo(root);

  expect(announced(root)).toBe('Nothing left to do');
  vi.unstubAllGlobals();
});

test('a stale language claims nothing while the list of changes is still being read', async () => {
  const gate = deferred<Response>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      isLock(url)
        ? Response.json(HELD)
        : String(url).startsWith('/admin/api/source/')
          ? gate.promise
          : Response.json({}),
    ),
  );
  const root = show(sixLanguages('base'));
  await frenchBesideEnglish(root);
  await settle();

  await runTodo(root);
  expect(announced(root)).toBe('');

  gate.resolve(Response.json({ changed: {} }));
  await settle();
  await runTodo(root);

  expect(announced(root)).toBe('Nothing left to do');
  vi.unstubAllGlobals();
});

test('a folded block is opened so the run lands on the input itself', async () => {
  staleSource({});
  const root = show(sixLanguages('staleAndPartial'));
  await frenchBesideEnglish(root);
  await settle();
  $<HTMLButtonElement>(root, '.pane .block-card button.fold')?.click();
  flushSync();
  expect($(root, 'input#t-body\\.0\\.heading')).toBeNull();

  await runTodo(root);

  expect(document.activeElement?.id).toBe('t-body.0.heading');
  expect(document.activeElement?.tagName).toBe('INPUT');
  vi.unstubAllGlobals();
});

// The section is the shell's to redraw, so the focus that lands there is proven in `App.test.ts`.
test('an SEO text takes the run to the SEO tab without dropping the queue', async () => {
  queueList();
  at('/admin/c/listings/structured?queue=de&owed=missing');
  const opened = sixLanguages('structured');
  delete ((opened.entry.translations.de as Record<string, unknown>).seo as Record<string, unknown>)
    .description;
  const root = show({ slug: 'structured', ...opened });
  await settle();

  await runTodo(root);

  expect(location.pathname).toBe('/admin/c/listings/structured/seo');
  expect(location.search).toBe('?queue=de&owed=missing');
  vi.unstubAllGlobals();
});

test('a marker on a row the file no longer has is passed over', async () => {
  staleSource({
    'body[_id=gone0001].heading': [{ text: 'Gone' }],
    title: [{ text: 'Harbour House' }],
  });
  const root = show(sixLanguages('base'));
  await frenchBesideEnglish(root);
  await settle();

  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-title');
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-title');
  // The run came round to the title again rather than resting on the row that is gone.
  expect(announced(root)).toBe('Back to the first field');
  vi.unstubAllGlobals();
});

test('a row that sits elsewhere in this language is still matched by its identity', async () => {
  staleSource({});
  const opened = sixLanguages('structured');
  for (const row of (opened.entry.translations.de as { rooms: Record<string, unknown>[] }).rooms)
    delete row.name;
  const root = show({ slug: 'structured', ...opened });
  sideBySide(root);
  await settle();

  // German has the garden room first, so the source's first room is its second row.
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-rooms.1.name');
  await runTodo(root);
  expect(document.activeElement?.id).toBe('t-rooms.0.name');
  vi.unstubAllGlobals();
});

test('Alt and the down arrow run the pane, unless something else owns the key', async () => {
  staleSource(CHANGED_TITLE);
  const root = show(owing());
  await frenchBesideEnglish(root);
  await settle();
  const chord = async (target: Element, init: KeyboardEventInit = {}) => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        altKey: true,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
    await settle();
  };
  const subtitle = $(root, 'input#t-subtitle');
  if (!subtitle) throw new Error('subtitle missing');

  await chord(subtitle);
  expect(document.activeElement?.id).toBe('t-title');

  // Mid-composition the arrow belongs to the input method.
  await chord($(root, 'input#t-title') as Element, { isComposing: true });
  expect(document.activeElement?.id).toBe('t-title');

  // An open popover answers its own keys.
  $<HTMLButtonElement>(root, '.pane .stale')?.click();
  flushSync();
  await chord($(root, '.pane .popover') as Element);
  expect($(root, '.pane .popover')).not.toBeNull();
  vi.unstubAllGlobals();
});

const CHANGED_HEADING = {
  'body[_id=hero0001].heading': [
    { text: 'Above the ' },
    { text: 'harbour', mark: 'del' },
    { text: 'fish market', mark: 'ins' },
  ],
};

test('a marker dismissed inside a block reaches the pane, which then has nothing left', async () => {
  staleSource(CHANGED_HEADING);
  const root = show(sixLanguages('base'));
  await frenchBesideEnglish(root);
  await settle();

  $<HTMLButtonElement>(root, '.pane .block-card .stale')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.pane .popover .actions button:last-of-type')?.click();
  await settle();
  await runTodo(root);

  expect(announced(root)).toBe('Nothing left to do');
  vi.unstubAllGlobals();
});

test('a field that answers the chord itself keeps it', async () => {
  staleSource(CHANGED_TITLE);
  const root = show(owing());
  await frenchBesideEnglish(root);
  await settle();
  const subtitle = $<HTMLInputElement>(root, 'input#t-subtitle');
  if (!subtitle) throw new Error('subtitle missing');
  subtitle.addEventListener('keydown', (e) => e.preventDefault());
  subtitle.focus();

  subtitle.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      altKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await settle();

  expect(document.activeElement).toBe(subtitle);
  vi.unstubAllGlobals();
});

test('a re-translated field is answered but stays in the run until its marker goes', async () => {
  const opened = sixLanguages('machine');
  (opened.entry.translations.fr as { body: Record<string, unknown>[] }).body = [
    { _type: 'hero', _id: 'hero0001' },
  ];
  const filled = {
    ...(opened.entry.translations.fr as Record<string, unknown>),
    body: [{ _type: 'hero', _id: 'hero0001', heading: 'Au-dessus du marché' }],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      isLock(url)
        ? Response.json(HELD)
        : String(url).startsWith('/admin/api/source/')
          ? Response.json({ changed: CHANGED_HEADING })
          : String(url).startsWith('/admin/api/translate/')
            ? Response.json({ data: filled, pending: true })
            : Response.json({ updated_at: 1755864000000, pending: true, problems: [] }),
    ),
  );
  const root = show(opened);
  await frenchBesideEnglish(root);
  await settle();
  expect(answered(root)).toBe('1 of 2 texts written');

  $<HTMLButtonElement>(root, '.pane .block-card .stale')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.pane .popover .actions button')?.click();
  await settle();

  expect(answered(root)).toBe('2 of 2 texts written');
  await runTodo(root);
  // The words are there, but the source's change has not been acknowledged.
  expect(document.activeElement?.id).toBe('t-body.0.heading');
  expect(announced(root)).toBe('');

  $<HTMLButtonElement>(root, '.pane .block-card .stale')?.click();
  flushSync();
  $<HTMLButtonElement>(root, '.pane .popover .actions button:last-of-type')?.click();
  await settle();
  await runTodo(root);

  expect(announced(root)).toBe('Nothing left to do');
  vi.unstubAllGlobals();
});

test('failed stale-marker loading does not announce that the work is finished', async () => {
  const page = owing();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      isLock(url)
        ? Response.json(HELD)
        : String(url).startsWith('/admin/api/source/')
          ? new Response('Unavailable', { status: 500 })
          : Response.json({ results: [], updated_at: 1755864000000, pending: true, problems: [] }),
    ),
  );
  const root = show(page);
  await frenchBesideEnglish(root);
  await settle();
  type(root, 'input#t-subtitle', 'Sous-titre');
  type(root, 'input#t-body\\.0\\.heading', 'Titre');
  await settle();

  expect(answered(root)).toBe('3 of 3 texts written');
  await runTodo(root);
  expect(announced(root)).not.toBe('Nothing left to do');
  expect($(root, '.marker-load-failure')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'Could not load what changed in the source. Retry',
  );
  vi.unstubAllGlobals();
});

test('a network failure loading stale markers can be retried successfully', async () => {
  const page = owing();
  let markers = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (isLock(url)) return Response.json(HELD);
      if (String(url).endsWith('/fr')) {
        markers += 1;
        if (markers === 1) throw new TypeError('offline');
        return Response.json({ changed: {} });
      }
      if (String(url).startsWith('/admin/api/source/')) return Response.json({ changed: {} });
      return Response.json({ results: [], updated_at: 1755864000000, pending: true, problems: [] });
    }),
  );
  const root = show(page);
  await frenchBesideEnglish(root);
  await settle();
  type(root, 'input#t-subtitle', 'Sous-titre');
  type(root, 'input#t-body\\.0\\.heading', 'Titre');
  await settle();

  await runTodo(root);
  expect(announced(root)).toBe('');
  $<HTMLButtonElement>(root, '.marker-load-failure button')?.click();
  await settle();
  expect(root.querySelector('.marker-load-failure')).toBeNull();
  await runTodo(root);
  expect(announced(root)).toBe('Nothing left to do');
  vi.unstubAllGlobals();
});
