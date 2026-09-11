import type { Field } from '@handover/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import CanvasBlockEditor, { canvasBlockDraft } from './CanvasBlockEditor.svelte';

const blocks = {
  hero: [
    { path: ['heading'], label: 'Heading', type: 'text', required: true },
    { path: ['eyebrow'], label: 'Eyebrow', type: 'text', required: false },
  ],
  quote: [{ path: ['quote'], label: 'Quote', type: 'text', required: true }],
  hidden: [{ path: ['label'], label: 'Label', type: 'text', required: false }],
} satisfies Record<string, Field[]>;

let app: ReturnType<typeof mount>;
const show = (over: Record<string, unknown> = {}) => {
  const onapply = vi.fn((_value: Record<string, unknown>) => ({
    ok: true as const,
    contentVersion: 1,
  }));
  const onclose = vi.fn();
  app = mount(CanvasBlockEditor, {
    target: document.body,
    props: {
      mode: 'insert',
      types: ['hero', 'quote'],
      blocks,
      locale: 'en',
      onapply,
      onclose,
      ...over,
    },
  });
  flushSync();
  return { root: document.body, onapply, onclose };
};

afterEach(() => {
  unmount(app);
  document.body.innerHTML = '';
});

test('replacement offers only destination types and waits for required fields before one Apply', () => {
  expect(
    canvasBlockDraft('settings', 'settings1', [
      { path: ['enabled'], label: 'Enabled', type: 'boolean', required: true },
      { path: ['items'], label: 'Items', type: 'array', required: true, item: [] },
    ]),
  ).toEqual({ _type: 'settings', _id: 'settings1', enabled: false, items: [] });
  const { root, onapply, onclose } = show({ mode: 'replace' });
  const types = Array.from(root.querySelectorAll<HTMLButtonElement>('.type-card'));
  expect(types.map((button) => button.textContent?.trim().split(/\s+/)[0])).toEqual([
    'hero',
    'quote',
  ]);
  expect(root.textContent).not.toContain('hidden');

  types[0]?.click();
  flushSync();
  const apply = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === 'Apply',
  );
  expect(apply?.disabled).toBe(true);
  expect(root.textContent).toContain('Complete the required fields');

  const heading = root.querySelector<HTMLInputElement>('input[id$="heading"]');
  if (!heading) throw new Error('Heading field missing');
  heading.value = 'A configured hero';
  heading.dispatchEvent(new InputEvent('input', { bubbles: true }));
  flushSync();
  expect(apply?.disabled).toBe(false);
  apply?.click();

  expect(onapply).toHaveBeenCalledOnce();
  expect(onapply).toHaveBeenCalledWith(
    expect.objectContaining({
      _type: 'hero',
      _id: expect.any(String),
      heading: 'A configured hero',
    }),
  );
  expect(onclose).toHaveBeenCalledOnce();
});

test('Cancel discards a configured replacement without calling the structural command', () => {
  const { root, onapply, onclose } = show({ mode: 'replace' });
  root.querySelector<HTMLButtonElement>('.type-card')?.click();
  flushSync();
  const heading = root.querySelector<HTMLInputElement>('input[id$="heading"]');
  if (!heading) throw new Error('Heading field missing');
  heading.value = 'Never inserted';
  heading.dispatchEvent(new InputEvent('input', { bubbles: true }));
  flushSync();
  Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.trim() === 'Cancel')
    ?.click();

  expect(onapply).not.toHaveBeenCalled();
  expect(onclose).toHaveBeenCalledOnce();
});

test('offers an explicit path back to Structure', () => {
  const { root, onclose } = show();
  root.querySelector<HTMLButtonElement>('button[aria-label="Back to Structure"]')?.click();
  expect(onclose).toHaveBeenCalledOnce();
});

test('insertion creates a draft immediately so its fields can be completed in Inspector', () => {
  const { root, onapply, onclose } = show({ mode: 'insert' });
  root.querySelector<HTMLButtonElement>('.type-card')?.click();

  expect(onapply).toHaveBeenCalledWith(
    expect.objectContaining({ _type: 'hero', _id: expect.any(String) }),
  );
  expect(onapply.mock.calls[0]?.[0]).not.toHaveProperty('heading');
  expect(onclose).toHaveBeenCalledWith('applied');
});

test('replacement starts a fresh allowed type instead of converting the old block', () => {
  const { root, onapply } = show({ mode: 'replace', currentType: 'hero' });
  expect(root.textContent).toContain('Fields are not converted between block types.');
  Array.from(root.querySelectorAll<HTMLButtonElement>('.type-card'))
    .find((button) => button.textContent?.includes('quote'))
    ?.click();
  flushSync();
  const quote = root.querySelector<HTMLInputElement>('input[id$="quote"]');
  if (!quote) throw new Error('Quote field missing');
  quote.value = 'Fresh words';
  quote.dispatchEvent(new InputEvent('input', { bubbles: true }));
  flushSync();
  Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.trim() === 'Apply')
    ?.click();

  expect(onapply).toHaveBeenCalledWith(
    expect.objectContaining({ _type: 'quote', _id: expect.any(String), quote: 'Fresh words' }),
  );
  expect(onapply.mock.calls[0]?.[0]).not.toHaveProperty('heading');
});
