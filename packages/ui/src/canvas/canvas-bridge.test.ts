import { afterEach, expect, test, vi } from 'vitest';
import {
  type CanvasCommandMessage,
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
  type: 'handover:canvas:command',
  protocol: 1,
  requestId: 'render-1',
  epoch: 'session-1',
  entry: { collection: 'pages', id: 'home' },
  locale: 'en',
  contentVersion: 4,
  commandId: 'command-1',
  target,
  command: { type: 'field', changes: [{ value: 'A brighter coast' }] },
  ...overrides,
});

const event = (source: Window, origin: string, data: unknown) =>
  ({ source, origin, data }) as MessageEvent;

const frame = () => ({ postMessage: vi.fn() }) as unknown as Window;

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
  const candidate = frame();
  const other = frame();
  const rejected = vi.fn();
  const onReady = vi.fn();
  const bridge = createCanvasParentBridge({
    manifest,
    frame: candidate,
    origin: 'https://cms.example',
    contentVersion: () => 4,
    currentTarget: () => target,
    onCommand: vi.fn(),
    onReady,
    onRejected: rejected,
    listen: false,
  });

  bridge.receive(event(candidate, 'https://attacker.example', ready));
  bridge.receive(event(other, 'https://cms.example', ready));
  bridge.receive(event(candidate, 'https://cms.example', { ...ready, epoch: 'replaced-session' }));
  expect(bridge.connected()).toBe(false);
  expect(rejected.mock.calls.map(([reason]) => reason)).toEqual([
    'foreign-origin',
    'foreign-window',
    'stale-epoch',
  ]);

  bridge.receive(event(candidate, 'https://cms.example', ready));
  bridge.receive(event(candidate, 'https://cms.example', ready));
  expect(bridge.connected()).toBe(true);
  expect(onReady).toHaveBeenCalledOnce();
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
  const candidate = frame();
  const onCommand = vi.fn();
  const rejected = vi.fn();
  const bridge = createCanvasParentBridge({
    manifest,
    frame: candidate,
    origin: 'https://cms.example',
    contentVersion: () => 4,
    currentTarget: () => target,
    onCommand,
    onRejected: rejected,
    listen: false,
  });

  bridge.receive(event(candidate, 'https://cms.example', { ...command(), extra: true }));
  bridge.receive(event(candidate, 'https://cms.example', { type: 'handover:canvas:command' }));

  expect(onCommand).not.toHaveBeenCalled();
  expect(rejected).toHaveBeenCalledTimes(2);
  expect(rejected).toHaveBeenCalledWith('malformed', expect.anything());
  expect(candidate.postMessage).not.toHaveBeenCalled();
});

test('selection and structure cross only the connected versioned bridge', () => {
  const candidate = frame();
  const onSelection = vi.fn();
  const onStructure = vi.fn();
  const rejected = vi.fn();
  const bridge = createCanvasParentBridge({
    manifest,
    frame: candidate,
    origin: 'https://cms.example',
    contentVersion: () => 4,
    currentTarget: () => target,
    onCommand: vi.fn(),
    onSelection,
    onStructure,
    onRejected: rejected,
    listen: false,
  });
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
  const identity = {
    protocol: 1,
    requestId: manifest.requestId,
    epoch: manifest.epoch,
    entry: manifest.entry,
    locale: manifest.locale,
    contentVersion: manifest.contentVersion,
  };

  bridge.receive(
    event(candidate, 'https://cms.example', {
      ...identity,
      type: 'handover:canvas:selection',
      selection: selected,
    }),
  );
  expect(onSelection).not.toHaveBeenCalled();
  bridge.receive(event(candidate, 'https://cms.example', ready));
  bridge.receive(
    event(candidate, 'https://cms.example', {
      ...identity,
      type: 'handover:canvas:structure',
      nodes: [node],
    }),
  );
  bridge.receive(
    event(candidate, 'https://cms.example', {
      ...identity,
      type: 'handover:canvas:selection',
      selection: selected,
    }),
  );

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
  const candidate = {
    postMessage: vi.fn((message: unknown) => posted.push(structuredClone(message))),
  } as unknown as Window;
  const bridge = createCanvasParentBridge({
    manifest,
    frame: candidate,
    origin: 'https://cms.example',
    contentVersion: () => 4,
    currentTarget: () => target,
    onCommand: vi.fn(),
    listen: false,
  });
  bridge.receive(event(candidate, 'https://cms.example', ready));
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

test('the child accepts a current parent selection and publishes validated navigation state', () => {
  const parent = frame();
  const onSelect = vi.fn();
  const child = createCanvasChildBridge({
    manifest,
    parent,
    origin: 'https://cms.example',
    onSelect,
    listen: false,
  });
  const selected = { kind: 'field' as const, target };
  child.start();
  expect(child.selection(selected)).toBe(true);
  expect(
    child.structure([
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
  child.receive(
    event(parent, 'https://cms.example', {
      ...ready,
      type: 'handover:canvas:select',
      selection: selected,
    }),
  );

  expect(onSelect).toHaveBeenCalledWith(selected, { scroll: true });
  child.receive(
    event(parent, 'https://cms.example', {
      ...ready,
      type: 'handover:canvas:select',
      selection: selected,
      scroll: false,
    }),
  );
  expect(onSelect).toHaveBeenLastCalledWith(selected, { scroll: false });
  onSelect.mockClear();
  child.receive(
    event(parent, 'https://cms.example', {
      ...ready,
      type: 'handover:canvas:select',
      selection: selected,
      scroll: 'false',
    }),
  );
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
  const parent = frame();
  const onActions = vi.fn();
  const child = createCanvasChildBridge({
    manifest,
    parent,
    origin: 'https://cms.example',
    onActions,
    listen: false,
  });
  const selected = { kind: 'block' as const, target };
  child.start();
  expect(child.action('insert-after', selected)).toBe(true);
  expect(parent.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'handover:canvas:action',
      action: 'insert-after',
      selection: selected,
    }),
    'https://cms.example',
  );

  const candidate = frame();
  const onAction = vi.fn();
  const rejected = vi.fn();
  const bridge = createCanvasParentBridge({
    manifest,
    frame: candidate,
    origin: 'https://cms.example',
    contentVersion: () => 4,
    currentTarget: () => target,
    onCommand: vi.fn(),
    onAction,
    onRejected: rejected,
    listen: false,
  });
  const message = {
    ...ready,
    type: 'handover:canvas:action',
    action: 'replace',
    selection: selected,
  };
  bridge.receive(event(candidate, 'https://cms.example', message));
  expect(onAction).not.toHaveBeenCalled();
  bridge.receive(event(candidate, 'https://cms.example', ready));
  expect(bridge.actions(selected, ['insert-after', 'replace'])).toBe(true);
  expect(candidate.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'handover:canvas:actions',
      selection: selected,
      actions: ['insert-after', 'replace'],
    }),
    'https://cms.example',
  );
  child.receive(
    event(parent, 'https://cms.example', {
      ...ready,
      type: 'handover:canvas:actions',
      selection: selected,
      actions: ['insert-after', 'replace'],
    }),
  );
  bridge.receive(event(candidate, 'https://cms.example', message));
  bridge.receive(
    event(candidate, 'https://cms.example', {
      ...message,
      action: 'convert-automatically',
    }),
  );

  expect(onAction).toHaveBeenCalledOnce();
  expect(onAction).toHaveBeenCalledWith(message);
  expect(onActions).toHaveBeenCalledWith({
    selection: selected,
    actions: ['insert-after', 'replace'],
  });
  expect(rejected.mock.calls.map(([reason]) => reason)).toEqual(['not-ready', 'malformed']);
});

test('same-list pointer moves carry one stable destination and reject malformed drops', () => {
  const parent = frame();
  const child = createCanvasChildBridge({
    manifest,
    parent,
    origin: 'https://cms.example',
    listen: false,
  });
  const selected = { kind: 'block' as const, target };
  const destination = {
    kind: 'block' as const,
    target: { ...target, address: 'blocks[_id=second]' },
  };
  child.start();
  expect(child.action('move', selected, destination)).toBe(true);
  expect(parent.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'handover:canvas:action',
      action: 'move',
      selection: selected,
      destination,
    }),
    'https://cms.example',
  );
  expect(child.action('move', selected)).toBe(false);
  expect(child.action('delete', selected, destination)).toBe(false);

  const candidate = frame();
  const onAction = vi.fn();
  const rejected = vi.fn();
  const bridge = createCanvasParentBridge({
    manifest,
    frame: candidate,
    origin: 'https://cms.example',
    contentVersion: () => 4,
    currentTarget: () => target,
    onCommand: vi.fn(),
    onAction,
    onRejected: rejected,
    listen: false,
  });
  bridge.receive(event(candidate, 'https://cms.example', ready));
  const moved = {
    ...ready,
    type: 'handover:canvas:action',
    action: 'move',
    selection: selected,
    destination,
  };
  bridge.receive(event(candidate, 'https://cms.example', moved));
  bridge.receive(event(candidate, 'https://cms.example', { ...moved, destination: null }));
  bridge.receive(
    event(candidate, 'https://cms.example', {
      ...moved,
      destination: { ...destination, kind: 'unknown' },
    }),
  );
  bridge.receive(event(candidate, 'https://cms.example', { ...moved, action: 'delete' }));

  expect(onAction).toHaveBeenCalledOnce();
  expect(onAction).toHaveBeenCalledWith(moved);
  expect(rejected.mock.calls.map(([reason]) => reason)).toEqual([
    'malformed',
    'malformed',
    'malformed',
  ]);
});

test('interaction mode and navigation intents cross only the current connected bridge', () => {
  const parent = frame();
  const onMode = vi.fn();
  const child = createCanvasChildBridge({
    manifest,
    parent,
    origin: 'https://cms.example',
    onMode,
    listen: false,
  });
  child.start();
  child.receive(
    event(parent, 'https://cms.example', {
      ...ready,
      type: 'handover:canvas:mode',
      mode: 'interact',
    }),
  );
  expect(onMode).toHaveBeenCalledWith('interact');
  expect(
    child.navigate({
      kind: 'link',
      href: 'https://cms.example/de/home',
      newTab: false,
      download: false,
    }),
  ).toBe(true);
  expect(parent.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'handover:canvas:navigate',
      kind: 'link',
      href: 'https://cms.example/de/home',
    }),
    'https://cms.example',
  );

  const candidate = frame();
  const onNavigate = vi.fn();
  const rejected = vi.fn();
  const bridge = createCanvasParentBridge({
    manifest,
    frame: candidate,
    origin: 'https://cms.example',
    contentVersion: () => 4,
    currentTarget: () => target,
    onCommand: vi.fn(),
    onNavigate,
    onRejected: rejected,
    listen: false,
  });
  bridge.receive(event(candidate, 'https://cms.example', ready));
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
  bridge.receive(event(candidate, 'https://cms.example', navigation));
  bridge.receive(event(candidate, 'https://cms.example', { ...navigation, href: '' }));

  expect(onNavigate).toHaveBeenCalledOnce();
  expect(onNavigate).toHaveBeenCalledWith(navigation);
  expect(rejected).toHaveBeenCalledWith('malformed', expect.anything());
});

test('plain-text capability and editing state cross only the current selected bridge', () => {
  const parent = frame();
  const onTextField = vi.fn();
  const child = createCanvasChildBridge({
    manifest,
    parent,
    origin: 'https://cms.example',
    onTextField,
    listen: false,
  });
  child.start();
  child.receive(
    event(parent, 'https://cms.example', {
      ...ready,
      type: 'handover:canvas:text-field',
      field: { kind: 'text', target, value: 'A brighter coast' },
    }),
  );
  expect(onTextField).toHaveBeenCalledWith({
    kind: 'text',
    target,
    value: 'A brighter coast',
  });
  child.receive(
    event(parent, 'https://cms.example', {
      ...ready,
      type: 'handover:canvas:text-field',
      field: { kind: 'richtext', target, value: '**A brighter coast**', tier: 'basic' },
    }),
  );
  expect(onTextField).toHaveBeenLastCalledWith({
    kind: 'richtext',
    target,
    value: '**A brighter coast**',
    tier: 'basic',
  });
  expect(child.interaction(target, { inlineEditing: true, composing: false })).toBe(true);
  expect(parent.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'handover:canvas:editing',
      target,
      state: { inlineEditing: true, composing: false },
    }),
    'https://cms.example',
  );

  const candidate = frame();
  const onEditing = vi.fn();
  const bridge = createCanvasParentBridge({
    manifest,
    frame: candidate,
    origin: 'https://cms.example',
    contentVersion: () => 4,
    currentTarget: () => target,
    onCommand: vi.fn(),
    onEditing,
    listen: false,
  });
  bridge.receive(event(candidate, 'https://cms.example', ready));
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
  expect(bridge.textField({ kind: 'richtext', target, value: 'Missing tier' } as never)).toBe(
    false,
  );
  bridge.receive(
    event(candidate, 'https://cms.example', {
      ...ready,
      type: 'handover:canvas:editing',
      target,
      state: { inlineEditing: true, composing: true },
    }),
  );
  expect(onEditing).toHaveBeenCalledWith(target, {
    inlineEditing: true,
    composing: true,
  });
});

test('stale commands and targets receive explicit acknowledgements without mutating', () => {
  const candidate = frame();
  const onCommand = vi.fn();
  const bridge = createCanvasParentBridge({
    manifest,
    frame: candidate,
    origin: 'https://cms.example',
    contentVersion: () => 5,
    currentTarget: () => target,
    onCommand,
    listen: false,
  });
  bridge.receive(event(candidate, 'https://cms.example', { ...ready, contentVersion: 5 }));
  bridge.receive(event(candidate, 'https://cms.example', command()));
  bridge.receive(
    event(
      candidate,
      'https://cms.example',
      command({
        commandId: 'command-2',
        contentVersion: 5,
        target: { ...target, address: 'blocks[_id=hero-1].summary' },
      }),
    ),
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

test('a repeated command replays its acknowledgement and never runs twice', async () => {
  const candidate = frame();
  let version = 4;
  const onCommand = vi.fn(() => {
    version = 5;
    return { ok: true as const, contentVersion: version };
  });
  const bridge = createCanvasParentBridge({
    manifest,
    frame: candidate,
    origin: 'https://cms.example',
    contentVersion: () => version,
    currentTarget: () => target,
    onCommand,
    listen: false,
  });
  bridge.receive(event(candidate, 'https://cms.example', ready));
  bridge.receive(event(candidate, 'https://cms.example', command()));
  await settle();
  bridge.receive(event(candidate, 'https://cms.example', command()));
  await settle();
  bridge.receive(
    event(
      candidate,
      'https://cms.example',
      command({ command: { type: 'field', changes: [{ value: 'A different reuse' }] } }),
    ),
  );

  expect(onCommand).toHaveBeenCalledTimes(1);
  expect(candidate.postMessage).toHaveBeenCalledTimes(3);
  expect(candidate.postMessage).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ commandId: 'command-1', ok: true, acceptedVersion: 5 }),
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
  const candidate = frame();
  const fetch = vi.spyOn(globalThis, 'fetch');
  const bridge = createCanvasParentBridge({
    manifest,
    frame: candidate,
    origin: 'https://cms.example',
    contentVersion: () => 4,
    currentTarget: () => target,
    onCommand: () => ({ ok: false, reason: 'readonly' }),
    listen: false,
  });
  bridge.receive(event(candidate, 'https://cms.example', ready));
  bridge.receive(event(candidate, 'https://cms.example', command()));
  await settle();

  expect(candidate.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ commandId: 'command-1', ok: false, reason: 'readonly' }),
    'https://cms.example',
  );
  expect(fetch).not.toHaveBeenCalled();
});

test('the iframe bridge ignores foreign and stale acknowledgements, then accepts its own', async () => {
  const parent = frame();
  const child = createCanvasChildBridge({
    manifest,
    parent,
    origin: 'https://cms.example',
    listen: false,
    commandId: () => 'command-1',
  });
  child.start();
  expect(parent.postMessage).toHaveBeenCalledWith(
    ready,
    'https://cms.example',
    expect.arrayContaining([expect.any(MessagePort)]),
  );

  const pending = child.command(target, {
    type: 'field',
    changes: [{ value: 'A brighter coast' }],
  });
  child.receive(
    event(parent, 'https://attacker.example', {
      ...command(),
      type: 'handover:canvas:ack',
      ok: true,
      acceptedVersion: 5,
      command: undefined,
    }),
  );
  child.receive(
    event(parent, 'https://cms.example', {
      type: 'handover:canvas:ack',
      protocol: 1,
      requestId: 'old-render',
      epoch: 'session-1',
      entry: manifest.entry,
      locale: 'en',
      contentVersion: 4,
      commandId: 'command-1',
      target,
      ok: true,
      acceptedVersion: 5,
    }),
  );
  child.receive(
    event(parent, 'https://cms.example', {
      type: 'handover:canvas:ack',
      protocol: 1,
      requestId: 'render-1',
      epoch: 'session-1',
      entry: manifest.entry,
      locale: 'en',
      contentVersion: 4,
      commandId: 'command-1',
      target,
      ok: true,
      acceptedVersion: 5,
    }),
  );

  await expect(pending).resolves.toEqual(expect.objectContaining({ ok: true, acceptedVersion: 5 }));
  expect(child.contentVersion()).toBe(5);
});

test('a structure node crosses with its optional keys and is refused any key beyond them', () => {
  const candidate = frame();
  const onStructure = vi.fn();
  const bridge = createCanvasParentBridge({
    manifest,
    frame: candidate,
    origin: 'https://cms.example',
    contentVersion: () => 4,
    currentTarget: () => target,
    onCommand: vi.fn(),
    onSelection: vi.fn(),
    onStructure,
    onRejected: vi.fn(),
    listen: false,
  });
  const identity = {
    protocol: 1,
    requestId: manifest.requestId,
    epoch: manifest.epoch,
    entry: manifest.entry,
    locale: manifest.locale,
    contentVersion: manifest.contentVersion,
  };
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
  const send = (nodes: unknown[]) =>
    bridge.receive(
      event(candidate, 'https://cms.example', {
        ...identity,
        type: 'handover:canvas:structure',
        nodes,
      }),
    );
  bridge.receive(event(candidate, 'https://cms.example', ready));

  send([root, node]);
  expect(onStructure).toHaveBeenCalledWith([root, node]);

  send([root, { ...node, named: 'Blocks' }]);
  expect(onStructure).toHaveBeenCalledTimes(1);
});
