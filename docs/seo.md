# Search and sharing

What a page says about itself in a search result and in a shared link: the `seo` field on an
entry, the site's own defaults, and the `<Seo />` component that turns both into tags.

## The field

`seo` is a field type like any other ([Structured fields](structured-fields.md)):

```ts
import { seo } from 'astro-handover';

export const listing = z.object({
  title: z.string(),
  seo: seo.meta({ label: 'SEO' }).optional(),
});
```

It stores `{ title?, description?, image?, noindex?, canonical? }`. Keep it `.optional()`:
every one of those has somewhere to fall back to, and a required `seo` asks a client to write
five things before a page can go out.

## Site defaults

`seoDefaults` is the other half — one title pattern, one description and one card for the whole
site. Spread it into the global your site keeps its own details in, under the key `defaultSeo`:
that key is how the package finds it, so nothing else has to be configured.

```ts
import { seoDefaults } from 'astro-handover';

export const site = z.object({
  name: z.string(),
  footerText: z.string(),
  defaultSeo: seoDefaults.optional(),
});
```

It holds `{ titlePattern?, description?, image?, twitter? }`. `titlePattern` is where `%s`
becomes the page's own title — `"%s · Coastal Homes"` — and it is a **fallback**, not a wrapper:
a page whose client typed a search title gets exactly what they typed. Each language's file
carries its own pattern and description, so the German pages read as German.

Resolution is field → global → nothing, and it is one function:

```ts
import { resolveSeo } from 'astro-handover';

resolveSeo(entry.data.seo, site.defaultSeo, entry.data.title);
// → { title, description?, image?, noindex, canonical?, twitter? }
```

## `<Seo />`

Put it in your `<head>` instead of a hand-written `<title>`:

```astro
---
import Seo from 'astro-handover/Seo.astro';
import cms from '../../cms.config';
const { data, site, locale, locales } = Astro.props;
---

<Seo
  seo={data.seo}
  defaults={site.defaultSeo}
  title={data.title}
  siteName={site.name}
  {locale}
  {locales}
  mediaBase={cms.media?.publicBase}
/>
```

It emits `<title>`, the meta description, `og:*`, `twitter:card`, `robots: noindex` where the
entry asks for it, a canonical link, and one `hreflang` alternate per language the entry can be
read in — `locales` is what [`getEntryLocales()`](rendering.md#the-language-switcher) already handed
your loader for the switcher, so a language the entry is not live in is not listed.

Two things it needs and will otherwise leave out rather than guess:

- **`site` in `astro.config.mjs`.** Without it there is no canonical, no `og:url` and no
  alternates — a relative one is not an address, and the build host is whatever machine ran
  the build. Pass `site` as a prop to override it for one page.
- **`mediaBase`.** A content file stores a media key, never a URL; without a base to serve it
  from, the card goes out as `summary` rather than pointing a crawler at a path.

A page that is not an entry — a listing index, say — passes `defaults` and a `title` and
nothing else.

## Sitemap and robots.txt

`astro build` writes them into the site's static assets: one `sitemap-<locale>.xml` per
language, a `sitemap-index.xml` naming them, and a `robots.txt` pointing at that. They are
files rather than routes, so a crawler reading them never wakes the Worker. Nothing is written
by `astro dev`.

A page is in the sitemap when it is one a visitor can reach — an entry in a collection with a
`route`, in each language it has a file for. Left out are entries that are
[hidden](entry-lifecycle.md), the languages an entry is not offered in, and every page whose
`seo.noindex` is on: that is the same switch `<Seo />` writes as `robots: noindex`, read by
that key, so a page asking to stay out of search is out of both. A collection's `index` page
is listed once per language, and every URL names its other languages as `hreflang` alternates.

`robots.txt` disallows `/admin` and `/_preview`. A `robots.txt` of your own in `public/` is
left exactly as it is — the build writes one only where there is none.

Two things worth knowing:

- **`site` in `astro.config.mjs`, again.** A sitemap holds absolute addresses. Without it no
  sitemap is written at all and `robots.txt` goes out without its `Sitemap:` line; the build
  says so as it goes past.
- **The addresses are written the way your site serves them** — with the trailing slash under
  the default `build.format: 'directory'`, without it under `trailingSlash: 'never'`. A sitemap
  full of URLs that redirect is a hop per page for every crawler.

## In the admin

The `seo` field is a tab of its own beside Content and History, and it draws a panel rather
than a row of boxes: a search title and a description, each with a line saying how much of it
a search engine will show; the social image, under a fixed 1.91:1 preset at 1200 px, which is
the 1200 × 630 every network asks for; a switch reading *Hide this page from search engines*;
and the canonical URL folded away, since almost no page has one.

The lines beside the labels are **guidance and never validation** — nothing on this panel can
refuse a save. An empty box is greyed with what the site would say instead, resolved by the
same `resolveSeo` the build runs, so what a client is shown while typing is what the page will
carry. A language being translated is given the search title, the description and the picture's
alt text; the picture, the switch and the canonical are the entry's and read the same in every
language ([Translating](translating.md)).
