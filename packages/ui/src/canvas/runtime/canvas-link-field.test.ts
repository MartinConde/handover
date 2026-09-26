import { afterEach, expect, test, vi } from 'vitest';
import type { CanvasAcknowledgement, CanvasFieldMutation, CanvasTarget } from '../canvas-bridge';
import { createCanvasLinkRuntime } from './canvas-link-field';
import { createCanvasUiLocaleState } from './canvas-ui-locale';

const target: CanvasTarget = {
  document: { collection: 'pages', id: 'home' },
  locale: 'en',
  address: 'button',
};

const reply = (version: number): CanvasAcknowledgement => ({
  type: 'handover:canvas:ack',
  protocol: 1,
  requestId: 'render-1',
  epoch: 'session-1',
  entry: target.document,
  locale: target.locale,
  contentVersion: version - 1,
  commandId: `command-${version}`,
  target,
  ok: true,
  acceptedVersion: version,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.innerHTML = '<head></head><body></body>';
});

test('edits a schema link as one destination, label, and window-target command', async () => {
  const fetcher = vi.fn(async () => Response.json({ entries: [], indexes: [], locales: ['en'] }));
  vi.stubGlobal('fetch', fetcher);
  document.body.innerHTML = '<a href="https://example.com/book">Book a viewing</a>';
  const anchor = document.querySelector('a');
  if (!anchor) throw new Error('link fixture missing');
  const commands: CanvasFieldMutation[] = [];
  const interaction = vi.fn();
  const runtime = createCanvasLinkRuntime({
    command: async (_target, command) => {
      commands.push(command);
      return reply(1);
    },
    interaction,
  });
  runtime.configure({
    kind: 'link',
    target,
    value: {
      type: 'url',
      ref: '',
      href: 'https://example.com/book',
      label: 'Book a viewing',
      newTab: false,
    },
  });

  expect(runtime.activate({ kind: 'field', target }, anchor)).toBe(true);
  const dialog = document.querySelector<HTMLElement>('[data-handover-canvas-link-editor]');
  const label = dialog?.querySelector<HTMLInputElement>('#handover-canvas-link-label');
  const address = dialog?.querySelector<HTMLInputElement>('#handover-canvas-link-url');
  const newTab = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!dialog || !label || !address || !newTab) throw new Error('link editor controls missing');
  label.value = 'Book by phone';
  label.dispatchEvent(new InputEvent('input', { bubbles: true }));
  address.value = 'https://example.com/phone';
  address.dispatchEvent(new InputEvent('input', { bubbles: true }));
  newTab.click();
  dialog.querySelector<HTMLButtonElement>('[data-link-apply]')?.click();

  await vi.waitFor(() => expect(commands).toHaveLength(1));
  expect(commands[0]).toEqual({
    type: 'field',
    changes: [
      { path: ['type'], value: 'url' },
      { path: ['ref'], value: undefined },
      { path: ['href'], value: 'https://example.com/phone' },
      { path: ['label'], value: 'Book by phone' },
      { path: ['newTab'], value: true },
    ],
  });
  await vi.waitFor(() => expect(dialog.hidden).toBe(true));
  expect(anchor.textContent).toBe('Book by phone');
  expect(interaction).toHaveBeenNthCalledWith(1, target, {
    inlineEditing: true,
    composing: false,
  });
  expect(interaction).toHaveBeenLastCalledWith(target, {
    inlineEditing: false,
    composing: false,
  });
  expect(fetcher).not.toHaveBeenCalled();
  runtime.dispose();
});

test('translates an open editor without replacing its focused draft controls', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ entries: [], indexes: [], locales: ['en'] })),
  );
  document.body.innerHTML = '<a href="/contact">Contact</a>';
  const anchor = document.querySelector('a');
  if (!anchor) throw new Error('link fixture missing');
  const uiLocale = createCanvasUiLocaleState('en');
  const runtime = createCanvasLinkRuntime({
    command: vi.fn(),
    interaction: vi.fn(),
    uiLocale,
  });
  runtime.configure({
    kind: 'link',
    target,
    value: { type: 'url', ref: '', href: '/contact', label: 'Contact', newTab: false },
  });
  runtime.activate({ kind: 'field', target }, anchor);
  const dialog = document.querySelector<HTMLElement>('[data-handover-canvas-link-editor]');
  const label = dialog?.querySelector<HTMLInputElement>('#handover-canvas-link-label');
  if (!dialog || !label) throw new Error('link editor controls missing');
  label.value = 'Geschriebener Entwurf';
  label.dispatchEvent(new InputEvent('input', { bubbles: true }));
  label.focus();

  uiLocale.set('de');

  expect(document.querySelector('#handover-canvas-link-label')).toBe(label);
  expect(dialog.lang).toBe('de');
  expect(document.activeElement).toBe(label);
  expect(label.value).toBe('Geschriebener Entwurf');
  expect(dialog.getAttribute('aria-label')).toBe('Link bearbeiten');
  expect(dialog.querySelector('[data-link-close]')?.textContent).toBe('Linkeditor schließen');
  expect(dialog.querySelector('[data-link-apply]')?.textContent).toBe('Anwenden');
  expect(dialog.textContent).toContain('In neuem Tab öffnen');
  runtime.dispose();
});

test('reformats an already-visible link refusal in the latest interface language', async () => {
  document.body.innerHTML = '<a href="/contact">Contact</a>';
  const anchor = document.querySelector('a');
  if (!anchor) throw new Error('link fixture missing');
  const uiLocale = createCanvasUiLocaleState('en');
  const runtime = createCanvasLinkRuntime({
    command: async () => ({
      ...reply(1),
      ok: false,
      acceptedVersion: undefined,
      reason: 'readonly',
    }),
    interaction: vi.fn(),
    uiLocale,
  });
  runtime.configure({
    kind: 'link',
    target,
    value: { type: 'url', ref: '', href: '/contact', label: 'Contact', newTab: false },
  });
  runtime.activate({ kind: 'field', target }, anchor);
  const dialog = document.querySelector<HTMLElement>('[data-handover-canvas-link-editor]');
  if (!dialog) throw new Error('link editor missing');
  dialog.querySelector<HTMLButtonElement>('[data-link-apply]')?.click();
  await vi.waitFor(() =>
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(
      'This link could not be updated (readonly).',
    ),
  );

  uiLocale.set('de');

  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(
    'Dieser Link konnte nicht aktualisiert werden (readonly).',
  );
  runtime.dispose();
});

test('applying a new label preserves icon markup inside the link', async () => {
  document.body.innerHTML =
    '<a href="https://example.com/book">\n  <svg data-icon></svg>\n  <span>Book a viewing</span>\n</a>';
  const anchor = document.querySelector('a');
  const iconElement = document.querySelector('svg');
  if (!anchor || !iconElement) throw new Error('link fixture missing');
  const runtime = createCanvasLinkRuntime({
    command: async () => reply(1),
    interaction: vi.fn(),
  });
  runtime.configure({
    kind: 'link',
    target,
    value: {
      type: 'url',
      ref: '',
      href: 'https://example.com/book',
      label: 'Book a viewing',
      newTab: false,
    },
  });
  runtime.activate({ kind: 'field', target }, anchor);
  const dialog = document.querySelector<HTMLElement>('[data-handover-canvas-link-editor]');
  const label = dialog?.querySelector<HTMLInputElement>('#handover-canvas-link-label');
  if (!dialog || !label) throw new Error('link editor controls missing');
  label.value = 'Book by phone';
  label.dispatchEvent(new InputEvent('input', { bubbles: true }));
  dialog.querySelector<HTMLButtonElement>('[data-link-apply]')?.click();

  await vi.waitFor(() => expect(anchor.querySelector('span')?.textContent).toBe('Book by phone'));
  expect(anchor.textContent?.trim()).toBe('Book by phone');
  expect(anchor.firstElementChild).toBe(iconElement);
  runtime.dispose();
});

test('uses the same editor to choose a page or entry destination', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        entries: [
          {
            collection: 'pages',
            path: 'pages/contact',
            title: 'Contact',
            locales: ['en'],
            urls: { en: '/contact' },
          },
        ],
        indexes: [],
        locales: ['en'],
      }),
    ),
  );
  document.body.innerHTML = '<a href="https://example.com/book">Book a viewing</a>';
  const anchor = document.querySelector('a');
  if (!anchor) throw new Error('link fixture missing');
  const command = vi.fn(async () => reply(1));
  const runtime = createCanvasLinkRuntime({ command, interaction: vi.fn() });
  runtime.configure({
    kind: 'link',
    target,
    value: {
      type: 'url',
      ref: '',
      href: 'https://example.com/book',
      label: 'Book a viewing',
      newTab: false,
    },
  });
  runtime.activate({ kind: 'field', target }, anchor);
  const dialog = document.querySelector<HTMLElement>('[data-handover-canvas-link-editor]');
  if (!dialog) throw new Error('link editor missing');
  Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent === 'Page / Entry')
    ?.click();
  await vi.waitFor(() =>
    expect(dialog.querySelector<HTMLButtonElement>('[role="option"]')?.textContent).toContain(
      'Contact',
    ),
  );
  dialog.querySelector<HTMLButtonElement>('[role="option"]')?.click();
  dialog.querySelector<HTMLButtonElement>('[data-link-apply]')?.click();

  await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  expect(command).toHaveBeenCalledWith(target, {
    type: 'field',
    changes: [
      { path: ['type'], value: 'entry' },
      { path: ['ref'], value: 'pages/contact' },
      { path: ['href'], value: undefined },
      { path: ['label'], value: 'Book a viewing' },
      { path: ['newTab'], value: undefined },
    ],
  });
  runtime.dispose();
});

test('marks the link in the page for exactly as long as its editor is open', () => {
  document.body.innerHTML = '<a href="/contact">Contact</a>';
  const anchor = document.querySelector('a');
  if (!anchor) throw new Error('link fixture missing');
  const marked: boolean[] = [];
  const runtime = createCanvasLinkRuntime({
    command: vi.fn(),
    interaction: () => marked.push(anchor.hasAttribute('data-handover-link-editing')),
  });
  runtime.configure({
    kind: 'link',
    target,
    value: { type: 'url', ref: '', href: '/contact', label: 'Contact', newTab: false },
  });

  runtime.activate({ kind: 'field', target }, anchor);
  document.querySelector<HTMLButtonElement>('[data-link-close]')?.click();

  expect(marked).toEqual([true, false]);
  expect(anchor.hasAttribute('data-handover-link-editing')).toBe(false);
  runtime.dispose();
});
