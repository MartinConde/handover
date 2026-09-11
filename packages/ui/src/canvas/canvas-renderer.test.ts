import { afterEach, expect, test, vi } from 'vitest';
import { type CanvasRenderRequest, createCanvasRenderer } from './canvas-renderer';

const request = (contentVersion: number): CanvasRenderRequest => ({
  url: '/preview',
  snapshot: {
    mode: 'canvas',
    protocol: 1,
    epoch: 'canvas-session',
    entry: { collection: 'pages', id: 'home' },
    locale: 'en',
    contentVersion,
    snapshots: { en: { title: `Version ${contentVersion}` } },
  },
});

const renderer = (stage: HTMLElement) =>
  createCanvasRenderer({
    stage,
    contentVersion: () => 2,
    currentTarget: () => undefined,
    onCommand: () => ({ ok: false, reason: 'readonly' }),
    renderDelayMs: 200,
  });

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

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
