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

## Blocks

`<Blocks />` renders a `blocks()` field from the list and a `{ _type: component }` map.
Each component receives the stored block as `block` and the map as `components`, so a
block that nests `blocks` renders them by calling `<Blocks />` again with the same map.
A `_type` with no component throws at build, naming the type; a block with `_ref` is
skipped until the globals collection exists.

```ts
// src/blocks/registry.ts
import type { BlockType } from '../content/schemas';
import Columns from './Columns.astro';
import Hero from './Hero.astro';

// A block type with a schema but no component fails typecheck here, not at build.
export const components = { hero: Hero, columns: Columns } satisfies Record<BlockType, unknown>;
```

`BlockType` is `keyof` the plain object the schema registry is built from, so in
`schemas.ts` write `const blockTypes = { hero, columns }`, then
`export const registry: BlockRegistry = blockTypes` and
`export type BlockType = keyof typeof blockTypes`.

```astro
---
// src/blocks/Columns.astro — a block that nests blocks
import Blocks from 'astro-handover/Blocks.astro';
import type { z } from 'astro/zod';
import type { columns } from '../content/schemas';
import type { components } from './registry';

interface Props {
  block: z.infer<typeof columns>;
  components: typeof components;
}

const { block, components: registry } = Astro.props;
---

<section>
  {block.columns.map((column) => <div><Blocks blocks={column.blocks} components={registry} /></div>)}
</section>
```

The layout renders the top level: `<Blocks blocks={data.blocks} components={components} />`.

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

> **Not on Cloudflare yet.** Astro 7's Markdown pipeline is a native binary and the
> Workers runtime cannot run it: a page that renders `<Markdown />` throws
> `The WASI method is not implemented`. That includes prerendered pages, because
> `@astrojs/cloudflare` prerenders inside the same runtime. (In a pnpm workspace the build
> usually stops earlier still, unable to resolve the pipeline's WASI build.) A richtext
> field therefore has no renderer on Cloudflare until `<Markdown />` is rewritten — don't
> route the field through another Markdown library into `set:html`, which is the raw HTML
> the tiers exist to keep out.

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
