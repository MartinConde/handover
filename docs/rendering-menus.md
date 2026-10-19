# Rendering the menus

`menusAt()` resolves the [menu file](navigation.md#the-file) for one language:
every menu by its key, every item's `ref` or `collection` turned into the address that language serves, and
everything that language cannot show **dropped** — an entry with no file in it, a hidden one,
and an item whose `_locales` names another language. A dropped item takes its children with it,
so a menu never becomes the way a reader finds a 404. Resolve it in the loader, like everything
else a page needs:

```ts
// src/loaders/globals.ts — the global is read, then resolved
const globals = await globalsAt('default', source, locale, { required: ['navigation'] });
const menus = await menusAt('default', source, cms, globals.navigation, locale);
```

```astro
---
import Nav from 'astro-handover/Nav.astro';
const { menus } = Astro.props;
---

<Nav menu="header" menus={menus} current={Astro.url.pathname} />
```

`<Nav />` draws a `<nav aria-label="Main">` with nested `<ul>`s — one `<a>` per item (a `<span>` for a label without a link),
`aria-current="page"` on the one the reader is on (a trailing slash is the same page), every
`href` written the way `current` is — with the slash or without, so no link is a hop through a
redirect — and
`target="_blank" rel="noopener noreferrer"` where the item asks for a new tab. A menu with
nothing left in this language draws **nothing**. `label` names the landmark where a page has
two menus. The words come from the file of the language being rendered — the tree is shared and
the labels are each language's own — so an item nobody has translated is named by the page it
points at, in that language. Style it, or read `menus.header` — `{ label, href?, newTab?, variant?, entry?, children }`, an item with
no `label` of its own already named by the page it points at — and write your own markup.
