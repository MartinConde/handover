# Site files

Besides collections, `src/content/` holds a few files with a fixed place and shape, all
written in the [content format](content-format.md): globals and entry templates on this
page, and two with pages of their own — [Navigation menus](navigation.md) and
[Redirects](redirects.md).

## Globals

Site-wide singletons — name, logo, contact details, footer text, default SEO
([Search and sharing](seo.md#site-defaults)) — live one
file per locale under `src/content/globals/<locale>/<key>.yaml`. Each key is declared
with its schema in `cms.config.ts`; the key is the file name (lowercase letters, digits
and dashes):

```ts
// cms.config.ts
import { defineConfig, navigation } from 'astro-handover';
import { site } from './src/content/schemas';

export default defineConfig({
  collections: { /* … */ },
  globals: { site, navigation },
});
```

They are also an ordinary collection in `src/content.config.ts`, so the build can read them.
One schema for the folder — each file is held to its own by the admin and by the publish:

```ts
globals: defineCollection({
  loader: glob({ pattern: '**/*.yaml', base: './src/content/globals', generateId: byPath }),
  schema: z.looseObject({}),
}),
```

```yaml
# src/content/globals/en/site.yaml
_version: 1
name: "Coastal Homes"
logo:
  src: "media/2b7c9e1a.svg"
  alt: "Coastal Homes"
  width: 320
  height: 80
contact:
  phone: "+44 1548 000000"
  email: "hello@example.com"
footerText: "Coastal homes in Devon since 2009."
```

A block with `_ref: "globals/<key>"` takes its content from that global, in the language the
page is in ([Blocks](blocks.md)).

Write the default language's file yourself — the build stops on a global that is declared and
never written, since the admin edits files rather than creating them. The other languages are
the editor's *Create from English*, like any entry's.

In the admin they are **Site settings**, above the collections: one card per global, and a
form that is the entry editor without the parts that do not apply — a global cannot be hidden,
renamed, duplicated or deleted. Everything else is the same screen, locks, unpublished changes
and one-commit publish included. Not to be confused with the read-only **Settings** screen,
which is this config as the Worker sees it.

## Templates

A starter for new entries is a content file under `src/content/_templates/<collection>/<name>.yaml`
with no `_id`s — they are generated when an entry is created from it:

```yaml
# src/content/_templates/pages/landing.yaml
_version: 1
title: "New page"
blocks:
  - _type: "hero"
    heading: "Move to the coast"
```

The folder is never part of a collection: each collection's loader reads its own folder
(`base: './src/content/listings'`), so `_templates/` is outside every glob.

**New entry** offers Blank and one choice per starter the collection ships, named after the
file (`house.yaml` → *House*). The values are copied into the new draft, every block and array
row is given an `_id`, and the title typed into the dialog wins over the one the starter
carries — so a starter needs no ids and no `_status`, `_locales` or `slug` of its own; those
belong to the entry. They are read at build time with the rest of `src/content/`, so a starter
added to the repository by hand appears in the dialog after the next deploy.

**Save as template** on an entry list row — owners only, since a template shapes every entry
made after it — writes one from the entry as it is published, in the language it was written
in, less its `_id`s, address, languages and status. It asks for a name, which goes through the
same derivation as a new entry's filename and never takes one the collection already has, and
commits the file at once. The dialog offers it straight away, without waiting for the deploy;
one saved and then deleted from the repository by hand is still offered until then, and
creating from it fails.
