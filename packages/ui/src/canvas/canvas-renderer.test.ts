import { afterEach, expect, test, vi } from 'vitest';
import { type CanvasRenderRequest, createCanvasRenderer } from './canvas-renderer';

const request = (contentVersion: number, locale = 'en'): CanvasRenderRequest => ({
  url: '/preview',
  snapshot: {
    mode: 'canvas',
    protocol: 1,
    epoch: 'canvas-session',
    entry: { collection: 'pages', id: 'home' },
    locale,
    contentVersion,
    snapshots: { [locale]: { title: `Version ${contentVersion}` } },
  },
});

const renderer = (stage: HTMLElement) =>
  createCanvasRenderer({
    stage,
    contentVersion: () => 2,
    currentTarget: () => undefined,
    uiLocale: () => 'en',
    onCommand: () => ({ ok: false, reason: 'readonly' }),
    renderDelayMs: 200,
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// Fakes the child handshake so `promote()` runs for real, including the editing-interaction gate.
const fakeFrames = new Map<HTMLIFrameElement, { win: Window; doc: Document }>();
const fakeHandshake = () => {
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockImplementation(function (
    this: HTMLIFrameElement,
  ) {
    if (!fakeFrames.has(this))
      fakeFrames.set(this, {
        win: {
          location: { href: 'http://localhost/preview' },
          postMessage: vi.fn(),
          scrollTo: () => {},
          scrollX: 0,
          scrollY: 0,
          innerWidth: 0,
          innerHeight: 0,
        } as unknown as Window,
        doc: document.implementation.createHTMLDocument(),
      });
    return fakeFrames.get(this)?.win ?? null;
  });
  vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockImplementation(function (
    this: HTMLIFrameElement,
  ) {
    return fakeFrames.get(this)?.doc ?? null;
  });
};

/** Drives one candidate through `load` + the ready handshake so it reaches `promote()`. */
const settleCandidate = (
  canvas: ReturnType<typeof createCanvasRenderer>,
  requestId: string,
  contentVersion: number,
  locale = 'en',
) => {
  const frame = canvas.candidateFrame();
  const fake = frame && fakeFrames.get(frame);
  if (!fake) throw new Error('Missing candidate frame');
  const { win, doc } = fake;
  const manifest = {
    mode: 'canvas',
    status: 'success',
    protocol: 1,
    requestId,
    epoch: 'canvas-session',
    entry: { collection: 'pages', id: 'home' },
    locale,
    contentVersion,
  };
  doc.body.innerHTML = `<script type="application/json" data-handover-canvas-manifest>${JSON.stringify(manifest)}</script>`;
  frame.dispatchEvent(new Event('load'));
  const { mode, status, ...identity } = manifest;
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: location.origin,
      source: win,
      data: { ...identity, type: 'handover:canvas:ready' },
    }),
  );
  return { win, doc };
};

test('materializes only the last request after a full quiet period', async () => {
  vi.useFakeTimers();
  const stage = document.createElement('div');
  document.body.append(stage);
  const canvas = renderer(stage);
  const first = vi.fn(() => request(1));
  const last = vi.fn(() => request(2));

  void canvas.schedule(first);
  await vi.advanceTimersByTimeAsync(150);
  void canvas.schedule(last);
  await vi.advanceTimersByTimeAsync(199);
  expect(first).not.toHaveBeenCalled();
  expect(last).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  expect(first).not.toHaveBeenCalled();
  expect(last).toHaveBeenCalledOnce();
  expect(canvas.state()).toMatchObject({ phase: 'rendering', contentVersion: 2 });
  canvas.dispose();
});

test('a prompt render cancels an unmaterialized continuous request', () => {
  vi.useFakeTimers();
  const stage = document.createElement('div');
  document.body.append(stage);
  const canvas = renderer(stage);
  const pending = vi.fn(() => request(1));

  void canvas.schedule(pending);
  void canvas.render(request(2));

  expect(pending).not.toHaveBeenCalled();
  expect(canvas.state()).toMatchObject({ phase: 'rendering', contentVersion: 2 });
  canvas.dispose();
});

test('an editing boundary launches the pending final request immediately', () => {
  vi.useFakeTimers();
  const stage = document.createElement('div');
  document.body.append(stage);
  const canvas = renderer(stage);
  const pending = vi.fn(() => request(2));

  void canvas.schedule(pending);
  expect(canvas.flushScheduled()).toBe(true);

  expect(pending).toHaveBeenCalledOnce();
  expect(canvas.state()).toMatchObject({ phase: 'rendering', contentVersion: 2 });
  canvas.dispose();
});

test('updates candidate frame presentation when the UI locale changes', () => {
  const stage = document.createElement('div');
  document.body.append(stage);
  let uiLocale: 'en' | 'de' = 'en';
  const canvas = createCanvasRenderer({
    stage,
    contentVersion: () => 2,
    currentTarget: () => undefined,
    uiLocale: () => uiLocale,
    onCommand: () => ({ ok: false, reason: 'readonly' }),
  });

  void canvas.render(request(2));
  const frame = canvas.candidateFrame();
  expect(frame?.title).toBe('The page as the site would serve it');

  uiLocale = 'de';
  canvas.uiLocale(uiLocale);

  expect(canvas.candidateFrame()).toBe(frame);
  expect(frame?.title).toBe('Die Seite, wie sie von der Website ausgeliefert würde');
  canvas.dispose();
});

test('reloading the active frame clears a lost editing flag so the candidate promotes', () => {
  fakeHandshake();
  const stage = document.createElement('div');
  document.body.append(stage);
  let ids = 0;
  const canvas = createCanvasRenderer({
    stage,
    contentVersion: () => 4,
    currentTarget: () => undefined,
    uiLocale: () => 'en',
    onCommand: () => ({ ok: false, reason: 'readonly' }),
    requestId: () => `req-${++ids}`,
  });

  void canvas.render(request(4));
  const { doc } = settleCandidate(canvas, 'req-1', 4);
  // The reloaded document would lose this; the fake keeps it so only the load event can unblock.
  const heading = doc.createElement('h1');
  heading.setAttribute('data-handover-inline-editing', '');
  doc.body.append(heading);
  // A stop the parent never received (e.g. the frame reloaded mid-edit) leaves this stuck true.
  canvas.setInteractionState({ inlineEditing: true, composing: false });

  void canvas.render(request(4));
  expect(canvas.state().phase).toBe('rendering');

  canvas.activeFrame()?.dispatchEvent(new Event('load'));
  settleCandidate(canvas, 'req-2', 4);
  expect(canvas.state().phase).toBe('ready');
  canvas.dispose();
});

test('a stop accepted after a locale switch still lets the waiting candidate promote', () => {
  fakeHandshake();
  const stage = document.createElement('div');
  document.body.append(stage);
  let ids = 0;
  let version = 4;
  const target = { document: { collection: 'pages', id: 'home' }, locale: 'en', address: 'title' };
  const canvas = createCanvasRenderer({
    stage,
    contentVersion: () => version,
    currentTarget: () => target,
    uiLocale: () => 'en',
    onCommand: () => ({ ok: false, reason: 'readonly' }),
    requestId: () => `req-${++ids}`,
  });

  // 1. Render `en` at v4 so it becomes active.
  void canvas.render(request(4, 'en'));
  const en = settleCandidate(canvas, 'req-1', 4, 'en');
  expect(canvas.state().phase).toBe('ready');
  const heading = en.doc.createElement('h1');
  heading.setAttribute('data-handover-inline-editing', '');
  en.doc.body.append(heading);

  // 2. An editor starts in the active `en` frame.
  const editing = (inlineEditing: boolean, contentVersion: number) => ({
    protocol: 1,
    requestId: 'req-1',
    epoch: 'canvas-session',
    entry: { collection: 'pages', id: 'home' },
    locale: 'en',
    type: 'handover:canvas:editing',
    target,
    state: { inlineEditing, composing: false },
    interactionId: 'i1',
    contentVersion,
  });
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: location.origin,
      source: en.win,
      data: editing(true, 4),
    }),
  );

  // 3. The admin switches locale; `de`'s own version is lower than `en`'s.
  version = 0;

  // 4. A `de` candidate reaches ready but stays blocked: the editor is still open.
  void canvas.render(request(0, 'de'));
  settleCandidate(canvas, 'req-2', 0, 'de');
  expect(canvas.state().phase).toBe('rendering');
  expect(canvas.candidateFrame()).toBeDefined();

  // 5. The stop arrives from the still-active `en` frame, at `en`'s own version.
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: location.origin,
      source: en.win,
      data: editing(false, 4),
    }),
  );

  // 6. Accepted despite the admin now being on a lower-versioned locale: the candidate promotes.
  expect(canvas.state().phase).toBe('ready');
  expect(canvas.candidateFrame()).toBeUndefined();
  canvas.dispose();
});

test('a lost stop with no editor left in the page lets the candidate promote and stay', async () => {
  fakeHandshake();
  const stage = document.createElement('div');
  document.body.append(stage);
  let ids = 0;
  const target = { document: { collection: 'pages', id: 'home' }, locale: 'en', address: 'title' };
  const canvas = createCanvasRenderer({
    stage,
    contentVersion: () => 4,
    currentTarget: () => target,
    uiLocale: () => 'en',
    onCommand: () => ({ ok: false, reason: 'readonly' }),
    requestId: () => `req-${++ids}`,
    // The workspace schedules a render on every stop; a call mid-promote would supersede the frame.
    onInteractionChange: (state) => {
      if (!state.inlineEditing) void canvas.render(request(4));
    },
  });

  void canvas.render(request(4));
  const first = settleCandidate(canvas, 'req-1', 4);
  // The link editor opened, then its stop was lost; the page has no editing marker left.
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: location.origin,
      source: first.win,
      data: {
        protocol: 1,
        requestId: 'req-1',
        epoch: 'canvas-session',
        entry: { collection: 'pages', id: 'home' },
        locale: 'en',
        type: 'handover:canvas:editing',
        target,
        state: { inlineEditing: true, composing: false },
        interactionId: 'i1',
        contentVersion: 4,
      },
    }),
  );

  const second = canvas.render(request(4));
  const promoted = canvas.candidateFrame();
  settleCandidate(canvas, 'req-2', 4);

  // The report re-renders after the promote, so req-3 is rendering behind the promoted frame.
  await expect(second).resolves.toMatchObject({ ok: true, requestId: 'req-2' });
  expect(canvas.activeFrame()).toBe(promoted);
  expect(promoted?.isConnected).toBe(true);
  canvas.dispose();
});

const lostStopCanvas = (onInteractionChange?: () => void) => {
  fakeHandshake();
  const stage = document.createElement('div');
  document.body.append(stage);
  let ids = 0;
  const target = { document: { collection: 'pages', id: 'home' }, locale: 'en', address: 'title' };
  const onSelectionChange = vi.fn();
  const canvas = createCanvasRenderer({
    stage,
    contentVersion: () => 4,
    currentTarget: () => target,
    uiLocale: () => 'en',
    onCommand: () => ({ ok: false, reason: 'readonly' }),
    requestId: () => `req-${++ids}`,
    onSelectionChange,
    onInteractionChange,
  });
  void canvas.render(request(4));
  const first = settleCandidate(canvas, 'req-1', 4);
  const identity = {
    protocol: 1,
    requestId: 'req-1',
    epoch: 'canvas-session',
    entry: { collection: 'pages', id: 'home' },
    locale: 'en',
    contentVersion: 4,
  };
  const post = (data: Record<string, unknown>) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: location.origin,
        source: first.win,
        data: { ...identity, ...data },
      }),
    );
  const editor = first.doc.createElement('h1');
  editor.setAttribute('data-handover-inline-editing', '');
  first.doc.body.append(editor);
  post({
    type: 'handover:canvas:editing',
    target,
    state: { inlineEditing: true, composing: false },
    interactionId: 'i1',
  });
  // The candidate is ready while the editor still runs, so it waits.
  void canvas.render(request(4));
  const waiting = canvas.candidateFrame();
  settleCandidate(canvas, 'req-2', 4);
  // The editor closes and its stop is lost; the next thing the page says is a click.
  editor.remove();
  const selection = { kind: 'field', target };
  const click = () => post({ type: 'handover:canvas:selection', selection });
  return { canvas, waiting, click, selection, onSelectionChange };
};

test('a lost stop while a candidate waits lets it promote on the next page message', () => {
  const { canvas, waiting, click, selection, onSelectionChange } = lostStopCanvas();
  expect(canvas.state().phase).toBe('rendering');

  click();

  expect(onSelectionChange).toHaveBeenCalledWith(selection);
  expect(canvas.state().phase).toBe('ready');
  expect(canvas.activeFrame()).toBe(waiting);
  canvas.dispose();
});

test('a lost stop cleared silently is reported once, after the candidate is active', () => {
  const reports: (HTMLIFrameElement | undefined)[] = [];
  let canvas: ReturnType<typeof createCanvasRenderer> | undefined;
  const setup = lostStopCanvas(() => reports.push(canvas?.activeFrame()));
  canvas = setup.canvas;
  reports.length = 0;

  setup.click();

  expect(reports).toEqual([setup.waiting]);
  canvas.dispose();
});
