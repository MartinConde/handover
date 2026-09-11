import { afterEach, expect, test, vi } from 'vitest';
import type {
  CanvasAcknowledgement,
  CanvasMutation,
  CanvasSelection,
  CanvasTarget,
} from './canvas-bridge';
import { createCanvasRichTextRuntime } from './canvas-rich-text';

const target: CanvasTarget = {
  document: { collection: 'pages', id: 'home' },
  locale: 'en',
  address: 'summary',
};
const selected: CanvasSelection = { kind: 'field', target };

const reply = (
  version: number,
  result: {
    ok: true;
    update?: {
      value: string;
      selection?: { kind?: 'node' | 'text'; anchor: number; head: number };
    };
  },
): CanvasAcknowledgement => ({
  type: 'handover:canvas:ack',
  protocol: 1,
  requestId: 'render-1',
  epoch: 'session-1',
  entry: target.document,
  locale: target.locale,
  contentVersion: Math.max(0, version - 1),
  commandId: `command-${version}`,
  target,
  ok: true,
  acceptedVersion: version,
  ...(result.update ? { update: result.update } : {}),
});

const fixture = () => {
  document.body.innerHTML = '<div data-prose><p>Harbour home</p></div><p data-other>Outside</p>';
  const element = document.querySelector<HTMLElement>('[data-prose]');
  if (!element) throw new Error('Rich text fixture missing');
  return element;
};

const selectAll = (element: HTMLElement) => {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
};

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.innerHTML = '<head></head><body></body>';
});

test('uses the shared basic tier, formats through the command lane, and restores session history', async () => {
  const element = fixture();
  let version = 0;
  const commands: CanvasMutation[] = [];
  const command = vi.fn(async (_target: CanvasTarget, mutation: CanvasMutation) => {
    commands.push(mutation);
    version += 1;
    if (mutation.type === 'history')
      return reply(version, {
        ok: true,
        update: {
          value: 'Harbour home',
          selection: { kind: 'text', anchor: 1, head: 13 },
        },
      });
    return reply(version, {
      ok: true,
      update: { value: String(mutation.changes[0]?.value ?? '') },
    });
  });
  const interaction = vi.fn();
  const runtime = createCanvasRichTextRuntime({ command, interaction });
  runtime.start();
  runtime.configure({ kind: 'richtext', target, value: 'Harbour home', tier: 'basic' });

  expect(runtime.activate(selected, element)).toBe(true);
  expect(element.textContent).toBe('Harbour home');
  expect(element.querySelectorAll('p')).toHaveLength(1);
  const editor = element.querySelector<HTMLElement>('[contenteditable="true"]');
  if (!editor) throw new Error('TipTap editable missing');
  expect(document.querySelectorAll('[aria-label="Rich text formatting"] button')).toHaveLength(5);
  selectAll(editor);
  document.querySelector<HTMLButtonElement>('[aria-label="Bold"]')?.click();
  await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  expect(commands[0]).toMatchObject({
    type: 'field',
    changes: [{ value: '**Harbour home**' }],
    history: { kind: 'format', before: { kind: 'text' }, after: { kind: 'text' } },
  });
  expect(element.querySelector('strong')?.textContent).toBe('Harbour home');
  expect(document.querySelector('[data-other]')?.textContent).toBe('Outside');

  editor.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, key: 'z', ctrlKey: true, cancelable: true }),
  );
  await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(element.querySelector('strong')).toBeNull());
  expect(document.getSelection()?.toString()).toBe('Harbour home');
  expect(interaction).toHaveBeenCalledWith(target, {
    inlineEditing: true,
    composing: false,
  });
  runtime.dispose();
});

test('uses the Canvas link editor to create and revisit a rich-text link', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ entries: [], indexes: [], locales: ['en'] })),
  );
  const element = fixture();
  const commands: CanvasMutation[] = [];
  let version = 0;
  const runtime = createCanvasRichTextRuntime({
    command: async (_target, mutation) => {
      commands.push(mutation);
      version += 1;
      const value = mutation.type === 'field' ? String(mutation.changes[0]?.value ?? '') : '';
      return reply(version, { ok: true, update: { value } });
    },
    interaction: vi.fn(),
  });
  runtime.start();
  runtime.configure({ kind: 'richtext', target, value: 'Harbour home', tier: 'basic' });
  runtime.activate(selected, element);
  const prose = element.querySelector<HTMLElement>('[contenteditable="true"]');
  if (!prose) throw new Error('TipTap editable missing');
  selectAll(prose);
  document.querySelector<HTMLButtonElement>('[aria-label="Link"]')?.click();

  const dialog = document.querySelector<HTMLElement>('[data-handover-canvas-link-editor]');
  const address = dialog?.querySelector<HTMLInputElement>('#handover-canvas-link-url');
  if (!dialog || !address) throw new Error('Canvas link editor missing');
  expect(dialog.hidden).toBe(false);
  expect(
    document.querySelector('[aria-label="Rich text formatting"]')?.hasAttribute('hidden'),
  ).toBe(true);
  address.value = '/contact';
  address.dispatchEvent(new InputEvent('input', { bubbles: true }));
  dialog.querySelector<HTMLButtonElement>('[data-link-apply]')?.click();

  await vi.waitFor(() => expect(commands).toHaveLength(1));
  expect(commands[0]).toMatchObject({
    type: 'field',
    changes: [{ value: expect.stringContaining('](/contact)') }],
    history: { kind: 'format' },
  });
  const link = element.querySelector<HTMLAnchorElement>('a[href="/contact"]');
  if (!link) throw new Error('created rich-text link missing');
  link.click();
  await vi.waitFor(() => expect(dialog.hidden).toBe(false));
  expect(dialog.querySelector<HTMLInputElement>('#handover-canvas-link-url')?.value).toBe(
    '/contact',
  );
  runtime.dispose();
});

test('full tier adds only its supported controls and composition commits once', async () => {
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([] as unknown as DOMRectList);
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  });
  const element = fixture();
  const commands: CanvasMutation[] = [];
  let version = 0;
  const runtime = createCanvasRichTextRuntime({
    command: async (_target, mutation) => {
      commands.push(mutation);
      version += 1;
      const value = mutation.type === 'field' ? String(mutation.changes[0]?.value ?? '') : '';
      return reply(version, { ok: true, update: { value } });
    },
    interaction: vi.fn(),
  });
  runtime.start();
  runtime.configure({ kind: 'richtext', target, value: 'Harbour home', tier: 'full' });
  runtime.activate(selected, element);
  expect(document.querySelectorAll('[aria-label="Rich text formatting"] button')).toHaveLength(8);

  const editor = element.querySelector<HTMLElement>('[contenteditable="true"]');
  if (!editor) throw new Error('TipTap editable missing');
  editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  const paragraph = editor.querySelector('p');
  if (!paragraph) throw new Error('TipTap paragraph missing');
  paragraph.textContent = '日本';
  editor.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      data: '日本',
      inputType: 'insertCompositionText',
      isComposing: true,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve));
  expect(commands).toHaveLength(0);
  editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
  await vi.waitFor(() => expect(commands).toHaveLength(1));
  expect(commands[0]).toMatchObject({
    type: 'field',
    changes: [{ value: '日本' }],
    history: { kind: 'composition', group: expect.stringMatching(/^composition-/) },
  });
  runtime.dispose();
});

test('unsupported Markdown and non-prose annotations remain read-only', () => {
  const element = fixture();
  const runtime = createCanvasRichTextRuntime({ command: vi.fn(), interaction: vi.fn() });
  runtime.start();
  runtime.configure({ kind: 'richtext', target, value: '# Unsupported heading', tier: 'basic' });
  expect(runtime.activate(selected, element)).toBe(false);
  expect(element.hasAttribute('contenteditable')).toBe(false);
  runtime.configure({ kind: 'richtext', target, value: 'Allowed', tier: 'basic' });
  const paragraph = document.querySelector('[data-other]');
  expect(paragraph && runtime.activate(selected, paragraph)).toBe(false);
  expect(
    document.querySelector('[aria-label="Rich text formatting"]')?.hasAttribute('hidden'),
  ).toBe(true);
  runtime.dispose();
});

test('finishing keeps the accepted prose visible and unchanged sessions restore the original nodes', async () => {
  const element = fixture();
  const original = element.firstChild;
  const runtime = createCanvasRichTextRuntime({
    command: async () => reply(1, { ok: true, update: { value: '**Harbour home**' } }),
    interaction: vi.fn(),
  });
  runtime.start();
  runtime.configure({ kind: 'richtext', target, value: 'Harbour home', tier: 'basic' });
  runtime.activate(selected, element);
  runtime.configure();
  expect(element.firstChild).toBe(original);
  expect(element.textContent).toBe('Harbour home');

  runtime.configure({ kind: 'richtext', target, value: 'Harbour home', tier: 'basic' });
  runtime.activate(selected, element);
  const editor = element.querySelector<HTMLElement>('[contenteditable="true"]');
  if (!editor) throw new Error('TipTap editable missing');
  selectAll(editor);
  document.querySelector<HTMLButtonElement>('[aria-label="Bold"]')?.click();
  await vi.waitFor(() => expect(element.querySelector('strong')).not.toBeNull());
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await vi.waitFor(() => expect(runtime.active()).toBe(false));
  expect(element.querySelector('[contenteditable]')).toBeNull();
  expect(element.querySelector('strong')?.textContent).toBe('Harbour home');
  expect(element.textContent).toBe('Harbour home');
  runtime.dispose();
});
