# core/ conventions

- **No Astro, no Cloudflare.** Nothing under `src/` imports `astro*`, `@astrojs/*`,
  `astro:*`, `cloudflare:*`, `@cloudflare/*` or `wrangler`. Anything framework-specific
  is passed in by the caller (see `AstroContent` in `content.ts`). A test greps for it. The
  one carve-out is Drizzle's D1 driver in `db.ts`; the binding itself still arrives as a
  parameter and the Cloudflare SDK stays out.
- **`siteId` is the first parameter of every exported function.** It is always
  `'default'` in v1 and may go unused (`_siteId`); it exists so multi-site is a change of
  value, not of signature. Types and interfaces don't carry it.
- **`exports` uses the `default` condition, not `import`.** The package is ESM either way,
  but `drizzle-kit generate` in a site repo resolves `astro-handover/schema` — and through
  it this package — with a CJS require, which an `import`-only condition refuses with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.
