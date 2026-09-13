import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import FieldsLocaleFixture from './FieldsLocaleFixture.svelte';

let app: ReturnType<typeof mount>;
afterEach(() => {
  unmount(app);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const q = <T extends Element>(selector: string): T => {
  const element = document.body.querySelector<T>(selector);
  if (!element) throw new Error(`${selector} missing`);
  return element;
};
const click = (selector: string) => {
  q<HTMLButtonElement>(selector).click();
  flushSync();
};
const type = (selector: string, value: string) => {
  const input = q<HTMLInputElement>(selector);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};

test('structured field state and open feedback survive a live locale switch', async () => {
  const fetchMock = vi.fn(async () => Response.json({ entries: [], locales: ['en', 'de'] }));
  vi.stubGlobal('fetch', fetchMock);
  app = mount(FieldsLocaleFixture, { target: document.body });
  await tick();
  flushSync();

  const nested = q<HTMLInputElement>('input#f-rooms\\.0\\.name');
  nested.focus();
  type('input#f-rooms\\.0\\.name', 'Garden room');
  nested.setSelectionRange(6, 6);
  click('#f-blocks .add');
  click('#f-video-change');
  await tick();
  type('input#f-video', 'https://www.dailymotion.com/video/x8abc');
  click('#stale-summary');
  await tick();
  flushSync();

  const date = q<HTMLInputElement>('input#f-available');
  const embedInput = q<HTMLInputElement>('input#f-video');
  const blockInput = q<HTMLInputElement>('input#f-blocks\\.0\\.heading');
  const commandsBeforeSwitch = q('[data-command-count]').textContent ?? '';
  const requestsBeforeSwitch = fetchMock.mock.calls.length;
  nested.focus();
  nested.setSelectionRange(6, 6);

  expect(q('#f-address-field summary').textContent ?? '').toBe('Postal address1 field');
  expect(q('#f-button\\.href-err').textContent ?? '').toBe('javascript: links are not allowed');
  expect(q('#f-video-paste').textContent ?? '').toBe(
    'We don’t recognise this link. Supported: YouTube, Vimeo, Google Maps.',
  );
  expect(q('#f-seo .notice').textContent ?? '').toContain(
    'anybody with the link can still open it',
  );
  expect(q('#translated-summary-field .hint').textContent ?? '').toBe('Same in every language');
  expect(q('.block-picker .type-card').textContent ?? '').toBe('callout');
  expect(q('.popover small').textContent ?? '').toBe('English, when translated · 13 Sept, 10:15');

  click('[data-locale-switch]');

  expect(q('#f-address-field summary').textContent ?? '').toBe('Postal address1 Feld');
  expect(q('#f-button\\.href-err').textContent ?? '').toBe(
    'Links mit dem Schema javascript: sind nicht erlaubt',
  );
  expect(q('#f-video-paste').textContent ?? '').toBe(
    'Dieser Link wird nicht erkannt. Unterstützt werden YouTube, Vimeo und Google Maps.',
  );
  expect(q('#f-seo .notice').textContent ?? '').toContain(
    'Wer den direkten Link hat, kann die Seite weiterhin öffnen',
  );
  expect(q('#translated-summary-field .hint').textContent ?? '').toBe('In jeder Sprache gleich');
  expect(q('#f-rooms .add').textContent ?? '').toBe('Zu Rooms hinzufügen');
  expect(q('#f-blocks .add').textContent ?? '').toBe('Block hinzufügen');
  expect(q('#f-button-field legend').textContent ?? '').toBe('Ziel');
  expect(q('#f-seo\\.title-meter').textContent ?? '').toBe('Bis zu etwa 60 Zeichen');
  expect(q('.block-picker .type-card').textContent ?? '').toBe('callout');
  expect(q('.popover small').textContent ?? '').toBe('English, when translated · 13. Sept., 10:15');
  expect(q<HTMLInputElement>('input#f-rooms\\.0\\.name')).toBe(nested);
  expect(nested.value).toBe('Garden room');
  expect(nested.selectionStart).toBe(6);
  expect(document.activeElement).toBe(nested);
  expect(q<HTMLInputElement>('input#f-blocks\\.0\\.heading')).toBe(blockInput);
  expect(blockInput.value).toBe('Welcome aboard');
  expect(q<HTMLInputElement>('input#f-available')).toBe(date);
  expect(date.value).toBe('2026-09-13');
  expect(q<HTMLInputElement>('input#f-video')).toBe(embedInput);
  expect(embedInput.value).toBe('https://www.dailymotion.com/video/x8abc');
  expect(q('[data-command-count]').textContent ?? '').toBe(commandsBeforeSwitch);
  expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeSwitch);
  expect(q('label[for="f-rooms.0.name"]').textContent ?? '').toBe('Room name');
  expect(q('#f-blocks\\.0 header .label').textContent ?? '').toBe('Callout');
});

test.each([
  [
    'https://maps.app.goo.gl/AbCdEf123',
    'Google Maps hat diesen Link gekürzt. Öffne ihn und kopiere dann die Adresse aus deinem Browser.',
  ],
  [
    'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3',
    'Das ist der Einbettungscode von Google. Öffne die Karte selbst und kopiere die Adresse aus deinem Browser.',
  ],
  [
    'https://www.google.com/maps/@50.5,-4.8,17z',
    'Dieser Link zeigt eine Kartenansicht ohne Ort. Suche den Ort in Google Maps und kopiere dann die Adresse aus deinem Browser.',
  ],
])(
  'a retained embed refusal selects its German recovery by stable reason',
  async (url, expected) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ entries: [], locales: ['en', 'de'] })),
    );
    app = mount(FieldsLocaleFixture, {
      target: document.body,
      props: { initialUiLocale: 'de', refusalUrl: url },
    });
    await tick();
    flushSync();
    click('#f-video-change');
    await tick();
    type('input#f-video', q('[data-refusal-url]').textContent ?? '');
    expect(q('#f-video-paste').textContent ?? '').toBe(expected);
  },
);
