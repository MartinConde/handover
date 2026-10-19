# Rendering content

The components the package ships and the helpers a template calls to draw an entry it has
already loaded. Getting the entry there is [Loaders and pages](loaders.md); the block renderer
is [Blocks](blocks.md), the language switcher is
[a page of its own](language-switcher.md), and `<Nav />` lives with the menus it draws
([Rendering the menus](rendering-menus.md)).

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

## Pictures

The package ships no picture component: the template draws its own `<img>`. An image field's
value is the stored `src` key, `alt`, `width`, `height` and, when the client moved the dot,
`focal` — `[x, y]` as fractions of the picture. A centred dot is not written, so default it to
the middle. This is the demo's hero, which keeps the dot in frame as the crop changes:

```astro
---
import cms from '../../cms.config';

const { block, edit } = Astro.props;
const media = (key: string) => `${cms.media?.publicBase}/${key}`;
const focal = block.image?.focal ?? [0.5, 0.5];
---

<section class="hero-block" {...(edit ?? {})}>
  <h1 {...(edit?.field('heading') ?? {})}>{block.heading}</h1>
  {
    block.image && (
      <img
        {...(edit?.field('image') ?? {})}
        src={media(block.image.src)}
        alt={block.image.alt ?? ''}
        width={block.image.width}
        height={block.image.height}
        style={`object-position: ${focal[0] * 100}% ${focal[1] * 100}%`}
      />
    )
  }
</section>
```

`object-position` only moves anything under `object-fit: cover` in a box of another shape, so
style the image that way. To have Cloudflare cut the crop instead of the browser, pass the same
two numbers as `gravity` ([The focal point](media-library.md#the-focal-point)).

### With Astro's `<Picture>`

A site that already draws its pictures with `<Picture>` from `astro:assets` can keep it and
let the build make the sizes. Add the media domain to `image.domains` in `astro.config.mjs`,
and pass the remote URL with the stored width and height, since Astro cannot read either from
a URL:

```astro
---
import { Picture } from 'astro:assets';
import type { Image } from 'astro-handover';
import cms from '../../cms.config';

interface Props {
  image: Image;
  widths: number[];
  sizes?: string;
}

const { image, widths, sizes } = Astro.props;
// Astro stops a local picture's widths at its own width; a remote one is not capped.
let candidates = [...widths].sort((a, b) => a - b);
if (candidates.at(-1)! > image.width) {
  candidates = [...candidates.filter((w) => w <= image.width), image.width];
}
---

<Picture
  src={`${cms.media?.publicBase}/${image.src}`}
  width={image.width}
  height={image.height}
  alt={image.alt ?? ''}
  formats={['avif', 'webp']}
  widths={candidates}
  sizes={sizes}
  fallbackFormat={image.src.endsWith('.png') ? 'png' : 'jpg'}
/>
```

Two things differ from a picture in `src/assets/`:

- **No width cap.** Astro drops the widths larger than a local picture, but not those of a
  remote one: it upscales them. The component above caps them the way Astro caps a local one.
- **A PNG fallback.** Without `fallbackFormat`, the `<img>` inside a remote `<picture>` is a
  PNG, often several times the size of the JPEG it was made from.

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
