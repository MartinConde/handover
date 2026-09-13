import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import FieldsLocaleFixture from './FieldsLocaleFixture.svelte';

let app: ReturnType<typeof mount>;
afterEach(() => {
  unmount(app);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
async function render(locale: 'en' | 'de') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ entries: [], locales: ['en', 'de'] })),
  );
  app = mount(FieldsLocaleFixture, { target: document.body, props: { initialUiLocale: locale } });
  await tick();
  flushSync();
}
test('empty link selection uses complete German copy', async () => {
  await render('de');
  document.querySelector<HTMLButtonElement>('#f-button-field .seg button')?.click();
  flushSync();
  expect(document.querySelector('#f-button-field .list-empty button')?.textContent ?? '').toBe(
    'Seite oder Eintrag auswählen',
  );
});
test('row controls translate their owned row noun', async () => {
  await render('de');
  const label =
    document.querySelector('#f-rooms .row-controls .handle')?.getAttribute('aria-label') ?? '';
  expect(label).toContain('Rooms');
  expect(label).not.toContain(' row ');
});
test('one entered SEO character still describes a plural limit', async () => {
  await render('en');
  const input = document.querySelector<HTMLInputElement>('input[id="f-seo.title"]');
  if (input) {
    input.value = 'A';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  flushSync();
  expect(document.querySelector('[id="f-seo.title-meter"]')?.textContent ?? '').toBe(
    'About 1 of ≈60 characters',
  );
});
