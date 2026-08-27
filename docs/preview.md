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
- **Never cached, never indexed, never framed.** Every answer carries
  `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow` and
  `Content-Security-Policy: frame-ancestors 'self'` — the admin frames the preview, and
  nothing else can.

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

An address the site could serve but has no entry at is `404`, the same answer the page itself
would give. A collection with no `load`, or a loader that exports no component, is `500` saying
which line to write: those are the site's own wiring, and only preview reads it.

## Not yet

Nothing in the admin opens a preview: the address is one you type or link to yourself until the
pane lands. A brand-new entry that has no address yet cannot be previewed, and a link inside a
preview goes to the live page rather than to its preview.
