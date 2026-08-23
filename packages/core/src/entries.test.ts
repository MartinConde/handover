import { expect, test } from 'vitest';
import { collectionEntries, contentPathErrors, indexFrom } from './entries.js';

const file = (path: string, body: string) => ({ path, contents: `_version: 1\n${body}` });
const listing = (locale: string, name: string, body: string) =>
  file(`src/content/listings/${locale}/${name}.yaml`, body);

test('an entry is one row with a locale per file', () => {
  const index = indexFrom('default', [
    listing('en', 'mill-house', 'title: "The Mill House"\n'),
    listing('de', 'mill-house', 'title: "Das Mühlenhaus"\n'),
    listing('en', 'seaview-cottage', 'title: "Seaview Cottage"\n'),
  ]);
  expect(index).toEqual({
    listings: [
      {
        id: 'mill-house',
        locales: {
          en: { title: 'The Mill House', path: 'src/content/listings/en/mill-house.yaml' },
          de: { title: 'Das Mühlenhaus', path: 'src/content/listings/de/mill-house.yaml' },
        },
      },
      {
        id: 'seaview-cottage',
        locales: {
          en: { title: 'Seaview Cottage', path: 'src/content/listings/en/seaview-cottage.yaml' },
        },
      },
    ],
  });
});

test('an entry with no title is listed under its filename', () => {
  const index = indexFrom('default', [listing('en', 'mill-house', 'name: "The Mill House"\n')]);
  expect(index.listings?.[0]?.locales.en?.title).toBe('mill-house');
});

test('a hidden entry carries its status and a live one has no status key', () => {
  const index = indexFrom('default', [
    listing('en', 'mill-house', '_status: "hidden"\ntitle: "The Mill House"\n'),
    listing('en', 'seaview-cottage', 'title: "Seaview Cottage"\n'),
  ]);
  expect(index.listings?.[0]?.locales.en).toEqual({
    title: 'The Mill House',
    path: 'src/content/listings/en/mill-house.yaml',
    status: 'hidden',
  });
  expect(index.listings?.[1]?.locales.en).not.toHaveProperty('status');
});

test('the entry layout is the only one accepted, and the site files with it', () => {
  expect(
    contentPathErrors('default', [
      'src/content/listings/en/mill-house.yaml',
      'src/content/globals/en/site.yaml',
      'src/content/redirects.yaml',
      'src/content/_templates/listings/house.yaml',
    ]),
  ).toEqual([]);
});

test('a content file below the locale folder fails rather than going missing', () => {
  expect(
    contentPathErrors('default', [
      'src/content/listings/en/devon/mill-house.yaml',
      'src/content/loose.yaml',
    ]),
  ).toEqual([
    'src/content/listings/en/devon/mill-house.yaml: an entry is src/content/<collection>/<locale>/<name>.yaml, one folder per locale and no folders below it',
    'src/content/loose.yaml: an entry is src/content/<collection>/<locale>/<name>.yaml, one folder per locale and no folders below it',
  ]);
});

test('templates, globals and redirects are not entries', () => {
  expect(
    indexFrom('default', [
      file('src/content/_templates/listings/house.yaml', 'title: "New listing"\n'),
      file('src/content/globals/en/site.yaml', 'title: "Handover"\n'),
      file('src/content/redirects.yaml', 'rules: []\n'),
    ]),
  ).toEqual({});
});

const index = indexFrom('default', [
  listing('en', 'mill-house', 'title: "The Mill House"\n'),
  listing('en', 'seaview-cottage', 'title: "Seaview Cottage"\n'),
]);

test('a draft title wins over the one the index was built from', () => {
  const entries = collectionEntries('default', index, 'listings', [
    listing('en', 'mill-house', 'title: "The Mill House, renamed"\n'),
  ]);
  expect(entries.map((e) => e.locales.en?.title)).toEqual([
    'The Mill House, renamed',
    'Seaview Cottage',
  ]);
});

test('a draft that hides an entry wins over the live file', () => {
  const entries = collectionEntries('default', index, 'listings', [
    listing('en', 'mill-house', '_status: "hidden"\ntitle: "The Mill House"\n'),
  ]);
  expect(entries[0]?.locales.en?.status).toBe('hidden');
});

test('an entry that exists only as a draft is in the list', () => {
  const entries = collectionEntries('default', index, 'listings', [
    listing('en', 'barn-conversion', 'title: "The Barn"\n'),
  ]);
  expect(entries.map((e) => e.id)).toEqual(['barn-conversion', 'mill-house', 'seaview-cottage']);
});

test('drafts of another collection are not in the list', () => {
  const entries = collectionEntries('default', index, 'listings', [
    file('src/content/pages/en/home.yaml', 'title: "Home, drafted"\n'),
  ]);
  expect(entries.map((e) => e.id)).toEqual(['mill-house', 'seaview-cottage']);
});

test('the built index is not mutated by the overlay', () => {
  collectionEntries('default', index, 'listings', [
    listing('en', 'mill-house', 'title: "The Mill House, renamed"\n'),
  ]);
  expect(index.listings?.[0]?.locales.en?.title).toBe('The Mill House');
});

test('a row saying the file is gone takes the entry out of the list', () => {
  const entries = collectionEntries('default', index, 'listings', [
    { path: 'src/content/listings/en/mill-house.yaml', contents: '' },
  ]);
  expect(entries.map((e) => e.id)).toEqual(['seaview-cottage']);
});

test('a renamed entry is listed under its new name before the build catches up', () => {
  const entries = collectionEntries('default', index, 'listings', [
    { path: 'src/content/listings/en/mill-house.yaml', contents: '' },
    listing('en', 'the-old-mill', 'title: "The Mill House"\n'),
  ]);
  expect(entries.map((e) => [e.id, e.locales.en?.title])).toEqual([
    ['seaview-cottage', 'Seaview Cottage'],
    ['the-old-mill', 'The Mill House'],
  ]);
});
