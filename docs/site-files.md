# Site files

Besides collections, `src/content/` holds a few files with a fixed place and shape:
globals, the navigation menus, redirects and entry templates. All of them are written in
the [content format](content-format.md).

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

## Navigation

`navigation` from `astro-handover` is the schema for `src/content/globals/<locale>/navigation.yaml`:
several menus in one file, each a tree of items. An item is a label and a link; `children`
nests items. The link points at an entry or page by its filename id, or at a URL — never
at a locale-prefixed path.

```yaml
_version: 1
menus:
  - _id: "7h2kq9sd"
    key: "header"
    items:
      - _id: "a1b2c3d4"
        label: "Listings"
        link:
          type: "entry"
          ref: "listings/seaview-cottage"
        children:
          - _id: "e5f6g7h8"
            label: "For sale"
            link:
              type: "url"
              href: "/listings?status=sale"
            newTab: false
      - _id: "i9j0k1l2"
        _locales:
          - "de"
        label: "Impressum"
        link:
          type: "page"
          ref: "pages/impressum"
```

`newTab` sits on the item, not inside `link`. Every menu and item has an `_id`, the same
in every locale. A `label` left empty is not a mistake: the item is then named by the page it
points at, so renaming that page moves the menu with it — in each language by that language's
title.

**The tree is shared, the labels are not.** Which items a menu has, in which order, what each
points at and where it opens is the same in every language's file; `label` is the one key a
language owns ([Languages](i18n.md#the-structure-is-shared)). Moving an item in one language
moves it in all of them, and the German file keeps its German words while it happens.

The client edits this file in **Site settings → Navigation**: pages and entries on the left,
the tree on the right, dragged by the handle or moved with each row's buttons (up, down, indent,
outdent), three levels deep. The second language's column draws the same tree as one box a row,
for the labels alone. A row pointing at something this language cannot show is flagged
there and dropped by [`<Nav />`](rendering.md#navigation-menus). Which menus a site has is the
developer's: they are declared in this file, and the client fills them.

## Redirects

`src/content/redirects.yaml` is a flat list of rules. Handover appends to it when an entry
is renamed or deleted ([entry lifecycle](entry-lifecycle.md#renaming-and-deleting-an-entry));
the client adds their own under **Site settings → Redirects**, and you can edit the file by hand.

```yaml
_version: 1
rules:
  - _id: "q8r9s0t1"
    from: "/brochure"
    to: "https://example.com/files/brochure.pdf"
    status: 301
    reason: "manual"
    createdAt: "2026-08-21T08:00:00Z"
```

`from` is a path starting with `/`; `to` is a path or an absolute URL; `status` is `301` or
`302`; `reason` is one of `slug-change`, `hidden`, `deleted`, `manual`. Exact matches only — no
wildcards.

The admin's table refuses a `from` that is a page the site already serves — that redirect would
take the page off the site — and a second rule from an address that already has one. A rule
pointing at an address a new rule claims is re-pointed at its destination, so a visitor never
hops twice. A rule the client adds is **committed as it is added** rather than waiting in the
publish drawer: this file is assembled at publish out of the rules of the selected entries, so a
rule belonging to no entry has nowhere to wait. It reaches visitors after the build.

A rule with `reason: hidden` belongs to the entry that is hidden — showing that entry again
removes the rule in the same commit — so the table draws it but neither edits nor deletes it.

At build time the integration writes every rule into `_redirects` in the output directory,
which Cloudflare serves without any Worker code. Each `from` is written twice — with the trailing
slash and without, since a visitor arrives with whichever form the page had when they bookmarked
it — and `to` the way your pages answer (`trailingSlash` and `build.format`), so they land in one
hop:

```
/brochure https://example.com/files/brochure.pdf 301
/brochure/ https://example.com/files/brochure.pdf 301
```

A rule that fails validation fails the build, naming it:
`src/content/redirects.yaml › rules[0].from: a path starting with "/"`. Redirects from
`astro.config` still work; the adapter adds them to the same file.

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
added to the repository appears in the dialog after the next deploy.
