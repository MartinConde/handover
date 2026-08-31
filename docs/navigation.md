# Navigation menus

Several menus — header, footer, legal — in one shared file,
`src/content/globals/<locale>/navigation.yaml`. Declaring it is a global like any other
([Site files](site-files.md#globals)); this page is the file's shape and the screen that
edits it.

## The file

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

## In the admin

The client edits this file in **Site settings → Navigation**: pages and entries on the left,
the tree on the right. Rows move by dragging the handle — a hairline marks a slot between
siblings, a tinted well names the parent a drop would go inside, and a slot past three levels
refuses in place — or with each row's buttons (up, down, indent, outdent). The second language's column draws the same tree as one box a row,
for the labels alone. A row pointing at something this language cannot show is flagged
there and dropped by [`<Nav />`](#rendering-the-menus). Which menus a site has is the
developer's: they are declared in this file, and the client fills them.

## Rendering the menus

`menusAt()` resolves the [file above](#the-file) for one language:
every menu by its key, every item's `ref` turned into the address that language serves, and
everything that language cannot show **dropped** — an entry with no file in it, a hidden one,
and an item whose `_locales` names another language. A dropped item takes its children with it,
so a menu never becomes the way a reader finds a 404. Resolve it in the loader, like everything
else a page needs:

```ts
// src/loaders/globals.ts — the global is read, then resolved
const globals = await globalsAt('default', source, locale);
const menus = await menusAt('default', source, cms, globals.navigation, locale);
```

```astro
---
import Nav from 'astro-handover/Nav.astro';
const { menus } = Astro.props;
---

<Nav menu="header" menus={menus} current={Astro.url.pathname} />
```

`<Nav />` draws a `<nav aria-label="Main">` with nested `<ul>`s — one `<a>` per item,
`aria-current="page"` on the one the reader is on (a trailing slash is the same page), every
`href` written the way `current` is — with the slash or without, so no link is a hop through a
redirect — and
`target="_blank" rel="noopener noreferrer"` where the item asks for a new tab. A menu with
nothing left in this language draws **nothing**. `label` names the landmark where a page has
two menus. The words come from the file of the language being rendered — the tree is shared and
the labels are each language's own — so an item nobody has translated is named by the page it
points at, in that language. Style it, or read `menus.header` — `{ label, href, newTab?, children }`, an item with
no `label` of its own already named by the page it points at — and write your own markup.
