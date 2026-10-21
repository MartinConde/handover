import { expect, test, vi } from 'vitest';
import {
  addressError,
  checkCollections,
  checkI18n,
  entryAddress,
  entryName,
  entryUrl,
  previewTarget,
  withSlash,
} from './names.js';

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
  expect(entryName(title, taken)).toBe(want);
});

test('valid collections produce no errors', () => {
  expect(
    checkCollections({
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
  const [message, ...rest] = checkCollections(collections);
  expect(rest).toEqual([]);
  expect(message).toMatch(new RegExp(`^cms\\.config\\.ts › ${at.replace(/\./g, '\\.')}: `));
});

test('a titleField naming an ordinary field is accepted', () => {
  expect(checkCollections({ presenters: { titleField: 'name' } })).toEqual([]);
});

test('the same route on two collections is reported on the second', () => {
  const errors = checkCollections({
    posts: { route: '/[slug]' },
    pages: { route: '/[slug]' },
  });
  expect(errors).toEqual([
    'cms.config.ts › collections.pages.route: "/[slug]" is already the route of "posts"',
  ]);
});

test('globals keys are file names: lowercase letters, digits and dashes', () => {
  expect(checkCollections({}, { site: {}, 'cta-newsletter': {} })).toEqual([]);
  expect(checkCollections({}, { 'Site Settings': {} })).toEqual([
    'cms.config.ts › globals.Site Settings: global keys are lowercase letters, digits and dashes (it is the file name under src/content/globals/<locale>/)',
  ]);
});

test('a valid i18n block produces no errors', () => {
  expect(checkI18n({ locales: ['en', 'de'], defaultLocale: 'en' })).toEqual([]);
  expect(
    checkI18n({ locales: ['pt-br'], defaultLocale: 'pt-br', prefixDefaultLocale: true }),
  ).toEqual([]);
  expect(checkI18n({ locales: ['en'], defaultLocale: 'en', base: '/site' })).toEqual([]);
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
  [
    'a base without a leading slash',
    { locales: ['en'], defaultLocale: 'en', base: 'site' },
    'i18n.base',
  ],
  [
    'a base with a trailing slash',
    { locales: ['en'], defaultLocale: 'en', base: '/site/' },
    'i18n.base',
  ],
])('%s is reported at its key', (_name, i18n, at) => {
  const [message, ...rest] = checkI18n(i18n);
  expect(rest).toEqual([]);
  expect(message).toMatch(new RegExp(`^cms\\.config\\.ts › ${at.replace(/\./g, '\\.')}: `));
});

const two = { locales: ['en', 'de'], defaultLocale: 'en' };

test('the default language has no segment and the others do', () => {
  expect(entryUrl(two, '/listings/[slug]', 'mill-house', 'en')).toBe('/listings/mill-house');
  expect(entryUrl(two, '/listings/[slug]', 'mill-house', 'de')).toBe('/de/listings/mill-house');
});

test('prefixDefaultLocale gives the default language a segment too', () => {
  const prefixed = { ...two, prefixDefaultLocale: true };
  expect(entryUrl(prefixed, '/[slug]', 'home', 'en')).toBe('/en/home');
});

test('a site under a base path has it in front of every address', () => {
  const under = { ...two, base: '/site' };
  expect(entryUrl(under, '/listings/[slug]', 'mill-house', 'en')).toBe('/site/listings/mill-house');
  expect(entryUrl(under, '/listings/[slug]', 'mill-house', 'de')).toBe(
    '/site/de/listings/mill-house',
  );
  expect(entryUrl(under, '/', '', 'en')).toBe('/site/');
});

test('a collection with no route of its own has no URL', () => {
  expect(entryUrl(two, undefined, 'everything', 'de')).toBe(undefined);
});

// Preview only allows paths the site's routes can serve.
const site = {
  listings: { route: '/listings/[slug]', index: '/' },
  pages: { route: '/[slug]' },
  samples: {},
};
const target = (path: string, i18n = two) => previewTarget(i18n, site, path);

test('an entry path resolves to its collection, language and address', () => {
  expect(target('/listings/mill-house')).toEqual({
    collection: 'listings',
    locale: 'en',
    address: 'mill-house',
  });
  expect(target('/de/listings/mill-house')).toEqual({
    collection: 'listings',
    locale: 'de',
    address: 'mill-house',
  });
});

test("a collection's index page is a target with no address", () => {
  expect(target('/')).toEqual({ collection: 'listings', locale: 'en' });
});

test('the entry named index is served at its index page, not under the route', () => {
  const home = { pages: { route: '/[slug]', index: '/' } };
  expect(previewTarget(two, home, '/index')).toBe(undefined);
  expect(previewTarget(two, home, '/')).toEqual({ collection: 'pages', locale: 'en' });
});

// `/de` is both the German index and, read as a page, the slug "de" in English.
test('a language segment is never read as a page slug', () => {
  expect(target('/de')).toEqual({ collection: 'listings', locale: 'de' });
});

test('one trailing slash is the same page', () => {
  expect(target('/de/')).toEqual({ collection: 'listings', locale: 'de' });
  expect(target('/listings/mill-house/')).toEqual({
    collection: 'listings',
    locale: 'en',
    address: 'mill-house',
  });
});

test('with prefixDefaultLocale the default language needs its segment too', () => {
  const prefixed = { ...two, prefixDefaultLocale: true };
  expect(target('/en/home', prefixed)).toEqual({
    collection: 'pages',
    locale: 'en',
    address: 'home',
  });
  expect(target('/home', prefixed)).toBe(undefined);
});

// Without it the site builds no /en/ pages at all.
test("without it the default language's segment is not a path", () => {
  expect(target('/en/home')).toBe(undefined);
});

test('a collection with neither a route nor an index is not previewable', () => {
  expect(previewTarget(two, { samples: {} }, '/everything')).toBe(undefined);
});

test.each([
  ['a path no route serves', '/listings/mill-house/gallery'],
  ['a segment that is not an address', '/listings/Mill%20House'],
  ['a way out of the site', '/listings/../admin'],
  ['an empty segment', '/de//'],
  ['nothing at all', ''],
])('%s is refused', (_name, path) => {
  expect(target(path)).toBe(undefined);
});

test('a route with nothing in its slug is not the collection', () => {
  expect(previewTarget(two, { listings: { route: '/listings/[slug]' } }, '/listings/')).toBe(
    undefined,
  );
});

test('a web address is spelled the way a file name is', () => {
  expect(addressError('start-seite')).toBe(undefined);
  // Empty is the fallback to the file name, not a mistake.
  expect(addressError('')).toBe(undefined);
  expect(addressError('Start-Seite')).toMatch(/lowercase/);
  expect(addressError('de/start')).toMatch(/lowercase/);
  expect(addressError('gr%C3%B6sse')).toMatch(/lowercase/);
  expect(addressError('start seite')).toMatch(/lowercase/);
  expect(addressError('-start')).toMatch(/lowercase/);
  expect(addressError('start--seite')).toMatch(/lowercase/);
  expect(addressError('a'.repeat(81))).toMatch(/longer than 80/);
});

test('a file with no slug of its own is addressed by its name', () => {
  expect(entryAddress({ title: 'Home' }, 'home')).toBe('home');
  expect(entryAddress({ slug: '' }, 'home')).toBe('home');
  expect(entryAddress({ slug: 'startseite' }, 'home')).toBe('startseite');
});

// Astro defines one on every entry that has no `slug` of its own, to say the property is gone.
test('a warning getter Astro left behind is never read', () => {
  const data = { title: 'Home' };
  const read = vi.fn(() => undefined);
  Object.defineProperty(data, 'slug', { get: read, enumerable: false });

  expect(entryAddress(data, 'home')).toBe('home');
  expect(read).not.toHaveBeenCalled();
});

test('localizedSlugs is true or false and says so when it is not', () => {
  expect(checkCollections({ pages: { localizedSlugs: true } })).toEqual([]);
  expect(checkCollections({ pages: { localizedSlugs: 'yes' } })).toEqual([
    'cms.config.ts › collections.pages.localizedSlugs: expected true or false, got "yes"',
  ]);
});

// One page has one address on a site, and the site decides which.
test('withSlash writes a path the way the site serves it and leaves the rest alone', () => {
  expect(withSlash('/listings/coast', true)).toBe('/listings/coast/');
  expect(withSlash('/listings/coast/', false)).toBe('/listings/coast');
  expect(withSlash('/', true)).toBe('/');
  expect(withSlash('/', false)).toBe('/');
  expect(withSlash('/listings?status=sale', true)).toBe('/listings/?status=sale');
  expect(withSlash('/de/#top', false)).toBe('/de#top');
  expect(withSlash('https://example.com/b.pdf', true)).toBe('https://example.com/b.pdf');
});

// A file has no directory form: `/sitemap-index.xml/` is a 404.
test('withSlash leaves a path ending in a file name alone', () => {
  expect(withSlash('/sitemap-index.xml', true)).toBe('/sitemap-index.xml');
  expect(withSlash('/files/plan.pdf?v=2', true)).toBe('/files/plan.pdf?v=2');
  expect(withSlash('/sitemap-index.xml/', false)).toBe('/sitemap-index.xml');
  expect(withSlash('/v1.2', true)).toBe('/v1.2/');
  expect(withSlash('/docs.old/guide', true)).toBe('/docs.old/guide/');
});

test.each(['', '/', '/site', '/nested/site', '/site/'])(
  'preview URLs round trip under base %s',
  (base) => {
    for (const prefixDefaultLocale of [false, true]) {
      const i18n = { base, locales: ['en', 'de'], defaultLocale: 'en', prefixDefaultLocale };
      const collections = {
        pages: { route: '/[slug]' },
        blog: { index: '/blog', route: '/blog/[slug]' },
      };
      for (const locale of i18n.locales) {
        const url = entryUrl(i18n, '/[slug]', 'home', locale) ?? '';
        expect(previewTarget(i18n, collections, url)).toEqual({
          collection: 'pages',
          locale,
          address: 'home',
        });
        const index = entryUrl(i18n, '/blog', '', locale) ?? '';
        expect(previewTarget(i18n, collections, `${index}/`)).toEqual({
          collection: 'blog',
          locale,
        });
      }
      if (base.replace(/\/+$/, '')) {
        expect(previewTarget(i18n, collections, '/de/home')).toBeUndefined();
        expect(previewTarget(i18n, collections, `${base}ish/de/home`)).toBeUndefined();
      }
    }
  },
);
