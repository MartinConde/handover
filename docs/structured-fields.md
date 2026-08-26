# Structured fields

The types that store a shape rather than a value: pictures and files, embeds, SEO, a
reference to another entry, and the three that nest — group, array and blocks. The scalars
are [Field types](field-types.md).

## Media, embeds, SEO and references

`image`, `file`, `embed`, `seo` and `reference` are exported from `astro-handover`. Their
picker UI comes later; the stored shape is fixed now.

| Field | Schema | Stored as |
|---|---|---|
| image | `image` | `{ src, alt?, width, height, focal? }` — `src` is a `media/…` key, never a URL |
| file | `file` | `{ src, name, bytes, mime }` — `src` is a `files/…` key |
| embed | `embed` | `{ provider, id, title?, start? }` — `provider` is `youtube`, `vimeo` or `google-maps`; never HTML |
| seo | `seo` | `{ title?, description?, image?, noindex?, canonical? }` |
| reference | `reference('agents')` | `"agents/jane-doe"` — `collection/slug` of the referenced entry |

```ts
import { embed, file, image, reference, seo } from 'astro-handover';

export const listing = z.object({
  hero: image,
  brochure: file.optional(),
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
place, and what has to be set up for them to, is [Media](media.md). An embed is rebuilt from `provider` + `id` by the shipped
component; an `id` containing `<` or `>` fails validation, as does any extra key.

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
  hero: defineBlock('hero', { heading: z.string(), image: image.optional() }),
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
`globals/<key>` path) needs no fields of its own: its content is filled from that global
at build time. The admin shows such a block read-only; write the `_ref` itself by hand.

## In the admin

`group` is a collapsible fieldset. An `array` is a list of rows with Add, Remove and move
up / down buttons — the first row's up and the last row's down are disabled. Every row
keeps its `_id` across moves; a new row gets a fresh one. A `blocks` field is the same list
of cards, each headed by its `_label` or `_type`, and Add block offers one button per type
in your registry. Reordering never rewrites an `_id`, so translations and `_machine` paths
keep pointing at the same block.

`image`, `file`, `embed`, `seo` and `reference` show their stored value as read-only JSON
until their pickers arrive, under one line naming the release that brings the editor. It is
read and written back untouched.

Make one of those **required** — `agent: reference('agents')` above — and a new entry
cannot satisfy it from the form until that picker ships. Nothing you type is lost: the
draft is stored anyway and the field is marked as a problem. What you cannot do is publish
that entry, so keep a field required only when your site really cannot render without it,
and use `.optional()` while the editor for it is still to come
([Drafts and publishing](publishing.md#fields-the-schema-is-not-happy-with)).
