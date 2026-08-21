import { render } from 'svelte/server';
import { expect, test } from 'vitest';
import App from './App.svelte';

test('the shell renders sidebar, top bar and main regions', () => {
  const { body } = render(App);
  expect(body).toMatch(/<aside class="sidebar[^"]*" aria-label="Main"/);
  expect(body).toMatch(/<header class="topbar[^"]*"/);
  expect(body).toMatch(/<main class="main[^"]*"/);
});
