import type { DiffGroup } from '@handover/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';
import Diff from './Diff.svelte';

let app: ReturnType<typeof mount>;
const show = (groups: DiffGroup[], mediaBase = '', uiLocale: 'en' | 'de' = 'en') => {
  app = mount(Diff, { target: document.body, props: { groups, mediaBase, uiLocale } });
  flushSync();
  return document.body;
};
afterEach(() => unmount(app));

test('a language nothing happened in says so, because silence reads as not loaded', () => {
  const body = show([
    { locale: 'en', changes: [{ path: 'title', label: 'Title', kind: 'whole' }] },
    { locale: 'de', changes: [] },
  ]);

  expect(Array.from(body.querySelectorAll('h3')).map((h) => h.textContent)).toEqual([
    'English',
    'German',
  ]);
  expect(body.querySelector('.is-quiet')?.textContent).toBe('Everything elseunchanged');
});

test('a block that moved is one row, not a deletion and an addition', () => {
  const body = show([
    {
      locale: 'en',
      changes: [
        {
          path: 'blocks[_id=cccc3333]',
          label: 'Gallery',
          kind: 'row',
          type: 'Hero',
          at: 'moved-up',
          above: 'Seaview Cottage',
          changes: [],
        },
      ],
    },
  ]);

  expect(body.querySelectorAll('.diff .row')).toHaveLength(1);
  expect(body.querySelector('.badge')?.textContent).toBe('moved up');
  expect(body.querySelector('.row')?.textContent).toContain('now above Seaview Cottage');
  expect(body.querySelector('del')).toBe(null);
  expect(body.querySelector('ins')).toBe(null);
});

test('a language that went is one line, not a deletion per field', () => {
  const root = show([
    { changes: [] },
    { locale: 'en', changes: [] },
    { locale: 'de', removed: true, changes: [] },
  ]);

  const german = Array.from(root.querySelectorAll('h3')).find((h) => h.textContent === 'German');
  expect(german?.nextElementSibling?.textContent?.trim()).toBe('The German version was removed');
});

// A picture is a key into storage that never changes, so a replacement is two named pictures.
test('a replaced picture is both thumbnails', () => {
  const root = show(
    [
      {
        locale: 'en',
        changes: [
          {
            path: 'hero.src',
            label: 'Hero image',
            kind: 'picture',
            before: 'media/aaaa.webp',
            after: 'media/bbbb.webp',
          },
        ],
      },
    ],
    'https://media.example',
  );

  const row = root.querySelector('.diff .row');
  expect(row?.textContent).toContain('photo replaced');
  expect(Array.from(root.querySelectorAll('.pair .lbl')).map((l) => l.textContent)).toEqual([
    'Before · aaaa.webp',
    'After · bbbb.webp',
  ]);
  expect(Array.from(root.querySelectorAll('.pair img')).map((i) => i.getAttribute('src'))).toEqual([
    'https://media.example/media/aaaa.webp',
    'https://media.example/media/bbbb.webp',
  ]);
});

test('diff chrome and language names render in German while authored labels stay unchanged', () => {
  const root = show(
    [
      {
        locale: 'en',
        changes: [{ path: 'title', label: 'Authored title label', kind: 'whole' }],
      },
    ],
    '',
    'de',
  );

  expect(root.querySelector('h3')?.textContent).toBe('Englisch');
  expect(root.querySelector('.row')?.textContent).toContain('Authored title label');
  expect(root.querySelector('.row')?.textContent).toContain('geändert');
});

test('a change and a block type labelled per language are named in the interface language', () => {
  const body = show(
    [
      {
        locale: 'en',
        changes: [
          {
            path: 'body[_id=aaaa1111]',
            label: 'Hero',
            labels: { en: 'Hero', de: 'Bühne' },
            kind: 'row',
            type: 'Hero',
            types: { en: 'Hero', de: 'Bühne' },
            above: 'Hero',
            aboveLabels: { en: 'Hero', de: 'Bühne' },
            at: 'added',
            changes: [],
          },
          {
            path: 'price',
            label: 'Price',
            labels: { en: 'Price', de: 'Preis' },
            kind: 'value',
            before: '1',
            after: '2',
          },
        ],
      },
    ],
    '',
    'de',
  );

  expect(Array.from(body.querySelectorAll('small'), (s) => s.textContent)).toEqual([
    'Bühne',
    'Preis',
  ]);
  expect(body.querySelector('.is-block .sub')?.textContent).toContain('Bühne');
  expect(body.querySelector('.is-block')?.textContent).not.toContain('Hero');
});
