import type { Field } from '@handover/core';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { createEntrySession } from '../editor/entry-session.svelte';
import CanvasWorkspace from './CanvasWorkspace.svelte';
import type { CanvasStructureNode } from './canvas-bridge';
import type { CanvasRenderRequest } from './canvas-renderer';

const fields = [
  { path: ['title'], label: 'Title', type: 'text', required: false },
] satisfies Field[];
let app: ReturnType<typeof mount>;
afterEach(() => {
  if (app) unmount(app);
  document.body.innerHTML = '';
  vi.doUnmock('./canvas-renderer');
});

test('Structure uses one tree focus and navigates visible nested rows', async () => {
  let options: import('./canvas-renderer').CanvasRendererOptions | undefined;
  vi.doMock('./canvas-renderer', () => ({
    createCanvasRenderer: (given: typeof options) => {
      options = given;
      return {
        render: vi.fn(),
        mode: vi.fn(),
        textField: vi.fn(),
        actions: vi.fn(),
        select: vi.fn(),
        uiLocale: vi.fn(),
        problems: vi.fn(),
        pause: vi.fn(),
        flushScheduled: vi.fn(),
        dispose: vi.fn(),
      };
    },
  }));
  const session = createEntrySession({
    document: 'pages/home',
    sourceLocale: 'en',
    data: { title: 'Draft' },
    translations: {},
    form: { fields, blocks: {} },
  });
  app = mount(CanvasWorkspace, {
    target: document.body,
    props: {
      active: true,
      fullscreen: true,
      locale: 'en',
      url: '/',
      request: (): CanvasRenderRequest => ({ url: '/preview', snapshot: {} as never }),
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
  await vi.waitFor(() => expect(options).toBeDefined());
  const target = (address: string) => ({
    document: { collection: 'pages', id: 'home' },
    locale: 'en',
    address,
  });
  const nodes: CanvasStructureNode[] = [
    {
      id: 'root',
      kind: 'list',
      label: 'Page',
      target: target('blocks'),
      depth: 1,
      position: 1,
      setSize: 1,
      occurrences: 1,
    },
    {
      id: 'wrapper',
      parentId: 'root',
      kind: 'list',
      label: 'Blocks',
      target: target('blocks[abc].blocks'),
      depth: 2,
      position: 1,
      setSize: 2,
      occurrences: 1,
    },
    {
      id: 'title',
      parentId: 'wrapper',
      kind: 'field',
      label: 'Title',
      target: target('title'),
      depth: 3,
      position: 1,
      setSize: 2,
      occurrences: 1,
    },
    {
      id: 'body',
      parentId: 'wrapper',
      kind: 'field',
      label: 'Body',
      target: target('body'),
      depth: 3,
      position: 2,
      setSize: 2,
      occurrences: 1,
    },
    {
      id: 'footer',
      parentId: 'root',
      kind: 'field',
      label: 'Footer',
      target: target('footer'),
      depth: 2,
      position: 2,
      setSize: 2,
      occurrences: 1,
    },
  ];
  options?.onStructureChange?.(nodes);
  flushSync();
  const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'));
  expect(rows().map((row) => row.textContent?.trim())).toEqual(['Page', 'Title', 'Body', 'Footer']);
  expect(rows().map((row) => row.tabIndex)).toEqual([0, -1, -1, -1]);
  expect(rows()[1]?.getAttribute('aria-posinset')).toBe('1');
  expect(rows()[1]?.getAttribute('aria-setsize')).toBe('3');
  const groupId = rows()[0]?.getAttribute('aria-owns');
  expect(groupId).toBeTruthy();
  expect(document.getElementById(groupId ?? '')?.getAttribute('role')).toBe('group');
  rows()[0]?.focus();
  rows()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await tick();
  expect(document.activeElement).toBe(rows()[1]);
  rows()[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  await tick();
  expect(document.activeElement).toBe(rows()[3]);
  rows()[3]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  await tick();
  expect(document.activeElement).toBe(rows()[0]);
  rows()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await tick();
  expect(document.activeElement).toBe(rows()[1]);
  rows()[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await tick();
  expect(document.activeElement).toBe(rows()[0]);
  rows()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await tick();
  expect(rows().map((row) => row.textContent?.trim())).toEqual(['Page']);
  expect(rows()[0]?.getAttribute('aria-expanded')).toBe('false');
  rows()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await tick();
  expect(rows()).toHaveLength(4);
  expect(rows().map((row) => row.tabIndex)).toEqual([0, -1, -1, -1]);
});
