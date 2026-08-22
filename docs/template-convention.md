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

## A loader

`ContentSource` is `{ getEntry, getCollection }`. Entry ids are `locale/slug`, matching
the folder layout `src/content/<collection>/<locale>/<slug>.yaml`, and `getCollection`
takes the locale and returns only that folder.

`staticSource` wraps Astro's own `astro:content` functions. Pass them in — the package
does not import `astro:content` itself. The first argument is the site id; use
`'default'`.

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
  if (!entry) throw new Error(`No listing ${locale}/${slug}`);
  return entry.data;
}
```

`ContentSource<{ listings: Listing }>` maps collection names to their data type, so
`entry.data` is typed without casts.

## A page

```astro
---
// src/pages/listings/[slug].astro
import Page from '../../layouts/Page.astro';
import { load, staticSource } from '../../loaders/listing';

const data = await load(staticSource, { locale: 'en', slug: Astro.params.slug });
---

<Page data={data} />
```

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

## Rich text

Only a `.md` file's body goes through Astro's Markdown pipeline; a Markdown string inside
a YAML field does not. `<Markdown />` renders a `richtext()` field with the same
pipeline, so headings get ids and typography matches the rest of the site. It outputs the
elements with no wrapper; put it inside your own `<div class="prose">` if you style one.

```astro
---
import Markdown from 'astro-handover/Markdown.astro';
---

<Markdown content={data.body} />
```

The field's validation is what keeps raw HTML out; the component renders what it is
given.

## Hidden entries

An entry with `_status: hidden` in its file stays in the repo but must not render.
`filterLive` drops those entries from a `getCollection` result; `isLive(siteId, data)`
is the same check for one entry. Use them in loaders and in `getStaticPaths`, so a hidden
entry 404s instead of being reachable by URL.

```ts
import { filterLive } from 'astro-handover';

export async function list(source: Source, locale: string) {
  return filterLive('default', await source.getCollection('listings', locale));
}
```

If a layout calls `getEntry()` itself, preview cannot substitute draft content for it.
Keep fetching in loaders.
