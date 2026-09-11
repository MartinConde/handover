# Preview

The client sees the page before it goes out: the real site, rendered on the Worker from the
draft in D1, through the same `load()` and the same components the static build uses. It is
its own route — your content pages stay prerendered static assets whether preview is on or
off.

## Turning it on

Preview is off unless the **build** was told otherwise. The flag is read once, while the
integration sets up, and a site that was not told has no `/_preview` route at all — not a
route that refuses, no route in the bundle.

```jsonc
// package.json
"scripts": {
  "dev": "PREVIEW_ENABLED=1 astro dev",
  "build": "PREVIEW_ENABLED=1 astro build"
}
```

It is a build-time environment variable, not a `wrangler` var and not a secret: setting it on
the deployed Worker does nothing, because the route it decides was already left out of the
bundle. On Cloudflare, put it in the build command under **Workers & Pages → your Worker →
Settings → Builds**, or in the script that command runs, as above.

`PREVIEW_ENABLED=0` and `PREVIEW_ENABLED=false` are read as off, so a site can turn it off
without editing the command.

## What is behind the gate

An SSR route that renders unpublished content on your client's own domain is worth being
careful with: without a gate it is somewhere a stranger could put a convincing fake page on a
brand's real hostname. So:

- **Signed in, or nothing.** Every request needs an admin session; without one the answer is
  `401` and no page is named. Both roles may preview.
- **Only addresses the site actually serves.** The path is held to the routes in
  `cms.config.ts` — a collection's `route` with an address in the `[slug]` place, or its
  `index` — under the language segment the site itself uses. Anything else is `404`, so the
  route cannot be pointed at content it did not draw.
- **Never cached, never indexed, never framed, never the referrer.** Every answer carries
  `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`,
  `Content-Security-Policy: frame-ancestors 'self'` and `Referrer-Policy: no-referrer` — the
  admin frames the preview, nothing else can, and a link followed off a draft page does not
  hand its address to the site it points at.

## The address to preview

The preview path is the page's own path with `/_preview` in front of it, which means the
language segment sits exactly where the site puts it. With the demo's `i18n` block
(`locales: ['en', 'de']`, `defaultLocale: 'en'`, no `prefixDefaultLocale`) and its
`listings: { route: '/listings/[slug]', index: '/' }`:

| The page | Its preview |
|---|---|
| `/listings/mill-house` | `/_preview/listings/mill-house` |
| `/de/listings/mill-house` | `/_preview/de/listings/mill-house` |
| `/` — the listings index | `/_preview/` |
| `/de` | `/_preview/de` |

With `prefixDefaultLocale: true` the default language carries its segment in both, so it is
`/_preview/en/listings/mill-house` and `/_preview/listings/mill-house` is `404`.

## What it renders

Your own pages. The route resolves the address to a collection, calls the `load()` that
collection's [loader](loaders.md) exports with a source that reads the drafts, and renders the
component the same file names — the identical component tree the static page renders, from the
bytes the editor last typed. An entry nobody is drafting renders from the build, so a page is
whole: the listing being edited, and beside it the four that are not.

That is the whole of what a site does to be previewable, and it is the
[template convention](template-convention.md) either way:

- the collection names its loader — `{ route: '/listings/[slug]', load: 'listing' }`
- `src/loaders/listing.ts` exports `load` and the component that renders what it returns,
  `Page`; a collection with an `index` exports `loadIndex` and `Index` beside them
- nothing in `src/pages/` changes between a preview-on and a preview-off build

## When a draft cannot be rendered

The bytes go through the collection's own Zod schema first, so a draft that no longer satisfies
it is `422` naming the file and the field — never half a page:

```
This draft cannot be rendered:
src/content/listings/en/mill-house.yaml › location: Invalid input: expected string, received undefined
```

This validation applies to content the loader renders. Navigation links, language switchers,
and localized address lookups read draft metadata separately, so an incomplete English
Impressum does not block the English homepage just because its menu links there. Following
that link still reports the Impressum's own validation errors. Collections whose contents
are rendered still require valid drafts.

For globals, use the [selective `globalsAt()` argument](blocks.md) in the loader: declare
layout dependencies (such as `site` and `navigation`) and pass the rendered block tree. Only
those names and its nested `_ref` targets are loaded and validated. An incomplete unused
newsletter global cannot block Home; a referenced one still returns `422` with its field path.
A missing required global also returns `422`, naming the locale and file. Three-argument
`globalsAt()` calls keep reading and validating the entire collection.

An address the site could serve but has no entry at is `404`, the same answer the page itself
would give. A collection with no `load`, or a loader that exports no component, is `500` saying
which line to write: those are the site's own wiring, and only preview reads it.

## Form, Split, and Canvas

Entries with a `route`, a [loader](loaders.md), and preview enabled offer three editor views.
**Form** is the initial view and retains side-by-side language comparison. **Split** places the
form beside the editable page; **Canvas** gives the page the workspace width and collapses the
normal navigation. Tablet and phone controls set the iframe's real width rather than scaling it.

Canvas renders the current working snapshots, including changes that autosave has not sent yet.
Completed edits are coalesced into a fresh render; autosave by itself does not reload the page.
If a render fails, the last working page and the current form data remain available with Retry and
Form actions. **Open preview** first saves every dirty locale, then opens the ordinary authenticated
GET in a new tab without putting snapshot data or a Canvas signal in its URL.

A global has no route of its own, so its editor offers Form only. To see a global in context, open
an entry whose loader reads it. A site without [template annotations](canvas.md) can still use Form
and the rendered page, but its content is not selectable in place.

A link inside an ordinary preview stays in preview: every link to a page on this site is rewritten
to that page's `/_preview` address on the way out, so clicking through a draft site keeps showing
drafts. Links elsewhere are left alone. Canvas keeps the site's real links and mediates them through
the editor instead; its navigation and external-effect rules are in the [Canvas guide](canvas.md).
