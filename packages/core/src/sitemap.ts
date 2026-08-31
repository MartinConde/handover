// What the build tells a crawler: one sitemap per language, an index naming them, and a
// robots.txt pointing at that. All three are static files, so a search engine reading them
// costs the site nothing.

import { parseEntry } from './content.js';
import { type ContentFile, entryParts } from './entries.js';
import { entryAddress, entryUrl, type I18nRouting, withSlash } from './names.js';
import { isLive } from './reserved.js';

/** One page: where it is served, and the same page in the other languages. */
export interface SitemapPage {
  loc: string;
  /** Every language this page can be read in, this one included; empty where there is one. */
  alternates: { locale: string; loc: string }[];
}

export interface SitemapSite {
  i18n: I18nRouting;
  collections: Record<string, { route?: string; index?: string }>;
  /** Where the site is served, from `astro.config.mjs`: `https://example.com`. */
  base: string;
  /**
   * Whether an address is written with a trailing slash. A sitemap URL that redirects is one
   * more hop for every crawler, so the form here is the form the site's own pages answer at.
   */
  slash: boolean;
}

const href = (site: SitemapSite, path: string) =>
  new URL(withSlash(path, site.slash), site.base).href;

/**
 * Every address the site serves, by language. An entry is in it once per language it is
 * written in, live in and not hidden from search in — the same three answers the page itself
 * gives, so a URL here is a page a crawler can index.
 *
 * The switch is read as `seo.noindex`, by that key: a site names its field `seo` the way it
 * names its defaults `defaultSeo`, and nothing else has to be configured.
 */
export function sitemapFrom(
  siteId: string,
  files: Iterable<ContentFile>,
  site: SitemapSite,
): Record<string, SitemapPage[]> {
  const entries = new Map<string, Map<string, string>>();
  for (const file of files) {
    const parts = entryParts(file.path);
    const route = parts && site.collections[parts.collection]?.route;
    if (!parts || !route) continue;
    const data = parseEntry(siteId, file.contents) as Record<string, unknown> | null;
    if (!isLive(siteId, data, parts.locale)) continue;
    if ((data?.seo as { noindex?: unknown } | undefined)?.noindex === true) continue;
    const address = entryAddress(siteId, data, parts.name);
    const url = entryUrl(siteId, site.i18n, route, address, parts.locale);
    if (!url) continue;
    const key = `${parts.collection}/${parts.name}`;
    const locales = entries.get(key) ?? new Map<string, string>();
    entries.set(key, locales);
    locales.set(parts.locale, href(site, url));
  }

  // A listing page is the collection rather than one of its entries, so it is not in the walk
  // above and is served in every language the site has.
  for (const c of Object.values(site.collections)) {
    if (!c.index) continue;
    const locales = new Map<string, string>();
    for (const locale of site.i18n.locales) {
      const url = entryUrl(siteId, site.i18n, c.index, '', locale);
      if (url) locales.set(locale, href(site, url));
    }
    entries.set(`index:${c.index}`, locales);
  }

  const pages: Record<string, SitemapPage[]> = Object.fromEntries(
    site.i18n.locales.map((locale) => [locale, [] as SitemapPage[]]),
  );
  for (const locales of entries.values()) {
    const alternates =
      locales.size > 1
        ? site.i18n.locales.flatMap((locale) => {
            const loc = locales.get(locale);
            return loc ? [{ locale, loc }] : [];
          })
        : [];
    for (const [locale, loc] of locales) pages[locale]?.push({ loc, alternates });
  }
  // Sorted so a build with no content change writes the same bytes, and deduplicated because
  // two collections may share one index page even though no two share a route.
  return Object.fromEntries(
    Object.entries(pages).map(([locale, list]) => [
      locale,
      [...new Map(list.map((p) => [p.loc, p])).values()].sort((a, b) => (a.loc < b.loc ? -1 : 1)),
    ]),
  );
}

// A path is not XML until the five characters that mean something else in it are spelled out.
const xmlText = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** One language's sitemap: each page, with its other languages named inside its own entry. */
export function sitemapXml(_siteId: string, pages: SitemapPage[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
  ];
  for (const page of pages) {
    lines.push('  <url>', `    <loc>${xmlText(page.loc)}</loc>`);
    for (const a of page.alternates)
      lines.push(
        `    <xhtml:link rel="alternate" hreflang="${xmlText(a.locale)}" href="${xmlText(a.loc)}"/>`,
      );
    lines.push('  </url>');
  }
  lines.push('</urlset>', '');
  return lines.join('\n');
}

/** `sitemap-index.xml`: the one address robots.txt names, whatever languages the site has. */
export function sitemapIndexXml(_siteId: string, locs: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...locs.map((loc) => `  <sitemap><loc>${xmlText(loc)}</loc></sitemap>`),
    '</sitemapindex>',
    '',
  ].join('\n');
}

/**
 * The admin and the preview are pages a crawler has no business in — both already say so in a
 * header, and this says it before the request. A site with no address of its own gets the same
 * file without the sitemap line, since a relative one is not an address.
 */
export function robotsText(_siteId: string, sitemap?: string): string {
  return [
    'User-agent: *',
    'Disallow: /admin',
    'Disallow: /_preview',
    ...(sitemap ? ['', `Sitemap: ${sitemap}`] : []),
    '',
  ].join('\n');
}
