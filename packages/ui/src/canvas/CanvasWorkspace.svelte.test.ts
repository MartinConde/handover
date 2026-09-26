import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import CanvasWorkspace from './CanvasWorkspace.svelte';
import type { CanvasRenderRequest } from './canvas-renderer';
import {
  session as entrySession,
  mockRenderer,
  mountWorkspace,
  workspaceProps,
} from './workspace.fixture';

let app: ReturnType<typeof mount>;

afterEach(async () => {
  // Unmounted first, the workspace drops its lazy renderer import instead of building one.
  if (app) unmount(app);
  // Settle that import before a later test mocks the same module.
  await import('./canvas-renderer');
  vi.useRealTimers();
  document.body.innerHTML = '';
  vi.doUnmock('./canvas-renderer');
});

test('checks locale and version before materializing, then lazily renders the final burst', async () => {
  const session = entrySession();
  const materialize = vi.fn(
    (): CanvasRenderRequest => ({
      url: '/preview',
      snapshot: {
        mode: 'canvas',
        protocol: 1,
        epoch: 'canvas-session',
        entry: { collection: 'pages', id: 'home' },
        locale: 'en',
        contentVersion: session.contentVersion('en'),
        snapshots: session.renderSnapshots(),
      },
    }),
  );

  app = mountWorkspace(session, { fullscreen: undefined, request: materialize });
  await vi.waitFor(() => expect(materialize).toHaveBeenCalledOnce());

  void app.schedule('continuous');
  await tick();
  expect(materialize).toHaveBeenCalledOnce();

  vi.useFakeTimers();
  session.fieldCommand('en', {
    address: 'title',
    contentVersion: session.contentVersion('en'),
    changes: [{ path: [], value: 'First' }],
  });
  void app.schedule('continuous');
  await tick();
  await vi.advanceTimersByTimeAsync(150);
  session.fieldCommand('en', {
    address: 'title',
    contentVersion: session.contentVersion('en'),
    changes: [{ path: [], value: 'Final' }],
  });
  void app.schedule('continuous');
  await tick();
  await vi.advanceTimersByTimeAsync(199);
  expect(materialize).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(1);
  expect(materialize).toHaveBeenCalledTimes(2);
  expect(materialize.mock.results[1]?.value.snapshot.snapshots.en).toMatchObject({
    title: 'Final',
  });
});

test('a discrete completion launches the pending version without rebuilding it', async () => {
  const session = entrySession();
  const materialize = vi.fn(
    (): CanvasRenderRequest => ({
      url: '/preview',
      snapshot: {
        mode: 'canvas',
        protocol: 1,
        epoch: 'canvas-session',
        entry: { collection: 'pages', id: 'home' },
        locale: 'en',
        contentVersion: session.contentVersion('en'),
        snapshots: session.renderSnapshots(),
      },
    }),
  );
  app = mountWorkspace(session, { fullscreen: undefined, request: materialize });
  await vi.waitFor(() => expect(materialize).toHaveBeenCalledOnce());
  vi.useFakeTimers();

  session.fieldCommand('en', {
    address: 'title',
    contentVersion: session.contentVersion('en'),
    changes: [{ path: [], value: 'Finished' }],
  });
  void app.schedule('continuous');
  await tick();
  expect(materialize).toHaveBeenCalledOnce();

  void app.schedule('discrete');
  expect(materialize).toHaveBeenCalledTimes(2);
  expect(materialize.mock.results[1]?.value.snapshot.snapshots.en).toMatchObject({
    title: 'Finished',
  });
});

test('switches workspace text and the existing frame title without rendering content again', async () => {
  const session = entrySession();
  const materialize = vi.fn(
    (): CanvasRenderRequest => ({
      url: '/preview',
      snapshot: {
        mode: 'canvas',
        protocol: 1,
        epoch: 'canvas-session',
        entry: { collection: 'pages', id: 'home' },
        locale: 'en',
        contentVersion: session.contentVersion('en'),
        snapshots: session.renderSnapshots(),
      },
    }),
  );
  const props = $state(workspaceProps(session, { uiLocale: 'en', request: materialize }));
  app = mount(CanvasWorkspace, { target: document.body, props });
  await vi.waitFor(() => expect(materialize).toHaveBeenCalledOnce());
  const frame = document.querySelector('iframe');

  expect(frame?.title).toBe('The page as the site would serve it');
  expect(document.querySelector('.canvas-panel-toggle span')?.textContent).toBe('Structure');

  props.uiLocale = 'de';
  flushSync();

  expect(document.querySelector('iframe')).toBe(frame);
  expect(frame?.title).toBe('Die Seite, wie sie von der Website ausgeliefert würde');
  expect(document.querySelector('.canvas-panel-toggle span')?.textContent).toBe('Struktur');
  expect(materialize).toHaveBeenCalledOnce();
  expect(session.snapshot('en')).toEqual({ title: 'Home' });
});

test('reformats retained renderer recovery while preserving exact diagnostic detail', async () => {
  const session = entrySession();
  const materialize = vi.fn(
    (): CanvasRenderRequest => ({
      url: 'https://outside.example/preview',
      snapshot: {
        mode: 'canvas',
        protocol: 1,
        epoch: 'canvas-session',
        entry: { collection: 'pages', id: 'home' },
        locale: 'en',
        contentVersion: session.contentVersion('en'),
        snapshots: session.renderSnapshots(),
      },
    }),
  );
  const props = $state(
    workspaceProps(session, { fullscreen: undefined, uiLocale: 'en', request: materialize }),
  );
  app = mount(CanvasWorkspace, { target: document.body, props });
  await vi.waitFor(() =>
    expect(document.querySelector('.canvas-failure')?.textContent).toContain(
      'Canvas could not start the page update.',
    ),
  );

  expect(document.querySelector('.canvas-failure small')?.textContent).toBe(
    'Canvas render URL must be same-origin.',
  );

  props.uiLocale = 'de';
  flushSync();

  expect(document.querySelector('.canvas-failure')?.textContent).toContain(
    'Canvas konnte die Seitenaktualisierung nicht starten.',
  );
  expect(document.querySelector('.canvas-failure small')?.textContent).toBe(
    'Canvas render URL must be same-origin.',
  );
  expect(materialize).toHaveBeenCalledOnce();
});

test('Split shows the page to look at: no editing, Inspector or navigation until Canvas', async () => {
  const { renderer, created } = mockRenderer();
  const session = entrySession();
  const props = $state(workspaceProps(session, { fullscreen: false, onnavigateentry: vi.fn() }));
  app = mount(CanvasWorkspace, { target: document.body, props });
  const options = await created();
  options.onStateChange?.({ phase: 'ready', requestId: 'r1', contentVersion: 0 });
  flushSync();

  expect(renderer.mode).toHaveBeenLastCalledWith('interact');
  // A shared global is the selection that would open the Inspector on its own in Canvas.
  options.onSelectionChange?.({
    kind: 'field',
    target: { document: { collection: 'globals', id: 'site' }, locale: 'en', address: 'name' },
  });
  await options.onNavigate?.({
    kind: 'form',
    href: 'http://localhost/contact',
    method: 'post',
  } as never);
  flushSync();
  expect(document.querySelector('.canvas-workarea.has-inspector')).toBeNull();
  expect(document.querySelector('.canvas-navigation-notice')).toBeNull();

  props.fullscreen = true;
  flushSync();
  expect(renderer.mode).toHaveBeenLastCalledWith('edit');
  vi.doUnmock('./canvas-renderer');
});

test('does not re-post identical validation problems on every keystroke', async () => {
  const { renderer, created } = mockRenderer();
  const session = entrySession(
    { title: '', body: '' },
    {
      fields: [
        { path: ['title'], label: 'Title', type: 'text', required: true },
        { path: ['body'], label: 'Body', type: 'text', required: false },
      ],
      blocks: {},
    },
  );
  app = mountWorkspace(session);
  const options = await created();
  options.onStateChange?.({ phase: 'ready', requestId: 'r1', contentVersion: 0 });
  flushSync();
  const callsAfterReady = renderer.problems.mock.calls.length;
  expect(callsAfterReady).toBeGreaterThan(0);

  session.fieldCommand('en', {
    address: 'body',
    contentVersion: session.contentVersion('en'),
    changes: [{ path: [], value: 'x' }],
  });
  flushSync();

  expect(renderer.problems).toHaveBeenCalledTimes(callsAfterReady);
  vi.doUnmock('./canvas-renderer');
});

test('reviews a missing unrendered field in the canvas inspector and clears validation after editing', async () => {
  const session = entrySession(
    { title: '' },
    { fields: [{ path: ['title'], label: 'Title', type: 'text', required: true }], blocks: {} },
  );
  const leaveCanvas = vi.fn();
  app = mountWorkspace(session, { onform: leaveCanvas, onreviewproblems: leaveCanvas });
  await tick();
  document.querySelector<HTMLButtonElement>('.canvas-validation button')?.click();
  await tick();
  const input = document.querySelector<HTMLInputElement>('.canvas-inspector input');
  expect(input).not.toBeNull();
  expect(input?.getAttribute('aria-invalid')).toBe('true');
  expect(leaveCanvas).not.toHaveBeenCalled();
  if (input) {
    input.value = 'Ready';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await tick();
  expect(session.snapshot('en').title).toBe('Ready');
  expect(document.querySelector('.canvas-validation')).toBeNull();
  expect(input?.getAttribute('aria-invalid')).not.toBe('true');
});

test('Review fields in Live preview hands off to the Form review instead of opening a second Inspector', async () => {
  const session = entrySession(
    { title: '' },
    { fields: [{ path: ['title'], label: 'Title', type: 'text', required: true }], blocks: {} },
  );
  const reviewProblems = vi.fn();
  app = mountWorkspace(session, { fullscreen: false, onreviewproblems: reviewProblems });
  await tick();
  document.querySelector<HTMLButtonElement>('.canvas-validation button')?.click();
  await tick();
  expect(reviewProblems).toHaveBeenCalledOnce();
  expect(document.querySelector('.canvas-inspector')).toBeNull();
});

test('the reviewed-problems list exposes a role for its ungrouped buttons', async () => {
  const session = entrySession(
    { title: '' },
    { fields: [{ path: ['title'], label: 'Title', type: 'text', required: true }], blocks: {} },
  );
  app = mountWorkspace(session);
  await tick();
  document.querySelector<HTMLButtonElement>('.canvas-validation button')?.click();
  await tick();
  expect(document.querySelector('.canvas-validation-issues')?.getAttribute('role')).toBe('group');
});
