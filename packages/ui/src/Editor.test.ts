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
  expect(row?.querySelector('.seg[aria-label="Language"]')).not.toBeNull();
  expect(row?.querySelector('.btn-primary')?.textContent).toContain('Publish this entry');
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

// Canvas needs both the injected preview route and a page address to POST into.
test('Canvas modes are enabled only where the site has a page to show', () => {
  expect(
    $<HTMLButtonElement>(show({ preview: true }), '.editor-modes button:last-child')?.disabled,
  ).toBe(true);
  unmount(app);
  const root = show({ entry: { ...entry, route: '/listings/[slug]' }, preview: true });
  expect(
    $<HTMLButtonElement>(root, '.editor-modes button:last-child')?.getAttribute('aria-pressed'),
  ).toBe('false');
  expect($<HTMLButtonElement>(root, '.editor-modes button:last-child')?.disabled).toBe(false);
});

test('pressing Split puts Canvas beside the form at the address this language serves', () => {
  const root = show({
    entry: { ...entry, route: '/listings/[slug]', published: [] },
    preview: true,
  });

  $$<HTMLButtonElement>(root, '.editor-modes button')[1]?.click();
  flushSync();

  expect(
    $<HTMLAnchorElement>(root, '.canvas-workspace a[target="_blank"]')?.getAttribute('href'),
  ).toContain('/_preview/listings/seaview-cottage');
  expect($(root, '.canvas-workspace')).not.toBeNull();
  expect($(root, 'input#f-title')).not.toBeNull();
  const structure = $<HTMLButtonElement>(
    root,
    '.canvas-rail button[aria-controls="canvas-structure"]',
  );
  expect(structure?.disabled).toBe(false);
  expect(structure?.getAttribute('aria-expanded')).toBe('false');
  structure?.click();
  flushSync();
  expect(structure?.getAttribute('aria-expanded')).toBe('true');
  expect($(root, '#canvas-structure[aria-labelledby="canvas-structure-title"]')).not.toBeNull();
});

test('the saved editor mode is scoped to the site base and signed-in user', () => {
  document.body.innerHTML = '<div id="app" data-base="/coastal"></div>';
  localStorage.setItem('handover:canvas-mode:v1:/coastal:u1', 'canvas');
  const root = show({
    entry: { ...entry, route: '/listings/[slug]' },
    preview: true,
    userId: 'u1',
  });

  expect(
    $<HTMLButtonElement>(root, '[aria-label="Editor view"] button[aria-pressed="true"]')
      ?.textContent,
  ).toBe('Canvas');
  $<HTMLButtonElement>(root, '[aria-label="Editor view"] button')?.click();
  flushSync();
  expect(localStorage.getItem('handover:canvas-mode:v1:/coastal:u1')).toBe('form');
});

test('invalid or unsupported Canvas preferences fall back to Form without being overwritten', () => {
  document.body.innerHTML = '<div id="app" data-base="/coastal/"></div>';
  const key = 'handover:canvas-mode:v1:/coastal:u1';
  localStorage.setItem(key, 'canvas');
  const root = show({
    entry: { ...entry, route: '/listings/[slug]' },
    preview: false,
    userId: 'u1',
  });

  expect(
    $<HTMLButtonElement>(root, '[aria-label="Editor view"] button[aria-pressed="true"]')
      ?.textContent,
  ).toBe('Form');
  expect($<HTMLButtonElement>(root, '[aria-label="Editor view"] button:last-child')?.disabled).toBe(
    true,
  );
  expect(localStorage.getItem(key)).toBe('canvas');

  unmount(app);
  localStorage.setItem(key, 'anything-else');
  const invalid = show({
    entry: { ...entry, route: '/listings/[slug]' },
    preview: true,
    userId: 'u1',
  });
  expect(
    $<HTMLButtonElement>(invalid, '[aria-label="Editor view"] button[aria-pressed="true"]')
      ?.textContent,
  ).toBe('Form');
});

test('Form to Canvas to Form retains unsaved field state in the same entry session', () => {
  const root = show({
    entry: { ...entry, route: '/listings/[slug]' },
    preview: true,
    userId: 'u1',
  });
  type(root, 'input#f-title', 'Unsaved harbour edit');

  $$<HTMLButtonElement>(root, '[aria-label="Editor view"] button')[2]?.click();
  flushSync();
  expect($(root, '.canvas-workspace')).not.toBeNull();
  expect($(root, 'input#f-title')).toBeNull();

  $$<HTMLButtonElement>(root, '[aria-label="Editor view"] button')[0]?.click();
  flushSync();
  expect($<HTMLInputElement>(root, 'input#f-title')?.value).toBe('Unsaved harbour edit');
});

test('Split replaces comparison with Canvas and Form restores the unsaved translation', () => {
  const root = show({
    entry: { ...bilingual, route: '/listings/[slug]' },
    preview: true,
    userId: 'u1',
  });
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  type(root, 'input#t-title', 'Ungespeicherte Hätte');

  $$<HTMLButtonElement>(root, '[aria-label="Editor view"] button')[1]?.click();
  flushSync();
  expect($(root, '.canvas-workspace')).not.toBeNull();
  expect($(root, 'input#t-title')).toBeNull();

  $$<HTMLButtonElement>(root, '[aria-label="Editor view"] button')[0]?.click();
  flushSync();
  expect($<HTMLInputElement>(root, 'input#t-title')?.value).toBe('Ungespeicherte Hätte');
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

// The hold goes with the draft, so it never blocks the entry's own publish.
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

// Five languages is where a row of buttons stops fitting — Sveltia's threshold.
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

// Autosave is independent of rendering: the live Canvas shell must stay mounted through it.
test('a save in the second language keeps the Canvas workspace mounted', async () => {
  vi.stubGlobal('fetch', autosaved());
  const root = show({
    entry: { ...bilingual, route: '/listings/[slug]', published: ['en', 'de'] },
    preview: true,
  });

  $$<HTMLButtonElement>(root, '.entry-header .seg button')[1]?.click();
  flushSync();
  $$<HTMLButtonElement>(root, '.editor-modes button')[1]?.click();
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
    body: JSON.stringify({ locales: ['en'], redirect: { kind: 'index' } }),
  });
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

// Turning German off deleted its file, so the log's commit is what brings the words back.
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

// Once a refusal means "you lost it", the beat on that save would push the lost lock back out.
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

// A lock that lapsed with nobody after it is not a take-over, so nobody else is named.
test('a lapsed idle lock stays released until the editor reloads', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    !isLock(url)
      ? Response.json({})
      : init?.method === 'POST'
        ? Response.json(HELD)
        : Response.json({ held_by: null, mine: false, expires_at: null }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const reload = vi.fn();
  const changed = vi.fn();
  const root = show({ onreload: reload, onchanged: changed });
  await vi.advanceTimersByTimeAsync(16_000);
  flushSync();

  const claims = fetchMock.mock.calls.filter((c) => isLock(c[0]) && c[1]?.method === 'POST');
  expect(claims).toHaveLength(1);
  expect($(root, '.lock-banner.is-lost')).not.toBeNull();
  expect($<HTMLFieldSetElement>(root, '.form > fieldset')?.disabled).toBe(true);
  $<HTMLButtonElement>(root, '.lock-banner .btn-link')?.click();
  expect(reload).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
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

// The screen under the dialog is not inert, so the dialog must not claim a modal trap.
test('the take-over dialog claims no modal trap the screen does not have', async () => {
  vi.stubGlobal('fetch', heldBy());
  const root = show();
  await tick();
  flushSync();

  $<HTMLButtonElement>(root, '.lock-banner .btn-link')?.click();
  flushSync();
  const dialog = $(root, '[aria-labelledby="take-h"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.getAttribute('aria-modal')).toBeNull();
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
  const { flushNavigation } = await import('./navigate');
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
  const { flushNavigation } = await import('./navigate');
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
  const { flushNavigation } = await import('./navigate');
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
    const { flushNavigation } = await import('./navigate');
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
  expect($(root, '.crumbs a')?.getAttribute('href')).toBe('/admin/c/listings');
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
  flushSync();
  expect($(root, '.entry-body.has-pane .pane.is-locale')).not.toBeNull();
  $<HTMLButtonElement>(root, 'button.btn-sbs')?.click();
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

test('the outline reaches empty media, choice and grouped fields as well as text', () => {
  vi.stubGlobal('fetch', autosaved());
  const fields: Field[] = [
    ...entry.fields,
    { path: ['photo'], label: 'Photo', type: 'image', required: false, preset: { max: 2400 } },
    {
      path: ['brochure'],
      label: 'Brochure',
      type: 'file',
      required: false,
      accept: ['application/pdf'],
    },
    {
      path: ['category'],
      label: 'Category',
      type: 'select',
      required: false,
      options: ['home', 'office'],
    },
    { path: ['summary'], label: 'Summary', type: 'richtext', required: false, tier: 'basic' },
  ];
  const root = show({ entry: { ...entry, fields } });
  flushSync();
  const jump = (label: string, selector: string) => {
    $$<HTMLButtonElement>(root, '.editor-outline button')
      .find((b) => b.textContent === label)
      ?.click();
    expect(document.activeElement).toBe($(root, selector));
  };
  jump('Title', '#f-title');
  jump('Photo', '#f-photo-field .dropzone button');
  jump('Brochure', '#f-brochure-field .dropzone button');
  jump('Category', '#f-category-field input[type="radio"]');
  jump('Summary', '#f-summary-field [contenteditable="true"]');
  jump('Seo', '#f-seo-field input');
  const group = $<HTMLDetailsElement>(root, '#f-seo-field details');
  if (group) group.open = false;
  jump('Seo', '#f-seo-field summary');
  jump('Photos', '#f-photos-field');
  vi.unstubAllGlobals();
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
  $$<HTMLButtonElement>(root, '[aria-label="Editor view"] button')[2]?.click();
  flushSync();
  expect($(root, '.canvas-validation')?.textContent).toContain('1 field needs attention');
  expect($(root, '.canvas-validation')?.textContent).toContain('Required');
  $<HTMLButtonElement>(root, '.canvas-validation button')?.click();
  await vi.waitFor(() => expect(document.activeElement?.id).toBe('f-title'));
  expect($(root, '[aria-label="Editor view"] [aria-pressed="true"]')?.textContent).toBe('Form');
});
