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
  `Content-Security-Policy: frame-ancestors 'self'; script-src 'self'` and
  `Referrer-Policy: no-referrer` — the admin frames the preview, nothing else can, and a link
  followed off a draft page does not hand its address to the site it points at.
- **Only the site's own scripts run.** A rendered page also allows by hash Astro's island
  scripts, so `client:*` components hydrate, and every `<script is:inline>` written in a
  `.astro` file under `src/`, such as a layout's
  `<script is:inline>document.documentElement.classList.add('js');</script>`. Any other inline
  script or `on…` attribute does not run. A draft that reaches a component rendering HTML
  therefore cannot act with the session of whoever is previewing it. These inline scripts are not
  admitted: one with `define:vars`, `set:html` or `set:text`, one in a package's component, and an
  island whose client directive comes from another integration. After changing an inline
  script, restart `astro dev` before you preview again.

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

An index wins over an entry at the same path: with `pages: { route: '/[slug]' }` beside
`listings: { index: '/listings' }`, `/_preview/listings` is the listings index. The editor's
Preview and Canvas of the `listings` page entry render that entry through the pages loader
instead, so a listing page's own copy can live in a page entry. Have the collection's
`loadIndex` return what the pages loader returns for that entry, and both show the same page.
An entry named `index` previews at its own collection's index page, through `loadIndex`
([A home page](loaders.md#a-home-page)).

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

What the editor shows beside the form, Canvas, and the interface language of that chrome are
[Preview in the editor](preview-in-the-editor.md).
