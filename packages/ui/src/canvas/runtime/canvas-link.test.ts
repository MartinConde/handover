import { afterEach, expect, test, vi } from 'vitest';
import type {
  CanvasAcknowledgement,
  CanvasFieldMutation,
  CanvasTarget,
} from '../canvas-bridge';
import { createCanvasLinkRuntime } from './canvas-link';

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
