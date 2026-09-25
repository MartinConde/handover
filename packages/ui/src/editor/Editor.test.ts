import type { Field } from '@handover/core';
import { flushSync, unmount } from 'svelte';
import { expect, test, vi } from 'vitest';
import { deferred } from '../test-helpers.fixture.js';
import {
  $,
  $$,
  addressed,
  at,
  autosaved,
  bilingual,
  entry,
  HELD,
  heldBy,
  isLint,
  isLock,
  settled,
  show,
  state,
  tick,
  type,
  useEditorSetup,
  wrote,
} from './editor.fixture.js';

useEditorSetup();

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

const beside = (root: ParentNode) =>
  $$<HTMLButtonElement>(root, '[aria-label="Beside the form"] button');
const pressed = (root: ParentNode) =>
  $(root, '[aria-label="Beside the form"] [aria-pressed="true"]')?.textContent;

// Canvas needs both the injected preview route and a page address to POST into.
test('the page and Canvas are offered only where the site has a page to show', () => {
  const none = show({ entry: bilingual, preview: true });
  expect(beside(none).map((b) => b.textContent)).toEqual(['Translate']);
  expect($(none, '.canvas-open')).toBeNull();
  unmount(state.app);
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

  unmount(state.app);
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
      published: ['en'],
      problems: [],
      titleField: 'name',
      locales: ['en'],
      defaultLocale: 'en',
      sourceLocale: 'en',
      offered: ['en'],
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
  await vi.waitFor(() => {
    flushSync();
    expect($(root, '.dialog h2')).not.toBeNull();
  });

  type(root, 'input#f-title', 'Source after confirmation opened');
  type(root, 'input#t-title', 'Ziel nach dem Öffnen');
  $<HTMLButtonElement>(root, '.dialog .btn-primary')?.click();
  await vi.waitFor(() => expect(order.at(-1)).toBe('publish'));

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

const publishCalls = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.filter((call) => call[0] === '/admin/api/publish');

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
  await vi.waitFor(() => {
    flushSync();
    expect($(root, '.dialog h2')).not.toBeNull();
  });
  type(root, 'input#f-title', 'Unsaved final words');

  $<HTMLButtonElement>(root, '.dialog .btn-primary')?.click();
  await vi.waitFor(() => {
    flushSync();
    expect($(root, '.dialog [role="alert"]')?.textContent).toContain(
      'Your latest changes could not be saved',
    );
  });

  expect(publishCalls(fetchMock)).toHaveLength(0);
  expect($(root, '.dialog [role="alert"]')?.textContent).toContain(
    'Your latest changes could not be saved',
  );
  expect($<HTMLFieldSetElement>(root, '.entry-body > .form > fieldset')?.disabled).toBe(false);
  type(root, 'input#f-title', 'Editing is available again');
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Editing is available again');
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

// An address is validated, unique and owes a redirect when it moves, so it is not a form field.
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

  unmount(state.app);
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
