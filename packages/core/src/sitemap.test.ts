import { expect, test } from 'vitest';
import { robotsText, sitemapFrom, sitemapIndexXml, sitemapXml } from './sitemap.js';

const BASE = 'https://coastalhomes.example';

const site = {
  i18n: { locales: ['en', 'de'], defaultLocale: 'en' },
  collections: {
    listings: { route: '/listings/[slug]', index: '/' },
    pages: { route: '/[slug]' },
    samples: {},
  },
  base: BASE,
  slash: true,
};

const at = (path: string, contents: string) => ({ path, contents });
const mill = (extra = '') => `title: "The Mill House"\n${extra}`;
const muehle = (extra = '') => `title: "Das Mühlenhaus"\nslug: "muehlenhaus"\n${extra}`;
const both = (en = '', de = '') => [
  at('src/content/listings/en/mill-house.yaml', mill(en)),
  at('src/content/listings/de/mill-house.yaml', muehle(de)),
];
const locs = (pages: ReturnType<typeof sitemapFrom>, locale: string) =>
  (pages[locale] ?? []).map((p) => p.loc);

test('an entry is one URL per language it is written in, under that language’s own address', () => {
  const pages = sitemapFrom('default', both(), site);
  expect(locs(pages, 'en')).toEqual([`${BASE}/`, `${BASE}/listings/mill-house/`]);
  expect(locs(pages, 'de')).toEqual([`${BASE}/de/`, `${BASE}/de/listings/muehlenhaus/`]);
});

test('every language of a page is named beside it as an alternate', () => {
  const [page] = sitemapFrom('default', both(), site).en?.slice(1) ?? [];
  expect(page?.alternates).toEqual([
    { locale: 'en', loc: `${BASE}/listings/mill-house/` },
    { locale: 'de', loc: `${BASE}/de/listings/muehlenhaus/` },
  ]);
});

test('a hidden entry is in no language’s sitemap', () => {
  const pages = sitemapFrom('default', both('_status: "hidden"\n', '_status: "hidden"\n'), site);
  expect(locs(pages, 'en')).toEqual([`${BASE}/`]);
  expect(locs(pages, 'de')).toEqual([`${BASE}/de/`]);
});

test('a page asking to stay out of search is left out of the sitemap', () => {
  const noindex = 'seo:\n  noindex: true\n';
  const pages = sitemapFrom('default', both(noindex, noindex), site);
  expect(locs(pages, 'en')).toEqual([`${BASE}/`]);
});

test('a language the entry is not offered in is left out, and alternates one language is not a list', () => {
  const only = '_locales:\n  - "en"\n';
  const pages = sitemapFrom('default', both(only, only), site);
  expect(locs(pages, 'en')).toEqual([`${BASE}/`, `${BASE}/listings/mill-house/`]);
  expect(locs(pages, 'de')).toEqual([`${BASE}/de/`]);
  expect(pages.en?.[1]?.alternates).toEqual([]);
});

test('a collection nothing renders contributes no URL', () => {
  const pages = sitemapFrom(
    'default',
    [at('src/content/samples/en/everything.yaml', 'title: "Everything"\n')],
    site,
  );
  expect(locs(pages, 'en')).toEqual([`${BASE}/`]);
});

test('a site that serves its pages without the slash is written without it', () => {
  const pages = sitemapFrom('default', both(), { ...site, slash: false });
  expect(locs(pages, 'en')).toEqual([`${BASE}/`, `${BASE}/listings/mill-house`]);
  expect(locs(pages, 'de')).toEqual([`${BASE}/de`, `${BASE}/de/listings/muehlenhaus`]);
});

test('the XML is one url per page, with its alternates inside it', () => {
  expect(
    sitemapXml('default', [
      {
        loc: `${BASE}/listings/mill-house/`,
        alternates: [
          { locale: 'en', loc: `${BASE}/listings/mill-house/` },
          { locale: 'de', loc: `${BASE}/de/listings/muehlenhaus/` },
        ],
      },
    ]),
  ).toBe(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
      '  <url>\n' +
      `    <loc>${BASE}/listings/mill-house/</loc>\n` +
      `    <xhtml:link rel="alternate" hreflang="en" href="${BASE}/listings/mill-house/"/>\n` +
      `    <xhtml:link rel="alternate" hreflang="de" href="${BASE}/de/listings/muehlenhaus/"/>\n` +
      '  </url>\n' +
      '</urlset>\n',
  );
});

test('an address with an ampersand in it is escaped rather than breaking the file', () => {
  const pages = sitemapFrom('default', [at('src/content/pages/en/rd.yaml', 'slug: "r&d"\n')], {
    ...site,
    collections: { pages: { route: '/[slug]' } },
  });
  expect(locs(pages, 'en')).toEqual([`${BASE}/r&d/`]);
  expect(sitemapXml('default', pages.en ?? [])).toContain(`<loc>${BASE}/r&amp;d/</loc>`);
});

test('the index names one sitemap per language', () => {
  expect(sitemapIndexXml('default', [`${BASE}/sitemap-en.xml`, `${BASE}/sitemap-de.xml`])).toBe(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      `  <sitemap><loc>${BASE}/sitemap-en.xml</loc></sitemap>\n` +
      `  <sitemap><loc>${BASE}/sitemap-de.xml</loc></sitemap>\n` +
      '</sitemapindex>\n',
  );
});

test('robots.txt points at the sitemap and keeps crawlers out of the admin', () => {
  expect(robotsText('default', `${BASE}/sitemap-index.xml`)).toBe(
    `User-agent: *\nDisallow: /admin\nDisallow: /_preview\n\nSitemap: ${BASE}/sitemap-index.xml\n`,
  );
});

test('robots.txt names no sitemap for a site that has not said where it is served', () => {
  expect(robotsText('default')).toBe('User-agent: *\nDisallow: /admin\nDisallow: /_preview\n');
});
