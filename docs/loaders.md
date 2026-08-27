# Loaders and pages

The other two rules of the [template convention](template-convention.md): a page type gathers
its data in one `load()`, and the layout is handed the result. Follow them and
[preview](preview.md) renders your real pages from an unpublished draft — it calls the same
`load()` your page calls, with a source that reads the drafts, and renders the same component.

## A loader

`ContentSource` is `{ getEntry, getCollection }`. Entry ids are `locale/slug`, matching the
folder layout `src/content/<collection>/<locale>/<slug>.yaml`, and `getCollection` takes the
locale and returns only that folder. `staticSource` wraps Astro's own `astro:content` functions;
pass them in, since the package does not import `astro:content` itself. The first argument
everywhere is the site id — use `'default'`.

**`load()` returns the props its page renders**, and names the component that renders them. The
page file spreads one into the other.

```ts
// src/loaders/listing.ts
import { type ContentSource, staticSource as createStaticSource } from 'astro-handover';
import { getCollection, getEntry } from 'astro:content';
import type { Listing } from '../content/schemas';

export { default as Page } from '../layouts/Page.astro';

type Source = ContentSource<{ listings: Listing }>;

export const staticSource: Source = createStaticSource('default', {
  getEntry: async (collection, id) => getEntry(collection, id),
  getCollection: (collection) => getCollection(collection),
});

export async function load(source: Source, { locale, slug }: { locale: string; slug: string }) {
  const entry = await source.getEntry('listings', `${locale}/${slug}`);
  return entry && { data: entry.data, locale };
}
```

`ContentSource<{ listings: Listing }>` maps collection names to their data type, so
`entry.data` is typed without casts.

**A miss is a value, not an error.** Return `undefined` and let the page answer `404`. A
`.catch()` around the call swallows everything, so a real problem — a `generateId` the loader is
missing, a schema a file no longer satisfies — reaches the visitor as a 404 with nothing said.

`slug` is the address in the URL. Point `cms.config.ts` at the file with
[`load`](configuration.md#load), which is the name without the folder or the extension:
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

A collection whose `cms.config.ts` entry has an [`index`](configuration.md#index) has a second
pair in the same file — `loadIndex(source, { locale })` and the component it names — because
that page is the collection rather than one entry. The prerendered routes build their paths
from it, so nothing lists the folder twice.

```ts
export { default as Index } from '../layouts/Index.astro';

export async function loadIndex(source: Source, { locale }: { locale: string }) {
  const entries = filterLive('default', await source.getCollection('listings', locale));
  return {
    locale,
    listings: entries.map((e) => {
      const name = e.id.slice(locale.length + 1);
      return { address: entryAddress('default', e.data, name), data: e.data };
    }),
  };
}
```

**[Globals](site-files.md) are gathered here too** — `globalsAt('default', source, locale)` — and
passed down as props. A layout that fetches its own reads the *published* file, so the one thing
preview would not show is the change the client just made to it.

## A page with an address per language

A collection with [`localizedSlugs`](configuration.md#localizedslugs) is not addressed by its
file name: `de/home.yaml` with `slug: startseite` is served at `/de/startseite` and no longer at
`/de/home`. The old address 301s from `_redirects`, which the assets layer serves before the
route runs.

The loader resolves the address with `entryAt()` rather than by id — the file name comes back
off the entry, for the switcher:

```ts
import { entryAt, getEntryLocales } from 'astro-handover';
import cms from '../../cms.config';

export async function load(source: Source, { locale, slug }: { locale: string; slug: string }) {
  const entry = await entryAt('default', source, cms, 'pages', locale, slug);
  if (!entry) return undefined;
  const name = entry.id.slice(locale.length + 1);
  return {
    data: entry.data,
    locale,
    locales: await getEntryLocales('default', source, cms, 'pages', name),
  };
}
```

A **prerendered** route is the same call: the address is what `getStaticPaths` put in the
params. One `getStaticPaths` per language, each in that language's own folder:

```astro
---
// src/pages/de/listings/[slug].astro
export async function getStaticPaths() {
  const { listings } = await loadIndex(staticSource, { locale: 'de' });
  return listings.map(({ address }) => ({ params: { slug: address } }));
}

const listing = await load(staticSource, { locale: 'de', slug: Astro.params.slug! });
if (!listing) throw new Error(`No listing de/${Astro.params.slug}`);
---
```

`entryAddress('default', entry.data, name)` is each address — the `slug` in the file, or the
file name. Never `entry.data.slug`: Astro puts a warning getter there on every entry without
one, and touching it logs on every render.

**A miss here is a bug and not a 404**, the one place the rule above is the other way round:
every path came from `getStaticPaths`, so `undefined` means the build disagrees with itself.

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
