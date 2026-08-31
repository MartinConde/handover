# Rendering content

The components the package ships and the helpers a template calls to draw an entry it has
already loaded. Getting the entry there is [Loaders and pages](loaders.md); the block renderer
is [Blocks](blocks.md), the language switcher is
[a page of its own](language-switcher.md), and `<Nav />` lives with the menus it draws
([Navigation menus](navigation.md#rendering-the-menus)).

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

## Search and sharing

`<Seo />` writes the title, description, `og:*`, `twitter:card`, canonical and `hreflang`
alternates for a page, from the entry's own `seo` field over the site's defaults. It has a
page of its own: [Search and sharing](seo.md).

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
