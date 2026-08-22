import { mount, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';
import App from './App.svelte';

let app: ReturnType<typeof mount>;
const show = (authed: boolean) => {
  app = mount(App, { target: document.body, props: { authed, path: '/admin' } });
  return document.body;
};
afterEach(() => unmount(app));

test('the shell renders sidebar, top bar and main regions once logged in', () => {
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
