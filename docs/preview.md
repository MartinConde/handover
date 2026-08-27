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

## Not yet

The route answers the gate and nothing else: an address it accepts comes back `204` with an
empty body, because nothing renders the page yet. Reading the draft and rendering it through
your `load()` is the next piece; until it lands there is nothing in the admin that opens a
preview, and turning the flag on is only worth doing to see the gate answer.
