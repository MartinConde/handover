import type { Drift, Field } from '@handover/core';
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
  pending: false,
  problems: [] as { path: string; message: string }[],
  locales: ['en'],
  drift: [] as Drift[],
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
      onresolved: () => {},
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
const autosaved = () =>
  vi.fn(async () => Response.json({ updated_at: 1755864000000, pending: true, problems: [] }));

const withProblems = (problems: { path: string; message: string }[]) => {
  app = mount(Editor, {
    target: document.body,
    props: {
      collection: 'listings',
      slug: 'seaview-cottage',
      entry: { ...entry, pending: true, problems },
      onpublish: opened,
      onresolved: () => {},
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
      pending: false,
      problems: [],
      titleField: 'name',
      locales: ['en'],
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
  expect(fetchMock).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(500);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('opening an entry and changing nothing writes no draft', async () => {
  vi.useFakeTimers();
  const fetchMock = autosaved();
  vi.stubGlobal('fetch', fetchMock);
  show();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetchMock).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('a draft that is ahead of the published file can be published on load', () => {
  app = mount(Editor, {
    target: document.body,
    props: {
      collection: 'listings',
      slug: 'seaview-cottage',
      entry: { ...entry, pending: true },
      onpublish: opened,
      onresolved: () => {},
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
      drift: [{ path: 'blocks[_id=z9y8x7w6]', type: 'quote', in: ['de'], expected: ['en', 'de'] }],
      locales: ['en', 'de'],
    },
  });

  expect($(root, '.lock-banner.is-drift')).not.toBe(null);
  expect($(root, '.drift .block-card')).not.toBe(null);
  expect($(root, 'form.form')).toBe(null);
  expect($<HTMLButtonElement>(root, 'header button.btn-primary')?.disabled).toBe(true);
});
