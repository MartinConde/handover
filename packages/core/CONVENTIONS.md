# core/ conventions

- **No Astro, no Cloudflare.** Nothing under `src/` imports `astro*`, `@astrojs/*`,
  `astro:*`, `cloudflare:*`, `@cloudflare/*` or `wrangler`. Anything framework-specific
  is passed in by the caller (see `AstroContent` in `src/content/content.ts`). A test greps for it. The
  one carve-out is Drizzle's D1 driver in `db.ts`; the binding itself still arrives as a
  parameter and the Cloudflare SDK stays out.
- **Stateful operations scope data with `siteId`.** Existing public functions that accept
  an unused site ID retain their signatures for compatibility. New pure helpers should
  take only the inputs they use.
- **`exports` uses the `default` condition, not `import`.** The package is ESM either way,
  but `drizzle-kit generate` in a site repo resolves `astro-handover/schema` — and through
  it this package — with a CJS require, which an `import`-only condition refuses with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.
