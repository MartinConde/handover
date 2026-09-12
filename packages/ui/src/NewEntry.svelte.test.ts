import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import NewEntry from './NewEntry.svelte';

let app: ReturnType<typeof mount>;

afterEach(() => {
  unmount(app);
  vi.unstubAllGlobals();
});

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

test('creation is a modal keyboard boundary with a predictable first control', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ entries: [] })),
  );
  app = mount(NewEntry, {
    target: document.body,
    props: { collection: 'pages', onclose: () => {} },
  });
  await settle();

  const dialog = document.querySelector<HTMLDialogElement>('[aria-labelledby="new-entry-h"]');
  const title = document.querySelector<HTMLInputElement>('#new-title');
  const create = document.querySelector<HTMLButtonElement>('button[type="submit"]');
  expect(dialog?.getAttribute('aria-modal')).toBe('true');
  expect(document.activeElement).toBe(title);

  create?.focus();
  create?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
  );
  expect(document.activeElement).toBe(title);
  title?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
  );
  expect(document.activeElement).toBe(create);
});

test('creation cannot be dismissed while its write is in flight', async () => {
  const writing = deferred<Response>();
  const close = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) =>
      url === '/admin/api/entries/pages' && init?.method === 'POST'
        ? writing.promise
        : Promise.resolve(Response.json({ entries: [] })),
    ),
  );
  app = mount(NewEntry, {
    target: document.body,
    props: { collection: 'pages', onclose: close },
  });
  await settle();

  const title = document.querySelector<HTMLInputElement>('#new-title');
  if (!title) throw new Error('title missing');
  title.value = 'A page';
  title.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
  flushSync();

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLButtonElement>('.actions .btn')?.disabled).toBe(true);

  writing.resolve(new Response('refused', { status: 500 }));
  await settle();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  expect(close).toHaveBeenCalledOnce();
});

test('creation waits for its catalogue and retry restores templates and collision preview', async () => {
  let attempts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('unavailable', { status: 503 })
        : Response.json({ entries: [{ id: 'new-page' }], templates: ['campaign'] });
    }),
  );
  app = mount(NewEntry, {
    target: document.body,
    props: { collection: 'pages', onclose: () => {} },
  });
  await settle();

  const title = document.querySelector<HTMLInputElement>('#new-title');
  if (!title) throw new Error('title missing');
  title.value = 'New page';
  title.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect(document.querySelector('.entry-read-error')?.textContent).toContain(
    'Could not check existing pages',
  );
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  expect(document.body.textContent).not.toContain('Saved as new-page.');

  document.querySelector<HTMLButtonElement>('.entry-read-error button')?.click();
  await settle();

  expect(document.body.textContent).toContain('Saved as new-page-2.');
  expect(document.body.textContent).toContain('Campaign template');
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
});
