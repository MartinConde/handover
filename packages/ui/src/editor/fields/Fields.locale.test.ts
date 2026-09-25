import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { q } from '../../test-helpers.fixture.js';
import FieldsLocaleFixture from './FieldsLocaleFixture.svelte';

// jsdom has no layout; ProseMirror asks for it when it scrolls a selection into view.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

let app: ReturnType<typeof mount>;
afterEach(() => {
  unmount(app);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

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
const settle = async () => {
  await tick();
  await Promise.resolve();
  await tick();
  flushSync();
};
const selectAll = (selector: string) => {
  const editor = q<HTMLElement>(selector);
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  flushSync();
};

test('rich-text state and an open link draft survive a live locale switch', async () => {
  const fetchMock = vi.fn(async () => Response.json({ entries: [], locales: ['en', 'de'] }));
  vi.stubGlobal('fetch', fetchMock);
  app = mount(FieldsLocaleFixture, { target: document.body });
  await settle();

  const editor = q<HTMLElement>('#f-summary');
  const toolbar = q<HTMLElement>('#f-summary-field [role="toolbar"]');
  selectAll('#f-summary');
  click('[aria-label="Bold"]');
  expect(q('[data-richtext-value]').textContent).toBe('**Two bedrooms.**');
  expect(q('[aria-label="Bold"]').getAttribute('aria-pressed')).toBe('true');

  click('[aria-label="Link"]');
  await settle();
  const picker = q<HTMLElement>('#f-summary-field .picker');
  const linkDraft = q<HTMLInputElement>('#f-summary-link-url');
  type('#f-summary-link-url', 'https://example.com/house');
  linkDraft.focus();
  linkDraft.setSelectionRange(12, 12);
  const historyBefore = q('[data-richtext-history]').textContent;
  const logicalBefore = q('[data-richtext-selection]').textContent;
  const commandsBefore = q('[data-command-count]').textContent;
  const requestsBefore = fetchMock.mock.calls.length;

  expect(JSON.parse(historyBefore ?? '')).toMatchObject({
    redoTransactions: 0,
    undoTransactions: 1,
  });
  expect(JSON.parse(logicalBefore ?? '')).toMatchObject({
    address: 'summary',
    anchor: 1,
    head: 14,
    kind: 'text',
    locale: 'en',
  });
  expect(commandsBefore).toBe('1');

  expect(toolbar.getAttribute('aria-label')).toBe('Formatting');
  click('[data-locale-switch]');

  expect(q('#f-summary')).toBe(editor);
  expect(q('#f-summary-field [role="toolbar"]')).toBe(toolbar);
  expect(q('#f-summary-field .picker')).toBe(picker);
  expect(q<HTMLInputElement>('#f-summary-link-url')).toBe(linkDraft);
  expect(document.activeElement).toBe(linkDraft);
  expect(linkDraft.value).toBe('https://example.com/house');
  expect(linkDraft.selectionStart).toBe(12);
  expect(q('[data-richtext-value]').textContent).toBe('**Two bedrooms.**');
  expect(q('[data-richtext-history]').textContent).toBe(historyBefore);
  expect(q('[data-richtext-selection]').textContent).toBe(logicalBefore);
  expect(q('[data-command-count]').textContent).toBe(commandsBefore);
  expect(toolbar.getAttribute('aria-label')).toBe('Formatierung');
  expect(q('[aria-label="Fett"]').getAttribute('aria-pressed')).toBe('true');
  expect(
    Array.from(toolbar.querySelectorAll('button'), (button) => button.getAttribute('aria-label')),
  ).toEqual([
    'Fett',
    'Kursiv',
    'Link',
    'Aufzählung',
    'Nummerierte Liste',
    'Überschrift 2',
    'Überschrift 3',
    'Zitat',
  ]);
  expect(q('#f-summary-field .picker-list').getAttribute('aria-label')).toBe(
    'Seiten und Einträge zum Verlinken',
  );
  expect(q('#f-summary-field .side-title').textContent).toBe('Eigener Link');
  expect(fetchMock).toHaveBeenCalledTimes(requestsBefore);

  click('#f-summary-field .actions .btn-primary');
  expect(q<HTMLAnchorElement>('#f-summary a').href).toBe('https://example.com/house');
  expect(q('#f-summary a').textContent).toBe('Two bedrooms.');
  expect(q('[data-richtext-value]').textContent).toContain('https://example.com/house');

  const undo = new KeyboardEvent('keydown', {
    key: 'z',
    code: 'KeyZ',
    keyCode: 90,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  editor.dispatchEvent(undo);
  await settle();
  expect(undo.defaultPrevented).toBe(true);
  expect(q('[data-richtext-value]').textContent).toBe('**Two bedrooms.**');
  expect(q('#f-summary strong').textContent).toBe('Two bedrooms.');
});

test('foreign guidance and a lazily opened link picker use the latest locale', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ entries: [], locales: ['en', 'de'] })),
  );
  app = mount(FieldsLocaleFixture, { target: document.body });
  await settle();
  const editor = q<HTMLElement>('#f-summary');
  const foreign = q<HTMLElement>('#f-legacy-field [role="region"]');
  const authored = q('#f-legacy').textContent;

  click('[data-locale-switch]');

  expect(q('#f-legacy-field [role="region"]')).toBe(foreign);
  expect(q('#f-legacy').textContent).toBe(authored);
  expect(q('#f-legacy-hint').textContent).toBe(
    'Dieser Text wurde im Code bearbeitet und verwendet Formatierungen, die der Editor nicht ändern kann. Bitte deinen Entwickler um Hilfe.',
  );
  selectAll('#f-summary');
  click('[aria-label="Link"]');
  await settle();
  expect(q('#f-summary')).toBe(editor);
  expect(q('#f-summary-field .picker-list').getAttribute('aria-label')).toBe(
    'Seiten und Einträge zum Verlinken',
  );
  expect(q<HTMLInputElement>('#f-summary-link-q').placeholder).toBe(
    'Seiten und Einträge durchsuchen',
  );
  expect(q('[data-richtext-value]').textContent).toBe('Two bedrooms.');
});

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
  expect(q('#translated-summary-field .badge-machine').textContent ?? '').toBe(
    'Machine translated',
  );
  expect(q('#stale-summary').textContent ?? '').toBe('English changed since this was translated');

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
  expect(q('#f-rooms .add').textContent ?? '').toBe('Eintrag hinzufügen');
  expect(q('#f-rooms .add').getAttribute('aria-label')).toBe('Einen Eintrag zu Rooms hinzufügen');
  expect(q('#f-blocks .add').textContent ?? '').toBe('Block hinzufügen');
  expect(q('#f-button-field legend').textContent ?? '').toBe('Ziel');
  expect(q('#f-seo\\.title-meter').textContent ?? '').toBe('Bis zu etwa 60 Zeichen');
  expect(q('.block-picker .type-card').textContent ?? '').toBe('callout');
  expect(q('.popover small').textContent ?? '').toBe(
    'Englisch, bei der Übersetzung · 13. Sept., 10:15',
  );
  expect(q('#translated-summary-field .badge-machine').textContent ?? '').toBe(
    'Maschinell übersetzt',
  );
  expect(q('#stale-summary').textContent ?? '').toBe(
    'Englisch wurde seit dieser Übersetzung geändert',
  );
  expect(q('#translated-summary-field > .popover').getAttribute('aria-label')).toBe(
    'Änderungen auf Englisch',
  );
  expect(q('#translated-summary-field > .popover .row:nth-child(2) small').textContent ?? '').toBe(
    'Englisch, jetzt',
  );
  expect(
    Array.from(
      q('#translated-summary-field > .popover .actions').querySelectorAll('button'),
      (button) => button.textContent,
    ),
  ).toEqual(['Neu übersetzen', 'Schließen']);
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
