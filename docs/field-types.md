# Field types

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

Any other schema (arrays, objects, custom types) is read and written as-is but shows as
"Not editable here yet" in the admin.
