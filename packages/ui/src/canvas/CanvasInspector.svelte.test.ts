import type { Field } from '@handover/core';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import CanvasInspector from './CanvasInspector.svelte';
import type { CanvasSelection } from './canvas-bridge';
import { createEntrySession } from '../editor/entry-session.svelte';

const fields = [
  {
    path: ['hero'],
    label: 'Hero image',
    type: 'image',
    required: false,
    preset: { ratio: '3:2', max: 2400 },
  },
  { path: ['button'], label: 'Button', type: 'link', required: false },
  { path: ['body'], label: 'Body', type: 'richtext', required: false, tier: 'basic' },
] satisfies Field[];

const data = () => ({
  hero: {
    src: 'hero.webp',
    width: 1200,
    height: 800,
    alt: 'Harbour at dusk',
  },
  button: { type: 'url', href: 'https://example.com', label: 'Book now' },
  body: 'Book a [viewing](https://example.com).',
});

const target = (address: string, locale = 'en'): CanvasSelection => ({
  kind: 'field',
  target: { document: { collection: 'pages', id: 'home' }, locale, address },
});

let app: ReturnType<typeof mount>;
const showFixture = ({
  selection,
  schemaFields = fields,
  schemaBlocks = {},
  entryData = data(),
  over = {},
}: {
  selection: CanvasSelection;
  schemaFields?: Field[];
  schemaBlocks?: Record<string, Field[]>;
  entryData?: Record<string, unknown>;
  over?: Record<string, unknown>;
}) => {
  const session = createEntrySession({
    document: 'pages/home',
    sourceLocale: 'en',
    data: entryData,
    translations: { de: structuredClone(entryData) },
    form: { fields: schemaFields, blocks: schemaBlocks },
  });
  const onschedule = vi.fn();
  const props = $state({
    selection,
    entryDocument: { collection: 'pages', id: 'home' },
    ownerLabel: 'Home',
    locale: selection.target.locale,
    sourceLocale: 'en',
    session,
    blocks: schemaBlocks,
    onschedule,
    onclose: () => {},
    ...over,
  });
  app = mount(CanvasInspector, {
    target: document.body,
    props,
  });
  flushSync();
  return { root: document.body, session, onschedule, props };
};
const show = (selection: CanvasSelection, over: Record<string, unknown> = {}) =>
  showFixture({ selection, over });

const inspectedFields: Field[] = [
  {
    path: ['blocks'],
    label: 'Blocks',
    type: 'blocks',
    required: true,
    types: ['basic', 'full'],
  },
];
const inspectedBlocks = {
  basic: [
    { path: ['body'], label: 'Body', type: 'richtext', required: false, tier: 'basic' },
  ],
  full: [
    { path: ['body'], label: 'Body', type: 'richtext', required: false, tier: 'full' },
  ],
} satisfies Record<string, Field[]>;
const inspectedData = (basic = 'Plain basic copy', full = '## Full heading') => ({
  blocks: [
    { _id: 'first', _type: 'basic', body: basic },
    { _id: 'second', _type: 'full', body: full },
  ],
});

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
  expect(onschedule).toHaveBeenCalledWith('discrete');
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
  expect(onschedule).toHaveBeenCalledWith('discrete');
});

test('classifies text input as continuous and ignores an unchanged input event', async () => {
  const { root, onschedule } = show(target('hero.alt'));
  const alt = root.querySelector<HTMLInputElement>('input[id$="hero.alt"]');
  if (!alt) throw new Error('alt input missing');

  alt.value = 'Harbour after sunset';
  alt.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  expect(onschedule).toHaveBeenCalledWith('continuous');

  onschedule.mockClear();
  alt.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  expect(onschedule).not.toHaveBeenCalled();
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

test('a selected block exposes all of its fields without sending the editor back to Form', () => {
  const selection: CanvasSelection = {
    kind: 'block',
    target: {
      document: { collection: 'pages', id: 'home' },
      locale: 'en',
      address: 'blocks[_id=hero01]',
    },
  };
  const { root } = show(selection, {
    blockInspection: {
      fields: [{ path: ['heading'], label: 'Heading', type: 'text', required: true }],
      path: ['blocks', '0'],
      type: 'cta',
    },
  });

  expect(root.querySelector('input[id$="heading"]')).not.toBeNull();
  expect(root.textContent).not.toContain('Edit in Form');
});

test('rich text is immediately available in Inspector without disclosure or Form detours', () => {
  const { root } = show(target('body'));

  expect(root.querySelector('.canvas-field-details')).toBeNull();
  expect(root.querySelector('[contenteditable="true"]')).not.toBeNull();
  expect(root.textContent).not.toContain('Open in form');
  expect(root.textContent).not.toContain('Edit in Inspector');
});

test('switching inspected rich-text fields rebuilds each field with its own tier', () => {
  const { root, props } = showFixture({
    selection: target('blocks[_id=first].body'),
    schemaFields: inspectedFields,
    schemaBlocks: inspectedBlocks,
    entryData: inspectedData(),
  });

  expect(root.querySelector('[contenteditable="true"]')).not.toBeNull();
  expect(root.querySelector('[aria-label="Heading 2"]')).toBeNull();

  props.selection = target('blocks[_id=second].body');
  flushSync();
  expect(root.querySelector('[contenteditable="true"]')).not.toBeNull();
  expect(root.querySelector('[aria-label="Heading 2"]')).not.toBeNull();

  props.selection = target('blocks[_id=first].body');
  flushSync();
  expect(root.querySelector('[aria-label="Heading 2"]')).toBeNull();
});

test('switching fields recalculates whether their Markdown is supported', () => {
  const { root, props } = showFixture({
    selection: target('blocks[_id=first].body'),
    schemaFields: inspectedFields,
    schemaBlocks: inspectedBlocks,
    entryData: inspectedData('## Unsupported basic heading', '## Supported full heading'),
  });

  expect(root.querySelector('[contenteditable="true"]')).toBeNull();
  expect(root.textContent).toContain('uses formatting the editor can’t change');

  props.selection = target('blocks[_id=second].body');
  flushSync();
  expect(root.querySelector('[contenteditable="true"]')).not.toBeNull();
  expect(root.textContent).not.toContain('uses formatting the editor can’t change');

  props.selection = target('blocks[_id=first].body');
  flushSync();
  expect(root.querySelector('[contenteditable="true"]')).toBeNull();
});

test('picker state does not follow the Inspector to another rich-text field', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ entries: [], locales: ['en'] })),
  );
  const { root, props } = showFixture({
    selection: target('blocks[_id=first].body'),
    schemaFields: inspectedFields,
    schemaBlocks: inspectedBlocks,
    entryData: inspectedData(),
  });
  root.querySelector<HTMLButtonElement>('[aria-label="Link"]')?.click();
  flushSync();
  expect(root.querySelector('.picker')).not.toBeNull();

  props.selection = target('blocks[_id=second].body');
  flushSync();
  expect(root.querySelector('.picker')).toBeNull();
});

test('editing one inspected field keeps its editor instance mounted', () => {
  const { root, session } = showFixture({
    selection: target('blocks[_id=first].body'),
    schemaFields: inspectedFields,
    schemaBlocks: inspectedBlocks,
    entryData: inspectedData(),
  });
  const editor = root.querySelector('[contenteditable="true"]');

  expect(
    session.fieldCommand('en', {
      address: 'blocks[_id=first].body',
      contentVersion: session.contentVersion('en'),
      changes: [{ path: [], value: 'Updated basic copy' }],
    }),
  ).toMatchObject({ ok: true });
  flushSync();

  expect(root.querySelector('[contenteditable="true"]')).toBe(editor);
});

test('an on-canvas image action opens the media library without a second inspector click', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ items: [] })),
  );
  const { root } = show(target('hero'), { mediaPickerRequest: 1 });
  await tick();
  flushSync();

  expect(root.querySelector('[role="dialog"][aria-labelledby="picker-h"]')).not.toBeNull();
  expect(root.querySelector('#picker-h')?.textContent).toContain(
    'Choose an image for “Hero image”',
  );
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
