import type { Field } from '@handover/core';
import { mount, unmount } from 'svelte';
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
  document.body.innerHTML = '';
  vi.doUnmock('./canvas-renderer');
});

test('shows renderer chunk failure and retains the editable session in Form', async () => {
  vi.doMock('./canvas-renderer', () => {
    throw new Error('chunk unavailable');
  });
  const session = createEntrySession({
    document: 'pages/home',
    sourceLocale: 'en',
    data: { title: 'Draft' },
    translations: {},
    form: { fields, blocks: {} },
  });
  const onform = vi.fn();
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
      onform,
      onreviewproblems: () => {},
      onnavigateentry: () => {},
    },
  });
  await vi.waitFor(() => expect(document.querySelector('.canvas-failure')).not.toBeNull());
  expect(document.querySelector('.canvas-render-state')?.textContent).not.toBe('Preparing Canvas…');
  expect(document.querySelector('.canvas-failure')?.textContent).toContain(
    'Canvas could not start. Your changes remain in the editor.',
  );
  expect(document.querySelectorAll('.canvas-failure button')).toHaveLength(1);
  expect(document.querySelector('.canvas-failure')?.textContent).not.toContain('Retry');
  document.querySelector<HTMLButtonElement>('.canvas-failure button')?.click();
  expect(onform).toHaveBeenCalledOnce();
  expect(session.snapshot('en')).toEqual({ title: 'Draft' });
});
