import { type mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { session as entrySession, mountWorkspace } from './workspace.fixture';

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
  const session = entrySession({ title: 'Draft' });
  const onform = vi.fn();
  app = mountWorkspace(session, { onform });
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
