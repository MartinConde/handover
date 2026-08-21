# core/ conventions

- **No Astro, no Cloudflare.** Nothing under `src/` imports `astro*`, `@astrojs/*`,
  `astro:*`, `cloudflare:*`, `@cloudflare/*` or `wrangler`. Anything framework-specific
  is passed in by the caller (see `AstroContent` in `content.ts`). A test greps for it.
- **`siteId` is the first parameter of every exported function.** It is always
  `'default'` in v1 and may go unused (`_siteId`); it exists so multi-site is a change of
  value, not of signature. Types and interfaces don't carry it.
