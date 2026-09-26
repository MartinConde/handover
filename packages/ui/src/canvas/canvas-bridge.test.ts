import { afterEach, expect, test, vi } from 'vitest';
import {
  type CanvasChildBridgeOptions,
  type CanvasCommandMessage,
  type CanvasParentBridgeOptions,
  type CanvasStructureNode,
  type CanvasSuccessManifest,
  type CanvasTarget,
  createCanvasChildBridge,
  createCanvasParentBridge,
  readCanvasResultManifest,
} from './canvas-bridge';

const manifest: CanvasSuccessManifest = {
  mode: 'canvas',
  status: 'success',
  protocol: 1,
  requestId: 'render-1',
  epoch: 'session-1',
  entry: { collection: 'pages', id: 'home' },
  locale: 'en',
  contentVersion: 4,
};

const target: CanvasTarget = {
  document: { collection: 'pages', id: 'home' },
  locale: 'en',
  address: 'blocks[_id=hero-1].heading',
};

const ready = {
  type: 'handover:canvas:ready',
  protocol: 1,
  requestId: 'render-1',
  epoch: 'session-1',
  entry: { collection: 'pages', id: 'home' },
  locale: 'en',
  contentVersion: 4,
} as const;

const command = (overrides: Partial<CanvasCommandMessage> = {}): CanvasCommandMessage => ({
  ...ready,
  type: 'handover:canvas:command',
  commandId: 'command-1',
  target,
  command: { type: 'field', changes: [{ value: 'A brighter coast' }] },
  ...overrides,
});

const ack = (overrides: Record<string, unknown> = {}) => ({
  ...ready,
  type: 'handover:canvas:ack',
  commandId: 'command-1',
  target,
  ok: true,
  acceptedVersion: 5,
  ...overrides,
});

const event = (source: Window, origin: string, data: unknown) =>
  ({ source, origin, data }) as MessageEvent;

const frame = () => ({ postMessage: vi.fn() }) as unknown as Window;

const connect = (
  overrides: Partial<CanvasParentBridgeOptions> = {},
  { ready: handshake = true } = {},
) => {
  const candidate = overrides.frame ?? frame();
  const rejected = vi.fn();
  const bridge = createCanvasParentBridge({
    manifest,
    frame: candidate,
    origin: 'https://cms.example',
    contentVersion: () => 4,
    currentTarget: () => target,
    onCommand: vi.fn(),
    onRejected: rejected,
    listen: false,
    ...overrides,
  });
  const send = (data: unknown, origin = 'https://cms.example', source = candidate) =>
    bridge.receive(event(source, origin, data));
  if (handshake) send(ready);
  return { bridge, candidate, rejected, send };
};

const child = (overrides: Partial<CanvasChildBridgeOptions> = {}) => {
  const parent = overrides.parent ?? frame();
  const bridge = createCanvasChildBridge({
    manifest,
    parent,
    origin: 'https://cms.example',
    listen: false,
    ...overrides,
  });
  const send = (data: unknown, origin = 'https://cms.example', source = parent) =>
    bridge.receive(event(source, origin, data));
  return { bridge, parent, send };
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

test('the parent handshake accepts only the expected origin, frame, request and epoch', () => {
  const onReady = vi.fn();
  const { bridge, rejected, send } = connect({ onReady }, { ready: false });

  send(ready, 'https://attacker.example');
  send(ready, 'https://cms.example', frame());
  send({ ...ready, epoch: 'replaced-session' });
  expect(bridge.connected()).toBe(false);
  expect(rejected.mock.calls.map(([reason]) => reason)).toEqual([
    'foreign-origin',
    'foreign-window',
    'stale-epoch',
  ]);

  send(ready);
  send(ready);
  expect(bridge.connected()).toBe(true);
  expect(onReady).toHaveBeenCalledOnce();
});

test('interface locale crosses only the current connected Canvas identity', () => {
  let contentVersion = 4;
  const { bridge, candidate, send } = connect(
    { contentVersion: () => contentVersion },
    { ready: false },
  );

  expect(bridge.uiLocale('de')).toBe(false);
  send(ready);
  expect(bridge.uiLocale('de')).toBe(true);
  contentVersion = 5;
  expect(bridge.uiLocale('en')).toBe(true);
  expect(candidate.postMessage).toHaveBeenCalledTimes(2);
  expect(candidate.postMessage).toHaveBeenNthCalledWith(
    1,
    {
      ...ready,
      type: 'handover:canvas:ui-locale',
      uiLocale: 'de',
    },
    'https://cms.example',
  );
  expect(candidate.postMessage).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      type: 'handover:canvas:ui-locale',
      uiLocale: 'en',
      contentVersion: 4,
    }),
    'https://cms.example',
  );

  const onUiLocale = vi.fn();
  const page = child({ onUiLocale });
  const localeMessage = {
    ...ready,
    type: 'handover:canvas:ui-locale',
    uiLocale: 'de',
  } as const;
  page.send(localeMessage, 'https://cms.example', frame());
  page.send(localeMessage, 'https://attacker.example');
  page.send({ ...localeMessage, epoch: 'old' });
  page.send({ ...localeMessage, uiLocale: 'fr' });
  expect(onUiLocale).not.toHaveBeenCalled();

  page.send(localeMessage);
  expect(onUiLocale).toHaveBeenCalledOnce();
  expect(onUiLocale).toHaveBeenCalledWith('de');
  expect(page.bridge.contentVersion()).toBe(4);
});

test('a controlled render error manifest is available to the candidate lifecycle', () => {
  document.body.innerHTML = `<script type="application/json" data-handover-canvas-manifest>{"mode":"canvas","status":"error","protocol":1,"requestId":"render-1","epoch":"session-1","contentVersion":4,"error":{"status":422,"message":"Invalid snapshot"}}</script>`;

  expect(readCanvasResultManifest()).toEqual({
    mode: 'canvas',
    status: 'error',
    protocol: 1,
    requestId: 'render-1',
    epoch: 'session-1',
    contentVersion: 4,
    error: { status: 422, message: 'Invalid snapshot' },
  });
});

test('the Canvas manifest accepts the authenticated site-base entry directory', () => {
  document.body.innerHTML = `<script type="application/json" data-handover-canvas-manifest>{"mode":"canvas","status":"success","protocol":1,"requestId":"render-1","epoch":"session-1","entry":{"collection":"pages","id":"home"},"locale":"en","contentVersion":4,"entryDirectory":"/coastal/admin/api/entries"}</script>`;

  expect(readCanvasResultManifest()).toEqual({
    ...manifest,
    entryDirectory: '/coastal/admin/api/entries',
  });
});

test('malformed messages are refused before they can reach a command handler', () => {
  const onCommand = vi.fn();
  const { candidate, rejected, send } = connect({ onCommand }, { ready: false });

  send({ ...command(), extra: true });
  send({ type: 'handover:canvas:command' });

  expect(onCommand).not.toHaveBeenCalled();
  expect(rejected).toHaveBeenCalledTimes(2);
  expect(rejected).toHaveBeenCalledWith('malformed', expect.anything());
  expect(candidate.postMessage).not.toHaveBeenCalled();
});

test('selection and structure cross only the connected versioned bridge', () => {
  const onSelection = vi.fn();
  const onStructure = vi.fn();
  const { bridge, candidate, rejected, send } = connect(
    { onSelection, onStructure },
    { ready: false },
  );
  const selected = { kind: 'field' as const, target };
  const node = {
    ...selected,
    id: 'target-1',
    label: 'Heading',
    depth: 1,
    position: 1,
    setSize: 1,
    occurrences: 2,
  };

  send({ ...ready, type: 'handover:canvas:selection', selection: selected });
  expect(onSelection).not.toHaveBeenCalled();
  send(ready);
  send({ ...ready, type: 'handover:canvas:structure', nodes: [node] });
  send({ ...ready, type: 'handover:canvas:selection', selection: selected });

  expect(onStructure).toHaveBeenCalledWith([node]);
  expect(onSelection).toHaveBeenCalledWith(selected);
  expect(bridge.select(selected)).toBe(true);
  expect(candidate.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: 'handover:canvas:select', selection: selected }),
    'https://cms.example',
  );
  expect(rejected).toHaveBeenCalledWith('not-ready', expect.anything());
});

test('parent controls copy reactive values before crossing the structured-clone boundary', () => {
  const posted: unknown[] = [];
  const { bridge } = connect({
    frame: {
      postMessage: vi.fn((message: unknown) => posted.push(structuredClone(message))),
    } as unknown as Window,
  });
  const reactiveTarget = new Proxy(target, {});
  const selected = new Proxy({ kind: 'field' as const, target: reactiveTarget }, {});

  expect(() => bridge.select(selected)).not.toThrow();
  expect(() =>
    bridge.textField(
      new Proxy({ kind: 'text' as const, target: reactiveTarget, value: 'A brighter coast' }, {}),
    ),
  ).not.toThrow();
  expect(() => bridge.actions(selected, ['undo', 'redo'])).not.toThrow();
  expect(posted).toEqual([
    expect.objectContaining({
      type: 'handover:canvas:select',
      selection: { kind: 'field', target },
    }),
    expect.objectContaining({
      type: 'handover:canvas:text-field',
      field: { kind: 'text', target, value: 'A brighter coast' },
    }),
    expect.objectContaining({
      type: 'handover:canvas:actions',
      selection: { kind: 'field', target },
      actions: ['undo', 'redo'],
    }),
  ]);
});

test('select and actions accept a Structure node and send only kind and target', () => {
  const { bridge, candidate } = connect();
  const node: CanvasStructureNode = {
    kind: 'block',
    target,
    id: 'hero-1',
    label: 'Hero',
    depth: 0,
    position: 1,
    setSize: 3,
    occurrences: 1,
  };

  expect(bridge.select(node)).toBe(true);
  expect(bridge.actions(node, ['delete'])).toBe(true);
  expect(candidate.postMessage).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      type: 'handover:canvas:select',
      selection: { kind: 'block', target },
    }),
    'https://cms.example',
  );
  expect(candidate.postMessage).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      type: 'handover:canvas:actions',
      selection: { kind: 'block', target },
      actions: ['delete'],
    }),
    'https://cms.example',
  );
});

test('the child accepts a current parent selection and publishes validated navigation state', () => {
  const onSelect = vi.fn();
  const { bridge, parent, send } = child({ onSelect });
  const selected = { kind: 'field' as const, target };
  bridge.start();
  expect(bridge.selection(selected)).toBe(true);
  expect(
    bridge.structure([
      {
        ...selected,
        id: 'target-1',
        label: 'Heading',
        depth: 1,
        position: 1,
        setSize: 1,
        occurrences: 1,
      },
    ]),
  ).toBe(true);
  send({ ...ready, type: 'handover:canvas:select', selection: selected });

  expect(onSelect).toHaveBeenCalledWith(selected, { scroll: true });
  send({ ...ready, type: 'handover:canvas:select', selection: selected, scroll: false });
  expect(onSelect).toHaveBeenLastCalledWith(selected, { scroll: false });
  onSelect.mockClear();
  send({ ...ready, type: 'handover:canvas:select', selection: selected, scroll: 'false' });
  expect(onSelect).not.toHaveBeenCalled();
  expect(parent.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'handover:canvas:selection', selection: selected }),
    'https://cms.example',
  );
  expect(parent.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'handover:canvas:structure' }),
    'https://cms.example',
  );
});

test('block actions cross only the connected bridge for the current selection', () => {
  const onActions = vi.fn();
  const page = child({ onActions });
  const selected = { kind: 'block' as const, target };
  page.bridge.start();
  expect(page.bridge.action('insert-after', selected)).toBe(true);
  expect(page.parent.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'handover:canvas:action',
      action: 'insert-after',
      selection: selected,
    }),
    'https://cms.example',
  );

  const onAction = vi.fn();
  const { bridge, candidate, rejected, send } = connect({ onAction }, { ready: false });
  const message = {
    ...ready,
    type: 'handover:canvas:action',
    action: 'replace',
    selection: selected,
  };
  send(message);
  expect(onAction).not.toHaveBeenCalled();
  send(ready);
  expect(bridge.actions(selected, ['insert-after', 'replace'])).toBe(true);
  expect(candidate.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'handover:canvas:actions',
      selection: selected,
      actions: ['insert-after', 'replace'],
    }),
    'https://cms.example',
  );
  page.send({
    ...ready,
    type: 'handover:canvas:actions',
    selection: selected,
    actions: ['insert-after', 'replace'],
  });
  send(message);
  send({ ...message, action: 'convert-automatically' });

  expect(onAction).toHaveBeenCalledOnce();
  expect(onAction).toHaveBeenCalledWith(message);
  expect(onActions).toHaveBeenCalledWith({
    selection: selected,
    actions: ['insert-after', 'replace'],
  });
  expect(rejected.mock.calls.map(([reason]) => reason)).toEqual(['not-ready', 'malformed']);
});

test('same-list pointer moves carry one stable destination and reject malformed drops', () => {
  const page = child();
  const selected = { kind: 'block' as const, target };
  const destination = {
    kind: 'block' as const,
    target: { ...target, address: 'blocks[_id=second]' },
  };
  page.bridge.start();
  expect(page.bridge.action('move', selected, destination)).toBe(true);
  expect(page.parent.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'handover:canvas:action',
      action: 'move',
      selection: selected,
      destination,
    }),
    'https://cms.example',
  );
  expect(page.bridge.action('move', selected)).toBe(false);
  expect(page.bridge.action('delete', selected, destination)).toBe(false);

  const onAction = vi.fn();
  const { rejected, send } = connect({ onAction });
  const moved = {
    ...ready,
    type: 'handover:canvas:action',
    action: 'move',
    selection: selected,
    destination,
  };
  send(moved);
  send({ ...moved, destination: null });
  send({ ...moved, destination: { ...destination, kind: 'unknown' } });
  send({ ...moved, action: 'delete' });

  expect(onAction).toHaveBeenCalledOnce();
  expect(onAction).toHaveBeenCalledWith(moved);
  expect(rejected.mock.calls.map(([reason]) => reason)).toEqual([
    'malformed',
    'malformed',
    'malformed',
  ]);
});

test('interaction mode and navigation intents cross only the current connected bridge', () => {
  const onMode = vi.fn();
  const page = child({ onMode });
  page.bridge.start();
  page.send({ ...ready, type: 'handover:canvas:mode', mode: 'interact' });
  expect(onMode).toHaveBeenCalledWith('interact');
  expect(
    page.bridge.navigate({
      kind: 'link',
      href: 'https://cms.example/de/home',
      newTab: false,
      download: false,
    }),
  ).toBe(true);
  expect(page.parent.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'handover:canvas:navigate',
      kind: 'link',
      href: 'https://cms.example/de/home',
    }),
    'https://cms.example',
  );

  const onNavigate = vi.fn();
  const { bridge, candidate, rejected, send } = connect({ onNavigate });
  expect(bridge.mode('interact')).toBe(true);
  expect(candidate.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: 'handover:canvas:mode', mode: 'interact' }),
    'https://cms.example',
  );
  const navigation = {
    ...ready,
    type: 'handover:canvas:navigate',
    kind: 'link',
    href: 'https://cms.example/de/home',
    newTab: false,
    download: false,
  };
  send(navigation);
  send({ ...navigation, href: '' });

  expect(onNavigate).toHaveBeenCalledOnce();
  expect(onNavigate).toHaveBeenCalledWith(navigation);
  expect(rejected).toHaveBeenCalledWith('malformed', expect.anything());
});

test('plain-text capability and editing state cross only the current selected bridge', () => {
  const onTextField = vi.fn();
  const page = child({ onTextField });
  page.bridge.start();
  page.send({
    ...ready,
    type: 'handover:canvas:text-field',
    field: { kind: 'text', target, value: 'A brighter coast' },
  });
  expect(onTextField).toHaveBeenCalledWith({
    kind: 'text',
    target,
    value: 'A brighter coast',
  });
  page.send({
    ...ready,
    type: 'handover:canvas:text-field',
    field: { kind: 'richtext', target, value: '**A brighter coast**', tier: 'basic' },
  });
  expect(onTextField).toHaveBeenLastCalledWith({
    kind: 'richtext',
    target,
    value: '**A brighter coast**',
    tier: 'basic',
  });
  expect(page.bridge.interaction(target, { inlineEditing: true, composing: false })).toBe(true);
  expect(page.parent.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'handover:canvas:editing',
      target,
      state: { inlineEditing: true, composing: false },
    }),
    'https://cms.example',
  );

  const onEditing = vi.fn();
  const { bridge, candidate, send } = connect({ onEditing });
  expect(bridge.textField({ kind: 'text', target, value: 'A brighter coast' })).toBe(true);
  expect(
    bridge.textField({ kind: 'richtext', target, value: '**A brighter coast**', tier: 'basic' }),
  ).toBe(true);
  expect(
    bridge.textField({
      kind: 'link',
      target,
      value: {
        type: 'url',
        ref: '',
        href: 'https://example.com',
        label: 'Visit',
        newTab: false,
      },
    }),
  ).toBe(true);
  expect(candidate.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'handover:canvas:text-field',
      field: {
        kind: 'link',
        target,
        value: {
          type: 'url',
          ref: '',
          href: 'https://example.com',
          label: 'Visit',
          newTab: false,
        },
      },
    }),
    'https://cms.example',
  );
  expect(candidate.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'handover:canvas:text-field',
      field: {
        kind: 'richtext',
        target,
        value: '**A brighter coast**',
        tier: 'basic',
      },
    }),
    'https://cms.example',
  );
  send({
    ...ready,
    type: 'handover:canvas:editing',
    target,
    state: { inlineEditing: true, composing: true },
  });
  expect(onEditing).toHaveBeenCalledWith(target, {
    inlineEditing: true,
    composing: true,
  });
});

test('the active editor can stop after parent selection moves to another target', () => {
  let selected = target;
  let version = 4;
  const onEditing = vi.fn();
  const { rejected, send } = connect({
    contentVersion: () => version,
    currentTarget: () => selected,
    onEditing,
  });
  const editing = (address: string, inlineEditing: boolean, interactionId = 'edit-1') => ({
    ...ready,
    type: 'handover:canvas:editing',
    target: { ...target, address },
    state: { inlineEditing, composing: false },
    interactionId,
  });
  send(editing(target.address, true));
  selected = { ...target, address: 'body' };
  version = 5;
  send({ ...editing(target.address, false), contentVersion: 6 });
  send({ ...editing(target.address, false), contentVersion: 3 });
  expect(onEditing).toHaveBeenCalledTimes(1);
  expect(rejected).toHaveBeenCalledWith('stale-version', expect.anything());
  send({ ...editing(target.address, false), contentVersion: 4 });
  expect(onEditing).toHaveBeenCalledTimes(2);
  expect(onEditing).toHaveBeenLastCalledWith(target, { inlineEditing: false, composing: false });
  send({ ...editing(target.address, false), contentVersion: 5 });
  expect(rejected).toHaveBeenCalledWith('stale-target', expect.anything());
});

test('a delayed stop from a previous edit cannot end a newer interaction', () => {
  const onEditing = vi.fn();
  const { rejected, send } = connect({ onEditing });
  const editing = (interactionId: string, inlineEditing: boolean) => ({
    ...ready,
    type: 'handover:canvas:editing',
    target,
    state: { inlineEditing, composing: false },
    interactionId,
  });
  send(editing('first', true));
  send(editing('second', true));
  send(editing('first', false));
  expect(onEditing).toHaveBeenCalledTimes(2);
  expect(rejected).toHaveBeenCalledWith('stale-target', expect.anything());
  send(editing('second', false));
  expect(onEditing).toHaveBeenCalledTimes(3);
});

test('an owned stop is not refused as stale after the admin switches to a lower-versioned locale', () => {
  const onEditing = vi.fn();
  let version = 4;
  const { bridge, rejected, send } = connect({ contentVersion: () => version, onEditing });
  // Raises this frame's own high-water mark to 6, independent of whichever locale is selected later.
  version = 6;
  bridge.textField({ kind: 'text', target, value: 'A brighter coast' });
  const editing = (inlineEditing: boolean) => ({
    ...ready,
    type: 'handover:canvas:editing',
    target,
    state: { inlineEditing, composing: false },
    contentVersion: 6,
    interactionId: 'i1',
  });
  send(editing(true));
  // The admin switches locale; the new locale's own version is lower than this frame's.
  version = 0;
  send(editing(false));
  expect(rejected).not.toHaveBeenCalledWith('stale-version', expect.anything());
  expect(onEditing).toHaveBeenLastCalledWith(target, { inlineEditing: false, composing: false });
});

test('a drag end is accepted after the content version changes mid-drag', () => {
  const onEditing = vi.fn();
  let version = 4;
  const { rejected, send } = connect({ contentVersion: () => version, onEditing });
  send({
    ...ready,
    type: 'handover:canvas:editing',
    target,
    state: { inlineEditing: false, composing: false, dragging: true },
  });
  // A drag end carries no interactionId, so without owned-interaction handling this drag-end
  // message is checked against the admin's now-different version and refused as stale.
  version = 6;
  send({
    ...ready,
    type: 'handover:canvas:editing',
    target,
    state: { inlineEditing: false, composing: false, dragging: false },
  });
  expect(rejected).not.toHaveBeenCalled();
  expect(onEditing).toHaveBeenLastCalledWith(target, {
    inlineEditing: false,
    composing: false,
    dragging: false,
  });
});

test('nested annotation addresses cross the bridge and addresses beyond its bound fail visibly', () => {
  const onSelection = vi.fn();
  const { rejected, send } = connect({ onSelection });
  const address = `blocks${'[_id=abcdefgh].blocks'.repeat(12)}[_id=abcdefgh].heading`;
  send({
    ...ready,
    type: 'handover:canvas:selection',
    selection: { kind: 'field', target: { ...target, address } },
  });
  expect(onSelection).toHaveBeenCalledWith({ kind: 'field', target: { ...target, address } });
  expect(rejected).not.toHaveBeenCalled();
  send({
    ...ready,
    type: 'handover:canvas:selection',
    selection: { kind: 'field', target: { ...target, address: 'a'.repeat(4_097) } },
  });
  expect(onSelection).toHaveBeenCalledTimes(1);
  expect(rejected).toHaveBeenCalledWith('malformed', expect.anything());
});

test('stale commands and targets receive explicit acknowledgements without mutating', () => {
  const onCommand = vi.fn();
  const { candidate, send } = connect({ contentVersion: () => 5, onCommand }, { ready: false });
  send({ ...ready, contentVersion: 5 });
  send(command());
  send(
    command({
      commandId: 'command-2',
      contentVersion: 5,
      target: { ...target, address: 'blocks[_id=hero-1].summary' },
    }),
  );

  expect(onCommand).not.toHaveBeenCalled();
  expect(candidate.postMessage).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      type: 'handover:canvas:ack',
      commandId: 'command-1',
      ok: false,
      reason: 'stale-version',
    }),
    'https://cms.example',
  );
  expect(candidate.postMessage).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ commandId: 'command-2', ok: false, reason: 'stale-target' }),
    'https://cms.example',
  );
});

test('a reused command ID is refused and never runs twice', async () => {
  let version = 4;
  const onCommand = vi.fn(() => {
    version = 5;
    return { ok: true as const, contentVersion: version };
  });
  const { candidate, send } = connect({ contentVersion: () => version, onCommand });
  send(command());
  send(command());
  await settle();
  send(command());
  await settle();

  expect(onCommand).toHaveBeenCalledTimes(1);
  expect(candidate.postMessage).toHaveBeenCalledTimes(3);
  expect(candidate.postMessage).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ commandId: 'command-1', ok: false, reason: 'duplicate-command' }),
    'https://cms.example',
  );
  expect(candidate.postMessage).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ commandId: 'command-1', ok: true, acceptedVersion: 5 }),
    'https://cms.example',
  );
  expect(candidate.postMessage).toHaveBeenNthCalledWith(
    3,
    expect.objectContaining({ commandId: 'command-1', ok: false, reason: 'duplicate-command' }),
    'https://cms.example',
  );
});

test('session refusals are acknowledged and the bridge performs no server write', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const { candidate, send } = connect({ onCommand: () => ({ ok: false, reason: 'readonly' }) });
  send(command());
  await settle();

  expect(candidate.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ commandId: 'command-1', ok: false, reason: 'readonly' }),
    'https://cms.example',
  );
  expect(fetch).not.toHaveBeenCalled();
});

test('the iframe bridge ignores foreign and stale acknowledgements, then accepts its own', async () => {
  const { bridge, parent, send } = child({ commandId: () => 'command-1' });
  bridge.start();
  expect(parent.postMessage).toHaveBeenCalledWith(
    ready,
    'https://cms.example',
    expect.arrayContaining([expect.any(MessagePort)]),
  );

  const pending = bridge.command(target, {
    type: 'field',
    changes: [{ value: 'A brighter coast' }],
  });
  send(ack(), 'https://attacker.example');
  send(ack({ requestId: 'old-render' }));
  send(ack());

  await expect(pending).resolves.toEqual(expect.objectContaining({ ok: true, acceptedVersion: 5 }));
  expect(bridge.contentVersion()).toBe(5);
});

test('a structure node crosses with its optional keys and is refused any key beyond them', () => {
  const onStructure = vi.fn();
  const { send } = connect({ onStructure });
  const root = {
    kind: 'block' as const,
    target: { ...target, address: 'blocks[_id=hero-1]' },
    id: 'target-1',
    label: 'Hero',
    depth: 1,
    position: 1,
    setSize: 1,
    occurrences: 1,
  };
  const node = {
    kind: 'list' as const,
    target,
    id: 'target-2',
    label: 'Blocks',
    parentId: 'target-1',
    depth: 2,
    position: 1,
    setSize: 1,
    occurrences: 1,
    empty: true,
  };
  const sendNodes = (nodes: unknown[]) =>
    send({ ...ready, type: 'handover:canvas:structure', nodes });

  sendNodes([{ ...root, container: true }, node]);
  expect(onStructure).toHaveBeenCalledWith([{ ...root, container: true }, node]);
  sendNodes([{ ...root, container: 'true' }, node]);
  expect(onStructure).toHaveBeenCalledTimes(1);

  sendNodes([root, { ...node, named: 'Blocks' }]);
  expect(onStructure).toHaveBeenCalledTimes(1);
});

test('problems() still sends the addresses within bound when another exceeds it', () => {
  const { bridge, candidate } = connect();
  expect(bridge.problems([target.address, 'a'.repeat(4_097)])).toBe(true);
  expect(candidate.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: 'handover:canvas:problems', addresses: [target.address] }),
    'https://cms.example',
  );
});

test('a problems update stamped ahead of a pending command is applied once it acks', () => {
  const onProblems = vi.fn();
  const { bridge, send } = child({ onProblems, commandId: () => 'command-1' });
  bridge.start();
  void bridge.command(target, { type: 'field', changes: [{ value: 'A brighter coast' }] });

  send({
    ...ready,
    type: 'handover:canvas:problems',
    addresses: [target.address],
    contentVersion: 5,
  });
  expect(onProblems).not.toHaveBeenCalled();

  send(ack());
  expect(onProblems).toHaveBeenCalledWith([target.address]);
});

test('an interface language stamped ahead of a pending command is applied once it acks', () => {
  const onUiLocale = vi.fn();
  const { bridge, send } = child({ onUiLocale, commandId: () => 'command-1' });
  bridge.start();
  void bridge.command(target, { type: 'field', changes: [{ value: 'A brighter coast' }] });

  send({ ...ready, type: 'handover:canvas:ui-locale', uiLocale: 'de', contentVersion: 5 });
  expect(onUiLocale).not.toHaveBeenCalled();

  send(ack());
  expect(onUiLocale).toHaveBeenCalledWith('de');
});

test('validation updates are scoped to the active frame and accept clearing all problems', () => {
  const onProblems = vi.fn();
  const { bridge, send } = child({ onProblems });
  const message = { ...ready, type: 'handover:canvas:problems', addresses: [target.address] };
  send(message, 'https://cms.example', frame());
  send(message, 'https://attacker.example');
  send({ ...message, epoch: 'old' });
  send({ ...message, addresses: [null] });
  expect(onProblems).not.toHaveBeenCalled();
  send(message);
  expect(onProblems).toHaveBeenLastCalledWith([target.address]);
  send({ ...message, addresses: [] });
  expect(onProblems).toHaveBeenLastCalledWith([]);
  bridge.dispose();
});

test('image activation validates its geometry and retains the normal target boundary', () => {
  const onAction = vi.fn();
  const { bridge, rejected, send } = connect({ onAction });
  const message = {
    ...ready,
    type: 'handover:canvas:action',
    action: 'edit-media',
    selection: { kind: 'field', target },
    anchor: { left: 20, top: 30, width: 300, height: 200 },
  };
  send({ ...message, anchor: { ...message.anchor, width: NaN } });
  send({ ...message, anchor: { ...message.anchor, height: -1 } });
  send({
    ...message,
    selection: { kind: 'field', target: { ...target, address: 'another-image' } },
  });
  expect(onAction).not.toHaveBeenCalled();
  expect(rejected.mock.calls.map(([reason]) => reason)).toEqual([
    'malformed',
    'malformed',
    'stale-target',
  ]);
  send(message);
  expect(onAction).toHaveBeenCalledWith(message);
  bridge.dispose();
});
