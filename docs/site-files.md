# Site files

Besides collections, `src/content/` holds a few files with a fixed place and shape:
globals, the navigation menus, redirects and entry templates. All of them are written in
the [content format](content-format.md).

## Globals

Site-wide singletons — name, logo, contact details, footer text, default SEO — live one
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

A block with `_ref: "globals/<key>"` takes its content from that global at build time
([field types](field-types.md)).

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
in every locale; only `label` is translated.

## Redirects

`src/content/redirects.yaml` is a flat list of rules. Handover appends to it when an entry
is renamed or deleted ([content format](content-format.md#renaming-and-deleting-an-entry));
you can add rules by hand.

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

`from` is a path starting with `/`; `to` is a path or an absolute URL; `status` is `301`;
`reason` is one of `slug-change`, `hidden`, `deleted`, `manual`. Exact matches only — no
wildcards.

At build time the integration writes every rule as a line of `_redirects` in the output
directory (`/brochure https://example.com/files/brochure.pdf 301`), which Cloudflare
serves without any Worker code. A rule that fails validation fails the build, naming it:
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
