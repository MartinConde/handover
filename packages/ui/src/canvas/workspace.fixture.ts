import type { Field } from '@handover/core';
import { type ComponentProps, mount } from 'svelte';
import { vi } from 'vitest';
import { createEntrySession, type EntrySession } from '../editor/entry-session.svelte';
import CanvasWorkspace from './CanvasWorkspace.svelte';
import type { CanvasRendererOptions, CanvasRenderRequest } from './canvas-renderer';

export const fields = [
  { path: ['title'], label: 'Title', type: 'text', required: false },
] satisfies Field[];

export const session = (
  data: Record<string, unknown> = { title: 'Home' },
  form: { fields: Field[]; blocks: Record<string, Field[]> } = { fields, blocks: {} },
) =>
  createEntrySession({ document: 'pages/home', sourceLocale: 'en', data, translations: {}, form });

type Props = ComponentProps<typeof CanvasWorkspace>;

export const workspaceProps = (entry: EntrySession, over: Partial<Props> = {}): Props => ({
  active: true,
  fullscreen: true,
  locale: 'en',
  url: '/',
  request: (): CanvasRenderRequest => ({ url: '/preview', snapshot: {} as never }),
  currentVersion: () => entry.contentVersion('en'),
  entryDocument: { collection: 'pages', id: 'home' },
  ownerLabel: 'Home',
  sourceLocale: 'en',
  session: entry,
  blocks: {},
  onform: () => {},
  onreviewproblems: () => {},
  onnavigateentry: () => {},
  ...over,
});

export const mountWorkspace = (entry: EntrySession, over: Partial<Props> = {}) =>
  mount(CanvasWorkspace, { target: document.body, props: workspaceProps(entry, over) });

export const mockRenderer = () => {
  const renderer = {
    mode: vi.fn(),
    textField: vi.fn(),
    actions: vi.fn(),
    select: vi.fn(),
    uiLocale: vi.fn(),
    problems: vi.fn(),
    render: vi.fn(async () => ({ ok: true })),
    schedule: vi.fn(),
    flushScheduled: vi.fn(),
    pause: vi.fn(),
    dispose: vi.fn(),
  };
  let options: CanvasRendererOptions | undefined;
  vi.doMock('./canvas-renderer', () => ({
    createCanvasRenderer: (given: CanvasRendererOptions) => {
      options = given;
      return renderer;
    },
  }));
  const created = () =>
    vi.waitFor(() => {
      if (!options) throw new Error('Canvas renderer was not created');
      return options;
    });
  return { renderer, created };
};
