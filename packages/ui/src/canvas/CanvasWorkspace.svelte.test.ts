import type { Field } from '@handover/core';
import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { createEntrySession } from '../editor/entry-session.svelte';
import CanvasWorkspace from './CanvasWorkspace.svelte';
import type { CanvasRenderRequest } from './canvas-renderer';

const fields = [
  { path: ['title'], label: 'Title', type: 'text', required: false },
] satisfies Field[];

let app: ReturnType<typeof mount>;

afterEach(() => {
  if (app) unmount(app);
  vi.useRealTimers();
  document.body.innerHTML = '';
});

test('checks locale and version before materializing, then lazily renders the final burst', async () => {
  const session = createEntrySession({
    document: 'pages/home',
    sourceLocale: 'en',
    data: { title: 'Home' },
    translations: {},
    form: { fields, blocks: {} },
  });
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

  app = mount(CanvasWorkspace, {
    target: document.body,
    props: {
      active: true,
      locale: 'en',
      url: '/',
      request: materialize,
      currentVersion: () => session.contentVersion('en'),
      entryDocument: { collection: 'pages', id: 'home' },
      ownerLabel: 'Home',
      sourceLocale: 'en',
      session,
      blocks: {},
      onform: () => {},
      onreviewproblems: () => {},
      onnavigateentry: () => {},
    },
  });
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
  const session = createEntrySession({
    document: 'pages/home',
    sourceLocale: 'en',
    data: { title: 'Home' },
    translations: {},
    form: { fields, blocks: {} },
  });
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
  app = mount(CanvasWorkspace, {
    target: document.body,
    props: {
      active: true,
      locale: 'en',
      url: '/',
      request: materialize,
      currentVersion: () => session.contentVersion('en'),
      entryDocument: { collection: 'pages', id: 'home' },
      ownerLabel: 'Home',
      sourceLocale: 'en',
      session,
      blocks: {},
      onform: () => {},
      onreviewproblems: () => {},
      onnavigateentry: () => {},
    },
  });
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
