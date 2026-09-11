import type { Field } from '@handover/core';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import CanvasInspector from './CanvasInspector.svelte';
import type { CanvasSelection } from './canvas-bridge';
import { createEntrySession } from './entry-session.svelte';

const fields = [
  {
    path: ['hero'],
    label: 'Hero image',
    type: 'image',
    required: false,
    preset: { ratio: '3:2', max: 2400 },
  },
  { path: ['button'], label: 'Button', type: 'link', required: false },
] satisfies Field[];

const data = () => ({
  hero: {
    src: 'hero.webp',
    width: 1200,
    height: 800,
    alt: 'Harbour at dusk',
  },
  button: { type: 'url', href: 'https://example.com', label: 'Book now' },
});

const target = (address: string, locale = 'en'): CanvasSelection => ({
  kind: 'field',
  target: { document: { collection: 'pages', id: 'home' }, locale, address },
});

let app: ReturnType<typeof mount>;
const show = (selection: CanvasSelection, over: Record<string, unknown> = {}) => {
  const session = createEntrySession({
    document: 'pages/home',
    sourceLocale: 'en',
    data: data(),
    translations: { de: data() },
    form: { fields, blocks: {} },
  });
  const onschedule = vi.fn();
  app = mount(CanvasInspector, {
    target: document.body,
    props: {
      selection,
      entryDocument: { collection: 'pages', id: 'home' },
      ownerLabel: 'Home',
      locale: selection.target.locale,
      sourceLocale: 'en',
      session,
      blocks: {},
      onschedule,
      onclose: () => {},
      onform: () => {},
      ...over,
    },
  });
  flushSync();
  return { root: document.body, session, onschedule };
};

afterEach(() => {
  unmount(app);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

test('reuses the complete image widget and schedules its accepted media action', async () => {
  const { root, session, onschedule } = show(target('hero.alt'));

  expect(root.querySelector('.canvas-inspector .media-card')).not.toBeNull();
  expect(root.querySelector<HTMLInputElement>('input[id$="hero.alt"]')?.value).toBe(
    'Harbour at dusk',
  );
  const remove = Array.from(
    root.querySelectorAll<HTMLButtonElement>('.canvas-inspector button'),
  ).find((button) => button.textContent === 'Remove');
  remove?.click();
  await tick();

  expect(session.snapshot('en').hero).toBeUndefined();
  expect(onschedule).toHaveBeenCalledOnce();
});

test('keeps a link type switch as one existing multi-property widget action', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ entries: [], locales: ['en', 'de'] })),
  );
  const { root, session, onschedule } = show(target('button.href'));
  const entryType = root.querySelector<HTMLButtonElement>('[aria-label="Link type"] button');
  entryType?.click();
  await tick();

  expect(session.snapshot('en').button).toEqual({ type: 'entry', label: 'Book now' });
  expect(onschedule).toHaveBeenCalledOnce();
});

test('keeps translated image and link ownership restrictions from the existing widgets', () => {
  const first = show(target('hero', 'de'));
  expect(first.root.querySelector('.canvas-inspector')?.textContent).toContain(
    'The picture is the same in every language.',
  );
  expect(first.root.querySelector('.canvas-inspector')?.textContent).not.toContain('Replace');
  const alt = first.root.querySelector<HTMLInputElement>('input[id$="hero.alt"]');
  if (!alt) throw new Error('translated alt input missing');
  alt.value = 'Hafen bei Abendlicht';
  alt.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect((first.session.snapshot('de').hero as Record<string, unknown>).alt).toBe(
    'Hafen bei Abendlicht',
  );
  expect((first.session.snapshot('en').hero as Record<string, unknown>).alt).toBe(
    'Harbour at dusk',
  );

  unmount(app);
  document.body.innerHTML = '';
  const second = show(target('button', 'de'));
  expect(second.root.querySelector('[aria-label="Link type"]')).toBeNull();
  const label = second.root.querySelector<HTMLInputElement>('input[id$="button.label"]');
  if (!label) throw new Error('translated link label input missing');
  label.value = 'Jetzt buchen';
  label.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect(second.session.snapshot('de').button).toEqual({
    type: 'url',
    href: 'https://example.com',
    label: 'Jetzt buchen',
  });
});

test('opens shared content in its owning editor instead of borrowing the page session', () => {
  const shared: CanvasSelection = {
    kind: 'field',
    target: {
      document: { collection: 'globals', id: 'shared-promo' },
      locale: 'en',
      address: 'heading',
      occurrence: {
        document: { collection: 'pages', id: 'home' },
        locale: 'en',
        address: 'blocks[_id=promo001].heading',
      },
    },
  };
  const { root } = show(shared);
  const link = root.querySelector<HTMLAnchorElement>('.canvas-inspector a');

  expect(root.querySelector('.canvas-inspector')?.textContent).toContain('Edit shared content');
  expect(link?.textContent).toContain('Edit shared content');
  expect(link?.getAttribute('href')).toBe('/admin/site/shared-promo?field=heading&locale=en');
  expect(root.querySelector('.canvas-inspector input')).toBeNull();
});

test('sends a derived structural selection to its owning Form field', () => {
  const onform = vi.fn();
  const selection: CanvasSelection = {
    kind: 'block',
    target: {
      document: { collection: 'pages', id: 'home' },
      locale: 'en',
      address: 'blocks[_id=hero01]',
    },
  };
  const { root } = show(selection, { onform });
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((item) =>
    item.textContent?.includes('Edit in Form'),
  );
  button?.click();

  expect(onform).toHaveBeenCalledWith(selection.target);
});

test('disables every reused widget when the entry lock is lost', () => {
  const { root } = show(target('button'), { locked: true });
  const fieldset = root.querySelector<HTMLFieldSetElement>('.canvas-inspector fieldset');

  expect(fieldset?.disabled).toBe(true);
  expect(
    root.querySelector<HTMLInputElement>('input[id$="button.label"]')?.matches(':disabled'),
  ).toBe(true);
  expect(root.querySelector('.canvas-inspector')?.textContent).toContain(
    'Editing is disabled because this entry is locked.',
  );
});
