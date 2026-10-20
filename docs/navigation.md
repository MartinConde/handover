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
named by the collection's [`label`](configuration.md#collections) in that language —
`{ en: 'homes', de: 'Häuser' }` gives *Homes* and *Häuser*, a plain string counts as English — or
by its key where the label has no entry for the language, until a label is typed. Every menu and item has an `_id`, the same
in every locale. A `label` left empty is not a mistake: the item is then named by the page it
points at, so renaming that page moves the menu with it — in each language by that language's
title.

An item with no `link` is a label that only opens the items under it, such as a *Company*
heading over *About* and *Team*. There is no page to name it, so a language where it has no
`label`, or nothing left under it, drops it.

An `index` item with `entries: true` lists the collection's live entries under it, in each
language, before any items added by hand. A *Services* item then always shows every service.
Each listed item carries its `entry` (`{ id, data }`), so a flyout can draw teasers from the
entry's fields. They come sorted by file name, the order the menu editor shows them in; sort them in the
site if another order matters. The client sets it with **List its pages under it** in the item editor. The menu editor then
shows those entries under the item as plain rows, marked as added automatically; they cannot be
moved or removed there. An entry that has never been published is left out until it is, as on the site.
The `index` entry of a collection that has an index page is left out: the item itself is that page.
`entries: true` on an item whose link is not an index link is refused by the navigation schema
with *only an index link can list its entries*.

**The tree is shared, the labels are not.** Which items a menu has, in which order, what each
points at and where it opens is the same in every language's file; `label` is the one key a
language owns ([Languages](i18n.md#the-structure-is-shared)). Moving an item in one language
moves it in all of them, and the German file keeps its German words while it happens.

### Variants

Where the site draws some items differently, such as one flyout as a wide panel, declare the
choices with `defineNavigation` instead of `navigation`. The client picks one per item under
**Style** in the item editor, and `menusAt()` hands it to the site as `variant`:

```ts
// cms.config.ts
import { defineConfig, defineNavigation } from 'astro-handover';

const navigation = defineNavigation({
  variants: { mega: { en: 'Wide flyout', de: 'Breites Menü' } },
});
export default defineConfig({ globals: { navigation } /* … */ });
```

```yaml
      - _id: "un3r8t4b"
        label: "Company"
        variant: "mega"
```

An item without `variant` is drawn the standard way. A `variant` the site has not declared fails
the build. The variant is part of the shared tree, so every language has the same one.

## In the admin

The client edits this file in **Site settings → Navigation**. A persistent **Add to menu**
library sits beside the menu structure, with searchable pages, entries, collection index pages
and a custom-link form. Pages are grouped in one closed section per collection; a search opens
every section it matches. Each page is one line with an add button; a ✓ marks pages already in
the menu, including nested items, and a tag names a page that is hidden or exists in only some
languages (*DE only*). The library keeps the current search after an addition. On narrow
screens the library stacks above the tree, with a shortcut to the menu structure.
**Add a label without a link** adds a heading for sub-items; **Remove link** in an item's
editor turns an item into one.

The navigation builder follows the account's **Interface language**. Switching between English
and German translates its controls, counts, warnings, dialogs and retained directory feedback in
place. It does not reread the page directory or replace the builder: menu order, an active drag,
the open item editor, focus and an unfinished label stay where they are. Menu keys, page titles,
labels, URLs and other site-authored values remain exactly as written.

Rows are one line each: the label, what it points at and its address. Clicking a row opens its
editor underneath: label and link side by side, then **Open in a new tab** and a **Shown in**
choice (all languages, or one language only). **Done** closes the editor;
**Cancel** restores the row to how it was when opened. Rows move by dragging the handle — a hairline marks a slot between
siblings, a tinted well names the parent a drop would go inside, and a slot past three levels
refuses in place — or from the row's ⋯ (up, down, make a sub-item, move out a level, remove).
The second language's column draws the same tree as one box a row, for the labels alone. A
row pointing at something this language cannot show carries a chip there — *Hidden*, *Not in
EN*, *Page missing* — and is dropped by [`<Nav />`](rendering-menus.md). Which menus a site has is the
developer's: they are declared in this file, and the client fills them.

### Working across languages

Build and arrange the menu in its source language (usually English). Switch to another
language to edit its labels, or use **Side by side** for reference. Leaving a label empty
uses the linked page's own title in that language. Page and collection links resolve the
localized destination automatically; a custom URL uses the exact same address everywhere.

**Shown in** is an optional setting inside the item editor. Keep **All languages**
for normal navigation; choose a single language for exceptions such as a German-only legal
link. It controls where the item and its sub-items belong, not whether a page is translated.
Missing or hidden pages are still omitted in that language. Label placeholders and hidden-page
warnings use the selected language's title and status.
