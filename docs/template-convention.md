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
collection's folder and whose schema is the one from `schemas.ts`. A `base` that does not
match the folder is not an error: the collection is simply empty, and every page built from
it renders nothing.

```ts
// src/content.config.ts
import { glob } from 'astro/loaders';
import { defineCollection } from 'astro:content';
import { listing, page } from './content/schemas';

// The id is the file's path and nothing else. Astro's default reads a `slug` out of the data
// and files the entry under that instead, which is exactly where localizedSlugs keeps an
// address: `de/home.yaml` with `slug: startseite` would stop being the German half of `home`.
const byPath = ({ entry }: { entry: string }) => entry.replace(/\.ya?ml$/, '');

export const collections = {
  listings: defineCollection({
    loader: glob({ pattern: '**/*.yaml', base: './src/content/listings', generateId: byPath }),
    schema: listing,
  }),
  pages: defineCollection({
    loader: glob({ pattern: '**/*.yaml', base: './src/content/pages', generateId: byPath }),
    schema: page,
  }),
};
```

The collection key is the folder name and the key in `cms.config.ts`; the locale folder
inside it becomes the first segment of the entry id, which is why `getEntry` takes
`locale/slug`. **`generateId` is not optional on a collection with
[`localizedSlugs`](configuration.md#localizedslugs)** — without it that collection's entries
are filed under their addresses, and every lookup by `locale/name` misses.

### Quote dates in a file you write by hand

`published: 2026-07-14` is a YAML timestamp: Astro's loader reads it as a `Date` and your
`z.iso.date()` fails with `Expected type "string", received "object"`. Write
`published: "2026-07-14"`. The same goes for anything that looks like a time —
`2026-07-14 09:00:00`.

The build refuses an unquoted date before Astro's loader sees it, naming the file and the
key, and `handover migrate --dry-run` reports them without writing. Files the CMS writes
are always quoted, so this only bites on a file you or a script created.

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

## A page with an address per language

A collection with [`localizedSlugs`](configuration.md#localizedslugs) is not addressed by its
file name: `de/home.yaml` with `slug: startseite` is served at `/de/startseite` and no longer
at `/de/home`. Resolve it with `entryAt()` rather than by id, and the file name comes back off
the entry for the switcher:

```ts
import { entryAt, getEntryLocales } from 'astro-handover';
import cms from '../../cms.config';

export async function load(source: Source, { locale, slug }: { locale: string; slug: string }) {
  const entry = await entryAt('default', source, cms, 'pages', locale, slug);
  if (!entry) throw new Error(`No page ${locale}/${slug}`);
  const name = entry.id.slice(locale.length + 1);
  return { data: entry.data, locales: await getEntryLocales('default', source, cms, 'pages', name) };
}
```

The old address 301s from `_redirects`, which the assets layer serves before the route runs.

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
a YAML field does not. `<Markdown />` renders a `richtext()` field, and renders only what
the field's tier allows: paragraphs, bold, italic, links, lists, and — in `richtext('full')`
— `##`/`###` headings with ids and blockquotes. It outputs the elements with no wrapper;
put it inside your own `<div class="prose">` if you style one.

```astro
---
import Markdown from 'astro-handover/Markdown.astro';
---

<Markdown content={data.body} />
```

The HTML is built element by element from the parsed Markdown, so nothing the tiers
disallow can reach the page: raw HTML in a hand-written file comes out as visible text,
not as markup. That is why the component may set it as HTML at all, and why routing a
richtext field through some other Markdown library into `set:html` yourself is not the
same thing.

It runs on Cloudflare, which Astro's own pipeline does not: that pipeline is a native
binary, and a page that renders it on a Worker throws `The WASI method is not
implemented` — prerendered pages included, since `@astrojs/cloudflare` prerenders inside
the same runtime.

## The language switcher

`getEntryLocales()` answers which languages one entry can be read in — it has a file in that
language's folder and the file is not hidden — and where each one is served. It reads the
collections, so it costs the build no lookup of its own. Give it your `cms.config.ts`: the
languages and the collections' routes are all it takes.

```ts
// src/loaders/page.ts
import { getEntryLocales } from 'astro-handover';
import cms from '../../cms.config';

export const locales = (source: Source, slug: string) =>
  getEntryLocales('default', source, cms, 'pages', slug);
```

```astro
---
// src/pages/de/[slug].astro
import LocaleSwitcher from 'astro-handover/LocaleSwitcher.astro';
import { load, locales, staticSource } from '../../loaders/page';

const slug = Astro.params.slug ?? '';
const data = await load(staticSource, { locale: 'de', slug });
---

<LocaleSwitcher locales={await locales(staticSource, slug)} current="de" />
```

The links come from the collection's `route` with the language's segment applied, so
`prefixDefaultLocale` is honoured and no template hardcodes `/de/`. The language being read is
a `<span aria-current="true">`, not a link.

An entry that can be read in one language draws **nothing** — a single button says nothing and
goes nowhere — so a site that declares one language never draws a switcher.

Each button is the language's code in capitals. For anything else — the language's own name, a
flag, a menu — call `getEntryLocales()` and write the markup yourself. One URL on its own is
`entryUrl('default', cms.i18n, '/[slug]', slug, 'de')`.

## Hidden entries

An entry with `_status: hidden` in its file stays in the repo but must not render.
`filterLive` drops those entries from a `getCollection` result; `isLive(siteId, data)`
is the same check for one entry. Use them in loaders and in `getStaticPaths`, so a hidden
entry 404s instead of being reachable by URL.

`isLive(siteId, data, locale)` asks the same of one language: a hidden file is not live in any,
and neither is a language the entry's `_locales` does not offer it in. The switcher does not
need the third argument — it holds the language's own file, and a language an entry is not
offered in has no file. Pass it when what you hold is an entry rather than a file.

```ts
import { filterLive } from 'astro-handover';

export async function list(source: Source, locale: string) {
  return filterLive('default', await source.getCollection('listings', locale));
}
```

If a layout calls `getEntry()` itself, preview cannot substitute draft content for it.
Keep fetching in loaders.
