# Rendering content

The components the package ships and the helpers a template calls to draw an entry it has
already loaded. Getting the entry there is [Loaders and pages](loaders.md), and
the block renderer has a page of its own: [Blocks](blocks.md).

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

## Navigation menus

`menusAt()` resolves the [`navigation` global](site-files.md#navigation) for one language:
every menu by its key, every item's `ref` turned into the address that language serves, and
everything that language cannot show **dropped** — an entry with no file in it, a hidden one,
and an item whose `_locales` names another language. A dropped item takes its children with it,
so a menu never becomes the way a reader finds a 404. Resolve it in the loader, like everything
else a page needs:

```ts
// src/loaders/globals.ts — the global is read, then resolved
const globals = await globalsAt('default', source, locale);
const menus = await menusAt('default', source, cms, globals.navigation, locale);
```

```astro
---
import Nav from 'astro-handover/Nav.astro';
const { menus } = Astro.props;
---

<Nav menu="header" menus={menus} current={Astro.url.pathname} />
```

`<Nav />` draws a `<nav aria-label="Main">` with nested `<ul>`s — one `<a>` per item,
`aria-current="page"` on the one the reader is on (a trailing slash is the same page), and
`target="_blank" rel="noopener noreferrer"` where the item asks for a new tab. A menu with
nothing left in this language draws **nothing**. `label` names the landmark where a page has
two menus. The words come from the file of the language being rendered — the tree is shared and
the labels are each language's own — so an item nobody has translated is named by the page it
points at, in that language. Style it, or read `menus.header` — `{ label, href, newTab?, children }`, an item with
no `label` of its own already named by the page it points at — and write your own markup.

## Videos and maps

An `embed` field holds a provider and an id — never a URL, never markup. `<Embed />` builds the
frame's address back from the provider's own template, so nothing a client pasted into the admin
can point a frame anywhere else:

```astro
---
import Embed from 'astro-handover/Embed.astro';
const { entry } = Astro.props;
---

<Embed value={entry.data.video} />
```

It draws a `<div class="handover-embed">` holding one lazy-loaded `<iframe>` in a fixed 16:9 box,
so the frame does not move the page when it arrives. YouTube is served from `youtube-nocookie.com`,
Vimeo with `dnt=1`, Google Maps from the embed endpoint; a `start` in the file becomes the time the
video begins at. The frame is named by the field's own `title`, which is translated, and by the
provider's name where this language has none yet. A field with no value draws nothing. Style
`.handover-embed` — the component sets nothing but the box.

## Hidden entries

An entry with `_status: hidden` in its file stays in the repo but must not render.
`filterLive` drops those entries from a `getCollection` result; `isLive(siteId, data)`
is the same check for one entry. Use them in loaders and in `getStaticPaths`, so a hidden
entry 404s instead of being reachable by URL.

This only works if `_status` survives the collection schema. Astro parses every entry through
it, and a plain `z.object` drops the keys it does not declare — so the schema in
`content.config.ts` has to keep the reserved ones
([Template convention](template-convention.md#contentconfigts)). Without that every helper here
reads `_status: undefined` and a hidden entry renders.

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
