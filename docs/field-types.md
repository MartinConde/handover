# Field types

The form is generated from your Zod schema. These are the scalar types and how each one
is stored:

| Field | Schema | Stored as |
|---|---|---|
| text | `z.string()` | `"quoted"`, or a `\|-` block when it has line breaks |
| richtext | `richtext()`, `richtext('full')` | Markdown in a `\|-` block, see below |
| number | `z.number()`, `z.number().int()` | plain number: `82.5`, `3` |
| boolean | `z.boolean()` | `true` / `false` |
| date | `z.iso.date()` | `"2026-09-01"` — always a quoted string, never a YAML timestamp |
| select | `z.enum([...])` | the chosen value, quoted: `"sale"` |
| link | `link` from `astro-handover` | `{ type, href \| ref, label?, newTab? }`, see below |

```ts
import { link, richtext } from 'astro-handover';
import { z } from 'astro/zod';

export const listing = z.object({
  title: z.string(),
  body: richtext('full'),
  bedrooms: z.number().int(),
  featured: z.boolean(),
  availableFrom: z.iso.date(),
  status: z.enum(['sale', 'rent']),
  button: link.optional(),
});
```

### Rich text

A `richtext()` field stores Markdown, never HTML. There are two tiers:

| Tier | Allows |
|---|---|
| `richtext()` | paragraphs, **bold**, *italic*, links, bullet and numbered lists |
| `richtext('full')` | the same plus `##` / `###` headings and `>` blockquotes |

Nothing else is accepted: no images, raw HTML, code, tables, `#` or `####` headings.
Validation fails naming the construct and its line (`table is not allowed (line 4)`),
so a paste that brings one in is caught before it is saved. Render the field with
[`<Markdown />`](template-convention.md#rich-text).

A link inside rich text may point at `http`, `https`, `mailto`, `tel` or a path on this
site. Anything else — `javascript:` and `data:` above all — fails validation
(`javascript: links are not allowed (line 2)`), and if a file written by hand carries one
anyway, `<Markdown />` renders the link's text without the link.

```yaml
body: |-
  ## The house

  Two **sunny** bedrooms, one *quiet* bathroom.

  - Sea view
  - Walled garden

  1. Book a [viewing](https://example.com/viewings)
  2. Make an offer

  > A rare find.
```

A link is one of three kinds: `url` with an `href`, or `entry` / `page` with a `ref` such
as `listings/mill-house` (the entry's filename id, resolved to a URL at build time).
`label` and `newTab` are optional on all three. An `href` takes the same schemes a rich
text link does: `http`, `https`, `mailto`, `tel` or a path on this site.

```yaml
button:
  type: "url"
  href: "https://example.com/viewings"
  label: "Book a viewing"
  newTab: true
more:
  type: "entry"
  ref: "listings/mill-house"
```

### Structured types

`image`, `file`, `embed`, `seo` and `reference` are exported from `astro-handover`. Their
upload and picker UI comes later; the stored shape is fixed now.

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

Media keys are resolved against your CDN base at render, so moving the CDN never
touches a content file. An embed is rebuilt from `provider` + `id` by the shipped
component; an `id` containing `<` or `>` fails validation, as does any extra key.

### Nesting: group, array, blocks

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

A `z.date()` is edited as a date and a transform by its input type. A `z.custom()` gets a
widget when you name one: `.meta({ handover: 'text' })` (`number`, `boolean` or `date`
likewise).

### Labels

A field is labelled by its key, humanised: `availableFrom` reads "Available from",
`seo_title` reads "Seo title". Name it yourself with `.meta({ label })` when the key does
not read well — on any field, including the helpers:

```ts
export const listing = z.object({
  availableFrom: z.iso.date(),                 // "Available from"
  seo: seo.meta({ label: 'SEO' }).optional(),  // "SEO"
});
```

### In the admin

Every scalar type, `group`, `array` and `blocks` has a widget: text is an input (a textarea
once it holds line breaks or more than 80 characters), number a numeric input, boolean a
switch, date a native date input, select radios for five options or fewer and a dropdown
above that, link a Page / Entry · URL toggle with label and "Open in new tab", group a
collapsible fieldset. Rich text is a TipTap editor whose toolbar has exactly the tier's
constructs; a value that already contains something outside the tier (edited in code) is
shown read-only rather than rewritten. Leaving an optional field empty removes the key from
the file.

An `array` is a list of rows with Add, Remove and move up / down buttons — the first row's
up and the last row's down are disabled. Every row keeps its `_id` across moves; a new row
gets a fresh one. A `blocks` field is the same list of cards, each headed by its `_label` or
`_type`, and Add block offers one button per type in your registry. Reordering never
rewrites an `_id`, so translations and `_machine` paths keep pointing at the same block.

`image`, `file`, `embed`, `seo` and `reference` show their stored value as read-only JSON
until their pickers arrive, under one line naming the release that brings the editor. Any
other schema (tuples, unions, untagged customs) shows as "Not editable here yet". Both are
read and written back untouched.

Make one of those **required** — `agent: reference('agents')` above — and a new entry
cannot satisfy it from the form until that picker ships. Nothing you type is lost: the
draft is stored anyway and the field is marked as a problem. What you cannot do is publish
that entry, so keep a field required only when your site really cannot render without it,
and use `.optional()` while the editor for it is still to come
([Drafts and publishing](publishing.md#fields-the-schema-is-not-happy-with)).
