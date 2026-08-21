import { render } from 'svelte/server';
import { expect, test } from 'vitest';
import App from './App.svelte';

test('the shell renders sidebar, top bar and main regions once logged in', () => {
  const { body } = render(App, { props: { authed: true } });
  expect(body).toMatch(/<aside class="sidebar[^"]*" aria-label="Main"/);
  expect(body).toMatch(/<header class="topbar[^"]*"/);
  expect(body).toMatch(/<main class="main[^"]*"/);
  expect(body).not.toContain('type="password"');
});

test('without a session only the login form renders', () => {
  const { body } = render(App, { props: { authed: false } });
  expect(body).toMatch(/<label for="password">Password<\/label>/);
  expect(body).toMatch(/<input id="password" type="password"/);
  expect(body).not.toContain('class="sidebar');
});
