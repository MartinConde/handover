import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import App from './App.svelte';

let app: ReturnType<typeof mount>;
const show = (authed: boolean) => {
  app = mount(App, { target: document.body, props: { authed, path: '/admin' } });
  flushSync();
  return document.body;
};
const drafts = (...files: string[]) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ files: files.map((path) => ({ path, updated_at: 1755864000000 })) }),
    ),
  );
afterEach(() => {
  unmount(app);
  vi.unstubAllGlobals();
});

test('the shell renders sidebar, top bar and main regions once logged in', () => {
  drafts();
  const root = show(true);
  expect(root.querySelector('aside.sidebar[aria-label="Main"]')).not.toBeNull();
  expect(root.querySelector('header.topbar')).not.toBeNull();
  expect(root.querySelector('main.main')).not.toBeNull();
  expect(root.querySelector('input[type="password"]')).toBeNull();
});

test('without a session only the login form renders', () => {
  const root = show(false);
  expect(root.querySelector('label[for="password"]')?.textContent).toBe('Password');
  expect(root.querySelector('input#password[type="password"]')).not.toBeNull();
  expect(root.querySelector('.sidebar')).toBeNull();
});

test('the indicator counts the pending files and opens the drawer', async () => {
  drafts('src/content/listings/en/mill-house.yaml');
  const root = show(true);
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  const indicator = root.querySelector<HTMLButtonElement>('button.indicator');
  expect(indicator?.textContent?.trim()).toBe('1 unpublished change');
  expect(root.querySelector('.drawer')).toBeNull();

  indicator?.click();
  flushSync();
  expect(root.querySelector('.drawer .drawer-meta .count')?.textContent).toBe('1 file');
  // The shell is inert while the drawer is up, so focus has to be inside it.
  expect(document.activeElement).toBe(root.querySelector('.drawer'));

  root.querySelector<HTMLButtonElement>('.drawer [aria-label="Close"]')?.click();
  flushSync();
  expect(root.querySelector('.drawer')).toBeNull();
  expect(document.activeElement).toBe(indicator);
});
