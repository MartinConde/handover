# Field types

The form is generated from your Zod schema. These are the scalar types and how each one is
stored; pictures, files, groups, arrays and blocks are
[Structured fields](structured-fields.md).

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
[`<Markdown />`](rendering.md#rich-text).

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

Every scalar type has a widget: text is an input (a textarea once it holds line breaks or
more than 80 characters), number a numeric input, boolean a switch, date a native date
input, select radios for five options or fewer and a dropdown above that, link a Page /
Entry · URL toggle with label and "Open in new tab". Rich text is a TipTap editor whose
toolbar has exactly the tier's constructs; a value that already contains something outside
the tier (edited in code) is shown read-only rather than rewritten. Leaving an optional
field empty removes the key from the file.

A `z.date()` is edited as a date and a transform by its input type. A `z.custom()` gets a
widget when you name one: `.meta({ handover: 'text' })` (`number`, `boolean` or `date`
likewise). Any other schema (tuples, unions, untagged customs) shows as "Not editable here
yet", read and written back untouched.
