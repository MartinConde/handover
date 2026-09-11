import { afterEach, expect, test, vi } from 'vitest';
import type {
  CanvasAcknowledgement,
  CanvasMutation,
  CanvasSelection,
  CanvasTarget,
} from './canvas-bridge';
import { createCanvasPlainTextRuntime } from './canvas-text';

const target: CanvasTarget = {
  document: { collection: 'pages', id: 'home' },
  locale: 'en',
  address: 'title',
};
const selected: CanvasSelection = { kind: 'field', target };

const reply = (
  commandId: string,
  version: number,
  result:
    | { ok: false; reason: 'readonly' }
    | { ok: true; update?: { value: string; selection?: { anchor: number; head: number } } },
): CanvasAcknowledgement => ({
  type: 'handover:canvas:ack',
  protocol: 1,
  requestId: 'render-1',
  epoch: 'session-1',
  entry: target.document,
  locale: target.locale,
  contentVersion: Math.max(0, version - 1),
  commandId,
  target,
  ...(result.ok
    ? { ok: true, acceptedVersion: version, ...(result.update ? { update: result.update } : {}) }
    : result),
});

const cursor = (element: HTMLElement, offset: number) => {
  const node = element.firstChild ?? element.appendChild(document.createTextNode(''));
  const selection = document.getSelection();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
};

const beforeInput = (element: HTMLElement, inputType = 'insertText') =>
  element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType }));

const fixture = (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing test fixture: ${selector}`);
  return element;
};

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.innerHTML = '<head></head><body></body>';
});

test('edits one configured field, serializes typing, and reports editing boundaries', async () => {
  document.body.innerHTML = '<h1>Home</h1><p>Other page content</p>';
  const heading = fixture('h1');
  let version = 0;
  const commands: CanvasMutation[] = [];
  const command = vi.fn(async (_target: CanvasTarget, mutation: CanvasMutation) => {
    commands.push(mutation);
    version += 1;
    const value = mutation.type === 'field' ? String(mutation.changes[0]?.value ?? '') : '';
    return reply(`command-${version}`, version, { ok: true, update: { value } });
  });
  const interaction = vi.fn();
  const runtime = createCanvasPlainTextRuntime({ command, interaction });
  runtime.start();
  runtime.configure({ kind: 'text', target, value: 'Home' });

  expect(runtime.activate(selected, heading)).toBe(true);
  expect(heading.getAttribute('contenteditable')).toBe('true');
  beforeInput(heading);
  heading.textContent = 'Homes';
  cursor(heading, 5);
  heading.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  beforeInput(heading);
  heading.textContent = 'Homest';
  cursor(heading, 6);
  heading.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(2));

  expect(commands).toEqual([
    expect.objectContaining({
      type: 'field',
      changes: [{ value: 'Homes' }],
      history: expect.objectContaining({ kind: 'typing', after: { anchor: 5, head: 5 } }),
    }),
    expect.objectContaining({
      type: 'field',
      changes: [{ value: 'Homest' }],
      history: expect.objectContaining({ kind: 'typing', after: { anchor: 6, head: 6 } }),
    }),
  ]);
  expect(document.querySelector('p')?.textContent).toBe('Other page content');
  expect(interaction).toHaveBeenCalledWith(target, {
    inlineEditing: true,
    composing: false,
  });

  heading.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
  await vi.waitFor(() => expect(runtime.active()).toBe(false));
  expect(heading.hasAttribute('contenteditable')).toBe(false);
  expect(interaction).toHaveBeenLastCalledWith(target, {
    inlineEditing: false,
    composing: false,
  });
  runtime.dispose();
});

test('paste is plain text and composition commits as one transaction', async () => {
  document.body.innerHTML = '<h1>Sea</h1>';
  const heading = fixture('h1');
  let version = 0;
  const commands: CanvasMutation[] = [];
  const runtime = createCanvasPlainTextRuntime({
    command: async (_target, command) => {
      commands.push(command);
      version += 1;
      const value = command.type === 'field' ? String(command.changes[0]?.value ?? '') : '';
      return reply(`command-${version}`, version, { ok: true, update: { value } });
    },
    interaction: vi.fn(),
  });
  runtime.start();
  runtime.configure({ kind: 'text', target, value: 'Sea' });
  runtime.activate(selected, heading);
  cursor(heading, 3);

  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? '<b> breeze</b>' : '') },
  });
  heading.dispatchEvent(paste);
  await vi.waitFor(() => expect(commands).toHaveLength(1));
  expect(heading.textContent).toBe('Sea<b> breeze</b>');
  expect(heading.querySelector('b')).toBeNull();
  expect(commands[0]).toMatchObject({
    type: 'field',
    history: { kind: 'paste' },
    changes: [{ value: 'Sea<b> breeze</b>' }],
  });

  heading.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  heading.textContent = '日本';
  cursor(heading, 2);
  heading.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '日本' }),
  );
  heading.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
  await vi.waitFor(() => expect(commands).toHaveLength(2));
  expect(commands[1]).toMatchObject({
    type: 'field',
    history: { kind: 'composition', group: expect.stringMatching(/^composition-/) },
    changes: [{ value: '日本' }],
  });
  runtime.dispose();
});

test('a refused acknowledgement restores accepted content and session undo restores its cursor', async () => {
  document.body.innerHTML = '<h1>Accepted</h1>';
  const heading = fixture('h1');
  const command = vi
    .fn<(target: CanvasTarget, command: CanvasMutation) => Promise<CanvasAcknowledgement>>()
    .mockResolvedValueOnce(reply('command-1', 1, { ok: false, reason: 'readonly' }))
    .mockResolvedValueOnce(
      reply('command-2', 2, {
        ok: true,
        update: { value: 'Before', selection: { anchor: 3, head: 3 } },
      }),
    );
  const runtime = createCanvasPlainTextRuntime({ command, interaction: vi.fn() });
  runtime.start();
  runtime.configure({ kind: 'text', target, value: 'Accepted' });
  runtime.activate(selected, heading);
  beforeInput(heading);
  heading.textContent = 'Rejected';
  cursor(heading, 8);
  heading.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  await vi.waitFor(() => expect(heading.textContent).toBe('Accepted'));
  expect(heading.getAttribute('data-handover-inline-refusal')).toBe('readonly');

  runtime.configure({ kind: 'text', target, value: 'Current' });
  heading.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, key: 'z', metaKey: true, cancelable: true }),
  );
  await vi.waitFor(() => expect(heading.textContent).toBe('Before'));
  expect(command).toHaveBeenLastCalledWith(target, { type: 'history', direction: 'undo' });
  expect(document.getSelection()?.anchorOffset).toBe(3);
  runtime.dispose();
});
