# Template convention

Handover reads and writes the same content files your Astro build renders, and
[previews](preview.md) unpublished edits through your own templates. That only works if every
page gets its data the same way. Three rules:

1. Schemas live in `src/content/schemas.ts` as plain Zod, imported by `content.config.ts`.
2. A layout takes its data as props and never fetches.
3. Each page type has one `load(source, ctx)` in `src/loaders/`, and `src/pages/*.astro`
   only calls it.

Rules 2 and 3 are [Loaders and pages](loaders.md); the two files below are the first rule.

## `schemas.ts`

```ts
// src/content/schemas.ts
import { z } from 'astro/zod';

export const listing = z.object({
  title: z.string(),
  location: z.string(),
  price: z.string(),
  summary: z.string(),
});

export type Listing = z.infer<typeof listing>;
```

## `content.config.ts`

Astro reads the same files, so every collection needs a `glob` loader whose `base` is that
collection's folder and whose schema is the one from `schemas.ts`. A `base` that does not match
the folder is not an error — the collection is simply empty, and its pages render nothing.

```ts
// src/content.config.ts
import { glob } from 'astro/loaders';
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { listing, page } from './content/schemas';

// The id is the file's path and nothing else; Astro's default would file an entry under the
// `slug` in its data, which is where localizedSlugs keeps an address.
const byPath = ({ entry }: { entry: string }) => entry.replace(/\.ya?ml$/, '');

// A z.object drops every key it does not declare, and the reserved ones are declared nowhere.
const withReserved = <T extends z.ZodObject>(schema: T) =>
  schema.extend({
    _status: z.literal('hidden').optional(),
    _locales: z.array(z.string()).optional(),
  });

export const collections = {
  listings: defineCollection({
    loader: glob({ pattern: '**/*.yaml', base: './src/content/listings', generateId: byPath }),
    schema: withReserved(listing),
  }),
  pages: defineCollection({
    loader: glob({ pattern: '**/*.yaml', base: './src/content/pages', generateId: byPath }),
    schema: withReserved(page),
  }),
};
```

**The schema Astro is given has to keep the reserved keys**, which is what `withReserved` above
is for. Astro parses every entry through it and a plain `z.object` throws away what it does not
declare, so `_status` and `_locales` never reach the built data — and `filterLive` reads
`undefined` and renders a hidden entry ([Rendering content](rendering.md#hidden-entries)). Your
own `schemas.ts` stays free of them: they are the file's keys, not fields anybody edits. A
collection declared `z.looseObject({})` keeps them already and needs nothing.

The collection key is the folder name and the key in `cms.config.ts`; the locale folder inside
it becomes the first segment of the entry id, which is why `getEntry` takes `locale/slug`.
**`generateId` is not optional on a collection with
[`localizedSlugs`](configuration.md#localizedslugs)** — without it those entries are filed under
their addresses, every lookup misses, and reading the collection throws saying so.

### Quote dates in a file you write by hand

`published: 2026-07-14` is a YAML timestamp: Astro's loader reads it as a `Date` and your
`z.iso.date()` fails with `Expected type "string", received "object"`. Write
`published: "2026-07-14"`, and the same for anything that looks like a time.

The build refuses an unquoted date before Astro's loader sees it, naming the file and the key,
and `handover migrate --dry-run` reports them without writing. Files the CMS writes are always
quoted, so this only bites on a file you or a script created.
