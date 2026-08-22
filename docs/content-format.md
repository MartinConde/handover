# Content format

Every entry is one YAML file per locale at `src/content/<collection>/<locale>/<slug>.yaml`.
Handover writes these files; your Astro build reads them through the schema in
`src/content/schemas.ts`. The file is the source of truth — nothing the site renders
lives only in a database.

## What a file looks like

```yaml
_version: 1
title: "Home"
seo:
  title: "Move to the coast"
  description: "Coastal homes in Devon."
blocks:
  - _type: "cta"
    _id: "k3nf9a2p"
    _label: "Newsletter signup"
    heading: "Ready to move?"
    body: |-
      Book a viewing this week and we'll
      cover your travel.
    button:
      label: "Contact us"
      href: "/contact"
```

Handover always writes the same shape, so a one-field edit is a one-line diff:

- strings are double-quoted; text with line breaks is a `|-` block
- keys starting with `_` come first, then your fields in schema order
- empty and `null` values are left out
- two-space indent, no line folding
- an array directly inside an array is not allowed — wrap the inner one in an object
  (`columns: [{ _id, blocks: [...] }]`)

You can hand-edit a file in any valid YAML; Handover rewrites it in this shape on the
next save.

## Field types

The form is generated from your Zod schema. These are the scalar types and how each one
is stored:

| Field | Schema | Stored as |
|---|---|---|
| text | `z.string()` | `"quoted"`, or a `\|-` block when it has line breaks |
| number | `z.number()`, `z.number().int()` | plain number: `82.5`, `3` |
| boolean | `z.boolean()` | `true` / `false` |
| date | `z.iso.date()` | `"2026-09-01"` — always a quoted string, never a YAML timestamp |
| select | `z.enum([...])` | the chosen value, quoted: `"sale"` |
| link | `link` from `astro-handover` | `{ type, href \| ref, label?, newTab? }`, see below |

```ts
import { link } from 'astro-handover';
import { z } from 'astro/zod';

export const listing = z.object({
  title: z.string(),
  bedrooms: z.number().int(),
  featured: z.boolean(),
  availableFrom: z.iso.date(),
  status: z.enum(['sale', 'rent']),
  button: link.optional(),
});
```

A link is one of three kinds: `url` with an `href`, or `entry` / `page` with a `ref` such
as `listings/mill-house` (the entry's filename id, resolved to a URL at build time).
`label` and `newTab` are optional on all three.

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

Any other schema (arrays, objects, custom types) is read and written as-is but shows as
"Not editable here yet" in the admin.

## Reserved keys

Keys starting with `_` belong to Handover. Name your own fields anything else — `type`,
`status`, `id` are all free.

| Key | Where | Value |
|---|---|---|
| `_version` | top of file | The format version, currently `1`. `handover migrate` reads it. |
| `_status` | top of file | `hidden` to keep the entry off the site. Absent means live. |
| `_machine` | top of file | Field paths whose current value was written by a translation or AI assist, e.g. `blocks[_id=k3nf9a2p].heading`. Cleared per path when a person edits the field. |
| `_i18n` | top of file | Which locale and which version of it a translation was made from. Only in translated files. |
| `_type` | block | The block type, matching a registered block. |
| `_id` | block, array item | Eight characters from `0-9a-z`, unique in the file, the same across locales. |
| `_label` | block | An editor-given name, shown in the block list instead of the type. |
| `_ref` | block | A path such as `globals/cta-newsletter` whose content fills the block at build time. |
| `_locales` | block, array item | The locales this item exists in, e.g. `["de"]`. Absent means all. Never empty. |

Reading a file checks these: a `_status` other than `hidden`, a malformed `_id`, an empty
`_locales` or a top-level key on a block fails with an error naming the path, such as
`blocks[0]._id: expected eight characters from 0-9a-z, got "ABCDEFGH"`.

## Block ids

Every block and array item carries an `_id`. Drafts, translations and `_machine` paths
address items by id, never by position, so reordering changes nothing but the order.
The same item has the same `_id` in every locale file; that is what lets the admin show
two languages side by side.

Duplicating an entry gives every item a new `_id`, the same new id in every locale of the
copy. Write a template or a fixture with ids of your own, or leave them out — the admin
fills them in on first save.

## Hiding an entry

```yaml
_version: 1
_status: "hidden"
title: "Seaview Cottage"
```

The file stays in the repo and in the admin, and the site ignores it when your loaders
use `filterLive` (see [Template convention](template-convention.md#hidden-entries)).
