# Loaders and pages

The other two rules of the [template convention](template-convention.md): a page type gathers
its data in one `load()`, and the layout is handed the result. Follow them and
[preview](preview.md) renders your real pages from an unpublished draft — it calls the same
`load()` your page calls, with a source that reads the drafts, and renders the same component.

## A loader

`ContentSource` provides `getEntry` and `getCollection`, with an optional `preview` flag. Entry ids are `locale/slug`, matching the
folder layout `src/content/<collection>/<locale>/<slug>.yaml`, and `getCollection` takes the
locale and returns only that folder. `staticSource` wraps Astro's own `astro:content` functions;
pass them in, since the package does not import `astro:content` itself.

**`load()` returns the props its page renders**, and names the component that renders them. The
page file spreads one into the other.

```ts
// src/loaders/listing.ts
import { type ContentSource, entryAt, staticSource as createStaticSource } from 'astro-handover';
import { getCollection, getEntry } from 'astro:content';
import type { Listing } from '../content/schemas';
import cms from '../../cms.config';

export { default as Page } from '../layouts/Page.astro';

type Source = ContentSource<{ listings: Listing }>;

export const staticSource: Source = createStaticSource({
  getEntry: async (collection, id) => getEntry(collection, id),
  getCollection: (collection) => getCollection(collection),
});

export async function load(source: Source, { locale, slug }: { locale: string; slug: string }) {
  const entry = await entryAt(source, cms, 'listings', locale, slug);
  return entry && { data: entry.data, locale };
}
```

`ContentSource<{ listings: Listing }>` maps collection names to their data type, so
`entry.data` is typed without casts.

Use `entryAt()` for public single-page reads: hidden entries return `undefined`, including
localized addresses. `draftSource()` sets `preview: true` so authenticated preview can still
render hidden entries. Public sources must omit that flag. Raw `source.getEntry()` and
`getCollection()` remain unfiltered reads; use `filterLive()` for public lists. Preserve
`_status` in the content schema, as the generated starter does.

Draft sources also provide optional `getEntryMetadata(collection, id)` and
`getCollectionMetadata(collection, locale)` reads. Their data is `unknown` and has not passed
the collection schema; use it only for link titles, addresses and visibility. `menusAt()`,
`getEntryLocales()` and localized address resolution use these reads automatically, falling
back to ordinary reads for custom sources without them. `entryAt()` then reads the matched
page through `getEntry()` so the content it returns is still validated. Rendered content
must always use `getEntry()` or `getCollection()`.

**A miss is a value, not an error.** Return `undefined` and let the page answer `404`. A
`.catch()` around the call swallows everything, so a real problem — a `generateId` the loader is
missing, a schema a file no longer satisfies — reaches the visitor as a 404 with nothing said.

`slug` is the address in the URL. Point `cms.config.ts` at the file with
[`load`](configuration.md#collections), which is the name without the folder or the extension:
`{ route: '/listings/[slug]', load: 'listing' }`.

## A page

```astro
---
// src/pages/listings/[slug].astro
import Page from '../../layouts/Page.astro';
import { load, staticSource } from '../../loaders/listing';

const listing = await load(staticSource, { locale: 'en', slug: Astro.params.slug! });
if (!listing) return new Response('Not found', { status: 404 });
---

<Page {...listing} />
```

## The index of a collection

A collection whose `cms.config.ts` entry has an [`index`](configuration.md#collections) has a second
pair in the same file — `loadIndex(source, { locale })` and the component it names — because
that page is the collection rather than one entry. The prerendered routes build their paths
from it, so nothing lists the folder twice.

```ts
export { default as Index } from '../layouts/Index.astro';

export async function loadIndex(source: Source, { locale }: { locale: string }) {
  const entries = filterLive(await source.getCollection('listings', locale));
  return {
    locale,
    listings: entries.map((e) => {
      const name = e.id.slice(locale.length + 1);
      return { address: entryAddress(e.data, name), data: e.data };
    }),
  };
}
```

**[Globals](site-files.md) are gathered here too** and passed down as props.
`globalsAt(source, locale)` reads the entire collection. For preview, pass a third
argument such as `{ required: ['site', 'navigation'], blocks: entry.data.blocks }` to read only
the layout's globals and references in the rendered block tree. Required drafts still validate;
invalid unused globals are never read. See [Blocks](blocks.md) for the shared loader example.

A layout that fetches its own reads the *published* file, so the one thing
preview would not show is the change the client just made to it.

## A home page

A page entry served at `/` is the `pages` collection's index, and the file named `index` is its
copy: `pages: { schema: page, route: '/[slug]', index: '/', load: 'page' }` and
`src/content/pages/de/index.yaml`. Preview, Canvas, page links and the sitemap give that entry
`/`; `/index` is not its address. The admin lists it first, marked with a house and **Home page**. The pages loader reads it for its index:

```ts
// src/loaders/page.ts
export { default as Page, default as Index } from '../layouts/Page.astro';

export const loadIndex = (source: Source, { locale }: { locale: string }) =>
  load(source, { locale, slug: 'index' });
```

`src/pages/index.astro` renders `<Index {...await loadIndex(staticSource, { locale: 'de' })} />`,
and `src/pages/[slug].astro` leaves `index` out of its `getStaticPaths`.

A collection with [`localizedSlugs`](configuration.md#localizedslugs) finds its entry by address
rather than by id: [A page with an address per language](loaders-addresses.md).

## The layout

```astro
---
// src/layouts/Page.astro
import type { Listing } from '../content/schemas';

interface Props {
  data: Listing;
  locale: string;
}

const { data, locale } = Astro.props;
---

<h1>{data.title}</h1>
<p>{data.location} · {data.price}</p>
```

Rendering what a loader returned — `<Blocks />`, `<Markdown />`, `<LocaleSwitcher />` and
hidden entries — is [Rendering content](rendering.md), and the block renderer is [Blocks](blocks.md).
