# Rendering content

The components the package ships and the helpers a template calls to draw an entry it has
already loaded. Getting the entry there is [Template convention](template-convention.md).

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

`getEntryLocales()` answers about an entry. A page that is not one — an index, a search, a
contact form — builds its own pair from the same rule:

```astro
---
// src/pages/index.astro
import { entryUrl } from 'astro-handover';
import LocaleSwitcher from 'astro-handover/LocaleSwitcher.astro';
import cms from '../../cms.config';

// `entryUrl` is undefined only for a collection with no route; '/' is one.
const locales = cms.i18n.locales.map((locale) => ({
  locale,
  url: entryUrl('default', cms.i18n, '/', '', locale)!,
}));
---

<LocaleSwitcher locales={locales} current="en" />
```

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
