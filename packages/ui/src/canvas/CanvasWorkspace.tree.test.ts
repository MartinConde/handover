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
let render: ReturnType<typeof vi.fn>;
afterEach(() => {
  if (app) unmount(app);
  document.body.innerHTML = '';
  vi.doUnmock('./canvas-renderer');
});

/** Mounts CanvasWorkspace with a mocked renderer and returns its onStructureChange hook. */
async function mountWithMockedRenderer(
  session: ReturnType<typeof createEntrySession>,
  blocks: Record<string, Field[]> = {},
) {
  let options: import('./canvas-renderer').CanvasRendererOptions | undefined;
  vi.doMock('./canvas-renderer', () => ({
    createCanvasRenderer: (given: typeof options) => {
      options = given;
      render = vi.fn();
      return {
        render,
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
      blocks,
      onform: () => {},
      onreviewproblems: () => {},
      onnavigateentry: () => {},
    },
  });
  await vi.waitFor(() => expect(options).toBeDefined());
  if (!options) throw new Error('Canvas renderer was not created');
  return options;
}

const targetFor = (address: string) => ({
  document: { collection: 'pages', id: 'home' },
  locale: 'en',
  address,
});

test('Structure uses one tree focus and navigates visible nested rows', async () => {
  const session = createEntrySession({
    document: 'pages/home',
    sourceLocale: 'en',
    data: { title: 'Draft' },
    translations: {},
    form: { fields, blocks: {} },
  });
  const options = await mountWithMockedRenderer(session);
  const nodes: CanvasStructureNode[] = [
    {
      id: 'root',
      kind: 'list',
      label: 'Page',
      target: targetFor('blocks'),
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
      target: targetFor('blocks[abc].blocks'),
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
      target: targetFor('title'),
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
      target: targetFor('body'),
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
      target: targetFor('footer'),
      depth: 2,
      position: 2,
      setSize: 2,
      occurrences: 1,
    },
  ];
  options.onStructureChange?.(nodes);
  flushSync();
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  const label = (row: HTMLElement) =>
    row.querySelector('.canvas-structure-name')?.textContent?.trim();
  expect(rows().map(label)).toEqual(['Page', 'Title', 'Body', 'Footer']);
  expect(rows().map((row) => row.tabIndex)).toEqual([0, -1, -1, -1]);
  expect(rows()[1]?.getAttribute('aria-posinset')).toBe('1');
  expect(rows()[1]?.getAttribute('aria-setsize')).toBe('3');
  const group = rows()[0]?.querySelector(':scope > [role="group"]');
  expect(group?.getAttribute('role')).toBe('group');
  expect(group?.querySelectorAll('[role="treeitem"]')).toHaveLength(3);
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
  expect(rows().map(label)).toEqual(['Page']);
  expect(rows()[0]?.getAttribute('aria-expanded')).toBe('false');
  rows()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await tick();
  expect(rows()).toHaveLength(4);
  expect(rows().map((row) => row.tabIndex)).toEqual([0, -1, -1, -1]);
});

/** The accessible children a `tree`/`group` owns: the nearest role-bearing descendant on each
 * branch, walking down through elements that carry no role of their own. */
function ownedChildRoles(root: Element): string[] {
  const roles: string[] = [];
  const walk = (element: Element) => {
    for (const child of Array.from(element.children)) {
      const role = child.getAttribute('role') ?? (child.tagName === 'BUTTON' ? 'button' : null);
      if (role) roles.push(role);
      else walk(child);
    }
  };
  walk(root);
  return roles;
}

const movableBlockFields = {
  section: [{ path: ['title'], label: 'Title', type: 'text', required: false }],
} satisfies Record<string, Field[]>;

function movableSession() {
  return createEntrySession({
    document: 'pages/home',
    sourceLocale: 'en',
    data: {
      blocks: [
        { _id: 'a', _type: 'section', title: 'One' },
        { _id: 'b', _type: 'section', title: 'Two' },
      ],
    },
    translations: {},
    form: {
      fields: [
        { path: ['blocks'], label: 'Blocks', type: 'blocks', required: false, types: ['section'] },
      ],
      blocks: movableBlockFields,
    },
  });
}

const movableNodes: CanvasStructureNode[] = [
  {
    id: 'root',
    kind: 'list',
    label: 'Page',
    target: targetFor('blocks'),
    depth: 1,
    position: 1,
    setSize: 1,
    occurrences: 1,
  },
  {
    id: 'a',
    parentId: 'root',
    kind: 'block',
    label: 'One',
    target: targetFor('blocks[_id=a]'),
    depth: 2,
    position: 1,
    setSize: 2,
    occurrences: 1,
  },
  {
    id: 'b',
    parentId: 'root',
    kind: 'block',
    label: 'Two',
    target: targetFor('blocks[_id=b]'),
    depth: 2,
    position: 2,
    setSize: 2,
    occurrences: 1,
  },
];

test('the structure tree owns only treeitem/group children, even with a movable row', async () => {
  const options = await mountWithMockedRenderer(movableSession(), movableBlockFields);
  options.onStructureChange?.(movableNodes);
  flushSync();

  expect(document.querySelector('.canvas-structure-drag')).not.toBeNull();
  const tree = document.querySelector('.canvas-structure-tree');
  if (!tree) throw new Error('structure tree not rendered');
  for (const root of [tree, ...Array.from(tree.querySelectorAll('[role="group"]'))]) {
    for (const role of ownedChildRoles(root)) expect(['treeitem', 'group']).toContain(role);
  }
  for (const group of Array.from(tree.querySelectorAll('[role="group"]'))) {
    let ancestor: Element | null = group.parentElement;
    while (ancestor && !ancestor.getAttribute('role')) ancestor = ancestor.parentElement;
    expect(ancestor?.getAttribute('role')).toBe('treeitem');
  }
});

test('a keydown on the drag handle does not also move tree focus', async () => {
  const options = await mountWithMockedRenderer(movableSession(), movableBlockFields);
  options.onStructureChange?.(movableNodes);
  flushSync();

  const handle = document.querySelector<HTMLElement>('.canvas-structure-drag');
  if (!handle) throw new Error('drag handle not rendered');
  handle.focus();
  expect(document.activeElement).toBe(handle);
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await tick();
  expect(document.activeElement).toBe(handle);
});

test('Enter on a treeitem selects it, matching a click', async () => {
  const options = await mountWithMockedRenderer(movableSession(), movableBlockFields);
  options.onStructureChange?.(movableNodes);
  flushSync();

  const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  const one = rows().find((row) => row.getAttribute('data-target-address') === 'blocks[_id=a]');
  if (!one) throw new Error('row for block "a" not rendered');
  one.focus();
  one.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  flushSync();
  expect(one.getAttribute('aria-current')).toBe('true');
});

test('a plain field sibling keeps its position among promoted block rows', async () => {
  const options = await mountWithMockedRenderer(movableSession(), movableBlockFields);
  const nodes: CanvasStructureNode[] = [
    ...movableNodes,
    {
      id: 'caption',
      parentId: 'root',
      kind: 'field',
      label: 'Caption',
      target: targetFor('caption'),
      depth: 2,
      position: 3,
      setSize: 3,
      occurrences: 1,
    },
  ];
  options.onStructureChange?.(nodes);
  flushSync();

  const label = (row: Element) => row.querySelector('.canvas-structure-name')?.textContent?.trim();
  const names = Array.from(document.querySelectorAll('[role="treeitem"]')).map(label);
  expect(names).toEqual(['Page', 'One', 'Two', 'Caption']);
});

test('a refused drag redraws the page from the session', async () => {
  const options = await mountWithMockedRenderer(movableSession(), movableBlockFields);
  options.onStateChange?.({ phase: 'ready', requestId: 'r1', contentVersion: 0 });
  flushSync();
  const renders = render.mock.calls.length;

  options.onAction?.({
    action: 'move',
    selection: { kind: 'block', target: targetFor('blocks[_id=a]') },
    destination: { kind: 'block', target: targetFor('blocks[_id=gone]') },
  } as never);
  await vi.waitFor(() => expect(render.mock.calls.length).toBe(renders + 1));
});
