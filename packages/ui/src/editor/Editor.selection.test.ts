import type { Field } from '@handover/core';
import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import type { CanvasSelection } from '../canvas/canvas-protocol';
import { $, autosaved, bilingual, settle, show, useEditorSetup } from './editor.fixture';
import type { EditorEntry } from './entry-payload';

useEditorSetup();
afterEach(() => vi.restoreAllMocks());

async function preview(entry: EditorEntry = bilingual, locale = 'en') {
  vi.stubGlobal('fetch', autosaved());
  let identity: Record<string, unknown> = {};
  let frame = document.createElement('iframe');
  const win = {
    location: { href: 'http://localhost/_preview' },
    postMessage: vi.fn(),
    scrollTo() {},
    scrollX: 0,
    scrollY: 0,
    innerWidth: 0,
    innerHeight: 0,
  } as unknown as Window;
  const doc = document.implementation.createHTMLDocument();
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(win);
  vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockReturnValue(doc);
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (
    this: HTMLFormElement,
  ) {
    const input = this.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('Missing preview snapshot');
    const snapshot = JSON.parse(input.value);
    const { protocol, requestId, epoch, entry, locale, contentVersion } = snapshot;
    identity = { protocol, requestId, epoch, entry, locale, contentVersion };
    const posted = document.querySelector<HTMLIFrameElement>(`iframe[name="${this.target}"]`);
    if (!posted) throw new Error('Missing preview frame');
    frame = posted;
    doc.body.innerHTML = `<script type="application/json" data-handover-canvas-manifest>${JSON.stringify({ ...identity, mode: 'canvas', status: 'success' })}</script>`;
  });
  const root = show({ entry: { ...entry, route: '/listings/[slug]' }, preview: true });
  flushSync();
  if (locale !== 'en') {
    $<HTMLButtonElement>(root, `.seg[aria-label="Language"] button:last-child`)?.click();
    flushSync();
  }
  await vi.waitFor(() => expect(frame.dataset.handoverCanvasFrame).toBe('candidate'));
  const post = (payload: Record<string, unknown>) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: location.origin,
        source: frame.contentWindow,
        data: { ...identity, ...payload },
      }),
    );
  frame.dispatchEvent(new Event('load'));
  post({ type: 'handover:canvas:ready' });
  await vi.waitFor(() => expect(frame.dataset.handoverCanvasFrame).toBe('active'));
  return {
    root,
    post,
    sent: vi.mocked(win.postMessage),
    frame: frame,
    select: (address: string, document = { collection: 'listings', id: 'seaview-cottage' }) => {
      const selection: CanvasSelection = { kind: 'field', target: { document, locale, address } };
      post({ type: 'handover:canvas:selection', selection });
    },
  };
}

test('preview selection opens every enclosing card and details before focusing the field', async () => {
  const nested = {
    ...bilingual,
    blocks: {
      hero: [
        {
          path: ['items'],
          label: 'Items',
          type: 'array',
          required: false,
          item: [
            {
              path: ['words'],
              label: 'Words',
              type: 'group',
              required: false,
              fields: [
                {
                  path: ['heading'],
                  label: 'Heading',
                  type: 'text',
                  required: false,
                  advanced: true,
                },
              ],
            },
          ],
        },
      ] satisfies Field[],
    },
    data: {
      ...bilingual.data,
      body: [
        {
          _id: 'k3nf9a2p',
          _type: 'hero',
          items: [{ _id: 'row00001', words: { heading: 'Deep words' } }],
        },
      ],
    },
  };
  const { root, select } = await preview(nested);
  select('body[_id=k3nf9a2p].items[_id=row00001].words.heading');
  await vi.waitFor(() => expect(document.activeElement?.id).toBe('f-body.0.items.0.words.heading'));
  expect(Array.from(root.querySelectorAll('details')).every((node) => node.open)).toBe(true);
  expect($(root, '.canvas-workspace.is-fullscreen')).toBeNull();
  expect($(root, '.canvas-form-surface.is-mobile-hidden')).toBeNull();
});

test('selecting a block opens its own card and focuses its first field', async () => {
  const { root, select } = await preview();
  select('body[_id=k3nf9a2p]');
  await vi.waitFor(() => expect(document.activeElement?.id).toBe('f-body.0.heading'));
  expect($(root, 'article.is-folded')).toBeNull();
});

test('selecting a group focuses its first field instead of the enclosing block', async () => {
  const grouped = {
    ...bilingual,
    blocks: {
      hero: [
        ...bilingual.blocks.hero,
        {
          path: ['primary'],
          label: 'Primary action',
          type: 'group',
          required: false,
          fields: [
            { path: ['label'], label: 'Label', type: 'text', required: false },
            { path: ['href'], label: 'URL', type: 'text', required: false },
          ],
        },
      ] satisfies Field[],
    },
    data: {
      ...bilingual.data,
      body: [{ ...bilingual.data.body[0], primary: { label: 'Explore', href: '/explore' } }],
    },
  };
  const { select } = await preview(grouped);
  select('body[_id=k3nf9a2p].primary');
  await vi.waitFor(() => expect(document.activeElement?.id).toBe('f-body.0.primary.label'));
});

test('preview selection focuses the current translation image description', async () => {
  const image = {
    path: ['picture'],
    label: 'Picture',
    type: 'image',
    required: false,
    preset: {},
  } satisfies Field;
  const opened = {
    ...bilingual,
    fields: [...bilingual.fields, image],
    translations: {
      de: { ...bilingual.translations.de, picture: { src: 'picture.webp', alt: 'Bild' } },
    },
  };
  const { select } = await preview(opened, 'de');
  select('picture.src');
  await vi.waitFor(() => expect(document.activeElement?.id).toBe('t-picture.alt'));
});

test('preview selection from another document leaves the form focus in place', async () => {
  const { root, select } = await preview();
  $<HTMLInputElement>(root, '#f-price')?.focus();
  expect(document.activeElement?.id).toBe('f-price');
  select('title', { collection: 'globals', id: 'header' });
  await settle();
  expect(document.activeElement?.id).toBe('f-price');
});

test('opening a form block selects and scrolls its preview annotation', async () => {
  const { root, post, sent } = await preview();
  const target = {
    document: { collection: 'listings', id: 'seaview-cottage' },
    locale: 'en',
    address: 'body[_id=k3nf9a2p]',
  };
  post({
    type: 'handover:canvas:structure',
    nodes: [
      {
        kind: 'block',
        target,
        id: 'hero',
        label: 'Hero',
        depth: 1,
        position: 1,
        setSize: 1,
        occurrences: 1,
      },
    ],
  });
  flushSync();
  await vi.waitFor(() => expect(root.querySelector('fieldset[disabled]')).toBeNull());
  sent.mockClear();
  $<HTMLButtonElement>(root, 'article > header button.fold')?.click();
  flushSync();
  expect(sent.mock.calls.map(([message]) => message)).toContainEqual(
    expect.objectContaining({
      type: 'handover:canvas:select',
      selection: expect.objectContaining({ kind: 'block', target }),
    }),
  );
});
