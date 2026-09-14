import type { Field } from '@handover/core';
import { flushSync, mount, tick, unmount } from 'svelte';
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

test('switches workspace text and the existing frame title without rendering content again', async () => {
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
  const props = $state({
    active: true,
    locale: 'en',
    uiLocale: 'en' as 'en' | 'de',
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
  });
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
  const session = createEntrySession({
    document: 'pages/home',
    sourceLocale: 'en',
    data: { title: 'Home' },
    translations: {},
    form: { fields, blocks: {} },
  });
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
  const props = $state({
    active: true,
    locale: 'en',
    uiLocale: 'en' as 'en' | 'de',
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
  });
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
