import { type Field, markTranslation, parseEntry, stringifyEntry } from '@handover/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import SourceChangeLocaleFixture from './SourceChangeLocaleFixture.svelte';

// Not testing: the request and the reload, which Editor.test.ts drives through the menu.

const fields = [
  { path: ['title'], label: 'Title', type: 'text', required: true },
  { path: ['summary'], label: 'Summary', type: 'text', required: true },
  { path: ['notes'], label: 'Internal note', type: 'text', required: false, i18n: false },
] satisfies Field[];
const form = { fields, blocks: {} };
const german = { title: 'Mühlenhaus', summary: 'Ein Mühlenhaus am Bach.', notes: 'Schlüssel' };
const olderGerman = { ...german, summary: 'Ein Haus am Bach.' };

const marked = async (from: Record<string, unknown>, data: Record<string, unknown>) =>
  parseEntry(
    'default',
    await markTranslation(
      'default',
      form,
      { locale: 'de', contents: stringifyEntry('default', from), blob_sha: 'b1' },
      stringifyEntry('default', data),
      undefined,
    ),
  ) as Record<string, unknown>;

// Mockup 17: German first; English and Italian up to date, French behind, Spanish missing, Dutch off.
const files = async () => ({
  de: { ...german },
  en: await marked(german, { title: 'Mill House', summary: 'A mill house by the brook.' }),
  fr: await marked(olderGerman, { title: 'Moulin', summary: 'Une maison au bord du ruisseau.' }),
  it: await marked(german, { title: 'Mulino' }),
});

let app: ReturnType<typeof mount>;
const confirmed = vi.fn();
const show = async (over: Record<string, unknown> = {}) => {
  app = mount(SourceChangeLocaleFixture, {
    target: document.body,
    props: {
      locales: ['de', 'en', 'fr', 'it', 'es', 'nl'],
      source: 'de',
      files: await files(),
      offered: ['de', 'en', 'fr', 'it', 'es'],
      stale: ['fr'],
      fields,
      blocks: {},
      onconfirm: confirmed,
      onclose: () => {},
      onreload: () => {},
      ...over,
    },
  });
  await vi.waitFor(() => expect(document.body.querySelector('.source-effects')).not.toBeNull());
  return document.body;
};
afterEach(() => {
  unmount(app);
  confirmed.mockClear();
  document.body.innerHTML = '';
});

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
const rows = (root: ParentNode) =>
  Array.from(root.querySelectorAll<HTMLLabelElement>('.choice'), (label) => [
    text(label),
    label.querySelector('input')?.disabled,
  ]);
const effects = (root: ParentNode) => Array.from(root.querySelectorAll('.source-effects li'), text);
const choose = async (root: ParentNode, locale: string) => {
  root.querySelector<HTMLInputElement>(`#source-change-${locale}`)?.click();
  flushSync();
  await vi.waitFor(() =>
    expect(text(root.querySelector('.source-effects li'))).toContain('becomes the source'),
  );
};

test('every other language is listed, and the ones that cannot be the source say why', async () => {
  const root = await show();
  expect(rows(root)).toEqual([
    ['EN English Up to date with German', false],
    ['FR French German changed since it was translated', false],
    ['IT Italian 1 problem — fix it first', true],
    ['ES Spanish No file yet', true],
    ['NL Dutch Turned off for this entry', true],
  ]);
});

test('an up-to-date target carries German and every up-to-date translation with it', async () => {
  const root = await show();
  expect(root.querySelector<HTMLInputElement>('#source-change-en')?.checked).toBe(true);
  expect(effects(root)).toEqual([
    'English becomes the source. Its words stay exactly as they are.',
    'German keeps every word and becomes a translation of English, up to date with it. So does Italian.',
    'French was already behind German. It stays marked as needing a look, now against English.',
    'Internal note belongs to the source alone, so English gets German’s value. German keeps its copy, no longer shown.',
    'Machine-translated badges stay where they are, in every language.',
  ]);
  expect(root.querySelector('.notice-warn')).toBeNull();
  expect(text(root.querySelector('.actions .btn-primary'))).toBe('Make English the source');
});

test('a target that is behind carries no mark over, and every marked file reads stale', async () => {
  const root = await show();
  await choose(root, 'fr');
  expect(text(root.querySelector('.notice-warn'))).toBe(
    'French was translated from an older German, so nothing records that it matches German now.',
  );
  expect(effects(root)).toEqual([
    'French becomes the source. Its words stay exactly as they are.',
    'English and Italian keep every word and show as needing a look against French until somebody translates them again.',
    'German keeps every word. Nothing records that it matches French.',
    'Internal note belongs to the source alone, so French gets German’s value. German keeps its copy, no longer shown.',
    'Machine-translated badges stay where they are, in every language.',
  ]);
  root.querySelector<HTMLButtonElement>('.actions .btn-primary')?.click();
  expect(confirmed).toHaveBeenCalledExactlyOnceWith('fr');
});

test('a language that cannot become the source cannot be chosen', async () => {
  const root = await show();
  root.querySelector<HTMLInputElement>('#source-change-it')?.click();
  flushSync();
  expect(root.querySelector<HTMLInputElement>('#source-change-it')?.checked).toBe(false);
  expect(text(root.querySelector('.actions .btn-primary'))).toBe('Make English the source');
});

test('switching the interface language keeps the chosen language', async () => {
  const root = await show();
  await choose(root, 'fr');
  root.querySelector<HTMLButtonElement>('[data-locale-switch]')?.click();
  flushSync();
  expect(root.querySelector<HTMLInputElement>('#source-change-fr')?.checked).toBe(true);
  expect(text(root.querySelector('.actions .btn-primary'))).toBe(
    'Französisch zur Ausgangssprache machen',
  );
  expect(text(root.querySelector('#source-change-h'))).toBe('Ausgangssprache ändern');
});

test('a concurrent change offers Reload and no second attempt', async () => {
  const reloaded = vi.fn();
  const root = await show({
    failure: { code: 'ENTRY_SOURCE_REVISION', status: 409 },
    onreload: reloaded,
  });
  const alert = root.querySelector('[role="alert"]');
  expect(text(alert)).toBe(
    'Somebody changed this entry while you were choosing. Nothing was changed — reload the entry and try again. Reload',
  );
  expect(root.querySelector<HTMLButtonElement>('.actions .btn-primary')?.disabled).toBe(true);
  alert?.querySelector('button')?.click();
  expect(reloaded).toHaveBeenCalledOnce();
});

test('a lost answer offers only Reload', async () => {
  const root = await show({ failure: { code: 'SOURCE_CHANGE_RESPONSE_LOST' } });
  expect(text(root.querySelector('[role="alert"]'))).toBe(
    'It could not be confirmed whether the source changed. Reload the entry before trying again. Reload',
  );
  expect(root.querySelector('.actions')).toBeNull();
});
