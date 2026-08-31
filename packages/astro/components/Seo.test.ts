import { parseEntry, type SeoValue, sitemapFrom } from '@handover/core';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { expect, test } from 'vitest';
import Seo from './Seo.astro';

const base = {
  title: 'Seaview Cottage',
  siteName: 'Coastal Homes',
  locale: 'en',
  mediaBase: 'https://media.example',
  site: 'https://coastalhomes.example',
};

const defaults = {
  titlePattern: '%s · Coastal Homes',
  description: 'Coastal homes in Devon.',
  image: { src: 'media/site-card.webp', alt: 'Coastal Homes', width: 1200, height: 630 },
  twitter: '@coastalhomes',
};

const render = (props: unknown, url = 'https://coastalhomes.example/listings/seaview-cottage/') =>
  AstroContainer.create().then((c) => c.renderToString(Seo, { props, request: new Request(url) }));

test('<Seo /> says what the entry says about itself', async () => {
  const html = await render({
    ...base,
    seo: { title: 'Move to the coast', description: 'Above the harbour.' },
  });

  expect(html).toContain('<title>Move to the coast</title>');
  expect(html).toContain('<meta name="description" content="Above the harbour.">');
  expect(html).toContain('<meta property="og:title" content="Move to the coast">');
  expect(html).toContain('<meta property="og:description" content="Above the harbour.">');
  expect(html).toContain('<meta property="og:site_name" content="Coastal Homes">');
  expect(html).toContain('<meta property="og:locale" content="en">');
  expect(html).toContain('<meta property="og:type" content="website">');
});

test('<Seo /> falls back to the site defaults for a page nobody wrote one for', async () => {
  const html = await render({ ...base, defaults });

  expect(html).toContain('<title>Seaview Cottage · Coastal Homes</title>');
  expect(html).toContain('<meta name="description" content="Coastal homes in Devon.">');
  expect(html).toContain(
    '<meta property="og:image" content="https://media.example/media/site-card.webp">',
  );
  expect(html).toContain('<meta name="twitter:site" content="@coastalhomes">');
});

test('<Seo /> gives the picture its size and its words', async () => {
  const image = { src: 'media/9f3a.webp', alt: 'Front of the house', width: 2400, height: 1600 };
  const html = await render({ ...base, defaults, seo: { image } });

  expect(html).toContain(
    '<meta property="og:image" content="https://media.example/media/9f3a.webp">',
  );
  expect(html).toContain('<meta property="og:image:alt" content="Front of the house">');
  expect(html).toContain('<meta property="og:image:width" content="2400">');
  expect(html).toContain('<meta property="og:image:height" content="1600">');
  expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
});

// No picture anywhere is a small card, not a large one with a hole in it.
test('<Seo /> asks for the card the picture it has can fill', async () => {
  const html = await render(base);
  expect(html).toContain('<meta name="twitter:card" content="summary">');
  expect(html).not.toContain('og:image');
});

test('<Seo /> marks a page kept out of search and says nothing else about it', async () => {
  const html = await render({ ...base, defaults, seo: { noindex: true } });
  expect(html).toContain('<meta name="robots" content="noindex">');
  expect(html).toContain('<title>Seaview Cottage · Coastal Homes</title>');
});

test('<Seo /> leaves out the robots tag for a page that is in search', async () => {
  expect(await render({ ...base, defaults })).not.toContain('name="robots"');
});

test('<Seo /> points the canonical at this page, or where the entry says instead', async () => {
  const here = await render(base);
  expect(here).toContain(
    '<link rel="canonical" href="https://coastalhomes.example/listings/seaview-cottage/">',
  );
  expect(here).toContain(
    '<meta property="og:url" content="https://coastalhomes.example/listings/seaview-cottage/">',
  );

  const elsewhere = await render({ ...base, seo: { canonical: 'https://example.com/original' } });
  expect(elsewhere).toContain('<link rel="canonical" href="https://example.com/original">');
});

// A relative hreflang is not an address, and a guessed origin is the build host: neither is
// worth emitting, so a site that declares none gets the tags that need no origin and no more.
test('<Seo /> emits no address at all when the site has not said where it lives', async () => {
  const html = await render({
    ...base,
    site: undefined,
    defaults,
    locales: [{ locale: 'de', url: '/de/' }],
  });

  expect(html).toContain('<title>Seaview Cottage · Coastal Homes</title>');
  expect(html).not.toContain('rel="canonical"');
  expect(html).not.toContain('og:url');
  expect(html).not.toContain('hreflang');
});

const alternates = [
  { locale: 'en', url: '/listings/seaview-cottage' },
  { locale: 'de', url: '/de/angebote/seaview-cottage' },
];

test('<Seo /> lists every language the entry can be read in', async () => {
  const html = await render(
    { ...base, locales: alternates },
    'https://coastalhomes.example/listings/seaview-cottage',
  );

  expect(html).toContain(
    '<link rel="alternate" hreflang="en" href="https://coastalhomes.example/listings/seaview-cottage">',
  );
  expect(html).toContain(
    '<link rel="alternate" hreflang="de" href="https://coastalhomes.example/de/angebote/seaview-cottage">',
  );
});

// One page has one address, and the site serves it under one of the two forms: a cluster whose
// self-reference is the other form is a cluster this page is not in, and every other language
// in it points at the redirect the site answers with.
test('<Seo /> writes the alternates the way the site writes this page', async () => {
  const html = await render({ ...base, locales: alternates });

  expect(html).toContain(
    '<link rel="canonical" href="https://coastalhomes.example/listings/seaview-cottage/">',
  );
  expect(html).toContain(
    '<link rel="alternate" hreflang="en" href="https://coastalhomes.example/listings/seaview-cottage/">',
  );
  expect(html).toContain(
    '<link rel="alternate" hreflang="de" href="https://coastalhomes.example/de/angebote/seaview-cottage/">',
  );
});

// The root is the one path that is a trailing slash, and stripping it leaves nothing.
test('<Seo /> leaves the site root alone whichever form this page is under', async () => {
  const html = await render(
    {
      ...base,
      locales: [
        { locale: 'en', url: '/' },
        { locale: 'de', url: '/de/' },
      ],
    },
    'https://coastalhomes.example/listings/a',
  );
  expect(html).toContain(
    '<link rel="alternate" hreflang="en" href="https://coastalhomes.example/">',
  );
  expect(html).toContain(
    '<link rel="alternate" hreflang="de" href="https://coastalhomes.example/de">',
  );
});

// One language is nothing to alternate between, which is the rule <LocaleSwitcher /> follows.
test('<Seo /> draws no alternates for an entry with one language', async () => {
  const html = await render({ ...base, locales: [{ locale: 'en', url: '/listings/a' }] });
  expect(html).not.toContain('hreflang');
});

test('<Seo /> escapes what a hand-edited file put in the title', async () => {
  const html = await render({ ...base, seo: { title: 'a" onload="alert(1)' } });
  expect(html).toContain('content="a&quot; onload=&quot;alert(1)"');
  expect(html).not.toContain('onload="alert(1)">');
});

// The two readings of one switch: the tag this component writes and the URL the build leaves
// out of the sitemap. Asserted together, off the same file, because a page that says `noindex`
// and is still offered to a crawler is the same defect as an hreflang pointing at a redirect.
const crawl = {
  i18n: { locales: ['en'], defaultLocale: 'en' },
  collections: { listings: { route: '/listings/[slug]' } },
  base: 'https://coastalhomes.example',
  slash: true,
};
const entryFile = (contents: string) => [
  { path: 'src/content/listings/en/seaview-cottage.yaml', contents },
];
const seoOf = (contents: string) => (parseEntry('default', contents) as { seo?: SeoValue }).seo;
const listed = (contents: string) =>
  (sitemapFrom('default', entryFile(contents), crawl).en ?? []).map((p) => p.loc);

test('the page <Seo /> marks noindex is the page the sitemap leaves out', async () => {
  const hidden = 'title: "Seaview Cottage"\nseo:\n  noindex: true\n';
  const shown = 'title: "Seaview Cottage"\n';

  expect(await render({ ...base, seo: seoOf(hidden) })).toContain(
    '<meta name="robots" content="noindex">',
  );
  expect(listed(hidden)).toEqual([]);

  expect(await render({ ...base, seo: seoOf(shown) })).not.toContain('name="robots"');
  expect(listed(shown)).toEqual(['https://coastalhomes.example/listings/seaview-cottage/']);
});
