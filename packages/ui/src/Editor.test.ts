import type { Field } from '@handover/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import Editor from './Editor.svelte';

const entry = {
  fields: [
    { path: ['title'], type: 'text', required: true },
    {
      path: ['seo'],
      type: 'group',
      required: false,
      fields: [{ path: ['description'], type: 'text', required: false }],
    },
    { path: ['photos'], type: 'unsupported' },
  ] satisfies Field[],
  blocks: {},
  data: { title: 'Seaview Cottage', seo: { description: 'Harbour view' }, photos: [] },
  head_sha: 'head789',
};

let app: ReturnType<typeof mount>;
const show = () => {
  app = mount(Editor, {
    target: document.body,
    props: { collection: 'listings', slug: 'seaview-cottage', entry },
  });
  return document.body;
};
afterEach(() => unmount(app));

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

test('the header shows the entry title; Publish is disabled until something changes', () => {
  const root = show();
  expect($(root, 'h1')?.textContent).toBe('Seaview Cottage');
  const publish = $<HTMLButtonElement>(root, 'button.btn-primary');
  expect(publish?.textContent).toBe('Publish this entry');
  expect(publish?.disabled).toBe(true);
  type(root, 'input#f-title', 'Seaview House');
  expect(publish?.disabled).toBe(false);
});

test('Publish saves the edited data against the loaded head and reports the commit', async () => {
  const fetchMock = vi.fn(async () => Response.json({ commit_sha: 'def4567890' }));
  vi.stubGlobal('fetch', fetchMock);
  const root = show();
  type(root, 'input#f-title', 'Seaview House');
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  flushSync();
  expect($(root, '.autosave')?.textContent).toBe('Publishing…');
  await tick();
  flushSync();
  expect(fetchMock).toHaveBeenCalledWith('/admin/api/entries/listings/seaview-cottage', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      data: { title: 'Seaview House', seo: { description: 'Harbour view' }, photos: [] },
      base_sha: 'head789',
    }),
  });
  expect($(root, '.autosave')?.textContent).toBe('Published def4567');
  expect($<HTMLButtonElement>(root, 'button.btn-primary')?.disabled).toBe(true);
  vi.unstubAllGlobals();
});

test('a 409 tells the editor someone else published first', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('moved', { status: 409 })),
  );
  const root = show();
  type(root, 'input#f-title', 'Seaview House');
  $<HTMLButtonElement>(root, 'button.btn-primary')?.click();
  await tick();
  flushSync();
  expect($(root, '[role="alert"]')?.textContent).toBe(
    'Someone else published this entry since you opened it. Reload to see their version.',
  );
  expect($<HTMLButtonElement>(root, 'button.btn-primary')?.disabled).toBe(false);
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
