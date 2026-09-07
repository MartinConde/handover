# Navigation menus

Several menus — header, footer, legal — in one shared file,
`src/content/globals/<locale>/navigation.yaml`. Declaring it is a global like any other
([Site files](site-files.md#globals)); this page is the file's shape and the screen that
edits it.

## The file

`navigation` from `astro-handover` is the schema for `src/content/globals/<locale>/navigation.yaml`:
several menus in one file, each a tree of items. An item is a label and a link; `children`
nests items. The link points at an entry or page by its filename id, at a collection's index
page by the collection's name, or at a URL — never at a locale-prefixed path.

```yaml
_version: 1
menus:
  - _id: "7h2kq9sd"
    key: "header"
    items:
      - _id: "a1b2c3d4"
        label: "Listings"
        link:
          type: "index"
          collection: "listings"
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

`newTab` sits on the item, not inside `link`. An `index` item links each language's own
index page — `/listings` in English, `/de/listings` in German — where a `url` item sends every
language to the one address it holds; it needs the collection to declare an `index`, and is
named by the collection until a label is typed. Every menu and item has an `_id`, the same
in every locale. A `label` left empty is not a mistake: the item is then named by the page it
points at, so renaming that page moves the menu with it — in each language by that language's
title.

**The tree is shared, the labels are not.** Which items a menu has, in which order, what each
points at and where it opens is the same in every language's file; `label` is the one key a
language owns ([Languages](i18n.md#the-structure-is-shared)). Moving an item in one language
moves it in all of them, and the German file keeps its German words while it happens.

## In the admin

The client edits this file in **Site settings → Navigation**. A persistent **Add to menu**
library sits beside the menu structure, with searchable pages, entries, collection index pages
and a custom-link form. Each page has an add button; **In menu** marks pages already used,
including nested items. The library keeps the current search after an addition. On narrow
screens the library stacks above the tree, with a shortcut to the menu structure.

Rows show a label, destination and an explicit **Edit** control. Clicking a row opens its
editor underneath: label, link, new tab and language visibility. **Done** closes the editor;
**Cancel** restores the row to how it was when opened. Rows move by dragging the handle — a hairline marks a slot between
siblings, a tinted well names the parent a drop would go inside, and a slot past three levels
refuses in place — or from the row's ⋯ (up, down, make a sub-item, move out a level, remove).
The second language's column draws the same tree as one box a row, for the labels alone. A
row pointing at something this language cannot show carries a chip there — *Hidden*, *Not in
EN*, *Page missing* — and is dropped by [`<Nav />`](#rendering-the-menus). Which menus a site has is the
developer's: they are declared in this file, and the client fills them.

### Working across languages

Build and arrange the menu in its source language (usually English). Switch to another
language to edit its labels, or use **Side by side** for reference. Leaving a label empty
uses the linked page's own title in that language. Page and collection links resolve the
localized destination automatically; a custom URL uses the exact same address everywhere.

**Language visibility** is an optional setting inside the item editor. Keep **All languages**
for normal navigation; choose a single language for exceptions such as a German-only legal
link. It controls where the item and its sub-items belong, not whether a page is translated.
Missing or hidden pages are still omitted in that language. Label placeholders and hidden-page
warnings use the selected language's title and status.

## Rendering the menus

`menusAt()` resolves the [file above](#the-file) for one language:
every menu by its key, every item's `ref` or `collection` turned into the address that language serves, and
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
