import { expect, test } from 'vitest';
import { checkCollections, checkI18n, entryName } from './names.js';

test.each([
  ['plain title', 'Seaview Cottage', [], 'seaview-cottage'],
  ['punctuation collapses to one dash', 'Hello,  world! (2026)', [], 'hello-world-2026'],
  ['leading and trailing dashes trimmed', '--Hi--', [], 'hi'],
  ['german umlauts', 'Größe über Fähre', [], 'groesse-ueber-faehre'],
  ['latin diacritics', 'Café Señor Ångström', [], 'cafe-senor-aangstroem'],
  ['cyrillic', 'Привет мир', [], 'privet-mir'],
  ['empty title', '', [], 'untitled'],
  ['only symbols', '!!!', [], 'untitled'],
  ['capped at 80 chars', `${'a'.repeat(79)}-bcd`, [], 'a'.repeat(79)],
  ['collision gets -2', 'Seaview Cottage', ['seaview-cottage'], 'seaview-cottage-2'],
  [
    'next free suffix',
    'Seaview Cottage',
    ['seaview-cottage', 'seaview-cottage-2'],
    'seaview-cottage-3',
  ],
  ['suffix skips a gap', 'x', ['x', 'x-3'], 'x-2'],
  ['empty title collides', '', ['untitled'], 'untitled-2'],
  ['suffix stays within the cap', 'a'.repeat(80), ['a'.repeat(80)], `${'a'.repeat(78)}-2`],
])('%s', (_name, title, taken, want) => {
  expect(entryName('default', title, taken)).toBe(want);
});

test('valid collections produce no errors', () => {
  expect(
    checkCollections('default', {
      listings: { route: '/listings/[slug]', index: '/', load: 'listing' },
      pages: { route: '/[slug]' },
      globals: {},
    }),
  ).toEqual([]);
});

test.each([
  ['route without [slug]', { posts: { route: '/blog' } }, 'collections.posts.route'],
  ['route with two [slug]', { posts: { route: '/[slug]/[slug]' } }, 'collections.posts.route'],
  ['route not starting with /', { posts: { route: 'blog/[slug]' } }, 'collections.posts.route'],
  ['route that is not a string', { posts: { route: 7 } }, 'collections.posts.route'],
  ['index with a parameter', { posts: { index: '/blog/[slug]' } }, 'collections.posts.index'],
  ['index not starting with /', { posts: { index: 'blog' } }, 'collections.posts.index'],
  ['load that is not a string', { posts: { load: () => 1 } }, 'collections.posts.load'],
  ['titleField that is not a string', { posts: { titleField: 1 } }, 'collections.posts.titleField'],
  [
    'titleField naming a reserved key',
    { posts: { titleField: '_id' } },
    'collections.posts.titleField',
  ],
  ['collection name with a capital', { Posts: {} }, 'collections.Posts'],
])('%s is reported at its key', (_name, collections, at) => {
  const [message, ...rest] = checkCollections('default', collections);
  expect(rest).toEqual([]);
  expect(message).toMatch(new RegExp(`^cms\\.config\\.ts › ${at.replace(/\./g, '\\.')}: `));
});

test('a titleField naming an ordinary field is accepted', () => {
  expect(checkCollections('default', { presenters: { titleField: 'name' } })).toEqual([]);
});

test('the same route on two collections is reported on the second', () => {
  const errors = checkCollections('default', {
    posts: { route: '/[slug]' },
    pages: { route: '/[slug]' },
  });
  expect(errors).toEqual([
    'cms.config.ts › collections.pages.route: "/[slug]" is already the route of "posts"',
  ]);
});

test('globals keys are file names: lowercase letters, digits and dashes', () => {
  expect(checkCollections('default', {}, { site: {}, 'cta-newsletter': {} })).toEqual([]);
  expect(checkCollections('default', {}, { 'Site Settings': {} })).toEqual([
    'cms.config.ts › globals.Site Settings: global keys are lowercase letters, digits and dashes (it is the file name under src/content/globals/<locale>/)',
  ]);
});

test('a valid i18n block produces no errors', () => {
  expect(checkI18n('default', { locales: ['en', 'de'], defaultLocale: 'en' })).toEqual([]);
  expect(
    checkI18n('default', { locales: ['pt-br'], defaultLocale: 'pt-br', prefixDefaultLocale: true }),
  ).toEqual([]);
});

test.each([
  ['no i18n block at all', undefined, 'i18n'],
  ['locales that is not an array', { locales: 'en', defaultLocale: 'en' }, 'i18n.locales'],
  ['no locales', { locales: [], defaultLocale: 'en' }, 'i18n.locales'],
  ['a locale with an underscore', { locales: ['en_US'], defaultLocale: 'en_US' }, 'i18n.locales'],
  ['a locale listed twice', { locales: ['en', 'en'], defaultLocale: 'en' }, 'i18n.locales'],
  [
    'a defaultLocale outside locales',
    { locales: ['en'], defaultLocale: 'de' },
    'i18n.defaultLocale',
  ],
  [
    'a prefixDefaultLocale that is not a boolean',
    { locales: ['en'], defaultLocale: 'en', prefixDefaultLocale: 'yes' },
    'i18n.prefixDefaultLocale',
  ],
])('%s is reported at its key', (_name, i18n, at) => {
  const [message, ...rest] = checkI18n('default', i18n);
  expect(rest).toEqual([]);
  expect(message).toMatch(new RegExp(`^cms\\.config\\.ts › ${at.replace(/\./g, '\\.')}: `));
});
