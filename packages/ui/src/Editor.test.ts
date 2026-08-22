import type { Field } from '@handover/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';
import Editor from './Editor.svelte';

const entry = {
  fields: [
    { path: ['title'], type: 'text', required: true },
    { path: ['seo', 'description'], type: 'text', required: false },
    { path: ['photos'], type: 'unsupported' },
  ] satisfies Field[],
  data: { title: 'Seaview Cottage', seo: { description: 'Harbour view' }, photos: [] },
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
  expect($(root, 'label[for="f-seo.description"]')?.textContent).toBe('Seo · Description');
  expect($<HTMLInputElement>(root, 'input#f-seo\\.description')?.value).toBe('Harbour view');
});

test('an unsupported field shows a marker instead of an input', () => {
  const root = show();
  expect($(root, 'input#f-photos')).toBeNull();
  expect($(root, 'label[for="f-photos"]')?.textContent).toBe('Photos');
  expect($(root, '#f-photos')?.textContent).toBe('Not editable here yet');
});

test('the header shows the entry title and a disabled Publish button', () => {
  const root = show();
  expect($(root, 'h1')?.textContent).toBe('Seaview Cottage');
  const publish = $<HTMLButtonElement>(root, 'button.btn-primary');
  expect(publish?.textContent).toBe('Publish this entry');
  expect(publish?.disabled).toBe(true);
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
