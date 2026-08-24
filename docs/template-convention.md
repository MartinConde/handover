# Template convention

Handover reads and writes the same content files your Astro build renders, and later
previews unpublished edits through your own templates. That only works if every page
gets its data the same way. Three rules:

1. Schemas live in `src/content/schemas.ts` as plain Zod, imported by `content.config.ts`.
2. A layout takes `data` as a prop and never fetches.
3. Each page type has one `load(source, ctx)` in `src/loaders/`, and `src/pages/*.astro`
   only calls it.

## `schemas.ts`

```ts
// src/content/schemas.ts
import { z } from 'astro/zod';

export const listing = z.object({
  title: z.string(),
  location: z.string(),
  price: z.string(),
  summary: z.string(),
});

export type Listing = z.infer<typeof listing>;
```

## `content.config.ts`

Astro reads the same files, so every collection needs a `glob` loader whose `base` is that
collection's folder and whose schema is the one from `schemas.ts`. A `base` that does not match
the folder is not an error — the collection is simply empty, and its pages render nothing.

```ts
// src/content.config.ts
import { glob } from 'astro/loaders';
import { defineCollection } from 'astro:content';
import { listing } from './content/schemas';

// The id is the file's path and nothing else; Astro's default would file an entry under the
// `slug` in its data, which is where localizedSlugs keeps an address.
const byPath = ({ entry }: { entry: string }) => entry.replace(/\.ya?ml$/, '');

export const collections = {
  listings: defineCollection({
    loader: glob({ pattern: '**/*.yaml', base: './src/content/listings', generateId: byPath }),
    schema: listing,
  }),
};
```

The collection key is the folder name and the key in `cms.config.ts`; the locale folder inside
it becomes the first segment of the entry id, which is why `getEntry` takes `locale/slug`.
**`generateId` is not optional on a collection with
[`localizedSlugs`](configuration.md#localizedslugs)** — without it those entries are filed under
their addresses, every lookup misses, and reading the collection throws saying so.

### Quote dates in a file you write by hand

`published: 2026-07-14` is a YAML timestamp: Astro's loader reads it as a `Date` and your
`z.iso.date()` fails with `Expected type "string", received "object"`. Write
`published: "2026-07-14"`, and the same for anything that looks like a time.

The build refuses an unquoted date before Astro's loader sees it, naming the file and the key,
and `handover migrate --dry-run` reports them without writing. Files the CMS writes are always
quoted, so this only bites on a file you or a script created.

## A loader

`ContentSource` is `{ getEntry, getCollection }`. Entry ids are `locale/slug`, matching the
folder layout `src/content/<collection>/<locale>/<slug>.yaml`, and `getCollection` takes the
locale and returns only that folder. `staticSource` wraps Astro's own `astro:content` functions;
pass them in, since the package does not import `astro:content` itself. The first argument
everywhere is the site id — use `'default'`.

```ts
// src/loaders/listing.ts
import { type ContentSource, staticSource as createStaticSource } from 'astro-handover';
import { getCollection, getEntry } from 'astro:content';
import type { Listing } from '../content/schemas';

type Source = ContentSource<{ listings: Listing }>;

export const staticSource: Source = createStaticSource('default', {
  getEntry: async (collection, id) => getEntry(collection, id),
  getCollection: (collection) => getCollection(collection),
});

export async function load(source: Source, { locale, slug }: { locale: string; slug: string }) {
  const entry = await source.getEntry('listings', `${locale}/${slug}`);
  return entry?.data;
}
```

`ContentSource<{ listings: Listing }>` maps collection names to their data type, so
`entry.data` is typed without casts.

**A miss is a value, not an error.** Return `undefined` and let the page answer `404`. A
`.catch()` around the call swallows everything, so a real problem — a `generateId` the loader is
missing, a schema a file no longer satisfies — reaches the visitor as a 404 with nothing said.

## A page

```astro
---
// src/pages/listings/[slug].astro
import Page from '../../layouts/Page.astro';
import { load, staticSource } from '../../loaders/listing';

const data = await load(staticSource, { locale: 'en', slug: Astro.params.slug });
if (!data) return new Response('Not found', { status: 404 });
---

<Page data={data} />
```

## A page with an address per language

A collection with [`localizedSlugs`](configuration.md#localizedslugs) is not addressed by its
file name: `de/home.yaml` with `slug: startseite` is served at `/de/startseite` and no longer at
`/de/home`. The old address 301s from `_redirects`, which the assets layer serves before the
route runs.

An **on-demand** route resolves the address with `entryAt()` rather than by id — the file name
comes back off the entry, for the switcher:

```ts
import { entryAt, getEntryLocales } from 'astro-handover';
import cms from '../../cms.config';

export async function load(source: Source, { locale, slug }: { locale: string; slug: string }) {
  const entry = await entryAt('default', source, cms, 'pages', locale, slug);
  if (!entry) return undefined;
  const name = entry.id.slice(locale.length + 1);
  return { data: entry.data, locales: await getEntryLocales('default', source, cms, 'pages', name) };
}
```

A **prerendered** one has nothing to resolve: it reads the collection anyway, so it builds the
paths from the addresses and passes the file name through `props`. One `getStaticPaths` per
language, each in that language's own folder:

```astro
---
// src/pages/de/listings/[slug].astro
export async function getStaticPaths() {
  return (await loadAll(staticSource, { locale: 'de' })).map(({ name, address }) => ({
    params: { slug: address },
    props: { name },
  }));
}

const { name } = Astro.props;
const listing = await load(staticSource, { locale: 'de', name });
if (!listing) throw new Error(`No listing de/${name}`);
---
```

`loadAll` reads each address with `entryAddress('default', entry.data, name)` — the `slug` in the
file, or the file name. Never `entry.data.slug`: Astro puts a warning getter there on every entry
without one, and touching it logs on every render.

**A miss here is a bug and not a 404**, the one place the rule above is the other way round:
every path came from `getStaticPaths`, so `undefined` means the build disagrees with itself.

## The layout

```astro
---
// src/layouts/Page.astro
import type { Listing } from '../content/schemas';

interface Props {
  data: Listing;
}

const { data } = Astro.props;
---

<h1>{data.title}</h1>
<p>{data.location} · {data.price}</p>
```

Rendering what a loader returned — `<Blocks />`, `<Markdown />`, `<LocaleSwitcher />` and
hidden entries — is [Rendering content](rendering.md).
