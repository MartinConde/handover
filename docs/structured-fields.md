# Structured fields

The types that store a shape rather than a value: pictures and files, embeds, SEO, a
reference to another entry, and the three that nest — group, array and blocks. The scalars
are [Field types](field-types.md).

## Media, embeds, SEO and references

`image`, `file`, `embed`, `seo` and `reference` are exported from `astro-handover`.

| Field | Schema | Stored as |
|---|---|---|
| image | `image(preset?)` | `{ src, alt?, width, height, focal? }` — `src` is a `media/…` key, never a URL |
| file | `file({ accept? })` | `{ src, name?, bytes, mime }` — `src` is a `files/…` key |
| embed | `embed` | `{ provider, id, title?, start? }` — `provider` is `youtube`, `vimeo` or `google-maps`; never HTML |
| seo | `seo` | `{ title?, description?, image?, noindex?, canonical? }` |
| site defaults | `seoDefaults` | `{ titlePattern?, description?, image?, twitter? }` — in a global, under `defaultSeo` |
| reference | `reference('agents')` | `"agents/jane-doe"` — `collection/slug` of the referenced entry |

```ts
import { embed, file, image, reference, seo } from 'astro-handover';

export const listing = z.object({
  hero: image({ ratio: '16:9', max: 2400, min: 1600 }),
  brochure: file().optional(),
  video: embed.optional(),
  seo: seo.optional(),
  agent: reference('agents'),
});
```

```yaml
hero:
  src: "media/9f3a2c7e.webp"
  alt: "Front of the house"
  width: 2400
  height: 1600
  focal:
    - 0.5
    - 0.35
brochure:
  src: "files/3e8a1b9c.pdf"
  name: "Seaview Cottage brochure.pdf"
  bytes: 2481033
  mime: "application/pdf"
video:
  provider: "youtube"
  id: "dQw4w9WgXcQ"
  title: "Walkthrough video"
  start: 42
agent: "agents/jane-doe"
```

Media keys are resolved against [`media.publicBase`](configuration.md#media) at render, so
moving the CDN never touches a content file. How bytes get to the bucket in the first
place and what has to be set up for it is [Media](media.md); what a field asks of a picture is
[Pictures and files in a field](media-fields.md).
An embed is rebuilt from `provider` + `id` by the shipped component; an `id` containing `<`
or `>` fails validation, as does any extra key.

An image's `alt` and a file's `name` are the halves a translation owns, so both are optional:
the language a picture was chosen in has them and the others do not until somebody types one,
which must never hold up a publish. Everything else in the two shapes is the same in every
language.

## Nesting: group, array, blocks

| Field | Schema | Stored as |
|---|---|---|
| group | `z.object({ … })` | a nested map; its fields appear in the form under the group's name |
| array | `z.array(z.object({ _id: z.string(), … }))` or `z.array(z.string())` | a list; give each object item an `_id` so it can be addressed across locales |
| blocks | `blocks(() => registry)` | a list of blocks, each `{ _type, _id, _label?, … }` matching its entry in the registry |

An array may hold groups or scalars, never another array — wrap the inner list in a
group (`columns: [{ _id, blocks: [...] }]`). Saving an array of arrays fails.

Blocks are declared once each with `defineBlock(type, fields)` and collected in a
registry. The registry is passed as a function so a block can contain `blocks` again:

```ts
import { type Block, type BlockRegistry, blocks, defineBlock, image, link } from 'astro-handover';
import { z } from 'astro/zod';

export const registry: BlockRegistry = {
  hero: defineBlock('hero', { heading: z.string(), image: image({ ratio: '16:9' }).optional() }),
  textSection: defineBlock('textSection', { body: z.string() }),
  cta: defineBlock('cta', { heading: z.string(), button: link }),
  columns: defineBlock('columns', {
    columns: z.array(z.object({ _id: z.string(), blocks: blocks(() => registry) })),
  }),
};

export const page = z.object({ title: z.string(), blocks: blocks(() => registry) });
```

The `BlockRegistry` annotation is what lets TypeScript accept the recursion; `Block` is
the type of one stored block if you need it in a template.

```yaml
blocks:
  - _type: "hero"
    _id: "k3nf9a2p"
    heading: "Move to the coast"
  - _type: "columns"
    _id: "a1b2c3d4"
    _label: "Two columns"
    columns:
      - _id: "e5f6g7h8"
        blocks:
          - _type: "textSection"
            _id: "i9j0k1l2"
            body: "First paragraph."
      - _id: "m3n4o5p6"
        blocks:
          - _type: "cta"
            _id: "q7r8s9t0"
            _ref: "globals/cta-newsletter"
```

A block whose `_type` is not in the registry fails validation. A block with `_ref` (a
`globals/<key>` path) needs no fields of its own: `<Blocks />` fills it from that global, in
the language the page is in ([Blocks](blocks.md)). Its `_type` still decides which component
draws it. The admin shows such a block read-only — the content is edited once under Site
settings — and the `_ref` itself is written by hand, in the starter content.

## In the admin

`group` is a collapsible fieldset. An `array` is a list of rows with Add, Remove and move
up / down buttons — the first row's up and the last row's down are disabled. Every row
keeps its `_id` across moves; a new row gets a fresh one. A `blocks` field is the same list
of cards, each headed by its `_label` or `_type`, and Add block offers one button per type
in your registry. Reordering never rewrites an `_id`, so translations and `_machine` paths
keep pointing at the same block.

`image` and `file` are a card: the picture at the field's own ratio, or the file's type and
size, with the translatable half beside it and Replace and Remove under it. An empty one is a
drop zone that takes a file dropped on it and opens the
[picker](media-fields.md#choosing-a-picture) otherwise. A language that is being translated gets the alt or the display name and nothing
else — the picture itself is the same in every language.

`reference` is a search box over the collection its schema names, one row per entry with
the languages that entry has a file in. Choosing one stores `collection/slug`; the chosen
row shows the entry's title beside the path it stores, and Change reopens the search. A
language that is being translated is not shown the field at all — an entry points at the
same entry in every language.

`embed` is one box: paste a YouTube, Vimeo or Google Maps link and it becomes a card with
the provider's name, the id that was stored and — for YouTube — the provider's own still.
Under it are the `title` the frame is named by and the second the video starts at. **Change**
puts the box back with the card still under it, so a link that is not recognised leaves the
video you had; a link from anywhere else is refused with the list of what is accepted, and
nothing is stored until one parses. YouTube's `watch`, `youtu.be`, `shorts`, `embed` and `live`
links all parse. Three Google Maps links are refused with a sentence saying what to do instead: a
shortened `maps.app.goo.gl` one, Google's own embed code, and a map dragged to somewhere
(`/maps/@lat,lng`) — a view with no place on it. A language that is being translated gets the title and
nothing else — the video is the same in every language. What the page does with the value is
[`<Embed />`](rendering.md#videos-and-maps).

`seo` is a tab of its own rather than a row in the form, and what it draws is described in
[Search and sharing](seo.md#in-the-admin) along with the `<Seo />` that renders it.

Make a structured field **required** and a new entry cannot be published until it is filled in.
Nothing typed is lost: the draft is stored anyway and the field is marked as a problem. Keep a
field required only when your site really cannot render without it
([Drafts and publishing](publishing.md#fields-the-schema-is-not-happy-with)).
